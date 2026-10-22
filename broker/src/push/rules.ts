import path from "node:path";
import type { Hub } from "../hub.ts";
import type { Lang } from "../lang.ts";
import type { DisplayItem, LiveState, PendingRequest, ServerMsg } from "../protocol.ts";
import type { SessionManager } from "../sessions/manager.ts";
import type { TurnEnd } from "../sessions/outcome.ts";
import { sessionTag } from "./attention.ts";
import type { Subscription } from "./subscriptions.ts";
import { PUSH_TEXT } from "./text.ts";
import type { PushAttention, PushPayload } from "./types.ts";

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
  // How long after a request's notification the app, coming to the front, goes to that request.
  recentMs: number;
}

export const TIMING: PushTiming = { ownedMs: 1000, secondMs: 1000, recheckMs: 15_000, doneMs: 1500, retryMs: 20_000, recentMs: 120_000 };

// What the remote user did this long before a turn started still makes the turn theirs.
const REMOTE_WINDOW_MS = 2 * 3600_000;
const TITLE_MAX = 80;
const TOOL_MAX = 60;
const SENT_CALLS_KEEP = 200;
const SENT_SESSIONS_KEEP = 200;
// PushNotification asks Claude to keep a message under this length.
const CLAUDE_MAX = 200;
const CLAUDE_CALLS_KEEP = 200;

function clip(s: string, max: number): string {
  const chars = [...s.replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}

// The kind of stop goes along, never anything Claude Code or the user wrote.
export function endText(end: TurnEnd, now = Date.now(), lang: Lang = "ko"): string {
  const words = PUSH_TEXT[lang];
  const text = words.ended[end.outcome as keyof typeof words.ended];
  if (end.outcome === "error") {
    const why = end.reason === "api" ? `API ${end.status}` : end.reason ? words.reason[end.reason] : "";
    return why ? `${text} · ${why}` : text;
  }
  return end.outcome === "limit" && end.resetsAt ? `${text} · ${words.resets(end.resetsAt, now)}` : text;
}

// What became of a notification Claude asked for: on its way to the devices that want it, not needed as the user is
// looking at the session, or wanted by no device.
export type ClaudeNotice = "sent" | "watching" | "off";

const record = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export interface NotifierDeps {
  subscriptions: () => Subscription[];
  deliver: (sub: Subscription, payload: PushPayload, urgency: Urgency) => void;
  timing: PushTiming;
  log: (line: string) => void;
  now?: () => number;
}

// Turns session events into notifications for the subscribed devices: a request that needs an answer on a session the
// user is not looking at, and the end of a model turn as each device asks for it. A turn the user stopped or a local
// command such as /compact is not notified. Files Claude sends are told at once when Claude marks them proactive, the
// user being away; others are counted on the next turn end's notice. A notification Claude asks for goes out at once
// and stands in for the notice that its turn finished. A turn the remote user waits for, and any notice told, leaves
// the session unread until it is opened.
export class Notifier {
  private manager: SessionManager;
  private hub: Hub;
  private d: NotifierDeps;
  private now: () => number;
  // Timers by `<session> <request id>` for a request, `<session> end` for a turn that ended, `<session> crash`,
  // `<session> file` and `<session> claude`.
  private timers = new Map<string, Set<NodeJS.Timeout>>();
  private states = new Map<string, LiveState>();
  // SendUserFile calls already counted or told, and the files sent since the last turn end, by session.
  private sentCalls = new Map<string, Set<string>>();
  private sentFiles = new Map<string, number>();
  // PushNotification calls by their tool use id, and the devices a notification from Claude goes to in the session's
  // current turn, until the session is opened.
  private claudeCalls = new Map<string, ClaudeNotice>();
  private told = new Map<string, Set<string>>();
  // The last notification each device got, by endpoint, with the request it was about if it was one.
  private last = new Map<string, { sessionId: string; requestId?: string; at: number }>();
  private listener = (sessionId: string, msg: ServerMsg) => {
    try {
      this.onEvent(sessionId, msg);
    } catch (e) {
      this.fail(e);
    }
  };
  private ended = (sessionId: string, end: TurnEnd) => {
    const told = this.told.get(sessionId);
    this.told.delete(sessionId);
    this.noteEnd(sessionId, end);
    void this.onEnd(sessionId, end, told).catch((e) => this.fail(e));
  };
  private seen = (sessionId: string) => {
    this.told.delete(sessionId);
    for (const what of ["end", "crash", "file", "claude"]) this.cancel(`${sessionId} ${what}`);
  };
  private notice = (sessionId: string, toolUseId: string, message: string) => this.claudeCall(sessionId, toolUseId, message);

  constructor(manager: SessionManager, hub: Hub, deps: NotifierDeps) {
    this.manager = manager;
    this.hub = hub;
    this.d = deps;
    this.now = deps.now ?? (() => Date.now());
    manager.on("event", this.listener);
    manager.on("turn_end", this.ended);
    manager.on("seen", this.seen);
    manager.claudeNotice = this.notice;
  }

  close(): void {
    this.manager.off("event", this.listener);
    this.manager.off("turn_end", this.ended);
    this.manager.off("seen", this.seen);
    if (this.manager.claudeNotice === this.notice) this.manager.claudeNotice = undefined;
    for (const key of [...this.timers.keys()]) this.cancel(key);
  }

  // The number for the app icon: sessions with a request waiting for an answer and sessions left unread, each counted
  // once, as the session list shows them; with those sessions as of now.
  attention(): PushAttention & { badge: number } {
    const unseen = this.manager.unreadSessions();
    const waiting = this.manager.waitingSessions();
    return { badge: new Set([...waiting, ...unseen]).size, at: this.now(), unseen, waiting };
  }

  // A notification as it leaves: when it was made, and the number and sessions by which the phone sets its icon and
  // closes the notifications that no longer count.
  stamp(payload: PushPayload): PushPayload {
    const { badge, ...attention } = this.attention();
    return { ...payload, data: { ...payload.data, at: attention.at }, badge, attention };
  }

  // The request the device's last notification was about, while that is recent and the request still waits.
  recent(endpoint: string): { sessionId: string; requestId: string } | undefined {
    const l = this.last.get(endpoint);
    if (!l?.requestId || Date.now() - l.at > this.d.timing.recentMs || !this.manager.pendingRequest(l.sessionId, l.requestId)) return undefined;
    return { sessionId: l.sessionId, requestId: l.requestId };
  }

  private deliver(sub: Subscription, sessionId: string, payload: PushPayload, urgency: Urgency, requestId?: string): void {
    this.d.deliver(sub, this.stamp(payload), urgency);
    this.last.delete(sub.endpoint);
    this.last.set(sub.endpoint, { sessionId, ...(requestId ? { requestId } : {}), at: Date.now() });
    for (const old of [...this.last.keys()].slice(0, -SENT_SESSIONS_KEEP)) this.last.delete(old);
  }

  // A PushNotification call Claude Code ran, from its result in the conversation or from the session's PostToolUse
  // hook, whichever comes first; each call is decided once. Without a device that wants it, or with the user looking at
  // the session, nothing goes.
  claudeCall(sessionId: string, toolUseId: string, message: string): ClaudeNotice {
    const known = this.claudeCalls.get(toolUseId);
    if (known) return known;
    const endpoints = this.d.subscriptions().filter((s) => s.prefs.claude).map((s) => s.endpoint);
    const notice: ClaudeNotice = !endpoints.length ? "off" : this.hub.isWatching(sessionId) ? "watching" : "sent";
    this.claudeCalls.set(toolUseId, notice);
    for (const old of [...this.claudeCalls.keys()].slice(0, -CLAUDE_CALLS_KEEP)) this.claudeCalls.delete(old);
    if (notice === "sent") void this.onClaude(sessionId, message, endpoints).catch((e) => this.fail(e));
    return notice;
  }

  private onEvent(sessionId: string, msg: ServerMsg): void {
    if (msg.t === "pending_add") void this.onPending(sessionId, msg.request).catch((e) => this.fail(e));
    else if (msg.t === "pending_remove") this.cancel(`${sessionId} ${msg.requestId}`);
    else if (msg.t === "state") this.onState(sessionId, msg.state);
    else if (msg.t === "item") this.onItem(sessionId, msg.item);
  }

  // A SendUserFile call counts once, when its result names a file that opens. A PushNotification call counts once
  // Claude Code ran it: one it refused or that failed sends nothing.
  private onItem(sessionId: string, item: DisplayItem): void {
    if (item.kind !== "tool") return;
    if (item.name === "PushNotification") {
      if (!item.result || item.result.isError) return;
      const message = record(item.input).message;
      this.claudeCall(sessionId, item.id, typeof message === "string" ? message : "");
      return;
    }
    if (item.name !== "SendUserFile") return;
    const files = item.sent?.filter((f) => f.error === undefined) ?? [];
    const calls = this.sentCalls.get(sessionId) ?? new Set<string>();
    if (!files.length || calls.has(item.id)) return;
    calls.add(item.id);
    for (const old of [...calls].slice(0, -SENT_CALLS_KEEP)) calls.delete(old);
    this.sentCalls.delete(sessionId);
    this.sentCalls.set(sessionId, calls);
    for (const old of [...this.sentCalls.keys()].slice(0, -SENT_SESSIONS_KEEP)) this.sentCalls.delete(old);
    const input = item.input !== null && typeof item.input === "object" ? (item.input as Record<string, unknown>) : {};
    const count = files.length + (item.sentCut ?? 0);
    if (input.status === "proactive") void this.onFiles(sessionId, files[0].name, count).catch((e) => this.fail(e));
    else this.sentFiles.set(sessionId, (this.sentFiles.get(sessionId) ?? 0) + count);
  }

  // Goes out almost at once to every device unless the user is looking at the session; a newer one replaces it.
  private async onFiles(sessionId: string, name: string, count: number): Promise<void> {
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
        const words = PUSH_TEXT[now.prefs.lang];
        const named = now.prefs.details ? ` · ${clip(name, TOOL_MAX)}${count > 1 ? words.more(count - 1) : ""}` : "";
        this.manager.markUnread(sessionId);
        const payload: PushPayload = { title, body: `${words.sent}${named}`, tag: sessionTag(sessionId, "file"), data: { url: `/#/s/${sessionId}` } };
        this.deliver(now, sessionId, payload, "normal");
      });
    }
  }

  // Goes out almost at once, VS Code session or not, as the user asked Claude to tell them; a newer one replaces it.
  // With details on it gives what Claude wrote. The devices count as told for the rest of the turn.
  private async onClaude(sessionId: string, message: string, endpoints: string[]): Promise<void> {
    const key = `${sessionId} claude`;
    const timers = new Set<NodeJS.Timeout>();
    this.cancel(key);
    this.timers.set(key, timers);
    const told = this.told.get(sessionId) ?? new Set<string>();
    this.told.set(sessionId, told);
    for (const endpoint of endpoints) told.add(endpoint);
    const { title } = await this.describe(sessionId);
    if (this.timers.get(key) !== timers) return;
    for (const endpoint of endpoints) {
      this.arm(key, this.d.timing.ownedMs, () => {
        const sub = this.d.subscriptions().find((s) => s.endpoint === endpoint);
        if (!sub?.prefs.claude || this.hub.isWatching(sessionId)) return void told.delete(endpoint);
        const body = sub.prefs.details && message.trim() ? clip(message, CLAUDE_MAX) : PUSH_TEXT[sub.prefs.lang].claude;
        this.manager.markUnread(sessionId);
        const payload: PushPayload = { title, body, tag: sessionTag(sessionId, "claude"), data: { url: `/#/s/${sessionId}` } };
        this.deliver(sub, sessionId, payload, "high");
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
      this.deliver(sub, sessionId, this.requestPayload(sessionId, request, title, sub.prefs.lang, tool), "high", request.id);
    };
    for (const sub of this.d.subscriptions()) {
      const wait = attached && request.kind !== "elicitation" ? sub.prefs.vscodeDelaySec * this.d.timing.secondMs : this.d.timing.ownedMs;
      this.arm(key, wait, () => notify(sub.endpoint));
    }
  }

  // A new turn makes the last one's end old news. A process that ends takes the notice of its finished turn with it,
  // not the notice of a crash.
  private onState(sessionId: string, state: LiveState): void {
    if (state.state === "inactive") {
      this.states.delete(sessionId);
      return this.cancel(`${sessionId} end`);
    }
    this.states.set(sessionId, state);
    if (!state.busy) return;
    this.cancel(`${sessionId} end`);
    this.cancel(`${sessionId} crash`);
  }

  // The remote user sent to the session, started or answered in it since REMOTE_WINDOW_MS before the turn started.
  private remoteTurn(sessionId: string, end: TurnEnd): boolean {
    const at = this.hub.remoteActivity(sessionId);
    return at !== undefined && at >= end.startedAt - REMOTE_WINDOW_MS;
  }

  // The remote user did so after VS Code's last message to the session.
  private remoteLast(sessionId: string, end: TurnEnd): boolean {
    const at = this.hub.remoteActivity(sessionId);
    return at !== undefined && at >= (end.hostInputAt ?? 0);
  }

  // A turn of a session the broker runs, or a VS Code turn the remote user waits for (theirs, with the last word), leaves
  // the session unread unless the user is looking at it as it ends; another VS Code turn does once a notice of it goes.
  private noteEnd(sessionId: string, end: TurnEnd): void {
    if (end.outcome === "interrupted" || end.outcome === "local" || end.queued || this.hub.isWatching(sessionId)) return;
    if (!end.attached || (this.remoteTurn(sessionId, end) && this.remoteLast(sessionId, end))) this.manager.markUnread(sessionId);
  }

  // "remote" devices hear of a turn the remote user sent, started or answered in since REMOTE_WINDOW_MS before it
  // started; "all" devices of every turn. A VS Code turn waits the device's delay unless the remote user gave the last
  // word, and no notice goes once a new turn starts or the user looks at the session. told: devices Claude's own
  // notification reached in the turn, which hear of it finishing only with files sent or when it stopped short.
  private async onEnd(sessionId: string, end: TurnEnd, told?: Set<string>): Promise<void> {
    const files = end.queued ? 0 : (this.sentFiles.get(sessionId) ?? 0);
    if (!end.queued) this.sentFiles.delete(sessionId);
    if (end.outcome === "interrupted" || end.outcome === "local" || end.queued || !this.d.subscriptions().length) return;
    const key = `${sessionId} ${end.outcome === "crashed" ? "crash" : "end"}`;
    const timers = new Set<NodeJS.Timeout>();
    this.cancel(key);
    this.timers.set(key, timers);
    const { title } = await this.describe(sessionId, this.states.get(sessionId));
    if (this.timers.get(key) !== timers) return;
    const recent = this.remoteTurn(sessionId, end);
    const remoteLast = this.remoteLast(sessionId, end);
    const wants = (s: Subscription) => s.prefs.turnEnd === "all" || (s.prefs.turnEnd === "remote" && recent);
    for (const sub of this.d.subscriptions()) {
      if (!wants(sub)) continue;
      const wait = end.attached && !remoteLast ? sub.prefs.vscodeDelaySec * this.d.timing.secondMs : this.d.timing.doneMs;
      this.arm(key, wait, () => {
        if (end.outcome !== "crashed" && this.states.get(sessionId)?.busy) return;
        if (this.hub.isWatching(sessionId)) return;
        const now = this.d.subscriptions().find((s) => s.endpoint === sub.endpoint);
        if (!now || !wants(now)) return;
        if (end.outcome === "done" && !files && told?.has(now.endpoint)) return;
        this.manager.markUnread(sessionId);
        this.deliver(now, sessionId, this.endPayload(sessionId, end, title, now.prefs.lang, files), end.outcome === "done" ? "normal" : "high");
      });
    }
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
  private requestPayload(sessionId: string, request: PendingRequest, title: string, lang: Lang, tool?: string): PushPayload {
    const words = PUSH_TEXT[lang];
    const what = request.kind === "dialog" && Object.hasOwn(words.dialogs, request.toolName) ? words.dialogs[request.toolName] : words.request[request.kind];
    const text = request.localOnly ? `${words.localOnly} · ${what}` : what;
    return { title, body: tool ? `${text} · ${clip(tool, TOOL_MAX)}` : text, tag: sessionTag(sessionId, request.kind), data: { url: `/#/s/${sessionId}` } };
  }

  // files: how many files Claude sent since the last turn end without telling them on their own.
  private endPayload(sessionId: string, end: TurnEnd, title: string, lang: Lang, files = 0): PushPayload {
    return { title, body: `${endText(end, Date.now(), lang)}${files ? ` · ${PUSH_TEXT[lang].files(files)}` : ""}`, tag: sessionTag(sessionId, "end"), data: { url: `/#/s/${sessionId}` } };
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
