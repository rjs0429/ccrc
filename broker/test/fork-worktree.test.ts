import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The manager reads ~/.claude and starts the fork fake, which makes worktrees with git and records where it worked.
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccrc-home-")));
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
process.env.CCRC_STATE_DIR = path.join(home, "state");
const requests = path.join(home, "requests.jsonl");
process.env.FAKE_REQUESTS = requests;
fs.mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });

const { SessionManager } = await import("../src/sessions/manager.ts");
const { projectDirName } = await import("../src/sessions/history.ts");
const { Hub } = await import("../src/hub.ts");
const { Uploads } = await import("../src/uploads.ts");
const { reattachNote } = await import("../../web/src/components/messageActions.ts");
type Audit = import("../src/audit.ts").Audit;
type Leases = import("../src/lease.ts").Leases;
type ServerMsg = import("../src/protocol.ts").ServerMsg;
type GitFolderInfo = import("../src/protocol.ts").GitFolderInfo;
type ForkResult = import("../src/protocol.ts").ForkResult;
type ReattachResult = import("../src/protocol.ts").ReattachResult;

const FAKE = new URL("./fixtures/fake-claude-fork.mjs", import.meta.url).pathname;
const ws = path.join(home, "ws");
fs.mkdirSync(ws, { recursive: true });
const config = { host: "127.0.0.1", port: 0, allowedDevices: [], allowLocal: true, claudePath: FAKE, roots: [ws], leaseIdleMinutes: 1, sessionIdleMinutes: 1 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

after(() => fs.rmSync(home, { recursive: true, force: true }));

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

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

type Recorded = { sid: string; args?: string[]; launched?: string; cwd?: string; user?: string };
const recorded = (): Recorded[] =>
  fs.existsSync(requests)
    ? fs
        .readFileSync(requests, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Recorded)
    : [];
const flagged = (args: string[] | undefined, name: string) => {
  const i = args?.findIndex((a) => a === name || a.startsWith(`${name}=`)) ?? -1;
  return i < 0 ? undefined : args![i].startsWith(`${name}=`) ? args![i].slice(name.length + 1) : args![i + 1];
};

async function until<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, what: string, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw Error(`timed out: ${what}`);
    await sleep(20);
  }
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 7)]);
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
type Block = Record<string, unknown>;

// A stopped session in `cwd` with two exchanges, the first message carrying `blocks` besides its text, named "원래 세션".
function transcript(sid: string, cwd: string, blocks: Block[] = [], extra: Record<string, unknown>[] = []) {
  const ids = { u1: randomUUID(), a1: randomUUID(), u2: randomUUID(), a2: randomUUID() };
  const base = { sessionId: sid, cwd, isSidechain: false, userType: "external", version: "2.1.300", gitBranch: "" };
  const reply = (id: string, parent: string, text: string, n: number) => ({
    ...base,
    parentUuid: parent,
    uuid: id,
    timestamp: `2026-10-18T01:00:0${n}Z`,
    type: "assistant",
    message: { id: `msg_${n}`, role: "assistant", model: "fake", type: "message", content: [{ type: "text", text }], stop_reason: "end_turn" },
  });
  const rows = [
    ...extra,
    { ...base, parentUuid: null, uuid: ids.u1, timestamp: "2026-10-18T01:00:00Z", type: "user", message: { role: "user", content: [...blocks, { type: "text", text: "첫째" }] } },
    reply(ids.a1, ids.u1, "첫째에 답", 1),
    { ...base, parentUuid: ids.a1, uuid: ids.u2, timestamp: "2026-10-18T01:00:02Z", type: "user", message: { role: "user", content: "둘째" } },
    reply(ids.a2, ids.u2, "둘째에 답", 3),
    { type: "custom-title", customTitle: "원래 세션", sessionId: sid },
  ];
  const project = path.join(home, ".claude", "projects", projectDirName(cwd));
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, `${sid}.jsonl`), rows.map((r) => JSON.stringify(r) + "\n").join(""));
  return ids;
}

function setup(t: { after: (fn: () => unknown) => void }) {
  fs.rmSync(requests, { force: true });
  const logged: [string, Record<string, unknown>][] = [];
  const audit = { log: (event: string, detail: Record<string, unknown>) => logged.push([event, detail]) } as unknown as Audit;
  const manager = new SessionManager(config, audit, { worktreeStartMs: 15_000 });
  manager.windowProbe = async () => undefined;
  const leases = Object.assign(new EventEmitter(), { validate: () => true }) as unknown as Leases;
  const uploads = new Uploads(fs.mkdtempSync(path.join(home, "up-")));
  const hub = new Hub(manager, leases, audit, uploads);
  const sock = new FakeSocket();
  hub.attach(sock as never, "phone", "token");
  const say = (m: Record<string, unknown>) => sock.emit("message", JSON.stringify(m));
  let seq = 0;
  const call = async (sessionId: string, op: string, args: Record<string, unknown>, ms = 20_000) => {
    const id = ++seq;
    say({ t: "call", id, sessionId, op, args });
    return until(() => sock.sent.find((m): m is Extract<ServerMsg, { t: "call_result" }> => m.t === "call_result" && m.id === id), `${op} answered`, ms);
  };
  t.after(async () => {
    hub.close();
    await manager.closeAll();
  });
  return { manager, call, logged, uploads };
}

test("a fork asked for a worktree runs in one Claude Code makes from the HEAD of the original's folder", async (t) => {
  const { manager, call, logged } = setup(t);
  const root = repo();
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "settings.json"), "{}\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "project settings");
  fs.writeFileSync(path.join(root, "a.txt"), "changed\n");
  fs.writeFileSync(path.join(root, "new.txt"), "new\n");
  fs.writeFileSync(path.join(root, ".claude", "settings.json"), '{"model":"opus"}\n');
  fs.writeFileSync(path.join(root, ".claude", "settings.local.json"), "{}\n");
  const src = randomUUID();
  transcript(src, root);

  const g = await call(src, "fork_git", {});
  assert.equal(g.ok, true, g.error);
  const info = g.data as GitFolderInfo;
  assert.equal(info.repo, true);
  assert.equal(info.root, root);
  assert.equal(info.branch, "main");
  assert.equal(info.changed, 3, "the changed, the new and the committed project settings count, Claude Code's local settings do not");
  assert.equal(info.subfolder, undefined);

  const id = randomUUID();
  const r = await call(src, "fork", { id, worktree: { name: "try/one" } });
  assert.equal(r.ok, true, r.error);
  const wt = path.join(root, ".claude", "worktrees", "try+one");
  assert.deepEqual(r.data as ForkResult, { sessionId: id, cwd: wt, title: "원래 세션 (fork)" });
  const start = recorded().find((x) => x.sid === id && x.args)!;
  assert.equal(start.launched, root, "Claude Code starts in the original's folder");
  assert.equal(flagged(start.args, "--worktree"), "try/one");
  assert.deepEqual(JSON.parse(flagged(start.args, "--settings")!), { worktree: { baseRef: "head" } });
  assert.ok(start.args!.includes("--fork-session"));
  assert.equal(flagged(start.args, "--resume"), src);
  assert.equal(git(root, "rev-parse", "worktree-try+one"), git(root, "rev-parse", "HEAD"));
  assert.equal(fs.readFileSync(path.join(wt, "a.txt"), "utf8"), "a\n", "uncommitted changes stay behind");
  assert.match(git(root, "worktree", "list", "--porcelain"), /branch refs\/heads\/worktree-try\+one\nlocked claude session try\/one \(pid \d+/);

  const file = path.join(home, ".claude", "projects", projectDirName(wt), `${id}.jsonl`);
  assert.ok(fs.existsSync(file), "the fork's transcript is in the worktree's project folder");
  const listed = await until(async () => (await manager.list()).find((x) => x.id === id), "fork listed");
  assert.equal(listed.cwd, wt);
  assert.equal((await manager.snapshot(id)).state.cwd, wt, "the fork works in the worktree");
  assert.deepEqual(logged.find(([e]) => e === "fork")?.[1], { device: "phone", sessionId: src, forkId: id, worktree: "try/one" });

  const again = await call(src, "fork", { id, worktree: { name: "try/one" } });
  assert.deepEqual(again.data, r.data, "the same id gives the same fork");
  assert.equal(recorded().filter((x) => x.sid === id && x.args).length, 1);
});

test("a fork of a session in a worktree gets one of its own beside it, from that worktree's HEAD", async (t) => {
  const { call } = setup(t);
  const root = repo();
  const from = path.join(root, ".claude", "worktrees", "src");
  git(root, "worktree", "add", "-q", "-b", "worktree-src", from, "HEAD");
  fs.writeFileSync(path.join(from, "b.txt"), "b\n");
  git(from, "add", ".");
  git(from, "commit", "-qm", "on src");
  const src = randomUUID();
  transcript(src, from);
  const info = (await call(src, "fork_git", {})).data as GitFolderInfo;
  assert.equal(info.root, root, "worktrees go under the main checkout");
  assert.equal(info.branch, "worktree-src");
  const id = randomUUID();
  const r = await call(src, "fork", { id, worktree: { name: "beside" } });
  assert.equal(r.ok, true, r.error);
  const wt = path.join(root, ".claude", "worktrees", "beside");
  assert.equal((r.data as { cwd: string }).cwd, wt);
  assert.equal(git(wt, "rev-parse", "HEAD"), git(from, "rev-parse", "HEAD"));
  assert.ok(fs.existsSync(path.join(wt, "b.txt")));
});

test("a fork in a worktree is refused before Claude Code starts outside git, for a bad name, or a branch left behind", async (t) => {
  const { call } = setup(t);
  const plain = path.join(ws, "plain");
  fs.mkdirSync(plain, { recursive: true });
  const src = randomUUID();
  transcript(src, plain);
  const info = (await call(src, "fork_git", {})).data as GitFolderInfo;
  assert.equal(info.repo, false);
  assert.equal(info.changed, undefined);
  assert.equal((await call(src, "fork", { id: randomUUID(), worktree: { name: "x" } })).error, "not a git repository");

  const root = repo();
  git(root, "branch", "worktree-left");
  const src2 = randomUUID();
  transcript(src2, root);
  assert.equal((await call(src2, "fork", { id: randomUUID(), worktree: { name: "a b" } })).error, "invalid worktree name: chars");
  assert.equal((await call(src2, "fork", { id: randomUUID(), worktree: { name: "left" } })).error, "branch worktree-left already exists");
  assert.equal((await call(src2, "fork", { id: randomUUID(), worktree: "left" })).error, "invalid request");
  assert.equal(recorded().filter((x) => x.args).length, 0, "Claude Code never started");
});

test("a session below the top of its checkout forks only without a worktree, which would work at its top", async (t) => {
  const { call, logged } = setup(t);
  const root = repo();
  const sub = path.join(root, "sub");
  fs.mkdirSync(sub);
  const src = randomUUID();
  transcript(src, sub);
  const info = (await call(src, "fork_git", {})).data as GitFolderInfo;
  assert.equal(info.subfolder, true);
  assert.equal(info.root, root);
  assert.equal((await call(src, "fork", { id: randomUUID(), worktree: { name: "below" } })).error, "session works in a subfolder of its repository");
  assert.equal(recorded().filter((x) => x.args).length, 0, "Claude Code never started");
  assert.ok(!fs.existsSync(path.join(root, ".claude", "worktrees", "below")));
  assert.ok(!logged.some(([e]) => e === "fork"), "a refused fork is not logged");
  const r = await call(src, "fork", { id: randomUUID() });
  assert.equal(r.ok, true, r.error);
  assert.equal((r.data as { cwd: string }).cwd, sub, "without one the fork works where the session did");
});

test("a fork is refused the name of a worktree already there, which holds other work than HEAD and stays as it was", async (t) => {
  const { call } = setup(t);
  const root = repo();
  const wt = path.join(root, ".claude", "worktrees", "kept");
  git(root, "worktree", "add", "-q", "-b", "worktree-kept", wt, "HEAD");
  fs.writeFileSync(path.join(wt, "other.txt"), "other\n");
  const src = randomUUID();
  transcript(src, root);
  assert.deepEqual(((await call(src, "fork_git", {})).data as GitFolderInfo).existing, ["kept"]);
  assert.equal((await call(src, "fork", { id: randomUUID(), worktree: { name: "kept" } })).error, "worktree kept already exists");
  assert.equal(recorded().filter((x) => x.args).length, 0, "Claude Code never started");
  assert.ok(fs.existsSync(path.join(wt, "other.txt")));
  assert.equal(git(root, "branch", "--list", "worktree-kept").replace(/^[*+ ]+/, ""), "worktree-kept");
});

test("a fork from the first message gives the draft whether or not it asked for a worktree, and is logged as one", async (t) => {
  const { call, logged } = setup(t);
  const root = repo();
  const src = randomUUID();
  const ids = transcript(src, root);
  const r = await call(src, "fork", { id: randomUUID(), before: ids.u1, text: "다시", worktree: { name: "first" } });
  assert.deepEqual(r.data, { draft: { cwd: root } });
  assert.ok(!fs.existsSync(path.join(root, ".claude", "worktrees", "first")));
  assert.deepEqual(logged.find(([e]) => e === "fork")?.[1], { device: "phone", sessionId: src, before: ids.u1, draft: true }, "nothing was copied, made or sent");
});

test("a worktree made for a fork that then failed to start goes again, and its branch with it", async (t) => {
  const { manager, call, logged } = setup(t);
  const root = repo();
  fs.writeFileSync(path.join(root, ".fake-fail-start"), "");
  const src = randomUUID();
  transcript(src, root);
  const id = randomUUID();
  const r = await call(src, "fork", { id, worktree: { name: "gone" } });
  assert.match(r.error ?? "", /^fork failed: Claude Code could not start: Error: could not start$/);
  assert.equal(flagged(recorded().find((x) => x.sid === id)?.args, "--worktree"), "gone", "Claude Code was asked for the worktree");
  const wt = path.join(root, ".claude", "worktrees", "gone");
  await until(() => !fs.existsSync(wt), "worktree removed");
  assert.equal(git(root, "branch", "--list", "worktree-gone"), "");
  assert.ok(!(await manager.list()).some((x) => x.id === id));
  assert.ok(!fs.existsSync(path.join(home, ".claude", "file-history", id)));
  assert.ok(!logged.some(([e]) => e === "fork"), "a fork that failed is not logged");
});

test("a message's images and documents come back as uploads in its order, and what cannot is said", async (t) => {
  const { call, logged, uploads } = setup(t);
  const root = repo();
  const src = randomUUID();
  const big = "x".repeat(300 * 1024);
  const blocks: Block[] = [
    { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } },
    { type: "document", source: { type: "text", media_type: "text/plain", data: "notes\n" }, title: "notes.txt" },
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF.toString("base64") }, title: "spec.pdf" },
    { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
    { type: "document", source: { type: "text", media_type: "text/plain", data: big }, title: "big.txt" },
  ];
  const ids = transcript(src, root, blocks);
  const r = await call(src, "reattach", { messageId: ids.u1 });
  assert.equal(r.ok, true, r.error);
  const files = (r.data as ReattachResult).files;
  assert.deepEqual(
    files.map((f) => ("upload" in f ? [f.upload.kind, f.upload.name] : f.failed)),
    [["image", "image-1.png"], ["text", "notes.txt"], ["pdf", "spec.pdf"], "unreadable", "too_large"],
  );
  const made = files.flatMap((f) => ("upload" in f ? [f.upload.id] : []));
  assert.deepEqual(await uploads.blocks(made), blocks.slice(0, 3), "sent again, the files are the blocks the message had");
  assert.deepEqual(logged.find(([e]) => e === "reattach")?.[1], { device: "phone", sessionId: src, messageId: ids.u1, files: 3 });

  assert.deepEqual((await call(src, "reattach", { messageId: randomUUID() })).data, { files: [], gone: true });
  assert.equal((await call(src, "reattach", { messageId: "../x" })).error, "invalid request");
});

test("no more files come back than one message from the phone carries", async (t) => {
  const { call, uploads } = setup(t);
  const root = repo();
  const src = randomUUID();
  const docs: Block[] = Array.from({ length: 12 }, (_, i) => ({ type: "document", source: { type: "text", media_type: "text/plain", data: `${i}\n` }, title: `n${i}.txt` }));
  const ids = transcript(src, root, docs);
  const files = ((await call(src, "reattach", { messageId: ids.u1 })).data as ReattachResult).files;
  assert.deepEqual(
    files.map((f) => ("upload" in f ? f.upload.name : f.failed)),
    docs.slice(0, 10).map((d) => d.title),
  );
  assert.equal(fs.readdirSync(uploads.dir).filter((n) => !n.endsWith(".json")).length, 10, "only those are kept as uploads");
});

test("a message sent while Claude worked gives its files back from the queued row that holds it", async (t) => {
  const { call } = setup(t);
  const root = repo();
  const src = randomUUID();
  const queued = randomUUID();
  const ids = transcript(src, root);
  const project = path.join(home, ".claude", "projects", projectDirName(root));
  fs.appendFileSync(
    path.join(project, `${src}.jsonl`),
    JSON.stringify({
      type: "attachment",
      uuid: randomUUID(),
      parentUuid: ids.a2,
      sessionId: src,
      cwd: root,
      attachment: { type: "queued_command", source_uuid: queued, prompt: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } }, { type: "text", text: "더" }] },
    }) + "\n",
  );
  const files = ((await call(src, "reattach", { messageId: queued })).data as ReattachResult).files;
  assert.deepEqual(
    files.map((f) => ("upload" in f ? f.upload.kind : f.failed)),
    ["image"],
  );
});

test("what could not be attached again reads in one line", () => {
  assert.equal(reattachNote([]), undefined);
  assert.equal(reattachNote(["gone"]), "첨부 1개는 다시 붙이지 못했습니다 (기록에 없음)");
  assert.equal(reattachNote(["gone", "too_large", "gone"]), "첨부 3개는 다시 붙이지 못했습니다 (기록에 없음 2개, 너무 큼 1개)");
  assert.equal(reattachNote(["unreadable", "too_many", "failed"]), "첨부 3개는 다시 붙이지 못했습니다 (붙일 수 없는 형식 1개, 10개 넘음 1개, 가져오지 못함 1개)");
});
