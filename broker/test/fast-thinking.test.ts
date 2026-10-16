import assert from "node:assert/strict";
import { test } from "node:test";
import type { DisplayItem, LiveState } from "../src/protocol.ts";
import { BrokerSession, thinkingDefault } from "../src/sessions/broker-session.ts";
import { modelCaps } from "../src/sessions/model-caps.ts";

const SID = "5e8f0a12-3b4c-4d5e-8f6a-7b8c9d0e1f2a";

// An owned session whose SDK query is a stand-in that records the control methods called on it.
function owned(effective: Record<string, unknown> = {}) {
  const s = new BrokerSession(SID, "/tmp/project");
  const calls: unknown[][] = [];
  const q = {
    applyFlagSettings: async (settings: unknown) => void calls.push(["applyFlagSettings", settings]),
    setMaxThinkingTokens: async (n: unknown) => void calls.push(["setMaxThinkingTokens", n]),
    request: async () => ({ response: { applied: { model: "claude-opus-5", effort: "high" }, effective } }),
    initializationResult: async () => ({ available_output_styles: [] }),
    getContextUsage: async () => ({ categories: [], totalTokens: 0, maxTokens: 0, percentage: 0 }),
    supportedModels: async () => [],
  };
  (s as unknown as { q: typeof q }).q = q;
  const items: DisplayItem[] = [];
  s.on("item", (i: DisplayItem) => items.push(i));
  const feed = (...ms: Record<string, unknown>[]) => {
    for (const m of ms) (s as unknown as { onMessage(m: unknown): void }).onMessage({ session_id: SID, ...m });
  };
  const flags = () => calls.filter((c) => c[0] === "applyFlagSettings").map((c) => c[1]);
  return { s, calls, items, feed, flags };
}

const init = (state: string, reason?: string) => ({ type: "system", subtype: "init", model: "claude-opus-5", fast_mode_state: state, ...(reason ? { fast_mode_disabled_reason: reason } : {}) });
const result = (state: string, reason?: string) => ({ type: "result", subtype: "success", is_error: false, fast_mode_state: state, ...(reason ? { fast_mode_disabled_reason: reason } : {}) });
const reply = (text: string) => ({ type: "assistant", uuid: `a-${text}`, parent_tool_use_id: null, message: { content: [{ type: "text", text }] } });
const credits = { type: "system", subtype: "notification", key: "fast-mode-overage-rejected", text: "Fast mode disabled · usage credits exhausted", uuid: "n-1" };
const tick = () => new Promise((r) => setTimeout(r, 10));
const fast = (st: LiveState) => {
  const { fastMode, fastReason, fastWanted, fastCredits } = st;
  return Object.fromEntries(Object.entries({ fastMode, fastReason, fastWanted, fastCredits }).filter(([, v]) => v !== undefined));
};
const notes = (items: DisplayItem[]) => items.filter((i): i is Extract<DisplayItem, { kind: "note" }> => i.kind === "note" && i.code === "fast").map((i) => i.text);

test("Fast mode follows what Claude Code last reported in an init line or a result", () => {
  const { s, feed } = owned();
  assert.deepEqual(fast(s.state()), {}, "nothing before Claude Code says");
  feed(init("off", "sdk_opt_in_required"));
  assert.deepEqual(fast(s.state()), { fastMode: "off", fastReason: "sdk_opt_in_required" });
  feed(result("on"));
  assert.deepEqual(fast(s.state()), { fastMode: "on" });
  feed(init("cooldown"));
  assert.deepEqual(fast(s.state()), { fastMode: "cooldown" });
  feed(init("sideways", "x"), { type: "result", subtype: "success", is_error: false });
  assert.deepEqual(fast(s.state()), { fastMode: "cooldown" }, "a line without a known state changes nothing");
});

test("a change asked for here shows until an init line confirms it; a result may close a turn begun before it", async () => {
  const { s, feed, flags } = owned();
  feed(init("off", "sdk_opt_in_required"), result("off", "sdk_opt_in_required"));
  await s.setFast(true);
  assert.deepEqual(flags(), [{ fastMode: true }]);
  assert.equal(s.state().fastWanted, true);
  feed(result("off", "sdk_opt_in_required"));
  assert.equal(s.state().fastWanted, true, "still asked for");
  feed(init("on"));
  assert.deepEqual(fast(s.state()), { fastMode: "on" });
  await s.setFast(false);
  feed(init("on"));
  assert.equal(s.state().fastWanted, false, "an off change waits for a report of off");
  feed(init("off", "sdk_opt_in_required"));
  assert.deepEqual(fast(s.state()), { fastMode: "off", fastReason: "sdk_opt_in_required" });
  assert.deepEqual(flags(), [{ fastMode: true }, { fastMode: false }]);
});

test("a change that cannot go on is asked off again at once and noted when its turn is over", async () => {
  const { s, feed, flags, items } = owned();
  await s.setFast(true);
  feed(init("off", "extra_usage_disabled"));
  await tick();
  assert.deepEqual(flags(), [{ fastMode: true }, { fastMode: false }]);
  assert.deepEqual(fast(s.state()), { fastMode: "off", fastReason: "extra_usage_disabled" }, "asked off without showing a change of its own");
  assert.deepEqual(notes(items), [], "not while the turn runs");
  feed(reply("standard speed"), result("off", "extra_usage_disabled"));
  assert.deepEqual(notes(items), ["extra_usage_disabled"]);
  assert.ok(items.findIndex((i) => i.kind === "assistant") < items.findIndex((i) => i.kind === "note"), "after the turn's reply");
  feed(init("off", "extra_usage_disabled"), result("off", "extra_usage_disabled"));
  assert.deepEqual(notes(items), ["extra_usage_disabled"], "once");
});

test("a pending check is waited out, and an off with no reason clears the change quietly", async () => {
  const { s, feed, flags, items } = owned();
  await s.setFast(true);
  feed(init("off", "pending"), result("off", "pending"));
  assert.equal(s.state().fastWanted, true);
  feed(init("off"), result("off"));
  assert.deepEqual(fast(s.state()), { fastMode: "off" });
  await tick();
  assert.deepEqual(flags(), [{ fastMode: true }]);
  assert.deepEqual(notes(items), []);
});

test("a session started with Fast mode settles it from the initialize answer, noting a refusal at once when idle", async () => {
  const { s, flags, items } = owned();
  s.fastWanted = true;
  (s as unknown as { adoptFast(state: unknown, reason: unknown, settles: boolean): void }).adoptFast("off", "free", true);
  await tick();
  assert.deepEqual(flags(), [{ fastMode: false }]);
  assert.deepEqual(notes(items), ["free"]);
});

test("the usage credits notice is noted once and turns Fast mode off in a broker session", async () => {
  const { s, feed, flags, items } = owned();
  feed(init("on"), credits, credits);
  await tick();
  assert.deepEqual(notes(items), ["credits"]);
  assert.deepEqual(flags(), [{ fastMode: false }], "asked off once");
  assert.deepEqual(fast(s.state()), { fastMode: "on", fastWanted: false, fastCredits: true });
  feed(result("on"), init("off", "sdk_opt_in_required"));
  assert.deepEqual(fast(s.state()), { fastMode: "off", fastReason: "sdk_opt_in_required" }, "a report of off clears the notice");
  await s.setFast(true);
  assert.equal(s.state().fastCredits, undefined);
});

test("Thinking starts as the settings say, MAX_THINKING_TOKENS first, and a change here sticks", async () => {
  assert.equal(thinkingDefault({}, {}), true);
  assert.equal(thinkingDefault(undefined, {}), true);
  assert.equal(thinkingDefault({ alwaysThinkingEnabled: false }, {}), false);
  assert.equal(thinkingDefault({ env: { MAX_THINKING_TOKENS: "0" } }, {}), false);
  assert.equal(thinkingDefault({ alwaysThinkingEnabled: false, env: { MAX_THINKING_TOKENS: "8000" } }, {}), true);
  assert.equal(thinkingDefault({}, { MAX_THINKING_TOKENS: "0" }), false);
  assert.equal(thinkingDefault({ env: { MAX_THINKING_TOKENS: "4000" } }, { MAX_THINKING_TOKENS: "0" }), true, "the settings' env wins");
  assert.equal(thinkingDefault({ alwaysThinkingEnabled: false }, { MAX_THINKING_TOKENS: "many" }), false, "a value that is no number counts for nothing");

  const { s, feed, calls } = owned({ alwaysThinkingEnabled: false });
  assert.equal(s.state().thinking, undefined);
  feed(init("off"));
  for (let i = 0; i < 50 && s.thinking === undefined; i++) await tick();
  assert.equal(s.state().thinking, false, "from the settings once Claude Code answers");
  await s.setThinking(true);
  assert.equal(s.state().thinking, true);
  await s.setThinking(false);
  assert.deepEqual(
    calls.filter((c) => c[0] === "setMaxThinkingTokens"),
    [
      ["setMaxThinkingTokens", 31999],
      ["setMaxThinkingTokens", 0],
    ],
  );
  await s.setThinking(true);
  feed(result("off"));
  await tick();
  assert.equal(s.state().thinking, true, "a later get_settings does not undo a change made here");
});

test("a model's Fast mode and Thinking off are known by name when Claude Code did not say", () => {
  assert.deepEqual(modelCaps("claude-opus-5-5"), { fast: true, thinkingOff: false });
  assert.deepEqual(modelCaps("claude-opus-5-5[1m]"), { fast: true, thinkingOff: false });
  assert.deepEqual(modelCaps("claude-opus-5"), { fast: true, thinkingOff: true });
  assert.deepEqual(modelCaps("claude-opus-4-8"), { fast: true, thinkingOff: true });
  assert.deepEqual(modelCaps("claude-opus-4-7"), { fast: false, thinkingOff: true });
  assert.deepEqual(modelCaps("claude-sonnet-5-5"), { fast: false, thinkingOff: false });
  assert.deepEqual(modelCaps("claude-sonnet-5"), { fast: false, thinkingOff: true });
  assert.deepEqual(modelCaps("claude-haiku-5-5"), { fast: false, thinkingOff: false });
  assert.deepEqual(modelCaps("claude-haiku-4-5-20251001"), { fast: false, thinkingOff: true });
  assert.deepEqual(modelCaps("claude-fable-5-1"), { fast: false, thinkingOff: false });
  assert.deepEqual(modelCaps("claude-mythos-5-1"), { fast: false, thinkingOff: false });
  assert.deepEqual(modelCaps("claude-mythos-5"), { fast: false });
  assert.deepEqual(modelCaps("claude-next-7"), { fast: false });
});
