import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { Audit } from "../src/audit.ts";
import type { Leases } from "../src/lease.ts";
import type { AgentTranscript, ServerMsg, TaskOutput } from "../src/protocol.ts";
import type { SessionCore } from "../src/sessions/core.ts";
import type { SessionManager, Snapshot } from "../src/sessions/manager.ts";

// Transcripts are read from ~/.claude, so the test runs against an empty home of its own.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccrc-follow-"));
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
after(() => fs.rmSync(home, { recursive: true, force: true }));

const { projectDirName } = await import("../src/sessions/history.ts");
const { Follows, advance } = await import("../src/sessions/follow.ts");
const { TaskBook } = await import("../src/sessions/tasks.ts");
const { Hub } = await import("../src/hub.ts");
const { Uploads } = await import("../src/uploads.ts");

const SID = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
const cwd = path.join(home, "ws");
const project = path.join(home, ".claude", "projects", projectDirName(cwd));
const subagents = path.join(project, SID, "subagents");
fs.mkdirSync(subagents, { recursive: true });
fs.writeFileSync(path.join(project, `${SID}.jsonl`), JSON.stringify({ type: "user", uuid: "m1", parentUuid: null, sessionId: SID, cwd, message: { role: "user", content: "go" } }) + "\n");

type Row = Record<string, unknown>;
type Pushed = Extract<ServerMsg, { t: "follow" | "follow_end" }>;

// A subagent's transcript in the shape Claude Code writes it, a line at a time, each after the one before.
function transcript(agentId: string) {
  const file = path.join(subagents, `agent-${agentId}.jsonl`);
  let parent: string | null = null;
  let n = 0;
  const add = (r: Row) => {
    const row: Row = { parentUuid: parent, isSidechain: true, agentId, sessionId: SID, cwd, timestamp: new Date(Date.UTC(2026, 9, 18, 1, 0, n++)).toISOString(), ...r };
    parent = r.uuid as string;
    fs.appendFileSync(file, JSON.stringify(row) + "\n");
  };
  fs.writeFileSync(file, "");
  return {
    file,
    prompt: (uuid: string, text: string) => add({ type: "user", uuid, message: { role: "user", content: text } }),
    say: (uuid: string, text: string) => add({ type: "assistant", uuid, message: { role: "assistant", content: [{ type: "text", text }] } }),
    call: (uuid: string, id: string) => add({ type: "assistant", uuid, message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command: "ls" } }] } }),
    result: (uuid: string, id: string, text: string) => add({ type: "user", uuid, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] } }),
  };
}

// What the broker sends the window, and a way to wait for the next message that matches.
function window() {
  const sent: Pushed[] = [];
  const waiters: { pred: (m: Pushed) => boolean; resolve: (m: Pushed) => void }[] = [];
  const push = (_sessionId: string, msg: ServerMsg) => {
    const m = msg as Pushed;
    sent.push(m);
    for (const w of [...waiters]) if (w.pred(m)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(m));
  };
  const next = (pred: (m: Pushed) => boolean, label: string, ms = 1500) =>
    new Promise<Pushed>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`timed out waiting for ${label}`)), ms);
      waiters.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m)) });
    });
  return { sent, push, next };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ids = (r?: AgentTranscript) => (r?.items ?? []).map((i) => i.id);

test("a followed transcript sends what is written as it is written, each change from where the last one left it", async () => {
  const t = transcript("afol");
  t.prompt("p1", "Look around");
  t.say("p2", "Looking.");
  const w = window();
  const follows = new Follows({ cwdOf: async () => cwd, session: () => undefined, push: w.push });
  const start = await follows.start(SID, { id: "f1", kind: "transcript", agentId: "afol", after: { count: 2, lastId: "p2:0" } });
  assert.deepEqual(start, { live: true });
  let at = Date.now();
  t.call("p3", "toolu_ls");
  const first = await w.next((m) => m.t === "follow", "the call");
  assert.ok(Date.now() - at < 1200, `${Date.now() - at}ms`);
  assert.deepEqual([first.t === "follow" && first.base, first.t === "follow" && ids(first.transcript)], [{ count: 2, lastId: "p2:0" }, ["toolu_ls"]]);
  at = Date.now();
  t.result("p4", "toolu_ls", "a.txt");
  t.say("p5", "One file.");
  const second = await w.next((m) => m.t === "follow" && Boolean(m.transcript?.items.length), "the reply");
  assert.ok(Date.now() - at < 1200, `${Date.now() - at}ms`);
  assert.ok(second.t === "follow");
  assert.deepEqual(second.base, { count: 3, lastId: "toolu_ls" });
  assert.deepEqual(ids(second.transcript), ["p5:0"]);
  assert.deepEqual(
    second.transcript?.changed?.map((i) => i.kind === "tool" && i.result?.text),
    ["a.txt"],
    "the call's result arrives in place",
  );
  t.say("p6", "Done.");
  const third = await w.next((m) => m.t === "follow", "the last words");
  assert.ok(third.t === "follow");
  assert.deepEqual(third.base, { count: 4, lastId: "p5:0" });
  assert.equal(third.transcript?.changed, undefined, "a result already sent is not sent again");
  follows.stopAll();
  assert.equal(follows.size, 0);
});

test("asked again under the same id, a follow sends from where the phone says it stands; let go, it sends nothing more", async () => {
  const t = transcript("aagain");
  t.prompt("q1", "Count");
  t.say("q2", "one");
  t.say("q3", "two");
  const w = window();
  const follows = new Follows({ cwdOf: async () => cwd, session: () => undefined, push: w.push });
  const start = await follows.start(SID, { id: "f2", kind: "transcript", agentId: "aagain", after: { count: 1, lastId: "q1" } });
  assert.deepEqual([start.live, ids(start.transcript), start.transcript?.from], [true, ["q2:0", "q3:0"], 1]);
  const again = await follows.start(SID, { id: "f2", kind: "transcript", agentId: "aagain", after: { count: 2, lastId: "q2:0" } });
  assert.deepEqual([again.live, ids(again.transcript)], [true, ["q3:0"]]);
  const off = await follows.start(SID, { id: "f2", kind: "transcript", agentId: "aagain", after: { count: 3, lastId: "elsewhere" } });
  assert.equal(off.transcript?.reset, true, "a cursor that no longer lines up gets the latest page");
  assert.equal(follows.size, 1, "the same follow, not another");
  follows.stop("f2");
  assert.equal(follows.size, 0);
  t.say("q4", "three");
  await sleep(400);
  assert.equal(w.sent.length, 0);
});

test("a transcript not there yet is not watched; a watched one that goes away ends its follow", async () => {
  const w = window();
  const follows = new Follows({ cwdOf: async () => cwd, session: () => undefined, push: w.push });
  assert.deepEqual(await follows.start(SID, { id: "f3", kind: "transcript", agentId: "anone", after: { count: 0, lastId: "" } }), { live: false });
  assert.equal(follows.size, 0);
  const t = transcript("agone");
  t.prompt("g1", "Go");
  const start = await follows.start(SID, { id: "f4", kind: "transcript", agentId: "agone", after: { count: 0, lastId: "" } });
  assert.deepEqual([start.live, ids(start.transcript)], [true, ["g1"]]);
  fs.rmSync(t.file);
  const end = await w.next((m) => m.t === "follow_end", "the end", 3000);
  assert.deepEqual(end, { t: "follow_end", sessionId: SID, id: "f4" });
  assert.equal(follows.size, 0);
  for (const args of [{ id: "../x", kind: "transcript", agentId: "agone" }, { id: "f5", kind: "transcript" }, { id: "f5", kind: "transcript", agentId: "a/b" }, { id: "f5", kind: "other" }, { id: "f5", kind: "output" }]) {
    await assert.rejects(follows.start(SID, args), /invalid request/, JSON.stringify(args));
  }
  await assert.rejects(follows.start(SID, { id: "f5", kind: "output", taskId: "b1" }), /session is not running here/);
});

test("the kernel's watch tells of each change at once; a watch that breaks, or cannot start, goes on by looking at the file", async () => {
  const t = transcript("akernel");
  t.prompt("k1", "Go");
  const w = window();
  const follows = new Follows({ cwdOf: async () => cwd, session: () => undefined, push: w.push });
  const real = { watch: fs.watch, watchFile: fs.watchFile, unwatchFile: fs.unwatchFile };
  const kernel: (EventEmitter & { closed: boolean })[] = [];
  let looking = 0;
  const fake = fs as unknown as Record<string, unknown>;
  fake.watch = (_file: string, _opts: unknown, listener: (event: string) => void) => {
    const watcher = Object.assign(new EventEmitter(), {
      closed: false,
      close() {
        watcher.closed = true;
      },
    });
    watcher.on("change", listener);
    kernel.push(watcher);
    return watcher;
  };
  fake.watchFile = (...a: Parameters<typeof fs.watchFile>) => (looking++, real.watchFile(...a));
  fake.unwatchFile = (...a: Parameters<typeof fs.unwatchFile>) => (looking--, real.unwatchFile(...a));
  try {
    assert.equal((await follows.start(SID, { id: "k", kind: "transcript", agentId: "akernel", after: { count: 1, lastId: "k1" } })).live, true);
    assert.equal(kernel.length, 1);
    t.say("k2", "one");
    let at = Date.now();
    kernel[0].emit("change", "change");
    const told = await w.next((m) => m.t === "follow", "the change the kernel told of");
    assert.ok(Date.now() - at < 300, `${Date.now() - at}ms`);
    assert.deepEqual(told.t === "follow" && ids(told.transcript), ["k2:0"]);
    kernel[0].emit("error", Error("watch broke"));
    assert.equal(kernel[0].closed, true);
    assert.equal(looking, 1);
    t.say("k3", "two");
    at = Date.now();
    const looked = await w.next((m) => m.t === "follow", "the change found by looking");
    assert.ok(Date.now() - at < 1200, `${Date.now() - at}ms`);
    assert.deepEqual(looked.t === "follow" && ids(looked.transcript), ["k3:0"]);
    fake.watch = () => {
      throw Object.assign(Error("ENOSPC: System limit for number of file watchers reached"), { code: "ENOSPC" });
    };
    assert.equal((await follows.start(SID, { id: "k2", kind: "transcript", agentId: "akernel", after: { count: 3, lastId: "k3:0" } })).live, true);
    assert.equal(looking, 2);
    t.say("k4", "three");
    const both = await w.next((m) => m.t === "follow" && m.id === "k2", "the change, where the kernel cannot watch");
    assert.deepEqual(both.t === "follow" && ids(both.transcript), ["k4:0"]);
    follows.stopAll();
    assert.equal(looking, 0, "nothing is left looking");
    assert.ok(kernel.every((k) => k.closed));
  } finally {
    Object.assign(fake, real);
    follows.stopAll();
  }
});

test("a window follows at most eight at once: another ends the oldest", async () => {
  const t = transcript("amany");
  t.prompt("n1", "Go");
  const w = window();
  const follows = new Follows({ cwdOf: async () => cwd, session: () => undefined, push: w.push });
  for (let n = 1; n <= 9; n++) await follows.start(SID, { id: `m${n}`, kind: "transcript", agentId: "amany", after: { count: 1, lastId: "n1" } });
  assert.equal(follows.size, 8);
  assert.deepEqual(
    w.sent.filter((m) => m.t === "follow_end").map((m) => m.id),
    ["m1"],
  );
  follows.stopAll();
  assert.equal(follows.size, 0);
});

// A session that lists one shell and answers for its output what the test sets.
function shellSession() {
  const s = Object.assign(new EventEmitter(), {
    tasks: new TaskBook(() => s.emit("state")),
    output: { text: "", totalBytes: 0, truncated: false } as TaskOutput,
    reads: 0,
    refuse: false,
    async taskOutput(id: string): Promise<TaskOutput> {
      s.reads++;
      if (s.refuse || id !== "b1") throw Error("rejected by the wrapper: request not allowed");
      return { ...s.output };
    },
  });
  s.tasks.on({ type: "system", subtype: "task_started", task_id: "b1", task_type: "local_bash", description: "npm run dev", is_backgrounded: true });
  return s;
}

test("a shell's output is sent only when it changed, read again soon while it changes and once more when the shell ends", async () => {
  const s = shellSession();
  const w = window();
  const follows = new Follows({ cwdOf: async () => cwd, session: () => s as unknown as SessionCore, push: w.push });
  s.output = { text: "line1\n", totalBytes: 6, truncated: false };
  assert.deepEqual(await follows.start(SID, { id: "o1", kind: "output", taskId: "b1" }), { live: true, output: { text: "line1\n", totalBytes: 6, truncated: false } });
  s.output = { text: "line1\nline2\n", totalBytes: 12, truncated: false };
  const changed = await w.next((m) => m.t === "follow", "the new line", 1600);
  assert.deepEqual(changed.t === "follow" && changed.output, { text: "line1\nline2\n", totalBytes: 12, truncated: false });
  await sleep(2600);
  assert.equal(w.sent.length, 1, "an output that did not change is not sent");
  const before = s.reads;
  s.output = { text: "line1\nline2\n[exited with code 0]\n", totalBytes: 34, truncated: false };
  s.tasks.on({ type: "system", subtype: "task_notification", task_id: "b1", status: "completed", summary: "done" });
  const last = await w.next((m) => m.t === "follow", "the end of the output", 500);
  assert.ok(last.t === "follow" && last.output?.text.endsWith("[exited with code 0]\n"), "the read once the shell ended comes at once");
  await sleep(2300);
  assert.equal(s.reads, before + 1, "an ended shell is read once more and then no more");
  assert.equal(follows.size, 1, "the follow stays until the phone lets go");
  follows.stop("o1");
  assert.equal(follows.size, 0);
  assert.equal(s.listenerCount("state") + s.listenerCount("closed"), 0, "nothing is left listening");
  s.tasks.clear();
});

test("an output the session refuses is not followed; a session that closes ends the follow", async () => {
  const s = shellSession();
  const w = window();
  const follows = new Follows({ cwdOf: async () => cwd, session: () => s as unknown as SessionCore, push: w.push });
  s.refuse = true;
  await assert.rejects(follows.start(SID, { id: "o2", kind: "output", taskId: "b1" }), /request not allowed/);
  assert.equal(follows.size, 0);
  s.refuse = false;
  await follows.start(SID, { id: "o3", kind: "output", taskId: "b1" });
  const ended = w.next((m) => m.t === "follow_end", "the end");
  s.emit("closed", "ended");
  assert.deepEqual(await ended, { t: "follow_end", sessionId: SID, id: "o3" });
  assert.equal(follows.size, 0);
  assert.equal(s.listenerCount("state") + s.listenerCount("closed"), 0);
  s.tasks.clear();
});

test("where the phone stands after an answer: its end, its last item and the calls still without a result", () => {
  const tool = (id: string, done: boolean) => ({ kind: "tool" as const, id, name: "Bash", summary: "", input: null, ...(done ? { result: { text: "", isError: false, truncated: false } } : {}) });
  const said = (id: string) => ({ kind: "assistant" as const, id, text: "x" });
  const base = { count: 3, lastId: "c", open: ["t1", "t2"] };
  assert.deepEqual(advance(base, { agentId: "a", items: [said("d"), tool("t3", false)], from: 3, total: 5, changed: [tool("t1", true)] }), { count: 5, lastId: "t3", open: ["t2", "t3"] });
  assert.deepEqual(advance(base, { agentId: "a", items: [], from: 3, total: 3 }), base);
  assert.deepEqual(advance(base, { agentId: "a", items: [tool("t9", false), said("z")], from: 7, total: 9, reset: true }), { count: 9, lastId: "z", open: ["t9"] });
  assert.deepEqual(advance(base, { agentId: "a", items: [], from: 0, total: 0, missing: true }), { count: 0, lastId: "" });
});

// A manager the hub test drives: one session, shown without a process.
class FakeManager extends EventEmitter {
  setViewed(): void {}
  markSeen(): void {}
  isControlled(): boolean {
    return false;
  }
  async snapshot(sessionId: string): Promise<Snapshot> {
    return { items: [], pending: [], hasMore: false, state: { sessionId, cwd, state: "inactive", busy: false } };
  }
  watch(): () => void {
    return () => {};
  }
  async sessionCwd(): Promise<string> {
    return cwd;
  }
  controlledSession(): undefined {
    return undefined;
  }
  async call(): Promise<unknown> {
    return {};
  }
}

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

test("the hub follows only the session a window shows, sends that window what changes, and lets go when it leaves", async () => {
  const t = transcript("ahub");
  t.prompt("h1", "Go");
  const leases = Object.assign(new EventEmitter(), { validate: () => true }) as unknown as Leases;
  const audit = { log: () => {} } as unknown as Audit;
  const hub = new Hub(new FakeManager() as unknown as SessionManager, leases, audit, new Uploads(fs.mkdtempSync(path.join(home, "up-"))));
  const ws = new FakeSocket();
  hub.attach(ws as never, "phone", "token");
  const say = (m: Record<string, unknown>) => ws.emit("message", JSON.stringify(m));
  const until = async (pred: (m: ServerMsg) => boolean, label: string) => {
    for (let n = 0; n < 60; n++) {
      const hit = ws.sent.find(pred);
      if (hit) return hit;
      await sleep(50);
    }
    throw Error(`timed out waiting for ${label}`);
  };
  say({ t: "call", id: 9, sessionId: SID, op: "follow", args: { id: "w0", kind: "transcript", agentId: "ahub", after: { count: 1, lastId: "h1" } } });
  assert.deepEqual(await until((m) => m.t === "call_result" && m.id === 9, "the refusal"), { t: "call_result", id: 9, ok: false, error: "session is not shown" });
  say({ t: "view", sessionId: SID });
  await until((m) => m.t === "snapshot", "the snapshot");
  say({ t: "call", id: 1, sessionId: SID, op: "follow", args: { id: "w1", kind: "transcript", agentId: "ahub", after: { count: 1, lastId: "h1" } } });
  const answer = await until((m) => m.t === "call_result" && m.id === 1, "the answer");
  assert.deepEqual(answer, { t: "call_result", id: 1, ok: true, data: { live: true } });
  t.say("h2", "Going.");
  const change = await until((m) => m.t === "follow", "the change");
  assert.ok(change.t === "follow" && change.id === "w1" && change.sessionId === SID);
  say({ t: "unfollow", id: "w1" });
  await sleep(100);
  t.say("h3", "Still going.");
  await sleep(400);
  assert.equal(ws.sent.filter((m) => m.t === "follow").length, 1, "nothing after the window let go");
  say({ t: "call", id: 2, sessionId: SID, op: "follow", args: { id: "w2", kind: "transcript", agentId: "ahub", after: { count: 3, lastId: "h3:0" } } });
  await until((m) => m.t === "call_result" && m.id === 2, "the second answer");
  say({ t: "view", sessionId: null });
  await sleep(100);
  t.say("h4", "Elsewhere now.");
  await sleep(400);
  assert.equal(ws.sent.filter((m) => m.t === "follow").length, 1, "leaving the session lets go of what it followed");
  hub.close();
});
