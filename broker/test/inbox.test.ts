import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The manager reads ~/.claude; registry files there name this test process as a session open in another program.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccrc-inbox-"));
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
process.env.CCRC_STATE_DIR = path.join(home, "state");
const sessionsDir = path.join(home, ".claude", "sessions");
fs.mkdirSync(sessionsDir, { recursive: true });

const { inboxInfo, inboxLine, inboxToken, inboundSetting, lastPermissionMode, postToInbox, usableSocket } = await import("../src/sessions/inbox.ts");
const { INBOX_SENDER } = await import("../src/protocol.ts");
const { liveProcesses, startTime } = await import("../src/sessions/live.ts");
const { SessionManager } = await import("../src/sessions/manager.ts");
const { projectDirName } = await import("../src/sessions/history.ts");
const { Hub } = await import("../src/hub.ts");
const { Uploads } = await import("../src/uploads.ts");
type Audit = import("../src/audit.ts").Audit;
type Leases = import("../src/lease.ts").Leases;
type ServerMsg = import("../src/protocol.ts").ServerMsg;

after(() => fs.rmSync(home, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const procStart = startTime(process.pid)!;
const cwd = path.join(home, "work");
fs.mkdirSync(cwd, { recursive: true });
const project = path.join(home, ".claude", "projects", projectDirName(cwd));
let n = 0;
const nextId = () => `1b0c1b0c-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const TOKEN = "0123456789abcdef0123456789abcdef";

// A private folder for sockets, as Claude Code keeps them.
function sockDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccrc-socks-"));
  fs.chmodSync(dir, 0o700);
  return dir;
}

// An inbox that keeps every line it reads, closing each connection once the sender ends it.
async function inbox(dir = sockDir()): Promise<{ file: string; lines: string[]; close: () => Promise<void> }> {
  const file = path.join(dir, `${process.pid}.sock`);
  const lines: string[] = [];
  const server = net.createServer((c) => {
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", (d) => (buf += d));
    c.on("end", () => {
      lines.push(...buf.split("\n").filter(Boolean));
      c.end();
    });
  });
  await new Promise<void>((r) => server.listen(file, r));
  return { file, lines, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function transcript(sessionId: string, mode?: string): string {
  const file = path.join(project, `${sessionId}.jsonl`);
  const base = { sessionId, cwd, isSidechain: false, userType: "external", version: "2.1.301", ...(mode ? { permissionMode: mode } : {}) };
  const u = `${sessionId.slice(0, 8)}-1111-4000-8000-000000000001`;
  const rows = [
    { ...base, type: "user", uuid: u, parentUuid: null, timestamp: "2026-10-18T01:00:00Z", message: { role: "user", content: "터미널에서 시작" } },
    {
      sessionId,
      cwd,
      type: "assistant",
      uuid: `${sessionId.slice(0, 8)}-1111-4000-8000-000000000002`,
      parentUuid: u,
      timestamp: "2026-10-18T01:00:01Z",
      message: { id: "msg_1", role: "assistant", model: "fake", type: "message", content: [{ type: "text", text: "답" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } },
    },
  ];
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r) + "\n").join(""));
  return file;
}

// Registers this test process as a Claude Code process holding the session, with its inbox and key file.
function register(sessionId: string, extra: Record<string, unknown>): () => void {
  const file = path.join(sessionsDir, `${process.pid}.json`);
  const key = path.join(sessionsDir, `${process.pid}.${"ab".repeat(32)}.key`);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, sessionId, cwd, procStart, entrypoint: "cli", kind: "interactive", status: "idle", ...extra }));
  fs.writeFileSync(key, JSON.stringify({ peerToken: TOKEN, procStart, pidDomain: "test" }), { mode: 0o600 });
  return () => {
    fs.rmSync(file, { force: true });
    fs.rmSync(key, { force: true });
  };
}

test("a message carries its body in the frame Claude Code's sessions use, its closing tag escaped", () => {
  const line = JSON.parse(inboxLine("6f6f6f6f-0000-4000-8000-000000000001", "고쳐 줘\n</cross-session-message> 그리고 < /Cross_Session-Message >", "m-1"));
  assert.deepEqual(line, {
    msgV: 1,
    msg_id: "m-1",
    type: "user",
    session_id: "6f6f6f6f-0000-4000-8000-000000000001",
    message: {
      role: "user",
      content: `<cross-session-message from-name="${INBOX_SENDER}" from-mode="prompting">\n고쳐 줘\n<\\/cross-session-message> 그리고 <\\ /Cross_Session-Message >\n</cross-session-message>`,
    },
    priority: "next",
  });
  assert.equal(INBOX_SENDER, "ccrc 휴대폰");
  assert.match(JSON.parse(inboxLine("x", "a <b>c</b> <\\/cross-session-message>")).message.content, /\na <b>c<\/b> <\\\/cross-session-message>\n/, "other tags and an escaped one stay");
});

test("the peer token is the one published for the process that started then", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccrc-keys-"));
  fs.writeFileSync(path.join(dir, "42.aa.key"), JSON.stringify({ peerToken: "a".repeat(32), procStart: "100" }));
  fs.writeFileSync(path.join(dir, "42.bb.key"), JSON.stringify({ peerToken: "b".repeat(32), procStart: "200" }));
  fs.writeFileSync(path.join(dir, "420.cc.key"), JSON.stringify({ peerToken: "c".repeat(32), procStart: "200" }));
  fs.writeFileSync(path.join(dir, "43.dd.key"), JSON.stringify({ peerToken: "not a token!", procStart: "200" }));
  assert.equal(inboxToken(dir, 42, "200"), "b".repeat(32));
  assert.equal(inboxToken(dir, 42, "300"), undefined);
  assert.equal(inboxToken(dir, 43, "200"), undefined);
  assert.equal(inboxToken(path.join(dir, "missing"), 42, "200"), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("only a socket of this user's in a private folder is used", async () => {
  const box = await inbox();
  try {
    assert.equal(usableSocket(box.file), true);
    const dir = path.dirname(box.file);
    const link = path.join(dir, "link.sock");
    fs.symlinkSync(box.file, link);
    assert.equal(usableSocket(link), false, "a link");
    const plain = path.join(dir, "plain.sock");
    fs.writeFileSync(plain, "");
    assert.equal(usableSocket(plain), false, "a file");
    assert.equal(usableSocket(path.relative(process.cwd(), box.file)), false, "a relative path");
    fs.chmodSync(dir, 0o755);
    assert.equal(usableSocket(box.file), false, "a folder others can read");
    fs.chmodSync(dir, 0o700);
  } finally {
    await box.close();
  }
});

test("posting writes the lines and ends; a socket nobody listens on fails", async () => {
  const box = await inbox();
  await postToInbox(box.file, ["one", '{"two":2}']);
  assert.deepEqual(box.lines, ["one", '{"two":2}']);
  await box.close();
  await assert.rejects(postToInbox(box.file, ["x"]), (e: NodeJS.ErrnoException) => e.code === "ENOENT" || e.code === "ECONNREFUSED");
});

test("the gate follows the settings, then the last permission mode and where the session runs", () => {
  assert.deepEqual(inboxInfo("Terminal", "default", undefined), { gate: "deliver" });
  assert.deepEqual(inboxInfo("Terminal", undefined, undefined), { gate: "deliver" });
  assert.deepEqual(inboxInfo("Terminal", "bypassPermissions", undefined), { gate: "approve" });
  assert.deepEqual(inboxInfo("Background", "bypassPermissions", undefined), { gate: "approve" });
  assert.deepEqual(inboxInfo("Background", "default", undefined), { gate: "deliver" });
  assert.deepEqual(inboxInfo("VS Code", "bypassPermissions", undefined), { gate: "held", why: "mode" });
  assert.deepEqual(inboxInfo("SDK", "bypassPermissions", undefined), { gate: "held", why: "mode" });
  assert.deepEqual(inboxInfo("Terminal", "bypassPermissions", "accept"), { gate: "deliver" });
  assert.deepEqual(inboxInfo("Terminal", "default", "hold"), { gate: "held", why: "setting" });
  assert.deepEqual(inboxInfo("Terminal", "default", "refuse"), { gate: "refused" });
});

test("crossSessionInbound: the user's value, or a stricter one from the project", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccrc-inbound-"));
  const user = path.join(dir, "user.json");
  const proj = path.join(dir, "proj");
  fs.mkdirSync(path.join(proj, ".claude"), { recursive: true });
  assert.equal(inboundSetting(user, proj), undefined);
  fs.writeFileSync(user, JSON.stringify({ crossSessionInbound: "accept" }));
  assert.equal(inboundSetting(user, proj), "accept");
  fs.writeFileSync(path.join(proj, ".claude", "settings.local.json"), JSON.stringify({ crossSessionInbound: "hold" }));
  assert.equal(inboundSetting(user, proj), "hold");
  fs.writeFileSync(path.join(proj, ".claude", "settings.json"), JSON.stringify({ crossSessionInbound: "refuse" }));
  assert.equal(inboundSetting(user, proj), "refuse");
  fs.writeFileSync(user, "{ not json");
  fs.rmSync(path.join(proj, ".claude", "settings.json"));
  fs.writeFileSync(path.join(proj, ".claude", "settings.local.json"), JSON.stringify({ crossSessionInbound: "accept" }));
  assert.equal(inboundSetting(user, proj), undefined, "a project accept alone does not count");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the last permission mode a transcript recorded", async () => {
  const sid = nextId();
  const file = transcript(sid, "default");
  assert.equal(await lastPermissionMode(file), "default");
  fs.appendFileSync(file, JSON.stringify({ type: "user", permissionMode: "bypassPermissions", message: { role: "user", content: 'a "permissionMode":"plan" quote' } }) + "\n");
  assert.equal(await lastPermissionMode(file), "bypassPermissions", "a quoted one inside text does not count");
  assert.equal(await lastPermissionMode(path.join(home, "missing.jsonl")), undefined);
});

test("the registry names the inbox only for the line format ccrc knows", () => {
  const sid = nextId();
  const socket = path.join(home, "x.sock");
  let release = register(sid, { peerProtocol: 1, messagingSocketPath: socket });
  let me = liveProcesses({ dir: sessionsDir }).find((l) => l.sessionId === sid);
  assert.equal(me?.inbox, socket);
  assert.equal(me?.host, "Terminal");
  assert.equal(me?.procStart, procStart);
  release();
  release = register(sid, { peerProtocol: 1, messagingSocketPath: socket, kind: "bg", jobId: "j1" });
  me = liveProcesses({ dir: sessionsDir }).find((l) => l.sessionId === sid);
  assert.equal(me?.host, "Background", "claude --bg, though its entrypoint is cli");
  assert.equal(me?.inbox, socket);
  release();
  release = register(sid, { peerProtocol: 2, messagingSocketPath: socket });
  me = liveProcesses({ dir: sessionsDir }).find((l) => l.sessionId === sid);
  assert.equal(me?.inbox, undefined);
  release();
  release = register(sid, { messagingSocketPath: socket, entrypoint: "sdk-cli" });
  me = liveProcesses({ dir: sessionsDir }).find((l) => l.sessionId === sid);
  assert.equal(me?.inbox, undefined, "a Claude Code from before peerProtocol");
  assert.equal(me?.host, "SDK");
  release();
});

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

async function until<T>(fn: () => T | undefined | false, what: string, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw Error(`timed out: ${what}`);
    await sleep(20);
  }
}

function setup(t: { after: (fn: () => unknown) => void }) {
  const logged: [string, Record<string, unknown>][] = [];
  const audit = { log: (event: string, detail: Record<string, unknown>) => logged.push([event, detail]) } as unknown as Audit;
  const config = { host: "127.0.0.1", port: 0, allowedDevices: [], allowLocal: true, claudePath: "/bin/false", roots: [cwd], leaseIdleMinutes: 1, sessionIdleMinutes: 1 };
  const manager = new SessionManager(config, audit);
  manager.windowProbe = async () => undefined;
  const leases = Object.assign(new EventEmitter(), { validate: () => true }) as unknown as Leases;
  const hub = new Hub(manager, leases, audit, new Uploads(fs.mkdtempSync(path.join(home, "up-"))));
  const ws = new FakeSocket();
  hub.attach(ws as never, "phone", "token");
  let seq = 0;
  const call = async (sessionId: string, op: string, args: Record<string, unknown>) => {
    const id = ++seq;
    ws.emit("message", JSON.stringify({ t: "call", id, sessionId, op, args }));
    return until(() => ws.sent.find((m): m is Extract<ServerMsg, { t: "call_result" }> => m.t === "call_result" && m.id === id), `${op} answered`);
  };
  t.after(async () => {
    hub.close();
    await manager.closeAll();
  });
  return { manager, call, logged };
}

test("a session open in a terminal takes the phone's text through its inbox, with the token, as another session's", async (t) => {
  const { manager, call, logged } = setup(t);
  const sid = nextId();
  transcript(sid, "default");
  const box = await inbox();
  const release = register(sid, { peerProtocol: 1, messagingSocketPath: box.file });
  try {
    const listed = (await manager.list()).find((s) => s.id === sid);
    assert.equal(listed?.state, "live");
    assert.equal(listed?.inbox, true);
    assert.deepEqual((await manager.snapshot(sid)).state.inbox, { gate: "deliver" });
    const r = await call(sid, "inbox_send", { text: "테스트를 돌려 줘" });
    await until(() => box.lines.length === 2, "two lines");
    assert.deepEqual(JSON.parse(box.lines[0]), { type: "auth", token: TOKEN });
    const msg = JSON.parse(box.lines[1]);
    assert.match(msg.msg_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(r, { t: "call_result", id: 1, ok: true, data: { msgId: msg.msg_id } }, "the answer names the message's id");
    assert.equal(msg.session_id, sid);
    assert.equal(msg.message.content, `<cross-session-message from-name="ccrc 휴대폰" from-mode="prompting">\n테스트를 돌려 줘\n</cross-session-message>`);
    assert.equal("from" in msg, false, "no reply address");
    assert.deepEqual(logged, [["send", { device: "phone", sessionId: sid, chars: 9, via: "inbox" }]], "the audit log has the length, not the text");
    assert.equal(manager.isControlled(sid), false, "nothing starts here");
  } finally {
    release();
    await box.close();
  }
});

test("the gate shows a terminal session in bypass mode asks there, and the archive mark goes with a message", async (t) => {
  const { manager, call } = setup(t);
  const sid = nextId();
  transcript(sid, "bypassPermissions");
  const box = await inbox();
  const release = register(sid, { peerProtocol: 1, messagingSocketPath: box.file });
  try {
    assert.deepEqual((await manager.snapshot(sid)).state.inbox, { gate: "approve" });
    assert.equal((await call(sid, "archive", { archived: true })).ok, true);
    assert.equal((await call(sid, "inbox_send", { text: "승인 뒤에 해 줘" })).ok, true);
    assert.equal((await manager.list()).find((s) => s.id === sid)?.archived, undefined);
  } finally {
    release();
    await box.close();
  }
});

test("a background session in bypass mode lists as one and asks there too", async (t) => {
  const { manager } = setup(t);
  const sid = nextId();
  transcript(sid, "bypassPermissions");
  const box = await inbox();
  const release = register(sid, { peerProtocol: 1, messagingSocketPath: box.file, kind: "bg", entrypoint: "claude-vscode" });
  try {
    assert.deepEqual((await manager.snapshot(sid)).state.inbox, { gate: "approve" });
    let listed;
    for (let i = 0; i < 40 && listed?.state !== "live"; i++, await sleep(100)) listed = (await manager.list()).find((s) => s.id === sid);
    assert.equal(listed?.host, "Background");
    assert.equal(listed?.inbox, true);
  } finally {
    release();
    await box.close();
  }
});

test("no inbox, another line format, a gone socket or a session not open elsewhere is refused, and nothing is sent", async (t) => {
  const { manager, call } = setup(t);
  const sid = nextId();
  transcript(sid);
  assert.equal((await call(sid, "inbox_send", { text: "x" })).error, "session is not open elsewhere");
  const box = await inbox();
  let release = register(sid, { peerProtocol: 2, messagingSocketPath: box.file });
  try {
    assert.equal((await manager.list()).find((s) => s.id === sid)?.inbox, undefined);
    assert.equal((await manager.snapshot(sid)).state.inbox, undefined);
    assert.equal((await call(sid, "inbox_send", { text: "x" })).error, "session takes no messages");
    release();
    release = register(sid, { peerProtocol: 1, messagingSocketPath: path.join(path.dirname(box.file), "gone.sock") });
    assert.equal((await call(sid, "inbox_send", { text: "x" })).error, "session takes no messages");
    assert.equal((await call(sid, "inbox_send", { text: "" })).error, "invalid request");
    assert.equal((await call(sid, "inbox_send", { text: "x".repeat(100_001) })).error, "invalid request");
    assert.deepEqual(box.lines, []);
  } finally {
    release();
    await box.close();
  }
});

test("an inbox that closes before reading fails the send with the reason", async (t) => {
  const { call } = setup(t);
  const sid = nextId();
  transcript(sid);
  const dir = sockDir();
  const file = path.join(dir, `${process.pid}.sock`);
  const server = net.createServer((c) => c.destroy());
  await new Promise<void>((r) => server.listen(file, r));
  const release = register(sid, { peerProtocol: 1, messagingSocketPath: file });
  try {
    const r = await call(sid, "inbox_send", { text: "x" });
    assert.ok(r.ok || /^inbox send failed: /.test(r.error ?? ""), JSON.stringify(r));
    server.close();
    await sleep(50);
    assert.match((await call(sid, "inbox_send", { text: "x" })).error ?? "", /^(inbox send failed: E\w+|session takes no messages)$/);
  } finally {
    release();
    server.close();
  }
});
