import { it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  appleScriptString,
  generateAttachmentSnippet,
  mimePartId,
  mboxPathFromUrl,
  sqlInt,
  sqlString,
  uniquePath,
} from "../index.js";

function assertAppleScriptRoundTrip(t, literal, value) {
  try {
    assert.equal(execFileSync("osascript", ["-e", `return ${literal}`], { encoding: "utf8" }), value + "\n");
  } catch (error) {
    if (error.code === "ENOENT") return t.skip("osascript is unavailable");
    throw error;
  }
}

function makeTempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

it("accepts safe integers and digit strings only", () => {
  for (const value of [5, "5", "005"]) assert.equal(sqlInt(value, "id"), 5);
  for (const value of ["1; ATTACH 'x' AS y", "1 OR 1=1", 1.5, "../x", null, NaN,
    "", " 5", "5\n", -1, "-1", true, "9007199254740992", Infinity]) {
    assert.throws(() => sqlInt(value, "id"), /id must be a safe integer/);
  }
});

it("accepts numeric MIME part ids and rejects path syntax", () => {
  for (const [value, expected] of [[2, "2"], ["1.2", "1.2"], ["1.1.2", "1.1.2"]]) {
    assert.equal(mimePartId(value), expected);
  }
  for (const value of ["../1", "1..2", "1.", ".1", "", "1/2", null]) {
    assert.throws(() => mimePartId(value), /Invalid attachment_id\./);
  }
});

it("quotes SQL strings and rejects NUL", () => {
  assert.equal(sqlString("it's"), "'it''s'");
  assert.equal(sqlString("$(touch x)"), "'$(touch x)'");
  assert.throws(() => sqlString("a\0b"), /NUL/);
});

it("round-trips an AppleScript string literal", t => {
  const value = 'a"b\\c';
  const literal = appleScriptString(value);
  assert.equal(literal, '"a\\"b\\\\c"');
  assertAppleScriptRoundTrip(t, literal, value);
});

it("rejects NUL in AppleScript strings", () => {
  assert.throws(() => appleScriptString("a\0b"), /NUL/);
});

it("rejects decoded mailbox path separators", () => {
  const uuid = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890";
  assert.equal(mboxPathFromUrl(`imap://${uuid}/%2E%2E%2F%2E%2E%2Fetc`), null);
  assert.equal(mboxPathFromUrl(`imap://${uuid}/INBOX%2F..`), null);
});

it("keeps generated attachment paths literal and inside the destination", t => {
  const dir = makeTempDir(t, "mail-attachment-path-");
  const filename = 'a"b\\c.txt';
  const filePath = join(dir, filename);
  writeFileSync(filePath, "attachment");
  const snippet = generateAttachmentSnippet([filePath]);
  const literal = appleScriptString(filePath);
  assert.ok(snippet.includes(`POSIX file ${literal}`));
  assertAppleScriptRoundTrip(t, literal, filePath);

  const safePath = uniquePath(dir, 1, "../../evil.txt");
  assert.equal(resolve(dirname(safePath)), resolve(dir));
  assert.throws(() => uniquePath(dir, 1, ".."), /Invalid attachment filename\./);
  assert.throws(() => uniquePath(dir, 1, "bad\0name.txt"), /Invalid attachment filename\./);
});

it("keeps shell execution out of index.js", () => {
  const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:execSync|exec)\s*\(|\bshell\s*:/);
});

it("searches the fixture Envelope Index for literal shell metacharacters", async t => {
  const dir = mkdtempSync(join(tmpdir(), "mail-search-"));
  const cwd = process.cwd();
  const previousDb = process.env.APPLE_MAIL_ENVELOPE_DB;
  t.after(() => {
    process.chdir(cwd);
    if (previousDb === undefined) delete process.env.APPLE_MAIL_ENVELOPE_DB;
    else process.env.APPLE_MAIL_ENVELOPE_DB = previousDb;
    rmSync(dir, { recursive: true, force: true });
  });
  process.chdir(dir);
  const db = join(dir, "Envelope Index");
  process.env.APPLE_MAIL_ENVELOPE_DB = db;
  const { handleSearchEmails } = await import("../index.js?search-fixture");
  const query = "it's $(touch marker1) and `touch marker2`";
  execFileSync("sqlite3", [db, `
    CREATE TABLE messages(subject_prefix, subject, sender, date_received, read, flagged, mailbox);
    CREATE TABLE labels(message_id, mailbox_id);
    CREATE TABLE subjects(subject);
    CREATE TABLE addresses(address, comment);
    CREATE TABLE mailboxes(url);
    CREATE TABLE attachments(message);
    INSERT INTO mailboxes VALUES ('fixture/INBOX');
    INSERT INTO subjects VALUES (${sqlString(query)});
    INSERT INTO addresses VALUES ('sender', NULL);
    INSERT INTO messages VALUES ('', 1, 1, 1, 0, 0, 1);
    INSERT INTO labels VALUES (1, 1);
  `]);
  const result = handleSearchEmails({ query, limit: "5" });
  assert.equal(existsSync("marker1"), false);
  assert.equal(existsSync("marker2"), false);
  assert.equal(result.content[0].text, `ID:1 | ● 1970-01-01 | sender | ${query} [Local/INBOX]`);
  assert.throws(() => handleSearchEmails({ query, limit: "1 OR 1=1" }), /limit/);
});
