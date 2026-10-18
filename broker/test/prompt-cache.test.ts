import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CacheClock, cacheOfLines, lastCache } from "../src/sessions/prompt-cache.ts";
import { cacheLabel, cacheNow, cacheText } from "../../web/src/components/promptCache.ts";
import { tempDir } from "./helpers.ts";

const usage = (o: { input?: number; read?: number; m5?: number; h1?: number }) => ({
  input_tokens: o.input ?? 2,
  cache_read_input_tokens: o.read ?? 0,
  cache_creation_input_tokens: (o.m5 ?? 0) + (o.h1 ?? 0),
  cache_creation: { ephemeral_5m_input_tokens: o.m5 ?? 0, ephemeral_1h_input_tokens: o.h1 ?? 0 },
  output_tokens: 50,
});

test("the cache is written or read when the request before the response went out, and keeps the time to live it was written with", () => {
  const c = new CacheClock();
  assert.equal(c.value(), undefined);
  c.request(1000);
  c.request(900);
  assert.equal(c.response("msg_1", usage({ m5: 300 }), 5000), true);
  assert.deepEqual(c.value(), { at: 1000, ttl: "5m", tokens: 302 });
  assert.equal(c.response("msg_1", usage({ m5: 300 }), 6000), false, "the parts of one response keep its request's time");
  c.request(8000);
  c.response("msg_2", usage({ read: 302, input: 5 }), 9000);
  assert.deepEqual(c.value(), { at: 8000, ttl: "5m", tokens: 307 }, "a response that only read keeps the time to live");
  c.response("msg_3", usage({ read: 307, h1: 40 }), 12_000);
  assert.deepEqual(c.value(), { at: 12_000, ttl: "1h", tokens: 349 }, "without a request since, the response's own time");
  c.response("msg_4", usage({ input: 9 }), 13_000);
  assert.equal(c.value(), undefined, "a response with nothing cached says nothing of how long a cache lasts");
  assert.equal(c.response("msg_5", { output_tokens: 3 }, 14_000), false, "a response without input counts is not one");
  assert.equal(c.response("msg_6", "nope", 15_000), false);
});

test("a compaction leaves nothing cached until a later response", () => {
  const c = new CacheClock();
  c.request(1000);
  c.response("msg_1", usage({ h1: 10 }), 2000);
  assert.equal(c.compact(3000), true);
  assert.deepEqual(c.value(), { at: 1000, ttl: "1h", tokens: 12, compactedAt: 3000 });
  c.response("msg_1", usage({ h1: 10 }), 3500);
  assert.equal(c.value()?.compactedAt, 3000, "a part of the response from before the compaction does not undo it");
  c.request(4000);
  c.response("msg_2", usage({ h1: 900 }), 5000);
  assert.deepEqual(c.value(), { at: 4000, ttl: "1h", tokens: 902 });
  const fresh = new CacheClock();
  fresh.compact(10);
  assert.deepEqual(fresh.value(), { compactedAt: 10 }, "compacted with nothing before it");
});

test("a clock takes the transcript's last state only while it has seen nothing of its own", () => {
  const c = new CacheClock();
  assert.equal(c.seed({ at: 5, ttl: "5m", tokens: 9 }), true);
  assert.deepEqual(c.value(), { at: 5, ttl: "5m", tokens: 9 });
  assert.equal(c.seed({ at: 7, ttl: "1h" }), false);
  assert.equal(new CacheClock().seed(undefined), false);
});

const row = (o: Record<string, unknown>) => JSON.stringify({ sessionId: "s", ...o });
const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse("2026-10-18T01:00:00Z");

function transcript(): string[] {
  return [
    row({ type: "user", timestamp: iso(T0), message: { role: "user", content: "hi" } }),
    row({ type: "assistant", timestamp: iso(T0 + 4000), message: { id: "msg_a", model: "claude-opus-5-5", usage: usage({ h1: 5000 }) } }),
    row({ type: "user", timestamp: iso(T0 + 5000), message: { role: "user", content: [{ type: "tool_result" }] } }),
    row({ type: "assistant", timestamp: iso(T0 + 6000), isSidechain: true, message: { id: "msg_side", model: "claude-haiku-5-5", usage: usage({ m5: 80 }) } }),
    row({ type: "user", timestamp: iso(T0 + 7000), isSidechain: true, message: { role: "user", content: "sub" } }),
    row({ type: "assistant", timestamp: iso(T0 + 9000), message: { id: "msg_b", model: "claude-opus-5-5", usage: usage({ read: 5000, h1: 120 }) } }),
    row({ type: "assistant", timestamp: iso(T0 + 9500), message: { id: "msg_syn", model: "<synthetic>", usage: usage({ input: 1 }) } }),
    "not json",
  ];
}

test("a transcript's main conversation sets the cache, its subagents and Claude Code's own notes do not", () => {
  assert.deepEqual(cacheOfLines(transcript()), { at: T0 + 5000, ttl: "1h", tokens: 5122 });
  const compacted = [...transcript(), row({ type: "system", subtype: "compact_boundary", timestamp: iso(T0 + 20_000) })];
  assert.equal(cacheOfLines(compacted)?.compactedAt, T0 + 20_000);
  const summary = [...transcript(), row({ type: "user", isCompactSummary: true, timestamp: iso(T0 + 21_000), message: { role: "user", content: "summary" } })];
  assert.equal(cacheOfLines(summary)?.compactedAt, T0 + 21_000);
  assert.equal(cacheOfLines([row({ type: "user", timestamp: iso(T0), message: { content: "x" } })]), undefined);
});

test("the last cache is read from the end of a large transcript, again only once the file changes", async () => {
  const file = path.join(tempDir(), "s.jsonl");
  const filler = row({ type: "attachment", timestamp: iso(T0), attachment: { type: "big", text: "x".repeat(400_000) } });
  fs.writeFileSync(file, [...transcript(), filler].join("\n") + "\n");
  assert.deepEqual(await lastCache(file), { at: T0 + 5000, ttl: "1h", tokens: 5122 }, "found past a first piece with no response in it");
  const later = row({ type: "user", timestamp: iso(T0 + 60_000), message: { role: "user", content: "again" } }) + "\n" + row({ type: "assistant", timestamp: iso(T0 + 61_000), message: { id: "msg_c", model: "m", usage: usage({ read: 5122, m5: 10 }) } }) + "\n";
  fs.appendFileSync(file, later);
  assert.deepEqual(await lastCache(file), { at: T0 + 60_000, ttl: "5m", tokens: 5134 });
  const empty = path.join(tempDir(), "e.jsonl");
  fs.writeFileSync(empty, row({ type: "user", timestamp: iso(T0), message: { content: "x" } }) + "\n");
  assert.equal(await lastCache(empty), undefined);
});

test("the phone reads the cache as VS Code does: minutes left rounded up, cold once expired or compacted", () => {
  const at = 1_000_000;
  assert.equal(cacheNow(undefined, at), undefined);
  assert.equal(cacheNow({ at, tokens: 5 }, at), undefined, "without a time to live");
  const warm = cacheNow({ at, ttl: "5m", tokens: 9 }, at + 61_000);
  assert.deepEqual(warm, { kind: "warm", ttl: "5m", at, msLeft: 239_000, minutes: 4 });
  assert.equal(cacheLabel(warm!), "프롬프트 캐시 4분 남음");
  const ahead = cacheNow({ at: at + 600_000, ttl: "5m" }, at);
  assert.equal(ahead?.kind === "warm" ? ahead.minutes : undefined, 5, "a clock ahead of the phone's leaves at most the whole time to live");
  const cold = cacheNow({ at, ttl: "1h", tokens: 120_000 }, at + 3_725_000);
  assert.deepEqual(cold, { kind: "cold", reason: "expired", idleMs: 3_725_000, tokens: 120_000 });
  assert.deepEqual(cacheText(cold!, (n) => `${n / 1000}k`), { head: "캐시가 만료되었을 수 있습니다 · 쉰 지 1시간 2분", hint: "다음 메시지가 약 120k 토큰을 다시 캐시합니다." });
  const compacted = cacheNow({ at, ttl: "1h", compactedAt: at + 1000 }, at + 2000);
  assert.deepEqual(compacted, { kind: "cold", reason: "compacted", idleMs: 1000 });
  assert.equal(cacheLabel(compacted!), "프롬프트 캐시 없음 (대화를 요약함)");
});
