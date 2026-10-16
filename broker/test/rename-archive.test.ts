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
const sessionsDir = path.join(home, ".claude", "sessions");
fs.mkdirSync(sessionsDir, { recursive: true });

const { SessionManager } = await import("../src/sessions/manager.ts");
const { projectDirName } = await import("../src/sessions/history.ts");
const { Hub } = await import("../src/hub.ts");
const { Uploads } = await import("../src/uploads.ts");
type Audit = import("../src/audit.ts").Audit;
type Leases = import("../src/lease.ts").Leases;
type ServerMsg = import("../src/protocol.ts").ServerMsg;

const cwd = path.join(home, "work");
fs.mkdirSync(cwd, { recursive: true });
const project = path.join(home, ".claude", "projects", projectDirName(cwd));
const FAKE = new URL("./fixtures/fake-claude.mjs", import.meta.url).pathname;
const config = { host: "127.0.0.1", port: 0, allowedDevices: [], allowLocal: true, claudePath: FAKE, roots: [cwd], leaseIdleMinutes: 1, sessionIdleMinutes: 1 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const nextId = () => `5e5e5e5e-0000-4000-8000-${String(++n).padStart(12, "0")}`;

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

type Recorded = { args?: string[]; user?: string; request?: Record<string, unknown> };
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

// A stopped session's transcript with one exchange.
function transcript(sessionId: string, first = "첫 질문"): string {
  const file = path.join(project, `${sessionId}.jsonl`);
  const base = { sessionId, cwd, isSidechain: false, userType: "external", version: "2.1.296" };
  const u = `${sessionId.slice(0, 8)}-1111-4000-8000-000000000001`;
  const rows = [
    { ...base, type: "user", uuid: u, parentUuid: null, timestamp: "2026-10-16T01:00:00Z", message: { role: "user", content: first } },
    {
      ...base,
      type: "assistant",
      uuid: `${sessionId.slice(0, 8)}-1111-4000-8000-000000000002`,
      parentUuid: u,
      timestamp: "2026-10-16T01:00:01Z",
      message: { id: "msg_1", role: "assistant", model: "fake", type: "message", content: [{ type: "text", text: "답" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } },
    },
  ];
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r) + "\n").join(""));
  return file;
}

const titleRows = (file: string) =>
  fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.includes('"custom-title"') || l.includes('"agent-name"'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);

// Registers this test process as a terminal Claude Code process that holds `sessionId`.
function holdElsewhere(sessionId: string): () => void {
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const procStart = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  const file = path.join(sessionsDir, `${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, sessionId, cwd, procStart, entrypoint: "cli" }));
  return () => fs.rmSync(file, { force: true });
}

function setup(t: { after: (fn: () => unknown) => void }) {
  fs.rmSync(requests, { force: true });
  const logged: [string, Record<string, unknown>][] = [];
  const audit = { log: (event: string, detail: Record<string, unknown>) => logged.push([event, detail]) } as unknown as Audit;
  const manager = new SessionManager(config, audit);
  manager.windowProbe = async () => undefined;
  const leases = Object.assign(new EventEmitter(), { validate: () => true }) as unknown as Leases;
  const hub = new Hub(manager, leases, audit, new Uploads(fs.mkdtempSync(path.join(home, "up-"))));
  const ws = new FakeSocket();
  hub.attach(ws as never, "phone", "token");
  const say = (m: Record<string, unknown>) => ws.emit("message", JSON.stringify(m));
  let seq = 0;
  // A call as the phone makes it, answered with its call_result.
  const call = async (sessionId: string, op: string, args: Record<string, unknown>, ms = 10_000) => {
    const id = ++seq;
    say({ t: "call", id, sessionId, op, args });
    return until(() => ws.sent.find((m): m is Extract<ServerMsg, { t: "call_result" }> => m.t === "call_result" && m.id === id), `${op} answered`, ms);
  };
  let changed = 0;
  manager.on("changed", () => changed++);
  t.after(async () => {
    say({ t: "view", sessionId: null });
    hub.close();
    await manager.closeAll();
  });
  return { manager, hub, ws, say, call, logged, changed: () => changed };
}

test("a stopped session is renamed in its transcript without starting Claude Code", async (t) => {
  const { manager, call, logged } = setup(t);
  const sid = nextId();
  const file = transcript(sid);
  const r = await call(sid, "rename", { title: `  고친 이름\n둘째 줄  ` });
  assert.deepEqual(r, { t: "call_result", id: 1, ok: true, data: { title: "고친 이름 둘째 줄" } });
  assert.deepEqual(titleRows(file), [{ type: "custom-title", customTitle: "고친 이름 둘째 줄", sessionId: sid }]);
  assert.equal(fs.readFileSync(path.join(project, sid, "custom-title.json"), "utf8"), '{"customTitle":"고친 이름 둘째 줄"}');
  assert.equal((await manager.list()).find((s) => s.id === sid)?.title, "고친 이름 둘째 줄");
  assert.equal((await manager.snapshot(sid)).state.title, "고친 이름 둘째 줄");
  assert.deepEqual(recorded(), [], "no Claude Code process was started");
  assert.ok(!manager.isControlled(sid));
  assert.deepEqual(logged, [["call", { device: "phone", sessionId: sid, op: "rename", chars: 10 }]], "the audit log has the length, not the name");
});

test("a name that cleans to nothing, a missing one and an unknown session are refused", async (t) => {
  const { call } = setup(t);
  const sid = nextId();
  const file = transcript(sid);
  assert.equal((await call(sid, "rename", { title: ` ${String.fromCodePoint(0x200b)}\n ` })).error, "title must be non-empty");
  assert.equal((await call(sid, "rename", {})).error, "invalid request");
  assert.equal((await call(sid, "rename", { title: "x".repeat(2001) })).error, "invalid request");
  assert.equal((await call(nextId(), "rename", { title: "이름" })).error, "unknown session");
  assert.deepEqual(titleRows(file), []);
});

test("a session open in a terminal keeps its name", async (t) => {
  const { call } = setup(t);
  const sid = nextId();
  const file = transcript(sid);
  const release = holdElsewhere(sid);
  try {
    assert.equal((await call(sid, "rename", { title: "바꿀 수 없음" })).error, "cannot rename while open in Terminal");
  } finally {
    release();
  }
  assert.deepEqual(titleRows(file), []);
});

test("a running session is renamed by its Claude Code process, which announces the name", async (t) => {
  const { manager, ws, say, call, changed } = setup(t);
  const sid = nextId();
  const file = transcript(sid, "원래 질문");
  say({ t: "view", sessionId: sid });
  assert.equal((await call(sid, "resume", {})).ok, true);
  await until(() => recorded().some((r) => r.request?.subtype === "initialize"), "Claude Code started");
  const before = (await manager.snapshot(sid)).items.length;
  const changes = changed();
  const r = await call(sid, "rename", { title: "실행 중 이름" });
  assert.deepEqual(r.data, { title: "실행 중 이름" });
  assert.deepEqual(
    recorded().filter((x) => x.request?.subtype === "rename_session").map((x) => x.request),
    [{ subtype: "rename_session", title: "실행 중 이름", source: "host", session_id: sid }],
  );
  assert.deepEqual(titleRows(file), [
    { type: "custom-title", customTitle: "실행 중 이름", sessionId: sid },
    { type: "agent-name", agentName: "실행 중 이름", sessionId: sid },
  ]);
  const state = await until(() => ws.sent.findLast((m): m is Extract<ServerMsg, { t: "state" }> => m.t === "state" && m.state.title === "실행 중 이름"), "state with the name");
  assert.equal(state.state.state, "owned");
  assert.equal((await manager.list()).find((s) => s.id === sid)?.title, "실행 중 이름");
  assert.ok(changed() > changes, "the list is told");
  assert.equal((await manager.snapshot(sid)).items.length, before, "nothing lands in the conversation");
});

test("a running session lists the transcript's name, which a name given elsewhere reaches first", async (t) => {
  const { manager, call } = setup(t);
  const sid = nextId();
  const file = transcript(sid);
  fs.appendFileSync(file, JSON.stringify({ type: "custom-title", customTitle: "처음 이름", sessionId: sid }) + "\n");
  assert.equal((await call(sid, "resume", {})).ok, true);
  assert.equal((await manager.snapshot(sid)).state.title, "처음 이름");
  fs.appendFileSync(file, JSON.stringify({ type: "custom-title", customTitle: "VS Code에서 붙인 이름", sessionId: sid }) + "\n");
  (manager as unknown as { catalog?: unknown }).catalog = undefined;
  assert.equal((await manager.list()).find((s) => s.id === sid)?.title, "VS Code에서 붙인 이름");
});

test("a rename asked for while the session starts waits for the start and goes to the process", async (t) => {
  const { manager } = setup(t);
  const sid = nextId();
  const file = transcript(sid);
  const started = manager.activate(sid);
  const renamed = manager.rename(sid, "시작 중에 바꾼 이름");
  await started;
  assert.deepEqual(await renamed, { title: "시작 중에 바꾼 이름" });
  assert.equal(recorded().filter((x) => x.request?.subtype === "rename_session").length, 1);
  assert.equal(titleRows(file).filter((r) => r.type === "custom-title").length, 1, "only the process wrote a name");
});

test("archiving hides a session from nothing but ccrc's list, and a message brings it back", async (t) => {
  const { manager, call, say, logged } = setup(t);
  const sid = nextId();
  const file = transcript(sid);
  const size = fs.statSync(file).size;
  assert.deepEqual((await call(sid, "archive", { archived: true })).data, { archived: true });
  assert.equal((await manager.list()).find((s) => s.id === sid)?.archived, true);
  assert.equal(fs.statSync(file).size, size, "the transcript is not touched");
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "state", "archived.json"), "utf8"))[sid] > 0, true);
  assert.equal((await call(sid, "archive", { archived: "yes" })).error, "invalid request");
  assert.equal((await call(nextId(), "archive", { archived: true })).error, "unknown session");

  say({ t: "send", sessionId: sid, text: "다시 쓰기" });
  await until(() => recorded().some((r) => r.user === "다시 쓰기"), "message sent");
  await until(async () => !(await manager.list()).find((s) => s.id === sid)?.archived, "unarchived");
  assert.deepEqual(
    logged.filter(([e, d]) => d.sessionId === sid && (e === "archive" || d.op === "archive")),
    [
      ["call", { device: "phone", sessionId: sid, op: "archive", archived: true }],
      ["archive", { sessionId: sid, archived: false, by: "send" }],
    ],
  );
  assert.equal((await call(sid, "archive", { archived: true })).ok, true, "a running session can be archived too");
  assert.equal((await manager.list()).find((s) => s.id === sid)?.archived, true);
  assert.equal((await call(sid, "archive", { archived: false })).ok, true);
  assert.equal((await manager.list()).find((s) => s.id === sid)?.archived, undefined);
});

test("the archive forgets sessions whose transcript is gone", async (t) => {
  const { manager } = setup(t);
  const kept = nextId();
  const gone = nextId();
  transcript(kept);
  const file = transcript(gone);
  await manager.setArchived(kept, true);
  await manager.setArchived(gone, true);
  fs.rmSync(file);
  manager.pruneArchived();
  const saved = JSON.parse(fs.readFileSync(path.join(home, "state", "archived.json"), "utf8"));
  assert.ok(kept in saved && !(gone in saved));
});
