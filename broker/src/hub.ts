import type { WebSocket } from "ws";
import type { Audit } from "./audit.ts";
import type { Leases } from "./lease.ts";
import { CALL_OPS, PERMISSION_MODES, type Answer, type CallOp, type ClientMsg, type EffortName, type ServerMsg } from "./protocol.ts";
import type { SessionManager } from "./sessions/manager.ts";
import type { Uploads } from "./uploads.ts";

const MAX_TEXT = 100_000;
const PING_MS = 30_000;
const CHANGED_DEBOUNCE_MS = 300;
const EFFORTS: EffortName[] = ["low", "medium", "high", "xhigh", "max"];
const MAX_ATTACHMENTS = 10;
// Calls that change something are recorded in the audit log.
const CHANGING_CALLS = new Set<CallOp>(["mcp_toggle", "mcp_reconnect", "rewind", "stop_task"]);

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function str(v: unknown, max = 200): string {
  if (typeof v !== "string" || !v || v.length > max) throw Error("invalid request");
  return v;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sid(v: unknown): string {
  const s = str(v, 64);
  if (!UUID.test(s)) throw Error("invalid request");
  return s;
}

// Exactly one browser window drives the broker at a time. A second window with the same login
// waits until its user chooses to take over, which disconnects the first window.
export class Hub {
  private manager: SessionManager;
  private leases: Leases;
  private audit: Audit;
  private uploads: Uploads;
  private visible = true;
  private remoteSends = new Map<string, number>();
  private active?: WebSocket;
  private device = "";
  private standby = new Map<WebSocket, string>();
  private tokens = new WeakMap<WebSocket, string>();
  private viewing: string | null = null;
  private viewSeq = 0;
  private focus?: string;
  private unwatch?: () => void;
  // Items last sent for the viewed session, by id, as JSON.
  private shown = new Map<string, string>();
  private changedTimer?: NodeJS.Timeout;
  private pinger: NodeJS.Timeout;
  private alive = new WeakSet<WebSocket>();

  constructor(manager: SessionManager, leases: Leases, audit: Audit, uploads: Uploads) {
    this.manager = manager;
    this.leases = leases;
    this.audit = audit;
    this.uploads = uploads;
    manager.on("event", (sessionId: string, msg: ServerMsg) => {
      if (this.active && sessionId === this.viewing) send(this.active, msg);
    });
    manager.on("changed", () => this.changed());
    for (const ev of ["attached", "detached"]) {
      manager.on(ev, (sessionId: string) => {
        if (this.active && sessionId === this.viewing) void this.setView(sessionId).catch(() => {});
      });
    }
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

  // Whether the remote user has this session in front of them right now.
  isWatching(sessionId: string): boolean {
    return Boolean(this.active) && this.visible && this.viewing === sessionId;
  }

  // When the remote user last sent a message to the session.
  remoteSent(sessionId: string): number | undefined {
    return this.remoteSends.get(sessionId);
  }

  close(): void {
    clearInterval(this.pinger);
    for (const ws of [this.active, ...this.standby.keys()]) ws?.close(1001, "shutdown");
  }

  private activate(ws: WebSocket, device: string): void {
    this.active = ws;
    this.device = device;
    this.visible = true;
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
      await this.dispatch(msg, ws);
    } catch (e) {
      send(ws, { t: "error", message: e instanceof Error ? e.message : String(e), sessionId });
    }
  }

  private async dispatch(msg: ClientMsg, ws: WebSocket): Promise<void> {
    const m = this.manager;
    const device = this.device;
    switch (msg.t) {
      case "ping":
        if (this.active) send(this.active, { t: "pong" });
        return;
      case "view":
        if (msg.focus !== undefined) str(msg.focus, 128);
        await this.setView(msg.sessionId === null ? null : sid(msg.sessionId), msg.focus);
        return;
      case "visibility":
        this.visible = msg.visible === true;
        return;
      case "call":
        await this.call(msg, ws);
        return;
      case "send": {
        const id = sid(msg.sessionId);
        const ids = msg.attachments === undefined ? [] : msg.attachments;
        if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS) throw Error("invalid request");
        const text = ids.length && msg.text === "" ? "" : str(msg.text, MAX_TEXT);
        const blocks = ids.length ? await this.uploads.blocks(ids.map((a) => str(a, 64))) : undefined;
        const wasControlled = m.isControlled(id);
        this.audit.log("send", { device, sessionId: id, chars: text.length, ...(ids.length ? { attachments: ids.length } : {}) });
        this.remoteSends.set(id, Date.now());
        await m.send(id, text, blocks);
        if (!wasControlled && this.viewing === id) await this.setView(id);
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
        this.remoteSends.set(s.id, Date.now());
        s.send(text);
        if (this.active) send(this.active, { t: "session_started", sessionId: s.id });
        await this.setView(s.id);
        return;
      }
      case "answer": {
        const answer = msg.answer as Answer;
        this.audit.log("answer", { device, sessionId: msg.sessionId, kind: answer?.kind, decision: "decision" in answer ? answer.decision : undefined });
        await m.answer(sid(msg.sessionId), str(msg.requestId), answer);
        return;
      }
      case "interrupt":
        this.audit.log("interrupt", { device, sessionId: msg.sessionId });
        await m.interrupt(sid(msg.sessionId));
        return;
      case "set_mode":
        if (!PERMISSION_MODES.includes(msg.mode)) throw Error("invalid mode");
        this.audit.log("set_mode", { device, sessionId: msg.sessionId, mode: msg.mode });
        await m.setMode(sid(msg.sessionId), msg.mode);
        return;
      case "set_model":
        this.audit.log("set_model", { device, sessionId: msg.sessionId, model: msg.model });
        await m.setModel(sid(msg.sessionId), str(msg.model));
        return;
      case "set_effort":
        if (!EFFORTS.includes(msg.effort)) throw Error("invalid effort");
        this.audit.log("set_effort", { device, sessionId: msg.sessionId, effort: msg.effort });
        await m.setEffort(sid(msg.sessionId), msg.effort);
        return;
      case "set_ultracode":
        if (typeof msg.on !== "boolean") throw Error("invalid ultracode");
        this.audit.log("set_ultracode", { device, sessionId: msg.sessionId, on: msg.on });
        await m.setUltracode(sid(msg.sessionId), msg.on);
        return;
      case "release":
        this.audit.log("release", { device, sessionId: msg.sessionId });
        await m.release(sid(msg.sessionId));
        return;
      default:
        throw Error("unknown request");
    }
  }

  // A call answers with call_result whether it succeeds or not, to the window that asked: call ids are
  // numbered per page, so another window may be waiting on the same id.
  private async call(msg: Extract<ClientMsg, { t: "call" }>, ws: WebSocket): Promise<void> {
    const id = msg.id;
    if (typeof id !== "number") throw Error("invalid request");
    const reply = (r: { ok: boolean; data?: unknown; error?: string }) => {
      if (ws === this.active) send(ws, { t: "call_result", id, ...r });
    };
    try {
      const sessionId = sid(msg.sessionId);
      if (!CALL_OPS.includes(msg.op)) throw Error("unknown request");
      const args = msg.args && typeof msg.args === "object" && !Array.isArray(msg.args) ? msg.args : {};
      if (CHANGING_CALLS.has(msg.op) && !(msg.op === "rewind" && args.dryRun !== false)) {
        const detail = Object.fromEntries(
          Object.entries(args).filter(([k, v]) => ["server", "enabled", "taskId", "userMessageId"].includes(k) && (typeof v === "string" || typeof v === "boolean")),
        );
        this.audit.log("call", { device: this.device, sessionId, op: msg.op, ...detail });
      }
      reply({ ok: true, data: await this.manager.call(sessionId, msg.op, args) });
    } catch (e) {
      reply({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Each view change gets a number; work for an older view is dropped when it finishes. A session
  // without a process the broker drives is followed through its transcript.
  private async setView(sessionId: string | null, focus?: string): Promise<void> {
    const seq = ++this.viewSeq;
    if (focus || sessionId !== this.viewing) this.focus = focus;
    this.unwatch?.();
    this.unwatch = undefined;
    this.viewing = sessionId;
    this.manager.setViewed(sessionId);
    if (!sessionId) return;
    const controlled = this.manager.isControlled(sessionId);
    const snap = await this.manager.snapshot(sessionId, this.focus);
    if (seq !== this.viewSeq || !this.active) return;
    if (!controlled && this.manager.isControlled(sessionId)) return;
    this.shown = new Map(snap.items.map((i) => [i.id, JSON.stringify(i)]));
    send(this.active, { t: "snapshot", sessionId, ...snap });
    if (!controlled) this.unwatch = this.manager.watch(sessionId, () => void this.pushChanges(sessionId, seq).catch(() => {}));
  }

  // Sends only the items that changed since the last snapshot; a rewritten history gets a new snapshot.
  private async pushChanges(sessionId: string, seq: number): Promise<void> {
    const snap = await this.manager.snapshot(sessionId, this.focus);
    if (seq !== this.viewSeq || !this.active || this.manager.isControlled(sessionId)) return;
    const before = [...this.shown.keys()];
    const start = before.indexOf(snap.items[0]?.id ?? "");
    const ids = new Set(snap.items.map((i) => i.id));
    if ((before.length && start === -1) || before.slice(Math.max(start, 0)).some((id) => !ids.has(id))) {
      this.shown = new Map(snap.items.map((i) => [i.id, JSON.stringify(i)]));
      send(this.active, { t: "snapshot", sessionId, ...snap });
      return;
    }
    for (const item of snap.items) {
      const json = JSON.stringify(item);
      if (this.shown.get(item.id) === json) continue;
      this.shown.set(item.id, json);
      send(this.active, { t: "item", sessionId, item });
    }
    send(this.active, { t: "state", sessionId, state: snap.state });
  }
}
