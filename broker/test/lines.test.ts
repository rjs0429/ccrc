import assert from "node:assert/strict";
import { test } from "node:test";
import { LineSplitter, parseLine } from "../src/link/lines.ts";

function split(chunks: Buffer[]): string[] {
  const out: string[] = [];
  const s = new LineSplitter((line) => out.push(line.toString("utf8")));
  for (const c of chunks) s.push(c);
  s.end();
  return out;
}

test("splits lines across and within chunks, keeping empty ones", () => {
  assert.deepEqual(split([Buffer.from("a\nb"), Buffer.from("c\n\nd")]), ["a", "bc", "", "d"]);
});

test("a multi-byte character split between chunks survives", () => {
  const bytes = Buffer.from('{"t":"한글"}\n');
  const out = split([bytes.subarray(0, 8), bytes.subarray(8)]);
  assert.deepEqual(out, ['{"t":"한글"}']);
});

test("parseLine accepts only JSON objects", () => {
  assert.deepEqual(parseLine('{"a":1}'), { a: 1 });
  assert.equal(parseLine("[1]"), undefined);
  assert.equal(parseLine("null"), undefined);
  assert.equal(parseLine("not json"), undefined);
});
