import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { tempDir } from "./helpers.ts";

// The manager reads ~/.claude, so it runs against an empty home of its own.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccrc-home-"));
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
const sessionsDir = path.join(home, ".claude", "sessions");
fs.mkdirSync(sessionsDir, { recursive: true });

const { LineSplitter, parseLine } = await import("../src/link/lines.ts");
const { LinkServer } = await import("../src/link/server.ts");
const { SessionManager } = await import("../src/sessions/manager.ts");
const { projectDirName } = await import("../src/sessions/history.ts");
const { HOLD_TEXT } = await import("../src/wrapper/hold.ts");

type Msg = Record<string, unknown>;
const X = "5f0e8a43-6a8b-4a0f-9f6e-2b7d7c1e9a10";
const Y = "7c2d1b90-3e4f-4a5b-8c6d-9e0f1a2b3c4d";

const config = { host: "127.0.0.1", port: 0, allowedDevices: [], allowLocal: true, roots: [], leaseIdleMinutes: 1, sessionIdleMinutes: 1 };

class FakeWrapper {
  sock: net.Socket;
  frames: Msg[] = [];
  private waiters: { pred: (f: Msg) => boolean; resolve: (f: Msg) => void }[] = [];

  constructor(sock: net.Socket) {
    this.sock = sock;
    const split = new LineSplitter((line) => {
      const f = parseLine(line);
      if (!f) return;
      this.frames.push(f);
      for (const w of [...this.waiters]) {
        if (w.pred(f)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(f);
        }
      }
    });
    sock.on("data", (c: Buffer) => split.push(c));
  }

  send(frame: Msg): void {
    this.sock.write(JSON.stringify(frame) + "\n");
  }

  wait(pred: (f: Msg) => boolean, label: string, ms = 5000): Promise<Msg> {
    const hit = this.frames.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`timed out waiting for ${label}`)), ms);
      this.waiters.push({ pred, resolve: (f) => (clearTimeout(timer), resolve(f)) });
    });
  }
}

const servers: InstanceType<typeof LinkServer>[] = [];
after(async () => {
  for (const s of servers) await s.close();
  fs.rmSync(home, { recursive: true, force: true });
});

async function setup(
  cfg: typeof config & { brokerSessions?: "off" | "apiKey" | "subscription" } = config,
  logged?: Msg[],
  timing: { handoffOtherMs?: number; handOverAskMs?: number } = {},
) {
  const audit = logged && ({ log: (event: string, detail: Msg) => logged.push({ event, ...detail }) } as unknown as import("../src/audit.ts").Audit);
  const manager = new SessionManager(cfg, audit, { handoffTurnMs: 200, handoffOtherMs: 400, ...timing });
  manager.holdLang = () => "ko";
  const server = new LinkServer(path.join(tempDir("ccrc-link-"), "link.sock"));
  servers.push(server);
  server.on("link", (link) => manager.attachLink(link));
  await server.listen();
  const connect = async (hello: Msg) => {
    const sock = net.createConnection(server.socketPath);
    await new Promise((r) => sock.once("connect", r));
    const w = new FakeWrapper(sock);
    w.send({ t: "hello", v: 1, wpid: 1, cwd: home, args: [], ...hello });
    return w;
  };
  const events: [string, string][] = [];
  for (const ev of ["attached", "detached"]) manager.on(ev, (id: string) => events.push([ev, id]));
  return { manager, connect, events };
}

// Registers this test process as another Claude Code process that holds `sessionId`, in a terminal unless `more` says
// otherwise (entrypoint "claude-vscode" for VS Code, a status).
function holdElsewhere(sessionId: string, more: Msg = {}): () => void {
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const procStart = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  const file = path.join(sessionsDir, `${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, sessionId, cwd: home, procStart, entrypoint: "cli", ...more }));
  return () => fs.rmSync(file, { force: true });
}

// A transcript whose first message names the session.
function transcript(sessionId: string, text: string): void {
  const dir = path.join(home, ".claude", "projects", projectDirName(home));
  fs.mkdirSync(dir, { recursive: true });
  const row = { sessionId, cwd: home, type: "user", uuid: `${sessionId.slice(0, 8)}-0000-4000-8000-000000000001`, parentUuid: null, timestamp: "2026-10-14T03:00:00Z" };
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), JSON.stringify({ ...row, message: { role: "user", content: text } }) + "\n");
}

const CAPS = ["fast_mode", "thinking", "hand_over", "claim_notice"];

const until = async (fn: () => boolean, label: string) => {
  for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(fn(), label);
};

test("a session another process keeps holding is opened in VS Code as a copy", async () => {
  const { manager, connect } = await setup();
  const release = holdElsewhere(X);
  try {
    const w = await connect({ sessionId: X, claim: X });
    await w.wait((f) => f.t === "claim_wait", "told to wait");
    const ok = await w.wait((f) => f.t === "claim_ok", "hand-over answer");
    assert.equal(ok.fork, true);
    assert.equal(manager.isControlled(X), false, "the held session is not taken over");
    w.send({ m: { type: "system", subtype: "init", session_id: Y }, t: "out" });
    await until(() => manager.isControlled(Y), "the copy is attached");
  } finally {
    release();
  }
});

test("VS Code takes a session over once the other process has let go", async () => {
  const { manager, connect } = await setup();
  const release = holdElsewhere(X);
  const w = await connect({ sessionId: X, claim: X });
  await w.wait((f) => f.t === "claim_wait", "told to wait");
  release();
  const ok = await w.wait((f) => f.t === "claim_ok", "hand-over answer");
  assert.equal(ok.fork, undefined);
  await until(() => manager.isControlled(X), "attached under its own id");
});

test("a VS Code tab the session rests in hands it over to the tab that opens it, and both tabs are told", async () => {
  const M = "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d";
  const logged: Msg[] = [];
  const { manager, connect, events } = await setup(config, logged);
  const reasons: unknown[] = [];
  manager.on("event", (id: string, m: Msg) => id === M && m.t === "state" && reasons.push((m.state as Msg).closedReason));
  const release = holdElsewhere(M, { entrypoint: "claude-vscode", status: "idle" });
  try {
    const old = await connect({ sessionId: M, caps: CAPS });
    old.send({ t: "spawned", cpid: process.pid });
    await until(() => events.some(([e, id]) => e === "attached" && id === M), "the first tab attached");
    const tab = await connect({ sessionId: M, claim: M, caps: CAPS });
    const ask = await old.wait((f) => f.t === "hand_over", "the resting tab asked to hand over");
    assert.equal(ask.notice, HOLD_TEXT.ko.stopped);
    await tab.wait((f) => f.t === "claim_wait", "the new tab waits meanwhile");
    old.send({ t: "handed_over", id: ask.id });
    release();
    old.send({ t: "exit", code: 0, signal: null, hostLeft: false, running: false });
    const ok = await tab.wait((f) => f.t === "claim_ok", "the new tab's answer");
    assert.deepEqual([ok.fork, ok.title, ok.notice], [undefined, undefined, HOLD_TEXT.ko.moved]);
    await until(() => events.filter(([e, id]) => e === "attached" && id === M).length === 2, "the new tab attached under the session's own id");
    assert.ok(reasons.includes("moved"), JSON.stringify(reasons));
    assert.deepEqual(
      logged.filter((e) => e.event === "handoff"),
      [{ event: "handoff", sessionId: M, to: "VS Code", moved: true, from: "VS Code" }],
    );
    tab.sock.destroy();
  } finally {
    release();
  }
});

test("a resting tab that hands over after the broker stopped waiting still lets the new tab open the session, told it moved", async () => {
  const L = "2a3b4c5d-6e7f-4a80-8b1c-2d3e4f5a6b7c";
  const logged: Msg[] = [];
  const { manager, connect, events } = await setup(config, logged, { handOverAskMs: 50, handoffOtherMs: 2000 });
  const reasons: unknown[] = [];
  manager.on("event", (id: string, m: Msg) => id === L && m.t === "state" && reasons.push((m.state as Msg).closedReason));
  const release = holdElsewhere(L, { entrypoint: "claude-vscode", status: "idle" });
  try {
    const old = await connect({ sessionId: L, caps: CAPS });
    old.send({ t: "spawned", cpid: process.pid });
    await until(() => events.some(([e, id]) => e === "attached" && id === L), "the first tab attached");
    const tab = await connect({ sessionId: L, claim: L, caps: CAPS });
    const ask = await old.wait((f) => f.t === "hand_over", "the resting tab asked to hand over");
    await tab.wait((f) => f.t === "claim_wait" && f.ms === 2000 + 2000, "the broker no longer waits for the answer");
    old.send({ t: "handed_over", id: ask.id });
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(manager.send(L, "늦은 메시지"), /session is opening in VS Code/);
    release();
    old.send({ t: "exit", code: 0, signal: null, hostLeft: false, running: false });
    const ok = await tab.wait((f) => f.t === "claim_ok", "the new tab's answer");
    assert.deepEqual([ok.fork, ok.title, ok.notice], [undefined, undefined, HOLD_TEXT.ko.moved]);
    await until(() => reasons.includes("moved"), "the old tab's session ended as moved");
    assert.deepEqual(
      logged.filter((e) => e.event === "handoff"),
      [{ event: "handoff", sessionId: L, to: "VS Code", moved: true, from: "VS Code" }],
    );
    tab.sock.destroy();
  } finally {
    release();
  }
});

test("a tab answering in the session keeps it: the new tab opens a copy named after its title in the list, and is told why", async () => {
  const N = "7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e";
  transcript(N, "인보이스 내보내기 고치기\n자세한 설명");
  const logged: Msg[] = [];
  const { manager, connect } = await setup(config, logged);
  const release = holdElsewhere(N, { entrypoint: "claude-vscode", status: "busy" });
  try {
    const old = await connect({ sessionId: N, caps: CAPS });
    old.send({ t: "spawned", cpid: process.pid });
    await until(() => manager.isControlled(N), "the first tab attached");
    const tab = await connect({ sessionId: N, claim: N, caps: CAPS });
    const ok = await tab.wait((f) => f.t === "claim_ok", "the new tab's answer");
    assert.ok(!old.frames.some((f) => f.t === "hand_over"), "a busy tab is not asked");
    assert.deepEqual(
      [ok.fork, ok.title, ok.notice],
      [true, "(복사본) 인보이스 내보내기 고치기 자세한 설명", HOLD_TEXT.ko.copy(HOLD_TEXT.ko.holder.vscode, true)],
    );
    assert.deepEqual(
      logged.filter((e) => e.event === "handoff"),
      [{ event: "handoff", sessionId: N, to: "VS Code", forked: true, heldBy: "VS Code", busy: true }],
    );
    old.sock.destroy();
    tab.sock.destroy();
  } finally {
    release();
  }
});

test("a tab is not asked without a wrapper that can hand over, and a refusal or a process that stays leaves a copy", async () => {
  const O = "8c9d0e1f-2a3b-4c4d-8e5f-6a7b8c9d0e1f";
  const { manager, connect } = await setup();
  const opened = async (oldCaps: string[], answer?: (old: InstanceType<typeof FakeWrapper>, id: unknown) => void) => {
    const old = await connect({ sessionId: O, caps: oldCaps });
    old.send({ t: "spawned", cpid: process.pid });
    await until(() => manager.isControlled(O), "the first tab attached");
    const tab = await connect({ sessionId: O, claim: O, caps: CAPS });
    if (answer) answer(old, (await old.wait((f) => f.t === "hand_over", "asked")).id);
    const ok = await tab.wait((f) => f.t === "claim_ok", "the new tab's answer");
    const asked = old.frames.some((f) => f.t === "hand_over");
    old.sock.destroy();
    tab.sock.destroy();
    await until(() => !manager.isControlled(O), "both tabs gone");
    return { ok, asked };
  };
  const release = holdElsewhere(O, { entrypoint: "claude-vscode", status: "idle" });
  try {
    const older = await opened(["fast_mode", "thinking"]);
    assert.equal(older.asked, false, "an older wrapper is not asked");
    assert.equal(older.ok.fork, true);
    assert.equal(older.ok.notice, HOLD_TEXT.ko.copy(HOLD_TEXT.ko.holder.vscode, false));
    const refused = await opened(CAPS, (old, id) => old.send({ t: "rejected", id, reason: "turn running" }));
    assert.equal(refused.ok.fork, true);
    const stays = await opened(CAPS, (old, id) => old.send({ t: "handed_over", id }));
    assert.equal(stays.ok.fork, true, "a copy when the process holds on all the same");
  } finally {
    release();
  }
});

test("a copy beside a terminal is told so, a wrapper that cannot show it gets neither name nor notice, and the copy's first message is announced once", async () => {
  const P = "9d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a";
  const Q = "0e1f2a3b-4c5d-4e6f-8a7b-8c9d0e1f2a3b";
  transcript(P, "테스트 고치기");
  const { manager, connect } = await setup();
  const started: [string, string][] = [];
  manager.on("copy_started", (id: string, holder: string) => started.push([id, holder]));
  const release = holdElsewhere(P);
  try {
    const old = await connect({ sessionId: P, claim: P, caps: ["fast_mode", "thinking"] });
    const plain = await old.wait((f) => f.t === "claim_ok", "an older wrapper's answer");
    assert.deepEqual([plain.fork, plain.title, plain.notice], [true, undefined, undefined]);
    old.sock.destroy();
    const tab = await connect({ sessionId: P, claim: P, caps: CAPS });
    const ok = await tab.wait((f) => f.t === "claim_ok", "the new tab's answer");
    assert.deepEqual([ok.fork, ok.title, ok.notice], [true, "(복사본) 테스트 고치기", HOLD_TEXT.ko.copy(HOLD_TEXT.ko.holder.terminal, false)]);
    tab.send({ m: { type: "system", subtype: "session_title_changed", title: ok.title, session_id: Q }, t: "out" });
    await until(() => manager.isControlled(Q), "the copy attached by its new name");
    assert.deepEqual(started, [], "opening a copy alone is not announced");
    const message = (uuid: string) => tab.send({ m: { type: "user", uuid, message: { role: "user", content: [{ type: "text", text: "go on" }] } }, t: "in" });
    message("u-1");
    await until(() => started.length === 1, "the first message announced");
    message("u-2");
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(started, [[Q, "Terminal"]]);
    tab.sock.destroy();
  } finally {
    release();
  }
});

test("a tab the broker let start on a session holds it before its Claude Code registers: a second launch gets a copy", async () => {
  const R = "1f2a3b4c-5d6e-4f70-8a1b-2c3d4e5f6a7b";
  const logged: Msg[] = [];
  const { manager, connect } = await setup(config, logged);
  const first = await connect({ sessionId: R, claim: R, caps: CAPS });
  const second = await connect({ sessionId: R, claim: R, caps: CAPS });
  const answers = await Promise.all([first, second].map((w) => w.wait((f) => f.t === "claim_ok", "an answer")));
  const copies = answers.filter((o) => o.fork === true);
  assert.equal(copies.length, 1, "only one of them starts on the session");
  assert.equal(copies[0].notice, HOLD_TEXT.ko.copy(HOLD_TEXT.ko.holder.vscode, false));
  assert.deepEqual(
    logged.filter((e) => e.event === "handoff"),
    [{ event: "handoff", sessionId: R, to: "VS Code", forked: true, heldBy: "VS Code" }],
  );
  assert.equal(manager.isControlled(R), true);
  first.sock.destroy();
  second.sock.destroy();
});

test("a newer wrapper for the same session replaces the older one quietly", async () => {
  const { manager, connect, events } = await setup();
  const first = await connect({ sessionId: X });
  await until(() => events.some(([e, id]) => e === "attached" && id === X), "first attached");
  const second = await connect({ sessionId: X });
  await until(() => events.filter(([e, id]) => e === "attached" && id === X).length === 2, "second attached");
  first.sock.destroy();
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!events.some(([e]) => e === "detached"), "closing the old one does not detach the session");
  assert.equal(manager.isControlled(X), true);
  second.sock.destroy();
  await until(() => events.some(([e, id]) => e === "detached" && id === X), "closing the current one detaches it");
});

test('a VS Code session is still driven from the phone while brokerSessions is "off"', async () => {
  const { manager, connect, events } = await setup({ ...config, brokerSessions: "off" });
  const w = await connect({ sessionId: X });
  await until(() => events.some(([e, id]) => e === "attached" && id === X), "attached");
  assert.equal(await manager.activate(X).then((s) => s.id), X);
  await manager.send(X, "from the phone");
  await w.wait((f) => f.t === "to_cli" && JSON.stringify(f.m).includes("from the phone"), "the message reaches Claude Code through the wrapper");
  w.sock.destroy();
  await until(() => events.some(([e, id]) => e === "detached" && id === X), "detached");
});

test("what a wrapper reports before naming its session is replayed in order", async () => {
  const { manager, connect } = await setup();
  const w = await connect({});
  w.send({ m: { type: "control_request", request_id: "p1", request: { subtype: "can_use_tool", tool_name: "Write", input: {}, tool_use_id: "t1" } }, t: "out" });
  w.send({ t: "settled", id: "p1", by: "host" });
  w.send({ m: { type: "system", subtype: "init", session_id: Y }, t: "out" });
  await until(() => manager.isControlled(Y), "attached");
  await new Promise((r) => setTimeout(r, 100));
  const snap = await manager.snapshot(Y);
  assert.deepEqual(snap.pending, []);
});

test("a reply a wrapper reports before naming its session keeps the time it arrived", async () => {
  const { manager, connect } = await setup();
  const w = await connect({});
  w.send({ m: { type: "assistant", uuid: "early-1", parent_tool_use_id: null, message: { content: [{ type: "text", text: "early" }] } }, t: "out" });
  await new Promise((r) => setTimeout(r, 100));
  const named = Date.now();
  w.send({ m: { type: "system", subtype: "init", session_id: Y }, t: "out" });
  await until(() => manager.isControlled(Y), "attached");
  await new Promise((r) => setTimeout(r, 100));
  const reply = (await manager.snapshot(Y)).items.find((i) => i.id === "early-1:0");
  assert.ok(reply?.ts && Date.parse(reply.ts) < named, reply?.ts);
});

test("a phone message left queued when VS Code closes stays in the stopped session's conversation", async () => {
  const Z = "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d";
  const dir = path.join(home, ".claude", "projects", projectDirName(home));
  fs.mkdirSync(dir, { recursive: true });
  const row = { sessionId: Z, cwd: home, type: "user", uuid: "2a3b4c5d-0000-4000-8000-000000000001", parentUuid: null, timestamp: "2026-10-14T03:00:00Z" };
  fs.writeFileSync(path.join(dir, `${Z}.jsonl`), JSON.stringify({ ...row, message: { role: "user", content: "hello" } }) + "\n");
  const { manager, connect, events } = await setup();
  const w = await connect({ sessionId: Z });
  await until(() => manager.isControlled(Z), "attached");
  await manager.send(Z, "left behind");
  w.sock.destroy();
  await until(() => events.some(([e, id]) => e === "detached" && id === Z), "detached");
  const snap = await manager.snapshot(Z);
  assert.deepEqual(
    snap.items.map((i) => [i.kind, "text" in i ? i.text : undefined]),
    [["user", "hello"], ["note", "left behind"]],
  );
});

test("a VS Code session whose Claude Code crashes mid-turn ends as crashed with that turn's end, and the reason is kept a day", async (t) => {
  const { manager, connect } = await setup();
  const ends: [string, string, boolean][] = [];
  manager.on("turn_end", (id: string, e: { outcome: string; attached: boolean }) => ends.push([id, e.outcome, e.attached]));
  const reasons: (string | undefined)[] = [];
  manager.on("event", (id: string, m: Msg) => id === X && m.t === "state" && reasons.push((m.state as Msg).closedReason as string | undefined));
  const seen: string[] = [];
  manager.on("seen", (id: string) => seen.push(id));
  const w = await connect({ sessionId: X });
  await until(() => manager.isControlled(X), "attached");
  w.send({ m: { type: "system", subtype: "init", session_id: X }, t: "out" });
  w.send({ m: { type: "control_request", request_id: "p1", request: { subtype: "can_use_tool", tool_name: "Write", input: {}, tool_use_id: "t1" } }, t: "out" });
  await until(() => manager.waitingSessions().includes(X), "a request waits");
  manager.markSeen(X);
  assert.deepEqual(seen, [X]);
  w.send({ t: "exit", code: null, signal: "SIGKILL", hostLeft: false, running: true });
  await until(() => !manager.isControlled(X), "ended");
  assert.deepEqual(ends, [[X, "crashed", true]]);
  assert.equal(reasons.at(-1), "crashed");
  assert.deepEqual(manager.waitingSessions(), []);
  const ended = (manager as unknown as { ended: Map<string, unknown> }).ended;
  const sweep = () => (manager as unknown as { sweep(): Promise<void> }).sweep();
  const base = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: base + 11 * 60_000 });
  await sweep();
  assert.ok(ended.has(X), "kept past the usual ten minutes");
  t.mock.timers.setTime(base + 24 * 3600_000 + 60_000);
  await sweep();
  assert.ok(!ended.has(X), "gone after a day");
  t.mock.timers.reset();

  const old = await connect({ sessionId: Y });
  await until(() => manager.isControlled(Y), "attached");
  old.send({ m: { type: "system", subtype: "init", session_id: Y }, t: "out" });
  old.send({ t: "exit", code: 1, signal: null });
  await until(() => !manager.isControlled(Y), "ended");
  assert.deepEqual(ends, [[X, "crashed", true]], "a wrapper that does not say how Claude Code ended reports no crash");
});

test("a running session's git changes come from Claude Code, and from ccrc when it cannot answer or no process runs", async () => {
  const { execFileSync } = await import("node:child_process");
  const G = "3b4c5d6e-7f80-4a9b-8c1d-2e3f4a5b6c7d";
  const repo = fs.realpathSync(tempDir("ccrc-repo-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-C", repo, ...args]);
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
  const dir = path.join(home, ".claude", "projects", projectDirName(repo));
  fs.mkdirSync(dir, { recursive: true });
  const row = { sessionId: G, cwd: repo, type: "user", uuid: "3b4c5d6e-0000-4000-8000-000000000001", parentUuid: null, timestamp: new Date(Date.now() - 60_000).toISOString() };
  fs.writeFileSync(path.join(dir, `${G}.jsonl`), JSON.stringify({ ...row, message: { role: "user", content: "change a.txt" } }) + "\n");
  fs.writeFileSync(path.join(repo, "made-by-the-session.txt"), "new\n");

  const { manager, connect } = await setup();
  const stopped = (await manager.call(G, "git_changes", {})) as { via: string; files: { path: string; untracked?: boolean; hunks?: unknown[] }[] };
  assert.equal(stopped.via, "broker");
  assert.deepEqual(
    stopped.files.map((f) => [f.path, Boolean(f.untracked), Boolean(f.hunks?.length)]),
    [
      ["a.txt", false, true],
      ["made-by-the-session.txt", true, false],
    ],
  );

  const w = await connect({ sessionId: G, cwd: repo, caps: ["fast_mode", "thinking", "workspace_diff", "side_question"] });
  await until(() => manager.isControlled(G), "attached");
  const answer = (diff: unknown, error?: string) =>
    void w.wait((f) => f.t === "to_cli" && ((f.m as Msg).request as Msg | undefined)?.subtype === "get_workspace_diff" && !answered.has((f.m as Msg).request_id), "diff asked").then((f) => {
      const id = (f.m as Msg).request_id;
      answered.add(id);
      w.send({ m: { type: "control_response", response: error ? { subtype: "error", request_id: id, error } : { subtype: "success", request_id: id, response: { diff } } }, t: "reply" });
    });
  const answered = new Set<unknown>();
  answer({ stats: { filesCount: 1, linesAdded: 1, linesRemoved: 1 }, perFileStats: [{ path: "a.txt", added: 1, removed: 1, isBinary: false, isUntracked: false, status: "modified" }], hunks: [], skippedLarge: [], restricted: [], source: { kind: "working-tree" } });
  const live = (await manager.call(G, "git_changes", {})) as { via: string; root: string };
  assert.equal(live.via, "claude");
  assert.equal(live.root, repo);
  answer(undefined, "Unsupported control request subtype: get_workspace_diff");
  const fallback = (await manager.call(G, "git_changes", {})) as { via: string };
  assert.equal(fallback.via, "broker");
  w.sock.destroy();
});

test("a side question asked with an id is waited for again while it runs, and how it ended is kept for a while", async () => {
  const Q = "4c5d6e7f-8091-4a2b-9c3d-4e5f6a7b8c9d";
  const { manager, connect } = await setup();
  const w = await connect({ sessionId: Q, cwd: home, caps: ["fast_mode", "thinking", "workspace_diff", "side_question"] });
  await until(() => manager.isControlled(Q), "attached");
  const seen = new Set<unknown>();
  const sent = async (question: string) => {
    const f = await w.wait((f) => f.t === "to_cli" && ((f.m as Msg).request as Msg | undefined)?.question === question && !seen.has((f.m as Msg).request_id), `${question} sent`);
    seen.add((f.m as Msg).request_id);
    return (f.m as Msg).request_id as string;
  };
  const reply = (id: string, response: Msg) => w.send({ m: { type: "control_response", response: { request_id: id, ...response } }, t: "reply" });

  const heard: unknown[] = [];
  const asked = manager.call(Q, "side_question", { question: "q1", history: [], ask: "a1" });
  const id1 = await sent("q1");
  const again = manager.call(Q, "side_question_wait", { ask: "a1" }, (p) => heard.push(p));
  w.send({ m: { type: "system", subtype: "control_request_progress", request_id: id1, status: "started" }, t: "out" });
  await until(() => heard.length === 1, "progress heard by the one waiting again");
  reply(id1, { subtype: "success", response: { response: "A1" } });
  assert.deepEqual(await asked, { answer: "A1" });
  assert.deepEqual(await again, { answer: "A1" });
  assert.deepEqual(await manager.call(Q, "side_question_wait", { ask: "a1" }), { answer: "A1" }, "an answer is kept after it came");
  await assert.rejects(manager.call(Q, "side_question_wait", { ask: "nobody" }), /side question gone/);

  const failed = assert.rejects(manager.call(Q, "side_question", { question: "q2", history: [], ask: "a2" }), /API Error: 500/);
  reply(await sent("q2"), { subtype: "error", error: "API Error: 500" });
  await failed;
  await assert.rejects(manager.call(Q, "side_question_wait", { ask: "a2" }), /API Error: 500/, "so is the error a question ended with");
  await assert.rejects(manager.call(Q, "side_question_wait", { ask: "a1" }), /side question gone/, "only the last question is kept");

  const slow = assert.rejects(manager.call(Q, "side_question", { question: "q3", history: [], ask: "a3" }), /side question cancelled/);
  const id3 = await sent("q3");
  await assert.rejects(manager.call(Q, "side_question", { question: "q4", history: [], ask: "a4" }), /a side question is under way/);
  await assert.rejects(manager.call(Q, "side_question_wait", { ask: "a4" }), /side question gone/, "a question refused is not kept");
  await assert.rejects(manager.call(Q, "side_question_wait", { ask: "a2" }), /API Error: 500/, "nor does it put out the one kept");
  await manager.call(Q, "side_question_cancel", { ask: "a1" });
  assert.ok(!w.frames.some((f) => (f.m as Msg | undefined)?.type === "control_cancel_request"), "a cancel naming another question leaves this one");
  await manager.call(Q, "side_question_cancel", { ask: "a3" });
  await w.wait((f) => (f.m as Msg | undefined)?.type === "control_cancel_request" && (f.m as Msg).request_id === id3, "cancel sent");
  await slow;
  await assert.rejects(manager.call(Q, "side_question_wait", { ask: "a3" }), /side question cancelled/);
  w.sock.destroy();
});
