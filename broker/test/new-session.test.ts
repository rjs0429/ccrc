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
const { UltracodeModels } = await import("../src/sessions/ultracode-models.ts");
const { Hub } = await import("../src/hub.ts");
const { Uploads } = await import("../src/uploads.ts");
type Audit = import("../src/audit.ts").Audit;
type Leases = import("../src/lease.ts").Leases;
type ServerMsg = import("../src/protocol.ts").ServerMsg;
type DisplayItem = import("../src/protocol.ts").DisplayItem;

const cwd = path.join(home, "work");
fs.mkdirSync(cwd, { recursive: true });
const FAKE = new URL("./fixtures/fake-claude.mjs", import.meta.url).pathname;
const config = { host: "127.0.0.1", port: 0, allowedDevices: [], allowLocal: true, claudePath: FAKE, roots: [cwd], leaseIdleMinutes: 1, sessionIdleMinutes: 1 };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
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

type Recorded = { args?: string[]; user?: string; blocks?: string[]; request?: { subtype?: string; settings?: unknown } };
const recorded = (): Recorded[] =>
  fs.existsSync(requests)
    ? fs
        .readFileSync(requests, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Recorded)
    : [];

async function until<T>(fn: () => T | undefined | false, what: string, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw Error(`timed out: ${what}`);
    await sleep(20);
  }
}

function flag(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1) ?? (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
}

// The flag settings Claude Code was started with, given inline or as a file.
function startSettings(args: string[]): Record<string, unknown> | undefined {
  const v = flag(args, "--settings");
  if (!v) return undefined;
  return JSON.parse(v.trim().startsWith("{") ? v : fs.readFileSync(v, "utf8")) as Record<string, unknown>;
}

function setup(t: { after: (fn: () => unknown) => void }) {
  fs.rmSync(requests, { force: true });
  const logged: [string, Record<string, unknown>][] = [];
  const audit = { log: (event: string, detail: Record<string, unknown>) => logged.push([event, detail]) } as unknown as Audit;
  const manager = new SessionManager(config, audit);
  manager.windowProbe = async () => undefined;
  const leases = Object.assign(new EventEmitter(), { validate: () => true }) as unknown as Leases;
  const uploads = new Uploads(fs.mkdtempSync(path.join(home, "up-")));
  const hub = new Hub(manager, leases, audit, uploads);
  const ws = new FakeSocket();
  hub.attach(ws as never, "phone", "token");
  const say = (m: Record<string, unknown>) => ws.emit("message", JSON.stringify(m));
  t.after(async () => {
    say({ t: "view", sessionId: null });
    hub.close();
    await manager.closeAll();
  });
  const started = () => ws.sent.find((m): m is Extract<ServerMsg, { t: "session_started" }> => m.t === "session_started");
  return { manager, hub, uploads, ws, say, logged, started };
}

test("a new session asked to start with Ultracode gets it as a flag setting, with effort as an option, and its first message waits for nothing", async (t) => {
  const { manager, ws, say, logged, started } = setup(t);
  say({ t: "new_session", cwd, text: "hello there", model: "sonnet", mode: "plan", effort: "high", ultracode: true, draftId: "d-1" });
  const s = await until(started, "session_started");
  assert.equal(s.draftId, "d-1", "the phone's name for the start comes back");
  await until(() => recorded().some((r) => r.user === "hello there"), "first message");
  const args = recorded().find((r) => r.args)!.args!;
  assert.equal(flag(args, "--model"), "sonnet");
  assert.equal(flag(args, "--permission-mode"), "plan");
  assert.equal(flag(args, "--effort"), "high");
  assert.deepEqual(startSettings(args), { ultracode: true });
  const order = recorded().filter((r) => r.user === "hello there" || r.request?.subtype === "apply_flag_settings");
  assert.deepEqual(order, [{ user: "hello there" }], "nothing is applied after the start and nothing holds the message");
  const owned = (manager as unknown as { owned: Map<string, { state(): { ultracode?: boolean } }> }).owned.get(s.sessionId)!;
  await until(() => owned.state().ultracode === true, "ultracode reported on");
  await sleep(100);
  const items = (await manager.snapshot(s.sessionId)).items;
  assert.ok(!items.some((i) => i.kind === "note" && i.code === "ultracode"), "no note when it went on");
  assert.deepEqual(logged.find(([e]) => e === "new_session")?.[1], { device: "phone", sessionId: s.sessionId, cwd: fs.realpathSync(cwd), ultracode: true });
  assert.ok(!ws.sent.some((m) => m.t === "error"));
});

test("without Ultracode a new session starts with no flag settings", async (t) => {
  const { say, started } = setup(t);
  say({ t: "new_session", cwd, text: "plain start", effort: "low" });
  await until(started, "session_started");
  await until(() => recorded().some((r) => r.user === "plain start"), "first message");
  const args = recorded().find((r) => r.args)!.args!;
  assert.equal(startSettings(args), undefined);
  assert.equal(flag(args, "--effort"), "low");
});

test("the conversation says so when the model could not take Ultracode at the start", async (t) => {
  const { manager, say, started } = setup(t);
  say({ t: "new_session", cwd, text: "go", model: "claude-no-ultracode-1", ultracode: true });
  const s = await until(started, "session_started");
  const note = await until(
    () => (manager as unknown as { owned: Map<string, { builder: { items: DisplayItem[] } }> }).owned.get(s.sessionId)?.builder.items.find((i) => i.kind === "note" && i.code === "ultracode"),
    "ultracode note",
  );
  assert.ok(note);
});

test("a stopped session started with Ultracode its model lacks gets the same note", async (t) => {
  const { manager } = setup(t);
  const id = "8c2f6a10-1b2c-4d3e-9f40-5a6b7c8d9e0f";
  const dir = path.join(home, ".claude", "projects", projectDirName(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const base = { sessionId: id, cwd, isSidechain: false, userType: "external", version: "2.1.296", gitBranch: "" };
  fs.writeFileSync(
    path.join(dir, `${id}.jsonl`),
    JSON.stringify({ ...base, type: "user", uuid: "8c2f6a10-0000-4000-8000-000000000001", parentUuid: null, timestamp: "2026-10-14T03:00:01.000Z", message: { role: "user", content: "hi" } }) + "\n",
  );
  manager.models = [];
  await manager.setModel(id, "claude-no-ultracode-1");
  await manager.setUltracode(id, true);
  await manager.call(id, "resume", {});
  const s = (manager as unknown as { owned: Map<string, { builder: { items: DisplayItem[] } }> }).owned.get(id)!;
  await until(() => s.builder.items.some((i) => i.kind === "note" && i.code === "ultracode"), "ultracode note");
  assert.ok(!recorded().some((r) => r.request?.subtype === "apply_flag_settings" && (r.request.settings as { ultracode?: boolean }).ultracode), "it was not asked for where the model lacks it");
});

test("a first message may carry attachments, or only attachments", async (t) => {
  const { uploads, say, logged, started } = setup(t);
  const image = await uploads.save(PNG, "photo.png", "image/png");
  say({ t: "new_session", cwd, text: "", attachments: [image.id] });
  const s = await until(started, "session_started");
  const sent = await until(() => recorded().find((r) => r.user !== undefined), "first message");
  assert.deepEqual(sent, { user: "", blocks: ["image"] });
  assert.equal(logged.find(([e]) => e === "new_session")?.[1].attachments, 1);
  assert.ok(s.sessionId);
});

test("a first message with an attachment that is gone starts nothing and names the start in the error", async (t) => {
  const { manager, ws, say, started } = setup(t);
  const before = (await manager.list()).length;
  say({ t: "new_session", cwd, text: "with photo", attachments: ["0".repeat(32)], draftId: "d-2" });
  const error = await until(() => ws.sent.find((m): m is Extract<ServerMsg, { t: "error" }> => m.t === "error"), "error");
  assert.equal(error.message, "attachment expired");
  assert.equal(error.draftId, "d-2");
  assert.equal(started(), undefined);
  assert.equal((await manager.list()).length, before);
  assert.ok(!recorded().some((r) => r.args), "no Claude Code was started");
});

test("a start asked for again with the same draftId after a reconnect starts nothing new and names the first session", async (t) => {
  const { manager, hub, ws, say, logged } = setup(t);
  const before = (await manager.list()).length;
  say({ t: "new_session", cwd, text: "only once", draftId: "d-3" });
  ws.readyState = 3;
  ws.emit("close");
  const ws2 = new FakeSocket();
  hub.attach(ws2 as never, "phone", "token");
  ws2.emit("message", JSON.stringify({ t: "new_session", cwd, text: "only once", draftId: "d-3" }));
  const s = await until(() => ws2.sent.find((m): m is Extract<ServerMsg, { t: "session_started" }> => m.t === "session_started"), "session_started");
  assert.equal(s.draftId, "d-3");
  await until(() => recorded().some((r) => r.user === "only once"), "first message");
  ws2.emit("message", JSON.stringify({ t: "new_session", cwd, text: "only once", draftId: "d-3" }));
  await until(() => ws2.sent.filter((m) => m.t === "session_started").length === 2, "second answer");
  await sleep(200);
  assert.ok(ws2.sent.filter((m) => m.t === "session_started").every((m) => m.sessionId === s.sessionId));
  assert.equal(recorded().filter((r) => r.user === "only once").length, 1, "the first message went once");
  assert.equal(recorded().filter((r) => r.args).length, 1, "one Claude Code was started");
  assert.equal(logged.filter(([e]) => e === "new_session").length, 1);
  assert.equal((await manager.list()).length, before + 1);
  ws2.emit("message", JSON.stringify({ t: "view", sessionId: null }));
});

test("a new session's fields are checked", async (t) => {
  const { ws, say } = setup(t);
  const bad = [
    { text: "x", ultracode: "yes" },
    { text: "", attachments: [] },
    { text: "x", attachments: new Array(11).fill("a") },
    { text: "x", attachments: "abc" },
    { text: "x", draftId: "../x" },
    { text: "x", mode: "bypassPermissions" },
  ];
  for (const b of bad) say({ t: "new_session", cwd, ...b });
  await until(() => ws.sent.filter((m) => m.t === "error").length === bad.length, "errors");
  assert.ok(!ws.sent.some((m) => m.t === "session_started"));
  assert.ok(!recorded().some((r) => r.args));
});

test("which models offered Ultracode is learnt from the sessions and shown with the model list", async (t) => {
  fs.rmSync(path.join(home, "state", "ultracode-models.json"), { force: true });
  const { manager, say, started } = setup(t);
  const options = [
    { value: "default", resolved: "claude-sonnet-9-9", label: "Default" },
    { value: "claude-no-ultracode-1", resolved: "claude-no-ultracode-1", label: "Old" },
    { value: "haiku", resolved: "claude-haiku-9-9", label: "Haiku" },
  ];
  manager.models = options;
  assert.ok((await manager.modelList()).every((m) => m.ultracode === undefined), "nothing is known yet");
  say({ t: "new_session", cwd, text: "a", model: "claude-sonnet-9-9[1m]" });
  await until(started, "first session");
  say({ t: "new_session", cwd, text: "b", model: "claude-no-ultracode-1" });
  await until(() => {
    const kept = new UltracodeModels(path.join(home, "state", "ultracode-models.json"));
    return kept.get("claude-sonnet-9-9") === true && kept.get("claude-no-ultracode-1") === false;
  }, "kept for the next run");
  manager.models = options;
  assert.deepEqual(
    (await manager.modelList()).map((m) => [m.value, m.ultracode]),
    [
      ["default", true],
      ["claude-no-ultracode-1", false],
      ["haiku", undefined],
    ],
  );
});

test("the kept list ignores what is not a model name and keeps the latest answer", () => {
  const file = path.join(home, "state", "uc-test.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ "claude-a": true, "--bad flag": true, "claude-b": "yes" }));
  const kept = new UltracodeModels(file);
  assert.equal(kept.get("claude-a[1m]"), true);
  assert.equal(kept.get("--bad flag"), undefined);
  assert.equal(kept.get("claude-b"), undefined);
  kept.learn("claude-a", false);
  kept.learn("--x", true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { "claude-a": false });
});
