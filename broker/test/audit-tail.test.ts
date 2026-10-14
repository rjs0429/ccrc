import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readAuditTail } from "../src/routes/audit.ts";
import { tempDir } from "./helpers.ts";

const line = (n: number, extra: Record<string, unknown> = {}) => JSON.stringify({ ts: `2026-10-14T00:00:${n}Z`, event: "send", n, ...extra });

async function all(file: string, limit: number, chunk?: number): Promise<{ seen: number[]; pages: number }> {
  const seen: number[] = [];
  let before: number | undefined;
  let pages = 0;
  for (;;) {
    const page = await readAuditTail(file, limit, before, chunk);
    pages++;
    seen.push(...page.entries.map((e) => e.n as number));
    if (page.next === undefined) return { seen, pages };
    assert.ok(before === undefined || page.next < before, "each page ends earlier in the file");
    before = page.next;
  }
}

test("pages through the log newest first, whatever the chunk size", async () => {
  const file = path.join(tempDir(), "audit.jsonl");
  fs.writeFileSync(file, Array.from({ length: 250 }, (_, i) => line(i)).join("\n") + "\n");
  const expected = Array.from({ length: 250 }, (_, i) => 249 - i);
  for (const chunk of [7, 100, undefined]) {
    const { seen, pages } = await all(file, 100, chunk);
    assert.deepEqual(seen, expected, `chunk ${chunk}`);
    assert.equal(pages, 3);
  }
  const first = await readAuditTail(file, 2);
  assert.deepEqual(first.entries.map((e) => e.n), [249, 248]);
});

test("skips lines that are not entries, too long to read, or still being written", async () => {
  const file = path.join(tempDir(), "audit.jsonl");
  const lines = [line(0), "not json", line(1), JSON.stringify({ event: "send" }), line(9, { pad: "x".repeat(100_000) }), "", line(2), '{"ts":"2026-10-14T00:00:03Z","ev'];
  fs.writeFileSync(file, lines.join("\n"));
  for (const chunk of [50, undefined]) assert.deepEqual((await all(file, 10, chunk)).seen, [2, 1, 0]);
});

test("a missing or empty log has no entries", async () => {
  const dir = tempDir();
  assert.deepEqual(await readAuditTail(path.join(dir, "none.jsonl"), 10), { entries: [] });
  fs.writeFileSync(path.join(dir, "empty.jsonl"), "");
  assert.deepEqual(await readAuditTail(path.join(dir, "empty.jsonl"), 10), { entries: [] });
  fs.writeFileSync(path.join(dir, "one.jsonl"), line(5) + "\n");
  assert.deepEqual(await readAuditTail(path.join(dir, "one.jsonl"), 10, 10_000), { entries: [JSON.parse(line(5))] });
});
