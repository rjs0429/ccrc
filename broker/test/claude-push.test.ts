import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The manager reads ~/.claude and starts the fake CLI through the Agent SDK, as it starts Claude Code.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccrc-home-"));
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
process.env.CCRC_STATE_DIR = path.join(home, "state");
process.env.CCRC_CONFIG_DIR = path.join(home, "config");
const requests = path.join(home, "requests.jsonl");
process.env.FAKE_REQUESTS = requests;
fs.mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });

const { SessionManager } = await import("../src/sessions/manager.ts");
const { LinkServer } = await import("../src/link/server.ts");
const { LineSplitter, parseLine } = await import("../src/link/lines.ts");
const { projectDirName } = await import("../src/sessions/history.ts");
type DisplayItem = import("../src/protocol.ts").DisplayItem;
type ServerMsg = import("../src/protocol.ts").ServerMsg;
type Msg = Record<string, unknown>;

const cwd = path.join(home, "work");
fs.mkdirSync(cwd, { recursive: true });
const FAKE = new URL("./fixtures/fake-claude.mjs", import.meta.url).pathname;
const X = "5f0e8a43-6a8b-4a0f-9f6e-2b7d7c1e9a10";
const Y = "7c2d1b90-3e4f-4a5b-8c6d-9e0f1a2b3c4d";

const managers: InstanceType<typeof SessionManager>[] = [];
const servers: InstanceType<typeof LinkServer>[] = [];
after(async () => {
  for (const m of managers) await m.closeAll();
  for (const s of servers) await s.close();
  fs.rmSync(home, { recursive: true, force: true });
});

function manager() {
  const m = new SessionManager({ host: "127.0.0.1", port: 0, allowedDevices: [], allowLocal: true, claudePath: FAKE, roots: [cwd], leaseIdleMinutes: 1, sessionIdleMinutes: 1, brokerSessions: "subscription" });
  m.modelProbe = async () => [];
  m.windowProbe = async () => undefined;
  m.usageProbe = async () => ({ limits: [] });
  managers.push(m);
  const items: DisplayItem[] = [];
  let changed = 0;
  m.on("event", (_id: string, msg: ServerMsg) => {
    if (msg.t === "item") items.push(msg.item);
  });
  m.on("changed", () => changed++);
  return { m, items, changes: () => changed };
}

const until = async (fn: () => boolean, label: string, ms = 5000) => {
  for (let i = 0; i < ms / 20 && !fn(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(fn(), label);
};

// The PushNotification item of the conversation once its result is in.
const pushed = (items: DisplayItem[]) => items.filter((i): i is Extract<DisplayItem, { kind: "tool" }> => i.kind === "tool" && i.name === "PushNotification" && Boolean(i.result)).at(-1);

test("a broker session's PushNotification call reads as requested once ccrc sends it, and as Claude Code answered otherwise", async () => {
  const { m, items } = manager();
  const asked: [string, string, string][] = [];
  let answer: "sent" | "watching" | "off" | undefined = "sent";
  m.claudeNotice = (sessionId, toolUseId, message) => (asked.push([sessionId, toolUseId, message]), answer!);
  const s = await m.create(cwd, {});
  const result = async (text: string) => {
    const before = items.filter((i) => i.kind === "tool" && i.name === "PushNotification" && i.result).length;
    s.send(`PUSH ${text}`);
    await until(() => items.filter((i) => i.kind === "tool" && i.name === "PushNotification" && i.result).length > before, `result of ${text}`);
    return pushed(items)!.result!;
  };
  assert.deepEqual(await result("테스트가 끝났습니다"), { text: "Mobile push requested.", isError: false, truncated: false });
  assert.equal(asked.length, 1);
  assert.equal(asked[0][0], s.id);
  assert.match(asked[0][1], /^toolu_push_/);
  assert.equal(asked[0][2], "테스트가 끝났습니다");
  assert.equal(pushed(items)!.summary, "테스트가 끝났습니다", "the call shows its message");
  const own = "Mobile push not sent (Remote Control inactive).";
  answer = "watching";
  assert.equal(
    (await result("보는 중")).text,
    "Not sent \u2014 this terminal is active, so your output here already reaches the user; a separate notification would be redundant.",
    "the user is looking at it: nothing went, as Claude Code says of its own terminal",
  );
  answer = "off";
  assert.equal((await result("꺼짐")).text, own);
  answer = undefined;
  assert.equal((await result("훅 없이")).text, own, "nothing decides it");
  const init = fs
    .readFileSync(requests, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Msg)
    .find((r) => (r.request as Msg | undefined)?.subtype === "initialize");
  const hooks = (init!.request as Msg).hooks as Msg;
  assert.deepEqual(Object.keys(hooks), ["PostToolUse"]);
  assert.deepEqual((hooks.PostToolUse as Msg[]).map((h) => h.matcher), ["PushNotification"]);
  await s.close("released");
});

test("the list marks unread sessions; opening, VS Code's later message or the user's choice reads them", async () => {
  const { m, changes } = manager();
  const project = path.join(home, ".claude", "projects", projectDirName(cwd));
  fs.mkdirSync(project, { recursive: true });
  const row = (id: string) => JSON.stringify({ type: "user", uuid: "8d2e4f6a-1b3c-4d5e-8f9a-0b1c2d3e4f5a", sessionId: id, cwd, timestamp: new Date().toISOString(), message: { role: "user", content: "hi" } }) + "\n";
  fs.writeFileSync(path.join(project, `${X}.jsonl`), row(X));
  const unread = async () => (await m.list()).filter((s) => s.unread).map((s) => s.id);
  assert.deepEqual(await unread(), []);
  const before = changes();
  m.markUnread(X);
  assert.equal(changes(), before + 1, "the list is told");
  m.markUnread(X);
  assert.equal(changes(), before + 1, "already unread");
  assert.deepEqual(await unread(), [X]);
  assert.deepEqual(m.unreadSessions(), [X]);
  m.markRead(X, Date.now() - 60_000);
  assert.deepEqual(await unread(), [X], "a message VS Code wrote before it became unread");
  m.markSeen(X);
  assert.deepEqual(await unread(), []);
  assert.deepEqual(await m.call(X, "mark_unread", { unread: true }), { unread: true });
  assert.deepEqual(await unread(), [X]);
  assert.deepEqual(await m.call(X, "mark_unread", { unread: false }), { unread: false });
  assert.deepEqual(await unread(), []);
  await assert.rejects(m.call(Y, "mark_unread", { unread: true }), /unknown session/);
  m.markUnread(X);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(home, "state", "unread.json"), "utf8"))), [X], "kept for the next broker");
  fs.rmSync(path.join(project, `${X}.jsonl`));
  m.pruneArchived();
  assert.deepEqual(m.unreadSessions(), [], "a session whose transcript is gone leaves");
});

class FakeWrapper {
  frames: Msg[] = [];
  sock: net.Socket;
  constructor(sock: net.Socket) {
    this.sock = sock;
    const split = new LineSplitter((line) => {
      const f = parseLine(line);
      if (f) this.frames.push(f);
    });
    sock.on("data", (c: Buffer) => split.push(c));
  }
  send(frame: Msg): void {
    this.sock.write(JSON.stringify(frame) + "\n");
  }
}

test("wrappers that can are told whether Claude's notifications reach a device and whether the user watches their session, at hello and on each change; a message from VS Code reads its session", async () => {
  const { m } = manager();
  const server = new LinkServer(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ccrc-link-")), "link.sock"));
  servers.push(server);
  server.on("link", (link) => m.attachLink(link));
  await server.listen();
  const connect = async (hello: Msg) => {
    const sock = net.createConnection(server.socketPath);
    await new Promise((r) => sock.once("connect", r));
    const w = new FakeWrapper(sock);
    w.send({ t: "hello", v: 1, wpid: 1, cwd, args: [], ...hello });
    return w;
  };
  const pushFrames = (w: FakeWrapper) => w.frames.filter((f) => f.t === "claude_push").map((f) => [f.on, f.watching]);
  m.setClaudePush(true);
  const able = await connect({ sessionId: X, caps: ["fast_mode", "thinking", "claude_push"] });
  const old = await connect({ sessionId: Y, caps: ["fast_mode", "thinking"] });
  await until(() => pushFrames(able).length === 1, "told at hello");
  m.setClaudePush(true);
  m.setClaudePush(false);
  await until(() => pushFrames(able).length === 2, "told of the change");
  m.setViewed(X, true);
  m.setClaudePush(true);
  m.setViewed(X, false);
  m.setViewed(X, true);
  m.setViewed(Y, true);
  m.setViewed(null);
  await until(() => pushFrames(able).length === 6, "told of the user watching its session");
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(pushFrames(able), [
    [true, false],
    [false, false],
    [true, true],
    [true, false],
    [true, true],
    [true, false],
  ]);
  assert.deepEqual(pushFrames(old), [], "a wrapper that cannot is not told");

  await until(() => m.isControlled(X), "attached");
  m.markUnread(X);
  able.send({ m: { type: "user", uuid: "11111111-2222-4333-8444-555555555555", timestamp: new Date(Date.now() - 60_000).toISOString(), message: { role: "user", content: [{ type: "text", text: "old" }] } }, t: "in" });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(m.unreadSessions(), [X], "VS Code's message from before");
  able.send({ m: { type: "user", uuid: "11111111-2222-4333-8444-666666666666", remote: true, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "from the phone" }] } }, t: "in" });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(m.unreadSessions(), [X], "the phone's own message is not VS Code's");
  able.send({ m: { type: "user", uuid: "11111111-2222-4333-8444-777777777777", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "new" }] } }, t: "in" });
  await until(() => m.unreadSessions().length === 0, "VS Code's new message reads it");
  m.setViewed(Y, true);
  able.send({ t: "out", m: { type: "system", subtype: "init", session_id: Y } });
  await until(() => pushFrames(able).length === 7, "told as its session becomes the one watched");
  assert.deepEqual(pushFrames(able).at(-1), [true, true]);
  able.sock.destroy();
  old.sock.destroy();
});
