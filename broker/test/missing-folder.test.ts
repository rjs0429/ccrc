import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The manager reads ~/.claude and would start the fake CLI, which records that it was started.
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
type Leases = import("../src/lease.ts").Leases;
type Audit = import("../src/audit.ts").Audit;
type ServerMsg = import("../src/protocol.ts").ServerMsg;

const GONE = "8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const HERE = "9b2c3d4e-5f60-4b7c-8d9e-0f1a2b3c4d5e";
const FILE = "7c3d4e5f-6071-4c8d-9eaf-1a2b3c4d5e6f";
const MOVED = "6d4e5f60-7182-4d9e-8fb0-2b3c4d5e6f70";
const VANISH = "5e5f6071-8293-4eaf-9fc1-3c4d5e6f7081";
const gone = path.join(home, "gone");
const vanish = path.join(home, "vanish");
const here = path.join(home, "here");
const file = path.join(home, "file");
const FAKE = new URL("./fixtures/fake-claude.mjs", import.meta.url).pathname;
const config = { host: "127.0.0.1", port: 0, allowedDevices: [], allowLocal: true, claudePath: FAKE, roots: [], leaseIdleMinutes: 1, sessionIdleMinutes: 1 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function writeTranscript(sessionId: string, cwd: string, under = cwd): void {
  const dir = path.join(home, ".claude", "projects", projectDirName(under));
  fs.mkdirSync(dir, { recursive: true });
  const row = { sessionId, cwd, isSidechain: false, userType: "external", version: "2.1.296", type: "user", uuid: `${sessionId.slice(0, 8)}-0000-4000-8000-000000000001`, parentUuid: null };
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), JSON.stringify({ ...row, timestamp: "2026-10-14T03:00:01.000Z", message: { role: "user", content: "hello" } }) + "\n");
}

fs.mkdirSync(here, { recursive: true });
fs.writeFileSync(file, "not a folder\n");
writeTranscript(GONE, gone);
writeTranscript(HERE, here);
writeTranscript(FILE, file);
writeTranscript(MOVED, path.join(home, "renamed"), here);
fs.mkdirSync(vanish);
writeTranscript(VANISH, vanish);

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

const started = () => fs.existsSync(requests) && fs.readFileSync(requests, "utf8").includes('"args"');

test("a session whose working folder is gone is listed and shown as such and never started", async () => {
  const manager = new SessionManager(config);
  manager.windowProbe = async () => undefined;
  const listed = await manager.list();
  assert.equal(listed.find((s) => s.id === GONE)?.folderMissing, true);
  assert.equal(listed.find((s) => s.id === FILE)?.folderMissing, true, "a file where the folder was is no folder");
  assert.equal(listed.find((s) => s.id === HERE)?.folderMissing, undefined);
  assert.equal((await manager.snapshot(GONE)).state.folderMissing, true);
  assert.equal((await manager.snapshot(HERE)).state.folderMissing, undefined);

  await assert.rejects(manager.call(GONE, "resume", {}), { message: `working folder is missing: ${gone}` });
  await assert.rejects(manager.send(GONE, "hello"), { message: `working folder is missing: ${gone}` });
  await assert.rejects(manager.call(FILE, "resume", {}), { message: `working folder is missing: ${file}` });
  assert.equal(manager.isControlled(GONE), false);
  await sleep(200);
  assert.equal(started(), false, "Claude Code was not started");
  await manager.closeAll();
});

test("the plan limits of such a session are asked from a folder that exists", async () => {
  const manager = new SessionManager(config);
  const asked: string[] = [];
  manager.usageProbe = async (cwd) => (asked.push(cwd), { limits: [{ kind: "session", percent: 5 }] });
  assert.deepEqual(await manager.call(GONE, "usage", {}), { limits: [{ kind: "session", percent: 5 }] });
  assert.deepEqual(asked, [os.homedir()]);
  await manager.closeAll();
});

test("a message to such a session from the phone comes back as an error naming the folder", async (t) => {
  const manager = new SessionManager(config);
  manager.windowProbe = async () => undefined;
  const logged: string[] = [];
  const audit = { log: (event: string) => logged.push(event) } as unknown as Audit;
  const leases = Object.assign(new EventEmitter(), { validate: () => true }) as unknown as Leases;
  const hub = new Hub(manager, leases, audit, new Uploads(fs.mkdtempSync(path.join(home, "up-"))));
  const ws = new FakeSocket();
  hub.attach(ws as never, "phone", "token");
  t.after(async () => {
    hub.close();
    await manager.closeAll();
  });
  ws.emit("message", JSON.stringify({ t: "send", sessionId: GONE, text: "/compact" }));
  for (let i = 0; i < 100 && !ws.sent.some((m) => m.t === "error"); i++) await sleep(20);
  const error = ws.sent.find((m): m is Extract<ServerMsg, { t: "error" }> => m.t === "error");
  assert.equal(error?.message, `working folder is missing: ${gone}`);
  assert.equal(manager.isControlled(GONE), false);
  assert.equal(started(), false);
});

test("a moved transcript whose recorded folder is gone resumes in the folder it was moved to and is not flagged", async () => {
  const manager = new SessionManager(config);
  manager.windowProbe = async () => undefined;
  assert.equal((await manager.list()).find((s) => s.id === MOVED)?.folderMissing, undefined);
  assert.equal((await manager.snapshot(MOVED)).state.folderMissing, undefined);
  await manager.closeAll();
});

test("a session whose folder goes away while it runs is shown without its folder once it stops", async () => {
  const manager = new SessionManager(config);
  manager.windowProbe = async () => undefined;
  const states: { folderMissing?: boolean; state: string }[] = [];
  manager.on("event", (id: string, m: ServerMsg) => id === VANISH && m.t === "state" && states.push(m.state));
  await manager.call(VANISH, "resume", {});
  fs.rmSync(vanish, { recursive: true });
  await manager.release(VANISH);
  for (let i = 0; i < 100 && !states.some((s) => s.folderMissing); i++) await sleep(20);
  assert.equal(states.at(-1)?.state, "inactive");
  assert.equal(states.at(-1)?.folderMissing, true);
  await manager.closeAll();
});
