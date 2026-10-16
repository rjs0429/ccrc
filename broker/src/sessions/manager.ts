import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { listSessions, type ModelInfo, type SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import type { Audit } from "../audit.ts";
import { ClaudeCli, type CliChoice } from "../claude-cli.ts";
import { claudeSettingsFile } from "../claude-settings.ts";
import { paths, writeFileAtomic, type Config } from "../config.ts";
import type { Hello } from "../link/protocol.ts";
import type { Link } from "../link/server.ts";
import {
  PERMISSION_MODES,
  type CallOp,
  type FolderOp,
  type ContextGauge,
  type DisplayItem,
  type EffortName,
  type ForkResult,
  type LiveState,
  type ModelOption,
  type PendingRequest,
  type PermissionModeName,
  type RewindConversationResult,
  type RewindResult,
  type ServerMsg,
  type SessionSummary,
  type SnapshotGap,
  type StartSettings,
  type UsageInfo,
} from "../protocol.ts";
import { cleanTitle } from "../titles.ts";
import { ArchiveStore, transcriptIds } from "./archive-store.ts";
import { BrokerSession, probeModels, probeUsage, probeWindow, type StartOptions } from "./broker-session.ts";
import { lastCommands, rememberCommands } from "./commands.ts";
import { ContextWindows, exactModel, gauge, lastModelId, lastUsage, widened, type ContextWindow } from "./context-gauge.ts";
import type { ContentBlock, SessionCore } from "./core.ts";
import { writeTitle } from "./custom-title.ts";
import { searchFiles } from "./files.ts";
import { PROJECTS, forkPoint, lastCwd, loadHistory, projectDirName, transcriptPath, turnPoint } from "./history.ts";
import { liveProcesses } from "./live.ts";
import { modelCaps } from "./model-caps.ts";
import type { TurnEnd } from "./outcome.ts";
import { MODEL_NAME, StartStore } from "./start-store.ts";
import { agentTranscript, workflowAgents } from "./subagents.ts";
import { UltracodeModels } from "./ultracode-models.ts";
import { WrappedSession } from "./wrapped.ts";

const CATALOG_MS = 3000;
const EXACT_KEEP = 500;
const SNAPSHOT_ITEMS = 400;
const FOCUS_BEFORE = 20;
const FOCUS_AFTER = 200;
const FOCUS_ITEMS_MAX = 1500;
const SWEEP_MS = 60_000;
const WATCH_INTERVAL_MS = 2000;
// Handing a session to VS Code: how long the broker's running turn may go on before it is interrupted,
// and how long to wait for any other process that still holds the session to end.
const HANDOFF_TURN_MS = 10_000;
const HANDOFF_OTHER_MS = 9_000;
const EARLY_LINES_MAX = 500;
const ENDED_KEEP_MS = 10 * 60_000;
const CRASHED_KEEP_MS = 24 * 3600_000;
const USAGE_KEEP_MS = 30_000;
// A model whose window could not be asked is asked again after this long.
const PROBE_RETRY_MS = 60_000;
// How long a call waits for a process of this broker that is closing to end.
const CLOSING_WAIT_MS = 3000;
// A fork: how long Claude Code may take to start on the copy, to name it and to show the name in its transcript, how long
// the same request gets the same fork, and how much of the original's title the name keeps.
const FORK_START_MS = 60_000;
const FORK_NAME_MS = 30_000;
const FORK_WRITTEN_MS = 3000;
const FORK_KEEP_MS = 10 * 60_000;
const FORK_TITLE_MAX = 120;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EFFORT_NAMES = new Set<unknown>(["low", "medium", "high", "xhigh", "max"]);
// How a Claude Code without rewind_conversation answers it.
const UNSUPPORTED = /^Unsupported control request subtype/;

export interface ManagerTiming {
  handoffTurnMs: number;
  handoffOtherMs: number;
  probeRetryMs: number;
}

// A fork's first message, if any, starts it at once.
export interface ForkRequest {
  id: string;
  before?: string;
  text?: string;
  blocks?: ContentBlock[];
  name?: string;
}

export interface Snapshot {
  items: DisplayItem[];
  pending: PendingRequest[];
  state: LiveState;
  hasMore: boolean;
  gap?: SnapshotGap;
}

function titleOf(info: SDKSessionInfo): string {
  return info.customTitle || info.summary || info.firstPrompt || "";
}

// A fork is named as VS Code names one: the original's name on one short line, then " (fork)". A name given for it
// stands instead, as Claude Code's /branch takes one.
function forkTitle(title: string, name = ""): string {
  return cleanTitle(name) || `${[...cleanTitle(title)].slice(0, FORK_TITLE_MAX).join("").trim()} (fork)`.trim();
}

const failed = (e: unknown): RewindResult => ({ canRewind: false, error: e instanceof Error ? e.message : String(e) });

// The latest items, reaching back to the focused item when that stays within a bound; a focused item further
// back comes with the items around it, and the ones between that part and the latest are left out.
export function tail(items: DisplayItem[], focus?: string): { items: DisplayItem[]; hasMore: boolean; gap?: SnapshotGap } {
  const latest = Math.max(0, items.length - SNAPSHOT_ITEMS);
  const at = focus ? items.findIndex((i) => i.id === focus) : -1;
  if (at < 0 || at >= latest) return { items: items.slice(latest), hasMore: latest > 0 };
  const from = Math.max(0, at - FOCUS_BEFORE);
  if (items.length - at <= FOCUS_ITEMS_MAX) return { items: items.slice(from), hasMore: from > 0 };
  const to = Math.min(at + FOCUS_AFTER, latest);
  const gap = latest > to ? { gap: { before: items[latest].id, skipped: latest - to } } : {};
  return { items: [...items.slice(from, to), ...items.slice(latest)], hasMore: from > 0, ...gap };
}

function within(dir: string, root: string): boolean {
  const rel = path.relative(root, dir);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Claude Code starts in the session's working folder, so a session whose folder is gone cannot start.
function isFolder(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// The project folder a session's transcript was moved to, when it no longer lies under the one of its cwd.
function movedTo(sessionId: string, cwd: string): string | undefined {
  const file = transcriptPath(sessionId, cwd);
  const dir = file ? path.basename(path.dirname(file)) : undefined;
  return dir && dir !== projectDirName(cwd) ? dir : undefined;
}

// Claude Code resumes a session from the project folder of its cwd. A transcript that was moved to
// another project folder resumes from the known folder whose name matches where the file now is.
function resumeIn(cwd: string, moved: string | undefined, infos: SDKSessionInfo[]): string {
  return (moved && infos.find((i) => i.cwd && projectDirName(i.cwd) === moved)?.cwd) || cwd;
}

// A probe loads no project settings, so any folder serves when the session's is gone.
const probeDir = (cwd: string): string => (isFolder(cwd) ? cwd : os.homedir());

// Owns the broker's Claude Code processes, tracks the VS Code ones reached through wrappers, and
// answers questions about every session on the machine.
// Emits "event" (sessionId, ServerMsg) for one session, "changed" when the session list changed, and
// "attached" / "detached" (sessionId) when a session gains or loses a process the broker can drive;
// "turn_end" (sessionId, TurnEnd) when a turn of one ends, and "seen" (sessionId) when the remote user opens one.
export class SessionManager extends EventEmitter {
  models: ModelOption[] = loadModels();
  private modelsAsked?: Promise<void>;
  private cfg: Config;
  private audit?: Audit;
  private owned = new Map<string, BrokerSession>();
  private wrapped = new Map<string, WrappedSession>();
  private starting = new Map<string, Promise<SessionCore>>();
  private claiming = new Set<string>();
  // Sessions that stopped lately, with the notes of phone messages Claude Code never took in, which no transcript keeps.
  private ended = new Map<string, { reason: string; at: number; unsent: DisplayItem[] }>();
  private catalog?: { at: number; list: SDKSessionInfo[] };
  private viewed: string | null = null;
  private sweeper: NodeJS.Timeout;
  private timing: ManagerTiming;
  private accountUsage?: { at: number; value: Promise<UsageInfo> };
  // What sessions without a process start with when the broker next starts them.
  private starts = new StartStore(path.join(paths.stateDir, "start-settings.json"));
  private windows = new ContextWindows(path.join(paths.stateDir, "context-windows.json"));
  private ultracodeModels = new UltracodeModels(path.join(paths.stateDir, "ultracode-models.json"));
  private archive = new ArchiveStore(path.join(paths.stateDir, "archived.json"));
  private probing = new Map<string, Promise<ContextWindow | undefined>>();
  // Forks made here by the id the phone chose for them; sent: a first message went to the fork.
  private forks = new Map<string, { at: number; done: Promise<ForkResult>; sent: boolean }>();
  private exact = new Map<string, { size: number; model: string }>();
  // Where plan limits come from when no running process can say: (cwd, Claude Code path).
  usageProbe: (cwd: string, claudePath?: string) => Promise<UsageInfo> = probeUsage;
  // Whether a phone can be reached now (connected, or the signed-in device gets notifications), so a VS Code
  // session's MCP input request is better answered there than declined by VS Code.
  remoteReachable: () => boolean = () => false;
  // Whether the app is open on a phone now; otherwise a taken input request waits only a short while.
  remoteWatching: () => boolean = () => false;
  // Where the model list comes from before any session reported one: (cwd, Claude Code path).
  modelProbe: (cwd: string, claudePath?: string) => Promise<ModelInfo[]> = probeModels;
  // Where a model's context window comes from when no session reported it: (cwd, model, Claude Code path).
  windowProbe: (cwd: string, model: string, claudePath?: string) => Promise<ContextWindow | undefined> = probeWindow;
  // The Claude Code each session and probe starts with, picked again for each, and where the pick is told.
  readonly cli: ClaudeCli;
  cliLog: (line: string) => void = (line) => console.log(line);

  constructor(cfg: Config, audit?: Audit, timing: Partial<ManagerTiming> = {}) {
    super();
    this.cfg = cfg;
    this.audit = audit;
    this.timing = { handoffTurnMs: HANDOFF_TURN_MS, handoffOtherMs: HANDOFF_OTHER_MS, probeRetryMs: PROBE_RETRY_MS, ...timing };
    this.cli = new ClaudeCli({ setting: cfg.claudePath });
    this.sweeper = setInterval(() => void this.sweep(), SWEEP_MS);
    this.sweeper.unref();
  }

  setViewed(sessionId: string | null): void {
    this.viewed = sessionId;
    const s = sessionId ? this.owned.get(sessionId) : undefined;
    if (s) s.lastActivity = Date.now();
  }

  markSeen(sessionId: string): void {
    this.emit("seen", sessionId);
  }

  // Sessions with a request waiting for an answer.
  waitingSessions(): string[] {
    return [...this.owned.values(), ...this.wrapped.values()].filter((s) => s.pending.size > 0).map((s) => s.id);
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

  // A running session's title is the transcript's, which a name given anywhere reaches first; the one its process
  // announced serves until the transcript has one.
  async list(): Promise<SessionSummary[]> {
    const infos = await this.infos();
    const live = new Map(liveProcesses().filter((l) => !this.controlled(l.sessionId)).map((l) => [l.sessionId, l]));
    const summary = (s: SessionCore, info?: SDKSessionInfo): SessionSummary => ({
      id: s.id,
      title: (info ? titleOf(info) : "") || s.title || "",
      cwd: info?.cwd ?? s.cwd,
      branch: info?.gitBranch,
      lastModified: Math.max(info?.lastModified ?? 0, s.lastActivity),
      createdAt: info?.createdAt,
      state: s.kind,
      host: s.host,
      busy: s.busy,
      pendingCount: s.pending.size || undefined,
      ...this.archived(s.id),
    });
    const folders = new Map<string, boolean>();
    const exists = (dir: string) => {
      if (!folders.has(dir)) folders.set(dir, isFolder(dir));
      return folders.get(dir);
    };
    const missing = (sessionId: string, cwd: string) => !exists(resumeIn(cwd, movedTo(sessionId, cwd), infos));
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
        ...(!l && info.cwd && missing(info.sessionId, info.cwd) ? { folderMissing: true } : {}),
        ...this.archived(info.sessionId),
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
        .then(async (dirs) => this.modelProbe(probeDir(dirs[0] ?? os.homedir()), (await this.claude()).path))
        .then(
          (list) => {
            if (!this.models.length) this.setModels(list);
          },
          () => {},
        );
      await this.modelsAsked;
    }
    // A list that marks no model for Fast mode gets Claude Code's own rule for it.
    const listsFast = this.models.some((m) => m.fast);
    return this.models.map((m) => {
      const ultracode = this.ultracodeModels.get(m.resolved ?? m.value);
      const caps = modelCaps(m.resolved ?? m.value);
      return {
        ...m,
        ...(ultracode === undefined ? {} : { ultracode }),
        ...(!listsFast && caps.fast ? { fast: true } : {}),
        ...(m.thinkingOff === undefined && caps.thinkingOff !== undefined ? { thinkingOff: caps.thinkingOff } : {}),
      };
    });
  }

  // Kept as Claude Code reported it, for the next broker run. A Claude Code that does not say whether a model's Thinking
  // can be turned off keeps what an earlier list said.
  private setModels(list: ModelInfo[]): void {
    const before = new Map(this.models.map((m) => [m.resolved ?? m.value, m.thinkingOff]));
    const models = modelOptions(list).map((m) => {
      const thinkingOff = m.thinkingOff ?? before.get(m.resolved ?? m.value);
      return thinkingOff === undefined ? m : { ...m, thinkingOff };
    });
    if (!models.length || JSON.stringify(models) === JSON.stringify(this.models)) return;
    this.models = models;
    const saved = models.map((m) => ({
      value: m.value,
      resolvedModel: m.resolved,
      displayName: m.label,
      description: m.description,
      supportedEffortLevels: m.efforts,
      supportsFastMode: m.fast,
      supportsThinkingOff: m.thinkingOff,
    }));
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
    return { ...tail([...items, ...(this.ended.get(sessionId)?.unsent ?? [])], focus), pending: [], state };
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
      ...(l || isFolder(await this.resumeFolder(sessionId, cwd)) ? {} : { folderMissing: true }),
    };
  }

  private async restate(sessionId: string): Promise<void> {
    if (this.controlled(sessionId)) return;
    const info = await this.info(sessionId).catch(() => undefined);
    if (!info?.cwd || this.controlled(sessionId)) return;
    this.emit("event", sessionId, { t: "state", sessionId, state: await this.idleState(sessionId, info.cwd, titleOf(info)) });
  }

  // The exact model a transcript ran, kept per transcript and size: a stopped session's file is read again only when it grows.
  private async exactModel(file: string, answered: string): Promise<string> {
    const size = (await fs.promises.stat(file).catch(() => undefined))?.size ?? -1;
    const key = `${file}\n${answered}`;
    const known = this.exact.get(key);
    if (known && known.size === size) return known.model;
    const recorded = await lastModelId(file).catch(() => undefined);
    const model = exactModel(answered, recorded, recorded ? undefined : settingsModel());
    this.exact.delete(key);
    this.exact.set(key, { size, model });
    for (const old of [...this.exact.keys()].slice(0, -EXACT_KEEP)) this.exact.delete(old);
    return model;
  }

  // The context the transcript last reports against the window its model runs with, the 1M one when the transcript,
  // the settings or the context's size show it: the window this session or model last reported, or else one asked
  // of Claude Code once per model, with `found` called when it comes.
  private async lastGauge(sessionId: string, cwd: string, found: () => void): Promise<ContextGauge | undefined> {
    const file = transcriptPath(sessionId, cwd);
    const used = file ? await lastUsage(file).catch(() => undefined) : undefined;
    if (!used) return undefined;
    let model = file && used.model ? await this.exactModel(file, used.model) : used.model;
    let w = this.windows.get(sessionId, model);
    const wider = w && model ? widened(model, used.tokens, w) : undefined;
    if (wider) {
      model = wider;
      w = this.windows.get(sessionId, model);
    }
    if (w) return gauge(used.tokens, w, true);
    if (!model) return undefined;
    let asked = this.probing.get(model);
    if (!asked) {
      const forget = () => {
        setTimeout(() => this.probing.get(model) === asked && this.probing.delete(model), this.timing.probeRetryMs).unref();
        return undefined;
      };
      asked = this.claude()
        .then((c) => this.windowProbe(probeDir(cwd), model, c.path))
        .then((w) => {
          if (!w) return forget();
          this.windows.learn(model, w);
          return w;
        }, forget);
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
      if (!isFolder(cwd)) throw Error(`working folder is missing: ${cwd}`);
      const history = await loadHistory(sessionId, cwd);
      const cli = await this.claude();
      const now = this.controlled(sessionId);
      if (now) return now;
      if (this.claiming.has(sessionId)) throw Error("session is opening in VS Code");
      const other = liveProcesses({ fresh: true }).find((l) => l.sessionId === sessionId);
      if (other) throw Error(`session is open in ${other.host}`);
      const start = this.starts.get(sessionId);
      const s = new BrokerSession(sessionId, cwd, history, titleOf(info));
      this.adopt(s);
      s.start({ resume: true, claudePath: cli.path, ...startOptions(start) });
      this.logCli(s.id, cli);
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

  private async resumeFolder(sessionId: string, cwd: string): Promise<string> {
    const moved = movedTo(sessionId, cwd);
    return moved ? resumeIn(cwd, moved, await this.infos()) : cwd;
  }

  async create(
    cwd: string,
    opts: { model?: string; mode?: PermissionModeName; effort?: EffortName; ultracode?: boolean; fast?: boolean; thinking?: boolean },
  ): Promise<BrokerSession> {
    const dir = await this.resolveFolder(cwd);
    const cli = await this.claude();
    const s = new BrokerSession(randomUUID(), dir);
    this.adopt(s);
    s.start({ ...opts, claudePath: cli.path });
    this.logCli(s.id, cli);
    return s;
  }

  // A copy of the session's conversation that runs here. Claude Code copies the transcript up to the fork point with its
  // message ids and file checkpoints, and writes the copy once its first input comes, which names it. The same id gives
  // the same fork, which takes a first message the earlier request for it did not bring; one before the conversation's
  // first message gives a draft in the session's folder instead.
  fork(sourceId: string, req: ForkRequest): Promise<ForkResult> {
    if (!UUID.test(req.id) || req.id === sourceId || (req.before !== undefined && !UUID.test(req.before))) return Promise.reject(Error("invalid request"));
    const now = Date.now();
    for (const [id, f] of this.forks) if (now - f.at > FORK_KEEP_MS) this.forks.delete(id);
    const first = Boolean(req.text || req.blocks?.length);
    const known = this.forks.get(req.id);
    if (known) return first && !known.sent ? this.sendToFork(known, req) : known.done;
    const f = { at: now, done: this.makeFork(sourceId, req), sent: first };
    this.forks.set(req.id, f);
    f.done.catch(() => this.forks.delete(req.id));
    return f.done;
  }

  private async sendToFork(f: { done: Promise<ForkResult>; sent: boolean }, req: ForkRequest): Promise<ForkResult> {
    f.sent = true;
    const r = await f.done;
    if (!("sessionId" in r)) return r;
    try {
      await this.send(r.sessionId, req.text ?? "", req.blocks);
    } catch (e) {
      f.sent = false;
      throw e;
    }
    const sent = { ...r, sent: true };
    f.done = Promise.resolve(sent);
    return sent;
  }

  // Without a message to cut at, a fork leaves out the turn running now.
  private async makeFork(sourceId: string, req: ForkRequest): Promise<ForkResult> {
    const taken = this.controlled(req.id);
    if (taken) return { sessionId: taken.id, cwd: taken.cwd, title: taken.title ?? "" };
    const kept = transcriptPath(req.id) ? await this.info(req.id) : undefined;
    if (kept?.cwd) return { sessionId: req.id, cwd: kept.cwd, title: titleOf(kept) };
    const source = this.controlled(sourceId);
    const info = await this.info(sourceId);
    if (!source && !info?.cwd) throw Error("unknown session");
    const cwd = source ? source.cwd : await this.resumeFolder(sourceId, info!.cwd!);
    if (!isFolder(cwd)) throw Error(`working folder is missing: ${cwd}`);
    const busy = source ? source.busy : liveProcesses({ fresh: true }).find((l) => l.sessionId === sourceId)?.status === "busy";
    const point = req.before ? await forkPoint(sourceId, cwd, req.before) : busy ? await turnPoint(sourceId, cwd) : undefined;
    if (!point && req.before) throw Error("unknown message");
    if (point && point.at === undefined) return { draft: { cwd } };
    const title = forkTitle((info ? titleOf(info) : "") || source?.title || "", req.name);
    const cli = await this.claude();
    const s = new BrokerSession(req.id, cwd, [], title);
    this.adopt(s);
    s.start({ fork: { from: sourceId, ...(point?.at ? { at: point.at } : {}) }, claudePath: cli.path, ...this.forkSettings(sourceId, source) });
    this.logCli(s.id, cli);
    try {
      await s.started(FORK_START_MS);
      await s.command(`/rename ${title}`, FORK_NAME_MS);
    } catch (e) {
      await s.close("fork_failed");
      if (!transcriptPath(req.id, cwd)) fs.rmSync(path.join(os.homedir(), ".claude", "file-history", req.id), { recursive: true, force: true });
      throw Error(`fork failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    s.builder.seed(await this.written(s));
    s.emit("state");
    this.catalog = undefined;
    this.emit("changed");
    const first = Boolean(req.text || req.blocks?.length);
    if (first) s.send(req.text ?? "", req.blocks);
    return { sessionId: s.id, cwd, title: s.title || title, ...(first ? { sent: true } : {}) };
  }

  // What a fork starts with: the original's permission mode where it can run here, its model, Effort, Ultracode and
  // Thinking as far as this broker knows them, never Fast mode, which holds for one session and costs more.
  private forkSettings(sourceId: string, s?: SessionCore): Partial<StartOptions> {
    const from: StartSettings = s
      ? { model: s.model, mode: s.permissionMode as PermissionModeName, effort: s.effort as EffortName, ultracode: s.ultracode, thinking: s.thinking }
      : (this.starts.get(sourceId) ?? {});
    return {
      ...(from.mode && PERMISSION_MODES.includes(from.mode) ? { mode: from.mode } : {}),
      ...(from.model ? { model: from.model } : {}),
      ...(EFFORT_NAMES.has(from.effort) ? { effort: from.effort } : {}),
      ...(from.ultracode ? { ultracode: true } : {}),
      ...(from.thinking === false ? { thinking: false } : {}),
    };
  }

  // The fork as Claude Code wrote it, once its transcript ends with the result of the command that named it.
  private async written(s: BrokerSession): Promise<DisplayItem[]> {
    const until = Date.now() + FORK_WRITTEN_MS;
    for (;;) {
      const items = await loadHistory(s.id, s.cwd).catch(() => []);
      if (items.at(-1)?.kind === "command" || Date.now() >= until) return items;
      await sleep(100);
    }
  }

  // In place where this broker runs the session. A session VS Code or another program runs keeps its conversation: the
  // rewind opens a new session at the message instead, and rewinds the code through VS Code when asked to.
  async rewindConversation(sessionId: string, args: Record<string, unknown>): Promise<RewindConversationResult> {
    if (args.choice !== "both" && args.choice !== "conversation") throw Error("invalid request");
    const id = typeof args.userMessageId === "string" ? args.userMessageId : "";
    const files = args.choice === "both";
    const s = this.controlled(sessionId);
    if (s instanceof BrokerSession && !s.closed) {
      try {
        return { mode: "in_place", ...(await s.rewindConversation(id, args.lastSeen, files)) };
      } catch (e) {
        if (!(e instanceof Error) || !UNSUPPORTED.test(e.message)) throw e;
        const r = await this.rewindByFork(sessionId, id, args.forkId, files);
        return r.mode === "forked" ? { ...r, fallback: true } : r;
      }
    }
    if (!s || s.closed) {
      const other = liveProcesses({ fresh: true }).find((l) => l.sessionId === sessionId);
      if (!other) throw Error("session is not running here");
      if (files) throw Error(`cannot rewind files while open in ${other.host}`);
    }
    return this.rewindByFork(sessionId, id, args.forkId, files);
  }

  private async rewindByFork(sessionId: string, messageId: string, forkId: unknown, files: boolean): Promise<RewindConversationResult> {
    if (typeof forkId !== "string") throw Error("invalid request");
    const s = this.controlled(sessionId);
    const items = s && !s.closed ? s.builder.items : await loadHistory(sessionId, await this.cwdOf(sessionId));
    const message = items.find((i) => i.kind === "user" && i.id === messageId);
    if (message?.kind !== "user") throw Error("unknown message");
    const r = await this.fork(sessionId, { id: forkId, before: messageId });
    const restored = files && s && !s.closed ? await s.rewind(messageId, false).catch(failed) : undefined;
    const done = { prefill: message.text, ...(restored ? { files: restored } : {}) };
    return "draft" in r ? { mode: "draft", cwd: r.draft.cwd, ...done } : { mode: "forked", sessionId: r.sessionId, ...done };
  }

  // The Claude Code to start now; the ones running sessions use stay.
  private claude(): Promise<CliChoice> {
    return this.cli.choose([...this.owned.values()].map((s) => s.claudePath));
  }

  private logCli(sessionId: string, c: CliChoice): void {
    const from = c.from ? ` from ${c.from}` : "";
    this.cliLog(`ccrc: session ${sessionId} starts Claude Code ${c.version ?? "(version unknown)"} (${c.source}) ${c.path ?? "bundled with the Agent SDK"}${from}`);
  }

  // A message from here brings an archived session back to the list.
  async send(sessionId: string, text: string, blocks?: ContentBlock[]): Promise<void> {
    const s = this.controlled(sessionId) ?? (await this.activate(sessionId));
    s.send(text, blocks);
    if (this.archive.set(sessionId, false)) {
      this.audit?.log("archive", { sessionId, archived: false, by: "send" });
      this.emit("changed");
    }
  }

  // Names a session where Claude Code keeps names. A process this broker drives saves the name itself; a session
  // without one gets the rows Claude Code writes, never while a program this broker cannot drive has it open.
  async rename(sessionId: string, raw: string): Promise<{ title: string }> {
    const title = cleanTitle(raw);
    if (!title) throw Error("title must be non-empty");
    await this.starting.get(sessionId)?.catch(() => {});
    if (this.claiming.has(sessionId)) throw Error("session is opening in VS Code");
    const running = await this.running(sessionId);
    if (running) return this.renameRunning(running, title);
    const info = await this.info(sessionId);
    const file = info?.cwd ? transcriptPath(sessionId, info.cwd) : undefined;
    if (!file) throw Error("unknown session");
    // Checked again after the last wait, then written without one, so no start here comes in between.
    const now = this.controlled(sessionId);
    if (now && !now.closed) return this.renameRunning(now, title);
    if (this.starting.has(sessionId) || this.claiming.has(sessionId)) throw Error("session is starting");
    const other = liveProcesses({ fresh: true }).find((l) => l.sessionId === sessionId);
    if (other) throw Error(`cannot rename while open in ${other.host}`);
    writeTitle(file, sessionId, title);
    this.catalog = undefined;
    this.emit("changed");
    await this.restate(sessionId).catch(() => {});
    return { title };
  }

  private async renameRunning(s: SessionCore, title: string): Promise<{ title: string }> {
    await s.rename(title);
    this.catalog = undefined;
    this.emit("changed");
    return { title: s.title || title };
  }

  // The session's process here, once one that is closing has ended.
  private async running(sessionId: string): Promise<SessionCore | undefined> {
    const until = Date.now() + CLOSING_WAIT_MS;
    let s = this.controlled(sessionId);
    while (s?.closed && Date.now() < until) {
      await sleep(250);
      s = this.controlled(sessionId);
    }
    return s?.closed ? undefined : s;
  }

  async setArchived(sessionId: string, on: boolean): Promise<{ archived: boolean }> {
    if (!this.controlled(sessionId) && !(await this.info(sessionId))) throw Error("unknown session");
    if (this.archive.set(sessionId, on)) this.emit("changed");
    return { archived: on };
  }

  private archived(sessionId: string): { archived?: true } {
    return this.archive.has(sessionId) ? { archived: true } : {};
  }

  // Sessions whose transcript is gone, as Claude Code removes old ones, leave the archive.
  pruneArchived(): void {
    const ids = transcriptIds(PROJECTS);
    if (ids) this.archive.prune((id) => ids.has(id));
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
      case "fork":
        return this.fork(sessionId, {
          id: String(args.id),
          ...(typeof args.before === "string" ? { before: args.before } : {}),
          ...(typeof args.text === "string" ? { text: args.text } : {}),
          ...(typeof args.name === "string" ? { name: args.name } : {}),
        });
      case "rewind_conversation":
        return this.rewindConversation(sessionId, args);
      case "stop_task":
        await this.get(sessionId).stopTask(String(args.taskId));
        return {};
      case "agent_transcript":
        return agentTranscript(sessionId, await this.cwdOf(sessionId), args);
      case "task_output":
        return this.get(sessionId).taskOutput(String(args.taskId));
      case "workflow_agents":
        return workflowAgents(sessionId, await this.cwdOf(sessionId), args.runId);
      case "output_style":
        return this.get(sessionId).outputStyleInfo();
      case "set_output_style":
        return this.get(sessionId).setOutputStyle(String(args.style));
      case "unqueue":
        await this.get(sessionId).unqueue(String(args.messageId));
        return {};
      case "rename":
        return this.rename(sessionId, typeof args.title === "string" ? args.title : "");
      case "archive":
        return this.setArchived(sessionId, args.archived === true);
    }
  }

  // The new-session screen's calls about a folder resolveFolder allowed. `indexed` hears of a file listing made for it.
  async folderCall(dir: string, op: FolderOp, args: Record<string, unknown>, indexed?: (files: number) => void): Promise<unknown> {
    switch (op) {
      case "files":
        return searchFiles(dir, typeof args.query === "string" ? args.query : "", indexed);
      case "commands":
        return lastCommands(dir);
      case "usage":
        return this.accountUsageFor(dir);
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
    return this.accountUsageFor(await this.cwdOf(sessionId), s);
  }

  private accountUsageFor(cwd: string, skip?: SessionCore): Promise<UsageInfo> {
    const kept = this.accountUsage;
    if (kept && Date.now() - kept.at < USAGE_KEEP_MS) return kept.value;
    const value = this.freshAccountUsage(cwd, skip);
    const entry = { at: Date.now(), value };
    this.accountUsage = entry;
    // An answer without limits may come from a process that could not sign in, so it is not kept.
    const forget = () => {
      if (this.accountUsage === entry) this.accountUsage = undefined;
    };
    value.then((u) => u.limits.length || forget(), forget);
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
    return this.usageProbe(probeDir(cwd), (await this.claude()).path);
  }

  // What reading a linked file needs: the folder the session started in, the one it last worked in,
  // and its running Claude Code process if there is one.
  async fileAccess(sessionId: string): Promise<{ start: string; latest?: string; session?: SessionCore }> {
    const s = this.controlled(sessionId);
    const start = await this.cwdOf(sessionId);
    const latest = await lastCwd(sessionId, start);
    return { start, latest: latest !== start ? latest : undefined, session: s && !s.closed ? s : undefined };
  }

  // The transcript of a known session, where the images of its messages are read from.
  async transcriptFile(sessionId: string): Promise<string | undefined> {
    return transcriptPath(sessionId, await this.cwdOf(sessionId));
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

  setFast(sessionId: string, on: boolean): Promise<void> {
    return this.controlled(sessionId)?.setFast(on) ?? this.setStart(sessionId, { fast: on });
  }

  setThinking(sessionId: string, on: boolean): Promise<void> {
    return this.controlled(sessionId)?.setThinking(on) ?? this.setStart(sessionId, { thinking: on });
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
    if (!next.fast) delete next.fast;
    if (next.thinking !== false) delete next.thinking;
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
    let early: { from: "out" | "in" | "settled" | "held"; v: unknown; at: string }[] = [];
    const bind = (id: string) => {
      if (session?.id === id || !link.usable) return;
      session?.end("switched");
      const cwd = link.hello?.cwd ?? "";
      const s = new WrappedSession(link, id, cwd);
      s.reachable = () => this.remoteReachable();
      s.watched = () => this.remoteWatching();
      session = s;
      const prev = this.wrapped.get(id);
      this.wrapped.set(id, s);
      prev?.end("replaced");
      this.adopt(s);
      for (const h of early) {
        if (h.from === "out") s.onOut(h.v as Record<string, unknown>, h.at);
        else if (h.from === "in") s.onIn(h.v as Record<string, unknown>);
        else if (h.from === "held") s.onHeld(h.v);
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
    const keep = (from: "out" | "in" | "settled" | "held", v: unknown) => {
      if (early.length < EARLY_LINES_MAX) early.push({ from, v, at: new Date().toISOString() });
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
    link.on("held", (id: unknown) => (session ? session.onHeld(id) : keep("held", id)));
    link.on("rejected", (id: unknown, reason: unknown) => session?.onRejected(id, reason));
    link.on("exit", (code: unknown, signal: unknown, hostLeft: unknown, running: unknown) => session?.exited(code, signal, hostLeft, running));
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
      if (s.id === this.viewed || s.busy || s.pending.size || s.tasks.running()) continue;
      if (Date.now() - s.lastActivity > limit) await s.close("idle");
    }
    for (const [id, e] of this.ended) if (Date.now() - e.at > (e.reason === "crashed" ? CRASHED_KEEP_MS : ENDED_KEEP_MS)) this.ended.delete(id);
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
    s.on("applied", (model: string, ultracode: boolean) => this.ultracodeModels.learn(model, ultracode));
    s.on("turn_end", (end: TurnEnd) => {
      if (this.current(s)) this.emit("turn_end", s.id, end);
    });
    s.on("title", () => {
      this.catalog = undefined;
      this.emit("changed");
    });
    s.on("closed", (reason: string) => {
      if (!this.current(s)) return;
      if (this.owned.get(s.id) === s) this.owned.delete(s.id);
      if (this.wrapped.get(s.id) === s) this.wrapped.delete(s.id);
      const unsent = s.builder.items.filter((i) => i.kind === "note" && i.code === "unsent");
      this.ended.set(s.id, { reason, at: Date.now(), unsent });
      this.catalog = undefined;
      this.emit("event", s.id, { t: "state", sessionId: s.id, state: s.state() });
      if (!isFolder(s.cwd)) void this.restate(s.id);
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
  return { model: start.model, mode: start.mode, ...(later ? { later } : {}), ...(start.fast ? { fast: true } : {}), ...(start.thinking === false ? { thinking: false } : {}) };
}

// The model the user's settings start Claude Code with.
function settingsModel(): string | undefined {
  try {
    const v = (JSON.parse(fs.readFileSync(claudeSettingsFile(), "utf8")) as { model?: unknown }).model;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

const modelsFile = () => path.join(paths.stateDir, "models.json");

// Claude Code lists this from 2.1.300 on; the SDK does not declare it.
function thinkingOffOf(m: ModelInfo): boolean | undefined {
  const v = (m as { supportsThinkingOff?: unknown }).supportsThinkingOff;
  return typeof v === "boolean" ? v : undefined;
}

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
      ...(m.supportsFastMode === true ? { fast: true } : {}),
      ...(thinkingOffOf(m) === undefined ? {} : { thinkingOff: thinkingOffOf(m) }),
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
