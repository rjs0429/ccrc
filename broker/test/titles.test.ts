import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { cleanTitle, TITLE_MAX } from "../src/titles.ts";
import { writeTitle } from "../src/sessions/custom-title.ts";
import { tempDir } from "./helpers.ts";

const SID = "6b1d2c3e-4f50-4a61-8b72-9c8d7e6f5a4b";
const ch = (code: number) => String.fromCodePoint(code);

test("a name is cleaned as Claude Code cleans it", () => {
  assert.equal(cleanTitle(`  ccrc 이름${ch(0x200b)} 시험\n하나  `), "ccrc 이름  시험 하나");
  assert.equal(cleanTitle(`a${ch(0x2028)}${ch(0x2029)}b${ch(0xfeff)}c${ch(0x202e)}d\t\re`), "a b c d e");
  assert.equal(cleanTitle(`x${ch(0x85)}y${ch(0x7f)}z`), "x y z");
  assert.equal(cleanTitle(` ${ch(0x200b)}\n `), "");
  assert.equal(cleanTitle(""), "");
  const long = cleanTitle("가".repeat(230));
  assert.equal([...long].length, TITLE_MAX);
  assert.equal([...cleanTitle("😀".repeat(201))].length, TITLE_MAX, "cut by code points, not UTF-16 units");
  assert.equal(cleanTitle(`${"a".repeat(199)} b`), "a".repeat(199), "trimmed again after the cut");
});

test("a title the list made from a long first prompt cleans to the name a rename would keep, without its …", () => {
  const prompt = "프롬프트가 길게 이어집니다. ".repeat(20);
  const listed = `${prompt.slice(0, 200).trim()}…`;
  assert.equal([...listed].length, TITLE_MAX + 1);
  assert.equal(cleanTitle(listed), prompt.slice(0, 200).trim());
  assert.equal(cleanTitle(cleanTitle(listed)), cleanTitle(listed), "a cleaned name stays as it is");
});

function transcript(content: string): string {
  const file = path.join(tempDir(), "-home-u-ws", `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

test("a stopped session's name is one custom-title row and the title file beside the transcript", () => {
  const first = JSON.stringify({ type: "user", sessionId: SID, message: { role: "user", content: "hi" } });
  const file = transcript(first + "\n");
  writeTitle(file, SID, "새 이름");
  const lines = fs.readFileSync(file, "utf8").split("\n");
  assert.deepEqual(lines, [first, '{"type":"custom-title","customTitle":"새 이름","sessionId":"6b1d2c3e-4f50-4a61-8b72-9c8d7e6f5a4b"}', ""], "the key order Claude Code writes");
  const sidecar = path.join(path.dirname(file), SID, "custom-title.json");
  assert.equal(fs.readFileSync(sidecar, "utf8"), '{"customTitle":"새 이름"}');
  assert.equal(fs.statSync(sidecar).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(sidecar)).mode & 0o777, 0o700);

  writeTitle(file, SID, "또 다른 이름");
  assert.equal(fs.readFileSync(file, "utf8").split("\n").filter((l) => l.includes('"custom-title"')).length, 2);
  assert.equal(fs.readFileSync(sidecar, "utf8"), '{"customTitle":"또 다른 이름"}');
  assert.deepEqual(
    fs.readdirSync(path.dirname(sidecar)),
    ["custom-title.json"],
    "no temporary file is left",
  );
});

test("a row cut off mid-write is closed before the name goes on a line of its own", () => {
  const file = transcript('{"type":"user"}\n{"type":"assist');
  writeTitle(file, SID, "이름");
  assert.deepEqual(fs.readFileSync(file, "utf8").split("\n"), ['{"type":"user"}', '{"type":"assist', `{"type":"custom-title","customTitle":"이름","sessionId":"${SID}"}`, ""]);
});

test("a missing or empty transcript is not named", () => {
  const dir = tempDir();
  assert.throws(() => writeTitle(path.join(dir, `${SID}.jsonl`), SID, "x"), /unknown session/);
  assert.ok(!fs.existsSync(path.join(dir, `${SID}.jsonl`)), "nothing is created");
  const empty = transcript("");
  assert.throws(() => writeTitle(empty, SID, "x"), /unknown session/);
  assert.equal(fs.statSync(empty).size, 0);
  assert.ok(!fs.existsSync(path.join(path.dirname(empty), SID)));
});
