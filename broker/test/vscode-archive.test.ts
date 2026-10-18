import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

// The manager reads ~/.claude and VS Code's state database under $XDG_CONFIG_HOME/Code.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccrc-vsarchive-"));
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
process.env.CCRC_STATE_DIR = path.join(home, "state");
process.env.XDG_CONFIG_HOME = path.join(home, ".config");
const dbFile = path.join(home, ".config", "Code", "User", "globalStorage", "state.vscdb");

const { VscodeArchive, hiddenIds } = await import("../src/sessions/vscode-archive.ts");
const { SessionManager } = await import("../src/sessions/manager.ts");
const { projectDirName } = await import("../src/sessions/history.ts");
const { Hub } = await import("../src/hub.ts");
const { Uploads } = await import("../src/uploads.ts");
type Audit = import("../src/audit.ts").Audit;
type Leases = import("../src/lease.ts").Leases;
type ServerMsg = import("../src/protocol.ts").ServerMsg;

after(() => fs.rmSync(home, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const nextId = () => `7c7c7c7c-0000-4000-8000-${String(++n).padStart(12, "0")}`;

// VS Code's globalStorage database with the Claude Code extension's row, as VS Code keeps it: one JSON text per
// extension. blob: the value as bytes, which VS Code also reads.
function vscodeState(file: string, state: Record<string, unknown>, blob = false): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  const value = JSON.stringify(state);
  db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("Anthropic.claude-code", blob ? Buffer.from(value) : value);
  db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("workbench.other", "{}");
  db.close();
}

test("the hidden ids are read from the extension's row, text or bytes, keeping session ids only", async () => {
  const dir = fs.mkdtempSync(path.join(home, "db-"));
  const a = nextId();
  const b = nextId();
  vscodeState(path.join(dir, "text.vscdb"), { hiddenSessionIds: [a, "not-an-id", 7, b], sessionUnarchivedAt: { [a]: 1 } });
  assert.deepEqual([...(await hiddenIds(path.join(dir, "text.vscdb")))], [a, b]);
  vscodeState(path.join(dir, "blob.vscdb"), { hiddenSessionIds: [b] }, true);
  assert.deepEqual([...(await hiddenIds(path.join(dir, "blob.vscdb")))], [b]);
  vscodeState(path.join(dir, "none.vscdb"), { thinkingLevel: "x" });
  assert.deepEqual([...(await hiddenIds(path.join(dir, "none.vscdb")))], []);
});

test("the database is read again only when it changes, and a busy or broken one keeps what was read", async () => {
  const dir = fs.mkdtempSync(path.join(home, "db-"));
  const file = path.join(dir, "state.vscdb");
  const a = nextId();
  const b = nextId();
  const archive = new VscodeArchive(path.join(dir, "shown.json"), () => file);
  assert.deepEqual([...(await archive.hidden())], [], "no database yet");
  vscodeState(file, { hiddenSessionIds: [a] });
  assert.deepEqual([...(await archive.hidden())], [a]);
  const before = fs.readFileSync(file);
  const stat = fs.statSync(file);
  assert.deepEqual([...(await archive.hidden())], [a]);
  assert.deepEqual(fs.readFileSync(file), before, "never written");
  assert.equal(fs.statSync(file).mtimeMs, stat.mtimeMs);

  const writer = new DatabaseSync(file);
  writer.exec("BEGIN EXCLUSIVE");
  writer.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("Anthropic.claude-code", JSON.stringify({ hiddenSessionIds: [a, b] }));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  const t0 = Date.now();
  assert.deepEqual([...(await archive.hidden())], [a], "a database VS Code is writing keeps the last ids");
  assert.ok(Date.now() - t0 < 900, `the read gave up quickly (${Date.now() - t0}ms)`);
  writer.exec("COMMIT");
  writer.close();
  assert.deepEqual([...(await archive.hidden())].sort(), [a, b].sort(), "read once it is free");

  fs.writeFileSync(file, "not a database");
  assert.deepEqual([...(await archive.hidden())].sort(), [a, b].sort());
  fs.rmSync(file);
  assert.deepEqual([...(await archive.hidden())], []);
});

test("brought-back marks are kept in their file, and go once VS Code no longer hides the session", async () => {
  const dir = fs.mkdtempSync(path.join(home, "db-"));
  const file = path.join(dir, "state.vscdb");
  const shown = path.join(dir, "shown.json");
  const a = nextId();
  const b = nextId();
  vscodeState(file, { hiddenSessionIds: [a, b] });
  const archive = new VscodeArchive(shown, () => file, () => 1000);
  await archive.hidden();
  assert.equal(archive.setShown(a, true), true);
  assert.equal(archive.setShown(a, true), false);
  assert.equal(archive.setShown(b, true), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(shown, "utf8")), { [a]: 1000, [b]: 1000 });
  assert.equal(new VscodeArchive(shown, () => file).shown(a), true, "a new broker reads them back");
  vscodeState(file, { hiddenSessionIds: [b] });
  fs.utimesSync(file, new Date(), new Date(Date.now() + 10_000));
  await archive.hidden();
  assert.equal(archive.shown(a), false, "VS Code showed it again");
  assert.equal(archive.shown(b), true);
  archive.prune(() => false);
  assert.deepEqual(JSON.parse(fs.readFileSync(shown, "utf8")), {});
  fs.writeFileSync(shown, JSON.stringify({ [a]: "x", junk: 1, [b]: 5 }));
  assert.equal(new VscodeArchive(shown, () => file).shown(b), true);
  assert.equal(new VscodeArchive(shown, () => file).shown(a), false);
});

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

async function until<T>(fn: () => T | undefined | false, what: string, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw Error(`timed out: ${what}`);
    await sleep(20);
  }
}

const cwd = path.join(home, "work");
fs.mkdirSync(cwd, { recursive: true });
const project = path.join(home, ".claude", "projects", projectDirName(cwd));

function transcript(sessionId: string): void {
  const base = { sessionId, cwd, isSidechain: false, userType: "external", version: "2.1.301" };
  const u = `${sessionId.slice(0, 8)}-1111-4000-8000-000000000001`;
  const rows = [
    { ...base, type: "user", uuid: u, parentUuid: null, timestamp: "2026-10-18T01:00:00Z", message: { role: "user", content: "질문" } },
    {
      ...base,
      type: "assistant",
      uuid: `${sessionId.slice(0, 8)}-1111-4000-8000-000000000002`,
      parentUuid: u,
      timestamp: "2026-10-18T01:00:01Z",
      message: { id: "msg_1", role: "assistant", model: "fake", type: "message", content: [{ type: "text", text: "답" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } },
    },
  ];
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, `${sessionId}.jsonl`), rows.map((r) => JSON.stringify(r) + "\n").join(""));
}

function setup(t: { after: (fn: () => unknown) => void }, vscodeArchive: boolean) {
  const audit = { log: () => {} } as unknown as Audit;
  const config = { host: "127.0.0.1", port: 0, allowedDevices: [], allowLocal: true, claudePath: "/bin/false", roots: [cwd], leaseIdleMinutes: 1, sessionIdleMinutes: 1, vscodeArchive };
  const manager = new SessionManager(config, audit);
  manager.windowProbe = async () => undefined;
  const leases = Object.assign(new EventEmitter(), { validate: () => true }) as unknown as Leases;
  const hub = new Hub(manager, leases, audit, new Uploads(fs.mkdtempSync(path.join(home, "up-"))));
  const ws = new FakeSocket();
  hub.attach(ws as never, "phone", "token");
  let seq = 0;
  const call = async (sessionId: string, op: string, args: Record<string, unknown>) => {
    const id = ++seq;
    ws.emit("message", JSON.stringify({ t: "call", id, sessionId, op, args }));
    return until(() => ws.sent.find((m): m is Extract<ServerMsg, { t: "call_result" }> => m.t === "call_result" && m.id === id), `${op} answered`);
  };
  const row = async (id: string) => {
    (manager as unknown as { catalog?: unknown }).catalog = undefined;
    const s = (await manager.list()).find((x) => x.id === id);
    return { archived: s?.archived, vscodeArchived: s?.vscodeArchived };
  };
  t.after(async () => {
    hub.close();
    await manager.closeAll();
  });
  return { manager, call, row };
}

const shownFile = () => path.join(home, "state", "vscode-unarchived.json");
const touch = () => fs.utimesSync(dbFile, new Date(), new Date(Date.now() + 20_000 + ++n * 1000));

test("with the setting on, sessions VS Code archived are archived in the list, and come back here alone", async (t) => {
  const a = nextId();
  const b = nextId();
  const c = nextId();
  for (const id of [a, b, c]) transcript(id);
  vscodeState(dbFile, { hiddenSessionIds: [a, b] });
  touch();
  const before = fs.readFileSync(dbFile);
  const { manager, call, row } = setup(t, true);
  assert.deepEqual(await row(a), { archived: true, vscodeArchived: true });
  assert.deepEqual(await row(c), { archived: undefined, vscodeArchived: undefined });

  assert.deepEqual((await call(a, "archive", { archived: false })).data, { archived: false });
  assert.deepEqual(await row(a), { archived: undefined, vscodeArchived: true }, "brought back here, still archived in VS Code");
  assert.ok(JSON.parse(fs.readFileSync(shownFile(), "utf8"))[a] > 0);
  assert.deepEqual(fs.readFileSync(dbFile), before, "VS Code's database is never written");

  assert.equal((await call(a, "archive", { archived: true })).ok, true);
  assert.deepEqual(await row(a), { archived: true, vscodeArchived: true });
  assert.equal(JSON.parse(fs.readFileSync(shownFile(), "utf8"))[a], undefined, "archived here again, the mark goes");

  assert.equal((await call(c, "archive", { archived: true })).ok, true);
  assert.equal((await call(c, "archive", { archived: false })).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(shownFile(), "utf8"))[c], undefined, "a session VS Code shows needs no mark");

  manager.setVscodeArchive(false);
  assert.deepEqual(await row(b), { archived: undefined, vscodeArchived: undefined }, "the setting off leaves VS Code's archive out");
  assert.deepEqual(await row(a), { archived: true, vscodeArchived: undefined }, "ccrc's own archive stays");
  manager.setVscodeArchive(true);
  assert.deepEqual(await row(b), { archived: true, vscodeArchived: true });
});

test("with the setting off VS Code's archive does not count, and bringing a session back marks nothing", async (t) => {
  const a = nextId();
  transcript(a);
  vscodeState(dbFile, { hiddenSessionIds: [a] });
  touch();
  const { call, row } = setup(t, false);
  assert.deepEqual(await row(a), { archived: undefined, vscodeArchived: undefined });
  assert.equal((await call(a, "archive", { archived: true })).ok, true);
  assert.equal((await call(a, "archive", { archived: false })).ok, true);
  assert.equal(fs.existsSync(shownFile()) ? JSON.parse(fs.readFileSync(shownFile(), "utf8"))[a] : undefined, undefined);
});

test("a session VS Code shows again leaves the list's archive, and one it hides again comes back to it", async (t) => {
  const a = nextId();
  transcript(a);
  vscodeState(dbFile, { hiddenSessionIds: [a] });
  touch();
  const { call, row } = setup(t, true);
  assert.equal((await call(a, "archive", { archived: false })).ok, true);
  assert.deepEqual(await row(a), { archived: undefined, vscodeArchived: true });
  vscodeState(dbFile, { hiddenSessionIds: [] });
  touch();
  assert.deepEqual(await row(a), { archived: undefined, vscodeArchived: undefined });
  vscodeState(dbFile, { hiddenSessionIds: [a] });
  touch();
  assert.deepEqual(await row(a), { archived: true, vscodeArchived: true }, "archived in VS Code again after it showed it");
});
