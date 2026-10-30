import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { Audit } from "../src/audit.ts";
import { Hub, type WindowTag } from "../src/hub.ts";
import type { Leases } from "../src/lease.ts";
import { PHONE_CAPS, type ServerMsg } from "../src/protocol.ts";
import type { SessionManager } from "../src/sessions/manager.ts";
import { Uploads } from "../src/uploads.ts";
import { tempDir } from "./helpers.ts";

const A = "11111111-2222-4333-8444-555555555555";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: ServerMsg[] = [];
  closed: (number | undefined)[] = [];
  terminated = false;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMsg);
  }
  ping(): void {}
  close(code?: number): void {
    this.closed.push(code);
    this.readyState = 3;
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
  }
  say(msg: unknown): void {
    this.emit("message", JSON.stringify(msg));
  }
  got(t: ServerMsg["t"]): ServerMsg[] {
    return this.sent.filter((m) => m.t === t);
  }
}

// A manager that takes messages, each after `delay`, failing while `failing` is set.
class FakeManager extends EventEmitter {
  delivered: string[] = [];
  delay = 0;
  failing = false;
  setViewed(): void {}
  markSeen(): void {}
  isControlled(): boolean {
    return true;
  }
  async snapshot(sessionId: string) {
    return { items: [], pending: [], hasMore: false, state: { sessionId, cwd: "/", state: "attached" as const, busy: false } };
  }
  async send(_sessionId: string, text: string): Promise<void> {
    await sleep(this.delay);
    if (this.failing) throw Error("session is not running here");
    this.delivered.push(text);
  }
}

function setup() {
  const manager = new FakeManager();
  const touches: boolean[] = [];
  const leases = Object.assign(new EventEmitter(), {
    validate: (_token: string, _now: number, touch = true) => {
      touches.push(touch);
      return true;
    },
  }) as unknown as Leases;
  const audit = { log: () => {} } as unknown as Audit;
  const hub = new Hub(manager as unknown as SessionManager, leases, audit, new Uploads(tempDir()));
  const attach = (tag?: WindowTag, device = "phone") => {
    const ws = new FakeSocket();
    hub.attach(ws as never, device, "token", tag);
    return ws;
  };
  return { manager, hub, attach, touches };
}

test("ready names what the broker does beyond older brokers, and the build it serves", () => {
  const { hub, attach } = setup();
  hub.webBuild = () => "b123";
  const ws = attach();
  assert.deepEqual(ws.sent[0], { t: "ready", caps: PHONE_CAPS, build: "b123" });
  hub.webBuild = () => undefined;
  const other = attach();
  other.say({ t: "take_window" });
  assert.deepEqual(other.sent.at(-1), { t: "ready", caps: PHONE_CAPS }, "no build when the broker serves none");
  hub.close();
});

test("a page that connects again takes the place of its earlier connection at once, whether that one answers or not", () => {
  const { hub, attach } = setup();
  const first = attach({ id: "page-aaaa", seq: 1 });
  for (let n = 2; n <= 101; n++) {
    const again = attach({ id: "page-aaaa", seq: n });
    assert.deepEqual(again.got("window_conflict"), [], `connection ${n}`);
    assert.equal(again.sent[0]?.t, "ready");
  }
  assert.ok(first.terminated, "the earlier connection is dropped");
  assert.ok(hub.connected);
  hub.close();
});

test("another page still waits until its user takes over", () => {
  const { hub, attach } = setup();
  const a = attach({ id: "page-aaaa", seq: 1 });
  const b = attach({ id: "page-bbbb", seq: 1 });
  assert.deepEqual(b.sent, [{ t: "window_conflict" }]);
  const old = attach();
  assert.deepEqual(old.sent, [{ t: "window_conflict" }], "a page that names nothing is another window");
  b.say({ t: "take_window" });
  assert.deepEqual(a.sent.at(-1), { t: "window_taken" });
  assert.deepEqual(a.closed, [4000]);
  assert.equal(b.sent.at(-1)?.t, "ready");
  hub.close();
});

test("a connection numbered before the page's latest is late and goes; a waiting page that connects again keeps waiting", () => {
  const { hub, attach } = setup();
  const latest = attach({ id: "page-aaaa", seq: 5 });
  const late = attach({ id: "page-aaaa", seq: 4 });
  assert.ok(late.terminated);
  assert.deepEqual(late.sent, []);
  assert.ok(!latest.terminated);
  const waiting = attach({ id: "page-bbbb", seq: 1 });
  const again = attach({ id: "page-bbbb", seq: 2 });
  assert.ok(waiting.terminated);
  assert.deepEqual(again.sent, [{ t: "window_conflict" }]);
  latest.say({ t: "ping" });
  assert.deepEqual(latest.sent.at(-1), { t: "pong" }, "the page in use is still the one in use");
  hub.close();
});

test("a ping is answered to any window and is not the user's activity", async () => {
  const { hub, attach, touches } = setup();
  const a = attach();
  const b = attach();
  a.say({ t: "ping" });
  b.say({ t: "ping" });
  a.say({ t: "visibility", visible: true });
  await sleep(10);
  assert.deepEqual(a.got("pong"), [{ t: "pong" }]);
  assert.deepEqual(b.got("pong"), [{ t: "pong" }], "a window waiting to take over learns its connection lives");
  assert.deepEqual(touches, [false, false, true]);
  hub.close();
});

test("a message sent again under the same id after a reconnect reaches its session once", async () => {
  const { manager, hub, attach } = setup();
  manager.delay = 30;
  const first = attach({ id: "page-aaaa", seq: 1 });
  const msg = { t: "send", sessionId: A, text: "only once", id: "m-1" };
  first.say(msg);
  await sleep(5);
  const second = attach({ id: "page-aaaa", seq: 2 });
  second.say(msg);
  await sleep(60);
  second.say(msg);
  await sleep(60);
  assert.deepEqual(manager.delivered, ["only once"]);
  assert.deepEqual(second.got("sent"), [
    { t: "sent", id: "m-1" },
    { t: "sent", id: "m-1" },
  ]);
  first.say({ t: "send", sessionId: A, text: "from a dropped connection", id: "m-2" });
  await sleep(60);
  assert.deepEqual(manager.delivered, ["only once"], "a connection replaced takes nothing more");
  hub.close();
});

test("a message that failed says so under its id and may be sent again; one without an id is not answered", async () => {
  const { manager, hub, attach } = setup();
  const ws = attach();
  manager.failing = true;
  ws.say({ t: "send", sessionId: A, text: "hello", id: "m-1" });
  await sleep(20);
  assert.deepEqual(ws.got("error"), [{ t: "error", message: "session is not running here", sessionId: A, sendId: "m-1" }]);
  manager.failing = false;
  ws.say({ t: "send", sessionId: A, text: "hello", id: "m-1" });
  ws.say({ t: "send", sessionId: A, text: "plain" });
  await sleep(20);
  assert.deepEqual(manager.delivered, ["hello", "plain"]);
  assert.deepEqual(ws.got("sent"), [{ t: "sent", id: "m-1" }]);
  ws.say({ t: "send", sessionId: A, text: "bad id", id: "x".repeat(65) });
  ws.say({ t: "send", sessionId: A, text: "bad id", id: 7 });
  await sleep(20);
  assert.equal(manager.delivered.length, 2);
  assert.deepEqual(
    ws.got("error").slice(1).map((m) => (m as { message: string }).message),
    ["invalid request", "invalid request"],
  );
  hub.close();
});
