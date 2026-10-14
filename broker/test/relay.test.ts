import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, test } from "node:test";
import { LineSplitter, parseLine } from "../src/link/lines.ts";
import { Relay, launchSession, type RelayOptions } from "../src/wrapper/relay.ts";
import { TurnStore } from "../src/wrapper/turns.ts";
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
  return { broker, host, hostIn, relay, exited, started, write, user };
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
  ];
  allowed.forEach((r, i) => request(`ccrc-ok-${i}`, r));
  for (const [i, r] of allowed.entries()) await t.broker.frames.wait(replied(`ccrc-ok-${i}`), String(r.subtype));
  const refused = [
    "mcp_set_servers",
    "mcp_authenticate",
    "mcp_read_resource",
    "set_mcp_permission_mode_override",
    "rewind_conversation",
    "background_tasks",
    "get_task_output",
    "update_settings",
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
