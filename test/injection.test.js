import { it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appleScriptString, sqlInt, sqlString } from "../index.js";

it("accepts safe integers and digit strings only", () => {
  for (const value of [5, "5", "005"]) assert.equal(sqlInt(value, "id"), 5);
  assert.equal(sqlInt(-1, "limit"), -1); // SQLite accepts a negative LIMIT.
  for (const value of ["1; ATTACH 'x' AS y", "1 OR 1=1", 1.5, "../x", null, NaN,
    "", " 5", "5\n", "-1", true, "9007199254740992", Infinity]) {
    assert.throws(() => sqlInt(value, "id"), /id must be a safe integer/);
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
  try {
    assert.equal(execFileSync("osascript", ["-e", `return ${literal}`], { encoding: "utf8" }), value + "\n");
  } catch (error) {
    if (error.code === "ENOENT") return t.skip("osascript is unavailable");
    throw error;
  }
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
