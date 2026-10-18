import assert from "node:assert/strict";
import { test } from "node:test";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { DisplayItem, PendingRequest } from "../src/protocol.ts";
import { BrokerSession } from "../src/sessions/broker-session.ts";
import { shellOutput } from "../src/sessions/core.ts";
import type { TurnEnd } from "../src/sessions/outcome.ts";

const SID = "3e7c9a10-5b2d-4f8e-9c1a-2d3e4f5a6b7c";
const MSG = "8d2e4f6a-1b3c-4d5e-8f9a-0b1c2d3e4f5a";

// An owned session whose SDK query is a stand-in that records the control methods called on it.
function owned() {
  const s = new BrokerSession(SID, "/tmp/project", [{ kind: "user", id: MSG, text: "edit a.txt" }]);
  const calls: unknown[][] = [];
  const q = {
    getContextUsage: async (opts: unknown) => {
      calls.push(["getContextUsage", opts]);
      return { categories: [{ name: "Messages", tokens: 10, color: "purple", kind: "used" }], totalTokens: 10, maxTokens: 100, percentage: 10.4, model: "m" };
    },
    mcpServerStatus: async () => {
      calls.push(["mcpServerStatus"]);
      return [{ name: "github", status: "disabled", scope: "user" }];
    },
    toggleMcpServer: async (name: string, enabled: boolean) => void calls.push(["toggleMcpServer", name, enabled]),
    reconnectMcpServer: async (name: string) => void calls.push(["reconnectMcpServer", name]),
    rewindFiles: async (id: string, opts: unknown) => {
      calls.push(["rewindFiles", id, opts]);
      return { canRewind: true, filesChanged: ["/tmp/project/a.txt"], insertions: 3, deletions: 0 };
    },
    stopTask: async (id: string) => void calls.push(["stopTask", id]),
  };
  (s as unknown as { q: typeof q }).q = q;
  return { s, calls };
}

test("owned sessions run the session controls through the SDK query", async () => {
  const { s, calls } = owned();
  assert.deepEqual(await s.contextDetail(), {
    percentage: 10.4,
    totalTokens: 10,
    maxTokens: 100,
    model: "m",
    categories: [{ name: "Messages", tokens: 10, kind: "used" }],
  });
  assert.deepEqual(s.context, { percent: 10, tokens: 10, max: 100 });
  assert.deepEqual(await s.mcpToggle("github", true), [{ name: "github", status: "disabled", scope: "user" }]);
  await s.mcpReconnect("github");
  assert.deepEqual(await s.rewind(MSG, true), { canRewind: true, filesChanged: ["/tmp/project/a.txt"], insertions: 3, deletions: 0 });
  s.tasks.on({ type: "system", subtype: "task_started", task_id: "b1", description: "npm test", task_type: "local_bash" });
  await s.stopTask("b1");
  assert.deepEqual(calls, [
    ["getContextUsage", { detail: "full" }],
    ["mcpServerStatus"],
    ["toggleMcpServer", "github", true],
    ["mcpServerStatus"],
    ["mcpServerStatus"],
    ["reconnectMcpServer", "github"],
    ["mcpServerStatus"],
    ["rewindFiles", MSG, { dryRun: true }],
    ["stopTask", "b1"],
  ]);
});

test("owned sessions refuse what the session did not report", async () => {
  const { s, calls } = owned();
  await assert.rejects(s.mcpToggle("gitlab", false), /unknown MCP server/);
  await assert.rejects(s.rewind("8d2e4f6a-1b3c-4d5e-8f9a-ffffffffffff", true), /unknown message/);
  await assert.rejects(s.stopTask("b1"), /task is not running/);
  s.busy = true;
  await assert.rejects(s.rewind(MSG, false), /session is busy/);
  assert.deepEqual(calls, [["mcpServerStatus"]]);
});

test("an owned session reads the output of a shell or monitor it lists, running or ended, and of nothing else", async () => {
  const { s } = owned();
  const asked: unknown[] = [];
  Object.assign((s as unknown as { q: object }).q, {
    request: async (r: unknown) => (asked.push(r), { response: { output: "\u001b[32mline1\u001b[0m\n", total_bytes: 14, truncated: false } }),
  });
  const started = (task_id: string, task_type: string) => s.tasks.on({ type: "system", subtype: "task_started", task_id, description: task_id, task_type });
  started("b1", "local_bash");
  started("m1", "monitor_mcp");
  started("s1", "monitor_ws");
  started("a1", "local_agent");
  assert.deepEqual(await s.taskOutput("b1"), { text: "\u001b[32mline1\u001b[0m\n", totalBytes: 14, truncated: false });
  await s.taskOutput("m1");
  await s.taskOutput("s1");
  await assert.rejects(s.taskOutput("a1"), /not a shell task/);
  await assert.rejects(s.taskOutput("b9"), /not a shell task/);
  s.tasks.on({ type: "system", subtype: "task_notification", task_id: "b1", status: "completed", summary: "done" });
  await s.taskOutput("b1");
  assert.deepEqual(asked, [
    { subtype: "get_task_output", task_id: "b1" },
    { subtype: "get_task_output", task_id: "m1" },
    { subtype: "get_task_output", task_id: "s1" },
    { subtype: "get_task_output", task_id: "b1" },
  ]);
  s.tasks.clear();
});

test("an owned session moves a call to the background only while Claude Code lists it running in the foreground", async () => {
  const { s } = owned();
  const asked: unknown[] = [];
  let answer = true;
  Object.assign((s as unknown as { q: object }).q, { backgroundTasks: async (id: unknown) => (asked.push(id), answer) });
  const started = (task_id: string, task_type: string, tool_use_id: string, is_backgrounded: boolean) =>
    s.tasks.on({ type: "system", subtype: "task_started", task_id, description: task_id, task_type, tool_use_id, is_backgrounded });
  started("b1", "local_bash", "toolu_1", false);
  started("a1", "local_agent", "toolu_2", false);
  started("b2", "local_bash", "toolu_3", true);
  assert.equal(await s.background("toolu_1"), true);
  assert.equal(await s.background("toolu_2"), true);
  await assert.rejects(s.background("toolu_3"), /not running in the foreground/);
  await assert.rejects(s.background("toolu_4"), /not running in the foreground/);
  answer = false;
  assert.equal(await s.background("toolu_1"), false);
  s.tasks.on({ type: "system", subtype: "task_updated", task_id: "b1", patch: { is_backgrounded: true } });
  await assert.rejects(s.background("toolu_1"), /not running in the foreground/);
  s.tasks.on({ type: "system", subtype: "task_notification", task_id: "a1", status: "completed", summary: "done" });
  await assert.rejects(s.background("toolu_2"), /not running in the foreground/);
  assert.deepEqual(asked, ["toolu_1", "toolu_2", "toolu_1"]);
  s.tasks.clear();
});

test("Claude Code's output answer keeps its end and says when it began earlier", () => {
  assert.deepEqual(shellOutput(undefined), { text: "", totalBytes: 0, truncated: false });
  assert.deepEqual(shellOutput({ output: 7, total_bytes: -1, truncated: "yes" }), { text: "", totalBytes: 0, truncated: false });
  const long = shellOutput({ output: `${"a".repeat(70_000)}END`, total_bytes: 70_003, truncated: false });
  assert.equal(long.text.length, 64 * 1024);
  assert.ok(long.text.endsWith("END") && long.truncated);
});

test("a message still waiting in the broker is taken back here without asking Claude Code", async () => {
  const { s } = owned();
  const asked: unknown[] = [];
  Object.assign((s as unknown as { q: object }).q, { request: async (r: unknown) => (asked.push(r), { response: { cancelled: true } }) });
  const input = (s as unknown as { input: { messages(): AsyncGenerator<{ uuid: string }> } }).input.messages();
  s.send("first");
  const [first] = [...s.queue.keys()];
  await s.unqueue(first);
  assert.equal(s.queue.size, 0);
  assert.equal(s.busy, false, "nothing went to Claude Code, so nothing runs");
  assert.deepEqual(asked, []);

  s.send("second");
  const [second] = [...s.queue.keys()];
  assert.equal((await input.next()).value?.uuid, second, "the taken-back message is never given");
  s.send("third");
  const third = [...s.queue.keys()].find((id) => id !== second)!;
  await s.unqueue(third);
  assert.equal(s.busy, true, "the message Claude Code has still runs");
  await s.unqueue(second);
  assert.deepEqual(asked, [{ subtype: "cancel_async_message", message_uuid: second }], "only a message Claude Code has is cancelled there");
});

test("a reply from Claude Code has its own time, or the time the broker received it when it comes without one", async () => {
  const s = new BrokerSession(SID, "/tmp/project");
  const items: DisplayItem[] = [];
  s.on("item", (item: DisplayItem) => items.push(item));
  const before = Date.now();
  async function* replies() {
    yield { type: "assistant", uuid: "a1", session_id: SID, parent_tool_use_id: null, message: { content: [{ type: "text", text: "no time" }] } };
    yield { type: "assistant", uuid: "a2", session_id: SID, parent_tool_use_id: null, timestamp: "2026-10-14T23:59:58.000Z", message: { content: [{ type: "text", text: "own time" }] } };
  }
  await (s as unknown as { consume(q: AsyncIterable<unknown>): Promise<void> }).consume(replies());
  const received = Date.parse(items[0]?.ts ?? "");
  assert.ok(received >= before && received <= Date.now(), items[0]?.ts);
  assert.equal(items[1]?.ts, "2026-10-14T23:59:58.000Z");
});

type Consumer = { consume(q: AsyncIterable<unknown>): Promise<void> };

test("Claude Code ending on its own during a turn is a crash, told as the turn's end; after a turn, or closed by ccrc, it is not", async () => {
  const run = async (lines: unknown[], fail?: string) => {
    const s = new BrokerSession(SID, "/tmp/project");
    const ends: TurnEnd[] = [];
    s.on("turn_end", (e: TurnEnd) => ends.push(e));
    async function* stream() {
      yield* lines;
      if (fail) throw Error(fail);
    }
    await (s as unknown as Consumer).consume(stream());
    return { s, ends };
  };
  const init = { type: "system", subtype: "init", session_id: SID, model: "m" };
  const killed = await run([init], "Claude Code process terminated by signal SIGKILL");
  assert.deepEqual(
    killed.ends.map((e) => [e.outcome, e.attached]),
    [["crashed", false]],
  );
  assert.equal(killed.s.closedReason, "crashed");
  assert.ok(killed.s.builder.items.some((i) => i.kind === "note" && i.code === "error"), "the error stays in the conversation");
  const finished = await run([init, { type: "result", subtype: "success", is_error: false, terminal_reason: "completed", session_id: SID }], "Claude Code process exited with code 1");
  assert.deepEqual(
    finished.ends.map((e) => e.outcome),
    ["done"],
  );
  assert.equal(finished.s.closedReason, "ended");

  const s = new BrokerSession(SID, "/tmp/project");
  const ends: TurnEnd[] = [];
  s.on("turn_end", (e: TurnEnd) => ends.push(e));
  let fail!: (e: Error) => void;
  const failed = new Promise<never>((_, reject) => (fail = reject));
  async function* held() {
    yield init;
    await failed;
  }
  const consumed = (s as unknown as Consumer).consume(held());
  await new Promise((r) => setTimeout(r, 10));
  const closing = s.close("released");
  fail(Error("Claude Code process exited with code 143"));
  await Promise.all([closing, consumed]);
  assert.deepEqual(ends, []);
  assert.equal(s.closedReason, "released");
});

test("an ask that must not be approved by a stray tap reaches the phone with deny first, and never as a lasting rule", async () => {
  const s = new BrokerSession(SID, "/tmp/project");
  const added: PendingRequest[] = [];
  s.on("pending_add", (r: PendingRequest) => added.push(r));
  const canUseTool = (s as unknown as { canUseTool: CanUseTool }).canUseTool;
  const suggestions = [{ type: "addRules" as const, rules: [{ toolName: "mcp__claude-in-chrome__navigate" }], behavior: "allow" as const, destination: "localSettings" as const }];
  const result = canUseTool("mcp__claude-in-chrome__navigate", { url: "https://bank.example.com" }, { signal: new AbortController().signal, requestId: "r1", toolUseID: "t1", defaultToNo: true, suppressAlwaysAllowRule: true, suggestions });
  assert.deepEqual([added[0]?.defaultToNo, added[0]?.allowAlways], [true, false]);
  await s.answer("r1", { kind: "permission", decision: "allow_always" });
  assert.deepEqual(await result, { behavior: "allow", updatedInput: { url: "https://bank.example.com" } });
});
