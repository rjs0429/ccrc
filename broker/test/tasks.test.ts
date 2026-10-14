import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mock, test } from "node:test";
import { TaskBook, workflowProgress } from "../src/sessions/tasks.ts";

type Msg = Record<string, unknown>;
// Messages a real Claude Code (haiku) sent through the SDK: a: a subagent that starts a nested subagent,
// b: a workflow of three agents in two phases, c: a background subagent asking for permission.
const PROBE = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "agent-probe.json"), "utf8")) as Record<string, Msg[]>;
const taskMessages = (k: string) => PROBE[k].filter((m) => m.type === "system" && TaskBook.handles(m.subtype));

function book() {
  let sent = 0;
  const b = new TaskBook(() => sent++);
  return { b, sent: () => sent };
}

test("a nested subagent hangs under the subagent that started it, with its depth and the activity apart from its name", () => {
  const { b } = book();
  const msgs = taskMessages("a");
  const upTo = (n: number) => msgs.slice(0, n).forEach((m) => b.on(m));
  upTo(msgs.findIndex((m) => m.subtype === "task_started" && m.parent_task_id));
  const outer = b.get("a095e9cb1491eec1a")!;
  assert.equal(outer.description, "Run nested subagent echo check");
  assert.equal(outer.activity, "Run nested echo check", "the progress names what it does now");
  assert.deepEqual([outer.kind, outer.agentType, outer.depth, outer.background, outer.status], ["local_agent", "general-purpose", 1, false, "running"]);
  const listedFirst = b.get("a8d26e194948c7c82")!;
  assert.equal(listedFirst.parentId, "a095e9cb1491eec1a", "the list of background tasks names its parent before it starts");
  msgs.slice(msgs.findIndex((m) => m.subtype === "task_started" && m.parent_task_id)).forEach((m) => b.on(m));
  const inner = b.get("a8d26e194948c7c82")!;
  assert.deepEqual([inner.parentId, inner.depth, inner.background, inner.status, inner.toolUseId], ["a095e9cb1491eec1a", 2, true, "completed", "toolu_01YF8X1LLAWMPL2457UJCQDo"]);
  assert.equal(inner.summary, "The command `echo nested-ok` printed exactly: `nested-ok`");
  assert.deepEqual([inner.tokens, inner.tools, inner.ms], [12153, 1, 3208]);
  assert.equal(b.get("a095e9cb1491eec1a")?.status, "completed");
  assert.equal(b.running(), false);
  b.clear();
});

test("a workflow's progress gives its phases and agents", () => {
  const { b } = book();
  const msgs = taskMessages("b");
  const progress = msgs.filter((m) => m.subtype === "task_progress");
  for (const m of msgs.slice(0, msgs.indexOf(progress[0]) + 1)) b.on(m);
  let wf = b.get("ws4ojltl1")!;
  assert.equal(wf.kind, "local_workflow");
  assert.equal(wf.workflow?.name, "alpha-beta-join");
  assert.deepEqual(wf.workflow?.phases, ["gather", "join"]);
  assert.deepEqual(
    wf.workflow?.agents.map((a) => [a.label, a.phase, a.state]),
    [
      ["gather:alpha", 0, "running"],
      ["gather:beta", 0, "queued"],
    ],
  );
  assert.equal(wf.summary, undefined, "a summary that repeats the name is left out");
  for (const m of msgs.slice(msgs.indexOf(progress[0]) + 1, msgs.indexOf(progress.at(-1)!) + 1)) b.on(m);
  wf = b.get("ws4ojltl1")!;
  assert.deepEqual(wf.workflow && { ...wf.workflow, agents: wf.workflow.agents.map((a) => [a.label, a.phase, a.state, a.tokens, a.ms]) }, {
    name: "alpha-beta-join",
    phases: ["gather", "join"],
    phase: 1,
    agents: [
      ["gather:alpha", 0, "done", 10179, 1484],
      ["gather:beta", 0, "done", 10178, 1437],
      ["join", 1, "done", 10217, 1973],
    ],
    total: 3,
    running: 0,
    done: 3,
    failed: 0,
  });
  assert.equal(wf.workflow?.agents[2].id, "adc5e4cf751d4364d");
  for (const m of msgs.slice(msgs.indexOf(progress.at(-1)!) + 1)) b.on(m);
  assert.deepEqual([b.get("ws4ojltl1")?.status, b.get("ws4ojltl1")?.ms, b.get("ws4ojltl1")?.tokens], ["completed", 4654, 30574]);
  b.clear();
});

test("workflow progress of another shape is left out", () => {
  assert.equal(workflowProgress(undefined), undefined);
  assert.equal(workflowProgress({ phases: [] }), undefined);
  assert.equal(workflowProgress([{ type: "something_else" }, null, 3, "x"]), undefined);
  const many = Array.from({ length: 45 }, (_, i) => ({ type: "workflow_agent", index: i, label: `agent ${i}`, state: i % 3 === 0 ? "error" : "progress", startedAt: 1, tokens: "lots" }));
  const wf = workflowProgress([{ type: "workflow_phase", index: 1, title: "only" }, ...many])!.info;
  assert.equal(wf.agents.length, 40);
  assert.deepEqual([wf.total, wf.failed, wf.running], [45, 15, 30]);
  assert.equal(wf.agents[0].tokens, undefined, "a value of the wrong type is dropped");
  assert.equal(wf.agents[0].phase, undefined, "an agent of an unknown phase has none");
});

test("progress alone goes out at most once a second; a change of state goes out at once", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  try {
    const { b, sent } = book();
    b.on({ subtype: "task_started", task_id: "t1", description: "Find", task_type: "local_agent" });
    assert.equal(sent(), 1);
    for (let n = 1; n <= 5; n++) b.on({ subtype: "task_progress", task_id: "t1", description: `step ${n}`, usage: { total_tokens: n, tool_uses: n, duration_ms: n } });
    assert.equal(sent(), 1);
    mock.timers.tick(1000);
    assert.equal(sent(), 2);
    assert.equal(b.get("t1")?.activity, "step 5");
    b.on({ subtype: "task_progress", task_id: "t1", description: "step 6", usage: { total_tokens: 6, tool_uses: 6, duration_ms: 6 } });
    b.on({ subtype: "task_updated", task_id: "t1", patch: { is_backgrounded: true } });
    assert.equal(sent(), 3, "the change to the background goes out with the progress before it");
    mock.timers.tick(5000);
    assert.equal(sent(), 3, "nothing waits after that");
    b.on({ subtype: "task_progress", task_id: "t1", description: "step 6", usage: { total_tokens: 6, tool_uses: 6, duration_ms: 6 } });
    mock.timers.tick(5000);
    assert.equal(sent(), 3, "the same progress again is no change");
    b.clear();
  } finally {
    mock.timers.reset();
  }
});

test("an ended task stays five minutes, measured from its end, then leaves", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  try {
    const { b } = book();
    b.on({ subtype: "task_started", task_id: "t1", description: "Find", task_type: "local_agent" });
    mock.timers.tick(90_000);
    assert.equal(b.get("t1")?.ms, 90_000, "a running task's time is the broker's own measure");
    b.on({ subtype: "task_notification", task_id: "t1", status: "completed", summary: "done" });
    assert.equal(b.get("t1")?.ms, 90_000);
    mock.timers.tick(4 * 60_000);
    assert.equal(b.get("t1")?.ms, 90_000, "an ended task's time stops");
    mock.timers.tick(60_000 - 1);
    assert.equal(b.has("t1"), true);
    mock.timers.tick(1);
    assert.equal(b.has("t1"), false);
    b.clear();
  } finally {
    mock.timers.reset();
  }
});

test("a later run of the same task starts over and messages of the earlier run are dropped", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  try {
    const { b } = book();
    b.on({ subtype: "task_started", task_id: "t1", run_id: "0mv1-a", description: "Find", task_type: "local_agent" });
    b.on({ subtype: "task_notification", task_id: "t1", run_id: "0mv1-a", status: "completed", summary: "first", usage: { total_tokens: 10, tool_uses: 2, duration_ms: 5000 } });
    mock.timers.tick(10_000);
    b.on({ subtype: "task_started", task_id: "t1", run_id: "0mv2-b", description: "Find", task_type: "local_agent" });
    const t = b.get("t1")!;
    assert.deepEqual([t.status, t.ms, t.summary, t.tokens], ["running", 0, undefined, undefined]);
    b.on({ subtype: "task_notification", task_id: "t1", run_id: "0mv1-a", status: "failed", summary: "late" });
    assert.equal(b.get("t1")?.status, "running");
    mock.timers.tick(5 * 60_000);
    assert.equal(b.has("t1"), true, "the earlier run's removal no longer applies");
    b.clear();
  } finally {
    mock.timers.reset();
  }
});

test("the list of background tasks adds what was missed and drops what has gone, but only background tasks", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  try {
    const { b, sent } = book();
    b.on({ subtype: "task_started", task_id: "fg", description: "Foreground", task_type: "local_agent", is_backgrounded: false });
    b.on({ subtype: "task_started", task_id: "bg", description: "Background", task_type: "local_agent", is_backgrounded: true });
    b.on({ subtype: "task_started", task_id: "done", description: "Ends late", task_type: "local_bash", is_backgrounded: true });
    const before = sent();
    b.on({
      subtype: "background_tasks_changed",
      tasks: [
        { task_id: "wf", run_id: "r1", task_type: "local_workflow", description: "Review" },
        { task_id: "amb", task_type: "local_bash", description: "watch", ambient: true },
        { task_id: 7 },
        "x",
      ],
    });
    assert.equal(sent(), before + 1);
    assert.deepEqual(
      b.values().map((t) => [t.id, t.status]),
      [
        ["fg", "running"],
        ["bg", "running"],
        ["done", "running"],
        ["wf", "running"],
      ],
    );
    b.on({ subtype: "task_started", task_id: "amb", description: "watch", task_type: "local_bash" });
    assert.equal(b.has("amb"), false, "an ambient task stays out");
    mock.timers.tick(2000);
    b.on({ subtype: "task_notification", task_id: "done", status: "completed", summary: "ok" });
    mock.timers.tick(1000);
    assert.equal(b.has("bg"), false, "a background task missing from the list is dropped");
    assert.equal(b.get("fg")?.status, "running", "a foreground task is never in the list");
    assert.equal(b.get("done")?.status, "completed", "a task whose end arrived meanwhile keeps it");
    b.on({ subtype: "task_progress", task_id: "wf", run_id: "r1", description: "x", usage: { total_tokens: 1, tool_uses: 0, duration_ms: 600_000 } });
    assert.equal(b.get("wf")?.ms, 600_000, "a task first seen in the list takes its start from its first progress");
    b.clear();
  } finally {
    mock.timers.reset();
  }
});

test("a task first seen in a list keeps its parent once the parent has ended and the list no longer names it", () => {
  const { b } = book();
  for (const m of taskMessages("a")) b.on(m);
  assert.equal(b.get("a8d26e194948c7c82")?.parentId, "a095e9cb1491eec1a");
  b.clear();
});

test("the list keeps at most sixty tasks, running ones first", () => {
  const { b } = book();
  for (let n = 0; n < 70; n++) {
    b.on({ subtype: "task_started", task_id: `t${n}`, description: `task ${n}`, task_type: "local_bash" });
    if (n < 65) b.on({ subtype: "task_notification", task_id: `t${n}`, status: "completed", summary: "" });
  }
  const list = b.values();
  assert.equal(list.length, 60);
  assert.deepEqual(
    list.slice(0, 5).map((t) => t.status),
    ["running", "running", "running", "running", "running"],
  );
  b.clear();
});
