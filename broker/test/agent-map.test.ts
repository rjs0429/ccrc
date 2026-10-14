import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mock, test } from "node:test";
import type { DisplayItem, PendingRequest, TaskInfo } from "../src/protocol.ts";
import { ItemBuilder } from "../src/sessions/items.ts";
import { TaskBook } from "../src/sessions/tasks.ts";
import { agentMap, elapsed, findNode } from "../../web/src/components/agents/tree.ts";

type Msg = Record<string, unknown>;
const PROBE = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "agent-probe.json"), "utf8")) as Record<string, Msg[]>;

// What the phone holds after the broker took in a recorded run up to message `upTo`.
function replay(k: string, upTo = PROBE[k].length) {
  const book = new TaskBook(() => {});
  const builder = new ItemBuilder("/tmp/f9-probe");
  const pending: PendingRequest[] = [];
  for (const m of PROBE[k].slice(0, upTo)) {
    if (m.type === "control_request") {
      const r = m.request as Msg;
      pending.push({ id: m.request_id as string, kind: "permission", toolName: r.tool_name as string, input: r.input as Msg, allowAlways: false, agentId: r.agent_id as string });
    } else if (m.type === "system" && TaskBook.handles(m.subtype)) book.on(m);
    builder.add(m as never);
  }
  const tasks = book.values();
  book.clear();
  return { tasks, items: builder.items, pending };
}

const at = (k: string, pred: (m: Msg) => boolean) => PROBE[k].findIndex(pred) + 1;

test("a nested subagent shows under the subagent that started it, merged with its Agent call", () => {
  const { tasks, items, pending } = replay("a", at("a", (m) => m.subtype === "task_progress" && m.task_id === "a8d26e194948c7c82"));
  const map = agentMap({ tasks, items, pending, busy: true });
  assert.equal(map.tree.length, 1);
  const outer = map.tree[0];
  assert.equal(outer.title, "Run nested subagent echo check");
  assert.equal(outer.itemId, "toolu_01MFKW2sCk2TMPNgjN4kaCk3");
  assert.equal(outer.prompt?.startsWith("Use the Agent tool yourself"), true);
  assert.deepEqual(
    outer.children.map((c) => [c.title, c.status, c.background]),
    [["Run nested echo check", "running", true]],
  );
  assert.deepEqual(map.chip, { running: 2, dot: "running" });
  assert.equal(map.past.length, 0, "a listed call is not also a past one");
});

test("once all agents end the chip shows done until the broker drops them", () => {
  const { tasks, items, pending } = replay("a");
  const map = agentMap({ tasks, items, pending, busy: false });
  assert.deepEqual(map.chip, { running: 0, dot: "done" });
  assert.deepEqual([map.counts.completed, map.counts.running], [2, 0]);
  const gone = agentMap({ tasks: [], items, pending, busy: false });
  assert.equal(gone.chip, undefined);
  assert.deepEqual(
    gone.past.map((n) => [n.title, n.status]),
    [["Run nested subagent echo check", "completed"]],
    "past agents come from the conversation; the nested one has no call of its own",
  );
});

test("a workflow shows its phases and agents and counts its running agents on the chip", () => {
  const { tasks, items, pending } = replay("b", at("b", (m) => m.subtype === "task_progress" && JSON.stringify(m).includes('"label":"join"')));
  const map = agentMap({ tasks, items, pending, busy: false });
  const wf = map.tree[0];
  assert.equal(wf.workflow, true);
  assert.equal(wf.name, "alpha-beta-join");
  assert.equal(wf.itemId, "toolu_011UT1xC9Fx3hWf24zG3PGpH");
  assert.deepEqual(wf.progress?.phases, ["gather", "join"]);
  assert.deepEqual([wf.progress?.phase, wf.progress?.running, wf.progress?.done], [1, 1, 2]);
  assert.deepEqual(map.chip, { running: 1, dot: "running" });
});

test("a workflow without its progress is one row counted once", () => {
  const tasks: TaskInfo[] = [{ id: "w1", description: "Review", kind: "local_workflow", status: "running", workflow: { name: "review", phases: [], agents: [], total: 0, running: 0, done: 0, failed: 0 } }];
  const map = agentMap({ tasks, items: [], pending: [], busy: false });
  assert.equal(map.tree[0].progress, undefined);
  assert.equal(map.tree[0].name, "review");
  assert.deepEqual(map.chip, { running: 1, dot: "running" });
});

test("a subagent asking for permission is waiting, and so is the chip", () => {
  const { tasks, items, pending } = replay("c", at("c", (m) => m.type === "control_request"));
  const map = agentMap({ tasks, items, pending, busy: true });
  assert.equal(map.tree[0].status, "waiting");
  assert.equal(map.tree[0].pending?.toolName, "Write");
  assert.deepEqual(map.chip, { running: 1, dot: "waiting" });
  assert.equal(map.counts.waiting, 1);
});

test("a workflow agent asking for permission makes its workflow wait", () => {
  const wf = { phases: ["a"], agents: [{ label: "x", id: "ag1", state: "running" as const }], total: 1, running: 1, done: 0, failed: 0 };
  const tasks: TaskInfo[] = [{ id: "w1", description: "Review", kind: "local_workflow", status: "running", workflow: wf }];
  const pending: PendingRequest[] = [{ id: "p1", kind: "permission", toolName: "Bash", input: {}, allowAlways: false, agentId: "ag1" }];
  assert.equal(agentMap({ tasks, items: [], pending, busy: true }).tree[0].status, "waiting");
});

test("shells and monitors alone bring no chip; they are background tasks", () => {
  const tasks: TaskInfo[] = [
    { id: "b1", description: "npm run dev", kind: "local_bash", type: "local_bash", status: "running" },
    { id: "m1", description: "watch logs", kind: "monitor_mcp", type: "monitor_mcp", status: "running", parentId: "a1" },
  ];
  const map = agentMap({ tasks, items: [], pending: [], busy: false });
  assert.equal(map.chip, undefined);
  assert.deepEqual(
    map.background.map((t) => t.id),
    ["b1", "m1"],
  );
  assert.equal(map.tree.length, 0);
});

test("siblings sort waiting, running longest first, failed, then the rest in the broker's order; an unknown parent means the main agent", () => {
  const t = (id: string, status: TaskInfo["status"], ms: number, parentId?: string): TaskInfo => ({ id, description: id, kind: "local_agent", status, ms, ...(parentId ? { parentId } : {}) });
  const tasks = [t("r-short", "running", 10), t("r-long", "running", 99), t("asks", "running", 5), t("done-late", "completed", 1), t("bad", "failed", 1), t("done-early", "completed", 1), t("orphan", "running", 50, "gone")];
  const pending: PendingRequest[] = [{ id: "p", kind: "permission", toolName: "Bash", input: {}, allowAlways: false, agentId: "asks" }];
  const map = agentMap({ tasks, items: [], pending, busy: true });
  assert.deepEqual(
    map.tree.map((n) => n.title),
    ["asks", "r-long", "orphan", "r-short", "bad", "done-late", "done-early"],
  );
});

test("parents that lead back to a node do not hide it", () => {
  const tasks: TaskInfo[] = [
    { id: "x", description: "x", kind: "local_agent", status: "running", parentId: "y" },
    { id: "y", description: "y", kind: "local_agent", status: "running", parentId: "x" },
  ];
  const map = agentMap({ tasks, items: [], pending: [], busy: true });
  assert.equal(map.tree.length, 2);
});

test("a call known only from the conversation takes its status from its end notice or its result", () => {
  const call = (id: string, extra: Partial<Extract<DisplayItem, { kind: "tool" }>>): DisplayItem => ({ kind: "tool", id, name: "Agent", summary: id, input: { description: id, prompt: "do it" }, ...extra });
  const items: DisplayItem[] = [
    call("noticed", { result: { text: "Async agent launched successfully.", isError: false, truncated: false }, sub: { tools: 3, recent: [], ended: { status: "failed", tokens: 1200 } } }),
    call("launched", { result: { text: "Async agent launched successfully.", isError: false, truncated: false } }),
    call("answered", { result: { text: "Found three files", isError: false, truncated: false } }),
    call("broke", { result: { text: "boom", isError: true, truncated: false } }),
    call("open", {}),
  ];
  const status = (busy: boolean) => Object.fromEntries(agentMap({ items, pending: [], busy }).past.map((n) => [n.title, n.status]));
  assert.deepEqual(status(true), { open: "running", broke: "failed", answered: "completed", launched: "unknown", noticed: "failed" });
  assert.equal(status(false).open, "unknown");
  const map = agentMap({ items, pending: [], busy: false });
  assert.deepEqual(
    map.past.map((n) => n.title),
    ["open", "broke", "answered", "launched", "noticed"],
    "latest first",
  );
  assert.equal(map.past.at(-1)?.tokens, 1200);
  assert.equal(findNode(map, "t:gone", "answered")?.title, "answered", "a node that left the list is found again by its call");
});

test("a running node's time counts on from the broker's measure", () => {
  mock.timers.enable({ apis: ["Date"], now: 10_000 });
  try {
    assert.equal(elapsed(5000, true, 7000, Date.now()), 8000);
    assert.equal(elapsed(5000, false, 7000, Date.now()), 5000);
    assert.equal(elapsed(undefined, true, 7000, Date.now()), undefined);
  } finally {
    mock.timers.reset();
  }
});

test("a subagent's result is its report without Claude Code's hand-back notice, indent, id and usage", () => {
  const { tasks, items, pending } = replay("a");
  const outer = agentMap({ tasks, items, pending, busy: false }).nodes.find((n) => n.task?.id === "a095e9cb1491eec1a")!;
  assert.equal(outer.result?.startsWith("The nested subagent is launched but has not finished"), true, outer.result);
  assert.equal(outer.result?.endsWith("too large to read directly."), true, outer.result);
});
