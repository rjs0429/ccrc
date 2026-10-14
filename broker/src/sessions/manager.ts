import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { listSessions, type ModelInfo, type SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import type { Audit } from "../audit.ts";
import { paths, writeFileAtomic, type Config } from "../config.ts";
import type { Hello } from "../link/protocol.ts";
import type { Link } from "../link/server.ts";
import {
  PERMISSION_MODES,
  type CallOp,
  type ContextGauge,
  type DisplayItem,
  type EffortName,
  type LiveState,
  type ModelOption,
  type PendingRequest,
  type PermissionModeName,
  type ServerMsg,
  type SessionSummary,
  type StartSettings,
  type UsageInfo,
} from "../protocol.ts";
import { BrokerSession, probeModels, probeUsage, probeWindow, type StartOptions } from "./broker-session.ts";
import { lastCommands, rememberCommands } from "./commands.ts";
import { ContextWindows, gauge, lastUsage, type ContextWindow } from "./context-gauge.ts";
import type { ContentBlock, SessionCore } from "./core.ts";
import { searchFiles } from "./files.ts";
import { lastCwd, loadHistory, projectDirName, transcriptPath } from "./history.ts";
import { liveProcesses } from "./live.ts";
import { WrappedSession } from "./wrapped.ts";

const CATALOG_MS = 3000;
const SNAPSHOT_ITEMS = 400;
const FOCUS_BEFORE = 20;
const FOCUS_ITEMS_MAX = 1500;
const SWEEP_MS = 60_000;
const WATCH_INTERVAL_MS = 2000;
// Handing a session to VS Code: how long the broker's running turn may go on before it is interrupted,
// and how long to wait for any other process that still holds the session to end.
const HANDOFF_TURN_MS = 10_000;
const HANDOFF_OTHER_MS = 9_000;
const EARLY_LINES_MAX = 500;
const ENDED_KEEP_MS = 10 * 60_000;
const USAGE_KEEP_MS = 30_000;
const MODEL_NAME = /^[A-Za-z0-9][\w.:[\]\/@-]{0,99}$/;

export interface ManagerTiming {
  handoffTurnMs: number;
  handoffOtherMs: number;
}

export interface Snapshot {
  items: DisplayItem[];
  pending: PendingRequest[];
  state: LiveState;
  hasMore: boolean;
}

function titleOf(info: SDKSessionInfo): string {
  return info.customTitle || info.summary || info.firstPrompt || "";
}

// The latest items, reaching back to the focused item when that stays within a bound.
export function tail(items: DisplayItem[], focus?: string): { items: DisplayItem[]; hasMore: boolean } {
  const at = focus ? items.findIndex((i) => i.id === focus) : -1;
  const from = at >= 0 && items.length - at <= FOCUS_ITEMS_MAX ? Math.min(Math.max(0, at - FOCUS_BEFORE), items.length - SNAPSHOT_ITEMS) : items.length - SNAPSHOT_ITEMS;
  return { items: items.slice(Math.max(0, from)), hasMore: from > 0 };
}

function within(dir: string, root: string): boolean {
  const rel = path.relative(root, dir);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Owns the broker's Claude Code processes, tracks the VS Code ones reached through wrappers, and
// answers questions about every session on the machine.
// Emits "event" (sessionId, ServerMsg) for one session, "changed" when the session list changed, and
// "attached" / "detached" (sessionId) when a session gains or loses a process the broker can drive.
export class SessionManager extends EventEmitter {
  models: ModelOption[] = loadModels();
  private modelsAsked?: Promise<void>;
  private cfg: Config;
  private audit?: Audit;
  private owned = new Map<string, BrokerSession>();
  private wrapped = new Map<string, WrappedSession>();
  private starting = new Map<string, Promise<SessionCore>>();
  private claiming = new Set<string>();
  private ended = new Map<string, { reason: string; at: number }>();
  private catalog?: { at: number; list: SDKSessionInfo[] };
  private viewed: string | null = null;
  private sweeper: NodeJS.Timeout;
  private timing: ManagerTiming;
  private accountUsage?: { at: number; value: Promise<UsageInfo> };
  // What sessions without a process start with when the broker next starts them.
  private starts = new Map<string, StartSettings>();
  private windows = new ContextWindows(path.join(paths.stateDir, "context-windows.json"));
  private probing = new Map<string, Promise<ContextWindow | undefined>>();
  // Where plan limits come from when no running process can say: (cwd, Claude Code path).
  usageProbe: (cwd: string, claudePath?: string) => Promise<UsageInfo> = probeUsage;
  // Where the model list comes from before any session reported one: (cwd, Claude Code path).
  modelProbe: (cwd: string, claudePath?: string) => Promise<ModelInfo[]> = probeModels;
  // Where a model's context window comes from when no session reported it: (cwd, model, Claude Code path).
  windowProbe: (cwd: string, model: string, claudePath?: string) => Promise<ContextWindow | undefined> = probeWindow;

  constructor(cfg: Config, audit?: Audit, timing: Partial<ManagerTiming> = {}) {
    super();
    this.cfg = cfg;
    this.audit = audit;
    this.timing = { handoffTurnMs: HANDOFF_TURN_MS, handoffOtherMs: HANDOFF_OTHER_MS, ...timing };
    this.sweeper = setInterval(() => void this.sweep(), SWEEP_MS);
    this.sweeper.unref();
  }

  setViewed(sessionId: string | null): void {
    this.viewed = sessionId;
    const s = sessionId ? this.owned.get(sessionId) : undefined;
    if (s) s.lastActivity = Date.now();
  }

  private async infos(): Promise<SDKSessionInfo[]> {
    if (this.catalog && Date.now() - this.catalog.at < CATALOG_MS) return this.catalog.list;
    const list = await listSessions();
    this.catalog = { at: Date.now(), list };
    return list;
  }

  private async info(sessionId: string): Promise<SDKSessionInfo | undefined> {
    const found = (await this.infos()).find((i) => i.sessionId === sessionId);
    if (found) return found;
    this.catalog = undefined;
    return (await this.infos()).find((i) => i.sessionId === sessionId);
  }

  private controlled(sessionId: string): SessionCore | undefined {
    return this.owned.get(sessionId) ?? this.wrapped.get(sessionId);
  }

  // A session object stays current until another process for the same session replaces it or it closes.
  private current(s: SessionCore): boolean {
    return this.owned.get(s.id) === s || this.wrapped.get(s.id) === s;
  }

  isControlled(sessionId: string): boolean {
    return Boolean(this.controlled(sessionId));
  }

  async list(): Promise<SessionSummary[]> {
    const infos = await this.infos();
    const live = new Map(liveProcesses().filter((l) => !this.controlled(l.sessionId)).map((l) => [l.sessionId, l]));
    const summary = (s: SessionCore, info?: SDKSessionInfo): SessionSummary => ({
      id: s.id,
      title: s.title || (info ? titleOf(info) : ""),
      cwd: info?.cwd ?? s.cwd,
      branch: info?.gitBranch,
      lastModified: Math.max(info?.lastModified ?? 0, s.lastActivity),
      createdAt: info?.createdAt,
      state: s.kind,
      host: s.host,
      busy: s.busy,
      pendingCount: s.pending.size || undefined,
    });
    const out: SessionSummary[] = infos.map((info) => {
      const s = this.controlled(info.sessionId);
      if (s) return summary(s, info);
      const l = live.get(info.sessionId);
      return {
        id: info.sessionId,
        title: titleOf(info),
        cwd: info.cwd ?? "",
        branch: info.gitBranch,
        lastModified: info.lastModified,
        createdAt: info.createdAt,
        state: l ? "live" : "inactive",
        host: l?.host,
        liveStatus: l?.status,
        busy: l?.status === "busy",
      };
    });
    const listed = new Set(out.map((o) => o.id));
    for (const s of [...this.owned.values(), ...this.wrapped.values()]) {
      if (listed.has(s.id) || (s.kind === "attached" && !s.builder.items.length && !s.busy)) continue;
      out.push(summary(s));
    }
    return out.sort((a, b) => b.lastModified - a.lastModified);
  }

  // A folder qualifies when it already has sessions or lies under a configured root.
  async resolveFolder(cwd: string): Promise<string> {
    let dir: string;
    try {
      dir = fs.realpathSync(cwd);
    } catch {
      throw Error("folder does not exist");
    }
    if (!fs.statSync(dir).isDirectory()) throw Error("not a folder");
    const known = new Set((await this.infos()).map((i) => i.cwd).filter((c): c is string => Boolean(c)));
    if (known.has(dir) || this.cfg.roots.some((root) => within(dir, root))) return dir;
    throw Error("folder is not allowed for new sessions");
  }

  // The models Claude Code last offered; before any session reported them, asked once of a short-lived process.
  async modelList(): Promise<ModelOption[]> {
    if (!this.models.length) {
      this.modelsAsked ??= this.folders()
        .then((dirs) => this.modelProbe(dirs[0] ?? os.homedir(), this.cfg.claudePath))
        .then(
          (list) => {
            if (!this.models.length) this.setModels(list);
          },
          () => {},
        );
      await this.modelsAsked;
    }
    return this.models;
  }

  // Kept as Claude Code reported it, for the next broker run.
  private setModels(list: ModelInfo[]): void {
    const models = modelOptions(list);
    if (!models.length || JSON.stringify(models) === JSON.stringify(this.models)) return;
    this.models = models;
    const saved = models.map((m) => ({ value: m.value, resolvedModel: m.resolved, displayName: m.label, description: m.description, supportedEffortLevels: m.efforts }));
    try {
      writeFileAtomic(modelsFile(), JSON.stringify(saved) + "\n");
    } catch {}
  }

  async folders(): Promise<string[]> {
    const known = (await this.infos()).map((i) => i.cwd).filter((c): c is string => Boolean(c));
    return [...new Set([...this.cfg.roots, ...known])].sort();
  }

  async snapshot(sessionId: string, focus?: string): Promise<Snapshot> {
    const s = this.controlled(sessionId);
    if (s) return { ...tail(s.builder.items, focus), pending: [...s.pending.values()].map((e) => e.request), state: s.state() };
    const info = await this.info(sessionId);
    if (!info?.cwd) throw Error("unknown session");
    const [items, state] = await Promise.all([loadHistory(sessionId, info.cwd), this.idleState(sessionId, info.cwd, titleOf(info))]);
    return { ...tail(items, focus), pending: [], state };
  }

  // A session without a process this broker drives: whether one runs elsewhere, the transcript's last context
  // gauge and, while nothing runs it, the choices it starts with here.
  private async idleState(sessionId: string, cwd: string, title: string): Promise<LiveState> {
    const l = liveProcesses({ fresh: true }).find((p) => p.sessionId === sessionId);
    const ended = this.ended.get(sessionId);
    const context = await this.lastGauge(sessionId, cwd, () => void this.restate(sessionId));
    const start = l ? undefined : this.starts.get(sessionId);
    return {
      sessionId,
      cwd,
      title,
      state: l ? "live" : "inactive",
      host: l?.host,
      busy: l?.status === "busy",
      ...(ended ? { closedReason: ended.reason } : {}),
      ...(context ? { context } : {}),
      ...(start ? { start } : {}),
    };
  }

  private async restate(sessionId: string): Promise<void> {
    if (this.controlled(sessionId)) return;
    const info = await this.info(sessionId).catch(() => undefined);
    if (!info?.cwd || this.controlled(sessionId)) return;
    this.emit("event", sessionId, { t: "state", sessionId, state: await this.idleState(sessionId, info.cwd, titleOf(info)) });
  }

  // The context the transcript last reports against the window its model runs with: the window this session
  // or model last reported, or else one asked of Claude Code once per model, with `found` called when it comes.
  private async lastGauge(sessionId: string, cwd: string, found: () => void): Promise<ContextGauge | undefined> {
    const file = transcriptPath(sessionId, cwd);
    const used = file ? await lastUsage(file).catch(() => undefined) : undefined;
    if (!used) return undefined;
    const w = this.windows.get(sessionId, used.model);
    if (w) return gauge(used.tokens, w, true);
    const model = used.model;
    if (!model) return undefined;
    let asked = this.probing.get(model);
    if (!asked) {
      asked = this.windowProbe(cwd, model, this.cfg.claudePath).then(
        (w) => {
          if (w) this.windows.learn(model, w);
          return w;
        },
        () => undefined,
      );
      this.probing.set(model, asked);
    }
    void asked.then((w) => w && found());
    return undefined;
  }

  // A session started or reached here shows the transcript's last gauge until Claude Code counts.
  private seedGauge(s: SessionCore): void {
    const fill = (): void =>
      void this.lastGauge(s.id, s.cwd, fill).then((g) => {
        if (!g || s.context || !this.current(s)) return;
        s.context = g;
        s.emit("state");
      });
    fill();
  }

  // Calls back whenever the transcript of a session without a process this broker drives changes.
  watch(sessionId: string, onChange: () => void): () => void {
    const file = transcriptPath(sessionId);
    if (!file) return () => {};
    const listener = (cur: fs.Stats, prev: fs.Stats) => {
      if (cur.mtimeMs !== prev.mtimeMs && !this.isControlled(sessionId)) onChange();
    };
    fs.watchFile(file, { interval: WATCH_INTERVAL_MS }, listener);
    return () => fs.unwatchFile(file, listener);
  }

  private get(sessionId: string): SessionCore {
    const s = this.controlled(sessionId);
    if (!s) throw Error("session is not running here");
    return s;
  }

  async activate(sessionId: string): Promise<SessionCore> {
    const running = this.controlled(sessionId);
    if (running) return running;
    const pending = this.starting.get(sessionId);
    if (pending) return pending;
    const p = (async (): Promise<SessionCore> => {
      const info = await this.info(sessionId);
      if (!info?.cwd) throw Error("unknown session");
      const cwd = await this.resumeFolder(sessionId, info.cwd);
      const history = await loadHistory(sessionId, cwd);
      const now = this.controlled(sessionId);
      if (now) return now;
      if (this.claiming.has(sessionId)) throw Error("session is opening in VS Code");
      const other = liveProcesses({ fresh: true }).find((l) => l.sessionId === sessionId);
      if (other) throw Error(`session is open in ${other.host}`);
      const start = this.starts.get(sessionId);
      const s = new BrokerSession(sessionId, cwd, history, titleOf(info));
      this.adopt(s);
      s.start({ resume: true, claudePath: this.cfg.claudePath, ...startOptions(start) });
      this.starts.delete(sessionId);
      if (start) this.audit?.log("start_settings", { sessionId, ...start });
      this.seedGauge(s);
      return s;
    })();
    this.starting.set(sessionId, p);
    try {
      return await p;
    } finally {
      this.starting.delete(sessionId);
    }
  }

  // Claude Code resumes a session from the project folder of its cwd. A transcript that was moved to
  // another project folder resumes from the known folder whose name matches where the file now is.
  private async resumeFolder(sessionId: string, cwd: string): Promise<string> {
    const file = transcriptPath(sessionId, cwd);
    const dir = file ? path.basename(path.dirname(file)) : undefined;
    if (!dir || dir === projectDirName(cwd)) return cwd;
    const known = (await this.infos()).map((i) => i.cwd).filter((c): c is string => Boolean(c));
    return known.find((c) => projectDirName(c) === dir) ?? cwd;
  }

  async create(cwd: string, opts: { model?: string; mode?: PermissionModeName; effort?: EffortName }): Promise<BrokerSession> {
    const dir = await this.resolveFolder(cwd);
    const s = new BrokerSession(randomUUID(), dir);
    this.adopt(s);
    s.start({ ...opts, claudePath: this.cfg.claudePath });
    return s;
  }

  async send(sessionId: string, text: string, blocks?: ContentBlock[]): Promise<void> {
    const s = this.controlled(sessionId) ?? (await this.activate(sessionId));
    s.send(text, blocks);
  }

  // The web client's requests about one session (CallMap in protocol.ts).
  async call(sessionId: string, op: CallOp, args: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case "files":
        return searchFiles(await this.cwdOf(sessionId), typeof args.query === "string" ? args.query : "");
      case "commands": {
        const s = this.controlled(sessionId);
        const cwd = await this.cwdOf(sessionId);
        if (s?.commands) rememberCommands(cwd, s.commands);
        return s?.commands ?? lastCommands(cwd);
      }
      case "context":
        return this.get(sessionId).contextDetail(args.summary === true);
      case "usage":
        return this.usage(sessionId);
      case "resume":
        await this.activate(sessionId);
        return {};
      case "mcp_status":
        return this.get(sessionId).mcpStatus();
      case "mcp_toggle":
        return this.get(sessionId).mcpToggle(String(args.server), args.enabled === true);
      case "mcp_reconnect":
        return this.get(sessionId).mcpReconnect(String(args.server));
      case "rewind":
        return this.get(sessionId).rewind(String(args.userMessageId), args.dryRun !== false);
      case "stop_task":
        await this.get(sessionId).stopTask(String(args.taskId));
        return {};
      case "output_style":
        return this.get(sessionId).outputStyleInfo();
      case "set_output_style":
        return this.get(sessionId).setOutputStyle(String(args.style));
    }
  }

  // Plan limits belong to the account, so a session without a process gets them without being resumed.
  private async usage(sessionId: string): Promise<UsageInfo> {
    const s = this.controlled(sessionId);
    if (s && !s.closed) {
      try {
        return await s.usage();
      } catch {}
    }
    const cwd = await this.cwdOf(sessionId);
    const kept = this.accountUsage;
    if (kept && Date.now() - kept.at < USAGE_KEEP_MS) return kept.value;
    const value = this.freshAccountUsage(cwd, s);
    const entry = { at: Date.now(), value };
    this.accountUsage = entry;
    value.catch(() => {
      if (this.accountUsage === entry) this.accountUsage = undefined;
    });
    return value;
  }

  // Any running process answers for the account; the session totals it adds are its own, so they are left out.
  private async freshAccountUsage(cwd: string, skip?: SessionCore): Promise<UsageInfo> {
    for (const s of [...this.owned.values(), ...this.wrapped.values()]) {
      if (s === skip || s.closed) continue;
      try {
        return { limits: (await s.usage()).limits };
      } catch {}
    }
    return this.usageProbe(cwd, this.cfg.claudePath);
  }

  // What reading a linked file needs: the folder the session started in, the one it last worked in,
  // and its running Claude Code process if there is one.
  async fileAccess(sessionId: string): Promise<{ start: string; latest?: string; session?: SessionCore }> {
    const s = this.controlled(sessionId);
    const start = await this.cwdOf(sessionId);
    const latest = await lastCwd(sessionId, start);
    return { start, latest: latest !== start ? latest : undefined, session: s && !s.closed ? s : undefined };
  }

  private async cwdOf(sessionId: string): Promise<string> {
    const cwd = this.controlled(sessionId)?.cwd ?? (await this.info(sessionId))?.cwd;
    if (!cwd) throw Error("unknown session");
    return cwd;
  }

  pendingRequest(sessionId: string, requestId: string): PendingRequest | undefined {
    return this.controlled(sessionId)?.pending.get(requestId)?.request;
  }

  answer(sessionId: string, requestId: string, answer: Parameters<SessionCore["answer"]>[1]): Promise<void> {
    return this.get(sessionId).answer(requestId, answer);
  }

  interrupt(sessionId: string): Promise<void> {
    return this.get(sessionId).interrupt();
  }

  // Whether the session's last turn was a local command rather than a model turn.
  lastTurnLocal(sessionId: string): boolean {
    return this.controlled(sessionId)?.localTurn === true;
  }

  // Model, mode, effort and ultracode change a running session at once; a session without a process keeps
  // them for when the broker next starts it.
  async setMode(sessionId: string, mode: PermissionModeName): Promise<void> {
    const s = this.controlled(sessionId);
    if (s) return s.setMode(mode);
    if (!PERMISSION_MODES.includes(mode)) throw Error(`mode ${mode} is not available remotely`);
    return this.setStart(sessionId, { mode });
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    const s = this.controlled(sessionId);
    if (s) return s.setModel(model);
    if (!MODEL_NAME.test(model) || (this.models.length && !this.models.some((m) => m.value === model))) throw Error("unknown model");
    return this.setStart(sessionId, { model });
  }

  setEffort(sessionId: string, effort: EffortName): Promise<void> {
    return this.controlled(sessionId)?.setEffort(effort) ?? this.setStart(sessionId, { effort });
  }

  setUltracode(sessionId: string, on: boolean): Promise<void> {
    return this.controlled(sessionId)?.setUltracode(on) ?? this.setStart(sessionId, { ultracode: on });
  }

  private async setStart(sessionId: string, change: StartSettings): Promise<void> {
    if (this.starting.has(sessionId)) throw Error("session is starting");
    const info = await this.info(sessionId);
    if (!info?.cwd) throw Error("unknown session");
    const other = liveProcesses({ fresh: true }).find((l) => l.sessionId === sessionId);
    if (other) throw Error(`session is open in ${other.host}`);
    if (this.controlled(sessionId)) throw Error("session started meanwhile");
    const next: StartSettings = { ...this.starts.get(sessionId), ...change };
    if (!next.ultracode) delete next.ultracode;
    this.starts.set(sessionId, next);
    await this.restate(sessionId);
  }

  startSettings(sessionId: string): StartSettings | undefined {
    return this.starts.get(sessionId);
  }

  async release(sessionId: string): Promise<void> {
    if (this.wrapped.has(sessionId)) throw Error("session runs in VS Code");
    await this.owned.get(sessionId)?.close("released");
  }

  async closeAll(): Promise<void> {
    clearInterval(this.sweeper);
    await Promise.all([...this.owned.values()].map((s) => s.close("shutdown")));
  }

  // A conversation process VS Code started, connected through its wrapper. The session it runs is
  // known from the launch arguments or from the first line that names it; what the wrapper reports
  // before that is kept and replayed in order.
  attachLink(link: Link): void {
    let session: WrappedSession | undefined;
    let claiming = false;
    let early: { from: "out" | "in" | "settled"; v: unknown }[] = [];
    const bind = (id: string) => {
      if (session?.id === id || !link.usable) return;
      session?.end("switched");
      const cwd = link.hello?.cwd ?? "";
      const s = new WrappedSession(link, id, cwd);
      session = s;
      const prev = this.wrapped.get(id);
      this.wrapped.set(id, s);
      prev?.end("replaced");
      this.adopt(s);
      for (const h of early) {
        if (h.from === "out") s.onOut(h.v as Record<string, unknown>);
        else if (h.from === "in") s.onIn(h.v as Record<string, unknown>);
        else s.onSettled(h.v);
      }
      early = [];
      this.audit?.log("attach", { sessionId: id, wpid: link.hello?.wpid });
      void loadHistory(id, cwd)
        .catch(() => [])
        .then((history) => {
          s.seed(history);
          this.seedGauge(s);
          if (this.current(s)) this.emit("attached", id);
        });
    };
    const keep = (from: "out" | "in" | "settled", v: unknown) => {
      if (early.length < EARLY_LINES_MAX) early.push({ from, v });
    };
    link.on("hello", (h: Hello) => {
      if (!h.claim) {
        if (link.sessionId) bind(link.sessionId);
        return;
      }
      const id = h.claim;
      claiming = true;
      this.claiming.add(id);
      void this.claim(id, link)
        .catch(() => ({ fork: false }))
        .then(({ fork }) => {
          link.send(fork ? { t: "claim_ok", fork: true } : { t: "claim_ok" });
          if (fork) link.sessionId = undefined;
          else if (link.sessionId) bind(link.sessionId);
          claiming = false;
          this.claiming.delete(id);
        });
    });
    link.on("session", (id: string) => {
      if (!claiming) bind(id);
    });
    link.on("out", (m: Record<string, unknown>) => (session ? session.onOut(m) : keep("out", m)));
    link.on("in", (m: Record<string, unknown>) => (session ? session.onIn(m) : keep("in", m)));
    link.on("settled", (id: unknown) => (session ? session.onSettled(id) : keep("settled", id)));
    link.on("exit", () => session?.end("vscode_closed"));
    link.on("close", () => session?.end("vscode_closed"));
  }

  // Lets a VS Code launch that resumes `sessionId` start: the broker's own process for it is closed once
  // its turn is over, and any other process that holds it gets a moment to end. If one still holds it,
  // VS Code starts on a copy instead, so two processes never write the same session.
  private async claim(sessionId: string, link: Link): Promise<{ fork: boolean }> {
    await this.starting.get(sessionId)?.catch(() => {});
    const s = this.owned.get(sessionId);
    if (s) {
      link.send({ t: "claim_wait", ms: this.timing.handoffTurnMs + 12_000 });
      if (!(await s.idle(this.timing.handoffTurnMs))) await s.interrupt().catch(() => {});
      await s.close("handed_off");
      this.audit?.log("handoff", { sessionId, to: "VS Code" });
    }
    const until = Date.now() + this.timing.handoffOtherMs;
    let told = false;
    for (;;) {
      const holder = liveProcesses({ fresh: true }).find((l) => l.sessionId === sessionId);
      if (!holder) return { fork: false };
      if (Date.now() >= until) {
        this.audit?.log("handoff", { sessionId, to: "VS Code", forked: true, heldBy: holder.host });
        return { fork: true };
      }
      if (!told) link.send({ t: "claim_wait", ms: this.timing.handoffOtherMs + 2000 });
      told = true;
      await sleep(250);
    }
  }

  // Closes processes nobody is looking at once they have been idle for a while.
  private async sweep(): Promise<void> {
    const limit = this.cfg.sessionIdleMinutes * 60_000;
    for (const s of this.owned.values()) {
      if (s.id === this.viewed || s.busy || s.pending.size || [...s.tasks.values()].some((t) => t.status === "running")) continue;
      if (Date.now() - s.lastActivity > limit) await s.close("idle");
    }
    for (const [id, e] of this.ended) if (Date.now() - e.at > ENDED_KEEP_MS) this.ended.delete(id);
  }

  private adopt(s: SessionCore): void {
    if (s instanceof BrokerSession) this.owned.set(s.id, s);
    this.ended.delete(s.id);
    const send = (msg: ServerMsg) => {
      if (this.current(s)) this.emit("event", s.id, msg);
    };
    s.on("item", (item: DisplayItem) => send({ t: "item", sessionId: s.id, item }));
    s.on("stream", (text: string, thinking: boolean) => send({ t: "stream", sessionId: s.id, text, thinking }));
    s.on("pending_add", (request: PendingRequest) => {
      send({ t: "pending_add", sessionId: s.id, request });
      this.emit("changed");
    });
    s.on("pending_remove", (requestId: string) => {
      send({ t: "pending_remove", sessionId: s.id, requestId });
      this.emit("changed");
    });
    s.on("state", () => send({ t: "state", sessionId: s.id, state: s.state() }));
    s.on("window", (model: string | undefined, w: ContextWindow) => this.windows.learn(model, w, s.id));
    s.on("models", (models: ModelInfo[]) => this.setModels(models));
    s.on("closed", (reason: string) => {
      if (!this.current(s)) return;
      if (this.owned.get(s.id) === s) this.owned.delete(s.id);
      if (this.wrapped.get(s.id) === s) this.wrapped.delete(s.id);
      this.ended.set(s.id, { reason, at: Date.now() });
      this.catalog = undefined;
      this.emit("event", s.id, { t: "state", sessionId: s.id, state: s.state() });
      this.emit("changed");
      this.emit("detached", s.id);
    });
    this.catalog = undefined;
    this.emit("changed");
  }
}

function startOptions(start?: StartSettings): Partial<StartOptions> {
  if (!start) return {};
  const later = start.effort || start.ultracode ? { effort: start.effort, ultracode: start.ultracode } : undefined;
  return { model: start.model, mode: start.mode, ...(later ? { later } : {}) };
}

const modelsFile = () => path.join(paths.stateDir, "models.json");

function modelOptions(list: unknown): ModelOption[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((m): m is ModelInfo => m !== null && typeof m === "object" && typeof m.value === "string" && m.value !== "")
    .map((m) => ({
      value: m.value,
      resolved: typeof m.resolvedModel === "string" ? m.resolvedModel : undefined,
      label: typeof m.displayName === "string" && m.displayName ? m.displayName : m.value,
      description: typeof m.description === "string" ? m.description : undefined,
      efforts: Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels : undefined,
    }));
}

// The model list kept from the last broker run.
function loadModels(): ModelOption[] {
  try {
    return modelOptions(JSON.parse(fs.readFileSync(modelsFile(), "utf8")));
  } catch {
    return [];
  }
}
