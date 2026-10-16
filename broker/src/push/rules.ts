import path from "node:path";
import type { Hub } from "../hub.ts";
import type { DisplayItem, LiveState, PendingKind, PendingRequest, ServerMsg } from "../protocol.ts";
import type { SessionManager } from "../sessions/manager.ts";
import type { ErrorReason, TurnEnd, TurnOutcome } from "../sessions/outcome.ts";
import type { Subscription } from "./subscriptions.ts";
import type { PushPayload } from "./types.ts";

export type Urgency = "high" | "normal";

export interface PushTiming {
  // Broker-run sessions: how long a request waits before it is notified.
  ownedMs: number;
  // The unit of prefs.vscodeDelaySec.
  secondMs: number;
  // How often a request the user has in front of them is looked at again, in case they leave it unanswered.
  recheckMs: number;
  // How long a finished turn must stay finished before it is notified.
  doneMs: number;
  // Wait before the one retry after a 429 or 5xx answer.
  retryMs: number;
}

export const TIMING: PushTiming = { ownedMs: 1000, secondMs: 1000, recheckMs: 15_000, doneMs: 1500, retryMs: 20_000 };

// What the remote user did this long before a turn started still makes the turn theirs.
const REMOTE_WINDOW_MS = 2 * 3600_000;
const UNSEEN_KEEP_MS = 24 * 3600_000;
const UNSEEN_MAX = 200;
const TITLE_MAX = 80;
const TOOL_MAX = 60;
const SENT_CALLS_KEEP = 200;
const SENT_SESSIONS_KEEP = 200;
const SENT = "파일을 보냈습니다";

const BODY: Record<PendingKind, string> = {
  permission: "권한 요청",
  question: "질문이 있습니다",
  plan: "계획 승인 요청",
  dialog: "확인 요청",
  elicitation: "입력 요청",
};
const LOCAL_ONLY = "VS Code에서 답변하기";
const ENDED: Record<Exclude<TurnOutcome, "interrupted" | "local">, string> = {
  done: "작업을 마쳤습니다",
  error: "오류로 끝났습니다",
  limit: "사용 한도에 걸렸습니다",
  crashed: "Claude Code가 비정상 종료되었습니다",
};
const REASON: Record<Exclude<ErrorReason, "api">, string> = { context: "문맥 한도", login: "로그인 필요", model: "모델 없음" };

function clip(s: string, max: number): string {
  const chars = [...s.replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}

const pad = (n: number) => String(n).padStart(2, "0");

// In the broker's time zone, with the date when it is not today.
function resetText(at: number, now: number): string {
  const d = new Date(at);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date(now).toDateString() ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

// The kind of stop goes along, never anything Claude Code or the user wrote.
export function endText(end: TurnEnd, now = Date.now()): string {
  const text = ENDED[end.outcome as keyof typeof ENDED];
  if (end.outcome === "error") {
    const why = end.reason === "api" ? `API ${end.status}` : end.reason ? REASON[end.reason] : "";
    return why ? `${text} · ${why}` : text;
  }
  return end.outcome === "limit" && end.resetsAt ? `${text} · ${resetText(end.resetsAt, now)} 초기화` : text;
}

export interface NotifierDeps {
  subscriptions: () => Subscription[];
  deliver: (sub: Subscription, payload: PushPayload, urgency: Urgency) => void;
  timing: PushTiming;
  log: (line: string) => void;
}

// Turns session events into notifications for the subscribed devices: a request that needs an answer on a session the
// user is not looking at, and the end of a model turn as each device asks for it. A turn the user stopped or a local
// command such as /compact is not notified. Files Claude sends are told at once when Claude marks them proactive, the
// user being away; others are counted on the next turn end's notice.
export class Notifier {
  private manager: SessionManager;
  private hub: Hub;
  private d: NotifierDeps;
  // Timers by `<session> <request id>` for a request, `<session> end` for a turn that ended, `<session> crash` and
  // `<session> file`.
  private timers = new Map<string, Set<NodeJS.Timeout>>();
  private states = new Map<string, LiveState>();
  // Sessions whose turn end or file went to a device and that were not opened since, with those devices' endpoints.
  private unseen = new Map<string, { at: number; endpoints: Set<string> }>();
  // SendUserFile calls already counted or told, and the files sent since the last turn end, by session.
  private sentCalls = new Map<string, Set<string>>();
  private sentFiles = new Map<string, number>();
  private listener = (sessionId: string, msg: ServerMsg) => {
    try {
      this.onEvent(sessionId, msg);
    } catch (e) {
      this.fail(e);
    }
  };
  private ended = (sessionId: string, end: TurnEnd) => void this.onEnd(sessionId, end).catch((e) => this.fail(e));
  private seen = (sessionId: string) => {
    this.unseen.delete(sessionId);
    this.cancel(`${sessionId} end`);
    this.cancel(`${sessionId} crash`);
    this.cancel(`${sessionId} file`);
  };

  constructor(manager: SessionManager, hub: Hub, deps: NotifierDeps) {
    this.manager = manager;
    this.hub = hub;
    this.d = deps;
    manager.on("event", this.listener);
    manager.on("turn_end", this.ended);
    manager.on("seen", this.seen);
  }

  close(): void {
    this.manager.off("event", this.listener);
    this.manager.off("turn_end", this.ended);
    this.manager.off("seen", this.seen);
    for (const key of [...this.timers.keys()]) this.cancel(key);
  }

  // The number for a device's app icon: sessions with a request waiting for an answer and sessions whose turn end the
  // device was told of and that nobody opened since, each counted once.
  badgeFor(endpoint: string): { badge: number; unseen: string[] } {
    const now = Date.now();
    for (const [id, u] of this.unseen) if (now - u.at > UNSEEN_KEEP_MS) this.unseen.delete(id);
    const unseen = [...this.unseen].filter(([, u]) => u.endpoints.has(endpoint)).map(([id]) => id);
    return { badge: new Set([...this.manager.waitingSessions(), ...unseen]).size, unseen };
  }

  private onEvent(sessionId: string, msg: ServerMsg): void {
    if (msg.t === "pending_add") void this.onPending(sessionId, msg.request).catch((e) => this.fail(e));
    else if (msg.t === "pending_remove") this.cancel(`${sessionId} ${msg.requestId}`);
    else if (msg.t === "state") this.onState(sessionId, msg.state);
    else if (msg.t === "item") this.onItem(sessionId, msg.item);
  }

  // A SendUserFile call counts once, when its result names a file that opens.
  private onItem(sessionId: string, item: DisplayItem): void {
    if (item.kind !== "tool" || item.name !== "SendUserFile") return;
    const files = item.sent?.filter((f) => f.error === undefined) ?? [];
    const calls = this.sentCalls.get(sessionId) ?? new Set<string>();
    if (!files.length || calls.has(item.id)) return;
    calls.add(item.id);
    for (const old of [...calls].slice(0, -SENT_CALLS_KEEP)) calls.delete(old);
    this.sentCalls.delete(sessionId);
    this.sentCalls.set(sessionId, calls);
    for (const old of [...this.sentCalls.keys()].slice(0, -SENT_SESSIONS_KEEP)) this.sentCalls.delete(old);
    const input = item.input !== null && typeof item.input === "object" ? (item.input as Record<string, unknown>) : {};
    if (input.status === "proactive") void this.onFiles(sessionId, files.map((f) => f.name)).catch((e) => this.fail(e));
    else this.sentFiles.set(sessionId, (this.sentFiles.get(sessionId) ?? 0) + files.length);
  }

  // Goes out almost at once to every device unless the user is looking at the session; a newer one replaces it.
  private async onFiles(sessionId: string, names: string[]): Promise<void> {
    if (!this.d.subscriptions().length) return;
    const key = `${sessionId} file`;
    const timers = new Set<NodeJS.Timeout>();
    this.cancel(key);
    this.timers.set(key, timers);
    const { title } = await this.describe(sessionId);
    if (this.timers.get(key) !== timers) return;
    for (const sub of this.d.subscriptions()) {
      this.arm(key, this.d.timing.ownedMs, () => {
        if (this.hub.isWatching(sessionId)) return;
        const now = this.d.subscriptions().find((s) => s.endpoint === sub.endpoint);
        if (!now) return;
        const named = now.prefs.details ? ` · ${clip(names[0], TOOL_MAX)}${names.length > 1 ? ` 외 ${names.length - 1}개` : ""}` : "";
        this.markUnseen(sessionId, now.endpoint);
        const payload: PushPayload = { title, body: `${SENT}${named}`, tag: `${sessionId}:file`, data: { url: `/#/s/${sessionId}` } };
        this.d.deliver(now, { ...payload, badge: this.badgeFor(now.endpoint).badge }, "normal");
      });
    }
  }

  // VS Code sessions wait the device's delay so an answer at the laptop comes first; requests of broker-run
  // sessions and MCP input requests, which only the phone answers, go out almost at once. A request the
  // user is looking at is notified once they look away.
  private async onPending(sessionId: string, request: PendingRequest): Promise<void> {
    if (!this.d.subscriptions().length) return;
    const key = `${sessionId} ${request.id}`;
    const timers = new Set<NodeJS.Timeout>();
    this.cancel(key);
    this.timers.set(key, timers);
    const { title, attached } = await this.describe(sessionId);
    if (this.timers.get(key) !== timers) return;
    const notify = (endpoint: string) => {
      if (this.hub.isWatching(sessionId)) return this.arm(key, this.d.timing.recheckMs, () => notify(endpoint));
      const sub = this.d.subscriptions().find((s) => s.endpoint === endpoint);
      if (!sub) return;
      const tool = (request.kind === "permission" || request.kind === "elicitation") && sub.prefs.details ? request.toolName : undefined;
      this.d.deliver(sub, { ...this.requestPayload(sessionId, request, title, tool), badge: this.badgeFor(endpoint).badge }, "high");
    };
    for (const sub of this.d.subscriptions()) {
      const wait = attached && request.kind !== "elicitation" ? sub.prefs.vscodeDelaySec * this.d.timing.secondMs : this.d.timing.ownedMs;
      this.arm(key, wait, () => notify(sub.endpoint));
    }
  }

  // A new turn makes the last one's end old news. A process that ends takes the notice of its finished turn with it,
  // not the notice of a crash.
  private onState(sessionId: string, state: LiveState): void {
    const wasBusy = this.states.get(sessionId)?.busy;
    if (state.state === "inactive") {
      this.states.delete(sessionId);
      return this.cancel(`${sessionId} end`);
    }
    this.states.set(sessionId, state);
    if (!state.busy) return;
    this.cancel(`${sessionId} end`);
    this.cancel(`${sessionId} crash`);
    if (!wasBusy) this.unseen.delete(sessionId);
  }

  // "remote" devices hear of a turn the remote user sent, started or answered in since REMOTE_WINDOW_MS before it
  // started; "all" devices of every turn. A VS Code turn waits the device's delay unless the remote user gave the last
  // word, and no notice goes once a new turn starts or the user looks at the session.
  private async onEnd(sessionId: string, end: TurnEnd): Promise<void> {
    const files = end.queued ? 0 : (this.sentFiles.get(sessionId) ?? 0);
    if (!end.queued) this.sentFiles.delete(sessionId);
    if (end.outcome === "interrupted" || end.outcome === "local" || end.queued || !this.d.subscriptions().length) return;
    const key = `${sessionId} ${end.outcome === "crashed" ? "crash" : "end"}`;
    const timers = new Set<NodeJS.Timeout>();
    this.cancel(key);
    this.timers.set(key, timers);
    const { title } = await this.describe(sessionId, this.states.get(sessionId));
    if (this.timers.get(key) !== timers) return;
    const at = this.hub.remoteActivity(sessionId);
    const recent = at !== undefined && at >= end.startedAt - REMOTE_WINDOW_MS;
    const remoteLast = at !== undefined && at >= (end.hostInputAt ?? 0);
    const wants = (s: Subscription) => s.prefs.turnEnd === "all" || (s.prefs.turnEnd === "remote" && recent);
    for (const sub of this.d.subscriptions()) {
      if (!wants(sub)) continue;
      const wait = end.attached && !remoteLast ? sub.prefs.vscodeDelaySec * this.d.timing.secondMs : this.d.timing.doneMs;
      this.arm(key, wait, () => {
        if (end.outcome !== "crashed" && this.states.get(sessionId)?.busy) return;
        if (this.hub.isWatching(sessionId)) return;
        const now = this.d.subscriptions().find((s) => s.endpoint === sub.endpoint);
        if (!now || !wants(now)) return;
        this.markUnseen(sessionId, now.endpoint);
        this.d.deliver(now, { ...this.endPayload(sessionId, end, title, files), badge: this.badgeFor(now.endpoint).badge }, end.outcome === "done" ? "normal" : "high");
      });
    }
  }

  private markUnseen(sessionId: string, endpoint: string): void {
    const endpoints = this.unseen.get(sessionId)?.endpoints ?? new Set<string>();
    this.unseen.delete(sessionId);
    this.unseen.set(sessionId, { at: Date.now(), endpoints: endpoints.add(endpoint) });
    for (const old of [...this.unseen.keys()].slice(0, -UNSEEN_MAX)) this.unseen.delete(old);
  }

  // The session's title, or its folder's name, and whether it runs in VS Code. The live state is read once
  // the session list has arrived, so a state that came right after the event counts; `known` stands in for a
  // session that has ended meanwhile.
  private async describe(sessionId: string, known?: LiveState): Promise<{ title: string; attached: boolean }> {
    const listed = await this.manager.list().then(
      (list) => list.find((s) => s.id === sessionId),
      () => undefined,
    );
    const live = this.states.get(sessionId) ?? known;
    const title = listed?.title.trim() || live?.title?.trim() || path.basename(listed?.cwd || live?.cwd || "") || "ccrc";
    return { title: clip(title, TITLE_MAX), attached: (live?.state ?? listed?.state) === "attached" };
  }

  // The tag joins the session and the kind, so a newer notification replaces the older one on the device.
  private requestPayload(sessionId: string, request: PendingRequest, title: string, tool?: string): PushPayload {
    const text = request.localOnly ? `${LOCAL_ONLY} · ${BODY[request.kind]}` : BODY[request.kind];
    return { title, body: tool ? `${text} · ${clip(tool, TOOL_MAX)}` : text, tag: `${sessionId}:${request.kind}`, data: { url: `/#/s/${sessionId}` } };
  }

  // files: how many files Claude sent since the last turn end without telling them on their own.
  private endPayload(sessionId: string, end: TurnEnd, title: string, files = 0): PushPayload {
    return { title, body: `${endText(end)}${files ? ` · 파일 ${files}개` : ""}`, tag: `${sessionId}:end`, data: { url: `/#/s/${sessionId}` } };
  }

  private arm(key: string, ms: number, fn: () => void): void {
    const set = this.timers.get(key);
    if (!set) return;
    const timer = setTimeout(() => {
      set.delete(timer);
      try {
        fn();
      } catch (e) {
        this.fail(e);
      }
    }, ms);
    timer.unref();
    set.add(timer);
  }

  private cancel(key: string): void {
    for (const timer of this.timers.get(key) ?? []) clearTimeout(timer);
    this.timers.delete(key);
  }

  private fail(e: unknown): void {
    this.d.log(`push: notification rule failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
