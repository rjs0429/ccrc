import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { Hub } from "../src/hub.ts";
import type { LiveState, PendingKind, ServerMsg, SessionSummary } from "../src/protocol.ts";
import { Notifier, type Urgency } from "../src/push/rules.ts";
import type { Subscription } from "../src/push/subscriptions.ts";
import { DEFAULT_PREFS, type PushPayload, type PushPrefs } from "../src/push/types.ts";
import type { SessionManager } from "../src/sessions/manager.ts";

const A = "11111111-2222-4333-8444-555555555555";
const ENDPOINT = "https://web.push.apple.com/device";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeManager extends EventEmitter {
  sessions: SessionSummary[] = [];
  async list(): Promise<SessionSummary[]> {
    return this.sessions;
  }
  state(s: Partial<LiveState>): void {
    const state: LiveState = { sessionId: A, cwd: "/home/u/billing-api", state: "owned", busy: false, ...s };
    this.emit("event", A, { t: "state", sessionId: A, state } satisfies ServerMsg);
  }
  ask(id: string, kind: PendingKind = "permission", toolName = "Bash"): void {
    this.emit("event", A, { t: "pending_add", sessionId: A, request: { id, kind, toolName, input: {}, allowAlways: false } } satisfies ServerMsg);
  }
  settle(id: string): void {
    this.emit("event", A, { t: "pending_remove", sessionId: A, requestId: id } satisfies ServerMsg);
  }
}

// Delays are short: a VS Code delay of 30 s waits 60 ms here.
function setup(prefs: Partial<PushPrefs> = {}) {
  const manager = new FakeManager();
  manager.sessions = [{ id: A, title: "Fix the invoice export", cwd: "/home/u/billing-api", lastModified: 0, state: "owned" }];
  const hub = { watching: false, sentAt: undefined as number | undefined, isWatching: () => hub.watching, remoteSent: () => hub.sentAt };
  const subs: Subscription[] = [{ endpoint: ENDPOINT, keys: { p256dh: "", auth: "" }, device: "iphone", createdAt: 0, prefs: { ...DEFAULT_PREFS, ...prefs } }];
  const sent: { payload: PushPayload; urgency: Urgency }[] = [];
  const notifier = new Notifier(manager as unknown as SessionManager, hub as unknown as Hub, {
    subscriptions: () => subs,
    deliver: (_sub, payload, urgency) => sent.push({ payload, urgency }),
    timing: { ownedMs: 10, secondMs: 2, recheckMs: 20, doneMs: 15, retryMs: 10 },
    log: () => {},
  });
  return { manager, hub, subs, sent, notifier };
}

test("a request on a broker-run session is notified almost at once, with a minimal text", async () => {
  const { manager, sent, notifier } = setup();
  manager.state({ busy: true });
  manager.ask("r1");
  await sleep(50);
  assert.deepEqual(sent, [
    { urgency: "high", payload: { title: "Fix the invoice export", body: "권한 요청", tag: `${A}:permission`, data: { url: `/#/s/${A}` } } },
  ]);
  notifier.close();
});

test("a VS Code request waits for the device's delay and is dropped when answered at the laptop", async () => {
  const { manager, sent, notifier } = setup({ vscodeDelaySec: 30 });
  manager.state({ state: "attached", busy: true });
  manager.ask("r1");
  await sleep(30);
  manager.settle("r1");
  await sleep(80);
  assert.equal(sent.length, 0);
  manager.ask("r2", "question", "AskUserQuestion");
  await sleep(30);
  assert.equal(sent.length, 0, "still within the delay");
  await sleep(70);
  assert.deepEqual(
    sent.map((s) => [s.payload.body, s.payload.tag]),
    [["질문이 있습니다", `${A}:question`]],
  );
  notifier.close();
});

test("a VS Code session's kind is known even when its first event is the request", async () => {
  const { manager, sent, notifier } = setup({ vscodeDelaySec: 30 });
  manager.sessions = [];
  manager.ask("r1");
  manager.state({ state: "attached", busy: true });
  await sleep(30);
  assert.equal(sent.length, 0);
  await sleep(70);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.title, "billing-api", "without a title the folder names the session");
  notifier.close();
});

test("a request the user is looking at is notified only once they look away", async () => {
  const { manager, hub, sent, notifier } = setup();
  hub.watching = true;
  manager.state({ busy: true });
  manager.ask("r1");
  await sleep(60);
  assert.equal(sent.length, 0);
  hub.watching = false;
  await sleep(50);
  assert.equal(sent.length, 1);
  notifier.close();
});

test("details name the tool of a permission request", async () => {
  const { manager, sent, notifier } = setup({ details: true });
  manager.state({ busy: true });
  manager.ask("r1", "permission", "Bash");
  manager.ask("r2", "plan", "ExitPlanMode");
  manager.ask("r3", "dialog", "refusal_fallback_prompt");
  await sleep(50);
  assert.deepEqual(sent.map((s) => s.payload.body).sort(), ["계획 승인 요청", "권한 요청 · Bash", "확인 요청"]);
  notifier.close();
});

test("the end of a turn the remote user started is notified unless they are looking at it", async () => {
  const { manager, hub, sent, notifier } = setup();
  hub.sentAt = Date.now();
  manager.state({ busy: true });
  manager.state({ busy: false });
  await sleep(50);
  assert.deepEqual(sent, [
    { urgency: "normal", payload: { title: "Fix the invoice export", body: "작업을 마쳤습니다", tag: `${A}:done`, data: { url: `/#/s/${A}` } } },
  ]);
  hub.watching = true;
  manager.state({ busy: true });
  manager.state({ busy: false });
  await sleep(50);
  assert.equal(sent.length, 1);
  notifier.close();
});

test("a turn end is not notified when the remote user did not send lately, turned it off, or a new turn began", async () => {
  const old = setup();
  old.hub.sentAt = Date.now() - 3 * 3600_000;
  old.manager.state({ busy: true });
  old.manager.state({ busy: false });

  const off = setup({ turnDone: false });
  off.hub.sentAt = Date.now();
  off.manager.state({ busy: true });
  off.manager.state({ busy: false });

  const resumed = setup();
  resumed.hub.sentAt = Date.now();
  resumed.manager.state({ busy: true });
  resumed.manager.state({ busy: false });
  resumed.manager.state({ busy: true });

  const closed = setup();
  closed.hub.sentAt = Date.now();
  closed.manager.state({ busy: true });
  closed.manager.state({ state: "inactive", busy: false });

  await sleep(60);
  for (const s of [old, off, resumed, closed]) {
    assert.equal(s.sent.length, 0);
    s.notifier.close();
  }
});

test("closing stops what is waiting", async () => {
  const { manager, sent, notifier } = setup({ vscodeDelaySec: 30 });
  manager.state({ state: "attached", busy: true });
  manager.ask("r1");
  await sleep(10);
  notifier.close();
  manager.ask("r2");
  await sleep(100);
  assert.equal(sent.length, 0);
});
