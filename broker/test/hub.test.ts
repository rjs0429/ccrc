import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { Audit } from "../src/audit.ts";
import { Hub } from "../src/hub.ts";
import type { Leases } from "../src/lease.ts";
import type { ServerMsg } from "../src/protocol.ts";
import type { SessionManager, Snapshot } from "../src/sessions/manager.ts";
import { Uploads } from "../src/uploads.ts";
import { tempDir } from "./helpers.ts";

const A = "11111111-2222-4333-8444-555555555555";

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

// A manager whose answers the test controls: how long a snapshot takes and whether the session is driven.
class FakeManager extends EventEmitter {
  controlled = false;
  delay = 0;
  watchers = 0;
  focuses: (string | undefined)[] = [];
  setViewed(): void {}
  isControlled(): boolean {
    return this.controlled;
  }
  async snapshot(sessionId: string, focus?: string): Promise<Snapshot> {
    this.focuses.push(focus);
    const state = this.controlled ? "attached" : "inactive";
    await new Promise((r) => setTimeout(r, this.delay));
    return { items: [], pending: [], hasMore: false, state: { sessionId, cwd: "/", state, busy: false } };
  }
  watch(): () => void {
    this.watchers++;
    return () => this.watchers--;
  }
  async call(_sessionId: string, op: string): Promise<unknown> {
    await new Promise((r) => setTimeout(r, this.delay));
    return op;
  }
}

function setup() {
  const manager = new FakeManager();
  const leases = Object.assign(new EventEmitter(), { validate: () => true }) as unknown as Leases;
  const audit = { log: () => {} } as unknown as Audit;
  const hub = new Hub(manager as unknown as SessionManager, leases, audit, new Uploads(tempDir()));
  const ws = new FakeSocket();
  hub.attach(ws as never, "test", "token");
  const view = (sessionId: string | null) => ws.emit("message", JSON.stringify({ t: "view", sessionId }));
  const snapshots = () => ws.sent.filter((m): m is Extract<ServerMsg, { t: "snapshot" }> => m.t === "snapshot");
  return { manager, hub, ws, view, snapshots };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a slow snapshot from before a session attached does not replace the attached one", async () => {
  const { manager, hub, view, snapshots } = setup();
  manager.delay = 150;
  view(A);
  await sleep(20);
  manager.controlled = true;
  manager.delay = 0;
  manager.emit("attached", A);
  await sleep(300);
  const sent = snapshots();
  assert.equal(sent.at(-1)?.state.state, "attached");
  assert.ok(sent.every((s) => s.state.state === "attached"), "the stale snapshot is dropped");
  assert.equal(manager.watchers, 0, "a driven session is not followed through its transcript");
  hub.close();
});

test("leaving and reopening a view quickly leaves one transcript watch", async () => {
  const { manager, hub, view } = setup();
  manager.delay = 50;
  view(A);
  await sleep(10);
  view(null);
  view(A);
  await sleep(200);
  assert.equal(manager.watchers, 1);
  view(null);
  await sleep(10);
  assert.equal(manager.watchers, 0);
  hub.close();
});

test("a call is answered to the window that made it, not to one that took over since", async () => {
  const { manager, hub, ws } = setup();
  manager.delay = 50;
  ws.emit("message", JSON.stringify({ t: "call", id: 1, sessionId: A, op: "context", args: {} }));
  const other = new FakeSocket();
  hub.attach(other as never, "laptop", "token2");
  other.emit("message", JSON.stringify({ t: "take_window" }));
  other.emit("message", JSON.stringify({ t: "call", id: 1, sessionId: A, op: "files", args: {} }));
  await sleep(150);
  assert.deepEqual(other.sent.filter((m) => m.t === "call_result"), [{ t: "call_result", id: 1, ok: true, data: "files" }]);
  assert.deepEqual(ws.sent.filter((m) => m.t === "call_result"), []);
  hub.close();
});

test("a focused view keeps its focus while the same session is shown again", async () => {
  const { manager, hub, ws, view } = setup();
  const B = "7c2d1b90-3e4f-4a5b-8c6d-9e0f1a2b3c4d";
  ws.emit("message", JSON.stringify({ t: "view", sessionId: A, focus: "u1" }));
  await sleep(20);
  view(A);
  manager.emit("attached", A);
  await sleep(20);
  view(B);
  await sleep(20);
  ws.emit("message", JSON.stringify({ t: "view", sessionId: A, focus: 5 }));
  await sleep(20);
  assert.deepEqual(manager.focuses, ["u1", "u1", "u1", undefined]);
  assert.ok(ws.sent.some((m) => m.t === "error"));
  hub.close();
});
