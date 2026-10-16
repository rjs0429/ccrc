import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The manager reads ~/.claude and starts the worktree fake, which records where it started and where it works.
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccrc-home-")));
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
process.env.CCRC_STATE_DIR = path.join(home, "state");
const requests = path.join(home, "requests.jsonl");
process.env.FAKE_REQUESTS = requests;
fs.mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });

const { SessionManager } = await import("../src/sessions/manager.ts");
const { Hub } = await import("../src/hub.ts");
const { Uploads } = await import("../src/uploads.ts");
type Audit = import("../src/audit.ts").Audit;
type Leases = import("../src/lease.ts").Leases;
type ServerMsg = import("../src/protocol.ts").ServerMsg;

const FAKE = new URL("./fixtures/fake-claude-worktree.mjs", import.meta.url).pathname;
const ws = path.join(home, "ws");
const config = { host: "127.0.0.1", port: 0, allowedDevices: [], allowLocal: true, claudePath: FAKE, roots: [ws], leaseIdleMinutes: 1, sessionIdleMinutes: 1 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

after(() => fs.rmSync(home, { recursive: true, force: true }));

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

let repos = 0;
function repo(): string {
  const dir = path.join(ws, `app${++repos}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".claude/worktrees/\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  return dir;
}

type Recorded = { args: string[]; launched: string; cwd: string };
const recorded = (): Recorded[] => (fs.existsSync(requests) ? fs.readFileSync(requests, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Recorded) : []);

async function until<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, what: string, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw Error(`timed out: ${what}`);
    await sleep(25);
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

function setup(t: { after: (fn: () => unknown) => void }, timing = {}) {
  fs.rmSync(requests, { force: true });
  const logged: [string, Record<string, unknown>][] = [];
  const audit = { log: (event: string, detail: Record<string, unknown>) => logged.push([event, detail]) } as unknown as Audit;
  const manager = new SessionManager(config, audit, timing);
  manager.windowProbe = async () => undefined;
  t.after(() => manager.closeAll());
  return { manager, logged, audit };
}

const flagged = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

test("a new session starts in the worktree Claude Code makes, from HEAD when asked, and is listed there", async (t) => {
  const { manager } = setup(t);
  const root = repo();
  const s = await manager.create(root, { worktree: { name: "feature/one", base: "head" } });
  const wt = path.join(root, ".claude", "worktrees", "feature+one");
  assert.equal(s.cwd, wt, "the session works in the worktree once Claude Code has started");
  const start = recorded()[0];
  assert.equal(start.launched, root);
  assert.equal(flagged(start.args, "--worktree"), "feature/one");
  assert.deepEqual(JSON.parse(flagged(start.args, "--settings")!), { worktree: { baseRef: "head" } });
  assert.match(git(root, "worktree", "list", "--porcelain"), /branch refs\/heads\/worktree-feature\+one\nlocked claude session feature\/one \(pid \d+ start \d+\)/);
  s.send("hello");
  await until(() => !s.busy && s.builder.items.some((i) => i.kind === "assistant"), "reply");
  const listed = await until(async () => (await manager.list()).find((x) => x.id === s.id && x.title), "listed with a transcript");
  assert.equal(listed.cwd, wt);
});

test("a fresh base is asked for as such, and Claude Code's init line moves the session where a hook put it", async (t) => {
  const { manager } = setup(t);
  const plain = path.join(ws, "plain-hooked");
  fs.mkdirSync(path.join(plain, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(plain, ".claude", "settings.json"), JSON.stringify({ hooks: { WorktreeCreate: [{ hooks: [{ type: "command", command: "mk" }] }] } }));
  const made = path.join(home, "hook-made", "wt");
  process.env.FAKE_WT_HOOK_DIR = made;
  t.after(() => delete process.env.FAKE_WT_HOOK_DIR);
  const s = await manager.create(plain, { worktree: { name: "hooked", base: "fresh" } });
  assert.deepEqual(JSON.parse(flagged(recorded()[0].args, "--settings")!), { worktree: { baseRef: "fresh" } });
  assert.equal(s.cwd, plain, "where a hook puts it is known only from Claude Code");
  let changed = 0;
  manager.on("changed", () => changed++);
  s.send("go");
  await until(() => s.cwd === made, "init line's folder");
  assert.ok(changed > 0, "the list hears of the move");
});

test("a folder outside git without a hook, a bad name, a left branch or an empty repository start nothing", async (t) => {
  const { manager } = setup(t);
  const plain = path.join(ws, "plain");
  fs.mkdirSync(plain, { recursive: true });
  await assert.rejects(manager.create(plain, { worktree: { name: "x", base: "fresh" } }), /^Error: not a git repository$/);
  const root = repo();
  await assert.rejects(manager.create(root, { worktree: { name: "has space", base: "fresh" } }), /invalid worktree name: chars/);
  git(root, "branch", "worktree-left");
  await assert.rejects(manager.create(root, { worktree: { name: "left", base: "fresh" } }), /branch worktree-left already exists/);
  const empty = path.join(ws, "empty");
  fs.mkdirSync(empty);
  git(empty, "init", "-q", "-b", "main");
  await assert.rejects(manager.create(empty, { worktree: { name: "x", base: "head" } }), /repository has no commits/);
  assert.deepEqual(recorded(), [], "no Claude Code was started");
  assert.equal((await manager.list()).filter((x) => x.state === "owned").length, 0);
});

test("a start that fails says Claude Code's last stderr line and leaves no session or file history", async (t) => {
  const { manager } = setup(t);
  const root = repo();
  process.env.FAKE_WT_FAIL = "Error creating worktree: fatal: could not lock config file";
  t.after(() => delete process.env.FAKE_WT_FAIL);
  const listed = new Set<string>();
  manager.on("changed", () => void manager.list().then((l) => l.forEach((x) => listed.add(x.id))));
  await assert.rejects(manager.create(root, { worktree: { name: "x", base: "fresh" } }), /^Error: Claude Code could not start: Error creating worktree: fatal: could not lock config file$/);
  await sleep(100);
  assert.equal((await manager.list()).some((x) => x.state === "owned"), false);
  for (const id of listed) assert.equal(manager.isControlled(id), false);
  assert.equal(fs.existsSync(path.join(home, ".claude", "file-history")) && fs.readdirSync(path.join(home, ".claude", "file-history")).length > 0, false);
});

test("a start that takes too long is closed and says so", async (t) => {
  const { manager } = setup(t, { worktreeStartMs: 1000 });
  const root = repo();
  process.env.FAKE_WT_SLOW_MS = "4000";
  t.after(() => delete process.env.FAKE_WT_SLOW_MS);
  const t0 = Date.now();
  await assert.rejects(manager.create(root, { worktree: { name: "slow", base: "fresh" } }), /^Error: Claude Code did not start in 1s$/);
  assert.ok(Date.now() - t0 < 3500, "it does not wait for the process");
  assert.equal((await manager.list()).some((x) => x.state === "owned"), false);
});

test("status tells changes and where the session runs; removal waits until nothing runs there", async (t) => {
  const { manager } = setup(t);
  const root = repo();
  const s = await manager.create(root, { worktree: { name: "busy", base: "head" } });
  s.send("hi");
  await until(() => !s.busy && s.builder.items.some((i) => i.kind === "assistant"), "reply");
  fs.writeFileSync(path.join(s.cwd, "b.txt"), "b\n");
  const st = await manager.worktreeStatus(s.id);
  assert.deepEqual([st.name, st.changed, st.commits, st.running, st.lock?.claude, st.lock?.alive, st.ignored], ["busy", 1, 0, "ccrc", true, true, true]);
  await assert.rejects(manager.worktreeRemove(s.id, true), /worktree is in use in ccrc/);
  await manager.release(s.id);
  const after = await manager.worktreeStatus(s.id);
  assert.deepEqual([after.running, after.lock?.alive], [undefined, false], "Claude Code's lock outlives its process");
  await assert.rejects(manager.worktreeRemove(s.id, false), /worktree has work to keep/);
  const done = await manager.worktreeRemove(s.id, true);
  assert.deepEqual(done, { path: path.join(root, ".claude", "worktrees", "busy"), branch: "worktree-busy", branchKept: false, commits: 0, discarded: 1 });
  await assert.rejects(manager.worktreeStatus("00000000-0000-4000-8000-000000000000"), /unknown session/);
});

test("a session whose worktree is gone is not a missing folder, and resumes where it was made from", async (t) => {
  const { manager } = setup(t);
  const root = repo();
  const s = await manager.create(root, { worktree: { name: "gone", base: "head" } });
  s.send("first");
  await until(() => !s.busy && s.builder.items.some((i) => i.kind === "assistant"), "reply");
  await manager.release(s.id);
  await manager.worktreeRemove(s.id, false);
  const listed = await until(async () => (await manager.list()).find((x) => x.id === s.id), "listed");
  assert.equal(listed.folderMissing, undefined);
  const snap = await manager.snapshot(s.id);
  assert.equal(snap.state.resumeIn, root);
  assert.equal(snap.state.folderMissing, undefined);
  fs.rmSync(requests, { force: true });
  const again = await manager.activate(s.id);
  assert.equal(again.cwd, root);
  await until(() => recorded()[0], "resumed");
  assert.deepEqual([recorded()[0].launched, recorded()[0].cwd], [root, root]);
  assert.ok(again.builder.items.some((i) => i.kind === "user" && i.text === "first"), "its conversation comes along");
  const st = await manager.worktreeStatus(s.id);
  assert.deepEqual([st.exists, st.registered, st.branch, st.running], [false, false, undefined, "ccrc"]);
});

test("a session in a worktree resumes in it, and the phone's new_session carries the worktree checked and recorded", async (t) => {
  const { manager, logged, audit } = setup(t);
  const root = repo();
  const leases = Object.assign(new EventEmitter(), { validate: () => true }) as unknown as Leases;
  const hub = new Hub(manager, leases, audit, new Uploads(fs.mkdtempSync(path.join(home, "up-"))));
  const sock = new FakeSocket();
  hub.attach(sock as never, "phone", "token");
  const say = (m: Record<string, unknown>) => sock.emit("message", JSON.stringify(m));
  t.after(() => {
    say({ t: "view", sessionId: null });
    hub.close();
  });
  for (const worktree of [{ name: 5, base: "fresh" }, { name: "x", base: "main" }, { name: "x".repeat(65), base: "head" }, "x"]) say({ t: "new_session", cwd: root, text: "x", worktree, draftId: "d-bad" });
  await until(() => sock.sent.filter((m) => m.t === "error").length === 4, "four refusals");
  assert.ok(sock.sent.filter((m) => m.t === "error").every((m) => m.t === "error" && m.message === "invalid request" && m.draftId === "d-bad"));
  say({ t: "new_session", cwd: root, text: "in a worktree", worktree: { name: "phone", base: "fresh" }, draftId: "d-wt" });
  const started = await until(() => sock.sent.find((m): m is Extract<ServerMsg, { t: "session_started" }> => m.t === "session_started"), "started");
  assert.equal(started.draftId, "d-wt");
  const wt = path.join(root, ".claude", "worktrees", "phone");
  assert.deepEqual(logged.find(([e]) => e === "new_session")?.[1], { device: "phone", sessionId: started.sessionId, cwd: wt, worktree: { name: "phone", base: "fresh" } });
  await until(async () => (await manager.list()).find((x) => x.id === started.sessionId && x.title && !x.busy), "transcript");
  await manager.release(started.sessionId);
  fs.rmSync(requests, { force: true });
  const again = await manager.activate(started.sessionId);
  await until(() => recorded()[0], "resumed");
  assert.equal(recorded()[0].cwd, wt, "Claude Code goes back into its worktree");
  assert.equal(again.cwd, wt);
  await manager.release(started.sessionId);
  say({ t: "call", id: 1, sessionId: started.sessionId, op: "worktree_remove", args: { discard: false } });
  const result = await until(() => sock.sent.find((m): m is Extract<ServerMsg, { t: "call_result" }> => m.t === "call_result" && m.id === 1), "removed");
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(logged.find(([e]) => e === "worktree_remove")?.[1], { device: "phone", sessionId: started.sessionId, path: wt, discarded: 0 });
  say({ t: "call", id: 2, cwd: root, op: "git" });
  const info = await until(() => sock.sent.find((m): m is Extract<ServerMsg, { t: "call_result" }> => m.t === "call_result" && m.id === 2), "git info");
  assert.equal((info.data as { root: string }).root, root);
  say({ t: "call", id: 3, sessionId: started.sessionId, op: "git" });
  const refused = await until(() => sock.sent.find((m): m is Extract<ServerMsg, { t: "call_result" }> => m.t === "call_result" && m.id === 3), "refused");
  assert.deepEqual([refused.ok, refused.error], [false, "unknown request"], "git is a folder call only");
});
