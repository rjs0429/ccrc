import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The manager reads ~/.claude and starts the fake CLI.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccrc-home-"));
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
process.env.CCRC_STATE_DIR = path.join(home, "state");
process.env.CCRC_CONFIG_DIR = path.join(home, "config");
fs.mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });
after(() => fs.rmSync(home, { recursive: true, force: true }));

const { SessionManager } = await import("../src/sessions/manager.ts");
const { projectDirName } = await import("../src/sessions/history.ts");
const { Hub } = await import("../src/hub.ts");
const { Uploads } = await import("../src/uploads.ts");
type Audit = import("../src/audit.ts").Audit;
type Leases = import("../src/lease.ts").Leases;
type ServerMsg = import("../src/protocol.ts").ServerMsg;
type UsageCauses = import("../src/protocol.ts").UsageCauses;

const cwd = path.join(home, "work");
fs.mkdirSync(cwd, { recursive: true });
const project = path.join(home, ".claude", "projects", projectDirName(cwd));
const FAKE = new URL("./fixtures/fake-claude.mjs", import.meta.url).pathname;
const config = { host: "127.0.0.1", port: 0, allowedDevices: [], allowLocal: true, claudePath: FAKE, roots: [cwd], leaseIdleMinutes: 1, sessionIdleMinutes: 1 };
const SID = "6e6e6e6e-0000-4000-8000-000000000001";
const EMPTY = "6e6e6e6e-0000-4000-8000-000000000002";
const T0 = Date.now() - 2 * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

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

function transcript(sessionId: string, rows: Record<string, unknown>[]): void {
  const base = { sessionId, cwd, isSidechain: false, userType: "external", version: "2.1.301" };
  let parent: string | null = null;
  const lines = rows.map((r, i) => {
    const uuid = `${sessionId.slice(0, 8)}-1111-4000-8000-${String(i + 1).padStart(12, "0")}`;
    const line = JSON.stringify({ ...base, uuid, parentUuid: parent, ...r });
    parent = uuid;
    return line;
  });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, `${sessionId}.jsonl`), lines.join("\n") + "\n");
}

const usage = { input_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 4000, cache_creation: { ephemeral_5m_input_tokens: 4000, ephemeral_1h_input_tokens: 0 }, output_tokens: 9 };
transcript(SID, [
  { type: "user", timestamp: iso(T0), message: { role: "user", content: "파서를 고쳐 줘" } },
  { type: "assistant", timestamp: iso(T0 + 3000), message: { id: "msg_1", role: "assistant", model: "fake", type: "message", content: [{ type: "text", text: "**고쳤습니다.**" }], stop_reason: "end_turn", usage } },
]);
transcript(EMPTY, [{ type: "summary", summary: "nothing" }]);

function setup(t: { after: (fn: () => unknown) => void }) {
  const logged: [string, Record<string, unknown>][] = [];
  const audit = { log: (event: string, detail: Record<string, unknown>) => logged.push([event, detail]) } as unknown as Audit;
  const manager = new SessionManager(config, audit);
  const leases = Object.assign(new EventEmitter(), { validate: () => true }) as unknown as Leases;
  const hub = new Hub(manager, leases, audit, new Uploads(fs.mkdtempSync(path.join(home, "up-"))));
  const ws = new FakeSocket();
  hub.attach(ws as never, "phone", "token");
  let id = 0;
  const call = async (target: { sessionId: string } | { cwd: string }, op: string, args: Record<string, unknown> = {}) => {
    const n = ++id;
    ws.emit("message", JSON.stringify({ t: "call", id: n, ...target, op, args }));
    for (let i = 0; i < 500; i++) {
      const r = ws.sent.find((m): m is Extract<ServerMsg, { t: "call_result" }> => m.t === "call_result" && m.id === n);
      if (r) return r;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw Error("no answer");
  };
  t.after(async () => {
    hub.close();
    await manager.closeAll();
  });
  return { manager, call, logged, ws };
}

test("a stopped session exports from its transcript; the export is recorded without its text", async (t) => {
  const { call, logged } = setup(t);
  const r = await call({ sessionId: SID }, "export", { tools: true, tz: "UTC" });
  assert.equal(r.ok, true, r.error);
  const x = r.data as { name: string; text: string; messages: number };
  assert.equal(x.messages, 2);
  assert.match(x.name, /^파서를 고쳐 줘-\d{8}-\d{4}\.md$/);
  assert.ok(x.text.includes(`### 사용자 · ${iso(T0).slice(0, 10)} ${iso(T0).slice(11, 16)}\n\n파서를 고쳐 줘`), x.text);
  assert.ok(x.text.includes("### Claude ·") && x.text.includes("**고쳤습니다.**"));
  const rec = logged.filter(([e]) => e === "export").map(([, d]) => d);
  assert.deepEqual(rec, [{ device: "phone", sessionId: SID, messages: 2, chars: x.text.length }]);
  assert.ok(!JSON.stringify(logged).includes("고쳤습니다"));
  for (const bad of [{ tools: "yes" }, { tz: 9 }]) assert.deepEqual([(await call({ sessionId: SID }, "export", bad)).error], ["invalid request"], JSON.stringify(bad));
  assert.deepEqual([(await call({ sessionId: EMPTY }, "export")).error], ["nothing to export"]);
});

test("a stopped session's state carries the prompt cache its transcript left", async (t) => {
  const { manager } = setup(t);
  const snap = await manager.snapshot(SID);
  assert.deepEqual(snap.state.cache, { at: T0, ttl: "5m", tokens: 4002 });
});

test("the causes of usage come from a process started for them, are kept a while, and an empty answer is not kept", async (t) => {
  const { manager, call } = setup(t);
  const asked: string[] = [];
  let answer: UsageCauses = { none: true };
  manager.causesProbe = async (dir) => (asked.push(dir), answer);
  assert.deepEqual((await call({ sessionId: SID }, "usage_causes")).data, { none: true });
  answer = { day: { requests: 3, sessions: 1, traits: [{ key: "cache_miss", pct: 40, count: 2 }], agents: [], skills: [], plugins: [], mcpServers: [] } };
  assert.deepEqual((await call({ sessionId: SID }, "usage_causes")).data, answer, "asked again after an answer without causes");
  assert.deepEqual((await call({ cwd }, "usage_causes")).data, answer, "the new-session screen gets the same, kept answer");
  assert.equal(asked.length, 2);
});

test("a running session answers the causes itself, through its own Claude Code", async (t) => {
  const { manager, call } = setup(t);
  manager.causesProbe = async () => {
    throw Error("no probe while a session runs");
  };
  await call({ sessionId: SID }, "resume");
  const r = await call({ sessionId: SID }, "usage_causes");
  assert.equal(r.ok, true, r.error);
  const c = r.data as UsageCauses;
  assert.deepEqual(c.day?.traits.map((x) => x.key), ["cache_miss", "brand_new_trait"]);
  assert.deepEqual(c.week?.traits, [{ key: "long_context", pct: 61, count: 40 }]);
});

test("a broker session's command list follows what Claude Code pushes during the session, and the phone is told by its state", async (t) => {
  const { manager, call, ws } = setup(t);
  await call({ sessionId: SID }, "resume");
  const first = await call({ sessionId: SID }, "commands");
  assert.deepEqual((first.data as { name: string }[]).map((c) => c.name), ["compact", "context", "usage", "mcp", "model", "effort", "config", "output-style"]);
  ws.emit("message", JSON.stringify({ t: "view", sessionId: SID }));
  const key = () => ws.sent.filter((m): m is Extract<ServerMsg, { t: "state" | "snapshot" }> => (m.t === "state" || m.t === "snapshot") && m.sessionId === SID).at(-1)?.state.commands;
  for (let i = 0; i < 250 && !key(); i++) await new Promise((r) => setTimeout(r, 20));
  const before = key();
  assert.ok(before);
  await manager.send(SID, "COMMANDS");
  for (let i = 0; i < 250 && key() === before; i++) await new Promise((r) => setTimeout(r, 20));
  assert.notEqual(key(), before, "the state names the new list");
  const listed = (await call({ sessionId: SID }, "commands")).data as { name: string; description: string }[];
  assert.equal(listed.length, 9);
  assert.deepEqual(listed.at(-1), { name: "skill-2", description: "Skill 2" });
});
