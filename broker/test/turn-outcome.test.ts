import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, noteFact, type TurnFacts } from "../src/sessions/outcome.ts";

type Msg = Record<string, unknown>;

// Lines as Claude Code 2.1.296 wrote them for a turn that finished, one stopped while it wrote, and one on a model
// that does not exist, from first message to result.
const DONE: Msg[] = [
  { type: "system", subtype: "init", model: "claude-haiku-5-5" },
  { type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1792095600, rateLimitType: "five_hour" } },
  { type: "user", isReplay: true, message: { role: "user", content: [{ type: "text", text: "Reply with exactly the word: ok." }] } },
  { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "ok" }] } },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    terminal_reason: "completed",
    api_error_status: null,
    duration_ms: 2376,
    user_message_uuids: ["aaaaaaaa-0000-4000-8000-000000000001"],
    queued_turn_count: 0,
    result: "ok",
  },
];
const INTERRUPTED: Msg[] = [
  { type: "system", subtype: "init", model: "claude-haiku-5-5" },
  { type: "user", isReplay: true, message: { role: "user", content: [{ type: "text", text: "Write a numbered list of 150 facts" }] } },
  { type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } },
  {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    terminal_reason: "aborted_streaming",
    duration_ms: 1729,
    queued_turn_count: 0,
    errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"],
  },
];
const NO_MODEL: Msg[] = [
  { type: "system", subtype: "init", model: "claude-haiku-0-0-doesnotexist" },
  { type: "assistant", error: "model_not_found", parent_tool_use_id: null, message: { model: "<synthetic>", content: [{ type: "text", text: "There's an issue with the selected model" }] } },
  { type: "result", subtype: "success", is_error: true, terminal_reason: "api_error", api_error_status: 404, duration_ms: 790, queued_turn_count: 0, result: "There's an issue" },
];

function outcomeOf(lines: Msg[]) {
  const facts: TurnFacts = {};
  for (const m of lines.slice(0, -1)) noteFact(facts, m);
  return classify(lines.at(-1)!, facts);
}

test("real turns: finished, stopped by the user, and an unknown model", () => {
  assert.deepEqual(outcomeOf(DONE), { outcome: "done" });
  assert.deepEqual(outcomeOf(INTERRUPTED), { outcome: "interrupted" });
  assert.deepEqual(outcomeOf(NO_MODEL), { outcome: "error", reason: "model", status: 404 });
});

test("a usage limit is told by a 429, a rate_limit error or a rejected limit event, which gives the reset in ms", () => {
  const result = { type: "result", subtype: "success", is_error: true, terminal_reason: "api_error" };
  assert.deepEqual(classify({ ...result, api_error_status: 429 }, {}), { outcome: "limit", status: 429 });
  const errored: TurnFacts = {};
  noteFact(errored, { type: "assistant", error: "rate_limit", parent_tool_use_id: null, message: { content: [] } });
  assert.deepEqual(classify({ ...result, api_error_status: null }, errored), { outcome: "limit" });
  const rejected: TurnFacts = {};
  noteFact(rejected, { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1792095600 } });
  assert.deepEqual(rejected, { rateLimited: true, resetsAt: 1792095600_000 });
  assert.deepEqual(classify(result, rejected), { outcome: "limit", resetsAt: 1792095600_000 });
  const allowed: TurnFacts = {};
  noteFact(allowed, { type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1792095600 } });
  assert.deepEqual(allowed, {}, "only a rejected event counts");
});

test("an error's reason: a full context, a login that does not hold, a server failure, or none", () => {
  const failed = (extra: Msg, facts: TurnFacts = {}) => classify({ type: "result", subtype: "success", is_error: true, ...extra }, facts);
  assert.deepEqual(failed({ terminal_reason: "prompt_too_long" }), { outcome: "error", reason: "context" });
  assert.deepEqual(failed({ terminal_reason: "blocking_limit" }), { outcome: "error", reason: "context" });
  assert.deepEqual(failed({ terminal_reason: "api_error", api_error_status: 401 }), { outcome: "error", reason: "login", status: 401 });
  assert.deepEqual(failed({ terminal_reason: "api_error" }, { apiError: "authentication_failed" }), { outcome: "error", reason: "login" });
  assert.deepEqual(failed({ terminal_reason: "api_error", api_error_status: 529 }), { outcome: "error", reason: "api", status: 529 });
  assert.deepEqual(failed({ terminal_reason: "api_error", api_error_status: 400 }), { outcome: "error", status: 400 });
  assert.deepEqual(failed({ subtype: "error_during_execution", terminal_reason: "turn_setup_failed" }), { outcome: "error" });
});

test("local commands, a turn sent to the background and ends that are not errors", () => {
  assert.deepEqual(classify({ type: "result", subtype: "success", is_error: false, local_command: "compact" }, {}), { outcome: "local" });
  assert.deepEqual(classify({ type: "result", subtype: "success", is_error: false, terminal_reason: "background_requested" }, {}), { outcome: "interrupted" });
  assert.deepEqual(classify({ type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_tools" }, {}), { outcome: "interrupted" });
  assert.deepEqual(classify({ type: "result", subtype: "success", is_error: false, terminal_reason: "hook_stopped" }, {}), { outcome: "done" });
  assert.deepEqual(classify({ type: "result", subtype: "success", is_error: false }, {}), { outcome: "done" }, "an older CLI without a reason");
});

test("without a terminal reason, error_during_execution is a stop only after the interrupt note", () => {
  const old = { type: "result", subtype: "error_during_execution", is_error: true };
  const noted: TurnFacts = {};
  noteFact(noted, { type: "user", parent_tool_use_id: null, message: { role: "user", content: "[Request interrupted by user for tool use]" } });
  assert.deepEqual(classify(old, noted), { outcome: "interrupted" });
  assert.deepEqual(classify(old, {}), { outcome: "error" });
  const echoed: TurnFacts = {};
  noteFact(echoed, { type: "user", isReplay: true, message: { role: "user", content: "[Request interrupted by user]" } });
  noteFact(echoed, { type: "user", parent_tool_use_id: "toolu_1", message: { role: "user", content: "[Request interrupted by user]" } });
  assert.deepEqual(echoed, {}, "the user's own words and a subagent's lines are not the note");
});
