import path from "node:path";
import type { Hub } from "../hub.ts";
import type { LiveState, PendingKind, PendingRequest, ServerMsg } from "../protocol.ts";
import type { SessionManager } from "../sessions/manager.ts";
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

const REMOTE_WINDOW_MS = 2 * 3600_000;
const TITLE_MAX = 80;
const TOOL_MAX = 60;

const BODY: Record<PendingKind | "done", string> = {
  permission: "권한 요청",
  question: "질문이 있습니다",
  plan: "계획 승인 요청",
  dialog: "확인 요청",
  elicitation: "입력 요청",
  done: "작업을 마쳤습니다",
};

function clip(s: string, max: number): string {
  const chars = [...s.replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}

export interface NotifierDeps {
  subscriptions: () => Subscription[];
  deliver: (sub: Subscription, payload: PushPayload, urgency: Urgency) => void;
  timing: PushTiming;
  log: (line: string) => void;
}

// Turns session events into notifications for the subscribed devices: a request that needs an answer
// on a session the user is not looking at, and the end of a turn the remote user started.
export class Notifier {
  private manager: SessionManager;
  private hub: Hub;
  private d: NotifierDeps;
  // Timers by `<session> <request id>` for a request and `<session> done` for a finished turn.
  private timers = new Map<string, Set<NodeJS.Timeout>>();
  private states = new Map<string, LiveState>();
  private listener = (sessionId: string, msg: ServerMsg) => {
    try {
      this.onEvent(sessionId, msg);
    } catch (e) {
      this.fail(e);
    }
  };

  constructor(manager: SessionManager, hub: Hub, deps: NotifierDeps) {
    this.manager = manager;
    this.hub = hub;
    this.d = deps;
    manager.on("event", this.listener);
  }

  close(): void {
    this.manager.off("event", this.listener);
    for (const key of [...this.timers.keys()]) this.cancel(key);
  }

  private onEvent(sessionId: string, msg: ServerMsg): void {
    if (msg.t === "pending_add") void this.onPending(sessionId, msg.request).catch((e) => this.fail(e));
    else if (msg.t === "pending_remove") this.cancel(`${sessionId} ${msg.requestId}`);
    else if (msg.t === "state") this.onState(sessionId, msg.state);
  }

  // VS Code sessions wait the device's delay so an answer at the laptop comes first; requests of broker-run
  // sessions go out almost at once. A request the user is looking at is notified once they look away.
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
      this.d.deliver(sub, this.payload(sessionId, request.kind, title, tool), "high");
    };
    for (const sub of this.d.subscriptions()) {
      const wait = attached ? sub.prefs.vscodeDelaySec * this.d.timing.secondMs : this.d.timing.ownedMs;
      this.arm(key, wait, () => notify(sub.endpoint));
    }
  }

  private onState(sessionId: string, state: LiveState): void {
    const key = `${sessionId} done`;
    const wasBusy = this.states.get(sessionId)?.busy;
    if (state.state === "inactive") {
      this.states.delete(sessionId);
      return this.cancel(key);
    }
    this.states.set(sessionId, state);
    if (state.busy) return this.cancel(key);
    if (!wasBusy || !this.remoteSentRecently(sessionId) || !this.d.subscriptions().length) return;
    const timers = new Set<NodeJS.Timeout>();
    this.cancel(key);
    this.timers.set(key, timers);
    void this.describe(sessionId)
      .then(({ title }) => {
        if (this.timers.get(key) !== timers) return;
        for (const sub of this.d.subscriptions()) {
          if (!sub.prefs.turnDone) continue;
          this.arm(key, this.d.timing.doneMs, () => {
            if (this.states.get(sessionId)?.busy || this.hub.isWatching(sessionId)) return;
            const now = this.d.subscriptions().find((s) => s.endpoint === sub.endpoint);
            if (now?.prefs.turnDone) this.d.deliver(now, this.payload(sessionId, "done", title), "normal");
          });
        }
      })
      .catch((e) => this.fail(e));
  }

  private remoteSentRecently(sessionId: string): boolean {
    const at = this.hub.remoteSent(sessionId);
    return at !== undefined && Date.now() - at <= REMOTE_WINDOW_MS;
  }

  // The session's title, or its folder's name, and whether it runs in VS Code. The live state is read once
  // the session list has arrived, so a state that came right after the event counts.
  private async describe(sessionId: string): Promise<{ title: string; attached: boolean }> {
    const listed = await this.manager.list().then(
      (list) => list.find((s) => s.id === sessionId),
      () => undefined,
    );
    const live = this.states.get(sessionId);
    const title = listed?.title.trim() || live?.title?.trim() || path.basename(listed?.cwd || live?.cwd || "") || "ccrc";
    return { title: clip(title, TITLE_MAX), attached: (live?.state ?? listed?.state) === "attached" };
  }

  // The tag joins the session and the kind, so a newer notification replaces the older one on the device.
  private payload(sessionId: string, kind: PendingKind | "done", title: string, tool?: string): PushPayload {
    return {
      title,
      body: tool ? `${BODY[kind]} · ${clip(tool, TOOL_MAX)}` : BODY[kind],
      tag: `${sessionId}:${kind}`,
      data: { url: `/#/s/${sessionId}` },
    };
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
