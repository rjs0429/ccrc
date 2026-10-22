import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, test } from "node:test";
import { LineSplitter, parseLine } from "../src/link/lines.ts";
import {
  Relay,
  allowedBackground,
  allowedFlagSettings,
  allowedMcpAuthenticate,
  allowedMcpCallback,
  allowedOAuthCallback,
  mcpAuthAnswer,
  allowedRename,
  allowedSideQuestion,
  allowedThinking,
  allowedTaskOutput,
  allowedWorkspaceDiff,
  allowedUpdateSettings,
  allowedUsage,
  appliedAnswer,
  elicitAnswer,
  launchSession,
  noteForeground,
  pushHookAnswer,
  styleNames,
  usageAnswer,
  withPushHook,
  PUSH_HOOK,
  type RelayOptions,
} from "../src/wrapper/relay.ts";
import { TurnStore } from "../src/wrapper/turns.ts";
import { elicitInfo, elicitResult } from "../src/elicit.ts";
import { tempDir } from "./helpers.ts";

const FAKE = new URL("./fixtures/fake-claude.mjs", import.meta.url).pathname;
const STREAM_ARGS = ["--output-format", "stream-json", "--input-format", "stream-json"];

type Msg = Record<string, unknown>;

// Collects JSON lines and lets a test wait for one that matches.
class Inbox {
  items: Msg[] = [];
  raw: Buffer[] = [];
  private waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];

  feed(line: Buffer): void {
    this.raw.push(line);
    const m = parseLine(line);
    if (!m) return;
    this.items.push(m);
    for (const w of [...this.waiters]) {
      if (w.pred(m)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
  }

  wait(pred: (m: Msg) => boolean, label: string, ms = 5000): Promise<Msg> {
    const hit = this.items.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`timed out waiting for ${label}`)), ms);
      this.waiters.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m)) });
    });
  }

  has(pred: (m: Msg) => boolean): boolean {
    return this.items.some(pred);
  }
}

class FakeBroker {
  readonly socketPath: string;
  server: net.Server;
  conns: net.Socket[] = [];
  frames = new Inbox();
  answerClaims = true;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
    this.server = net.createServer((sock) => {
      this.conns.push(sock);
      const split = new LineSplitter((line) => {
        const f = parseLine(line);
        if (f?.t === "hello" && f.claim && this.answerClaims) this.send({ t: "claim_ok" });
        this.frames.feed(line);
      });
      sock.on("data", (c: Buffer) => split.push(c));
      sock.on("error", () => {});
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.socketPath, resolve));
  }

  send(frame: Msg): void {
    this.conns.at(-1)?.write(JSON.stringify(frame) + "\n");
  }

  dropConnections(): void {
    for (const c of this.conns) c.destroy();
  }

  close(): Promise<void> {
    this.dropConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

const cleanups: (() => unknown)[] = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

type SetupOptions = {
  broker?: boolean;
  args?: string[];
  claimAckMs?: number;
  claimMaxMs?: number;
  env?: Record<string, string>;
  dirMode?: number;
  relay?: Partial<RelayOptions>;
};

async function setup(opts: SetupOptions = {}) {
  const dir = tempDir();
  if (opts.dirMode !== undefined) fs.chmodSync(dir, opts.dirMode);
  const socketPath = path.join(dir, "link.sock");
  const broker = new FakeBroker(socketPath);
  if (opts.broker !== false) await broker.listen();
  const hostIn = new PassThrough();
  const hostOut = new PassThrough();
  const host = new Inbox();
  const split = new LineSplitter((line) => host.feed(line));
  hostOut.on("data", (c: Buffer) => split.push(c));
  const relay = new Relay({
    claudePath: process.execPath,
    args: [FAKE, ...STREAM_ARGS, ...(opts.args ?? [])],
    cwd: dir,
    env: { ...process.env, ...opts.env },
    socketPath,
    hostIn,
    hostOut,
    log: () => {},
    claimAckMs: opts.claimAckMs ?? 2000,
    claimMaxMs: opts.claimMaxMs,
    retryMs: [50],
    heldElsewhere: () => false,
    ...opts.relay,
  });
  const exited = new Promise<[number | null, string | null]>((resolve) => relay.on("exit", (code, signal) => resolve([code, signal])));
  const started = relay.start();
  const write = (m: Msg) => hostIn.write(JSON.stringify(m) + "\n");
  const user = (text: string) => write({ type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text }] } });
  cleanups.push(async () => {
    hostIn.end();
    await exited;
    await broker.close().catch(() => {});
  });
  return { dir, broker, host, hostIn, relay, exited, started, write, user };
}

const frameOut = (pred: (m: Msg) => boolean) => (f: Msg) => f.t === "out" && pred(f.m as Msg);
const response = (id: string, behavior: string) => ({
  type: "control_response",
  response: { subtype: "success", request_id: id, response: { behavior, toolUseID: "toolu_1" } },
});

test("launchSession reads resume, fork and explicit session arguments", () => {
  assert.deepEqual(launchSession(["--resume=abc"]), { sessionId: "abc", claim: "abc" });
  assert.deepEqual(launchSession(["--resume", "abc"]), { sessionId: "abc", claim: "abc" });
  assert.deepEqual(launchSession(["--resume", "abc", "--fork-session"]), {});
  assert.deepEqual(launchSession(["--session-id", "new"]), { sessionId: "new" });
  assert.deepEqual(launchSession([]), {});
});

test("relays both ways unchanged and copies lines to the broker", async () => {
  const t = await setup();
  const hello = await t.broker.frames.wait((f) => f.t === "hello", "hello");
  assert.equal(hello.v, 1);
  assert.ok((hello.args as string[]).includes("--input-format"));
  t.user("hi");
  const reply = await t.host.wait((m) => m.type === "assistant", "assistant");
  assert.equal((reply.message as { content: { text: string }[] }).content[0].text, "echo: hi");
  await t.broker.frames.wait(frameOut((m) => m.type === "assistant"), "copied assistant");
  await t.broker.frames.wait(frameOut((m) => m.type === "user" && m.isReplay === true), "copied replay");
  assert.ok(!t.broker.frames.has((f) => f.t === "in"), "user lines from VS Code are not copied");
  t.write({ type: "control_request", request_id: "host-1", request: { subtype: "set_model", model: "sonnet" } });
  await t.broker.frames.wait((f) => f.t === "in" && (f.m as Msg).request_id === "host-1", "copied host control request");
});

test("VS Code answers first: the late remote answer is dropped", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  t.user("ASK");
  await t.host.wait((m) => m.type === "control_request", "prompt at VS Code");
  await t.broker.frames.wait(frameOut((m) => m.type === "control_request"), "prompt at broker");
  t.write(response("perm-1", "allow"));
  await t.host.wait((m) => m.type === "answered" && m.behavior === "allow", "CLI got VS Code's answer");
  await t.broker.frames.wait((f) => f.t === "settled" && f.id === "perm-1" && f.by === "host", "settled by host");
  t.broker.send({ t: "to_cli", m: response("perm-1", "deny") });
  await t.broker.frames.wait((f) => f.t === "dropped" && f.id === "perm-1" && f.from === "remote", "remote answer dropped");
  assert.equal(t.host.items.filter((m) => m.type === "answered").length, 1);
});

test("remote answers first: VS Code's prompt is withdrawn and its late answer dropped", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  t.user("ASK");
  await t.broker.frames.wait(frameOut((m) => m.type === "control_request"), "prompt at broker");
  t.broker.send({ t: "to_cli", m: response("perm-1", "allow") });
  await t.host.wait((m) => m.type === "answered" && m.behavior === "allow", "CLI got remote answer");
  await t.host.wait((m) => m.type === "control_cancel_request" && m.request_id === "perm-1", "cancel sent to VS Code");
  await t.broker.frames.wait((f) => f.t === "settled" && f.id === "perm-1" && f.by === "remote", "settled by remote");
  t.write(response("perm-1", "deny"));
  await t.broker.frames.wait((f) => f.t === "dropped" && f.id === "perm-1" && f.from === "host", "VS Code answer dropped");
  t.user("after");
  await t.host.wait((m) => m.type === "assistant", "relay still flows");
  assert.equal(t.host.items.filter((m) => m.type === "answered").length, 1);
});

test("a prompt Claude Code withdraws is settled and cannot be answered", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  t.user("CANCEL");
  await t.broker.frames.wait((f) => f.t === "settled" && f.id === "perm-1" && f.by === "cli", "settled by CLI");
  t.broker.send({ t: "to_cli", m: response("perm-1", "allow") });
  await t.broker.frames.wait((f) => f.t === "dropped" && f.id === "perm-1", "late answer dropped");
});

test("broker control requests are answered to the broker only", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  t.broker.send({ t: "to_cli", m: { type: "control_request", request_id: "ccrc-1", request: { subtype: "get_context_usage" } } });
  const reply = await t.broker.frames.wait((f) => f.t === "reply", "reply");
  assert.equal(((reply.m as Msg).response as Msg).request_id, "ccrc-1");
  t.user("hi");
  await t.host.wait((m) => m.type === "result", "turn done");
  assert.ok(!t.host.has((m) => m.type === "control_response"), "VS Code never sees the broker's responses");
});

test("remote lines other than user messages, broker requests and open prompts are refused", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  t.broker.send({ t: "to_cli", m: { type: "control_request", request_id: "x-1", request: { subtype: "interrupt" } } });
  await t.broker.frames.wait((f) => f.t === "rejected" && f.id === "x-1", "unprefixed request refused");
  t.broker.send({ t: "to_cli", m: { type: "control_request", request_id: "ccrc-2", request: { subtype: "set_permission_mode", mode: "bypassPermissions" } } });
  await t.broker.frames.wait((f) => f.t === "rejected" && f.id === "ccrc-2", "bypass refused");
  t.broker.send({ t: "to_cli", m: response("nope", "allow") });
  await t.broker.frames.wait((f) => f.t === "rejected" && f.id === "nope", "unknown prompt refused");
  t.broker.send({ t: "to_cli", m: { type: "keep_alive" } });
  await t.broker.frames.wait((f) => f.t === "rejected" && f.reason === "unsupported", "unknown type refused");
  t.broker.send({ t: "to_cli", m: { type: "user", uuid: "u-remote", session_id: "", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: "from phone" }] } } });
  await t.host.wait((m) => m.type === "user" && m.uuid === "u-remote" && m.isReplay === true, "remote message shown in VS Code");
  await t.host.wait((m) => m.type === "assistant" && JSON.stringify(m).includes("echo: from phone"), "remote message answered");
});

test("a remote answer that switches the session to bypassPermissions is refused", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  t.user("ASK");
  await t.broker.frames.wait(frameOut((m) => m.type === "control_request"), "prompt at broker");
  const answer = response("perm-1", "allow");
  const updatedPermissions = [{ type: "setMode", mode: "bypassPermissions", destination: "session" }];
  t.broker.send({ t: "to_cli", m: { ...answer, response: { ...answer.response, response: { ...answer.response.response, updatedPermissions } } } });
  await t.broker.frames.wait((f) => f.t === "rejected" && f.id === "perm-1" && f.reason === "mode not allowed", "bypass answer refused");
  t.write(response("perm-1", "deny"));
  await t.host.wait((m) => m.type === "answered", "VS Code still answers the prompt");
  assert.deepEqual(
    t.host.items.filter((m) => m.type === "answered").map((m) => m.behavior),
    ["deny"],
  );
});

test("reconnects to a restarted broker and re-announces state and open prompts", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  t.user("ASK");
  await t.broker.frames.wait(frameOut((m) => m.type === "control_request"), "prompt at broker");
  t.write({ type: "control_request", request_id: "host-2", request: { subtype: "set_permission_mode", mode: "plan" } });
  await t.broker.frames.wait((f) => f.t === "in", "host setting copied");
  t.broker.frames = new Inbox();
  t.broker.dropConnections();
  const hello = await t.broker.frames.wait((f) => f.t === "hello", "hello again");
  assert.ok(typeof hello.sessionId === "string" && hello.sessionId.length > 0, "hello names the session");
  assert.equal(hello.claim, undefined);
  await t.broker.frames.wait((f) => f.t === "spawned", "child pid re-sent");
  await t.broker.frames.wait(frameOut((m) => m.type === "system" && m.subtype === "init"), "init re-sent");
  await t.broker.frames.wait((f) => f.t === "in" && ((f.m as Msg).request as Msg).mode === "plan", "host setting re-sent");
  await t.broker.frames.wait(frameOut((m) => m.type === "control_request" && m.request_id === "perm-1"), "open prompt re-sent");
  t.broker.send({ t: "to_cli", m: response("perm-1", "allow") });
  await t.host.wait((m) => m.type === "answered", "answer after reconnect reaches the CLI");
});

test("a reconnecting broker gets the latest list of background tasks again", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  t.user("BGTASKS");
  const listed = (m: Msg) => m.subtype === "background_tasks_changed" && (m.tasks as unknown[]).length === 2;
  await t.broker.frames.wait(frameOut(listed), "list shared");
  t.broker.frames = new Inbox();
  t.broker.dropConnections();
  await t.broker.frames.wait((f) => f.t === "hello", "hello again");
  await t.broker.frames.wait(frameOut(listed), "latest list re-sent");
  assert.equal(t.broker.frames.items.filter((f) => f.t === "out" && (f.m as Msg).subtype === "background_tasks_changed").length, 1);
});

test("a reconnecting broker gets the latest command list Claude Code pushed again, after its initialize answer", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  t.write({ type: "control_request", request_id: "init-1", request: { subtype: "initialize" } });
  await t.broker.frames.wait(frameOut((m) => m.type === "control_response" && JSON.stringify(m).includes('"models"')), "initialize answer shared");
  t.user("COMMANDS");
  const latest = (m: Msg) => m.subtype === "commands_changed" && JSON.stringify(m.commands).includes("skill-2");
  await t.broker.frames.wait(frameOut(latest), "list shared");
  t.broker.frames = new Inbox();
  t.broker.dropConnections();
  await t.broker.frames.wait((f) => f.t === "hello", "hello again");
  await t.broker.frames.wait(frameOut(latest), "latest list re-sent");
  const outs = t.broker.frames.items.filter((f) => f.t === "out").map((f) => f.m as Msg);
  assert.equal(outs.filter((m) => m.subtype === "commands_changed").length, 1, "only the latest list");
  const answer = outs.findIndex((m) => m.type === "control_response");
  assert.ok(answer !== -1 && answer < outs.findIndex(latest), "the initialize answer comes before the pushed list");
});

test("claim: waits for claim_ok before starting Claude Code", async () => {
  const dir = tempDir();
  const socketPath = path.join(dir, "link.sock");
  const broker = new FakeBroker(socketPath);
  broker.answerClaims = false;
  await broker.listen();
  const hostIn = new PassThrough();
  const hostOut = new PassThrough();
  const relay = new Relay({
    claudePath: process.execPath,
    args: [FAKE, ...STREAM_ARGS, "--resume", "aaaa"],
    cwd: dir,
    env: process.env,
    socketPath,
    hostIn,
    hostOut,
    log: () => {},
    claimAckMs: 2000,
    retryMs: [50],
  });
  const exited = new Promise((resolve) => relay.on("exit", resolve));
  void relay.start();
  await broker.frames.wait((f) => f.t === "hello" && f.claim === "aaaa", "hello with claim");
  broker.send({ t: "claim_wait", ms: 4000 });
  await new Promise((r) => setTimeout(r, 2500));
  assert.ok(!broker.frames.has((f) => f.t === "spawned"), "not started while the broker hands over");
  broker.send({ t: "claim_ok" });
  await broker.frames.wait((f) => f.t === "spawned", "started after claim_ok");
  hostIn.end();
  await exited;
  await broker.close();
});

test("claim: starts anyway when the broker does not acknowledge in time", async () => {
  const t = await setup({ args: ["--resume", "bbbb"], claimAckMs: 300 });
  t.broker.answerClaims = false;
  await t.started;
  await t.broker.frames.wait((f) => f.t === "spawned", "started without claim_ok");
});

test("works without a broker and connects once one appears", async () => {
  const t = await setup({ broker: false, args: ["--resume", "cccc"] });
  await t.started;
  t.user("hi");
  await t.host.wait((m) => m.type === "assistant", "relay works with no broker");
  await t.broker.listen();
  const hello = await t.broker.frames.wait((f) => f.t === "hello", "late hello", 3000);
  assert.equal(hello.claim, undefined, "no hand-over once Claude Code runs");
  assert.equal(hello.sessionId, "cccc");
});

test("long lines pass intact to VS Code and the broker", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  t.user("BIG");
  const m = await t.host.wait((x) => x.type === "assistant", "big line", 10_000);
  assert.equal((m.message as { content: { text: string }[] }).content[0].text.length, 3_000_000);
  const f = await t.broker.frames.wait(frameOut((x) => x.type === "assistant"), "big frame", 10_000);
  assert.equal(((f.m as Msg).message as { content: { text: string }[] }).content[0].text.length, 3_000_000);
});

test("exits with Claude Code's status after VS Code closes its input", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  t.hostIn.end();
  const [code, signal] = await t.exited;
  assert.equal(code, 0);
  assert.equal(signal, null);
  await t.broker.frames.wait((f) => f.t === "exit" && f.code === 0, "exit reported");
});

test("the exit report says whether VS Code ended Claude Code and whether a turn was under way", async () => {
  const crashed = await setup();
  await crashed.broker.frames.wait((f) => f.t === "hello", "hello");
  crashed.user("ok");
  await crashed.host.wait((m) => m.type === "result", "a first turn");
  crashed.user("CRASH");
  assert.deepEqual(await crashed.exited, [1, null]);
  const a = await crashed.broker.frames.wait((f) => f.t === "exit", "exit after the crash");
  assert.deepEqual([a.code, a.signal, a.hostLeft, a.running], [1, null, false, true]);

  const left = await setup({ env: { FAKE_EXIT_CODE: "1" } });
  await left.broker.frames.wait((f) => f.t === "hello", "hello");
  left.user("HOLD");
  await left.host.wait((m) => m.type === "user" && m.isReplay === true, "turn started");
  left.hostIn.end();
  await left.exited;
  const b = await left.broker.frames.wait((f) => f.t === "exit", "exit after VS Code left");
  assert.deepEqual([b.code, b.hostLeft, b.running], [1, true, true]);
});

test("only the conversation, prompts and settings reach the broker", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  t.write({ type: "control_request", request_id: "oauth-1", request: { subtype: "claude_oauth_callback", authorizationCode: "secret" } });
  await t.host.wait((m) => m.type === "control_response" && (m.response as Msg).request_id === "oauth-1", "CLI answered VS Code");
  t.write({ type: "control_request", request_id: "init-1", request: { subtype: "initialize" } });
  await t.broker.frames.wait(frameOut((m) => m.type === "control_response" && JSON.stringify(m).includes('"models"')), "initialize answer shared");
  t.user("MCP");
  await t.host.wait((m) => m.type === "control_request" && m.request_id === "mcp-1", "MCP request at VS Code");
  t.user("hi");
  await t.broker.frames.wait(frameOut((m) => m.type === "result"), "turn copied");
  const seen = JSON.stringify(t.broker.frames.items);
  assert.ok(!seen.includes("secret") && !seen.includes("oauth-1"), "VS Code's other control traffic stays private");
  assert.ok(!seen.includes("mcp-1"), "Claude Code's requests to VS Code's own tools stay private");
});

test("broker control requests are limited to the ones it needs", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  t.broker.send({ t: "to_cli", m: { type: "control_request", request_id: "ccrc-a", request: { subtype: "mcp_set_servers", servers: {} } } });
  await t.broker.frames.wait((f) => f.t === "rejected" && f.id === "ccrc-a", "other subtypes refused");
  t.broker.send({ t: "to_cli", m: { type: "control_request", request_id: "ccrc-b", request: { subtype: "apply_flag_settings", settings: { model: "x" } } } });
  await t.broker.frames.wait((f) => f.t === "rejected" && f.id === "ccrc-b", "settings other than effort refused");
  t.broker.send({ t: "to_cli", m: { type: "control_request", request_id: "ccrc-c", request: { subtype: "apply_flag_settings", settings: { effortLevel: "low" } } } });
  await t.broker.frames.wait((f) => f.t === "reply" && ((f.m as Msg).response as Msg).request_id === "ccrc-c", "effort allowed");
  t.broker.send({ t: "to_cli", m: { type: "control_request", request_id: "ccrc-d", request: { subtype: "apply_flag_settings", settings: { effortLevel: "high", ultracode: true } } } });
  await t.broker.frames.wait((f) => f.t === "reply" && ((f.m as Msg).response as Msg).request_id === "ccrc-d", "effort with ultracode allowed");
  t.broker.send({ t: "to_cli", m: { type: "control_request", request_id: "ccrc-e", request: { subtype: "apply_flag_settings", settings: { ultracode: "yes" } } } });
  await t.broker.frames.wait((f) => f.t === "rejected" && f.id === "ccrc-e", "invalid ultracode value refused");
});

test("apply_flag_settings from the broker allows only effort and ultracode with valid values", () => {
  for (const ok of [{ effortLevel: "low" }, { effortLevel: "max", ultracode: true }, { ultracode: true }, { ultracode: null }, { ultracode: false }]) {
    assert.ok(allowedFlagSettings(ok), JSON.stringify(ok));
  }
  const bad: unknown[] = [
    {},
    null,
    [],
    "x",
    { effortLevel: "ultracode" },
    { effortLevel: "auto" },
    { effortLevel: 3 },
    { ultracode: "on" },
    { model: "opus" },
    { effortLevel: "low", model: "opus" },
    { ultracode: true, env: { A: "1" } },
  ];
  for (const b of bad) assert.ok(!allowedFlagSettings(b), JSON.stringify(b));
});

test("the broker may also turn fast mode on or off for the session, and set Thinking to a budget, off or back", () => {
  for (const ok of [{ fastMode: true }, { fastMode: false }, { fastMode: null }, { effortLevel: "high", fastMode: true }]) assert.ok(allowedFlagSettings(ok), JSON.stringify(ok));
  for (const bad of [{ fastMode: "on" }, { fastMode: true, model: "opus" }, { alwaysThinkingEnabled: false }, { viewMode: "focus" }, { fastModePerSessionOptIn: false }]) {
    assert.ok(!allowedFlagSettings(bad), JSON.stringify(bad));
  }
  for (const ok of [0, 31999, null, 1024, 128_000]) assert.ok(allowedThinking({ subtype: "set_max_thinking_tokens", max_thinking_tokens: ok }), String(ok));
  const bad: Msg[] = [
    {},
    { max_thinking_tokens: -1 },
    { max_thinking_tokens: 500 },
    { max_thinking_tokens: 128_001 },
    { max_thinking_tokens: 2048.5 },
    { max_thinking_tokens: "0" },
    { max_thinking_tokens: 0, thinking_display: "highlights" },
  ];
  for (const b of bad) assert.ok(!allowedThinking({ subtype: "set_max_thinking_tokens", ...b }), JSON.stringify(b));
});

test("Thinking changes from either side reach Claude Code, and a reconnecting broker gets the latest; the hello names what passes", async () => {
  const t = await setup();
  const hello = await t.broker.frames.wait((f) => f.t === "hello", "hello");
  assert.deepEqual(hello.caps, ["fast_mode", "thinking", "claude_push", "background_tasks", "workspace_diff", "side_question", "usage_causes", "user_dialogs", "mcp_auth", "hand_over", "claim_notice"]);
  const request = (id: string, r: Msg) => t.broker.send({ t: "to_cli", m: { type: "control_request", request_id: id, request: r } });
  const replied = (id: string) => (f: Msg) => f.t === "reply" && ((f.m as Msg).response as Msg).request_id === id;
  const thinking = (f: Msg) => f.t === "in" && ((f.m as Msg).request as Msg)?.subtype === "set_max_thinking_tokens";
  request("ccrc-th-bad", { subtype: "set_max_thinking_tokens", max_thinking_tokens: 0, thinking_display: "highlights" });
  await t.broker.frames.wait((f) => f.t === "rejected" && f.id === "ccrc-th-bad" && f.reason === "invalid request", "a display change refused");
  request("ccrc-fast", { subtype: "apply_flag_settings", settings: { fastMode: true } });
  await t.broker.frames.wait(replied("ccrc-fast"), "fast mode answered");
  t.write({ type: "control_request", request_id: "vs-th", request: { subtype: "set_max_thinking_tokens", max_thinking_tokens: 31999, thinking_display: "summarized" } });
  await t.broker.frames.wait((f) => thinking(f) && (f.m as Msg).request_id === "vs-th", "VS Code's change copied");
  request("ccrc-th", { subtype: "set_max_thinking_tokens", max_thinking_tokens: 0 });
  await t.broker.frames.wait(replied("ccrc-th"), "the broker's change answered");
  assert.ok(!t.host.has((m) => m.type === "control_response" && String((m.response as Msg).request_id).startsWith("ccrc-")), "VS Code sees none of the answers");
  t.broker.frames = new Inbox();
  t.broker.dropConnections();
  await t.broker.frames.wait((f) => f.t === "hello", "hello again");
  const again = await t.broker.frames.wait(thinking, "the latest Thinking again");
  assert.equal((again.m as Msg).request_id, "ccrc-th", "the broker's change came last");
  await t.broker.frames.wait(frameOut((m) => m.type === "system" && m.subtype === "init"), "the rest of the state");
  assert.equal(t.broker.frames.items.filter(thinking).length, 1);
});

test("only the applied part of VS Code's get_settings answers reaches the broker, and VS Code gets the whole answer", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  t.write({ type: "control_request", request_id: "gs-1", request: { subtype: "get_settings" } });
  const whole = await t.host.wait((m) => m.type === "control_response" && (m.response as Msg).request_id === "gs-1", "VS Code's answer");
  assert.ok(JSON.stringify(whole).includes("s3cret"), "VS Code sees the full answer");
  const f = await t.broker.frames.wait(frameOut((m) => m.type === "control_response" && JSON.stringify(m).includes('"applied"')), "applied shared");
  assert.deepEqual(((f.m as Msg).response as Msg).response, {
    applied: { model: "claude-haiku-5-5", effort: "medium", ultracode: false, ultracodeAvailable: true },
  });
  t.user("hi");
  await t.broker.frames.wait(frameOut((m) => m.type === "result"), "turn copied");
  const seen = JSON.stringify(t.broker.frames.items);
  assert.ok(!seen.includes("s3cret") && !seen.includes("hook-cmd") && !seen.includes("ultracodeRequested"), "effective, sources and the rest stay private");
  assert.ok(!t.broker.frames.has((x) => x.t === "in"), "VS Code's get_settings request is not copied");
});

test("a reconnecting broker gets the last applied settings again", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  t.write({ type: "control_request", request_id: "gs-2", request: { subtype: "get_settings" } });
  await t.broker.frames.wait(frameOut((m) => JSON.stringify(m).includes('"applied"')), "applied shared");
  t.broker.frames = new Inbox();
  t.broker.dropConnections();
  await t.broker.frames.wait((f) => f.t === "hello", "hello again");
  const f = await t.broker.frames.wait(frameOut((m) => JSON.stringify(m).includes('"applied"')), "applied re-announced");
  assert.ok(!JSON.stringify(f).includes("s3cret"));
});

test("the broker's get_settings is answered with the applied part only", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  t.broker.send({ t: "to_cli", m: { type: "control_request", request_id: "ccrc-gs", request: { subtype: "get_settings" } } });
  const f = await t.broker.frames.wait((x) => x.t === "reply" && ((x.m as Msg).response as Msg).request_id === "ccrc-gs", "reply");
  assert.deepEqual(((f.m as Msg).response as Msg).response, {
    applied: { model: "claude-haiku-5-5", effort: "medium", ultracode: false, ultracodeAvailable: true },
  });
  assert.ok(!JSON.stringify(t.broker.frames.items).includes("s3cret"));
  assert.ok(!t.host.has((m) => m.type === "control_response"), "VS Code does not see the broker's answer");
});

test("the broker's get_usage is answered with the limit windows and session totals only", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  t.broker.send({ t: "to_cli", m: { type: "control_request", request_id: "ccrc-gu", request: { subtype: "get_usage", skip_behaviors: true } } });
  const f = await t.broker.frames.wait((x) => x.t === "reply" && ((x.m as Msg).response as Msg).request_id === "ccrc-gu", "reply");
  assert.deepEqual(((f.m as Msg).response as Msg).response, {
    session: { total_cost_usd: 0.25, total_duration_ms: 4000, total_api_duration_ms: 900, total_lines_added: 3, total_lines_removed: 1 },
    rate_limits: {
      five_hour: { utilization: 32, resets_at: "2026-10-14T05:19:59Z" },
      seven_day: { utilization: 91, resets_at: "2026-10-17T12:59:59Z" },
      model_scoped: [{ display_name: "Fable", utilization: 0, resets_at: "2026-10-17T13:00:00Z" }],
    },
  });
  const seen = JSON.stringify(t.broker.frames.items);
  for (const leak of ["s3cret", "extra_usage", "subscription_type", "model_usage", "behaviors"]) assert.ok(!seen.includes(leak), leak);
  assert.ok(!t.host.has((m) => m.type === "control_response"), "VS Code does not see the broker's answer");
});

test("the broker's get_usage without skip_behaviors gets the causes of usage, names and shares only", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  t.broker.send({ t: "to_cli", m: { type: "control_request", request_id: "ccrc-gc", request: { subtype: "get_usage" } } });
  const f = await t.broker.frames.wait((x) => x.t === "reply" && ((x.m as Msg).response as Msg).request_id === "ccrc-gc", "reply");
  const answer = ((f.m as Msg).response as Msg).response as Msg;
  assert.deepEqual(answer.behaviors, {
    day: {
      request_count: 12,
      session_count: 2,
      behaviors: [
        { key: "cache_miss", pct: 34, count: 5 },
        { key: "brand_new_trait", pct: 12, count: 1 },
      ],
      agents: [{ name: "general-purpose", pct: 40 }],
      skills: [],
      plugins: [],
      mcp_servers: [{ name: "github", pct: 11 }],
    },
    week: { request_count: 80, session_count: 9, behaviors: [{ key: "long_context", pct: 61, count: 40 }], agents: [], skills: [{ name: "dataviz", pct: 3 }], plugins: [], mcp_servers: [] },
  });
  const seen = JSON.stringify(t.broker.frames.items);
  for (const leak of ["s3cret", "not a key", "subscription_type", "model_usage"]) assert.ok(!seen.includes(leak), leak);
});

test("get_usage from the broker asks with or without the causes, nothing else", async () => {
  for (const ok of [{}, { skip_behaviors: true }, { skip_behaviors: false }]) assert.ok(allowedUsage({ subtype: "get_usage", ...ok }), JSON.stringify(ok));
  for (const bad of [{ skip_behaviors: "yes" }, { skip_behaviors: 1 }, { since: "2026-10-01" }, { skip_behaviors: true, project: "x" }]) {
    assert.ok(!allowedUsage({ subtype: "get_usage", ...bad }), JSON.stringify(bad));
  }
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  t.broker.send({ t: "to_cli", m: { type: "control_request", request_id: "ccrc-gx", request: { subtype: "get_usage", project: "/home/user" } } });
  await t.broker.frames.wait((f) => f.t === "rejected" && f.id === "ccrc-gx", "a get_usage with other keys refused");
});

test("a get_usage answer keeps only an error's message", () => {
  const err = JSON.parse(usageAnswer({ type: "control_response", response: { subtype: "error", request_id: "r", error: "no", rate_limits: { x: 1 } } }).toString());
  assert.deepEqual(err, { type: "control_response", response: { subtype: "error", request_id: "r", error: "no" } });
});

test("a get_settings answer is reduced to plain applied values, and an error keeps only its message", () => {
  const ok = JSON.parse(
    appliedAnswer({
      type: "control_response",
      response: { subtype: "success", request_id: "r", response: { applied: { model: { x: 1 }, effort: null, ultracode: true, extra: "y" }, effective: { env: {} } } },
    }).toString(),
  );
  assert.deepEqual(ok, { type: "control_response", response: { subtype: "success", request_id: "r", response: { applied: { effort: null, ultracode: true } } } });
  const err = JSON.parse(appliedAnswer({ type: "control_response", response: { subtype: "error", request_id: "r", error: "nope", pending: { env: {} } } }).toString());
  assert.deepEqual(err, { type: "control_response", response: { subtype: "error", request_id: "r", error: "nope" } });
});

test("update_settings from the broker only sets the project's output style to a listed style", () => {
  const styles = ["default", "Explanatory", "my style"];
  const req = (r: Msg) => ({ subtype: "update_settings", ...r });
  for (const style of styles) assert.ok(allowedUpdateSettings(req({ source: "localSettings", settings: { outputStyle: style } }), styles), style);
  const bad: Msg[] = [
    { source: "localSettings", settings: { outputStyle: "Unlisted" } },
    { source: "localSettings", settings: { outputStyle: "default", model: "opus" } },
    { source: "localSettings", settings: { permissions: { allow: ["Bash"] } } },
    { source: "localSettings", settings: { hooks: {} } },
    { source: "localSettings", settings: { outputStyle: 1 } },
    { source: "localSettings", settings: {} },
    { source: "localSettings", settings: null },
    { source: "localSettings", settings: ["outputStyle"] },
    { source: "localSettings" },
    { source: "userSettings", settings: { outputStyle: "default" } },
    { source: "userSettings", settings: { effortLevel: "high" } },
    { source: "projectSettings", settings: { outputStyle: "default" } },
    { source: "localSettings", settings: { outputStyle: "default" }, extra: true },
  ];
  for (const b of bad) assert.ok(!allowedUpdateSettings(req(b), styles), JSON.stringify(b));
  assert.ok(!allowedUpdateSettings(req({ source: "localSettings", settings: { outputStyle: "default" } }), undefined), "no list yet");
});

test("style names keep plain non-empty strings", () => {
  assert.deepEqual(styleNames(["default", "", 3, null, "x".repeat(201), "Learning"]), ["default", "Learning"]);
  assert.equal(styleNames("default"), undefined);
  assert.equal(styleNames(Array.from({ length: 150 }, (_, i) => `s${i}`))?.length, 100);
});

test("a get_settings answer passes on the effective output style and the listed styles, nothing else of the settings", () => {
  const msg = {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "r",
      response: { applied: { effort: "low" }, effective: { outputStyle: "Explanatory", env: { A: "s3cret" }, hooks: {} }, sources: [{ settings: { outputStyle: "x" } }] },
    },
  };
  const out = JSON.parse(appliedAnswer(msg, ["default", "Explanatory"]).toString());
  assert.deepEqual(out.response.response, { applied: { effort: "low" }, outputStyle: "Explanatory", outputStyles: ["default", "Explanatory"] });
  const odd = JSON.parse(
    appliedAnswer({ type: "control_response", response: { subtype: "success", request_id: "r", response: { applied: {}, effective: { outputStyle: { x: 1 } } } } }).toString(),
  );
  assert.deepEqual(odd.response.response, { applied: {} });
});

test("the broker sets the output style through the wrapper once Claude Code has listed the styles", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  const request = (id: string, r: Msg) => t.broker.send({ t: "to_cli", m: { type: "control_request", request_id: id, request: r } });
  const replied = (id: string) => (f: Msg) => f.t === "reply" && ((f.m as Msg).response as Msg).request_id === id;
  const set = (id: string, outputStyle: unknown, source = "localSettings") => request(id, { subtype: "update_settings", source, settings: { outputStyle } });
  set("ccrc-early", "Explanatory");
  await t.broker.frames.wait((f) => f.t === "rejected" && f.id === "ccrc-early" && f.reason === "setting not allowed", "refused before the list is known");
  t.write({ type: "control_request", request_id: "init-1", request: { subtype: "initialize" } });
  await t.host.wait((m) => m.type === "control_response" && (m.response as Msg).request_id === "init-1", "initialize answered");
  set("ccrc-unknown", "Pirate");
  set("ccrc-user", "Explanatory", "userSettings");
  request("ccrc-more", { subtype: "update_settings", source: "localSettings", settings: { outputStyle: "Explanatory", permissions: { allow: ["Bash(*)"] } } });
  for (const id of ["ccrc-unknown", "ccrc-user", "ccrc-more"]) {
    await t.broker.frames.wait((f) => f.t === "rejected" && f.id === id && f.reason === "setting not allowed", id);
  }
  set("ccrc-ok", "Explanatory");
  const f = await t.broker.frames.wait(replied("ccrc-ok"), "style set");
  assert.deepEqual(((f.m as Msg).response as Msg).response, {});
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(t.dir, ".claude/settings.local.json"), "utf8")), { outputStyle: "Explanatory" });
  request("ccrc-gs", { subtype: "get_settings" });
  const g = await t.broker.frames.wait(replied("ccrc-gs"), "settings read");
  assert.deepEqual(((g.m as Msg).response as Msg).response, {
    applied: { model: "claude-haiku-5-5", effort: "medium", ultracode: false, ultracodeAvailable: true },
    outputStyle: "Explanatory",
    outputStyles: ["default", "Proactive", "Concise", "Explanatory", "Learning"],
  });
  assert.ok(!JSON.stringify(t.broker.frames.items).includes("s3cret"));
  assert.ok(!t.host.has((m) => m.type === "control_response" && String((m.response as Msg).request_id).startsWith("ccrc-")), "VS Code sees none of the answers");
});

test("the session controls reach Claude Code; MCP setup, settings and conversation rewind do not", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  const request = (id: string, r: Msg) => t.broker.send({ t: "to_cli", m: { type: "control_request", request_id: id, request: r } });
  const replied = (id: string) => (f: Msg) => f.t === "reply" && ((f.m as Msg).response as Msg).request_id === id;
  const allowed: Msg[] = [
    { subtype: "get_context_usage", detail: "full" },
    { subtype: "mcp_status" },
    { subtype: "mcp_toggle", serverName: "github", enabled: false },
    { subtype: "mcp_reconnect", serverName: "github" },
    { subtype: "rewind_files", user_message_id: "6a1f3c2e-8b4d-4e5f-9a0b-1c2d3e4f5a6b", dry_run: true },
    { subtype: "stop_task", task_id: "b1" },
    { subtype: "get_task_output", task_id: "b1" },
  ];
  allowed.forEach((r, i) => request(`ccrc-ok-${i}`, r));
  for (const [i, r] of allowed.entries()) await t.broker.frames.wait(replied(`ccrc-ok-${i}`), String(r.subtype));
  const refused = [
    "mcp_set_servers",
    "mcp_clear_auth",
    "mcp_read_resource",
    "set_mcp_permission_mode_override",
    "rewind_conversation",
    "initialize",
  ];
  for (const subtype of refused) request(`ccrc-no-${subtype}`, { subtype });
  for (const subtype of refused) {
    await t.broker.frames.wait((f) => f.t === "rejected" && f.id === `ccrc-no-${subtype}` && f.reason === "request not allowed", `${subtype} refused`);
  }
  request("ccrc-last", { subtype: "mcp_status" });
  await t.broker.frames.wait(replied("ccrc-last"), "a later request");
  const leaked = t.broker.frames.has((f) => f.t === "reply" && String(((f.m as Msg).response as Msg).request_id).startsWith("ccrc-no-"));
  assert.ok(!leaked, "refused requests never reach Claude Code");
  assert.ok(!t.host.has((m) => m.type === "control_response"), "VS Code sees none of the answers");
});

test("read_file reaches Claude Code only with a path, a size up to 10MB and a known encoding", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  const request = (id: string, r: Msg) => t.broker.send({ t: "to_cli", m: { type: "control_request", request_id: id, request: r } });
  fs.writeFileSync(path.join(t.dir, "notes.md"), "# notes");
  request("ccrc-read-ok", { subtype: "read_file", path: "notes.md", max_bytes: 10_000_000, encoding: "base64" });
  const reply = await t.broker.frames.wait((f) => f.t === "reply" && ((f.m as Msg).response as Msg).request_id === "ccrc-read-ok", "read_file answered");
  assert.equal(Buffer.from(String((((reply.m as Msg).response as Msg).response as Msg).contents), "base64").toString(), "# notes");
  const bad: Msg[] = [
    { subtype: "read_file" },
    { subtype: "read_file", path: "" },
    { subtype: "read_file", path: 7 },
    { subtype: "read_file", path: "a", max_bytes: 10_000_001 },
    { subtype: "read_file", path: "a", max_bytes: "1" },
    { subtype: "read_file", path: "a", encoding: "latin1" },
    { subtype: "read_file", path: "a", anchor: { type: "repo", repo: "x/y" } },
  ];
  bad.forEach((r, i) => request(`ccrc-read-bad-${i}`, r));
  for (const i of bad.keys()) await t.broker.frames.wait((f) => f.t === "rejected" && f.id === `ccrc-read-bad-${i}` && f.reason === "invalid request", `bad read_file ${i}`);
  assert.ok(!t.host.has((m) => m.type === "control_response"), "VS Code sees none of the answers");
});

test("get_task_output reaches Claude Code only with a task id, and its answer comes back as Claude Code gave it", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  const request = (id: string, r: Msg) => t.broker.send({ t: "to_cli", m: { type: "control_request", request_id: id, request: r } });
  request("ccrc-out", { subtype: "get_task_output", task_id: "b7" });
  const reply = await t.broker.frames.wait((f) => f.t === "reply" && ((f.m as Msg).response as Msg).request_id === "ccrc-out", "output answered");
  const output = '\u001b[32mb7\u001b[0m "applied": {"rate_limits": 1}\n';
  assert.deepEqual(((reply.m as Msg).response as Msg).response, { output, total_bytes: Buffer.byteLength(output), truncated: false });
  const bad: Msg[] = [
    { subtype: "get_task_output" },
    { subtype: "get_task_output", task_id: "" },
    { subtype: "get_task_output", task_id: 7 },
    { subtype: "get_task_output", task_id: "../b7" },
    { subtype: "get_task_output", task_id: "b".repeat(65) },
    { subtype: "get_task_output", task_id: "b7", path: "/etc/passwd" },
  ];
  bad.forEach((r, i) => request(`ccrc-out-bad-${i}`, r));
  for (const i of bad.keys()) await t.broker.frames.wait((f) => f.t === "rejected" && f.id === `ccrc-out-bad-${i}` && f.reason === "invalid request", `bad get_task_output ${i}`);
  assert.ok(!t.host.has((m) => m.type === "control_response"), "VS Code sees none of the answers");
  assert.ok(allowedTaskOutput({ subtype: "get_task_output", task_id: "a_B-9" }));
  assert.ok(!allowedTaskOutput({ subtype: "get_task_output", task_id: "b 7" }));
});

test("background_tasks reaches Claude Code only for a call it runs in the foreground now, named by its id", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  const request = (id: string, r: Msg) => t.broker.send({ t: "to_cli", m: { type: "control_request", request_id: id, request: r } });
  const refused = (id: string, reason: string) => t.broker.frames.wait((f) => f.t === "rejected" && f.id === id && f.reason === reason, `${id} refused: ${reason}`);
  request("ccrc-bg-early", { subtype: "background_tasks", tool_use_id: "toolu_fg" });
  await refused("ccrc-bg-early", "not running");
  t.user("FGBASH");
  await t.broker.frames.wait(frameOut((m) => m.subtype === "task_started"), "the foreground call listed");
  const bad: Msg[] = [
    { subtype: "background_tasks" },
    { subtype: "background_tasks", tool_use_id: "" },
    { subtype: "background_tasks", tool_use_id: 7 },
    { subtype: "background_tasks", tool_use_id: "toolu/fg" },
    { subtype: "background_tasks", tool_use_id: "toolu_fg", task_id: "bfg" },
  ];
  bad.forEach((r, i) => request(`ccrc-bg-bad-${i}`, r));
  for (const i of bad.keys()) await refused(`ccrc-bg-bad-${i}`, "invalid request");
  request("ccrc-bg-other", { subtype: "background_tasks", tool_use_id: "toolu_other" });
  await refused("ccrc-bg-other", "not running");
  request("ccrc-bg", { subtype: "background_tasks", tool_use_id: "toolu_fg" });
  const reply = await t.broker.frames.wait((f) => f.t === "reply" && ((f.m as Msg).response as Msg).request_id === "ccrc-bg", "moved");
  assert.deepEqual(((reply.m as Msg).response as Msg).response, { backgrounded: true });
  await t.broker.frames.wait(frameOut((m) => m.subtype === "task_updated"), "moved to the background");
  request("ccrc-bg-again", { subtype: "background_tasks", tool_use_id: "toolu_fg" });
  await refused("ccrc-bg-again", "not running");
  assert.ok(!t.broker.frames.has((f) => f.t === "reply" && String(((f.m as Msg).response as Msg).request_id).startsWith("ccrc-bg-")), "refused requests never reach Claude Code");
  assert.ok(!t.host.has((m) => m.type === "control_response"), "VS Code sees none of the answers");
  assert.ok(t.host.has((m) => m.type === "system" && m.subtype === "task_updated"), "VS Code sees the move");
});

test("the calls running in the foreground follow Claude Code's task events", () => {
  const calls = new Map<string, string>();
  const started = (id: string, extra: Msg) => noteForeground(calls, { type: "system", subtype: "task_started", task_id: id, ...extra });
  started("b1", { task_type: "local_bash", tool_use_id: "toolu_1", is_backgrounded: false });
  started("a1", { task_type: "local_agent", tool_use_id: "toolu_2", is_backgrounded: false });
  started("b2", { task_type: "local_bash", tool_use_id: "toolu_3", is_backgrounded: true });
  started("w1", { task_type: "local_workflow", tool_use_id: "toolu_4", is_backgrounded: false });
  started("m1", { task_type: "monitor_mcp", tool_use_id: "toolu_5", is_backgrounded: false });
  started("b3", { task_type: "local_bash", tool_use_id: "toolu_6", is_backgrounded: false, skip_transcript: true });
  started("b4", { task_type: "local_bash", is_backgrounded: false });
  assert.deepEqual([...calls], [["b1", "toolu_1"], ["a1", "toolu_2"]]);
  noteForeground(calls, { type: "system", subtype: "task_updated", task_id: "b1", patch: { is_backgrounded: true } });
  noteForeground(calls, { type: "system", subtype: "task_updated", task_id: "a1", patch: { tokens: 3 } });
  assert.deepEqual([...calls], [["a1", "toolu_2"]]);
  noteForeground(calls, { type: "system", subtype: "task_updated", task_id: "a1", patch: { status: "killed" } });
  assert.equal(calls.size, 0);
  started("b5", { task_type: "local_bash", tool_use_id: "toolu_7", is_backgrounded: false });
  noteForeground(calls, { type: "system", subtype: "task_notification", task_id: "b5", status: "completed" });
  assert.equal(calls.size, 0);
  for (let n = 0; n < 150; n++) started(`b${n}x`, { task_type: "local_bash", tool_use_id: `toolu_${n}x`, is_backgrounded: false });
  assert.equal(calls.size, 100);
  assert.ok(allowedBackground({ subtype: "background_tasks", tool_use_id: "toolu_01AbC-9_z" }));
  assert.ok(!allowedBackground({ subtype: "background_tasks" }));
});

test("a broker request after VS Code closed its input is refused by id", async () => {
  const t = await setup({ env: { FAKE_LINGER_MS: "1500" } });
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  t.hostIn.end();
  await new Promise((r) => setTimeout(r, 100));
  t.broker.send({ t: "to_cli", m: { type: "control_request", request_id: "ccrc-late", request: { subtype: "interrupt" } } });
  await t.broker.frames.wait((f) => f.t === "rejected" && f.id === "ccrc-late" && f.reason === "closed", "refused with its id");
});

test("claim: repeated claim_wait cannot hold Claude Code back past the overall limit", async () => {
  const t = await setup({ args: ["--resume", "dddd"], claimMaxMs: 600 });
  t.broker.answerClaims = false;
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  const timer = setInterval(() => t.broker.send({ t: "claim_wait", ms: 5000 }), 100);
  const t0 = Date.now();
  await t.broker.frames.wait((f) => f.t === "spawned", "started at the limit");
  clearInterval(timer);
  assert.ok(Date.now() - t0 < 1500, `started after ${Date.now() - t0} ms`);
});

test("claim: a session still held elsewhere starts as a copy", async () => {
  const t = await setup({ args: ["--resume", "eeee"] });
  t.broker.answerClaims = false;
  await t.broker.frames.wait((f) => f.t === "hello" && f.claim === "eeee", "hello with claim");
  t.broker.send({ t: "claim_ok", fork: true });
  const init = await t.broker.frames.wait(frameOut((m) => m.type === "system" && m.subtype === "init"), "init of the copy");
  const m = init.m as Msg;
  assert.ok((m.args as string[]).includes("--fork-session"));
  assert.notEqual(m.session_id, "eeee");
});

const initialize = (t: { write: (m: Msg) => void }) => t.write({ type: "control_request", request_id: "init-1", request: { subtype: "initialize" } });
const isNotice = (m: Msg) => m.type === "system" && m.subtype === "informational";
const asked = (file: string) =>
  fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Msg);

test("claim: a copy is renamed as the broker says once VS Code's initialize reached Claude Code, and VS Code shows the broker's notice after the answer", async () => {
  const requests = path.join(tempDir(), "requests.jsonl");
  const t = await setup({ args: ["--resume", "eeef"], env: { FAKE_REQUESTS: requests } });
  t.broker.answerClaims = false;
  await t.broker.frames.wait((f) => f.t === "hello" && f.claim === "eeef", "hello with claim");
  initialize(t);
  t.broker.send({ t: "claim_ok", fork: true, title: "(복사본) 인보이스 내보내기", notice: "복사본으로 열었습니다." });
  const notice = await t.host.wait(isNotice, "the notice in VS Code");
  assert.deepEqual([notice.level, notice.content], ["warning", "복사본으로 열었습니다."]);
  assert.notEqual(notice.session_id, "eeef");
  const answer = t.host.items.findIndex((m) => m.type === "control_response" && (m.response as Msg).request_id === "init-1");
  assert.ok(answer !== -1 && answer < t.host.items.indexOf(notice), "after Claude Code answered VS Code's initialize");
  const named = await t.broker.frames.wait(frameOut((m) => m.subtype === "session_title_changed"), "the copy's name announced");
  assert.equal((named.m as Msg).title, "(복사본) 인보이스 내보내기");
  await t.broker.frames.wait((f) => f.t === "reply" && ((f.m as Msg).response as Msg).subtype === "success", "the rename answered to the broker");
  const lines = asked(requests);
  assert.ok((lines[0].args as string[]).includes("--fork-session"));
  const requested = lines.filter((l) => l.request).map((l) => l.request as Msg);
  assert.deepEqual(
    requested.map((r) => r.subtype),
    ["initialize", "rename_session"],
  );
  assert.deepEqual(requested[1], { subtype: "rename_session", title: "(복사본) 인보이스 내보내기", source: "host" }, "the copy, which has no id of its own yet");
  assert.ok(!t.host.has((m) => m.type === "control_response" && String((m.response as Msg).request_id).startsWith("ccrc-")), "VS Code does not get the rename's answer");
  t.user("hi");
  await t.host.wait((m) => m.type === "result", "a turn");
  assert.equal(t.host.items.filter(isNotice).length, 1, "told once");
});

test("claim: a launch the session moved to starts on it, with the broker's notice and no new name", async () => {
  const requests = path.join(tempDir(), "requests.jsonl");
  const t = await setup({ args: ["--resume", "eeeg"], env: { FAKE_REQUESTS: requests, FAKE_INIT_AT_TURN: "1" } });
  t.broker.answerClaims = false;
  await t.broker.frames.wait((f) => f.t === "hello" && f.claim === "eeeg", "hello with claim");
  t.broker.send({ t: "claim_ok", notice: "옮겼습니다." });
  await t.broker.frames.wait((f) => f.t === "spawned", "started");
  initialize(t);
  const notice = await t.host.wait(isNotice, "the notice in VS Code");
  assert.deepEqual([notice.content, notice.session_id], ["옮겼습니다.", "eeeg"]);
  t.user("hi");
  await t.host.wait((m) => m.type === "result", "a turn");
  assert.equal(t.host.items.filter(isNotice).length, 1, "told once: the session keeps its id");
  const lines = asked(requests);
  assert.ok(!(lines[0].args as string[]).includes("--fork-session"));
  assert.ok(!lines.some((l) => (l.request as Msg | undefined)?.subtype === "rename_session"));
});

const isInit = (m: Msg) => m.type === "system" && m.subtype === "init";

test("claim: a copy tells VS Code its notice again below the first message after the copy's init, with which VS Code starts the conversation over", async () => {
  const viaBroker = await setup({ args: ["--resume", "eeej"], env: { FAKE_INIT_AT_TURN: "1" } });
  viaBroker.broker.answerClaims = false;
  await viaBroker.broker.frames.wait((f) => f.t === "hello" && f.claim === "eeej", "hello with claim");
  initialize(viaBroker);
  viaBroker.broker.send({ t: "claim_ok", fork: true, title: "(복사본) 인보이스", notice: "복사본으로 열었습니다." });
  const alone = await setup({
    broker: false,
    args: ["--resume", "eeek"],
    env: { FAKE_INIT_AT_TURN: "1", LANG: "ko_KR.UTF-8", LC_ALL: "", LC_MESSAGES: "" },
    relay: { heldElsewhere: () => true, holderHost: () => "VS Code", releaseWaitMs: 300 },
  });
  await alone.started;
  initialize(alone);
  for (const [t, claim] of [
    [viaBroker, "eeej"],
    [alone, "eeek"],
  ] as const) {
    const first = await t.host.wait(isNotice, `${claim}: the notice in VS Code`);
    assert.ok(!t.host.has(isInit), `${claim}: told before the copy's first init`);
    t.user("hi");
    await t.host.wait((m) => m.type === "result", `${claim}: a turn`);
    const items = t.host.items;
    const init = items.findIndex(isInit);
    const shown = items.findIndex((m, i) => i > init && (m.type === "user" || m.type === "assistant"));
    const notices = items.filter(isNotice);
    assert.notEqual(items[init].session_id, claim, `${claim}: the init brings the copy's id`);
    assert.equal(notices.length, 2, `${claim}: told again`);
    assert.equal(items.indexOf(notices[1]), shown + 1, `${claim}: right below the first message after the init`);
    assert.deepEqual([notices[1].level, notices[1].content, notices[1].session_id], ["warning", first.content, items[init].session_id], claim);
    t.user("again");
    await t.host.wait((m) => m.type === "result" && t.host.items.filter(isInit).length === 2, `${claim}: another turn`);
    assert.equal(t.host.items.filter(isNotice).length, 2, `${claim}: told again only once`);
  }
});

test("claim: a notice or name that is not text, or too long, is left out", async () => {
  const requests = path.join(tempDir(), "requests.jsonl");
  const t = await setup({ args: ["--resume", "eeeh"], env: { FAKE_REQUESTS: requests } });
  t.broker.answerClaims = false;
  await t.broker.frames.wait((f) => f.t === "hello" && f.claim === "eeeh", "hello with claim");
  initialize(t);
  t.broker.send({ t: "claim_ok", fork: true, title: "x".repeat(1001), notice: { text: "no" } });
  await t.host.wait((m) => m.type === "control_response", "the initialize answer");
  t.user("hi");
  await t.host.wait((m) => m.type === "result", "a turn");
  assert.ok(!t.host.has(isNotice));
  assert.ok(!asked(requests).some((l) => (l.request as Msg | undefined)?.subtype === "rename_session"));
});

test("does not use a socket whose folder others can reach", async () => {
  const t = await setup({ dirMode: 0o755 });
  t.user("hi");
  await t.host.wait((m) => m.type === "assistant", "relay works");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(t.broker.frames.items.length, 0, "no connection to the broker");
});

test("everything Claude Code wrote reaches VS Code before the wrapper exits", async () => {
  const bin = new URL("../../bin/ccrc-wrapper", import.meta.url).pathname;
  const dir = tempDir();
  const child = spawn(bin, [process.execPath, FAKE, ...STREAM_ARGS], {
    env: { ...process.env, FAKE_BURST: "1", CCRC_LINK_SOCKET: path.join(dir, "none", "link.sock"), CCRC_WRAPPER_LOG: path.join(dir, "w.log") },
    stdio: ["pipe", "pipe", "inherit"],
  });
  child.stdout.pause();
  await new Promise((r) => setTimeout(r, 400));
  const lines: string[] = [];
  const split = new LineSplitter((line) => lines.push(line.toString("utf8")));
  child.stdout.on("data", (c: Buffer) => split.push(c));
  child.stdout.resume();
  const code = await Promise.race([
    new Promise((resolve) => child.on("close", resolve)),
    new Promise((_, reject) => setTimeout(() => reject(Error(`output cut short after ${lines.length} lines`)), 10_000)),
  ]);
  assert.equal(code, 1);
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[2]).type, "result");
});

// VS Code processes in these tests: 1001 went away (a reloaded window), 1002 is the current one.
function turnStore(dir: string, alive = new Set([1002])): TurnStore {
  return new TurnStore({ dir, processStart: (pid) => (alive.has(pid) ? `start-${pid}` : undefined), hostExitWaitMs: 300 });
}

const initOf = (t: { broker: FakeBroker }) => t.broker.frames.wait(frameOut((m) => m.type === "system" && m.subtype === "init"), "init");

test("a turn VS Code leaves mid-way continues when another VS Code process reopens the session", async () => {
  const turns = turnStore(tempDir());
  const first = await setup({ args: ["--session-id", "ffff"], relay: { turns, hostPid: 1001 } });
  first.user("HOLD");
  await first.host.wait((m) => m.type === "user" && m.isReplay === true, "turn started");
  first.hostIn.end();
  await first.exited;
  const again = await setup({ args: ["--resume", "ffff"], relay: { turns, hostPid: 1002 } });
  assert.equal(((await initOf(again)).m as Msg).continueTurn, "1");
  again.user("hi");
  await again.host.wait((m) => m.type === "result", "turn completed");
  const later = await setup({ args: ["--resume", "ffff"], relay: { turns, hostPid: 1002 } });
  assert.equal(((await initOf(later)).m as Msg).continueTurn, null, "a completed turn is not continued");
});

test("a turn is not continued when the same VS Code process reopens the session", async () => {
  const turns = turnStore(tempDir(), new Set([1001, 1002]));
  const first = await setup({ args: ["--session-id", "gggg"], relay: { turns, hostPid: 1002 } });
  first.user("HOLD");
  await first.host.wait((m) => m.type === "user" && m.isReplay === true, "turn started");
  first.hostIn.end();
  await first.exited;
  const again = await setup({ args: ["--resume", "gggg"], relay: { turns, hostPid: 1002 } });
  assert.equal(((await initOf(again)).m as Msg).continueTurn, null);
});

test("a turn left with no turn running is not noted", async () => {
  const turns = turnStore(tempDir());
  const first = await setup({ args: ["--session-id", "hhhh"], relay: { turns, hostPid: 1001 } });
  first.user("hi");
  await first.host.wait((m) => m.type === "result", "turn completed");
  first.hostIn.end();
  await first.exited;
  const again = await setup({ args: ["--resume", "hhhh"], relay: { turns, hostPid: 1002 } });
  assert.equal(((await initOf(again)).m as Msg).continueTurn, null);
});

test("without the broker's go-ahead a resuming launch waits for the process that still holds the session", async () => {
  let heldUntil = Date.now() + 600;
  const t = await setup({ broker: false, args: ["--resume", "iiii"], relay: { heldElsewhere: () => Date.now() < heldUntil } });
  const t0 = Date.now();
  await t.started;
  assert.ok(Date.now() - t0 >= 500, `started after ${Date.now() - t0} ms`);
  t.user("hi");
  const replay = await t.host.wait((m) => m.type === "user" && m.isReplay === true, "replay");
  assert.equal(replay.session_id, "iiii", "the session itself, not a copy");
  heldUntil = 0;
});

test("without the broker's go-ahead a session that stays held starts as a copy", async () => {
  const t = await setup({ broker: false, args: ["--resume", "jjjj"], relay: { heldElsewhere: () => true, releaseWaitMs: 300 } });
  await t.started;
  t.user("hi");
  const replay = await t.host.wait((m) => m.type === "user" && m.isReplay === true, "replay");
  assert.notEqual(replay.session_id, "jjjj");
});

test("a copy started without the broker tells VS Code in the environment's language what keeps the original, and is not renamed", async () => {
  const cases: [string, string | undefined, string][] = [
    ["ko_KR.UTF-8", "Terminal", "이 대화는 터미널에서 열려 있어 복사본으로 열었습니다."],
    ["en_US.UTF-8", "VS Code", "This conversation is open in another VS Code tab, so it opened here as a copy."],
    ["en_US.UTF-8", undefined, "This conversation is open in another Claude Code process, so it opened here as a copy."],
  ];
  for (const [lang, host, start] of cases) {
    const requests = path.join(tempDir(), "requests.jsonl");
    const t = await setup({
      broker: false,
      args: ["--resume", "jjjk"],
      env: { LANG: lang, LC_ALL: "", LC_MESSAGES: "", FAKE_REQUESTS: requests },
      relay: { heldElsewhere: () => true, holderHost: () => host, releaseWaitMs: 300 },
    });
    await t.started;
    initialize(t);
    const notice = await t.host.wait(isNotice, "the notice in VS Code");
    assert.ok(String(notice.content).startsWith(start), String(notice.content));
    t.user("hi");
    await t.host.wait((m) => m.type === "result", "a turn");
    assert.ok(!asked(requests).some((l) => (l.request as Msg | undefined)?.subtype === "rename_session"));
    t.hostIn.end();
    await t.exited;
  }
});

test("hand_over: a resting Claude Code is ended as VS Code ends one, after VS Code shows why", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  t.user("hi");
  await t.host.wait((m) => m.type === "result", "a turn");
  t.broker.send({ t: "hand_over", id: "ccrc-h1", notice: "다른 탭으로 옮겼습니다." });
  await t.broker.frames.wait((f) => f.t === "handed_over" && f.id === "ccrc-h1", "handed over");
  const notice = await t.host.wait(isNotice, "the notice in VS Code");
  assert.deepEqual([notice.level, notice.content], ["warning", "다른 탭으로 옮겼습니다."]);
  assert.deepEqual(await t.exited, [0, null]);
  const exit = await t.broker.frames.wait((f) => f.t === "exit", "exit");
  assert.deepEqual([exit.code, exit.signal, exit.hostLeft, exit.running], [0, null, false, false]);
});

test("hand_over is refused while a turn runs, a background task runs or Claude scheduled a job, and Claude Code goes on", async () => {
  const refused = async (texts: string[], reason: string, done: boolean) => {
    const t = await setup();
    await t.broker.frames.wait((f) => f.t === "hello", "hello");
    for (const text of texts) t.user(text);
    if (done) await t.host.wait((m) => m.type === "result", "the turn ended");
    else await t.host.wait((m) => m.type === "user" && m.isReplay === true, "the turn started");
    t.broker.send({ t: "hand_over", id: "ccrc-h2", notice: "옮겼습니다." });
    await t.broker.frames.wait((f) => f.t === "rejected" && f.id === "ccrc-h2" && f.reason === reason, reason);
    t.broker.send({ t: "to_cli", m: { type: "control_request", request_id: "ccrc-ctx", request: { subtype: "get_context_usage" } } });
    await t.broker.frames.wait((f) => f.t === "reply" && ((f.m as Msg).response as Msg).request_id === "ccrc-ctx", "Claude Code still answers");
    assert.ok(!t.host.has(isNotice), "VS Code is told nothing");
    assert.ok(!t.broker.frames.has((f) => f.t === "exit"));
    return t;
  };
  const turn = await refused(["HOLD"], "turn running", false);
  turn.broker.send({ t: "to_cli", m: { type: "control_request", request_id: "ccrc-stop", request: { subtype: "interrupt" } } });
  await turn.host.wait((m) => m.type === "result", "the turn stopped");
  turn.broker.send({ t: "hand_over", id: "ccrc-h3", notice: "옮겼습니다." });
  await turn.broker.frames.wait((f) => f.t === "handed_over" && f.id === "ccrc-h3", "handed over once the turn ended");
  await refused(["ASK"], "turn running", false);
  await refused(["BGIDLE"], "background task running", true);
  await refused(["CRON"], "job scheduled", true);
});

// A notes folder that cannot be written to, as on a full disk.
async function lockedNotes(fn: (turns: TurnStore) => Promise<void>): Promise<void> {
  const dir = tempDir();
  const turns = turnStore(dir);
  turns.cut("kkkk", 1001);
  turns.cut("llll", 1002);
  fs.chmodSync(dir, 0o500);
  try {
    await fn(turns);
  } finally {
    fs.chmodSync(dir, 0o700);
  }
}

test("a turn note that cannot be updated does not keep Claude Code from starting", async () => {
  await lockedNotes(async (turns) => {
    const t = await setup({ args: ["--resume", "kkkk"], relay: { turns, hostPid: 1002 } });
    await t.started.catch((e) => {
      t.relay.signal("SIGTERM");
      throw e;
    });
    assert.equal(((await initOf(t)).m as Msg).continueTurn, null, "not continued when the rerun cannot be counted");
  });
});

test("a turn note that cannot be cleared does not cut off what Claude Code writes next", async () => {
  await lockedNotes(async (turns) => {
    const t = await setup({ args: ["--resume", "llll"], relay: { turns, hostPid: 1002 } });
    t.user("one");
    t.user("two");
    await t.host.wait((m) => m.type === "assistant" && JSON.stringify(m).includes("echo: two"), "the second turn");
  });
});

const isSnapshot = (m: Msg) => m.type === "system" && m.subtype === "status" && m.connectSnapshot === true;

test("a model or effort change from the broker makes VS Code read the applied settings again", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  const request = (id: string, r: Msg) => t.broker.send({ t: "to_cli", m: { type: "control_request", request_id: id, request: r } });
  const replied = (id: string) => (f: Msg) => f.t === "reply" && ((f.m as Msg).response as Msg).request_id === id;
  request("ccrc-early", { subtype: "apply_flag_settings", settings: { effortLevel: "high" } });
  await t.broker.frames.wait(replied("ccrc-early"), "early reply");
  assert.ok(!t.host.has(isSnapshot), "nothing before VS Code has connected");

  t.write({ type: "control_request", request_id: "init-1", request: { subtype: "initialize" } });
  await t.host.wait((m) => m.type === "control_response" && (m.response as Msg).request_id === "init-1", "initialize answer");
  request("ccrc-effort", { subtype: "apply_flag_settings", settings: { effortLevel: "low", ultracode: true } });
  const first = await t.host.wait(isSnapshot, "status line after the effort change");
  const init = t.host.items.find((m) => m.type === "system" && m.subtype === "init") as Msg;
  assert.deepEqual({ ...first, uuid: typeof first.uuid }, { type: "system", subtype: "status", status: null, connectSnapshot: true, uuid: "string", session_id: init.session_id });
  assert.ok(!("permissionMode" in first), "the permission mode stays as VS Code has it");

  t.user("COMPACTING");
  await t.host.wait((m) => m.type === "system" && m.status === "compacting", "compacting");
  request("ccrc-model", { subtype: "set_model", model: "opus" });
  await t.broker.frames.wait(replied("ccrc-model"), "model reply");
  const second = await t.host.wait((m) => isSnapshot(m) && m !== first, "status line after the model change");
  assert.equal(second.status, "compacting", "Claude Code's current status goes along");

  const count = () => t.host.items.filter(isSnapshot).length;
  request("ccrc-mode", { subtype: "set_permission_mode", mode: "plan" });
  request("ccrc-gs", { subtype: "get_settings" });
  request("ccrc-ctx", { subtype: "get_context_usage" });
  for (const id of ["ccrc-mode", "ccrc-gs", "ccrc-ctx"]) await t.broker.frames.wait(replied(id), id);
  assert.equal(count(), 2, "other requests do not");
  assert.ok(!t.broker.frames.has(frameOut(isSnapshot)), "the line is for VS Code only");
});

test("a refused change does not touch VS Code", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  t.write({ type: "control_request", request_id: "init-1", request: { subtype: "initialize" } });
  await t.host.wait((m) => m.type === "control_response", "initialize answer");
  t.broker.send({ t: "to_cli", m: { type: "control_request", request_id: "ccrc-bad", request: { subtype: "apply_flag_settings", settings: { model: "opus" } } } });
  await t.broker.frames.wait((f) => f.t === "rejected" && f.id === "ccrc-bad", "refused");
  t.user("hi");
  await t.host.wait((m) => m.type === "result", "turn");
  assert.ok(!t.host.has(isSnapshot));
});

const isElicit = (id: string) => (m: Msg) => m.type === "control_request" && m.request_id === id;
const elicitReply = (id: string, response: Msg) => ({ type: "control_response", response: { subtype: "success", request_id: id, response } });

test("an MCP input request waits for the broker, which answers it in place of VS Code", async () => {
  const t = await setup({ relay: { elicitTakeMs: 2000 } });
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  t.user("ELICIT");
  await t.broker.frames.wait(frameOut(isElicit("elicit-1")), "request copied");
  await t.broker.frames.wait((f) => f.t === "held" && f.id === "elicit-1", "held frame");
  t.broker.send({ t: "to_cli", m: elicitReply("elicit-1", { action: "accept", content: { name: "Kim" } }) });
  await t.broker.frames.wait((f) => f.t === "rejected" && f.id === "elicit-1" && f.reason === "not answerable", "no answer before take");
  t.broker.send({ t: "take", id: "elicit-1" });
  t.broker.send({ t: "to_cli", m: elicitReply("elicit-1", { action: "maybe" }) });
  await t.broker.frames.wait((f) => f.t === "rejected" && f.id === "elicit-1" && f.reason === "invalid answer", "bad action refused");
  t.broker.send({ t: "to_cli", m: elicitReply("elicit-1", { action: "accept", content: { name: "Kim" }, hookSpecificOutput: { x: 1 } }) });
  const answered = await t.host.wait((m) => m.type === "answered" && m.request_id === "elicit-1", "CLI got the answer");
  assert.deepEqual([answered.action, answered.content, answered.keys], ["accept", { name: "Kim" }, ["action", "content"]]);
  await t.broker.frames.wait((f) => f.t === "settled" && f.id === "elicit-1" && f.by === "remote", "settled by remote");
  await new Promise((r) => setTimeout(r, 2200));
  assert.ok(!t.host.has(isElicit("elicit-1")), "VS Code never sees the request");
  assert.ok(!t.host.has((m) => m.type === "control_cancel_request"), "nor a withdrawal");
  t.broker.send({ t: "to_cli", m: elicitReply("elicit-1", { action: "decline" }) });
  await t.broker.frames.wait((f) => f.t === "dropped" && f.id === "elicit-1" && f.from === "remote", "a second answer is dropped");
});

test("an MCP input request the broker does not take in time goes to VS Code", async () => {
  const t = await setup({ relay: { elicitTakeMs: 300 } });
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  t.user("ELICIT");
  await t.broker.frames.wait((f) => f.t === "held", "held frame");
  assert.ok(!t.host.has(isElicit("elicit-1")));
  await t.host.wait(isElicit("elicit-1"), "VS Code gets it after the wait");
  t.write(elicitReply("elicit-1", { action: "decline" }));
  const answered = await t.host.wait((m) => m.type === "answered", "CLI got VS Code's answer");
  assert.equal(answered.action, "decline");
  await t.broker.frames.wait((f) => f.t === "settled" && f.id === "elicit-1" && f.by === "host", "settled by host");
  t.broker.send({ t: "take", id: "elicit-1" });
  await t.broker.frames.wait((f) => f.t === "rejected" && f.id === "elicit-1" && f.reason === "not held", "late take refused");
});

test("an MCP input request the broker passes goes to VS Code at once", async () => {
  const t = await setup({ relay: { elicitTakeMs: 10_000 } });
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  t.user("ELICIT");
  await t.broker.frames.wait((f) => f.t === "held", "held frame");
  t.broker.send({ t: "pass", id: "elicit-1" });
  await t.host.wait(isElicit("elicit-1"), "VS Code gets it", 2000);
  t.broker.send({ t: "to_cli", m: elicitReply("elicit-1", { action: "cancel" }) });
  await t.broker.frames.wait((f) => f.t === "rejected" && f.id === "elicit-1", "the broker cannot answer a passed request");
});

test("without a broker an MCP input request goes straight to VS Code", async () => {
  const t = await setup({ broker: false, relay: { elicitTakeMs: 10_000 } });
  await t.started;
  t.user("ELICIT");
  await t.host.wait(isElicit("elicit-1"), "VS Code gets it", 2000);
});

test("a taken MCP input request goes to VS Code when the broker goes away", async () => {
  const t = await setup({ relay: { elicitTakeMs: 10_000 } });
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  t.user("ELICIT");
  await t.broker.frames.wait((f) => f.t === "held", "held frame");
  t.broker.send({ t: "take", id: "elicit-1" });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!t.host.has(isElicit("elicit-1")));
  t.broker.frames = new Inbox();
  t.broker.dropConnections();
  await t.host.wait(isElicit("elicit-1"), "VS Code gets it", 2000);
  await t.broker.frames.wait((f) => f.t === "hello", "hello again");
  await t.broker.frames.wait(frameOut(isElicit("elicit-1")), "still open, re-sent");
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!t.broker.frames.has((f) => f.t === "held"), "but not held again");
});

test("an MCP input request Claude Code withdraws while held never reaches VS Code", async () => {
  const t = await setup({ relay: { elicitTakeMs: 10_000 } });
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  t.user("ELICIT_CANCEL");
  await t.broker.frames.wait((f) => f.t === "held", "held frame");
  t.broker.send({ t: "take", id: "elicit-1" });
  await t.broker.frames.wait((f) => f.t === "settled" && f.id === "elicit-1" && f.by === "cli", "settled by Claude Code");
  await t.broker.frames.wait(frameOut((m) => m.type === "control_cancel_request" && m.request_id === "elicit-1"), "withdrawal copied");
  t.broker.send({ t: "to_cli", m: elicitReply("elicit-1", { action: "accept", content: { name: "x" } }) });
  await t.broker.frames.wait((f) => f.t === "dropped" && f.id === "elicit-1", "late answer dropped");
  t.user("hi");
  await t.host.wait((m) => m.type === "result", "relay still flows");
  assert.ok(!t.host.has(isElicit("elicit-1")) && !t.host.has((m) => m.type === "control_cancel_request"), "VS Code saw neither");
});

test("an MCP input answer carries an action and, with accept, flat values only", () => {
  assert.deepEqual(elicitAnswer({ action: "decline" }), { action: "decline" });
  assert.deepEqual(elicitAnswer({ action: "cancel", extra: 1 }), { action: "cancel" });
  assert.deepEqual(elicitAnswer({ action: "accept", content: { a: "x", b: 2, c: true, d: ["p", "q"] } }), {
    action: "accept",
    content: { a: "x", b: 2, c: true, d: ["p", "q"] },
  });
  const bad: unknown[] = [
    null,
    {},
    { action: "allow" },
    { action: "decline", content: { a: "x" } },
    { action: "accept", content: [] },
    { action: "accept", content: { a: { nested: 1 } } },
    { action: "accept", content: { a: [1] } },
    { action: "accept", content: { a: Infinity } },
    { action: "accept", content: { a: "x".repeat(20_001) } },
    { action: "accept", content: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, i])) },
  ];
  for (const b of bad) assert.equal(elicitAnswer(b), undefined, JSON.stringify(b)?.slice(0, 80));
});

test("every MCP input answer the broker accepts passes the wrapper", () => {
  const info = elicitInfo({
    serverName: "s",
    message: "m",
    mode: "form",
    requestedSchema: { type: "object", properties: { long: { type: "string", maxLength: 50_000 }, plain: { type: "string" } } },
  });
  assert.equal((info.fields?.[0] as { maxLength?: number }).maxLength, 10_000);
  assert.throws(() => elicitResult(info, "accept", { long: "x".repeat(10_001) }));
  for (const content of [{ long: "x".repeat(10_000) }, { plain: "\u{1F600}".repeat(10_000) }]) {
    assert.ok(elicitAnswer(elicitResult(info, "accept", content)), Object.keys(content)[0]);
  }
});

test("messages written during a turn reach the broker at once, and only the broker's own can be taken back", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  t.user("HOLD");
  await t.host.wait((m) => m.type === "user" && m.isReplay === true, "turn started");
  t.write({
    type: "user",
    uuid: "vs-q1",
    session_id: "",
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "QUFBQQ==" } }, { type: "text", text: "from VS Code" }] },
  });
  const copy = await t.broker.frames.wait((f) => f.t === "in" && (f.m as Msg).type === "user", "VS Code's message");
  assert.deepEqual((copy.m as Msg).message, { role: "user", content: [{ type: "image" }, { type: "text", text: "from VS Code" }] });
  assert.equal((copy.m as Msg).remote, undefined);
  assert.ok(!JSON.stringify(copy).includes("QUFBQQ"), "image data stays out of the copy");
  const phone = { type: "user", uuid: "ph-q2", session_id: "", parent_tool_use_id: null, origin: { kind: "human" }, message: { role: "user", content: [{ type: "text", text: "from the phone" }] } };
  t.broker.send({ t: "to_cli", m: phone });
  await t.broker.frames.wait(frameOut((m) => m.type === "command_lifecycle" && m.command_uuid === "ph-q2" && m.state === "queued"), "queued");
  assert.ok(!t.broker.frames.has((f) => f.t === "in" && (f.m as Msg).uuid === "ph-q2"), "the broker's own message is not copied back");

  const cancel = (id: string, request: Msg) => t.broker.send({ t: "to_cli", m: { type: "control_request", request_id: id, request: { subtype: "cancel_async_message", ...request } } });
  cancel("ccrc-c1", { message_uuid: "vs-q1" });
  await t.broker.frames.wait((f) => f.t === "rejected" && f.id === "ccrc-c1" && f.reason === "message not allowed", "VS Code's message is not taken back remotely");
  cancel("ccrc-c2", { message_uuid: "ph-q2", extra: 1 });
  await t.broker.frames.wait((f) => f.t === "rejected" && f.id === "ccrc-c2", "other arguments refused");

  const hellos = () => t.broker.frames.items.filter((f) => f.t === "hello").length;
  const reconnect = async (n: number) => {
    const at = t.broker.frames.items.length;
    t.broker.dropConnections();
    for (let i = 0; i < 200 && hellos() < n; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 100));
    return t.broker.frames.items.slice(at).filter((f) => f.t === "in" && (f.m as Msg).type === "user").map((f) => [(f.m as Msg).uuid, (f.m as Msg).remote ?? false]);
  };
  assert.deepEqual(await reconnect(2), [
    ["vs-q1", false],
    ["ph-q2", true],
  ]);

  cancel("ccrc-c3", { message_uuid: "ph-q2" });
  const answer = await t.broker.frames.wait((f) => f.t === "reply" && ((f.m as Msg).response as Msg).request_id === "ccrc-c3", "cancel answered");
  assert.equal((((answer.m as Msg).response as Msg).response as Msg).cancelled, true);
  await t.broker.frames.wait(frameOut((m) => m.type === "command_lifecycle" && m.command_uuid === "ph-q2" && m.state === "cancelled"), "cancelled");
  cancel("ccrc-c4", { message_uuid: "ph-q2" });
  await t.broker.frames.wait((f) => f.t === "rejected" && f.id === "ccrc-c4", "a message no longer waiting cannot be taken back");

  t.broker.send({ t: "to_cli", m: { type: "control_request", request_id: "ccrc-stop", request: { subtype: "interrupt" } } });
  await t.broker.frames.wait(frameOut((m) => m.type === "command_lifecycle" && m.command_uuid === "vs-q1" && m.state === "started"), "taken in");
  assert.deepEqual(await reconnect(3), [], "nothing is waiting any more");
});

test("rename_session names only the session the process runs now, as the user's rename", () => {
  const ok = { subtype: "rename_session", title: "새 이름", source: "host", session_id: "s1" };
  assert.ok(allowedRename(ok, "s1"));
  assert.ok(allowedRename({ ...ok, title: "x".repeat(1000) }, "s1"));
  assert.ok(!allowedRename(ok, undefined), "not before the session is known");
  assert.ok(!allowedRename(ok, "s2"));
  const bad: Msg[] = [
    { ...ok, source: "remote" },
    { subtype: "rename_session", title: "x", session_id: "s1" },
    { subtype: "rename_session", title: "x", source: "host" },
    { ...ok, title: "" },
    { ...ok, title: "x".repeat(1001) },
    { ...ok, title: 3 },
    { ...ok, extra: true },
  ];
  for (const b of bad) assert.ok(!allowedRename(b, "s1"), JSON.stringify(b).slice(0, 80));
});

test("the broker renames the session through the wrapper, and Claude Code's announcement reaches VS Code and the broker", async () => {
  const SID = "1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
  const t = await setup({ args: ["--session-id", SID], env: { CLAUDE_CONFIG_DIR: tempDir() } });
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  const request = (id: string, r: Msg) => t.broker.send({ t: "to_cli", m: { type: "control_request", request_id: id, request: r } });
  request("ccrc-rn-ok", { subtype: "rename_session", title: "새 이름", source: "host", session_id: SID });
  const reply = await t.broker.frames.wait((f) => f.t === "reply" && ((f.m as Msg).response as Msg).request_id === "ccrc-rn-ok", "renamed");
  assert.equal(((reply.m as Msg).response as Msg).subtype, "success");
  await t.host.wait((m) => m.type === "system" && m.subtype === "session_title_changed" && m.title === "새 이름", "VS Code hears the name");
  await t.broker.frames.wait(frameOut((m) => m.subtype === "session_title_changed" && m.title === "새 이름"), "the broker hears it");
  const refused: Msg[] = [
    { subtype: "rename_session", title: "x", source: "remote", session_id: SID },
    { subtype: "rename_session", title: "x", source: "host", session_id: "00000000-0000-4000-8000-000000000000" },
    { subtype: "rename_session", title: "x", source: "host", session_id: SID, tag: "y" },
  ];
  refused.forEach((r, i) => request(`ccrc-rn-bad-${i}`, r));
  for (const i of refused.keys()) await t.broker.frames.wait((f) => f.t === "rejected" && f.id === `ccrc-rn-bad-${i}` && f.reason === "invalid request", `refused ${i}`);
  assert.ok(!t.host.has((m) => m.type === "control_response"), "VS Code sees none of the answers");
});

test("Claude Code may send the user files by path unless VS Code's environment turns it off or already says how", async () => {
  const script = `console.log(JSON.stringify({ type: "system", subtype: "env", value: process.env.CLAUDE_CODE_ATTACHMENTS_BY_PATH ?? null }))`;
  const seen = async (env: Record<string, string>) => {
    const logs: string[] = [];
    const { host } = await setup({ relay: { args: ["-e", script], env: { PATH: process.env.PATH ?? "", ...env }, log: (m) => logs.push(m) } });
    const m = await host.wait((m) => m.subtype === "env", "the environment Claude Code got");
    return [m.value, logs.find((l) => l.startsWith("files sent to the user"))];
  };
  assert.deepEqual(await seen({}), ["1", "files sent to the user go by path: 1"]);
  assert.deepEqual(await seen({ CCRC_SEND_FILES: "0" }), [null, "files sent to the user go by path: off"]);
  assert.deepEqual(await seen({ CLAUDE_CODE_ATTACHMENTS_BY_PATH: "0" }), ["0", "files sent to the user go by path: 0"]);
});

// VS Code's initialize, with the hooks the extension registers for itself.
const VSCODE_INIT = {
  type: "control_request",
  request_id: "init-1",
  request: {
    subtype: "initialize",
    hooks: {
      PreToolUse: [
        { matcher: "Edit|Write|MultiEdit", hookCallbackIds: ["hook_0"] },
        { matcher: "Edit|Write|Read", hookCallbackIds: ["hook_1"] },
      ],
      PostToolUse: [{ matcher: "Edit|Write|MultiEdit", hookCallbackIds: ["hook_2"] }],
    },
    systemPrompt: ["keep"],
  },
};
const OURS = { matcher: "PushNotification", hookCallbackIds: [PUSH_HOOK] };
const pushResult = (m: Msg) => m.type === "user" && JSON.stringify(m).includes('"tool_result"') && JSON.stringify(m).includes("toolu_push_");
const resultText = (m: Msg) => ((m.message as Msg).content as Msg[])[0].content;
const requests = (file: string) =>
  fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Msg);

test("VS Code's initialize gets one more hook, for PushNotification; any other shape goes on as it is", () => {
  const added = JSON.parse(String(withPushHook(VSCODE_INIT)));
  assert.deepEqual(added.request.hooks.PreToolUse, VSCODE_INIT.request.hooks.PreToolUse);
  assert.deepEqual(added.request.hooks.PostToolUse, [...VSCODE_INIT.request.hooks.PostToolUse, OURS]);
  assert.deepEqual(added.request.systemPrompt, ["keep"]);
  assert.equal(added.request_id, "init-1");
  const bare = JSON.parse(String(withPushHook({ type: "control_request", request_id: "i", request: { subtype: "initialize" } })));
  assert.deepEqual(bare.request.hooks, { PostToolUse: [OURS] });
  assert.equal(withPushHook({ type: "control_request", request_id: "i", request: { subtype: "initialize", hooks: [] } }), undefined);
  assert.equal(withPushHook({ type: "control_request", request_id: "i", request: { subtype: "initialize", hooks: { PostToolUse: {} } } }), undefined);
  assert.equal(withPushHook({ type: "control_request", request_id: "i", request: { subtype: "interrupt" } }), undefined);
});

test("the hook's answer says the push was requested while the broker sends it, not needed while the user watches, and Claude Code's own otherwise", () => {
  const input = { tool_name: "PushNotification", tool_response: { message: "끝", pushSent: false, localSent: true, disabledReason: "no_transport", sentAt: "t" } };
  assert.deepEqual(pushHookAnswer(input, "sent"), {
    hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: { message: "끝", pushSent: true, localSent: false } },
  });
  assert.deepEqual(pushHookAnswer(input, "watching"), {
    hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: { message: "끝", pushSent: false, localSent: false, disabledReason: "user_present" } },
  });
  assert.deepEqual(pushHookAnswer(input, "off"), {}, "no device takes them");
  assert.deepEqual(pushHookAnswer(input, undefined), {}, "nothing decided it");
  assert.deepEqual(pushHookAnswer({ ...input, tool_response: { message: "끝", pushSent: true } }, "sent"), {}, "Claude Code pushed it itself");
  assert.deepEqual(pushHookAnswer({ ...input, tool_name: "Bash" }, "sent"), {});
  assert.deepEqual(pushHookAnswer({ tool_name: "PushNotification", tool_response: "Error: x" }, "watching"), {});
});

test("the wrapper answers its PushNotification hook itself: requested while the broker sends Claude's notifications, not needed while the user watches the session, as Claude Code made it otherwise", async () => {
  const dir = tempDir();
  const log = path.join(dir, "requests.jsonl");
  const t = await setup({ env: { FAKE_REQUESTS: log } });
  const hello = await t.broker.frames.wait((f) => f.t === "hello", "hello");
  assert.ok((hello.caps as string[]).includes("claude_push"));
  t.write(VSCODE_INIT);
  await t.host.wait((m) => m.type === "control_response" && (m.response as Msg).request_id === "init-1", "initialize answered to VS Code");
  const init = requests(log).find((r) => (r.request as Msg | undefined)?.subtype === "initialize");
  assert.deepEqual(((init!.request as Msg).hooks as Msg).PostToolUse, [...VSCODE_INIT.request.hooks.PostToolUse, OURS], "Claude Code got VS Code's hooks and the wrapper's");

  // The n-th result of a PushNotification call that reached VS Code.
  const nth = async (n: number) => {
    await t.host.wait(() => t.host.items.filter(pushResult).length >= n, `result ${n}`);
    return resultText(t.host.items.filter(pushResult)[n - 1]);
  };
  t.user("PUSH 아직 연결 전");
  assert.equal(await nth(1), "Mobile push not sent (Remote Control inactive).", "the broker has not said a device takes them");

  t.broker.send({ t: "claude_push", on: true });
  await new Promise((r) => setTimeout(r, 50));
  t.user("PUSH 테스트 끝");
  assert.equal(await nth(2), "Mobile push requested.");
  const copied = await t.broker.frames.wait(frameOut((m) => pushResult(m) && resultText(m) === "Mobile push requested."), "result copied to the broker");
  assert.equal(((copied.m as Msg).tool_use_result as Msg).pushSent, true);
  await t.broker.frames.wait(frameOut((m) => m.type === "assistant" && JSON.stringify(m).includes('"PushNotification"')), "the call copied to the broker");
  assert.ok(!t.host.has((m) => (m.request as Msg | undefined)?.subtype === "hook_callback"), "VS Code never sees the wrapper's hook");
  assert.ok(!t.broker.frames.has((f) => JSON.stringify(f).includes('"hook_callback"')), "nor does the broker");

  t.broker.send({ t: "claude_push", on: true, watching: true });
  await new Promise((r) => setTimeout(r, 50));
  t.user("PUSH 보는 중");
  assert.equal(await nth(3), "Not sent \u2014 this terminal is active, so your output here already reaches the user; a separate notification would be redundant.", "the user has the session in front of them");

  t.broker.send({ t: "claude_push", on: false });
  await new Promise((r) => setTimeout(r, 50));
  t.user("PUSH 끈 뒤");
  assert.equal(await nth(4), "Mobile push not sent (Remote Control inactive).", "no device takes them now");

  t.broker.send({ t: "claude_push", on: true, watching: true });
  await new Promise((r) => setTimeout(r, 50));
  t.broker.dropConnections();
  await new Promise((r) => setTimeout(r, 20));
  t.user("PUSH 브로커 없이");
  assert.equal(await nth(5), "Mobile push not sent (Remote Control inactive).", "a broker that went away sends nothing");
  const answers = requests(log)
    .filter((r) => "hookAnswer" in r)
    .map((r) => ((r.hookAnswer as Msg).hookSpecificOutput as Msg | undefined)?.updatedToolOutput as Msg | undefined)
    .map((o) => (o ? (o.disabledReason ?? o.pushSent) : null));
  assert.deepEqual(answers, [null, true, "user_present", null, null]);
});

test("VS Code's own hooks still reach VS Code, and its answers Claude Code", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  t.write(VSCODE_INIT);
  t.broker.send({ t: "claude_push", on: true });
  t.user("VSHOOK");
  const asked = await t.host.wait((m) => m.type === "control_request" && (m.request as Msg).subtype === "hook_callback", "VS Code's hook");
  assert.equal((asked.request as Msg).callback_id, "hook_0");
  t.write({ type: "control_response", response: { subtype: "success", request_id: asked.request_id, response: { continue: true } } });
  await t.host.wait((m) => m.type === "answered" && m.request_id === asked.request_id, "Claude Code got VS Code's answer");
});

test("get_workspace_diff reaches Claude Code with nothing else, and its answer only the broker", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  const request = (id: string, r: Msg) => t.broker.send({ t: "to_cli", m: { type: "control_request", request_id: id, request: r } });
  request("ccrc-diff", { subtype: "get_workspace_diff" });
  const reply = await t.broker.frames.wait((f) => f.t === "reply" && ((f.m as Msg).response as Msg).request_id === "ccrc-diff", "diff answered");
  const diff = ((((reply.m as Msg).response as Msg).response as Msg).diff ?? {}) as Msg;
  assert.equal((diff.perFileStats as Msg[])[0].path, "a.txt");
  request("ccrc-diff-bad", { subtype: "get_workspace_diff", path: "/etc" });
  await t.broker.frames.wait((f) => f.t === "rejected" && f.id === "ccrc-diff-bad" && f.reason === "invalid request", "extra keys refused");
  assert.ok(!t.host.has((m) => m.type === "control_response"), "VS Code sees none of the answers");
  assert.ok(allowedWorkspaceDiff({ subtype: "get_workspace_diff" }));
  assert.ok(!allowedWorkspaceDiff({ subtype: "get_workspace_diff", base: "main" }));
});

test("a side question carries only its text and its thread; its progress and answer reach the broker only", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  const request = (id: string, r: Msg) => t.broker.send({ t: "to_cli", m: { type: "control_request", request_id: id, request: r } });
  request("ccrc-side", { subtype: "side_question", question: "what now?", history: [{ question: "before?", response: "yes" }] });
  await t.broker.frames.wait(frameOut((m) => m.subtype === "control_request_progress" && m.request_id === "ccrc-side"), "progress to the broker");
  const reply = await t.broker.frames.wait((f) => f.t === "reply" && ((f.m as Msg).response as Msg).request_id === "ccrc-side", "answer to the broker");
  assert.equal((((reply.m as Msg).response as Msg).response as Msg).response, "side: what now? (history 1)");
  assert.ok(!t.host.has((m) => m.subtype === "control_request_progress"), "VS Code does not hear of the broker's side question");
  assert.ok(!t.host.has((m) => m.type === "control_response"), "VS Code sees none of the answers");
  const bad: Msg[] = [
    { subtype: "side_question" },
    { subtype: "side_question", question: "" },
    { subtype: "side_question", question: "x".repeat(10_001) },
    { subtype: "side_question", question: "q", model: "opus" },
    { subtype: "side_question", question: "q", history: "none" },
    { subtype: "side_question", question: "q", history: [{ question: "a", response: "b", tools: true }] },
    { subtype: "side_question", question: "q", history: [{ question: "a", response: 7 }] },
    { subtype: "side_question", question: "q", history: Array.from({ length: 21 }, () => ({ question: "a", response: "b" })) },
    { subtype: "side_question", question: "q", history: Array.from({ length: 3 }, () => ({ question: "a", response: "가".repeat(30_000) })) },
  ];
  bad.forEach((r, i) => request(`ccrc-side-bad-${i}`, r));
  for (const i of bad.keys()) await t.broker.frames.wait((f) => f.t === "rejected" && f.id === `ccrc-side-bad-${i}` && f.reason === "invalid request", `bad side_question ${i}`);
  assert.ok(allowedSideQuestion({ subtype: "side_question", question: "q", history: [{ question: "a", response: "", fallback_notice: "n" }] }));
  assert.ok(!allowedSideQuestion({ subtype: "side_question", question: "q", history: [null] }));
  assert.ok(allowedSideQuestion({ subtype: "side_question", question: "q", history: Array.from({ length: 2 }, () => ({ question: "a", response: "가".repeat(30_000) })) }));
});

test("the broker cancels only its own side question, and VS Code's own side question stays between it and Claude Code", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  t.broker.send({ t: "to_cli", m: { type: "control_request", request_id: "ccrc-slow", request: { subtype: "side_question", question: "SLOW" } } });
  await t.broker.frames.wait(frameOut((m) => m.subtype === "control_request_progress" && m.request_id === "ccrc-slow"), "slow side question taken up");
  t.broker.send({ t: "to_cli", m: { type: "control_cancel_request", request_id: "ccrc-other" } });
  await t.broker.frames.wait((f) => f.t === "rejected" && f.id === "ccrc-other" && f.reason === "not cancellable", "another id refused");
  t.broker.send({ t: "to_cli", m: { type: "control_cancel_request", request_id: "ccrc-slow", extra: 1 } });
  await t.broker.frames.wait((f) => f.t === "rejected" && f.id === "ccrc-slow" && f.reason === "not cancellable", "a cancel with more in it refused");
  t.broker.send({ t: "to_cli", m: { type: "control_cancel_request", request_id: "ccrc-slow" } });
  const reply = await t.broker.frames.wait((f) => f.t === "reply" && ((f.m as Msg).response as Msg).request_id === "ccrc-slow", "cancelled side question answered");
  assert.equal(((reply.m as Msg).response as Msg).error, "Side question cancelled");
  t.write({ type: "control_request", request_id: "host-side", request: { subtype: "side_question", question: "from VS Code" } });
  await t.host.wait((m) => m.subtype === "control_request_progress" && m.request_id === "host-side", "VS Code hears of its own side question");
  await t.host.wait((m) => m.type === "control_response" && (m.response as Msg).request_id === "host-side", "VS Code gets its answer");
  t.user("hi");
  await t.broker.frames.wait(frameOut((m) => m.type === "result"), "a later turn copied");
  assert.ok(!JSON.stringify(t.broker.frames.items).includes("host-side"), "VS Code's side question never reaches the broker");
});

const dialogAnswer = (id: string, response: unknown, subtype = "success") => ({ t: "to_cli", m: { type: "control_response", response: { subtype, request_id: id, response } } });

test("a dialog the phone may answer goes to Claude Code as a rebuilt answer, and VS Code is told to close its copy", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  t.user("DIALOG refusal_fallback_prompt");
  await t.host.wait((m) => m.type === "control_request" && (m.request as Msg).subtype === "request_user_dialog", "dialog at VS Code");
  await t.broker.frames.wait(frameOut((m) => m.type === "control_request" && m.request_id === "dialog-1"), "dialog at broker");
  t.broker.send(dialogAnswer("dialog-1", { behavior: "completed", result: "retry_now" }));
  await t.broker.frames.wait((f) => f.t === "rejected" && f.id === "dialog-1" && f.reason === "invalid answer", "an answer the dialog does not offer");
  t.broker.send(dialogAnswer("dialog-1", { behavior: "completed", result: "retry_fallback", extra: 1 }));
  await t.broker.frames.wait((f) => f.t === "rejected" && f.id === "dialog-1" && f.reason === "invalid answer" && t.broker.frames.items.filter((x) => x.t === "rejected").length === 2, "an answer with more in it");
  t.broker.send(dialogAnswer("dialog-1", { behavior: "completed", result: "retry_fallback" }));
  const answered = await t.host.wait((m) => m.type === "answered" && m.request_id === "dialog-1", "Claude Code got the answer");
  assert.equal(answered.behavior, "completed");
  assert.equal(answered.result, "retry_fallback");
  await t.host.wait((m) => m.type === "control_cancel_request" && m.request_id === "dialog-1", "VS Code closes its copy");
  await t.broker.frames.wait((f) => f.t === "settled" && f.id === "dialog-1" && f.by === "remote", "settled by the phone");
  t.write({ type: "control_response", response: { subtype: "error", request_id: "dialog-1", error: "aborted" } });
  await t.broker.frames.wait((f) => f.t === "dropped" && f.id === "dialog-1" && f.from === "host", "VS Code's late answer goes nowhere");
});

test("auto mode's billing notice takes continue, interrupt or a close; the credits consent is not answerable", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  t.user("DIALOG auto_mode_server_fallback");
  await t.broker.frames.wait(frameOut((m) => m.request_id === "dialog-1"), "notice at broker");
  t.broker.send(dialogAnswer("dialog-1", { behavior: "cancelled" }));
  const closed = await t.host.wait((m) => m.type === "answered" && m.request_id === "dialog-1", "closed");
  assert.equal(closed.behavior, "cancelled");
  t.user("DIALOG fable_overage_consent_prompt");
  await t.broker.frames.wait(frameOut((m) => m.request_id === "dialog-2"), "consent at broker");
  t.broker.send(dialogAnswer("dialog-2", { behavior: "completed", result: "consent" }));
  await t.broker.frames.wait((f) => f.t === "rejected" && f.id === "dialog-2" && f.reason === "not answerable", "consent refused");
  t.broker.send(dialogAnswer("dialog-2", { behavior: "cancelled" }));
  await t.broker.frames.wait((f) => f.t === "rejected" && f.id === "dialog-2" && t.broker.frames.items.filter((x) => x.t === "rejected" && x.id === "dialog-2").length === 2, "a close refused too");
  assert.ok(!t.host.has((m) => m.type === "answered" && m.request_id === "dialog-2"), "only VS Code answers the consent");
  t.write({ type: "control_response", response: { subtype: "success", request_id: "dialog-2", response: { behavior: "completed", result: "switch_default" } } });
  const vs = await t.host.wait((m) => m.type === "answered" && m.request_id === "dialog-2", "VS Code's answer");
  assert.equal(vs.result, "switch_default");
});

test("an MCP sign-in starts with a server name only, its answer comes back reduced, and the redirect goes back only to this machine", async () => {
  const t = await setup();
  await t.broker.frames.wait((f) => f.t === "hello", "hello");
  const request = (id: string, r: Msg) => t.broker.send({ t: "to_cli", m: { type: "control_request", request_id: id, request: r } });
  const replied = (id: string) => (f: Msg) => f.t === "reply" && ((f.m as Msg).response as Msg).request_id === id;
  request("ccrc-auth", { subtype: "mcp_authenticate", serverName: "linear" });
  const started = await t.broker.frames.wait(replied("ccrc-auth"), "sign-in started");
  assert.deepEqual(((started.m as Msg).response as Msg).response, { authUrl: "https://auth.example.com/authorize?state=s1", requiresUserAction: true, callbackExpected: true });
  request("ccrc-auth-redirect", { subtype: "mcp_authenticate", serverName: "linear", redirectUri: "https://evil.example/cb" });
  await t.broker.frames.wait((f) => f.t === "rejected" && f.id === "ccrc-auth-redirect" && f.reason === "invalid request", "a redirect the broker picks");
  request("ccrc-cb", { subtype: "mcp_oauth_callback_url", serverName: "linear", callbackUrl: "http://localhost:43123/callback?code=abc&state=s1" });
  const done = await t.broker.frames.wait(replied("ccrc-cb"), "sign-in finished");
  assert.equal(((done.m as Msg).response as Msg).subtype, "success");
  request("ccrc-cb-far", { subtype: "mcp_oauth_callback_url", serverName: "linear", callbackUrl: "https://evil.example/callback?code=abc&state=s1" });
  await t.broker.frames.wait((f) => f.t === "rejected" && f.id === "ccrc-cb-far" && f.reason === "invalid request", "a redirect elsewhere");
  request("ccrc-cb-other", { subtype: "mcp_oauth_callback_url", serverName: "linear", callbackUrl: "http://localhost:43123/callback?code=abc&state=s2" });
  const other = await t.broker.frames.wait(replied("ccrc-cb-other"), "another attempt's redirect");
  assert.match(String(((other.m as Msg).response as Msg).error), /not accepted/);
  assert.ok(!t.host.has((m) => m.type === "control_response"), "VS Code sees none of the answers");
});

test("the MCP sign-in checks take only what Claude Code needs", () => {
  assert.ok(allowedMcpAuthenticate({ subtype: "mcp_authenticate", serverName: "claude.ai Gmail" }));
  for (const bad of [{}, { serverName: "" }, { serverName: 7 }, { serverName: "x".repeat(201) }, { serverName: "a\nb" }, { serverName: "a", redirectUri: "https://x" }]) {
    assert.ok(!allowedMcpAuthenticate({ subtype: "mcp_authenticate", ...bad }), JSON.stringify(bad));
  }
  for (const ok of ["http://localhost:43123/callback?code=abc&state=s1", "http://127.0.0.1:9/callback?error=access_denied&state=s1", "http://[::1]:9/cb?code=1"]) assert.ok(allowedOAuthCallback(ok), ok);
  const bad = [
    "https://localhost:43123/callback?code=abc",
    "http://localhost:43123/callback?state=s1",
    "http://example.com/callback?code=abc",
    "http://user:pw@localhost:1/callback?code=abc",
    "http://localhost:1/callback?code=a\u0000",
    `http://localhost:1/callback?code=${"a".repeat(4096)}`,
    "javascript:alert(1)",
    "not a url",
    7,
  ];
  for (const url of bad) assert.ok(!allowedOAuthCallback(url), String(url));
  assert.ok(allowedMcpCallback({ subtype: "mcp_oauth_callback_url", serverName: "linear", callbackUrl: "http://localhost:1/cb?code=x" }));
  assert.ok(!allowedMcpCallback({ subtype: "mcp_oauth_callback_url", serverName: "linear", callbackUrl: "http://localhost:1/cb?code=x", extra: 1 }));
  const reduced = JSON.parse(
    String(
      mcpAuthAnswer({
        type: "control_response",
        response: { subtype: "success", request_id: "ccrc-1", response: { authUrl: "https://a.example/x", requiresUserAction: true, callbackExpected: true, state: "s", callbackPort: 1, redirectScheme: "localhost" } },
      }),
    ),
  );
  assert.deepEqual(reduced.response.response, { authUrl: "https://a.example/x", requiresUserAction: true, callbackExpected: true });
});
