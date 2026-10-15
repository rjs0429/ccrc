import assert from "node:assert/strict";
import { test } from "node:test";
import type { DisplayItem } from "../src/protocol.ts";
import { BrokerSession } from "../src/sessions/broker-session.ts";

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
