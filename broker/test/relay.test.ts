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
  allowedFlagSettings,
  allowedUpdateSettings,
  appliedAnswer,
  elicitAnswer,
  launchSession,
  styleNames,
  usageAnswer,
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
