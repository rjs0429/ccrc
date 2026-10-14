import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ContextWindows, exactModel, gauge, gaugeOf, lastModelId, lastUsage, widened } from "../src/sessions/context-gauge.ts";
import { contextDetail } from "../src/sessions/reports.ts";
import { tempDir } from "./helpers.ts";

type Row = Record<string, unknown>;

const assistant = (model: string, usage: Row, more: Row = {}): Row => ({
  type: "assistant",
  isSidechain: false,
  message: { model, role: "assistant", content: [{ type: "text", text: "ok" }], usage },
  ...more,
});
const user = (text: string): Row => ({ type: "user", isSidechain: false, message: { role: "user", content: text } });
const compacted = (postTokens?: number): Row => ({
  type: "system",
  subtype: "compact_boundary",
  isSidechain: false,
  compactMetadata: { trigger: "manual", preTokens: 500_000, ...(postTokens !== undefined ? { postTokens } : {}) },
});

function transcript(rows: Row[], pad = ""): string {
  const file = path.join(tempDir(), "s.jsonl");
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n" + pad);
  return file;
}

test("the last main-conversation response gives the context in use: input, cache and output tokens", async () => {
  const file = transcript([
    user("hi"),
    assistant("claude-a-1", { input_tokens: 5, output_tokens: 5 }),
    user("more"),
    assistant("claude-a-1", { input_tokens: 2, cache_creation_input_tokens: 850, cache_read_input_tokens: 174_792, output_tokens: 1078 }),
    assistant("claude-sub-1", { input_tokens: 1, output_tokens: 1 }, { isSidechain: true }),
    assistant("<synthetic>", { input_tokens: 0, output_tokens: 0 }),
    user("<command-name>/usage</command-name>"),
  ]);
  assert.deepEqual(await lastUsage(file), { tokens: 176_722, model: "claude-a-1" });
});

test("a compaction after the last response gives what it left, or nothing when it does not say", async () => {
  const usage = { input_tokens: 400_000, output_tokens: 10 };
  assert.deepEqual(await lastUsage(transcript([assistant("claude-a-1", usage), compacted(9600)])), { tokens: 9600, model: "claude-a-1" });
  assert.equal(await lastUsage(transcript([assistant("claude-a-1", usage), compacted()])), undefined);
  assert.deepEqual(await lastUsage(transcript([compacted(9600), assistant("claude-a-1", { input_tokens: 12_000, output_tokens: 300 })])), {
    tokens: 12_300,
    model: "claude-a-1",
  });
  assert.equal(await lastUsage(transcript([user("only a question")])), undefined);
});

test("a response far before the end of a long transcript is still found", async () => {
  const tail = Array.from({ length: 40 }, (_, i) => JSON.stringify(user(`${i} ${"x".repeat(20_000)}`))).join("\n") + "\n";
  const file = transcript([assistant("claude-a-1", { input_tokens: 70_000, output_tokens: 1 })], tail);
  assert.ok(fs.statSync(file).size > 512 * 1024);
  assert.deepEqual(await lastUsage(file), { tokens: 70_001, model: "claude-a-1" });
});

test("a gauge is the share of the window in whole percent, with the auto-compact point when known", () => {
  assert.deepEqual(gauge(57_000, { max: 100_000, autoCompactAt: 67_000 }, true), { percent: 57, tokens: 57_000, max: 100_000, autoCompactAt: 67_000, last: true });
  assert.deepEqual(gauge(0, { max: 200_000 }), { percent: 0, tokens: 0, max: 200_000 });
  assert.equal(gauge(1_999, { max: 200_000 }).percent, 1);
  const detail = contextDetail({ percentage: 2.9, totalTokens: 28_561, maxTokens: 1_000_000, autoCompactThreshold: 967_000, isAutoCompactEnabled: true, model: "m" });
  assert.equal(detail.autoCompactAt, 967_000);
  assert.deepEqual(gaugeOf(detail), { percent: 3, tokens: 28_561, max: 1_000_000, autoCompactAt: 967_000 });
  assert.equal(contextDetail({ totalTokens: 1, maxTokens: 10, autoCompactThreshold: 9, isAutoCompactEnabled: false }).autoCompactAt, undefined);
  assert.equal(gaugeOf(contextDetail({ percentage: 40 })), undefined);
});

test("context windows are kept per session and per model across restarts", () => {
  const file = path.join(tempDir(), "context-windows.json");
  const w = new ContextWindows(file);
  w.learn("claude-a-1[1m]", { max: 1_000_000, autoCompactAt: 967_000 }, "s1");
  w.learn("claude-b-1", { max: 200_000, autoCompactAt: 167_000 });
  const again = new ContextWindows(file);
  assert.deepEqual(again.get("s1", "claude-a-1"), { max: 1_000_000, autoCompactAt: 967_000, model: "claude-a-1[1m]" });
  assert.deepEqual(again.get("s2", "claude-b-1"), { max: 200_000, autoCompactAt: 167_000 });
  assert.deepEqual(again.get("s1", "claude-b-1"), { max: 200_000, autoCompactAt: 167_000 }, "a session now on another model uses that model's window");
  assert.equal(again.get("s2", "claude-a-1"), undefined);
  again.learn(undefined, { max: 0 }, "s3");
  assert.equal(again.get("s3"), undefined);
});

const modelRow = (modelId: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "attachment", isSidechain: false, attachment: { type: "model", identity: { modelId, marketingName: "M" }, text: "t" }, ...extra });
const answer = (model: string) => JSON.stringify({ type: "assistant", isSidechain: false, message: { model, usage: { input_tokens: 10, output_tokens: 1 } } });

test("the exact model comes from the transcript's newest model record of the main conversation", async () => {
  const dir = tempDir();
  const write = (name: string, lines: string[]) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, lines.join("\n") + "\n");
    return f;
  };
  assert.equal(await lastModelId(write("a.jsonl", [modelRow("claude-a-1"), answer("claude-a-1"), modelRow("claude-a-1[1m]"), answer("claude-a-1")])), "claude-a-1[1m]");
  assert.equal(await lastModelId(write("b.jsonl", [modelRow("claude-a-1[1m]"), modelRow("claude-a-1", { isSidechain: true }), answer("claude-a-1")])), "claude-a-1[1m]");
  assert.equal(await lastModelId(write("c.jsonl", [answer("claude-a-1")])), undefined);
  const filler = answer("claude-a-1").replace("usage", `pad":"${"x".repeat(4000)}","usage`);
  const big = write("d.jsonl", [modelRow("claude-a-1[1m]"), ...Array.from({ length: 3000 }, () => filler)]);
  assert.ok(fs.statSync(big).size > 8 * 1024 * 1024);
  assert.equal(await lastModelId(big), "claude-a-1[1m]", "a session's first record is found at the start of a long transcript");
  const mid = write("e.jsonl", [...Array.from({ length: 500 }, () => filler), modelRow("claude-a-2[1m]"), ...Array.from({ length: 1250 }, () => filler)]);
  assert.equal(await lastModelId(mid), "claude-a-2[1m]", "a record up to 8 MB before the end is found");
});

test("a stopped session's model takes the 1M window only on evidence", () => {
  assert.equal(exactModel("claude-opus-9", "claude-opus-9[1m]", undefined), "claude-opus-9[1m]");
  assert.equal(exactModel("claude-opus-9", "claude-opus-9", "opus[1m]"), "claude-opus-9", "the transcript's record wins over settings");
  assert.equal(exactModel("claude-opus-9", "claude-sonnet-9[1m]", undefined), "claude-opus-9", "a record of another model says nothing");
  assert.equal(exactModel("claude-opus-9", undefined, "opus[1m]"), "claude-opus-9[1m]");
  assert.equal(exactModel("claude-opus-9", undefined, "claude-opus-9[1m]"), "claude-opus-9[1m]");
  assert.equal(exactModel("claude-opus-9", undefined, "sonnet[1m]"), "claude-opus-9");
  assert.equal(exactModel("claude-opus-9", undefined, "opus"), "claude-opus-9");
  assert.equal(exactModel("claude-opus-9", undefined, undefined), "claude-opus-9");
  assert.equal(widened("claude-opus-9", 300_000, { max: 200_000 }), "claude-opus-9[1m]");
  assert.equal(widened("claude-opus-9", 100_000, { max: 200_000 }), undefined);
  assert.equal(widened("claude-opus-9[1m]", 1_300_000, { max: 1_000_000 }), undefined);
});
