import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { listSessions, type ModelInfo, type SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.ts";
import type {
  DisplayItem,
  EffortName,
  LiveState,
  ModelOption,
  PendingRequest,
  PermissionModeName,
  ServerMsg,
  SessionSummary,
} from "../protocol.ts";
import { BrokerSession } from "./broker-session.ts";
import { loadHistory, projectDirName, transcriptPath } from "./history.ts";
import { liveProcesses } from "./live.ts";

const CATALOG_MS = 3000;
const SNAPSHOT_ITEMS = 400;
const SWEEP_MS = 60_000;
const WATCH_INTERVAL_MS = 2000;

export interface Snapshot {
  items: DisplayItem[];
  pending: PendingRequest[];
  state: LiveState;
  hasMore: boolean;
}

function titleOf(info: SDKSessionInfo): string {
  return info.customTitle || info.summary || info.firstPrompt || "";
}

function tail(items: DisplayItem[]): { items: DisplayItem[]; hasMore: boolean } {
  return { items: items.slice(-SNAPSHOT_ITEMS), hasMore: items.length > SNAPSHOT_ITEMS };
}

function within(dir: string, root: string): boolean {
  const rel = path.relative(root, dir);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Owns the broker's Claude Code processes and answers questions about every session on the machine.
// Emits "event" (sessionId, ServerMsg) for one session and "changed" when the session list changed.
export class SessionManager extends EventEmitter {
  models: ModelOption[] = [];
  private cfg: Config;
  private owned = new Map<string, BrokerSession>();
  private starting = new Map<string, Promise<BrokerSession>>();
  private catalog?: { at: number; list: SDKSessionInfo[] };
  private viewed: string | null = null;
  private sweeper: NodeJS.Timeout;

  constructor(cfg: Config) {
    super();
    this.cfg = cfg;
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

  async list(): Promise<SessionSummary[]> {
    const infos = await this.infos();
    const live = new Map(liveProcesses().filter((l) => !this.owned.has(l.sessionId)).map((l) => [l.sessionId, l]));
    const out: SessionSummary[] = infos.map((info) => {
      const s = this.owned.get(info.sessionId);
      const l = live.get(info.sessionId);
      return {
        id: info.sessionId,
        title: s?.title || titleOf(info),
        cwd: info.cwd ?? "",
        branch: info.gitBranch,
        lastModified: s ? Math.max(info.lastModified, s.lastActivity) : info.lastModified,
        createdAt: info.createdAt,
        state: s ? "owned" : l ? "live" : "inactive",
        liveHost: l?.host,
        liveStatus: l?.status,
        busy: s ? s.busy : l?.status === "busy",
        pendingCount: s?.pending.size || undefined,
      };
    });
    for (const s of this.owned.values()) {
      if (out.some((o) => o.id === s.id)) continue;
      out.push({ id: s.id, title: s.title ?? "", cwd: s.cwd, lastModified: s.lastActivity, state: "owned", busy: s.busy, pendingCount: s.pending.size || undefined });
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

  async folders(): Promise<string[]> {
    const known = (await this.infos()).map((i) => i.cwd).filter((c): c is string => Boolean(c));
    return [...new Set([...this.cfg.roots, ...known])].sort();
  }

  async snapshot(sessionId: string): Promise<Snapshot> {
    const s = this.owned.get(sessionId);
    if (s) return { ...tail(s.builder.items), pending: [...s.pending.values()].map((e) => e.request), state: s.state() };
    const info = await this.info(sessionId);
    if (!info?.cwd) throw Error("unknown session");
    const l = liveProcesses().find((p) => p.sessionId === sessionId);
    const items = await loadHistory(sessionId, info.cwd);
    return {
      ...tail(items),
      pending: [],
      state: { sessionId, cwd: info.cwd, title: titleOf(info), owned: false, busy: l?.status === "busy", liveHost: l?.host },
    };
  }

  // Calls back whenever the transcript of a session this broker does not run changes.
  watch(sessionId: string, onChange: () => void): () => void {
    const file = transcriptPath(sessionId);
    if (!file) return () => {};
    const listener = (cur: fs.Stats, prev: fs.Stats) => {
      if (cur.mtimeMs !== prev.mtimeMs && !this.owned.has(sessionId)) onChange();
    };
    fs.watchFile(file, { interval: WATCH_INTERVAL_MS }, listener);
    return () => fs.unwatchFile(file, listener);
  }

  isOwned(sessionId: string): boolean {
    return this.owned.has(sessionId);
  }

  private get(sessionId: string): BrokerSession {
    const s = this.owned.get(sessionId);
    if (!s) throw Error("session is not running here");
    return s;
  }

  async activate(sessionId: string): Promise<BrokerSession> {
    const running = this.owned.get(sessionId);
    if (running) return running;
    const pending = this.starting.get(sessionId);
    if (pending) return pending;
    const p = (async () => {
      const info = await this.info(sessionId);
      if (!info?.cwd) throw Error("unknown session");
      const other = liveProcesses().find((l) => l.sessionId === sessionId);
      if (other) throw Error(`session is open in ${other.host}`);
      const cwd = await this.resumeFolder(sessionId, info.cwd);
      const s = new BrokerSession(sessionId, cwd, await loadHistory(sessionId, cwd), titleOf(info));
      this.adopt(s);
      s.start({ resume: true, claudePath: this.cfg.claudePath });
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

  async send(sessionId: string, text: string): Promise<void> {
    const s = this.owned.get(sessionId) ?? (await this.activate(sessionId));
    s.send(text);
  }

  answer(sessionId: string, requestId: string, answer: Parameters<BrokerSession["answer"]>[1]): Promise<void> {
    return this.get(sessionId).answer(requestId, answer);
  }

  interrupt(sessionId: string): Promise<void> {
    return this.get(sessionId).interrupt();
  }

  setMode(sessionId: string, mode: PermissionModeName): Promise<void> {
    return this.get(sessionId).setMode(mode);
  }

  setModel(sessionId: string, model: string): Promise<void> {
    return this.get(sessionId).setModel(model);
  }

  setEffort(sessionId: string, effort: EffortName): Promise<void> {
    return this.get(sessionId).setEffort(effort);
  }

  async release(sessionId: string): Promise<void> {
    await this.owned.get(sessionId)?.close("released");
  }

  async closeAll(): Promise<void> {
    clearInterval(this.sweeper);
    await Promise.all([...this.owned.values()].map((s) => s.close("shutdown")));
  }

  // Closes processes nobody is looking at once they have been idle for a while.
  private async sweep(): Promise<void> {
    const limit = this.cfg.sessionIdleMinutes * 60_000;
    for (const s of this.owned.values()) {
      if (s.id === this.viewed || s.busy || s.pending.size) continue;
      if (Date.now() - s.lastActivity > limit) await s.close("idle");
    }
  }

  private adopt(s: BrokerSession): void {
    this.owned.set(s.id, s);
    const send = (msg: ServerMsg) => this.emit("event", s.id, msg);
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
    s.on("models", (models: ModelInfo[]) => {
      this.models = models.map((m) => ({
        value: m.value,
        resolved: m.resolvedModel,
        label: m.displayName,
        description: m.description,
        efforts: m.supportedEffortLevels,
      }));
    });
    s.on("closed", () => {
      if (this.owned.get(s.id) === s) this.owned.delete(s.id);
      this.catalog = undefined;
      send({ t: "state", sessionId: s.id, state: s.state() });
      this.emit("changed");
    });
    this.catalog = undefined;
    this.emit("changed");
  }
}
