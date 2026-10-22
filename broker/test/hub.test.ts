import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { Audit } from "../src/audit.ts";
import { Hub } from "../src/hub.ts";
import type { Leases } from "../src/lease.ts";
import type { DisplayItem, ServerMsg } from "../src/protocol.ts";
import { RemoteActivity } from "../src/remote-activity.ts";
import type { SessionManager, Snapshot } from "../src/sessions/manager.ts";
import { snapshotPart } from "../src/sessions/pages.ts";
import { Uploads } from "../src/uploads.ts";
import { tempDir } from "./helpers.ts";

const A = "11111111-2222-4333-8444-555555555555";

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: ServerMsg[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMsg);
  }
  ping(): void {}
  close(): void {
    this.readyState = 3;
  }
  terminate(): void {}
}

// A manager whose answers the test controls: how long a snapshot takes and whether the session is driven.
class FakeManager extends EventEmitter {
  controlled = false;
  delay = 0;
  watchers = 0;
  focuses: (string | undefined)[] = [];
  froms: (string | undefined)[] = [];
  seen: string[] = [];
  // What snapshots hold, the whole conversation, and the transcript watch's callback.
  part: Partial<Snapshot> = {};
  items: DisplayItem[] = [];
  changed?: () => void;
  setViewed(): void {}
  markSeen(sessionId: string): void {
    this.seen.push(sessionId);
  }
  isControlled(): boolean {
    return this.controlled;
  }
  async snapshot(sessionId: string, opts: { focus?: string; from?: string } = {}): Promise<Snapshot> {
    this.focuses.push(opts.focus);
    this.froms.push(opts.from);
    const state = this.controlled ? "attached" : "inactive";
    await new Promise((r) => setTimeout(r, this.delay));
    return { items: [], pending: [], hasMore: false, state: { sessionId, cwd: "/", state, busy: false }, ...this.part };
  }
  async conversation(sessionId: string) {
    return { items: this.items, state: { sessionId, cwd: "/", state: "inactive" as const, busy: false } };
  }
  watch(_sessionId: string, onChange: () => void): () => void {
    this.watchers++;
    this.changed = onChange;
    return () => this.watchers--;
  }
  async call(_sessionId: string, op: string, args: Record<string, unknown>): Promise<unknown> {
    await new Promise((r) => setTimeout(r, this.delay));
    if (op === "history") {
      const end = this.items.findIndex((i) => i.id === args.before);
      return { items: this.items.slice(Math.max(0, end - 2), end), more: end > 2 };
    }
    return op;
  }
}

function setup() {
  const manager = new FakeManager();
  const leases = Object.assign(new EventEmitter(), { validate: () => true }) as unknown as Leases;
  const audit = { log: () => {} } as unknown as Audit;
  const hub = new Hub(manager as unknown as SessionManager, leases, audit, new Uploads(tempDir()));
  const ws = new FakeSocket();
  hub.attach(ws as never, "test", "token");
  const view = (sessionId: string | null) => ws.emit("message", JSON.stringify({ t: "view", sessionId }));
  const snapshots = () => ws.sent.filter((m): m is Extract<ServerMsg, { t: "snapshot" }> => m.t === "snapshot");
  return { manager, hub, ws, view, snapshots };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a slow snapshot from before a session attached does not replace the attached one", async () => {
  const { manager, hub, view, snapshots } = setup();
  manager.delay = 150;
  view(A);
  await sleep(20);
  manager.controlled = true;
  manager.delay = 0;
  manager.emit("attached", A);
  await sleep(300);
  const sent = snapshots();
  assert.equal(sent.at(-1)?.state.state, "attached");
  assert.ok(sent.every((s) => s.state.state === "attached"), "the stale snapshot is dropped");
  assert.equal(manager.watchers, 0, "a driven session is not followed through its transcript");
  hub.close();
});

test("leaving and reopening a view quickly leaves one transcript watch", async () => {
  const { manager, hub, view } = setup();
  manager.delay = 50;
  view(A);
  await sleep(10);
  view(null);
  view(A);
  await sleep(200);
  assert.equal(manager.watchers, 1);
  view(null);
  await sleep(10);
  assert.equal(manager.watchers, 0);
  hub.close();
});

test("a call is answered to the window that made it, not to one that took over since", async () => {
  const { manager, hub, ws } = setup();
  manager.delay = 50;
  ws.emit("message", JSON.stringify({ t: "call", id: 1, sessionId: A, op: "context", args: {} }));
  const other = new FakeSocket();
  hub.attach(other as never, "laptop", "token2");
  other.emit("message", JSON.stringify({ t: "take_window" }));
  other.emit("message", JSON.stringify({ t: "call", id: 1, sessionId: A, op: "files", args: {} }));
  await sleep(150);
  assert.deepEqual(other.sent.filter((m) => m.t === "call_result"), [{ t: "call_result", id: 1, ok: true, data: "files" }]);
  assert.deepEqual(ws.sent.filter((m) => m.t === "call_result"), []);
  hub.close();
});

test("an output style change is written to the audit log; a missing style name is refused first", async () => {
  const manager = new FakeManager();
  const leases = Object.assign(new EventEmitter(), { validate: () => true }) as unknown as Leases;
  const logged: [string, Record<string, unknown>][] = [];
  const audit = { log: (event: string, detail: Record<string, unknown>) => logged.push([event, detail]) } as unknown as Audit;
  const hub = new Hub(manager as unknown as SessionManager, leases, audit, new Uploads(tempDir()));
  const ws = new FakeSocket();
  hub.attach(ws as never, "phone", "token");
  ws.emit("message", JSON.stringify({ t: "call", id: 1, sessionId: A, op: "output_style", args: {} }));
  ws.emit("message", JSON.stringify({ t: "call", id: 2, sessionId: A, op: "set_output_style", args: { style: "Explanatory" } }));
  ws.emit("message", JSON.stringify({ t: "call", id: 3, sessionId: A, op: "set_output_style", args: { style: "x".repeat(300) } }));
  ws.emit("message", JSON.stringify({ t: "call", id: 4, sessionId: A, op: "set_output_style", args: {} }));
  await sleep(50);
  assert.deepEqual(logged, [["call", { device: "phone", sessionId: A, op: "set_output_style", style: "Explanatory" }]]);
  const results = ws.sent.filter((m) => m.t === "call_result");
  assert.deepEqual(
    results.map((r) => [r.id, r.ok]).sort((x, y) => Number(x[0]) - Number(y[0])),
    [
      [1, true],
      [2, true],
      [3, false],
      [4, false],
    ],
  );
  hub.close();
});

test("taking back a queued message is written to the audit log", async () => {
  const manager = new FakeManager();
  const leases = Object.assign(new EventEmitter(), { validate: () => true }) as unknown as Leases;
  const logged: [string, Record<string, unknown>][] = [];
  const audit = { log: (event: string, detail: Record<string, unknown>) => logged.push([event, detail]) } as unknown as Audit;
  const hub = new Hub(manager as unknown as SessionManager, leases, audit, new Uploads(tempDir()));
  const ws = new FakeSocket();
  hub.attach(ws as never, "phone", "token");
  ws.emit("message", JSON.stringify({ t: "call", id: 1, sessionId: A, op: "unqueue", args: { messageId: "m-1" } }));
  await sleep(50);
  assert.deepEqual(logged, [["call", { device: "phone", sessionId: A, op: "unqueue", messageId: "m-1" }]]);
  hub.close();
});

test("a focused view keeps its focus while the same session is shown again", async () => {
  const { manager, hub, ws, view } = setup();
  const B = "7c2d1b90-3e4f-4a5b-8c6d-9e0f1a2b3c4d";
  ws.emit("message", JSON.stringify({ t: "view", sessionId: A, focus: "u1" }));
  await sleep(20);
  view(A);
  manager.emit("attached", A);
  await sleep(20);
  view(B);
  await sleep(20);
  ws.emit("message", JSON.stringify({ t: "view", sessionId: A, focus: 5 }));
  await sleep(20);
  assert.deepEqual(manager.focuses, ["u1", "u1", "u1", undefined]);
  assert.ok(ws.sent.some((m) => m.t === "error"));
  hub.close();
});

test("sending, starting a session and answering a request are the remote user's activity, kept across a restart", async () => {
  const B = "7c2d1b90-3e4f-4a5b-8c6d-9e0f1a2b3c4d";
  const C = "0f1e2d3c-4b5a-4968-8776-655443322110";
  const manager = Object.assign(new FakeManager(), {
    send: async () => {},
    answer: async () => {},
    pendingRequest: () => undefined,
    create: async (cwd: string) => ({ id: C, cwd, send: () => {} }),
  });
  const leases = Object.assign(new EventEmitter(), { validate: () => true }) as unknown as Leases;
  const audit = { log: () => {} } as unknown as Audit;
  const file = path.join(tempDir(), "remote-activity.json");
  const hub = new Hub(manager as unknown as SessionManager, leases, audit, new Uploads(tempDir()), new RemoteActivity(file));
  const ws = new FakeSocket();
  hub.attach(ws as never, "phone", "token");
  const before = Date.now();
  ws.emit("message", JSON.stringify({ t: "send", sessionId: A, text: "go on" }));
  ws.emit("message", JSON.stringify({ t: "answer", sessionId: B, requestId: "r1", answer: { kind: "permission", decision: "allow" } }));
  ws.emit("message", JSON.stringify({ t: "new_session", cwd: "/work", text: "start" }));
  await sleep(50);
  for (const id of [A, B, C]) assert.ok((hub.remoteActivity(id) ?? 0) >= before, id);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))).sort(), [A, B, C].sort());
  const D = "1a2b3c4d-5e6f-4789-8abc-def012345678";
  hub.noteRemoteActivity(D);
  assert.ok(new RemoteActivity(file).get(D), "another way to start work notes it the same way");
  hub.close();
});

test("a session counts as opened when it is viewed in a visible window, or the window comes back to it", async () => {
  const { manager, hub, ws, view } = setup();
  const B = "7c2d1b90-3e4f-4a5b-8c6d-9e0f1a2b3c4d";
  view(A);
  await sleep(20);
  assert.deepEqual(manager.seen, [A]);
  ws.emit("message", JSON.stringify({ t: "visibility", visible: false }));
  view(B);
  await sleep(20);
  assert.deepEqual(manager.seen, [A], "a hidden window does not open it");
  ws.emit("message", JSON.stringify({ t: "visibility", visible: true }));
  await sleep(20);
  assert.deepEqual(manager.seen, [A, B]);
  view(null);
  ws.emit("message", JSON.stringify({ t: "visibility", visible: true }));
  await sleep(20);
  assert.deepEqual(manager.seen, [A, B], "nothing is open");
  hub.close();
});

test("opening a subagent's transcript is written to the audit log; following it, paging back and reading output are not", async () => {
  const manager = new FakeManager();
  const leases = Object.assign(new EventEmitter(), { validate: () => true }) as unknown as Leases;
  const logged: [string, Record<string, unknown>][] = [];
  const audit = { log: (event: string, detail: Record<string, unknown>) => logged.push([event, detail]) } as unknown as Audit;
  const hub = new Hub(manager as unknown as SessionManager, leases, audit, new Uploads(tempDir()));
  const ws = new FakeSocket();
  hub.attach(ws as never, "phone", "token");
  const calls: [string, Record<string, unknown>][] = [
    ["agent_transcript", { agentId: "a1b2" }],
    ["agent_transcript", { agentId: "a1b2", after: { count: 3, lastId: "x" } }],
    ["agent_transcript", { agentId: "a1b2", before: 150 }],
    ["agent_transcript", { toolUseId: "toolu_9", agentId: "../x" }],
    ["task_output", { taskId: "b1" }],
    ["workflow_agents", { runId: "wf_1" }],
  ];
  calls.forEach(([op, args], n) => ws.emit("message", JSON.stringify({ t: "call", id: n + 1, sessionId: A, op, args })));
  await sleep(50);
  assert.deepEqual(logged, [
    ["agent_transcript", { device: "phone", sessionId: A, agentId: "a1b2" }],
    ["agent_transcript", { device: "phone", sessionId: A, toolUseId: "toolu_9" }],
  ]);
  const results = ws.sent.filter((m) => m.t === "call_result");
  assert.ok(results.length === calls.length && results.every((r) => r.ok), JSON.stringify(results));
  hub.close();
});

const item = (id: string, text = ""): DisplayItem => ({ kind: "user", id, text });

test("a view asked for again keeps the part the phone holds, the pages it loaded since included; a new one asks for the latest", async () => {
  const { manager, hub, ws, view } = setup();
  manager.items = ["i0", "i1", "i2", "i3", "i4", "i5"].map((id) => item(id));
  manager.part = { items: manager.items.slice(4), hasMore: true };
  view(A);
  await sleep(20);
  ws.emit("message", JSON.stringify({ t: "call", id: 1, sessionId: A, op: "history", args: { before: "i4" } }));
  await sleep(20);
  const page = ws.sent.find((m): m is Extract<ServerMsg, { t: "call_result" }> => m.t === "call_result" && m.id === 1);
  assert.deepEqual((page?.data as { items: DisplayItem[] }).items.map((i) => i.id), ["i2", "i3"]);
  manager.emit("attached", A);
  await sleep(20);
  ws.emit("message", JSON.stringify({ t: "view", sessionId: A, from: "i3" }));
  await sleep(20);
  view(A);
  await sleep(20);
  ws.emit("message", JSON.stringify({ t: "call", id: 2, sessionId: A, op: "history", args: { before: 7 } }));
  await sleep(20);
  assert.deepEqual(manager.froms, [undefined, "i2", "i3", undefined]);
  assert.ok(ws.sent.some((m) => m.t === "call_result" && m.id === 2 && !m.ok));
  hub.close();
});

test("a snapshot sent again after a focused open keeps the pages the phone loaded before the focused item", async () => {
  const { manager, hub, ws, snapshots } = setup();
  manager.items = Array.from({ length: 300 }, (_, n) => item(`i${n}`));
  manager.snapshot = async function (sessionId: string, opts: { focus?: string; from?: string } = {}) {
    this.focuses.push(opts.focus);
    this.froms.push(opts.from);
    return { ...snapshotPart(this.items, opts), pending: [], state: { sessionId, cwd: "/", state: "inactive", busy: false } };
  };
  ws.emit("message", JSON.stringify({ t: "view", sessionId: A, focus: "i100" }));
  await sleep(20);
  assert.deepEqual([snapshots()[0].items[0].id, snapshots()[0].gap?.before], ["i90", "i260"]);
  ws.emit("message", JSON.stringify({ t: "call", id: 1, sessionId: A, op: "history", args: { before: "i90" } }));
  await sleep(20);
  manager.emit("detached", A);
  await sleep(20);
  ws.emit("message", JSON.stringify({ t: "view", sessionId: A, from: "i88" }));
  await sleep(20);
  assert.deepEqual(manager.focuses, ["i100", "i100", "i100"]);
  assert.deepEqual(
    snapshots().slice(1).map((s) => [s.items[0].id, s.items.length, s.gap]),
    [
      ["i88", 212, undefined],
      ["i88", 212, undefined],
    ],
  );
  hub.close();
});

test("a session followed through its transcript gets the items that changed or came after the phone's last, each with the one before it", async () => {
  const { manager, hub, ws, view } = setup();
  manager.items = ["i0", "i1", "i2", "i3", "i4", "i5", "i6"].map((id) => item(id));
  manager.part = { items: manager.items.slice(4), hasMore: true, earlier: [manager.items[1]] };
  view(A);
  await sleep(20);
  const sent = ws.sent.length;
  manager.items = [item("i0"), item("i1", "changed aside"), item("i2"), item("i3", "changed, not held"), item("i4"), item("i5", "changed"), item("i6"), item("i7")];
  manager.changed!();
  await sleep(20);
  const out = ws.sent.slice(sent).filter((m): m is Extract<ServerMsg, { t: "item" }> => m.t === "item");
  assert.deepEqual(
    out.map((m) => [m.item.id, m.prev]),
    [
      ["i1", "i0"],
      ["i5", "i4"],
      ["i7", "i6"],
    ],
  );
  assert.ok(ws.sent.slice(sent).some((m) => m.t === "state"));
  const again = ws.sent.length;
  manager.changed!();
  await sleep(20);
  assert.deepEqual(ws.sent.slice(again).map((m) => m.t), ["state"]);
  manager.items = manager.items.filter((i) => i.id !== "i5");
  manager.changed!();
  await sleep(20);
  assert.deepEqual(ws.sent.slice(again + 1).map((m) => m.t), ["snapshot"]);
  hub.close();
});

test("new transcript items reach the phone wherever they come in the part it holds to the end, and none from a part it does not hold", async () => {
  const { manager, hub, ws, view } = setup();
  const unsent: DisplayItem = { kind: "note", id: "unsent-q1", code: "unsent", text: "queued" };
  manager.items = [item("t0"), item("t1"), unsent];
  manager.part = { items: manager.items, hasMore: false };
  view(A);
  await sleep(20);
  let sent = ws.sent.length;
  manager.items = [item("t0"), item("t1"), item("t2", "answered elsewhere"), item("t3"), unsent];
  manager.changed!();
  await sleep(20);
  const items = () => ws.sent.slice(sent).filter((m): m is Extract<ServerMsg, { t: "item" }> => m.t === "item").map((m) => [m.item.id, m.prev]);
  assert.deepEqual(items(), [
    ["t2", "t1"],
    ["t3", "t2"],
  ]);
  view(null);
  manager.items = ["i0", "i1", "i2", "i3", "i4", "i5", "i6", "i7", "i8", "i9"].map((id) => item(id));
  manager.part = { items: [manager.items[0], manager.items[1], manager.items[8], manager.items[9]], hasMore: false, gap: { before: "i8", skipped: 6 } };
  view(A);
  await sleep(20);
  sent = ws.sent.length;
  manager.items = [...manager.items.slice(0, 2), item("i2", "changed in the gap"), ...manager.items.slice(3), item("i10")];
  manager.changed!();
  await sleep(20);
  assert.deepEqual(items(), [["i10", "i9"]]);
  hub.close();
});

test("a side question's progress goes to the window that asked; only its length and thread are recorded, and a bad one is refused", async () => {
  const manager = new FakeManager();
  const got: unknown[][] = [];
  manager.call = async (_sessionId: string, op: string, args?: unknown, progress?: (p: Record<string, unknown>) => void) => {
    got.push([op, args]);
    progress?.({ status: "started" });
    await sleep(20);
    progress?.({ status: "retry", attempt: 1, maxRetries: 10, retryInMs: 500 });
    return op === "side_question" ? { answer: "fine" } : op === "git_changes" ? { state: "ok", files: [{}, {}], via: "claude" } : op;
  };
  const leases = Object.assign(new EventEmitter(), { validate: () => true }) as unknown as Leases;
  const logged: [string, Record<string, unknown>][] = [];
  const audit = { log: (event: string, detail: Record<string, unknown>) => logged.push([event, detail]) } as unknown as Audit;
  const hub = new Hub(manager as unknown as SessionManager, leases, audit, new Uploads(tempDir()));
  const ws = new FakeSocket();
  hub.attach(ws as never, "phone", "token");
  const send = (id: number, op: string, args: Record<string, unknown>) => ws.emit("message", JSON.stringify({ t: "call", id, sessionId: A, op, args }));
  send(1, "side_question", { question: "status?", history: [{ question: "a?", answer: "b", notice: "n" }], extra: true });
  send(2, "side_question", { question: "" });
  send(3, "side_question", { question: "q", history: [{ question: "a?", answer: 7 }] });
  send(4, "side_question", { question: "q", history: Array.from({ length: 21 }, () => ({ question: "a", answer: "b" })) });
  send(5, "git_changes", {});
  send(6, "agent_changes", {});
  send(7, "agent_changes", { follow: true });
  await sleep(80);
  assert.deepEqual(got[0], ["side_question", { question: "status?", history: [{ question: "a?", answer: "b", notice: "n" }] }], "only the question and its thread go on");
  assert.deepEqual(
    ws.sent.filter((m) => m.t === "call_progress"),
    [
      { t: "call_progress", id: 1, status: "started" },
      { t: "call_progress", id: 1, status: "retry", attempt: 1, maxRetries: 10, retryInMs: 500 },
    ],
    "only the side question hears of its progress",
  );
  const results = new Map(ws.sent.filter((m) => m.t === "call_result").map((m) => [m.id, m]));
  assert.deepEqual(results.get(1), { t: "call_result", id: 1, ok: true, data: { answer: "fine" } });
  for (const id of [2, 3, 4]) assert.equal(results.get(id)?.ok, false, `call ${id} refused`);
  assert.deepEqual(logged, [
    ["side_question", { device: "phone", sessionId: A, chars: 7, thread: 1 }],
    ["agent_changes", { device: "phone", sessionId: A }],
    ["git_changes", { device: "phone", sessionId: A, via: "claude", state: "ok", files: 2 }],
  ]);
  hub.close();
});

test("a side question may go with an id, be waited for again by it and be cancelled by it; a thread too large for one message is refused", async () => {
  const manager = new FakeManager();
  const got: unknown[][] = [];
  manager.call = async (_sessionId: string, op: string, args?: unknown, progress?: (p: Record<string, unknown>) => void) => {
    got.push([op, args]);
    progress?.({ status: "started" });
    return op === "side_question_cancel" ? {} : { answer: "fine" };
  };
  const leases = Object.assign(new EventEmitter(), { validate: () => true }) as unknown as Leases;
  const logged: [string, Record<string, unknown>][] = [];
  const audit = { log: (event: string, detail: Record<string, unknown>) => logged.push([event, detail]) } as unknown as Audit;
  const hub = new Hub(manager as unknown as SessionManager, leases, audit, new Uploads(tempDir()));
  const ws = new FakeSocket();
  hub.attach(ws as never, "phone", "token");
  const send = (id: number, op: string, args: Record<string, unknown>) => ws.emit("message", JSON.stringify({ t: "call", id, sessionId: A, op, args }));
  const long = "가".repeat(30_000);
  send(1, "side_question", { question: "q", ask: "k1-abc" });
  send(2, "side_question_wait", { ask: "k1-abc" });
  send(3, "side_question_cancel", { ask: "k1-abc" });
  send(4, "side_question_cancel", {});
  send(5, "side_question", { question: "q", ask: "not an id!" });
  send(6, "side_question_wait", {});
  send(7, "side_question", { question: "q", history: [1, 2, 3].map(() => ({ question: "a", answer: long })) });
  send(8, "side_question", { question: "q", history: [1, 2].map(() => ({ question: "a", answer: long })) });
  await sleep(50);
  const results = new Map(ws.sent.filter((m) => m.t === "call_result").map((m) => [m.id, m]));
  for (const id of [1, 2, 3, 4, 8]) assert.equal(results.get(id)?.ok, true, `call ${id} answered`);
  for (const id of [5, 6, 7]) assert.equal(results.get(id)?.ok, false, `call ${id} refused`);
  assert.deepEqual(got.slice(0, 4), [
    ["side_question", { question: "q", history: [], ask: "k1-abc" }],
    ["side_question_wait", { ask: "k1-abc" }],
    ["side_question_cancel", { ask: "k1-abc" }],
    ["side_question_cancel", {}],
  ]);
  assert.deepEqual(
    ws.sent.filter((m) => m.t === "call_progress").map((m) => m.id),
    [1, 2, 8],
    "the one waiting again hears of the progress too",
  );
  assert.deepEqual(
    logged.map(([e]) => e),
    ["side_question", "side_question"],
    "waiting again and cancelling are not new questions",
  );
  hub.close();
});

test("a window whose login a passkey has to confirm again is closed with the code that says so, and answers nothing", async () => {
  const { hub, ws, manager } = setup();
  const closed: unknown[] = [];
  ws.close = (code?: number) => {
    closed.push(code);
    ws.readyState = 3;
  };
  let due = false;
  hub.passkeyDue = (device) => due && device === "test";
  ws.emit("message", JSON.stringify({ t: "view", sessionId: A }));
  await sleep(20);
  assert.equal(manager.focuses.length, 1);
  due = true;
  ws.emit("message", JSON.stringify({ t: "view", sessionId: A }));
  await sleep(20);
  assert.deepEqual(closed, [4003]);
  assert.equal(manager.focuses.length, 1, "nothing more is answered");
  const idle = new FakeSocket();
  const idleClosed: unknown[] = [];
  idle.close = (code?: number) => void idleClosed.push(code);
  hub.attach(idle as never, "test", "token");
  (hub as unknown as { ping(): void }).ping();
  assert.deepEqual(idleClosed, [4003], "an idle window is closed at the next ping");
});
