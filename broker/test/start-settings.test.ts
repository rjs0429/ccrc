import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The manager reads ~/.claude and starts the fake CLI, which records what it was asked.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccrc-home-"));
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
type Audit = import("../src/audit.ts").Audit;
type Leases = import("../src/lease.ts").Leases;
type ServerMsg = import("../src/protocol.ts").ServerMsg;

const S = "3b9e2f10-4c5d-4e6f-8a7b-9c0d1e2f3a4b";
const T = "4c0f3a21-5d6e-4f70-9b8c-0d1e2f3a4b5c";
const U = "5d1a4b32-6e7f-4081-8c9d-1e2f3a4b5c6d";
const cwd = path.join(home, "work");
const FAKE = new URL("./fixtures/fake-claude.mjs", import.meta.url).pathname;
const config = { host: "127.0.0.1", port: 0, allowedDevices: [], allowLocal: true, claudePath: FAKE, roots: [], leaseIdleMinutes: 1, sessionIdleMinutes: 1 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function writeTranscript(sessionId: string, model: string): void {
  const dir = path.join(home, ".claude", "projects", projectDirName(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const base = { sessionId, cwd, isSidechain: false, userType: "external", version: "2.1.296", gitBranch: "main" };
  const rows = [
    { ...base, type: "user", uuid: `${sessionId.slice(0, 8)}-0000-4000-8000-000000000001`, parentUuid: null, timestamp: "2026-10-14T03:00:01.000Z", message: { role: "user", content: "hello" } },
    {
      ...base,
      type: "assistant",
      uuid: `${sessionId.slice(0, 8)}-0000-4000-8000-000000000002`,
      parentUuid: `${sessionId.slice(0, 8)}-0000-4000-8000-000000000001`,
      timestamp: "2026-10-14T03:00:02.000Z",
      message: { id: "msg_1", role: "assistant", model, type: "message", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 7000, cache_read_input_tokens: 50_000, output_tokens: 0 } },
    },
  ];
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

fs.mkdirSync(cwd, { recursive: true });
writeTranscript(S, "claude-test-1");
writeTranscript(T, "claude-test-2");
writeTranscript(U, "claude-test-1");

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

const recorded = (): Record<string, unknown>[] =>
  fs.existsSync(requests)
    ? fs
        .readFileSync(requests, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];

test("choices for a stopped session are kept, shown, audited, applied when the broker starts it and then dropped", async (t) => {
  const logged: [string, Record<string, unknown>][] = [];
  const audit = { log: (event: string, detail: Record<string, unknown>) => logged.push([event, detail]) } as unknown as Audit;
  const manager = new SessionManager(config, audit);
  manager.windowProbe = async () => ({ max: 100_000, autoCompactAt: 67_000 });
  const leases = Object.assign(new EventEmitter(), { validate: () => true }) as unknown as Leases;
  const hub = new Hub(manager, leases, audit, new Uploads(fs.mkdtempSync(path.join(home, "up-"))));
  const ws = new FakeSocket();
  hub.attach(ws as never, "phone", "token");
  const say = (m: Record<string, unknown>) => ws.emit("message", JSON.stringify(m));
  t.after(async () => {
    say({ t: "view", sessionId: null });
    hub.close();
    await manager.closeAll();
  });

  say({ t: "view", sessionId: S });
  say({ t: "set_model", sessionId: S, model: "sonnet" });
  say({ t: "set_mode", sessionId: S, mode: "plan" });
  say({ t: "set_effort", sessionId: S, effort: "high" });
  say({ t: "set_ultracode", sessionId: S, on: true });
  say({ t: "set_mode", sessionId: S, mode: "bypassPermissions" });
  say({ t: "set_model", sessionId: S, model: "--dangerously-skip-permissions" });
  for (let i = 0; i < 100 && manager.startSettings(S)?.ultracode !== true; i++) await sleep(20);
  await sleep(100);

  assert.deepEqual(manager.startSettings(S), { model: "sonnet", mode: "plan", effort: "high", ultracode: true });
  const errors = ws.sent.filter((m) => m.t === "error").map((m) => (m as { message: string }).message);
  assert.deepEqual(errors.sort(), ["invalid mode", "unknown model"]);
  await assert.rejects(manager.setMode(S, "bypassPermissions" as never), /not available remotely/);
  assert.deepEqual(
    logged.filter(([e]) => e.startsWith("set_")).map(([e, d]) => [e, d.start]),
    [
      ["set_model", true],
      ["set_mode", true],
      ["set_effort", true],
      ["set_ultracode", true],
      ["set_model", true],
    ],
  );
  const shown = ws.sent.filter((m): m is Extract<ServerMsg, { t: "state" }> => m.t === "state" && m.sessionId === S).at(-1);
  assert.deepEqual(shown?.state.start, { model: "sonnet", mode: "plan", effort: "high", ultracode: true });
  assert.equal(shown?.state.state, "inactive");

  await manager.call(S, "resume", {});
  for (let i = 0; i < 150 && !recorded().some((r) => (r.request as { subtype?: string })?.subtype === "apply_flag_settings"); i++) await sleep(20);
  const args = recorded().find((r) => r.args)?.args as string[];
  const flag = (name: string) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1) ?? (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  assert.equal(flag("--model"), "sonnet");
  assert.equal(flag("--permission-mode"), "plan");
  assert.equal(flag("--resume"), S);
  assert.equal(flag("--effort"), undefined, "effort goes as a control request once Claude Code runs");
  const flags = recorded()
    .map((r) => r.request as { subtype?: string; settings?: unknown } | undefined)
    .filter((r) => r?.subtype === "apply_flag_settings");
  assert.deepEqual(flags.map((r) => r!.settings), [{ effortLevel: "high", ultracode: true }]);
  assert.equal(manager.startSettings(S), undefined, "used once, then dropped");
  assert.deepEqual(logged.find(([e]) => e === "start_settings")?.[1], { sessionId: S, model: "sonnet", mode: "plan", effort: "high", ultracode: true });
  const snap = await manager.snapshot(S);
  assert.equal(snap.state.state, "owned");
  assert.equal(snap.state.start, undefined);
  assert.equal(snap.state.permissionMode, "plan");

  say({ t: "set_effort", sessionId: S, effort: "low" });
  await sleep(200);
  assert.equal(logged.at(-1)?.[1].start, undefined, "a running session changes at once");
});

test("a message that starts a session goes out after the effort it starts with is applied", async () => {
  const manager = new SessionManager(config);
  manager.windowProbe = async () => undefined;
  fs.rmSync(requests, { force: true });
  await manager.setEffort(U, "max");
  await manager.send(U, "hello there");
  for (let i = 0; i < 150 && !recorded().some((r) => r.user === "hello there"); i++) await sleep(20);
  const order = recorded()
    .filter((r) => r.user === "hello there" || (r.request as { subtype?: string })?.subtype === "apply_flag_settings")
    .map((r) => (r.user ? "user" : (r.request as { settings?: unknown }).settings));
  assert.deepEqual(order, [{ effortLevel: "max" }, "user"]);
  await manager.closeAll();
});

test("a stopped session's gauge comes from its transcript and the window asked of Claude Code once per model", async () => {
  const manager = new SessionManager(config);
  let probes = 0;
  manager.windowProbe = async (_cwd, model) => (probes++, model === "claude-test-2" ? { max: 100_000, autoCompactAt: 67_000 } : undefined);
  const states: ServerMsg[] = [];
  manager.on("event", (_id: string, m: ServerMsg) => states.push(m));
  const first = await manager.snapshot(T);
  assert.equal(first.state.context, undefined, "the window is not known yet");
  for (let i = 0; i < 50 && !states.length; i++) await sleep(10);
  const later = states.find((m): m is Extract<ServerMsg, { t: "state" }> => m.t === "state");
  assert.deepEqual(later?.state.context, { percent: 57, tokens: 57_000, max: 100_000, autoCompactAt: 67_000, last: true });
  assert.deepEqual((await manager.snapshot(T)).state.context, later?.state.context);
  assert.equal(probes, 1);
  await manager.closeAll();
});

test("the model list is asked of Claude Code once before any session reports it, and kept for the next run", async () => {
  fs.rmSync(path.join(home, "state", "models.json"), { force: true });
  const manager = new SessionManager(config);
  let probes = 0;
  manager.modelProbe = async () => (probes++, [{ value: "default", displayName: "Default", description: "" }, { value: "haiku", displayName: "Haiku", description: "fast", supportedEffortLevels: ["low", "high"] }]);
  const [a, b] = await Promise.all([manager.modelList(), manager.modelList()]);
  assert.equal(probes, 1);
  assert.deepEqual(a, b);
  assert.deepEqual(
    a.map((m) => [m.value, m.label, m.efforts]),
    [
      ["default", "Default", undefined],
      ["haiku", "Haiku", ["low", "high"]],
    ],
  );
  await assert.rejects(manager.setModel(T, "sonnet"), /unknown model/, "a stopped session takes only a model Claude Code offers");
  await manager.setModel(T, "haiku");
  assert.equal(manager.startSettings(T)?.model, "haiku");
  const next = new SessionManager(config);
  next.modelProbe = async () => (probes++, []);
  assert.deepEqual(await next.modelList(), a);
  assert.equal(probes, 1);
  await manager.closeAll();
  await next.closeAll();
});
