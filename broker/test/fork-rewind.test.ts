import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The manager reads ~/.claude and starts the fake CLI, which keeps transcripts there and records what it was asked.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccrc-home-"));
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
process.env.CCRC_STATE_DIR = path.join(home, "state");
const requests = path.join(home, "requests.jsonl");
process.env.FAKE_REQUESTS = requests;
const sessionsDir = path.join(home, ".claude", "sessions");
fs.mkdirSync(sessionsDir, { recursive: true });

const { SessionManager } = await import("../src/sessions/manager.ts");
const { loadHistory, projectDirName } = await import("../src/sessions/history.ts");
const { Hub } = await import("../src/hub.ts");
const { Uploads } = await import("../src/uploads.ts");
type Audit = import("../src/audit.ts").Audit;
type Leases = import("../src/lease.ts").Leases;
type ServerMsg = import("../src/protocol.ts").ServerMsg;
type DisplayItem = import("../src/protocol.ts").DisplayItem;

const cwd = path.join(home, "work");
fs.mkdirSync(cwd, { recursive: true });
const project = path.join(home, ".claude", "projects", projectDirName(cwd));
const FAKE = new URL("./fixtures/fake-claude-fork.mjs", import.meta.url).pathname;
const config = { host: "127.0.0.1", port: 0, allowedDevices: [], allowLocal: true, claudePath: FAKE, roots: [cwd], leaseIdleMinutes: 1, sessionIdleMinutes: 1 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

after(() => fs.rmSync(home, { recursive: true, force: true }));

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

type Recorded = { sid: string; args?: string[]; user?: string; request?: Record<string, unknown> };
const recorded = (): Recorded[] =>
  fs.existsSync(requests)
    ? fs
        .readFileSync(requests, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Recorded)
    : [];
const arg = (args: string[] | undefined, name: string) => {
  const i = args?.findIndex((a) => a === name || a.startsWith(`${name}=`)) ?? -1;
  return i < 0 ? undefined : args![i].includes("=") ? args![i].split("=")[1] : args![i + 1];
};

async function until<T>(fn: () => T | undefined | false, what: string, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw Error(`timed out: ${what}`);
    await sleep(20);
  }
}

// A stopped session with three exchanges, named "원래 세션", and the ids of its rows.
function transcript(sid: string) {
  const ids = { u1: randomUUID(), a1: randomUUID(), u2: randomUUID(), a2: randomUUID(), u3: randomUUID(), a3: randomUUID() };
  const base = { sessionId: sid, cwd, isSidechain: false, userType: "external", version: "2.1.300", gitBranch: "" };
  const rows: Record<string, unknown>[] = [];
  let parent: string | null = null;
  for (const [n, text] of ["첫째", "둘째", "셋째"].entries()) {
    const u = Object.values(ids)[2 * n];
    const a = Object.values(ids)[2 * n + 1];
    rows.push({ ...base, parentUuid: parent, uuid: u, timestamp: `2026-10-16T01:00:0${2 * n}Z`, type: "user", message: { role: "user", content: text } });
    rows.push({ ...base, parentUuid: u, uuid: a, timestamp: `2026-10-16T01:00:0${2 * n + 1}Z`, type: "assistant", message: { id: `msg_${n}`, role: "assistant", model: "fake", type: "message", content: [{ type: "text", text: `${text}에 답` }], stop_reason: "end_turn" } });
    parent = a;
  }
  rows.push({ type: "custom-title", customTitle: "원래 세션", sessionId: sid });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, `${sid}.jsonl`), rows.map((r) => JSON.stringify(r) + "\n").join(""));
  return ids;
}

const rowsOf = (sid: string) =>
  fs
    .readFileSync(path.join(project, `${sid}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
const texts = (items: DisplayItem[]) => items.filter((i) => i.kind === "user" || i.kind === "assistant").map((i) => ("text" in i ? i.text : ""));

function setup(t: { after: (fn: () => unknown) => void }) {
  fs.rmSync(requests, { force: true });
  const logged: [string, Record<string, unknown>][] = [];
  const audit = { log: (event: string, detail: Record<string, unknown>) => logged.push([event, detail]) } as unknown as Audit;
  const manager = new SessionManager(config, audit);
  manager.windowProbe = async () => undefined;
  const leases = Object.assign(new EventEmitter(), { validate: () => true }) as unknown as Leases;
  const hub = new Hub(manager, leases, audit, new Uploads(fs.mkdtempSync(path.join(home, "up-"))));
  const ws = new FakeSocket();
  hub.attach(ws as never, "phone", "token");
  const say = (m: Record<string, unknown>) => ws.emit("message", JSON.stringify(m));
  let seq = 0;
  const call = async (sessionId: string, op: string, args: Record<string, unknown>, ms = 15_000) => {
    const id = ++seq;
    say({ t: "call", id, sessionId, op, args });
    return until(() => ws.sent.find((m): m is Extract<ServerMsg, { t: "call_result" }> => m.t === "call_result" && m.id === id), `${op} answered`, ms);
  };
  t.after(async () => {
    say({ t: "view", sessionId: null });
    hub.close();
    await manager.closeAll();
  });
  return { manager, hub, ws, say, call, logged };
}

test("a fork from the menu copies the whole conversation under the phone's id and names it", async (t) => {
  const { manager, call, logged } = setup(t);
  const src = randomUUID();
  const ids = transcript(src);
  const id = randomUUID();
  const r = await call(src, "fork", { id });
  assert.deepEqual(r.data, { sessionId: id, cwd: fs.realpathSync(cwd), title: "원래 세션 (fork)" });
  const start = recorded().find((x) => x.sid === id && x.args)!;
  assert.equal(arg(start.args, "--resume"), src);
  assert.equal(arg(start.args, "--session-id"), id);
  assert.ok(start.args!.includes("--fork-session"));
  assert.equal(arg(start.args, "--resume-session-at"), undefined);
  assert.deepEqual(
    recorded().filter((x) => x.sid === id && x.user).map((x) => x.user),
    ["/rename 원래 세션 (fork)"],
    "the name is the first input and nothing else goes",
  );
  const copied = rowsOf(id).filter((x) => x.type === "user" || x.type === "assistant").map((x) => x.uuid);
  assert.deepEqual(copied.slice(0, 6), Object.values(ids), "the copy keeps the message ids");
  const s = (await manager.list()).find((x) => x.id === id);
  assert.equal(s?.title, "원래 세션 (fork)");
  assert.equal(s?.state, "owned");
  const items = (await manager.snapshot(id)).items;
  assert.deepEqual(texts(items), ["첫째", "첫째에 답", "둘째", "둘째에 답", "셋째", "셋째에 답"]);
  assert.equal(items.at(-1)?.kind, "command", "the naming command's result ends the copy, as its transcript has it");
  assert.equal(items.filter((i) => i.kind === "user" && i.text.startsWith("/rename")).length, 0);
  assert.deepEqual(logged.find(([e]) => e === "fork"), ["fork", { device: "phone", sessionId: src, forkId: id }]);
  assert.equal(fs.existsSync(path.join(home, ".claude", "file-history", id)), true);
});

test("a fork from a message ends before it; asked again with the same id it is the same fork", async (t) => {
  const { call } = setup(t);
  const src = randomUUID();
  const ids = transcript(src);
  const id = randomUUID();
  const [one, two] = await Promise.all([call(src, "fork", { id, before: ids.u2 }), call(src, "fork", { id, before: ids.u2 })]);
  assert.deepEqual(one.data, two.data);
  assert.equal(recorded().filter((x) => x.sid === id && x.args).length, 1, "one Claude Code for the fork");
  assert.equal(arg(recorded().find((x) => x.sid === id && x.args)?.args, "--resume-session-at"), ids.a1);
  assert.deepEqual(
    rowsOf(id).filter((x) => x.type === "assistant").map((x) => x.uuid),
    [ids.a1],
  );
  const again = await call(src, "fork", { id, before: ids.u2 });
  assert.deepEqual(again.data, one.data);
});

test("a fork from the first message is a draft in the session's folder, with no Claude Code started", async (t) => {
  const { call } = setup(t);
  const src = randomUUID();
  const ids = transcript(src);
  const r = await call(src, "fork", { id: randomUUID(), before: ids.u1 });
  assert.deepEqual(r.data, { draft: { cwd: fs.realpathSync(cwd) } });
  assert.deepEqual(recorded(), []);
  assert.equal((await call(src, "fork", { id: randomUUID(), before: randomUUID() })).error, "unknown message");
  assert.equal((await call(src, "fork", { id: "not-a-uuid" })).error, "invalid request");
  assert.equal((await call(src, "fork", { id: src })).error, "invalid request");
});

test("a fork given a first message runs it after its name, as the phone's own work, and inherits all but Fast mode", async (t) => {
  const { manager, hub, call, logged } = setup(t);
  const src = randomUUID();
  transcript(src);
  manager.models = [];
  await manager.setMode(src, "plan");
  await manager.setModel(src, "claude-opus-5-5");
  await manager.setEffort(src, "high");
  await manager.setFast(src, true);
  await manager.setThinking(src, false);
  const id = randomUUID();
  const r = await call(src, "fork", { id, text: "다른 방법을 써 봐" });
  assert.equal(r.ok, true, JSON.stringify(r));
  await until(() => recorded().filter((x) => x.sid === id && x.user).length === 2, "the first message went");
  assert.deepEqual(
    recorded().filter((x) => x.sid === id && x.user).map((x) => x.user),
    ["/rename 원래 세션 (fork)", "다른 방법을 써 봐"],
  );
  const args = recorded().find((x) => x.sid === id && x.args)!.args!;
  assert.equal(arg(args, "--permission-mode"), "plan");
  assert.equal(arg(args, "--model"), "claude-opus-5-5");
  assert.equal(arg(args, "--effort"), "high");
  assert.ok(args.includes("--thinking=disabled"));
  assert.ok(!args.some((a) => a.includes("fastMode")), JSON.stringify(args));
  assert.ok(hub.remoteActivity(id) !== undefined, "the fork's turn is the phone's to hear the end of");
  assert.deepEqual(logged.find(([e]) => e === "fork")?.[1], { device: "phone", sessionId: src, forkId: id, chars: 10 });
  await until(() => (manager as unknown as { controlled(id: string): { busy: boolean } | undefined }).controlled(id)?.busy === false, "the turn ended");
  assert.deepEqual(texts((await manager.snapshot(id)).items).slice(-2), ["다른 방법을 써 봐", "echo: 다른 방법을 써 봐"]);
});

test("a fork of a session whose turn runs leaves that turn out", async (t) => {
  const { manager, call, say } = setup(t);
  const src = randomUUID();
  const ids = transcript(src);
  say({ t: "send", sessionId: src, text: "HOLD" });
  await until(() => recorded().some((x) => x.sid === src && x.user === "HOLD"), "the turn runs");
  await until(async () => (await manager.list()).find((x) => x.id === src)?.busy, "busy");
  const id = randomUUID();
  const r = await call(src, "fork", { id });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(arg(recorded().find((x) => x.sid === id && x.args)?.args, "--resume-session-at"), ids.a3);
  assert.deepEqual(texts((await manager.snapshot(id)).items), ["첫째", "첫째에 답", "둘째", "둘째에 답", "셋째", "셋째에 답"]);
});

test("a fork of a session whose turn runs elsewhere leaves out the whole turn, whatever came into it or started it", async (t) => {
  const { call } = setup(t);
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const procStart = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  const holder = path.join(sessionsDir, `${process.pid}.json`);
  t.after(() => fs.rmSync(holder, { force: true }));
  const base = { cwd, isSidechain: false, userType: "external", version: "2.1.301", gitBranch: "" };
  const running = (src: string, rows: Record<string, unknown>[]) => {
    fs.appendFileSync(path.join(project, `${src}.jsonl`), rows.map((r) => JSON.stringify({ sessionId: src, ...base, timestamp: "2026-10-16T01:00:09Z", ...r }) + "\n").join(""));
    fs.writeFileSync(holder, JSON.stringify({ pid: process.pid, sessionId: src, cwd, procStart, entrypoint: "cli", status: "busy" }));
  };
  const tool = (uuid: string, parentUuid: string, id: string) => ({ parentUuid, uuid, type: "assistant", message: { id: `msg_${uuid}`, role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: {} }] } });
  // Claude took in a message sent during the turn.
  const src = randomUUID();
  const ids = transcript(src);
  const [u4, call4, done4, queued] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  running(src, [
    { parentUuid: ids.a3, uuid: u4, type: "user", message: { role: "user", content: "넷째: 시험을 돌려" } },
    tool(call4, u4, "toolu_1"),
    { parentUuid: call4, uuid: done4, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] } },
    { parentUuid: done4, uuid: queued, type: "attachment", attachment: { type: "queued_command", prompt: "lint 도", source_uuid: randomUUID(), commandMode: "prompt" } },
    tool(randomUUID(), queued, "toolu_2"),
  ]);
  const id = randomUUID();
  assert.equal((await call(src, "fork", { id })).ok, true);
  assert.equal(arg(recorded().find((x) => x.sid === id && x.args)?.args, "--resume-session-at"), ids.a3);
  // A command started the turn.
  const other = randomUUID();
  const more = transcript(other);
  const command = randomUUID();
  running(other, [{ parentUuid: more.a3, uuid: command, type: "user", message: { role: "user", content: "<command-message>review</command-message>\n<command-name>/review</command-name>" } }, tool(randomUUID(), command, "toolu_3")]);
  const id2 = randomUUID();
  assert.equal((await call(other, "fork", { id: id2 })).ok, true);
  assert.equal(arg(recorded().find((x) => x.sid === id2 && x.args)?.args, "--resume-session-at"), more.a3);
});

test("a fork asked again with its id takes the first message the earlier request did not bring, once", async (t) => {
  const { call } = setup(t);
  const src = randomUUID();
  transcript(src);
  const id = randomUUID();
  const opened = await call(src, "fork", { id });
  assert.equal(opened.ok, true);
  const started = await call(src, "fork", { id, text: "이제 시작해" });
  assert.deepEqual(started.data, { ...(opened.data as object), sent: true });
  assert.deepEqual((await call(src, "fork", { id, text: "이제 시작해" })).data, started.data, "a retry sends nothing more");
  await until(() => recorded().filter((x) => x.sid === id && x.user === "이제 시작해").length === 1 && recorded().filter((x) => x.sid === id && x.user).length, "the message went");
  await sleep(200);
  assert.deepEqual(
    recorded().filter((x) => x.sid === id && x.user).map((x) => x.user),
    ["/rename 원래 세션 (fork)", "이제 시작해"],
  );
  // The other way round, the answer tells the fork has its message already.
  const id2 = randomUUID();
  assert.equal((await call(src, "fork", { id: id2, text: "바로 시작" })).ok, true);
  assert.equal(((await call(src, "fork", { id: id2 })).data as { sent?: boolean }).sent, true);
});

test("a fork given a name is called by it, as Claude Code's /branch names one", async (t) => {
  const { call } = setup(t);
  const src = randomUUID();
  transcript(src);
  const id = randomUUID();
  const r = await call(src, "fork", { id, name: "  실험\n이름 " });
  assert.equal((r.data as { title: string }).title, "실험 이름");
  assert.deepEqual(
    recorded().filter((x) => x.sid === id && x.user).map((x) => x.user),
    ["/rename 실험 이름"],
  );
  assert.equal((await call(src, "fork", { id: randomUUID(), name: "" })).error, "invalid request");
});

test("a fork that cannot start leaves nothing behind and says why", async (t) => {
  const { manager, call } = setup(t);
  const src = randomUUID();
  transcript(src);
  // The source's transcript goes away between the listing and the start.
  const id = randomUUID();
  assert.ok((await manager.list()).some((x) => x.id === src));
  fs.renameSync(path.join(project, `${src}.jsonl`), path.join(home, "moved.jsonl"));
  const r = await call(src, "fork", { id }, 70_000);
  fs.renameSync(path.join(home, "moved.jsonl"), path.join(project, `${src}.jsonl`));
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /^fork failed: Claude Code could not start: [\s\S]*No conversation found/);
  assert.ok(!(await manager.list()).some((x) => x.id === id));
  assert.equal(fs.existsSync(path.join(home, ".claude", "file-history", id)), false);
});

test("a rewind of a session run here is in place: conversation, then files, the cut kept by Claude Code", async (t) => {
  const { manager, ws, say, call, logged } = setup(t);
  const src = randomUUID();
  const ids = transcript(src);
  fs.writeFileSync(path.join(cwd, ".fake-rewind.json"), JSON.stringify({ files: [path.join(cwd, "a.txt")], insertions: 1, deletions: 1 }));
  t.after(() => fs.rmSync(path.join(cwd, ".fake-rewind.json"), { force: true }));
  say({ t: "view", sessionId: src });
  assert.equal((await call(src, "resume", {})).ok, true);
  await until(() => recorded().some((x) => x.sid === src && x.request?.subtype === "initialize"), "started");
  const refused = await call(src, "rewind_conversation", { userMessageId: ids.u2, choice: "conversation" });
  assert.equal(refused.error, "rewind refused: stale_target", "without the latest message seen, Claude Code refuses");
  const snaps = ws.sent.filter((m) => m.t === "snapshot").length;
  const r = await call(src, "rewind_conversation", { userMessageId: ids.u2, choice: "both", lastSeen: ids.u3 });
  assert.deepEqual(r.data, { mode: "in_place", prefill: "둘째", files: { canRewind: true, filesChanged: [path.join(cwd, "a.txt")] } });
  const asked = recorded()
    .filter((x) => x.sid === src && x.request && /rewind/.test(String(x.request.subtype)))
    .map((x) => x.request);
  assert.deepEqual(asked.slice(-2), [
    { subtype: "rewind_conversation", target_message_uuid: ids.u2, last_seen_user_message_uuid: ids.u3 },
    { subtype: "rewind_files", user_message_id: ids.u2, dry_run: false },
  ]);
  assert.deepEqual(texts((await manager.snapshot(src)).items), ["첫째", "첫째에 답"]);
  const snap = await until(() => ws.sent.filter((m) => m.t === "snapshot").length > snaps && ws.sent.findLast((m) => m.t === "snapshot"), "a new snapshot");
  assert.deepEqual(texts((snap as Extract<ServerMsg, { t: "snapshot" }>).items), ["첫째", "첫째에 답"]);
  assert.deepEqual(logged.find(([e]) => e === "rewind_conversation")?.[1], { device: "phone", sessionId: src, userMessageId: ids.u2, choice: "both", mode: "in_place", files: true });
  // A new message goes on from there; read again from the transcript, so does the conversation.
  say({ t: "send", sessionId: src, text: "넷째" });
  await until(async () => texts((await manager.snapshot(src)).items).includes("echo: 넷째"), "answered");
  await manager.release(src);
  assert.deepEqual(texts(await loadHistory(src, cwd)), ["첫째", "첫째에 답", "넷째", "echo: 넷째"]);
});

test("a rewind Claude Code refuses changes nothing; one it cannot do opens a new session instead", async (t) => {
  const { manager, call, say } = setup(t);
  const src = randomUUID();
  const ids = transcript(src);
  assert.equal((await call(src, "rewind_conversation", { userMessageId: ids.u2, choice: "conversation", lastSeen: ids.u3 })).error, "session is not running here");
  say({ t: "view", sessionId: src });
  assert.equal((await call(src, "resume", {})).ok, true);
  await until(() => recorded().some((x) => x.sid === src && x.request?.subtype === "initialize"), "started");
  fs.writeFileSync(path.join(cwd, ".fake-unseen"), "");
  try {
    assert.equal((await call(src, "rewind_conversation", { userMessageId: ids.u2, choice: "conversation", lastSeen: ids.u3 })).error, "rewind refused: unseen_later_turn");
  } finally {
    fs.rmSync(path.join(cwd, ".fake-unseen"), { force: true });
  }
  assert.equal(texts((await manager.snapshot(src)).items).length, 6);
  assert.equal((await call(src, "rewind_conversation", { userMessageId: randomUUID(), choice: "conversation" })).error, "unknown message");
  assert.equal((await call(src, "rewind_conversation", { userMessageId: ids.u2, choice: "code" })).error, "invalid request");
  say({ t: "send", sessionId: src, text: "HOLD" });
  await until(async () => (await manager.list()).find((x) => x.id === src)?.busy, "busy");
  assert.equal((await call(src, "rewind_conversation", { userMessageId: ids.u2, choice: "conversation", lastSeen: ids.u3 })).error, "session is busy");
});

test("Claude Code without rewind_conversation: the rewind opens a new session at the message", async (t) => {
  process.env.FAKE_NO_REWIND = "1";
  t.after(() => delete process.env.FAKE_NO_REWIND);
  const { manager, call, say } = setup(t);
  const src = randomUUID();
  const ids = transcript(src);
  say({ t: "view", sessionId: src });
  assert.equal((await call(src, "resume", {})).ok, true);
  const forkId = randomUUID();
  const r = await call(src, "rewind_conversation", { userMessageId: ids.u2, choice: "conversation", lastSeen: ids.u3, forkId });
  assert.deepEqual(r.data, { mode: "forked", sessionId: forkId, prefill: "둘째", fallback: true });
  assert.equal(texts((await manager.snapshot(src)).items).length, 6, "the conversation stays");
  assert.deepEqual(texts((await manager.snapshot(forkId)).items), ["첫째", "첫째에 답"]);
});

test("a session open in a terminal rewinds only its conversation, into a new session", async (t) => {
  const { manager, call } = setup(t);
  const src = randomUUID();
  const ids = transcript(src);
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const procStart = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  const holder = path.join(sessionsDir, `${process.pid}.json`);
  fs.writeFileSync(holder, JSON.stringify({ pid: process.pid, sessionId: src, cwd, procStart, entrypoint: "cli" }));
  t.after(() => fs.rmSync(holder, { force: true }));
  assert.equal((await call(src, "rewind_conversation", { userMessageId: ids.u3, choice: "both", forkId: randomUUID() })).error, "cannot rewind files while open in Terminal");
  assert.equal((await call(src, "rewind_conversation", { userMessageId: ids.u3, choice: "conversation" })).error, "invalid request", "it needs the new session's id");
  const forkId = randomUUID();
  const r = await call(src, "rewind_conversation", { userMessageId: ids.u3, choice: "conversation", forkId });
  assert.deepEqual(r.data, { mode: "forked", sessionId: forkId, prefill: "셋째" });
  assert.deepEqual(texts((await manager.snapshot(forkId)).items), ["첫째", "첫째에 답", "둘째", "둘째에 답"]);
  const first = await call(src, "rewind_conversation", { userMessageId: ids.u1, choice: "conversation", forkId: randomUUID() });
  assert.deepEqual(first.data, { mode: "draft", cwd: fs.realpathSync(cwd), prefill: "첫째" });
});
