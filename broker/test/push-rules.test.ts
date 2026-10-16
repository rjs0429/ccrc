import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { Hub } from "../src/hub.ts";
import type { LiveState, PendingKind, PendingRequest, ServerMsg, SessionSummary } from "../src/protocol.ts";
import { Notifier, endText, type Urgency } from "../src/push/rules.ts";
import type { Subscription } from "../src/push/subscriptions.ts";
import { DEFAULT_PREFS, type PushPayload, type PushPrefs } from "../src/push/types.ts";
import type { SessionManager } from "../src/sessions/manager.ts";
import type { TurnEnd } from "../src/sessions/outcome.ts";

const A = "11111111-2222-4333-8444-555555555555";
const B = "22222222-3333-4444-8555-666666666666";
const C = "33333333-4444-4555-8666-777777777777";
const ENDPOINT = "https://web.push.apple.com/device";
const OTHER = "https://web.push.apple.com/tablet";
const HOUR = 3600_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeManager extends EventEmitter {
  sessions: SessionSummary[] = [];
  private pending = new Map<string, string>();
  async list(): Promise<SessionSummary[]> {
    return this.sessions;
  }
  waitingSessions(): string[] {
    return [...new Set(this.pending.values())];
  }
  state(s: Partial<LiveState>, id = A): void {
    const state: LiveState = { sessionId: id, cwd: "/home/u/billing-api", state: "owned", busy: false, ...s };
    this.emit("event", id, { t: "state", sessionId: id, state } satisfies ServerMsg);
  }
  ask(requestId: string, kind: PendingKind = "permission", toolName = "Bash", extra: Partial<PendingRequest> = {}, id = A): void {
    this.pending.set(requestId, id);
    this.emit("event", id, { t: "pending_add", sessionId: id, request: { id: requestId, kind, toolName, input: {}, allowAlways: false, ...extra } } satisfies ServerMsg);
  }
  settle(requestId: string, id = A): void {
    this.pending.delete(requestId);
    this.emit("event", id, { t: "pending_remove", sessionId: id, requestId } satisfies ServerMsg);
  }
  // A turn of the session ends: by default a broker session's finished turn that started just now.
  end(e: Partial<TurnEnd> = {}, id = A): void {
    this.emit("turn_end", id, { outcome: "done", startedAt: Date.now(), attached: false, ...e } satisfies TurnEnd);
  }
  open(id = A): void {
    this.emit("seen", id);
  }
}

// Delays are short: a VS Code delay of 30 s waits 60 ms here, a finished turn 15 ms.
function setup(prefs: Partial<PushPrefs> = {}, more: Subscription[] = []) {
  const manager = new FakeManager();
  manager.sessions = [{ id: A, title: "Fix the invoice export", cwd: "/home/u/billing-api", lastModified: 0, state: "owned" }];
  const hub = { watching: false, activity: undefined as number | undefined, isWatching: () => hub.watching, remoteActivity: () => hub.activity };
  const subs: Subscription[] = [{ endpoint: ENDPOINT, keys: { p256dh: "", auth: "" }, device: "iphone", createdAt: 0, prefs: { ...DEFAULT_PREFS, ...prefs } }, ...more];
  const sent: { endpoint: string; payload: PushPayload; urgency: Urgency }[] = [];
  const notifier = new Notifier(manager as unknown as SessionManager, hub as unknown as Hub, {
    subscriptions: () => subs,
    deliver: (sub, payload, urgency) => sent.push({ endpoint: sub.endpoint, payload, urgency }),
    timing: { ownedMs: 10, secondMs: 2, recheckMs: 20, doneMs: 15, retryMs: 10 },
    log: () => {},
  });
  return { manager, hub, subs, sent, notifier, bodies: () => sent.map((s) => s.payload.body) };
}

test("a request on a broker-run session is notified almost at once, with a minimal text and the badge", async () => {
  const { manager, sent, notifier } = setup();
  manager.state({ busy: true });
  manager.ask("r1");
  await sleep(50);
  assert.deepEqual(sent, [
    { endpoint: ENDPOINT, urgency: "high", payload: { title: "Fix the invoice export", body: "권한 요청", tag: `${A}:permission`, data: { url: `/#/s/${A}` }, badge: 1 } },
  ]);
  notifier.close();
});

test("a VS Code request waits for the device's delay and is dropped when answered at the laptop", async () => {
  const { manager, sent, notifier, bodies } = setup({ vscodeDelaySec: 30 });
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
  assert.deepEqual(bodies(), ["질문이 있습니다"]);
  assert.equal(sent[0].payload.tag, `${A}:question`);
  notifier.close();
});

test("an MCP input request on a VS Code session, which only the phone answers, is notified at once", async () => {
  const { manager, notifier, bodies } = setup({ vscodeDelaySec: 30 });
  manager.state({ state: "attached", busy: true });
  manager.ask("r1", "elicitation", "demo");
  await sleep(30);
  assert.deepEqual(bodies(), ["입력 요청"]);
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

test("a renamed session is notified under the list's name, archived or not", async () => {
  const { manager, sent, notifier } = setup();
  manager.sessions = [{ ...manager.sessions[0], title: "청구서 내보내기 고치기", archived: true }];
  manager.state({ busy: true, title: "Fix the invoice export" });
  manager.ask("r1");
  await sleep(50);
  assert.deepEqual(
    sent.map((s) => s.payload.title),
    ["청구서 내보내기 고치기"],
  );
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
  const { manager, notifier, bodies } = setup({ details: true });
  manager.state({ busy: true });
  manager.ask("r1", "permission", "Bash");
  manager.ask("r2", "plan", "ExitPlanMode");
  await sleep(50);
  assert.deepEqual(bodies().sort(), ["계획 승인 요청", "권한 요청 · Bash"]);
  notifier.close();
});

test("a request only VS Code can answer says so; one the auto-mode classifier handed over reads as any other", async () => {
  const plain = setup({ vscodeDelaySec: 0 });
  plain.manager.state({ state: "attached", busy: true });
  plain.manager.ask("r1", "permission", "Bash", { localOnly: true });
  plain.manager.ask("r2", "dialog", "refusal_fallback_prompt", { localOnly: true });
  plain.manager.ask("r3", "permission", "mcp__claude-in-chrome__navigate", { personOnly: true, defaultToNo: true });
  const detailed = setup({ vscodeDelaySec: 0, details: true });
  detailed.manager.state({ state: "attached", busy: true });
  detailed.manager.ask("r1", "permission", "Bash", { localOnly: true });
  await sleep(50);
  assert.deepEqual(plain.bodies().sort(), ["VS Code에서 답변하기 · 권한 요청", "VS Code에서 답변하기 · 확인 요청", "권한 요청"].sort());
  assert.ok(plain.sent.every((s) => s.urgency === "high"));
  assert.deepEqual(detailed.bodies(), ["VS Code에서 답변하기 · 권한 요청 · Bash"]);
  plain.notifier.close();
  detailed.notifier.close();
});

test("by default a turn the remote user sent to, started or answered in up to two hours before it started is notified", async () => {
  const long = setup();
  long.hub.activity = Date.now() - 3 * HOUR - 10 * 60_000;
  long.manager.end({ startedAt: Date.now() - 3 * HOUR });

  const answered = setup();
  answered.hub.activity = Date.now() - 60_000;
  answered.manager.end({ startedAt: Date.now() - 2 * 60_000 });

  const stale = setup();
  stale.hub.activity = Date.now() - 4 * HOUR;
  stale.manager.end({ startedAt: Date.now() - HOUR });

  const never = setup();
  never.manager.end();

  await sleep(50);
  assert.deepEqual(long.sent, [
    { endpoint: ENDPOINT, urgency: "normal", payload: { title: "Fix the invoice export", body: "작업을 마쳤습니다", tag: `${A}:end`, data: { url: `/#/s/${A}` }, badge: 1 } },
  ]);
  assert.equal(answered.sent.length, 1, "an answer during the turn counts");
  assert.equal(stale.sent.length, 0, "sent three hours before the turn started");
  assert.equal(never.sent.length, 0);
  for (const s of [long, answered, stale, never]) s.notifier.close();
});

test("all sessions: a VS Code turn waits the device's delay unless the remote user gave the last word; a broker turn does not", async () => {
  const { manager, hub, notifier, sent } = setup({ turnEnd: "all", vscodeDelaySec: 30 });
  manager.state({ state: "attached", busy: true });
  manager.state({ state: "attached", busy: false });
  manager.end({ attached: true, hostInputAt: Date.now() });
  await sleep(35);
  assert.equal(sent.length, 0, "within the VS Code delay");
  await sleep(60);
  assert.equal(sent.length, 1);

  hub.activity = Date.now();
  manager.end({ attached: true, hostInputAt: Date.now() - 1000 }, A);
  await sleep(35);
  assert.equal(sent.length, 2, "the phone's message came after VS Code's");

  manager.state({ busy: false }, B);
  manager.end({}, B);
  await sleep(35);
  assert.equal(sent.length, 3, "a broker session waits only a moment");
  notifier.close();
});

test("a turn end waiting to go out is dropped when a new turn starts, the session is opened, or its process ends", async () => {
  const run = async (meanwhile: (s: ReturnType<typeof setup>) => void) => {
    const s = setup({ turnEnd: "all", vscodeDelaySec: 30 });
    s.manager.state({ state: "attached", busy: false });
    s.manager.end({ attached: true });
    await sleep(20);
    meanwhile(s);
    await sleep(80);
    s.notifier.close();
    return s.sent.length;
  };
  assert.equal(await run(() => {}), 1);
  assert.equal(await run((s) => s.manager.state({ state: "attached", busy: true })), 0);
  assert.equal(await run((s) => s.manager.open()), 0);
  assert.equal(await run((s) => s.manager.state({ state: "inactive", busy: false })), 0);
  assert.equal(
    await run((s) => {
      s.hub.watching = true;
    }),
    0,
    "a session the user is looking at",
  );
});

test("turn ends are off for a device that turned them off; other devices are told", async () => {
  const other: Subscription = { endpoint: OTHER, keys: { p256dh: "", auth: "" }, device: "ipad", createdAt: 0, prefs: { ...DEFAULT_PREFS, turnEnd: "all" } };
  const { manager, hub, sent, notifier } = setup({ turnEnd: "off" }, [other]);
  hub.activity = Date.now();
  manager.end();
  await sleep(40);
  assert.deepEqual(
    sent.map((s) => s.endpoint),
    [OTHER],
  );
  notifier.close();
});

test("a crash is told even after the process ended, with high urgency; a stop the user made, a local command or a queued turn is not", async () => {
  const { manager, hub, notifier, sent } = setup();
  hub.activity = Date.now();
  manager.end({ outcome: "interrupted" });
  manager.end({ outcome: "local" });
  manager.end({ queued: true });
  manager.end({ outcome: "crashed" });
  manager.state({ state: "inactive", busy: false });
  await sleep(50);
  assert.deepEqual(
    sent.map((s) => [s.payload.body, s.payload.tag, s.urgency]),
    [["Claude Code가 비정상 종료되었습니다", `${A}:end`, "high"]],
  );
  notifier.close();
});

test("an error or a limit is told with high urgency and the kind of stop", async () => {
  const { manager, hub, notifier, sent } = setup();
  hub.activity = Date.now();
  manager.end({ outcome: "error", reason: "api", status: 529 });
  await sleep(30);
  assert.deepEqual(
    sent.map((s) => [s.payload.body, s.urgency]),
    [["오류로 끝났습니다 · API 529", "high"]],
  );
  notifier.close();
  const now = new Date(2026, 9, 16, 1, 0).getTime();
  const end = (e: Partial<TurnEnd>): TurnEnd => ({ outcome: "error", startedAt: now, attached: false, ...e });
  assert.equal(endText(end({}), now), "오류로 끝났습니다");
  assert.equal(endText(end({ reason: "context" }), now), "오류로 끝났습니다 · 문맥 한도");
  assert.equal(endText(end({ reason: "login", status: 401 }), now), "오류로 끝났습니다 · 로그인 필요");
  assert.equal(endText(end({ reason: "model", status: 404 }), now), "오류로 끝났습니다 · 모델 없음");
  assert.equal(endText(end({ outcome: "limit" }), now), "사용 한도에 걸렸습니다");
  assert.equal(endText(end({ outcome: "limit", resetsAt: new Date(2026, 9, 16, 5, 20).getTime() }), now), "사용 한도에 걸렸습니다 · 05:20 초기화");
  assert.equal(endText(end({ outcome: "limit", resetsAt: new Date(2026, 9, 17, 22, 0).getTime() }), now), "사용 한도에 걸렸습니다 · 10/17 22:00 초기화");
  assert.equal(endText(end({ outcome: "done" }), now), "작업을 마쳤습니다");
});

test("the badge counts each session once: waiting requests and turn ends the device was told of and nobody opened", async (t) => {
  const other: Subscription = { endpoint: OTHER, keys: { p256dh: "", auth: "" }, device: "ipad", createdAt: 0, prefs: { ...DEFAULT_PREFS, turnEnd: "off" } };
  const { manager, hub, notifier, sent } = setup({}, [other]);
  manager.sessions.push({ id: B, title: "Second", cwd: "/home/u/b", lastModified: 0, state: "owned" }, { id: C, title: "Third", cwd: "/home/u/c", lastModified: 0, state: "owned" });
  hub.activity = Date.now();
  manager.end({}, A);
  manager.end({}, B);
  await sleep(30);
  assert.deepEqual(
    sent.map((s) => s.payload.badge),
    [1, 2],
  );
  assert.deepEqual(notifier.badgeFor(ENDPOINT), { badge: 2, unseen: [A, B] });
  assert.deepEqual(notifier.badgeFor(OTHER), { badge: 0, unseen: [] }, "a device that was not told counts nothing");
  manager.open(A);
  manager.ask("r1", "permission", "Bash", {}, B);
  manager.ask("r2", "permission", "Bash", {}, C);
  manager.ask("r3", "permission", "Bash", {}, C);
  await sleep(30);
  assert.deepEqual(
    sent.filter((s) => s.payload.tag.endsWith(":permission")).map((s) => [s.endpoint, s.payload.badge]),
    [
      [ENDPOINT, 2],
      [OTHER, 2],
      [ENDPOINT, 2],
      [OTHER, 2],
      [ENDPOINT, 2],
      [OTHER, 2],
    ],
    "B once though it is waiting and unseen, C once for two requests",
  );
  manager.settle("r1", B);
  manager.state({ busy: true }, B);
  assert.deepEqual(notifier.badgeFor(ENDPOINT), { badge: 1, unseen: [] }, "a new turn on B makes its end old news");
  manager.settle("r2", C);
  manager.settle("r3", C);
  manager.state({ busy: false }, B);
  manager.end({}, B);
  await sleep(30);
  assert.deepEqual(notifier.badgeFor(ENDPOINT), { badge: 1, unseen: [B] });
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 24 * HOUR + 1 });
  assert.deepEqual(notifier.badgeFor(ENDPOINT), { badge: 0, unseen: [] }, "a day later");
  t.mock.timers.reset();
  notifier.close();
});

test("closing stops what is waiting", async () => {
  const { manager, hub, sent, notifier } = setup({ vscodeDelaySec: 30 });
  manager.state({ state: "attached", busy: true });
  manager.ask("r1");
  hub.activity = Date.now();
  manager.end({ attached: true, hostInputAt: Date.now() + 1 });
  await sleep(10);
  notifier.close();
  manager.ask("r2");
  manager.end();
  await sleep(100);
  assert.equal(sent.length, 0);
});
