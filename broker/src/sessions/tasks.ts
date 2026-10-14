import type { TaskInfo, WorkflowAgent, WorkflowAgentState, WorkflowInfo } from "../protocol.ts";

const NAME_MAX = 200;
const TEXT_MAX = 1000;
const NOTE_MAX = 300;
const LABEL_MAX = 120;
const TASKS_MAX = 60;
const WORKFLOW_AGENTS_MAX = 40;
const WORKFLOW_PHASES_MAX = 40;
// How long a task that has ended stays listed.
export const TASK_KEEP_MS = 5 * 60_000;
// A running background task missing from Claude Code's list of them is dropped after this long without an end of its own.
const GONE_MS = 3000;
// Progress alone (tokens, tool count, activity, workflow agents) is sent at most this often.
const PROGRESS_MS = 1000;

const EVENTS = new Set(["task_started", "task_progress", "task_updated", "task_notification", "background_tasks_changed"]);
const STATUS = new Map<unknown, TaskInfo["status"]>([
  ["pending", "running"],
  ["running", "running"],
  ["paused", "running"],
  ["completed", "completed"],
  ["failed", "failed"],
  ["killed", "stopped"],
  ["stopped", "stopped"],
]);
// What tells the phone more than progress: these go out at once.
const SHAPE: (keyof TaskInfo)[] = ["description", "kind", "agentType", "status", "toolUseId", "parentId", "depth", "background", "error"];

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): string | undefined => (typeof v === "string" && v ? v.slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

interface Entry {
  info: TaskInfo;
  startedAt: number;
  endedAt?: number;
  // The length Claude Code reported for a run that has ended.
  ms?: number;
  runId?: string;
  seenAt: number;
  // Added from Claude Code's list of background tasks: its start is learned from its first progress.
  fromList?: boolean;
  // When each workflow agent started, by Claude Code's clock, which is this machine's.
  agentStarts?: (number | undefined)[];
}

function agentState(state: unknown, started: boolean): WorkflowAgentState {
  if (state === "done") return "done";
  if (state === "error") return "failed";
  return started ? "running" : "queued";
}

// A workflow's phases and agents from the progress Claude Code reports for it; the field is not part of the
// SDK's public types, so anything of another shape is left out, and nothing usable gives undefined.
export function workflowProgress(v: unknown, name?: string): { info: WorkflowInfo; starts: (number | undefined)[] } | undefined {
  if (!Array.isArray(v)) return undefined;
  const phaseRows = v
    .filter((p): p is Obj => isObj(p) && p.type === "workflow_phase" && typeof p.index === "number")
    .sort((a, b) => (a.index as number) - (b.index as number))
    .slice(0, WORKFLOW_PHASES_MAX);
  const phases = phaseRows.map((p) => text(p.title, LABEL_MAX) ?? `${p.index}`);
  const phaseAt = new Map(phaseRows.map((p, i) => [p.index, i]));
  const rows = v
    .filter((a): a is Obj => isObj(a) && a.type === "workflow_agent" && typeof a.label === "string")
    .sort((a, b) => (num(a.index) ?? 0) - (num(b.index) ?? 0));
  if (!phases.length && !rows.length) return undefined;
  const all: WorkflowAgent[] = [];
  const starts: (number | undefined)[] = [];
  for (const a of rows) {
    const startedAt = num(a.startedAt);
    const state = agentState(a.state, startedAt !== undefined);
    const phase = phaseAt.get(a.phaseIndex);
    const id = text(a.agentId, NAME_MAX);
    const model = text(a.model, NAME_MAX);
    const tokens = num(a.tokens);
    const tools = num(a.toolCalls);
    const ms = state === "done" || state === "failed" ? num(a.durationMs) : undefined;
    const activity = text(a.lastToolName, LABEL_MAX);
    const error = text(a.error, NOTE_MAX);
    all.push({
      label: (a.label as string).slice(0, LABEL_MAX),
      ...(id ? { id } : {}),
      ...(phase !== undefined ? { phase } : {}),
      state,
      ...(model ? { model } : {}),
      ...(tokens !== undefined ? { tokens } : {}),
      ...(tools !== undefined ? { tools } : {}),
      ...(ms !== undefined ? { ms } : {}),
      ...(activity ? { activity } : {}),
      ...(error ? { error } : {}),
    });
    starts.push(state === "running" ? startedAt : undefined);
  }
  const running = all.filter((a) => a.state === "running");
  const at = Math.max(-1, ...(running.length ? running : all).map((a) => a.phase ?? -1));
  return {
    info: {
      ...(name ? { name } : {}),
      phases,
      ...(at >= 0 ? { phase: at } : {}),
      agents: all.slice(0, WORKFLOW_AGENTS_MAX),
      total: all.length,
      running: running.length,
      done: all.filter((a) => a.state === "done").length,
      failed: all.filter((a) => a.state === "failed").length,
    },
    starts: starts.slice(0, WORKFLOW_AGENTS_MAX),
  };
}

const shape = (t: TaskInfo) => JSON.stringify(SHAPE.map((k) => t[k]));

// The session's tasks as Claude Code reports them through task_* messages and its list of background tasks.
// A task_updated carries its changes in `patch`; a task first seen through its progress counts as running.
// A later run of the same task (a subagent woken again) starts over; messages of an earlier run are dropped.
export class TaskBook {
  keepMs = TASK_KEEP_MS;
  goneMs = GONE_MS;
  progressMs = PROGRESS_MS;
  private entries = new Map<string, Entry>();
  // Claude Code's own watchers, which run for the whole session and are not the user's work.
  private ambient = new Set<string>();
  private timers = new Map<string, NodeJS.Timeout>();
  private listed?: { ids: Set<string>; at: number };
  private goneTimer?: NodeJS.Timeout;
  private progressTimer?: NodeJS.Timeout;
  private sentAt = 0;
  private changed: () => void;

  constructor(changed: () => void) {
    this.changed = changed;
  }

  static handles(subtype: unknown): boolean {
    return typeof subtype === "string" && EVENTS.has(subtype);
  }

  get size(): number {
    return this.entries.size;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get(id: string): TaskInfo | undefined {
    const e = this.entries.get(id);
    return e && this.shown(e, Date.now());
  }

  // Running tasks first, then the ones that ended most recently.
  values(now = Date.now()): TaskInfo[] {
    const order = (e: Entry) => (e.info.status === "running" ? Infinity : (e.endedAt ?? 0));
    return [...this.entries.values()]
      .sort((a, b) => order(b) - order(a))
      .slice(0, TASKS_MAX)
      .map((e) => this.shown(e, now));
  }

  running(): boolean {
    return [...this.entries.values()].some((e) => e.info.status === "running");
  }

  clear(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    clearTimeout(this.goneTimer);
    clearTimeout(this.progressTimer);
    this.goneTimer = this.progressTimer = undefined;
    this.entries.clear();
    this.listed = undefined;
  }

  on(m: Obj): void {
    if (m.subtype === "background_tasks_changed") return this.onList(m.tasks);
    const id = text(m.task_id, NAME_MAX + 1);
    if (!id || id.length > NAME_MAX || this.ambient.has(id)) return;
    if (m.subtype === "task_started" && m.ambient === true) {
      this.ambient.add(id);
      if (this.drop(id)) this.send(true);
      return;
    }
    const now = Date.now();
    const started = m.subtype === "task_started";
    const runId = text(m.run_id, NAME_MAX);
    let e = this.entries.get(id);
    if (e?.runId && runId && runId < e.runId) return;
    if (!e) {
      if (!started && m.subtype !== "task_progress") return;
      e = { info: { id, description: "", status: "running" }, startedAt: now, seenAt: now };
      this.entries.set(id, e);
    }
    const before = JSON.stringify(e.info);
    const was = shape(e.info);
    const fresh = before === JSON.stringify({ id, description: "", status: "running" });
    if (started && (runId && e.runId ? runId > e.runId : e.info.status !== "running")) this.restart(e, now);
    if (runId) e.runId = runId;
    const i = e.info;
    const usage = isObj(m.usage) ? m.usage : {};
    if (started) {
      e.fromList = false;
      this.set(i, "description", text(m.description, TEXT_MAX) ?? i.description);
      this.set(i, "kind", text(m.task_type, NAME_MAX) ?? i.kind);
      this.set(i, "agentType", text(m.subagent_type, NAME_MAX) ?? i.agentType);
      this.set(i, "toolUseId", text(m.tool_use_id, NAME_MAX) ?? i.toolUseId);
      this.set(i, "parentId", text(m.parent_task_id, NAME_MAX) ?? i.parentId);
      this.set(i, "depth", num(m.spawn_depth) ?? i.depth);
      if (typeof m.is_backgrounded === "boolean") i.background = m.is_backgrounded;
      const name = text(m.workflow_name, LABEL_MAX);
      if (name || i.kind === "local_workflow") i.workflow = { ...(i.workflow ?? { phases: [], agents: [], total: 0, running: 0, done: 0, failed: 0 }), ...(name ? { name } : {}) };
    } else if (m.subtype === "task_progress") {
      const desc = text(m.description, TEXT_MAX);
      if (!i.description) this.set(i, "description", desc ?? "");
      this.set(i, "agentType", i.agentType ?? text(m.subagent_type, NAME_MAX));
      this.set(i, "toolUseId", i.toolUseId ?? text(m.tool_use_id, NAME_MAX));
      const ms = num(usage.duration_ms);
      if ((fresh || e.fromList) && ms !== undefined) e.startedAt = now - ms;
      e.fromList = false;
      this.counts(i, usage);
      const tool = text(m.last_tool_name, LABEL_MAX);
      this.set(i, "activity", desc && desc !== i.description ? desc.slice(0, NOTE_MAX) : (tool ?? i.activity));
      const summary = text(m.summary, NOTE_MAX);
      if (summary && summary !== i.description.slice(0, NOTE_MAX)) i.summary = summary;
      const wf = workflowProgress(m.workflow_progress, i.workflow?.name);
      if (wf) {
        i.workflow = wf.info;
        e.agentStarts = wf.starts;
      }
    } else if (m.subtype === "task_updated") {
      const patch = isObj(m.patch) ? m.patch : {};
      const status = STATUS.get(patch.status);
      if (status) this.end(e, status, now);
      this.set(i, "description", text(patch.description, TEXT_MAX) ?? i.description);
      this.set(i, "error", text(patch.error, NOTE_MAX) ?? i.error);
      if (typeof patch.is_backgrounded === "boolean") i.background = patch.is_backgrounded;
    } else if (m.subtype === "task_notification") {
      this.end(e, STATUS.get(m.status) ?? "completed", now);
      this.set(i, "toolUseId", i.toolUseId ?? text(m.tool_use_id, NAME_MAX));
      this.set(i, "summary", text(m.summary, NOTE_MAX) ?? i.summary);
      this.counts(i, usage);
      e.ms = num(usage.duration_ms) ?? e.ms;
    }
    i.type = i.agentType ?? i.kind;
    if (!i.type) delete i.type;
    if (JSON.stringify(i) === before && !fresh) return;
    this.send(fresh || shape(i) !== was);
  }

  private set<K extends keyof TaskInfo>(i: TaskInfo, key: K, v: TaskInfo[K] | undefined): void {
    if (v === undefined) delete i[key];
    else i[key] = v;
  }

  private counts(i: TaskInfo, usage: Obj): void {
    this.set(i, "tokens", num(usage.total_tokens) ?? i.tokens);
    this.set(i, "tools", num(usage.tool_uses) ?? i.tools);
  }

  private restart(e: Entry, now: number): void {
    const { id, description, kind, agentType, toolUseId, parentId, depth, background } = e.info;
    e.info = { id, description, ...{ kind, agentType, toolUseId, parentId, depth, background }, status: "running" };
    for (const k of Object.keys(e.info) as (keyof TaskInfo)[]) if (e.info[k] === undefined) delete e.info[k];
    e.startedAt = now;
    e.endedAt = e.ms = undefined;
    clearTimeout(this.timers.get(e.info.id));
    this.timers.delete(e.info.id);
  }

  private end(e: Entry, status: TaskInfo["status"], now: number): void {
    const id = e.info.id;
    if (status === "running") {
      e.info.status = "running";
      return;
    }
    if (e.info.status === "running" || e.endedAt === undefined) e.endedAt = now;
    e.info.status = status;
    clearTimeout(this.timers.get(id));
    const timer = setTimeout(() => {
      this.timers.delete(id);
      if (this.entries.get(id) === e && this.drop(id)) this.send(true);
    }, this.keepMs);
    timer.unref();
    this.timers.set(id, timer);
  }

  private drop(id: string): boolean {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    return this.entries.delete(id);
  }

  // The full list of background tasks still running, sent when it changes and again by the wrapper when it
  // reconnects. It adds what was missed and, after a while, drops what has gone without an end of its own.
  private onList(tasks: unknown): void {
    if (!Array.isArray(tasks)) return;
    const now = Date.now();
    const ids = new Set<string>();
    let changed = false;
    for (const t of tasks) {
      if (!isObj(t)) continue;
      const id = text(t.task_id, NAME_MAX + 1);
      if (!id || id.length > NAME_MAX) continue;
      if (t.ambient === true) {
        this.ambient.add(id);
        changed = this.drop(id) || changed;
        continue;
      }
      if (this.ambient.has(id)) continue;
      ids.add(id);
      const runId = text(t.run_id, NAME_MAX);
      const e = this.entries.get(id);
      if (e && !(runId && e.runId && runId > e.runId)) {
        if (e.info.status === "running" && !e.info.background) {
          e.info.background = true;
          changed = true;
        }
        continue;
      }
      if (e) this.restart(e, now);
      const kind = text(t.task_type, NAME_MAX);
      const agentType = text(t.subagent_type, NAME_MAX);
      const parentId = e?.info.parentId ?? text(t.parent_task_id, NAME_MAX);
      const info: TaskInfo = {
        id,
        description: text(t.description, TEXT_MAX) ?? e?.info.description ?? "",
        ...((agentType ?? kind) ? { type: agentType ?? kind } : {}),
        ...(kind ? { kind } : {}),
        ...(agentType ? { agentType } : {}),
        status: "running",
        ...(e?.info.toolUseId ? { toolUseId: e.info.toolUseId } : {}),
        ...(parentId ? { parentId } : {}),
        background: true,
        ...(kind === "local_workflow" ? { workflow: { phases: [], agents: [], total: 0, running: 0, done: 0, failed: 0 } } : {}),
      };
      this.entries.set(id, { info, startedAt: now, seenAt: e?.seenAt ?? now, fromList: true, ...(runId ? { runId } : {}) });
      changed = true;
    }
    this.listed = { ids, at: now };
    if (changed) this.send(true);
    clearTimeout(this.goneTimer);
    this.goneTimer = undefined;
    if (this.gone().length) {
      this.goneTimer = setTimeout(() => {
        this.goneTimer = undefined;
        let dropped = false;
        for (const id of this.gone()) dropped = this.drop(id) || dropped;
        if (dropped) this.send(true);
      }, this.goneMs);
      this.goneTimer.unref();
    }
  }

  // Running background tasks known before the latest list and missing from it.
  private gone(): string[] {
    const l = this.listed;
    if (!l) return [];
    return [...this.entries.values()].filter((e) => e.info.status === "running" && e.info.background === true && e.seenAt <= l.at && !l.ids.has(e.info.id)).map((e) => e.info.id);
  }

  private shown(e: Entry, now: number): TaskInfo {
    const ms = e.info.status === "running" ? now - e.startedAt : (e.ms ?? (e.endedAt ?? now) - e.startedAt);
    const wf = e.info.workflow;
    const workflow =
      wf && e.agentStarts?.some((s) => s !== undefined)
        ? { ...wf, agents: wf.agents.map((a, n) => (e.agentStarts?.[n] !== undefined && a.state === "running" ? { ...a, ms: Math.max(0, now - e.agentStarts[n]!) } : a)) }
        : wf;
    return { ...e.info, ms: Math.max(0, Math.round(ms)), ...(workflow ? { workflow } : {}) };
  }

  // A change of state goes out at once; progress alone at most once every progressMs.
  private send(now: boolean): void {
    if (now) {
      clearTimeout(this.progressTimer);
      this.progressTimer = undefined;
      this.sentAt = Date.now();
      this.changed();
      return;
    }
    if (this.progressTimer) return;
    const wait = this.sentAt + this.progressMs - Date.now();
    if (wait <= 0) return this.send(true);
    this.progressTimer = setTimeout(() => this.send(true), wait);
    this.progressTimer.unref();
  }
}
