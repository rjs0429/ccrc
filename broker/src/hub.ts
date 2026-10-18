import type { WebSocket } from "ws";
import type { Audit } from "./audit.ts";
import type { Leases } from "./lease.ts";
import {
  CALL_OPS,
  FOLDER_OPS,
  PERMISSION_MODES,
  SIDE_THREAD_BYTES,
  type Answer,
  type CallOp,
  type ClientMsg,
  type EffortName,
  type GitChanges,
  type ServerMsg,
  type SideTurn,
  type WorktreeChoice,
  type WorktreeRemoved,
} from "./protocol.ts";
import { RemoteActivity } from "./remote-activity.ts";
import type { SideProgress } from "./sessions/core.ts";
import type { SessionManager } from "./sessions/manager.ts";
import { cleanTitle } from "./titles.ts";
import type { Uploads } from "./uploads.ts";
import { WORKTREE_NAME_MAX } from "./worktree-names.ts";

const MAX_TEXT = 100_000;
const PING_MS = 30_000;
const CHANGED_DEBOUNCE_MS = 300;
const EFFORTS: EffortName[] = ["low", "medium", "high", "xhigh", "max"];
const MAX_ATTACHMENTS = 10;
const ELICIT_ACTIONS = new Set<unknown>(["accept", "decline", "cancel"]);
// Calls that change something are recorded in the audit log.
const CHANGING_CALLS = new Set<CallOp>(["mcp_toggle", "mcp_reconnect", "rewind", "stop_task", "resume", "set_output_style", "unqueue", "rename", "archive"]);
// The longest session name taken as typed; it is then cut to the length Claude Code keeps.
const TITLE_ARG_MAX = 2000;
// A folder call refused for a folder is recorded once in this long.
const DENIED_LOG_MS = 60_000;
const DENIED_KEEP = 100;
const DRAFT_ID = /^[A-Za-z0-9-]{1,64}$/;
// A start asked for again with the same draftId in this long gets the session already started.
const DRAFT_KEEP_MS = 10 * 60_000;
// A side question and the thread it is asked in, as the wrapper takes them, and the phone's id for it.
const QUESTION_MAX = 10_000;
const ANSWER_MAX = 100_000;
const THREAD_MAX = 20;
const ASK_ID = /^[A-Za-z0-9-]{1,64}$/;

function sideTurns(v: unknown): SideTurn[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > THREAD_MAX) throw Error("invalid request");
  const turns = v.map((t) => {
    const o = t as Partial<SideTurn> | null;
    if (!o || typeof o !== "object" || typeof o.answer !== "string" || o.answer.length > ANSWER_MAX) throw Error("invalid request");
    if (o.notice !== undefined && (typeof o.notice !== "string" || o.notice.length > QUESTION_MAX)) throw Error("invalid request");
    return { question: str(o.question, QUESTION_MAX), answer: o.answer, ...(o.notice ? { notice: o.notice } : {}) };
  });
  const size = turns.reduce((n, t) => n + Buffer.byteLength(t.question) + Buffer.byteLength(t.answer) + Buffer.byteLength(t.notice ?? ""), 0);
  if (size > SIDE_THREAD_BYTES) throw Error("invalid request");
  return turns;
}

function askId(v: unknown, optional = false): { ask?: string } {
  if (v === undefined && optional) return {};
  if (typeof v !== "string" || !ASK_ID.test(v)) throw Error("invalid request");
  return { ask: v };
}

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function str(v: unknown, max = 200): string {
  if (typeof v !== "string" || !v || v.length > max) throw Error("invalid request");
  return v;
}

function worktreeArg(v: unknown): WorktreeChoice {
  const w = v as Partial<WorktreeChoice> | null;
  if (!w || typeof w !== "object" || (w.base !== "fresh" && w.base !== "head")) throw Error("invalid request");
  return { name: str(w.name, WORKTREE_NAME_MAX), base: w.base };
}

function startFlag(m: SessionManager, sessionId: string): { start?: true } {
  return m.isControlled(sessionId) ? {} : { start: true };
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
  private activity: RemoteActivity;
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
  private deniedLogged = new Map<string, number>();
  private drafts = new Map<string, { at: number; started: Promise<string> }>();

  constructor(manager: SessionManager, leases: Leases, audit: Audit, uploads: Uploads, activity = new RemoteActivity()) {
    this.manager = manager;
    this.leases = leases;
    this.audit = audit;
    this.uploads = uploads;
    this.activity = activity;
    manager.on("event", (sessionId: string, msg: ServerMsg) => {
      if (this.active && sessionId === this.viewing) send(this.active, msg);
    });
    manager.on("changed", () => this.changed());
    manager.on("options_changed", () => {
      if (this.active) send(this.active, { t: "options_changed" });
    });
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

  get connected(): boolean {
    return Boolean(this.active);
  }

  // Whether the remote user has this session in front of them right now.
  isWatching(sessionId: string): boolean {
    return Boolean(this.active) && this.visible && this.viewing === sessionId;
  }

  // When the remote user last sent a message to the session, started it or answered one of its requests.
  remoteActivity(sessionId: string): number | undefined {
    return this.activity.get(sessionId);
  }

  // Every way the remote user starts or continues a session's work calls this, so the end of that work is theirs to hear of.
  noteRemoteActivity(sessionId: string): void {
    this.activity.note(sessionId);
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
    const draftId = msg.t === "new_session" && typeof msg.draftId === "string" && DRAFT_ID.test(msg.draftId) ? msg.draftId : undefined;
    try {
      await this.dispatch(msg, ws);
    } catch (e) {
      send(ws, { t: "error", message: e instanceof Error ? e.message : String(e), sessionId, ...(draftId ? { draftId } : {}) });
    }
  }

  private async startSession(msg: Extract<ClientMsg, { t: "new_session" }>, ids: string[], text: string, device: string): Promise<string> {
    const blocks = ids.length ? await this.uploads.blocks(ids.map((a) => str(a, 64))) : undefined;
    const worktree = msg.worktree === undefined ? undefined : worktreeArg(msg.worktree);
    const s = await this.manager.create(str(msg.cwd, 4096), {
      model: msg.model === undefined ? undefined : str(msg.model),
      mode: msg.mode,
      effort: msg.effort,
      ultracode: msg.ultracode === true,
      fast: msg.fast === true,
      ...(msg.thinking === false ? { thinking: false } : {}),
      ...(worktree ? { worktree } : {}),
    });
    this.audit.log("new_session", {
      device,
      sessionId: s.id,
      cwd: s.cwd,
      ...(worktree ? { worktree } : {}),
      ...(msg.ultracode ? { ultracode: true } : {}),
      ...(msg.fast ? { fast: true } : {}),
      ...(msg.thinking === false ? { thinking: false } : {}),
      ...(ids.length ? { attachments: ids.length } : {}),
    });
    this.noteRemoteActivity(s.id);
    s.send(text, blocks);
    return s.id;
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
        if (this.visible && this.viewing) this.manager.markSeen(this.viewing);
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
        this.noteRemoteActivity(id);
        await m.send(id, text, blocks);
        if (!wasControlled && this.viewing === id) await this.setView(id);
        this.changed();
        return;
      }
      // The attachments are checked before the session is made, so a bad one starts nothing.
      case "new_session": {
        const ids = msg.attachments === undefined ? [] : msg.attachments;
        if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS) throw Error("invalid request");
        const text = ids.length && msg.text === "" ? "" : str(msg.text, MAX_TEXT);
        if (msg.mode !== undefined && !PERMISSION_MODES.includes(msg.mode)) throw Error("invalid mode");
        if (msg.effort !== undefined && !EFFORTS.includes(msg.effort)) throw Error("invalid effort");
        if (msg.ultracode !== undefined && typeof msg.ultracode !== "boolean") throw Error("invalid ultracode");
        if ((msg.fast !== undefined && typeof msg.fast !== "boolean") || (msg.thinking !== undefined && typeof msg.thinking !== "boolean")) throw Error("invalid request");
        if (msg.draftId !== undefined && (typeof msg.draftId !== "string" || !DRAFT_ID.test(msg.draftId))) throw Error("invalid request");
        if (msg.worktree !== undefined) worktreeArg(msg.worktree);
        const draftId = msg.draftId;
        const now = Date.now();
        for (const [k, d] of this.drafts) if (now - d.at > DRAFT_KEEP_MS) this.drafts.delete(k);
        // The phone asks again after a reconnect; the start it already asked for is not run twice.
        let started = draftId ? this.drafts.get(draftId)?.started : undefined;
        if (!started) {
          started = this.startSession(msg, ids, text, device);
          if (draftId) {
            this.drafts.set(draftId, { at: now, started });
            started.catch(() => this.drafts.delete(draftId));
          }
        }
        const id = await started;
        if (this.active) send(this.active, { t: "session_started", sessionId: id, ...(draftId ? { draftId } : {}) });
        await this.setView(id);
        return;
      }
      case "answer": {
        const answer = msg.answer as Answer;
        const id = sid(msg.sessionId);
        const requestId = str(msg.requestId);
        // Of an MCP input answer only the server and the action are recorded, never what was filled in.
        const detail =
          answer?.kind === "elicitation"
            ? { action: ELICIT_ACTIONS.has(answer.action) ? answer.action : "invalid", server: m.pendingRequest(id, requestId)?.elicitation?.server }
            : { decision: answer && "decision" in answer ? answer.decision : undefined };
        this.audit.log("answer", { device, sessionId: id, kind: answer?.kind, ...detail });
        this.noteRemoteActivity(id);
        await m.answer(id, requestId, answer);
        return;
      }
      case "interrupt":
        this.audit.log("interrupt", { device, sessionId: msg.sessionId });
        await m.interrupt(sid(msg.sessionId));
        return;
      // A session without a process keeps these for its next start here ("start" in the record).
      case "set_mode": {
        if (!PERMISSION_MODES.includes(msg.mode)) throw Error("invalid mode");
        const id = sid(msg.sessionId);
        this.audit.log("set_mode", { device, sessionId: id, mode: msg.mode, ...startFlag(m, id) });
        await m.setMode(id, msg.mode);
        return;
      }
      case "set_model": {
        const id = sid(msg.sessionId);
        const model = str(msg.model);
        this.audit.log("set_model", { device, sessionId: id, model, ...startFlag(m, id) });
        await m.setModel(id, model);
        return;
      }
      case "set_effort": {
        if (!EFFORTS.includes(msg.effort)) throw Error("invalid effort");
        const id = sid(msg.sessionId);
        this.audit.log("set_effort", { device, sessionId: id, effort: msg.effort, ...startFlag(m, id) });
        await m.setEffort(id, msg.effort);
        return;
      }
      case "set_ultracode": {
        if (typeof msg.on !== "boolean") throw Error("invalid ultracode");
        const id = sid(msg.sessionId);
        this.audit.log("set_ultracode", { device, sessionId: id, on: msg.on, ...startFlag(m, id) });
        await m.setUltracode(id, msg.on);
        return;
      }
      case "set_fast":
      case "set_thinking": {
        if (typeof msg.on !== "boolean") throw Error("invalid request");
        const id = sid(msg.sessionId);
        this.audit.log(msg.t, { device, sessionId: id, on: msg.on, ...startFlag(m, id) });
        await (msg.t === "set_fast" ? m.setFast(id, msg.on) : m.setThinking(id, msg.on));
        return;
      }
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
      if (!("sessionId" in msg) && "cwd" in msg) {
        reply({ ok: true, data: await this.folderCall(msg) });
        return;
      }
      const sessionId = sid(msg.sessionId);
      if (!CALL_OPS.includes(msg.op)) throw Error("unknown request");
      const args = msg.args && typeof msg.args === "object" && !Array.isArray(msg.args) ? msg.args : {};
      if (msg.op === "set_output_style") str(args.style);
      if (msg.op === "rename") str(args.title, TITLE_ARG_MAX);
      if (msg.op === "archive" && typeof args.archived !== "boolean") throw Error("invalid request");
      if (msg.op === "fork") {
        reply({ ok: true, data: await this.fork(sessionId, args) });
        return;
      }
      if (msg.op === "rewind_conversation") {
        reply({ ok: true, data: await this.rewindConversation(sessionId, args) });
        return;
      }
      // Of a side question only its length and its thread's are recorded; its answer comes after progress lines, also
      // when it is waited for again.
      if (msg.op === "side_question" || msg.op === "side_question_wait") {
        const progress = (p: SideProgress) => {
          if (ws === this.active) send(ws, { t: "call_progress", id, ...p });
        };
        if (msg.op === "side_question_wait") {
          reply({ ok: true, data: await this.manager.call(sessionId, "side_question_wait", askId(args.ask), progress) });
          return;
        }
        const question = str(args.question, QUESTION_MAX);
        const history = sideTurns(args.history);
        const ask = askId(args.ask, true);
        this.audit.log("side_question", { device: this.device, sessionId, chars: question.length, ...(history.length ? { thread: history.length } : {}) });
        reply({ ok: true, data: await this.manager.call(sessionId, "side_question", { question, history, ...ask }, progress) });
        return;
      }
      if (msg.op === "side_question_cancel") {
        reply({ ok: true, data: await this.manager.call(sessionId, "side_question_cancel", askId(args.ask, true)) });
        return;
      }
      if (CHANGING_CALLS.has(msg.op) && !(msg.op === "rewind" && args.dryRun !== false)) {
        const detail = Object.fromEntries(
          Object.entries(args).filter(([k, v]) => ["server", "enabled", "taskId", "userMessageId", "style", "messageId"].includes(k) && (typeof v === "string" || typeof v === "boolean")),
        );
        // Of a new name only its length is recorded.
        const own = msg.op === "rename" ? { chars: [...cleanTitle(String(args.title))].length } : msg.op === "archive" ? { archived: args.archived } : {};
        this.audit.log("call", { device: this.device, sessionId, op: msg.op, ...detail, ...own });
      }
      // Opening the subagents' changes is recorded; following them while the sheet stays open is not.
      if (msg.op === "agent_changes" && args.follow !== true) this.audit.log("agent_changes", { device: this.device, sessionId });
      // Opening a subagent's transcript is recorded; following it as it grows and paging back are not.
      if (msg.op === "agent_transcript" && args.before === undefined && args.after === undefined) {
        const ids = Object.entries(args).filter(([k, v]) => (k === "agentId" || k === "toolUseId") && typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v));
        this.audit.log("agent_transcript", { device: this.device, sessionId, ...Object.fromEntries(ids) });
      }
      const data = await this.manager.call(sessionId, msg.op, args);
      // Reading the folder's git changes is recorded with who read them and how many files they named.
      if (msg.op === "git_changes") {
        const g = data as GitChanges;
        this.audit.log("git_changes", { device: this.device, sessionId, via: g.via, state: g.state, files: g.files.length });
      }
      // A worktree removal is recorded once done, with what went with it.
      if (msg.op === "worktree_remove") {
        const w = data as WorktreeRemoved;
        this.audit.log("worktree_remove", { device: this.device, sessionId, path: w.path, discarded: w.discarded, ...(w.branchKept ? { branchKept: w.branch } : {}) });
      }
      if (msg.op === "resume") {
        if (this.viewing === sessionId) await this.setView(sessionId);
        this.changed();
      }
      reply({ ok: true, data });
    } catch (e) {
      reply({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // A fork given a first message runs it at once, which counts as the remote user's work.
  private async fork(sessionId: string, args: Record<string, unknown>): Promise<unknown> {
    const ids = args.attachments === undefined ? [] : args.attachments;
    if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS || (args.text !== undefined && typeof args.text !== "string")) throw Error("invalid request");
    const text = args.text ? str(args.text, MAX_TEXT) : "";
    const forkId = sid(args.id);
    const before = args.before === undefined ? undefined : sid(args.before);
    const name = args.name === undefined ? undefined : str(args.name, TITLE_ARG_MAX);
    const blocks = ids.length ? await this.uploads.blocks(ids.map((a) => str(a, 64))) : undefined;
    this.audit.log("fork", {
      device: this.device,
      sessionId,
      forkId,
      ...(before ? { before } : {}),
      ...(text ? { chars: text.length } : {}),
      ...(ids.length ? { attachments: ids.length } : {}),
    });
    if (text || blocks) this.noteRemoteActivity(forkId);
    const r = await this.manager.fork(sessionId, { id: forkId, before, text, blocks, name });
    this.changed();
    return r;
  }

  // A rewind in place gives the window that shows the session the conversation as it now stands.
  private async rewindConversation(sessionId: string, args: Record<string, unknown>): Promise<unknown> {
    const userMessageId = sid(args.userMessageId);
    const r = await this.manager.rewindConversation(sessionId, args);
    this.audit.log("rewind_conversation", {
      device: this.device,
      sessionId,
      userMessageId,
      choice: args.choice,
      mode: r.mode,
      ...(r.mode === "forked" ? { forkId: r.sessionId, ...(r.fallback ? { fallback: true } : {}) } : {}),
      ...(r.files ? { files: r.files.canRewind } : {}),
    });
    if (r.mode === "in_place" && this.viewing === sessionId) await this.setView(sessionId);
    this.changed();
    return r;
  }

  // A call about a folder no session runs in yet goes only to a folder a new session may start in. A listing
  // made for it is recorded, and so is a refusal; the queries are not.
  private async folderCall(msg: Extract<ClientMsg, { t: "call"; cwd: string }>): Promise<unknown> {
    if (!FOLDER_OPS.includes(msg.op)) throw Error("unknown request");
    const cwd = str(msg.cwd, 4096);
    const args = msg.args && typeof msg.args === "object" && !Array.isArray(msg.args) ? msg.args : {};
    let dir: string;
    try {
      dir = await this.manager.resolveFolder(cwd);
    } catch (e) {
      this.folderDenied(cwd);
      throw e;
    }
    const device = this.device;
    return this.manager.folderCall(dir, msg.op, args, (files) => this.audit.log("folder_index", { device, cwd: dir, files }));
  }

  private folderDenied(cwd: string): void {
    const now = Date.now();
    if (now - (this.deniedLogged.get(cwd) ?? 0) < DENIED_LOG_MS) return;
    this.deniedLogged.delete(cwd);
    this.deniedLogged.set(cwd, now);
    for (const old of [...this.deniedLogged.keys()].slice(0, -DENIED_KEEP)) this.deniedLogged.delete(old);
    this.audit.log("folder_denied", { device: this.device, cwd });
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
    if (this.active && this.visible) this.manager.markSeen(sessionId);
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
