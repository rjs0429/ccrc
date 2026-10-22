import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { Hub } from "../src/hub.ts";
import type { DisplayItem, LiveState, PendingKind, PendingRequest, SentFile, ServerMsg, SessionSummary, ToolResult } from "../src/protocol.ts";
import { Notifier, endText, type ClaudeNotice, type Urgency } from "../src/push/rules.ts";
import type { Subscription } from "../src/push/subscriptions.ts";
import { DEFAULT_PREFS, type PushPayload, type PushPrefs } from "../src/push/types.ts";
import type { SessionManager } from "../src/sessions/manager.ts";
import type { TurnEnd } from "../src/sessions/outcome.ts";
import { UnreadStore } from "../src/sessions/unread-store.ts";

const A = "11111111-2222-4333-8444-555555555555";
const B = "22222222-3333-4444-8555-666666666666";
const C = "33333333-4444-4555-8666-777777777777";
const ENDPOINT = "https://web.push.apple.com/device";
const OTHER = "https://web.push.apple.com/tablet";
const HOUR = 3600_000;
// The broker's clock as notifications and the badge state read it.
const NOW = 1_792_627_200_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeManager extends EventEmitter {
  sessions: SessionSummary[] = [];
  unread = new UnreadStore();
  claudeNotice?: (sessionId: string, toolUseId: string, message: string) => ClaudeNotice;
  private pending = new Map<string, string>();
  markUnread(id: string): void {
    this.unread.mark(id);
  }
  markRead(id: string, at?: number): void {
    this.unread.seen(id, at);
  }
  unreadSessions(): string[] {
    return this.unread.ids();
  }
  async list(): Promise<SessionSummary[]> {
    return this.sessions;
  }
  waitingSessions(): string[] {
    return [...new Set(this.pending.values())];
  }
  pendingRequest(id: string, requestId: string): object | undefined {
    return this.pending.get(requestId) === id ? {} : undefined;
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
    this.unread.seen(id);
    this.emit("seen", id);
  }
  // Claude's PushNotification call as the conversation shows it: the call, then with its result.
  pushItem(toolUseId: string, input: Record<string, unknown>, result?: ToolResult, id = A): void {
    const item: DisplayItem = { kind: "tool", id: toolUseId, name: "PushNotification", summary: String(input.message ?? ""), input, ...(result ? { result } : {}) };
    this.emit("event", id, { t: "item", sessionId: id, item } satisfies ServerMsg);
  }
  // A call Claude Code ran.
  push(toolUseId: string, message: string, id = A): void {
    const input = { message, status: "proactive" };
    this.pushItem(toolUseId, input, undefined, id);
    this.pushItem(toolUseId, input, { text: "Mobile push requested.", isError: false, truncated: false }, id);
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
    timing: { ownedMs: 10, secondMs: 2, recheckMs: 20, doneMs: 15, retryMs: 10, recentMs: 150 },
    log: () => {},
    now: () => NOW,
  });
  return { manager, hub, subs, sent, notifier, bodies: () => sent.map((s) => s.payload.body) };
}

// What the badge counts: the number, and the sessions unread and waiting for an answer.
const counts = (badge: number, unseen: string[], waiting: string[] = []) => ({ badge, at: NOW, unseen, waiting });

test("a request on a broker-run session is notified almost at once, with a minimal text and the badge", async () => {
  const { manager, sent, notifier } = setup();
  manager.state({ busy: true });
  manager.ask("r1");
  await sleep(50);
  assert.deepEqual(sent, [
    { endpoint: ENDPOINT, urgency: "high", payload: { title: "Fix the invoice export", body: "권한 요청", tag: `${A}:permission`, data: { url: `/#/s/${A}`, at: NOW }, badge: 1, attention: { at: NOW, unseen: [], waiting: [A] } } },
  ]);
  notifier.close();
});

test("a device hears which request it was told of last, while that is recent and still waits", async () => {
  const other: Subscription = { endpoint: OTHER, keys: { p256dh: "", auth: "" }, device: "tablet", createdAt: 0, prefs: { ...DEFAULT_PREFS, vscodeDelaySec: 30 } };
  const { manager, hub, notifier } = setup({ vscodeDelaySec: 0 }, [other]);
  manager.state({ state: "attached", busy: true });
  assert.equal(notifier.recent(ENDPOINT), undefined);
  manager.ask("r1");
  await sleep(30);
  assert.deepEqual(notifier.recent(ENDPOINT), { sessionId: A, requestId: "r1" });
  assert.equal(notifier.recent(OTHER), undefined, "the tablet waits its delay and was not told yet");
  manager.ask("r2", "question", "AskUserQuestion", {}, B);
  await sleep(30);
  assert.deepEqual(notifier.recent(ENDPOINT), { sessionId: B, requestId: "r2" }, "the latest request");
  manager.settle("r2", B);
  assert.equal(notifier.recent(ENDPOINT), undefined, "answered");
  hub.watching = true;
  manager.ask("r3");
  await sleep(30);
  assert.equal(notifier.recent(ENDPOINT), undefined, "not told while the user looks at the session");
  manager.settle("r3");
  hub.watching = false;
  manager.ask("r4");
  await sleep(30);
  assert.deepEqual(notifier.recent(ENDPOINT), { sessionId: A, requestId: "r4" });
  manager.state({ state: "owned", busy: false }, B);
  manager.end({}, B);
  hub.activity = Date.now();
  await sleep(40);
  assert.equal(notifier.recent(ENDPOINT), undefined, "a later notice about something else came last");
  manager.ask("r5");
  await sleep(30);
  assert.deepEqual(notifier.recent(ENDPOINT), { sessionId: A, requestId: "r5" });
  await sleep(170);
  assert.equal(notifier.recent(ENDPOINT), undefined, "too long ago");
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
  assert.deepEqual(plain.bodies().sort(), ["VS Code에서 답변하기 · 권한 요청", "VS Code에서 답변하기 · 다른 모델로 계속할지 확인", "권한 요청"].sort());
  assert.ok(plain.sent.every((s) => s.urgency === "high"));
  assert.deepEqual(detailed.bodies(), ["VS Code에서 답변하기 · 권한 요청 · Bash"]);
  plain.notifier.close();
  detailed.notifier.close();
});

test("a dialog's notification names what it asks in the device's language", async () => {
  const { manager, notifier, bodies } = setup({ lang: "en", vscodeDelaySec: 0 });
  manager.state({ state: "attached", busy: true });
  manager.ask("r1", "dialog", "refusal_fallback_prompt", { localOnly: true });
  manager.ask("r2", "dialog", "auto_mode_server_fallback");
  manager.ask("r3", "dialog", "a_kind_ccrc_does_not_know");
  await sleep(50);
  assert.deepEqual(bodies().sort(), ["Answer in VS Code · Confirm continuing with another model", "Confirm Auto mode classifier charges", "Waiting for your confirmation"].sort());
  notifier.close();
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
    { endpoint: ENDPOINT, urgency: "normal", payload: { title: "Fix the invoice export", body: "작업을 마쳤습니다", tag: `${A}:end`, data: { url: `/#/s/${A}`, at: NOW }, badge: 1, attention: { at: NOW, unseen: [A], waiting: [] } } },
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

test("each device is written to in its own language", async () => {
  const korean: Subscription = { endpoint: OTHER, keys: { p256dh: "", auth: "" }, device: "tablet", createdAt: 0, prefs: { ...DEFAULT_PREFS, vscodeDelaySec: 0, turnEnd: "all" } };
  const { manager, hub, sent, notifier } = setup({ lang: "en", vscodeDelaySec: 0, turnEnd: "all", details: true }, [korean]);
  const body = (endpoint: string, tag: string) => sent.filter((s) => s.endpoint === endpoint && s.payload.tag === `${A}:${tag}`).map((s) => s.payload.body);
  manager.state({ busy: true });
  manager.ask("r1", "permission", "Bash");
  manager.ask("r2", "question", "AskUserQuestion");
  await sleep(40);
  assert.deepEqual(body(ENDPOINT, "permission"), ["Waiting for your permission · Bash"]);
  assert.deepEqual(body(ENDPOINT, "question"), ["Claude has a question"]);
  assert.deepEqual(body(OTHER, "permission"), ["권한 요청"]);
  sendFiles(manager, "toolu_l1", "proactive", [{ name: "report.md" }, { name: "chart.png" }]);
  sendFiles(manager, "toolu_l2", "", [{ name: "a.txt" }, { name: "b.txt" }]);
  manager.push("toolu_l3", "");
  await sleep(40);
  assert.deepEqual(body(ENDPOINT, "file"), ["Claude sent a file · report.md and 1 more"]);
  assert.deepEqual(body(OTHER, "file"), ["파일을 보냈습니다"]);
  assert.deepEqual(body(ENDPOINT, "claude"), ["Notification from Claude"]);
  manager.settle("r1");
  manager.settle("r2");
  manager.state({ busy: false });
  hub.activity = Date.now();
  manager.end({ outcome: "error", reason: "context" });
  await sleep(40);
  assert.deepEqual(body(ENDPOINT, "end"), ["Stopped with an error · context limit · 2 files"]);
  assert.deepEqual(body(OTHER, "end"), ["오류로 끝났습니다 · 문맥 한도 · 파일 2개"]);
  notifier.close();
  const now = new Date(2026, 9, 16, 1, 0).getTime();
  const end = (e: Partial<TurnEnd>): TurnEnd => ({ outcome: "limit", startedAt: now, attached: false, ...e });
  assert.equal(endText(end({ outcome: "done" }), now, "en"), "Finished");
  assert.equal(endText(end({ outcome: "crashed" }), now, "en"), "Claude Code exited unexpectedly");
  assert.equal(endText(end({ outcome: "error", reason: "api", status: 529 }), now, "en"), "Stopped with an error · API 529");
  assert.equal(endText(end({ resetsAt: new Date(2026, 9, 16, 5, 20).getTime() }), now, "en").replace(/[\u202f\u00a0]/g, " "), "Usage limit reached · resets 5:20 AM");
  assert.equal(endText(end({ resetsAt: new Date(2026, 9, 17, 22, 0).getTime() }), now, "en").replace(/[\u202f\u00a0]/g, " "), "Usage limit reached · resets Oct 17, 10:00 PM");
});

test("the badge counts each session once, as the list shows them: waiting requests and unread sessions", async (t) => {
  const other: Subscription = { endpoint: OTHER, keys: { p256dh: "", auth: "" }, device: "ipad", createdAt: 0, prefs: { ...DEFAULT_PREFS, turnEnd: "off" } };
  const { manager, hub, notifier, sent } = setup({}, [other]);
  manager.sessions.push({ id: B, title: "Second", cwd: "/home/u/b", lastModified: 0, state: "owned" }, { id: C, title: "Third", cwd: "/home/u/c", lastModified: 0, state: "owned" });
  hub.activity = Date.now();
  manager.end({}, A);
  manager.end({}, B);
  await sleep(30);
  assert.deepEqual(
    sent.map((s) => [s.endpoint, s.payload.badge]),
    [
      [ENDPOINT, 2],
      [ENDPOINT, 2],
    ],
    "both turns left their sessions unread as they ended",
  );
  assert.deepEqual(notifier.attention(), counts(2, [A, B]));
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
  assert.deepEqual(notifier.attention(), counts(2, [B], [C]), "a turn that starts by itself leaves B unread");
  manager.settle("r2", C);
  manager.settle("r3", C);
  manager.state({ busy: false }, B);
  manager.end({}, B);
  await sleep(30);
  assert.deepEqual(notifier.attention(), counts(1, [B]));
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 31 * 24 * HOUR });
  assert.deepEqual(notifier.attention(), counts(0, []), "a month later");
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

// A SendUserFile call's item as the conversation gets it once its result is in.
function sendFiles(manager: FakeManager, id: string, status: string, files: Partial<SentFile>[], sessionId = A, sentCut = 0): void {
  const sent = files.map((f, n) => ({ name: `file${n}.md`, path: `/tmp/file${n}.md`, size: 1, ...f }));
  const item: DisplayItem = {
    kind: "tool",
    id,
    name: "SendUserFile",
    summary: "",
    input: { files: sent.map((f) => f.path), status },
    result: { text: "ok", isError: false, truncated: false },
    sent,
    ...(sentCut ? { sentCut } : {}),
  };
  manager.emit("event", sessionId, { t: "item", sessionId, item } satisfies ServerMsg);
}

test("every notification carries when it was made and the sessions the badge then counts, which reading and answering take out", async () => {
  const { manager, hub, notifier, sent } = setup();
  manager.sessions.push({ id: B, title: "Second", cwd: "/home/u/b", lastModified: 0, state: "owned" }, { id: C, title: "Third", cwd: "/home/u/c", lastModified: 0, state: "owned" });
  hub.activity = Date.now();
  manager.end({}, A);
  await sleep(30);
  manager.end({}, B);
  await sleep(30);
  manager.ask("r1", "permission", "Bash", {}, C);
  await sleep(30);
  assert.deepEqual(
    sent.map((s) => [s.payload.tag, s.payload.data.at, s.payload.badge, s.payload.attention]),
    [
      [`${A}:end`, NOW, 1, { at: NOW, unseen: [A], waiting: [] }],
      [`${B}:end`, NOW, 2, { at: NOW, unseen: [A, B], waiting: [] }],
      [`${C}:permission`, NOW, 3, { at: NOW, unseen: [A, B], waiting: [C] }],
    ],
  );
  manager.open(A);
  assert.deepEqual(notifier.attention(), counts(2, [B], [C]), "opened on the phone");
  manager.markRead(B, Date.now());
  assert.deepEqual(notifier.attention(), counts(1, [], [C]), "VS Code wrote to it");
  manager.settle("r1", C);
  assert.deepEqual(notifier.attention(), counts(0, []), "answered");
  manager.ask("r2", "question", "AskUserQuestion");
  await sleep(30);
  assert.deepEqual(sent.at(-1)?.payload.attention, { at: NOW, unseen: [], waiting: [A] }, "the next notification tells the phone");
  notifier.close();
});

test("a file Claude sends to reach the user is told almost at once, once per call, unless the user is looking", async () => {
  const plain = setup();
  plain.manager.state({ busy: true });
  sendFiles(plain.manager, "toolu_f1", "proactive", [{ name: "report.md" }, { name: "chart.png" }]);
  sendFiles(plain.manager, "toolu_f1", "proactive", [{ name: "report.md" }, { name: "chart.png" }]);
  await sleep(40);
  assert.deepEqual(plain.sent, [
    { endpoint: ENDPOINT, urgency: "normal", payload: { title: "Fix the invoice export", body: "파일을 보냈습니다", tag: `${A}:file`, data: { url: `/#/s/${A}`, at: NOW }, badge: 1, attention: { at: NOW, unseen: [A], waiting: [] } } },
  ]);
  assert.deepEqual(plain.notifier.attention(), counts(1, [A]), "a file nobody looked at counts on the badge");

  const detailed = setup({ details: true });
  sendFiles(detailed.manager, "toolu_f2", "proactive", [{ name: "report.md" }, { name: "chart.png" }, { name: "data.csv" }]);
  sendFiles(detailed.manager, "toolu_f3", "proactive", [{ name: "only.pdf" }], B);
  await sleep(40);
  assert.deepEqual(detailed.bodies().sort(), ["파일을 보냈습니다 · only.pdf", "파일을 보냈습니다 · report.md 외 2개"]);

  const watching = setup();
  watching.hub.watching = true;
  sendFiles(watching.manager, "toolu_f4", "proactive", [{}]);
  await sleep(40);
  assert.equal(watching.sent.length, 0, "the card is in front of the user");

  const opened = setup();
  sendFiles(opened.manager, "toolu_f5", "proactive", [{}]);
  opened.manager.open();
  await sleep(40);
  assert.equal(opened.sent.length, 0, "the session was opened meanwhile");

  const refused = setup();
  sendFiles(refused.manager, "toolu_f6", "proactive", [{ error: "upload failed" }, { error: "" }]);
  await sleep(40);
  assert.equal(refused.sent.length, 0, "a call that sent nothing that opens");
  for (const s of [plain, detailed, watching, opened, refused]) s.notifier.close();
});

test("other files sent in a turn are counted on its end's notice", async () => {
  const { manager, hub, notifier, bodies } = setup();
  hub.activity = Date.now();
  manager.state({ busy: true });
  sendFiles(manager, "toolu_n1", "normal", [{}, {}]);
  sendFiles(manager, "toolu_n1", "normal", [{}, {}]);
  sendFiles(manager, "toolu_n2", "normal", [{}, { error: "" }]);
  sendFiles(manager, "toolu_p1", "proactive", [{}]);
  manager.state({ busy: false });
  manager.end({ queued: true });
  manager.end();
  await sleep(40);
  assert.deepEqual(bodies().sort(), ["파일을 보냈습니다", "작업을 마쳤습니다 · 파일 3개"].sort(), "a turn that queued the next one hands its files on");
  manager.end();
  await sleep(40);
  assert.equal(bodies().at(-1), "작업을 마쳤습니다", "counted once");
  sendFiles(manager, "toolu_n3", "normal", [{}]);
  manager.end({ outcome: "interrupted" });
  manager.end({ outcome: "error", status: 529, reason: "api" });
  await sleep(40);
  assert.equal(bodies().at(-1), "오류로 끝났습니다 · API 529", "a turn the user stopped takes its files with it");
  notifier.close();
});

test("files a long call's item leaves out still count", async () => {
  const told = setup({ details: true });
  sendFiles(told.manager, "toolu_l1", "proactive", [{ name: "first.md" }, { error: "" }], A, 5);
  await sleep(40);
  assert.deepEqual(told.bodies(), ["파일을 보냈습니다 · first.md 외 5개"]);
  told.notifier.close();

  const counted = setup();
  counted.hub.activity = Date.now();
  counted.manager.state({ busy: true });
  sendFiles(counted.manager, "toolu_l2", "normal", [{}, {}], A, 3);
  counted.manager.state({ busy: false });
  counted.manager.end();
  await sleep(40);
  assert.deepEqual(counted.bodies(), ["작업을 마쳤습니다 · 파일 5개"]);
  counted.notifier.close();
});

test("a notification Claude asks for goes out almost at once, once per call, in a minimal text unless details are on", async () => {
  const plain = setup();
  plain.manager.state({ busy: true });
  plain.manager.push("toolu_c1", "테스트가 모두 통과했습니다");
  plain.manager.push("toolu_c1", "테스트가 모두 통과했습니다");
  await sleep(40);
  assert.deepEqual(plain.sent, [
    { endpoint: ENDPOINT, urgency: "high", payload: { title: "Fix the invoice export", body: "Claude의 알림", tag: `${A}:claude`, data: { url: `/#/s/${A}`, at: NOW }, badge: 1, attention: { at: NOW, unseen: [A], waiting: [] } } },
  ]);
  assert.deepEqual(plain.notifier.attention(), counts(1, [A]), "the session is unread until opened");

  const detailed = setup({ details: true });
  detailed.manager.push("toolu_c2", `빌드 끝\n${"가".repeat(300)}`);
  await sleep(40);
  assert.equal(detailed.bodies()[0], `빌드 끝 ${"가".repeat(194)}…`, "what Claude wrote, on one line and cut to 200 characters");

  const empty = setup({ details: true });
  empty.manager.push("toolu_c3", "  ");
  await sleep(40);
  assert.deepEqual(empty.bodies(), ["Claude의 알림"]);
  for (const s of [plain, detailed, empty]) s.notifier.close();
});

test("Claude's notification is left out while the user looks at the session, or for a device that turned it off", async () => {
  const watching = setup();
  watching.hub.watching = true;
  assert.equal(watching.notifier.claudeCall(A, "toolu_w1", "끝"), "watching");
  await sleep(40);
  assert.equal(watching.sent.length, 0);
  assert.deepEqual(watching.notifier.attention(), counts(0, []));

  const opened = setup();
  opened.manager.push("toolu_w2", "끝");
  opened.manager.open();
  await sleep(40);
  assert.equal(opened.sent.length, 0, "opened in the moment before it went");

  const other: Subscription = { endpoint: OTHER, keys: { p256dh: "", auth: "" }, device: "ipad", createdAt: 0, prefs: { ...DEFAULT_PREFS } };
  const some = setup({ claude: false }, [other]);
  assert.equal(some.notifier.claudeCall(A, "toolu_w3", "끝"), "sent");
  await sleep(40);
  assert.deepEqual(
    some.sent.map((s) => s.endpoint),
    [OTHER],
  );

  const none = setup({ claude: false });
  assert.equal(none.notifier.claudeCall(A, "toolu_w4", "끝"), "off");
  none.manager.push("toolu_w4", "끝");
  await sleep(40);
  assert.equal(none.sent.length, 0);
  for (const s of [watching, opened, some, none]) s.notifier.close();
});

test("a PushNotification call Claude Code refused or that failed sends nothing, nor stands in for the turn's end", async () => {
  const { manager, hub, notifier, bodies } = setup();
  hub.activity = Date.now();
  manager.state({ busy: true });
  manager.pushItem("toolu_x1", { message: "끝났습니다" });
  await sleep(40);
  assert.deepEqual(bodies(), [], "nothing goes before Claude Code ran the call");
  const invalid = "<tool_use_error>InputValidationError: PushNotification failed due to the following issue:\nThe required parameter `status` is missing</tool_use_error>";
  manager.pushItem("toolu_x1", { message: "끝났습니다" }, { text: invalid, isError: true, truncated: false });
  manager.pushItem("toolu_x2", { message: "끝났습니다", status: "proactive" });
  manager.pushItem("toolu_x2", { message: "끝났습니다", status: "proactive" }, { text: "Permission to use PushNotification has been denied.", isError: true, truncated: false });
  await sleep(40);
  assert.deepEqual(bodies(), [], "a call it refused");
  manager.push("toolu_x3", "끝났습니다");
  await sleep(40);
  assert.deepEqual(bodies(), ["Claude의 알림"], "the call it ran goes, once");
  manager.state({ busy: false });
  manager.end();
  await sleep(40);
  assert.deepEqual(bodies(), ["Claude의 알림"]);

  manager.state({ busy: true });
  manager.pushItem("toolu_x4", { message: "끝" });
  manager.pushItem("toolu_x4", { message: "끝" }, { text: invalid, isError: true, truncated: false });
  await sleep(20);
  manager.state({ busy: false });
  manager.end();
  await sleep(40);
  assert.deepEqual(bodies(), ["Claude의 알림", "작업을 마쳤습니다"], "a turn whose only call failed is told as it ends");
  notifier.close();
});

test("the session's hook and the conversation decide a call once; the manager asks the notifier while it runs", async () => {
  const { manager, notifier, sent } = setup();
  assert.equal(manager.claudeNotice?.(A, "toolu_h1", "배포 끝"), "sent", "the hook comes first");
  manager.push("toolu_h1", "배포 끝");
  await sleep(40);
  assert.equal(sent.length, 1);
  manager.push("toolu_h2", "두 번째");
  assert.equal(manager.claudeNotice?.(A, "toolu_h2", "두 번째"), "sent", "the conversation came first");
  await sleep(40);
  assert.equal(sent.length, 2);
  notifier.close();
  assert.equal(manager.claudeNotice, undefined);
});

test("the turn Claude told the user about does not also say it finished; a stop short of it, files, or another device still hear", async () => {
  const other: Subscription = { endpoint: OTHER, keys: { p256dh: "", auth: "" }, device: "ipad", createdAt: 0, prefs: { ...DEFAULT_PREFS, claude: false } };
  const { manager, hub, notifier, sent } = setup({}, [other]);
  hub.activity = Date.now();
  manager.state({ busy: true });
  manager.push("toolu_t1", "끝났습니다");
  await sleep(20);
  manager.state({ busy: false });
  manager.end();
  await sleep(40);
  assert.deepEqual(
    sent.map((s) => [s.endpoint, s.payload.body]),
    [
      [ENDPOINT, "Claude의 알림"],
      [OTHER, "작업을 마쳤습니다"],
    ],
  );

  manager.state({ busy: true });
  manager.state({ busy: false });
  manager.end();
  await sleep(40);
  assert.deepEqual(
    sent.slice(2).map((s) => [s.endpoint, s.payload.body]),
    [
      [ENDPOINT, "작업을 마쳤습니다"],
      [OTHER, "작업을 마쳤습니다"],
    ],
    "the next turn is told again",
  );

  manager.state({ busy: true });
  manager.push("toolu_t2", "끝났습니다");
  await sleep(20);
  manager.state({ busy: false });
  manager.end({ outcome: "error", reason: "api", status: 529 });
  await sleep(40);
  assert.deepEqual(
    sent.slice(4).map((s) => s.payload.body),
    ["Claude의 알림", "오류로 끝났습니다 · API 529", "오류로 끝났습니다 · API 529"],
  );

  manager.state({ busy: true });
  manager.push("toolu_t3", "끝났습니다");
  sendFiles(manager, "toolu_t4", "normal", [{}]);
  await sleep(20);
  manager.state({ busy: false });
  manager.end();
  await sleep(40);
  assert.deepEqual(
    sent.slice(7).map((s) => [s.endpoint, s.payload.body]),
    [
      [ENDPOINT, "Claude의 알림"],
      [ENDPOINT, "작업을 마쳤습니다 · 파일 1개"],
      [OTHER, "작업을 마쳤습니다 · 파일 1개"],
    ],
  );
  notifier.close();
});

test("a VS Code session's notification from Claude does not wait the device's delay", async () => {
  const { manager, notifier, bodies } = setup({ vscodeDelaySec: 30 });
  manager.state({ state: "attached", busy: true });
  manager.push("toolu_v1", "끝");
  await sleep(30);
  assert.deepEqual(bodies(), ["Claude의 알림"]);
  notifier.close();
});

test("a turn leaves the session unread when the broker runs it or the remote user waits for it, unless the user watches it end", async () => {
  const run = async (end: Partial<TurnEnd>, before: (s: ReturnType<typeof setup>) => void = () => {}) => {
    const s = setup({ turnEnd: "off" });
    before(s);
    s.manager.end(end);
    const unread = s.manager.unreadSessions();
    s.notifier.close();
    return unread.length > 0;
  };
  assert.equal(await run({}), true, "a broker session's turn, the remote user's or not");
  assert.equal(await run({ attached: true }), false, "a VS Code turn nobody here asked for");
  assert.equal(await run({ attached: true }, (s) => (s.hub.activity = Date.now())), true, "a VS Code turn the phone sent");
  assert.equal(await run({ attached: true, hostInputAt: Date.now() - 60_000 }, (s) => (s.hub.activity = Date.now())), true, "the phone answered in it after VS Code's message");
  assert.equal(await run({ attached: true, hostInputAt: Date.now() }, (s) => (s.hub.activity = Date.now() - 60_000)), false, "VS Code asked for it after the phone's message");
  assert.equal(await run({ attached: true }, (s) => (s.hub.activity = Date.now() - 3 * HOUR)), false, "the phone's message is hours old");
  assert.equal(await run({ attached: true, outcome: "crashed" }, (s) => (s.hub.activity = Date.now())), true);
  assert.equal(await run({ outcome: "interrupted" }), false);
  assert.equal(await run({ outcome: "local" }), false);
  assert.equal(await run({ queued: true }), false, "the next turn's end counts");
  assert.equal(await run({}, (s) => (s.hub.watching = true)), false, "watched as it ended");
});

test("a notice told about a VS Code turn nobody here asked for leaves its session unread too", async () => {
  const { manager, notifier } = setup({ turnEnd: "all", vscodeDelaySec: 0 });
  manager.state({ state: "attached", busy: false });
  manager.end({ attached: true, hostInputAt: Date.now() });
  assert.deepEqual(manager.unreadSessions(), []);
  await sleep(30);
  assert.deepEqual(manager.unreadSessions(), [A]);
  notifier.close();
});

test("a dialog is named by what it asks, and the credits consent says to answer in VS Code", async () => {
  const t = setup({ vscodeDelaySec: 0 });
  t.manager.state({ state: "attached", busy: true });
  t.manager.ask("d1", "dialog", "fable_overage_consent_prompt", { localOnly: true });
  t.manager.ask("d2", "dialog", "auto_mode_server_fallback");
  t.manager.ask("d3", "dialog", "some_new_dialog", { localOnly: true });
  await sleep(50);
  assert.deepEqual(t.bodies().sort(), ["Auto 모드 분류기 과금 확인", "VS Code에서 답변하기 · 사용 크레딧 동의", "VS Code에서 답변하기 · 확인 요청"].sort());
  t.notifier.close();
});

test("a copy's first message is told once to each device in its language, naming where the original stays, unless the phone shows the copy", async () => {
  const tablet: Subscription = { endpoint: OTHER, keys: { p256dh: "", auth: "" }, device: "tablet", createdAt: 0, prefs: { ...DEFAULT_PREFS, lang: "en", turnEnd: "off" } };
  const { manager, hub, sent, notifier } = setup({}, [tablet]);
  manager.sessions.push({ id: B, title: "(복사본) Fix the invoice export", cwd: "/home/u/billing-api", lastModified: 0, state: "attached" });
  manager.emit("copy_started", B, "Terminal");
  await sleep(30);
  assert.deepEqual(
    sent.map((s) => [s.endpoint, s.urgency, s.payload.title, s.payload.body, s.payload.tag, s.payload.data.url]),
    [
      [ENDPOINT, "normal", "복사본에서 대화를 시작했습니다", "(복사본) Fix the invoice export · 원본은 터미널에 그대로 있습니다", `${B}:copy`, `/#/s/${B}`],
      [OTHER, "normal", "A copy of a conversation started", "(복사본) Fix the invoice export · the original is still open in a terminal", `${B}:copy`, `/#/s/${B}`],
    ],
  );
  assert.deepEqual(manager.unreadSessions(), [B], "unread, as after any notice, until the phone opens it or VS Code writes to it");
  hub.watching = true;
  manager.emit("copy_started", B, "VS Code");
  await sleep(30);
  assert.equal(sent.length, 2, "nothing while the phone shows it");
  notifier.close();
  hub.watching = false;
  manager.emit("copy_started", B, "VS Code");
  await sleep(30);
  assert.equal(sent.length, 2, "nor once the notifier is closed");
});
