import type { WebSocket } from "ws";
import type { Audit } from "./audit.ts";
import type { Leases } from "./lease.ts";
import { PERMISSION_MODES, type Answer, type ClientMsg, type EffortName, type ServerMsg } from "./protocol.ts";
import type { SessionManager } from "./sessions/manager.ts";

const MAX_TEXT = 100_000;
const PING_MS = 30_000;
const CHANGED_DEBOUNCE_MS = 300;
const EFFORTS: EffortName[] = ["low", "medium", "high", "xhigh", "max"];

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function str(v: unknown, max = 200): string {
  if (typeof v !== "string" || !v || v.length > max) throw Error("invalid request");
  return v;
}

// Exactly one browser window drives the broker at a time. A second window with the same login
// waits until its user chooses to take over, which disconnects the first window.
export class Hub {
  private manager: SessionManager;
  private leases: Leases;
  private audit: Audit;
  private active?: WebSocket;
  private device = "";
  private standby = new Map<WebSocket, string>();
  private tokens = new WeakMap<WebSocket, string>();
  private viewing: string | null = null;
  private unwatch?: () => void;
  private changedTimer?: NodeJS.Timeout;
  private pinger: NodeJS.Timeout;
  private alive = new WeakSet<WebSocket>();

  constructor(manager: SessionManager, leases: Leases, audit: Audit) {
    this.manager = manager;
    this.leases = leases;
    this.audit = audit;
    manager.on("event", (sessionId: string, msg: ServerMsg) => {
      if (this.active && sessionId === this.viewing) send(this.active, msg);
    });
    manager.on("changed", () => this.changed());
    leases.on("revoked", (reason: string) => this.revokeAll(reason));
    this.pinger = setInterval(() => this.ping(), PING_MS);
    this.pinger.unref();
  }

  attach(ws: WebSocket, device: string, token: string): void {
    this.tokens.set(ws, token);
    this.alive.add(ws);
    ws.on("pong", () => this.alive.add(ws));
    ws.on("message", (data) => void this.onMessage(ws, String(data)));
    ws.on("close", () => {
      this.standby.delete(ws);
      if (ws === this.active) {
        this.active = undefined;
        void this.setView(null);
      }
    });
    if (!this.active) this.activate(ws, device);
    else {
      this.standby.set(ws, device);
      send(ws, { t: "window_conflict" });
    }
  }

  close(): void {
    clearInterval(this.pinger);
    for (const ws of [this.active, ...this.standby.keys()]) ws?.close(1001, "shutdown");
  }

  private activate(ws: WebSocket, device: string): void {
    this.active = ws;
    this.device = device;
    send(ws, { t: "ready" });
  }

  private ping(): void {
    for (const ws of [this.active, ...this.standby.keys()]) {
      if (!ws) continue;
      if (!this.alive.has(ws)) {
        ws.terminate();
        continue;
      }
      this.alive.delete(ws);
      ws.ping();
    }
  }

  private changed(): void {
    if (this.changedTimer) return;
    this.changedTimer = setTimeout(() => {
      this.changedTimer = undefined;
      if (this.active) send(this.active, { t: "sessions_changed" });
    }, CHANGED_DEBOUNCE_MS);
  }

  private revokeAll(reason: string): void {
    for (const ws of [this.active, ...this.standby.keys()]) {
      if (!ws) continue;
      send(ws, { t: "lease_revoked", reason });
      ws.close(4001, "lease revoked");
    }
  }

  private async onMessage(ws: WebSocket, data: string): Promise<void> {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(data) as ClientMsg;
    } catch {
      return;
    }
    if (!this.leases.validate(this.tokens.get(ws))) {
      send(ws, { t: "lease_revoked", reason: "expired" });
      ws.close(4001, "lease expired");
      return;
    }
    if (ws !== this.active) {
      const device = this.standby.get(ws);
      if (msg.t !== "take_window" || device === undefined) return;
      const previous = this.active;
      this.standby.delete(ws);
      if (previous) {
        send(previous, { t: "window_taken" });
        previous.close(4000, "window taken");
      }
      this.audit.log("window_taken", { device });
      this.activate(ws, device);
      return;
    }
    const sessionId = "sessionId" in msg && typeof msg.sessionId === "string" ? msg.sessionId : undefined;
    try {
      await this.dispatch(msg);
    } catch (e) {
      send(ws, { t: "error", message: e instanceof Error ? e.message : String(e), sessionId });
    }
  }

  private async dispatch(msg: ClientMsg): Promise<void> {
    const m = this.manager;
    const device = this.device;
    switch (msg.t) {
      case "ping":
        if (this.active) send(this.active, { t: "pong" });
        return;
      case "view":
        await this.setView(msg.sessionId === null ? null : str(msg.sessionId));
        return;
      case "send": {
        const id = str(msg.sessionId);
        const text = str(msg.text, MAX_TEXT);
        const wasOwned = m.isOwned(id);
        this.audit.log("send", { device, sessionId: id, chars: text.length });
        await m.send(id, text);
        if (!wasOwned && this.viewing === id) await this.setView(id);
        this.changed();
        return;
      }
      case "new_session": {
        const text = str(msg.text, MAX_TEXT);
        if (msg.mode !== undefined && !PERMISSION_MODES.includes(msg.mode)) throw Error("invalid mode");
        if (msg.effort !== undefined && !EFFORTS.includes(msg.effort)) throw Error("invalid effort");
        const s = await m.create(str(msg.cwd, 4096), {
          model: msg.model === undefined ? undefined : str(msg.model),
          mode: msg.mode,
          effort: msg.effort,
        });
        this.audit.log("new_session", { device, sessionId: s.id, cwd: s.cwd });
        s.send(text);
        if (this.active) send(this.active, { t: "session_started", sessionId: s.id });
        await this.setView(s.id);
        return;
      }
      case "answer": {
        const answer = msg.answer as Answer;
        this.audit.log("answer", { device, sessionId: msg.sessionId, kind: answer?.kind, decision: "decision" in answer ? answer.decision : undefined });
        await m.answer(str(msg.sessionId), str(msg.requestId), answer);
        return;
      }
      case "interrupt":
        this.audit.log("interrupt", { device, sessionId: msg.sessionId });
        await m.interrupt(str(msg.sessionId));
        return;
      case "set_mode":
        if (!PERMISSION_MODES.includes(msg.mode)) throw Error("invalid mode");
        this.audit.log("set_mode", { device, sessionId: msg.sessionId, mode: msg.mode });
        await m.setMode(str(msg.sessionId), msg.mode);
        return;
      case "set_model":
        this.audit.log("set_model", { device, sessionId: msg.sessionId, model: msg.model });
        await m.setModel(str(msg.sessionId), str(msg.model));
        return;
      case "set_effort":
        if (!EFFORTS.includes(msg.effort)) throw Error("invalid effort");
        this.audit.log("set_effort", { device, sessionId: msg.sessionId, effort: msg.effort });
        await m.setEffort(str(msg.sessionId), msg.effort);
        return;
      case "release":
        this.audit.log("release", { device, sessionId: msg.sessionId });
        await m.release(str(msg.sessionId));
        return;
      default:
        throw Error("unknown request");
    }
  }

  private async setView(sessionId: string | null): Promise<void> {
    this.unwatch?.();
    this.unwatch = undefined;
    this.viewing = sessionId;
    this.manager.setViewed(sessionId);
    if (!sessionId) return;
    await this.pushSnapshot(sessionId);
    if (!this.manager.isOwned(sessionId) && this.viewing === sessionId) {
      this.unwatch = this.manager.watch(sessionId, () => void this.pushSnapshot(sessionId).catch(() => {}));
    }
  }

  private async pushSnapshot(sessionId: string): Promise<void> {
    const snap = await this.manager.snapshot(sessionId);
    if (this.active && this.viewing === sessionId) send(this.active, { t: "snapshot", sessionId, ...snap });
  }
}
