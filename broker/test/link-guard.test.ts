import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
process.env.CCRC_STATE_DIR = path.join(home, "state");
fs.mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });

const { guarded, lineKind } = await import("../src/link/guard.ts");
const { LinkServer } = await import("../src/link/server.ts");
const { SessionManager } = await import("../src/sessions/manager.ts");
const { WrappedSession } = await import("../src/sessions/wrapped.ts");

type Msg = Record<string, unknown>;
const SID = "0000f00d-0000-4000-8000-00000000f00d";
const config = { host: "127.0.0.1", port: 0, allowedDevices: [], allowLocal: true, roots: [], leaseIdleMinutes: 1, sessionIdleMinutes: 1 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const servers: InstanceType<typeof LinkServer>[] = [];
after(async () => {
  for (const s of servers) await s.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const until = async (fn: () => boolean, label: string) => {
  for (let i = 0; i < 250 && !fn(); i++) await sleep(20);
  assert.ok(fn(), label);
};

// A manager behind a link server, and a wrapper connected to it that has said hello for SID.
async function wrapper() {
  const manager = new SessionManager(config);
  const server = new LinkServer(path.join(tempDir("ccrc-link-"), "link.sock"));
  servers.push(server);
  server.on("link", (link) => manager.attachLink(link));
  await server.listen();
  const sock = net.createConnection(server.socketPath);
  await new Promise((r) => sock.once("connect", r));
  sock.on("error", () => {});
  const send = (frame: Msg) => sock.write(JSON.stringify(frame) + "\n");
  send({ t: "hello", v: 1, wpid: 990001, cwd: home, args: ["--resume", SID], sessionId: SID, caps: ["claude_push", "mcp_auth"] });
  await until(() => manager.isControlled(SID), "the session is attached");
  const texts = () => manager.controlledSession(SID)?.builder.items.map((i) => ("text" in i ? i.text : undefined)) ?? [];
  return { manager, send, texts, sock };
}

// Well-formed lines of each kind Claude Code writes, as in a broker test of odd values.
const base = { session_id: SID, parent_tool_use_id: null };
const SAMPLES: Msg[] = [
  { type: "system", subtype: "init", ...base, model: "m", cwd: "/tmp", tools: ["Bash"], permissionMode: "default", slash_commands: ["help"] },
  { type: "assistant", ...base, message: { id: "m1", model: "m", content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }, { type: "thinking", thinking: "x" }] } },
  { type: "user", ...base, message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "out" }], is_error: false }] }, tool_use_result: { stdout: "out" } },
  { type: "user", ...base, message: { content: [{ type: "tool_result", tool_use_id: "tu4", content: "ok" }] }, tool_use_result: { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }], filePath: "/x/a.ts" } },
  { type: "stream_event", ...base, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "t" } } },
  { type: "stream_event", ...base, event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } },
  { type: "result", subtype: "error_during_execution", ...base, is_error: true, result: "no", errors: ["e"], usage: { input_tokens: 1 } },
  { type: "system", subtype: "local_command", ...base, content: "<local-command-stdout>x</local-command-stdout>" },
  { type: "system", subtype: "task_notification", ...base, task_id: "t1", tool_use_id: "tu1", status: "completed", usage: { tool_uses: 2 } },
  { type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "rm x" }, tool_use_id: "tu9" } },
];
const ODD: unknown[] = [null, "x", 7, [], [null], {}, { type: null }, true];

// Each sample with one field at a time, at any depth, replaced by each odd value; "type" at the top stays.
function* variants(v: unknown, at: string[] = []): Generator<[string[], unknown]> {
  if (v === null || typeof v !== "object") return;
  for (const k of Object.keys(v)) {
    if (k === "type" && at.length === 0) continue;
    for (const o of ODD) yield [[...at, k], o];
    yield* variants((v as Msg)[k], [...at, k]);
  }
}

function put(v: Msg, at: string[], value: unknown): Msg {
  const copy = structuredClone(v);
  let p = copy as Record<string, unknown>;
  for (const k of at.slice(0, -1)) p = p[k] as Record<string, unknown>;
  p[at.at(-1)!] = value;
  return copy;
}

test("lines of an unexpected shape are taken without the broker failing, and the next good line is handled", async () => {
  const { send, texts } = await wrapper();
  const errors: string[] = [];
  const error = console.error;
  console.error = (line: string) => errors.push(line);
  let sent = 0;
  try {
    for (const s of SAMPLES) {
      for (const [at, value] of variants(s)) {
        // A line naming another session would move the link to it.
        if (at[0] === "session_id") continue;
        send({ m: put({ ...s, uuid: randomUUID() }, at, value), t: "out" });
        send({ m: { type: "user", uuid: randomUUID(), message: { content: value } }, t: "in" });
        sent++;
      }
    }
    assert.ok(sent > 500, `sent ${sent}`);
    send({ m: { type: "assistant", ...base, uuid: randomUUID(), message: { content: [{ type: "text", text: "after the odd lines" }] } }, t: "out" });
    await until(() => texts().includes("after the odd lines"), "the good line is handled");
  } finally {
    console.error = error;
  }
  assert.deepEqual(errors, [], "the conversation's items are built from them without an error");
});

test("a line whose handling throws is dropped, logged by its kind once a minute, and the lines after it go on", async () => {
  const { manager, send, texts } = await wrapper();
  const s = manager.controlledSession(SID) as InstanceType<typeof WrappedSession>;
  const errors: string[] = [];
  const error = console.error;
  console.error = (line: string) => errors.push(line);
  const onOut = s.onOut.bind(s);
  s.onOut = (m: Msg, at?: string) => {
    if (m.boom) throw new TypeError("Cannot read properties of null (reading 'text')");
    onOut(m, at);
  };
  try {
    for (const n of [1, 2, 3]) send({ m: { type: "assistant", subtype: "x", boom: n, message: { content: [{ type: "text", text: "secret words" }] } }, t: "out" });
    send({ m: { type: "assistant", ...base, uuid: randomUUID(), message: { content: [{ type: "text", text: "still here" }] } }, t: "out" });
    await until(() => texts().includes("still here"), "the line after them is handled");
  } finally {
    console.error = error;
  }
  assert.equal(errors.length, 1, errors.join("\n"));
  assert.match(errors[0], /^ccrc: dropped a line from a wrapper \(out:assistant\/x\): TypeError: Cannot read properties of null \(reading 'text'\) at link-guard\.test\.ts:\d+:\d+$/);
  assert.doesNotMatch(errors[0], /secret/, "nothing of the line itself");
});

test("the guard logs a kind again after a minute with how many it dropped meanwhile, and names kinds without their content", () => {
  const logs: string[] = [];
  const boom = () => {
    throw Error("first line\nsecond line");
  };
  const t0 = 1_000_000_000_000;
  const kind = "test:guard";
  assert.equal(
    guarded(kind, () => {}, (l) => logs.push(l), t0),
    true,
  );
  assert.equal(guarded(kind, boom, (l) => logs.push(l), t0), false);
  assert.equal(guarded(kind, boom, (l) => logs.push(l), t0 + 30_000), false);
  assert.equal(guarded(kind, boom, (l) => logs.push(l), t0 + 59_000), false);
  assert.equal(guarded(kind, boom, (l) => logs.push(l), t0 + 61_000), false);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /^ccrc: dropped a line from a wrapper \(test:guard\): Error: first line at /);
  assert.match(logs[1], /; 2 more since$/);
  assert.equal(lineKind("out", { type: "system", subtype: "init" }), "out:system/init");
  assert.equal(lineKind("out", { type: "a b c", subtype: { x: 1 } }), "out:?/?");
  assert.equal(lineKind("in", 7), "in");
  assert.equal(lineKind({ t: 1 }), "?");
});

test("lines held until the conversation so far is read are replayed one by one, an odd one dropped", async () => {
  const server = new LinkServer(path.join(tempDir("ccrc-link-"), "link.sock"));
  servers.push(server);
  await server.listen();
  const linked = new Promise<import("../src/link/server.ts").Link>((resolve) => server.once("link", resolve));
  const sock = net.createConnection(server.socketPath);
  await new Promise((r) => sock.once("connect", r));
  const link = await linked;
  const hello = new Promise((r) => link.once("hello", r));
  sock.write(JSON.stringify({ t: "hello", v: 1, wpid: 990002, cwd: home, args: [], sessionId: SID }) + "\n");
  await hello;
  const s = new WrappedSession(link, SID, home);
  const onOut = s.onOut.bind(s);
  let replaying = false;
  s.onOut = (m: Msg, at?: string) => {
    if (replaying && m.boom) throw Error("boom");
    onOut(m, at);
  };
  const outs = new Promise<void>((resolve) => {
    let n = 0;
    link.on("out", (m: Msg) => {
      s.onOut(m);
      if (++n === 2) resolve();
    });
  });
  const errors: string[] = [];
  const error = console.error;
  console.error = (line: string) => errors.push(line);
  try {
    sock.write(JSON.stringify({ m: { type: "assistant", boom: 1, message: { content: [] } }, t: "out" }) + "\n");
    sock.write(JSON.stringify({ m: { type: "assistant", ...base, uuid: randomUUID(), message: { content: [{ type: "text", text: "held" }] } }, t: "out" }) + "\n");
    await outs;
    assert.equal(s.builder.items.length, 0, "held until seeded");
    replaying = true;
    s.seed([]);
  } finally {
    console.error = error;
  }
  assert.deepEqual(
    s.builder.items.map((i) => ("text" in i ? i.text : i.kind)),
    ["held"],
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /\(out:assistant\): Error: boom/);
  sock.destroy();
});
