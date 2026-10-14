import assert from "node:assert/strict";
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
const sessionsDir = path.join(home, ".claude", "sessions");
fs.mkdirSync(sessionsDir, { recursive: true });

const { LineSplitter, parseLine } = await import("../src/link/lines.ts");
const { LinkServer } = await import("../src/link/server.ts");
const { SessionManager } = await import("../src/sessions/manager.ts");
const { projectDirName } = await import("../src/sessions/history.ts");

type Msg = Record<string, unknown>;
const X = "5f0e8a43-6a8b-4a0f-9f6e-2b7d7c1e9a10";
const Y = "7c2d1b90-3e4f-4a5b-8c6d-9e0f1a2b3c4d";

const config = { host: "127.0.0.1", port: 0, allowedDevices: [], allowLocal: true, roots: [], leaseIdleMinutes: 1, sessionIdleMinutes: 1 };

class FakeWrapper {
  sock: net.Socket;
  frames: Msg[] = [];
  private waiters: { pred: (f: Msg) => boolean; resolve: (f: Msg) => void }[] = [];

  constructor(sock: net.Socket) {
    this.sock = sock;
    const split = new LineSplitter((line) => {
      const f = parseLine(line);
      if (!f) return;
      this.frames.push(f);
      for (const w of [...this.waiters]) {
        if (w.pred(f)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(f);
        }
      }
    });
    sock.on("data", (c: Buffer) => split.push(c));
  }

  send(frame: Msg): void {
    this.sock.write(JSON.stringify(frame) + "\n");
  }

  wait(pred: (f: Msg) => boolean, label: string, ms = 5000): Promise<Msg> {
    const hit = this.frames.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`timed out waiting for ${label}`)), ms);
      this.waiters.push({ pred, resolve: (f) => (clearTimeout(timer), resolve(f)) });
    });
  }
}

const servers: InstanceType<typeof LinkServer>[] = [];
after(async () => {
  for (const s of servers) await s.close();
  fs.rmSync(home, { recursive: true, force: true });
});

async function setup() {
  const manager = new SessionManager(config, undefined, { handoffTurnMs: 200, handoffOtherMs: 400 });
  const server = new LinkServer(path.join(tempDir("ccrc-link-"), "link.sock"));
  servers.push(server);
  server.on("link", (link) => manager.attachLink(link));
  await server.listen();
  const connect = async (hello: Msg) => {
    const sock = net.createConnection(server.socketPath);
    await new Promise((r) => sock.once("connect", r));
    const w = new FakeWrapper(sock);
    w.send({ t: "hello", v: 1, wpid: 1, cwd: home, args: [], ...hello });
    return w;
  };
  const events: [string, string][] = [];
  for (const ev of ["attached", "detached"]) manager.on(ev, (id: string) => events.push([ev, id]));
  return { manager, connect, events };
}

// Registers this test process as another Claude Code process that holds `sessionId`.
function holdElsewhere(sessionId: string): () => void {
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const procStart = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  const file = path.join(sessionsDir, `${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, sessionId, cwd: home, procStart, entrypoint: "cli" }));
  return () => fs.rmSync(file, { force: true });
}

const until = async (fn: () => boolean, label: string) => {
  for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(fn(), label);
};

test("a session another process keeps holding is opened in VS Code as a copy", async () => {
  const { manager, connect } = await setup();
  const release = holdElsewhere(X);
  try {
    const w = await connect({ sessionId: X, claim: X });
    await w.wait((f) => f.t === "claim_wait", "told to wait");
    const ok = await w.wait((f) => f.t === "claim_ok", "hand-over answer");
    assert.equal(ok.fork, true);
    assert.equal(manager.isControlled(X), false, "the held session is not taken over");
    w.send({ m: { type: "system", subtype: "init", session_id: Y }, t: "out" });
    await until(() => manager.isControlled(Y), "the copy is attached");
  } finally {
    release();
  }
});

test("VS Code takes a session over once the other process has let go", async () => {
  const { manager, connect } = await setup();
  const release = holdElsewhere(X);
  const w = await connect({ sessionId: X, claim: X });
  await w.wait((f) => f.t === "claim_wait", "told to wait");
  release();
  const ok = await w.wait((f) => f.t === "claim_ok", "hand-over answer");
  assert.equal(ok.fork, undefined);
  await until(() => manager.isControlled(X), "attached under its own id");
});

test("a newer wrapper for the same session replaces the older one quietly", async () => {
  const { manager, connect, events } = await setup();
  const first = await connect({ sessionId: X });
  await until(() => events.some(([e, id]) => e === "attached" && id === X), "first attached");
  const second = await connect({ sessionId: X });
  await until(() => events.filter(([e, id]) => e === "attached" && id === X).length === 2, "second attached");
  first.sock.destroy();
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!events.some(([e]) => e === "detached"), "closing the old one does not detach the session");
  assert.equal(manager.isControlled(X), true);
  second.sock.destroy();
  await until(() => events.some(([e, id]) => e === "detached" && id === X), "closing the current one detaches it");
});

test("what a wrapper reports before naming its session is replayed in order", async () => {
  const { manager, connect } = await setup();
  const w = await connect({});
  w.send({ m: { type: "control_request", request_id: "p1", request: { subtype: "can_use_tool", tool_name: "Write", input: {}, tool_use_id: "t1" } }, t: "out" });
  w.send({ t: "settled", id: "p1", by: "host" });
  w.send({ m: { type: "system", subtype: "init", session_id: Y }, t: "out" });
  await until(() => manager.isControlled(Y), "attached");
  await new Promise((r) => setTimeout(r, 100));
  const snap = await manager.snapshot(Y);
  assert.deepEqual(snap.pending, []);
});

test("a phone message left queued when VS Code closes stays in the stopped session's conversation", async () => {
  const Z = "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d";
  const dir = path.join(home, ".claude", "projects", projectDirName(home));
  fs.mkdirSync(dir, { recursive: true });
  const row = { sessionId: Z, cwd: home, type: "user", uuid: "2a3b4c5d-0000-4000-8000-000000000001", parentUuid: null, timestamp: "2026-10-14T03:00:00Z" };
  fs.writeFileSync(path.join(dir, `${Z}.jsonl`), JSON.stringify({ ...row, message: { role: "user", content: "hello" } }) + "\n");
  const { manager, connect, events } = await setup();
  const w = await connect({ sessionId: Z });
  await until(() => manager.isControlled(Z), "attached");
  await manager.send(Z, "left behind");
  w.sock.destroy();
  await until(() => events.some(([e, id]) => e === "detached" && id === Z), "detached");
  const snap = await manager.snapshot(Z);
  assert.deepEqual(
    snap.items.map((i) => [i.kind, "text" in i ? i.text : undefined]),
    [["user", "hello"], ["note", "left behind"]],
  );
});
