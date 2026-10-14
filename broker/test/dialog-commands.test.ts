import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import type { DisplayItem, ServerMsg, UsageInfo } from "../src/protocol.ts";

// Sessions are found through ~/.claude, so the test runs against an empty home of its own.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccrc-home-"));
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
fs.mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });
after(() => fs.rmSync(home, { recursive: true, force: true }));

const { commandName, hideDialogCommands, isDialogCommand, parseCommand } = await import("../src/dialog-commands.ts");
const { SessionManager } = await import("../src/sessions/manager.ts");
const { probeUsage } = await import("../src/sessions/broker-session.ts");
const { projectDirName } = await import("../src/sessions/history.ts");
const { Hub } = await import("../src/hub.ts");
const { Uploads } = await import("../src/uploads.ts");

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const SID = "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const cwd = path.join(home, "ws");
fs.mkdirSync(cwd, { recursive: true });

function transcript(sessionId: string): void {
  const dir = path.join(home, ".claude", "projects", projectDirName(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const row = { parentUuid: null, isSidechain: false, userType: "external", cwd, sessionId, version: "2.1.296", type: "user", uuid: "u1" };
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    JSON.stringify({ ...row, timestamp: "2026-10-14T02:00:00.000Z", message: { role: "user", content: "hello" } }) + "\n",
  );
}

const config = { host: "127.0.0.1", port: 0, allowedDevices: [], allowLocal: true, roots: [], leaseIdleMinutes: 1, sessionIdleMinutes: 1, claudePath: FAKE };

const note = (id: string, text: string): DisplayItem => ({ kind: "note", id, code: "command", text });
const result = (id: string, name: string, args?: string): DisplayItem => ({ kind: "command", id, name, ...(args ? { args } : {}), text: "out" });

test("dialog commands are known by name and alias", () => {
  assert.equal(commandName("/cost"), "usage");
  assert.equal(commandName("allowed-tools"), "permissions");
  assert.equal(commandName("Undo"), "rewind");
  for (const name of ["context", "usage", "stats", "mcp", "status", "settings", "bashes", "effort", "model", "output-style"]) assert.ok(isDialogCommand(name), name);
  for (const name of ["compact", "clear", "init", undefined]) assert.ok(!isDialogCommand(name), String(name));
  assert.deepEqual(parseCommand(" /model  sonnet "), { name: "model", args: "sonnet" });
  assert.deepEqual(parseCommand("/usage"), { name: "usage", args: "" });
  assert.equal(parseCommand("/usr/bin is a path"), undefined);
  assert.equal(parseCommand("say /usage"), undefined);
});

test("dialog command results and the lines that ran them stay out of the conversation", () => {
  const items: DisplayItem[] = [
    { kind: "user", id: "u1", text: "hi" },
    note("n1", "/usage"),
    result("c1", "usage"),
    note("n2", "/compact"),
    result("c2", "compact"),
    note("n3", "/model sonnet"),
    result("c3", "model", "sonnet"),
    note("n4", "/plan write the tests"),
    { kind: "assistant", id: "a1", text: "planning" },
    { kind: "user", id: "u2", text: "/stats" },
    { kind: "user", id: "u3", text: "/status", images: 1 },
    result("c4", "cost"),
    { kind: "command", id: "c5", text: "no name" },
    note("n5", "/model opus"),
    { kind: "command", id: "c6", text: "Set model to Opus" },
    note("n6", "/context"),
    { kind: "command", id: "c7", text: "## Context Usage" },
    note("n7", "/compact"),
    { kind: "command", id: "c8", text: "Compacted" },
  ];
  assert.deepEqual(
    hideDialogCommands(items).map((i) => i.id),
    ["u1", "n2", "c2", "n4", "a1", "u3", "c5", "n7", "c8"],
  );
});

test("a session without a process gets plan limits without being resumed, briefly kept", async () => {
  transcript(SID);
  const manager = new SessionManager(config);
  const asked: [string, string | undefined][] = [];
  let fail = true;
  manager.usageProbe = async (dir, claudePath) => {
    asked.push([dir, claudePath]);
    if (fail) throw Error("no answer");
    return { limits: [{ kind: "session", percent: 12 }] };
  };
  await assert.rejects(manager.call(SID, "usage", {}), /no answer/);
  fail = false;
  const first = (await manager.call(SID, "usage", {})) as UsageInfo;
  const again = (await manager.call(SID, "usage", {})) as UsageInfo;
  assert.deepEqual(first, { limits: [{ kind: "session", percent: 12 }] });
  assert.deepEqual(again, first);
  assert.deepEqual(asked, [
    [cwd, FAKE],
    [cwd, FAKE],
  ]);
  assert.equal(manager.isControlled(SID), false, "asking for usage does not take the session over");
  await manager.closeAll();
});

test("resume starts the session's process, which then answers for itself", async () => {
  const id = "7b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
  transcript(id);
  const manager = new SessionManager(config);
  manager.usageProbe = async () => assert.fail("a running session answers itself");
  assert.deepEqual(await manager.call(id, "resume", {}), {});
  assert.equal(manager.isControlled(id), true);
  const usage = (await manager.call(id, "usage", {})) as UsageInfo;
  assert.equal(usage.limits.find((l) => l.kind === "session")?.percent, 32);
  assert.equal(usage.session?.costUsd, 0.25);
  await manager.closeAll();
});

test("the usage probe reads plan limits from a process of its own", async () => {
  const usage = await probeUsage(cwd, FAKE);
  assert.deepEqual(
    usage.limits.map((l) => [l.kind, l.percent]),
    [
      ["session", 32],
      ["weekly_all", 91],
      ["weekly_scoped", 0],
    ],
  );
  assert.equal(usage.session, undefined);
});

test("a probe runs with the user's settings env and auto-compact window but not their hooks", async () => {
  const settings = path.join(home, ".claude", "settings.json");
  const requests = path.join(home, "probe-requests.jsonl");
  fs.writeFileSync(
    settings,
    JSON.stringify({
      env: { FAKE_REQUESTS: requests, CCRC_PROBE_NUMBER: 3 },
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "false" }] }] },
      remoteControlAtStartup: true,
      autoCompactWindow: 400_000,
      modelSettings: { "claude-test": { effortLevel: "high", autoCompactWindow: 300_000 } },
    }),
  );
  try {
    await probeUsage(cwd, FAKE);
    const { args } = JSON.parse(fs.readFileSync(requests, "utf8").split("\n")[0]) as { args: string[] };
    const flag = JSON.parse(args[args.indexOf("--settings") + 1]);
    assert.deepEqual(flag, { autoCompactWindow: 400_000, modelSettings: { "claude-test": { autoCompactWindow: 300_000 } } });
    assert.ok(args.includes("--setting-sources="), "no settings file is loaded");
  } finally {
    fs.rmSync(settings);
    fs.rmSync(requests, { force: true });
  }
});

test("plan limits that come back empty are not kept", async () => {
  transcript(SID);
  const manager = new SessionManager(config);
  let asks = 0;
  manager.usageProbe = async () => (asks++ ? { limits: [{ kind: "session", percent: 12 }] } : { limits: [] });
  assert.deepEqual(await manager.call(SID, "usage", {}), { limits: [] });
  assert.deepEqual(await manager.call(SID, "usage", {}), { limits: [{ kind: "session", percent: 12 }] });
  assert.deepEqual(await manager.call(SID, "usage", {}), { limits: [{ kind: "session", percent: 12 }] });
  assert.equal(asks, 2);
  await manager.closeAll();
});

test("a resume from the phone is audited and the viewed session is shown again", async () => {
  class FakeSocket extends EventEmitter {
    readonly OPEN = 1;
    readyState = 1;
    sent: ServerMsg[] = [];
    send(data: string): void {
      this.sent.push(JSON.parse(data) as ServerMsg);
    }
    ping(): void {}
    close(): void {}
    terminate(): void {}
  }
  let controlled = false;
  const manager = Object.assign(new EventEmitter(), {
    setViewed() {},
    isControlled: () => controlled,
    snapshot: async (sessionId: string) => ({ items: [], pending: [], hasMore: false, state: { sessionId, cwd: "/", state: controlled ? "owned" : "inactive", busy: false } }),
    watch: () => () => {},
    call: async (_id: string, op: string) => {
      if (op === "resume") controlled = true;
      return {};
    },
  });
  const logged: [string, Record<string, unknown>][] = [];
  const audit = { log: (event: string, detail: Record<string, unknown>) => void logged.push([event, detail]) };
  const leases = Object.assign(new EventEmitter(), { validate: () => true });
  const hub = new Hub(manager as never, leases as never, audit as never, new Uploads(fs.mkdtempSync(path.join(home, "up-"))));
  const ws = new FakeSocket();
  hub.attach(ws as never, "phone", "token");
  ws.emit("message", JSON.stringify({ t: "view", sessionId: SID }));
  await new Promise((r) => setTimeout(r, 20));
  ws.emit("message", JSON.stringify({ t: "call", id: 1, sessionId: SID, op: "resume", args: {} }));
  await new Promise((r) => setTimeout(r, 20));
  const snaps = ws.sent.filter((m): m is Extract<ServerMsg, { t: "snapshot" }> => m.t === "snapshot");
  assert.deepEqual(
    snaps.map((s) => s.state.state),
    ["inactive", "owned"],
  );
  assert.deepEqual(ws.sent.find((m) => m.t === "call_result"), { t: "call_result", id: 1, ok: true, data: {} });
  assert.deepEqual(logged, [["call", { device: "phone", sessionId: SID, op: "resume" }]]);
  hub.close();
});
