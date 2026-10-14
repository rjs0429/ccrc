import { EventEmitter } from "node:events";
import {
  PERMISSION_MODES,
  type Answer,
  type CommandInfo,
  type ContextDetail,
  type ContextGauge,
  type DisplayItem,
  type EffortName,
  type ElicitInfo,
  type ElicitValue,
  type LiveState,
  type McpServerInfo,
  type OutputStyleInfo,
  type PendingKind,
  type PendingRequest,
  type PermissionModeName,
  type QueuedMessage,
  type RewindResult,
  type TaskInfo,
  type UsageInfo,
} from "../protocol.ts";
import { elicitResult } from "../elicit.ts";
import { gaugeOf } from "./context-gauge.ts";
import type { FileContents } from "./file-read.ts";
import { ItemBuilder, clipInput, typedContent, type RawMessage } from "./items.ts";

const STREAM_FLUSH_MS = 80;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_MAX = 200;
const TEXT_MAX = 1000;
const FILES_MAX = 500;
const STYLES_MAX = 100;
const TASK_KEEP_MS = 5 * 60_000;
const TASK_EVENTS = new Set(["task_started", "task_progress", "task_updated", "task_notification"]);
const TASK_STATUS = new Map<unknown, TaskInfo["status"]>([
  ["pending", "running"],
  ["running", "running"],
  ["paused", "running"],
  ["completed", "completed"],
  ["failed", "failed"],
  ["killed", "stopped"],
  ["stopped", "stopped"],
]);
const QUEUE_MAX = 100;
// Command lifecycle states that end a queued message without Claude Code taking it in.
const UNQUEUED = new Set<unknown>(["cancelled", "discarded", "refused"]);
// An approved plan continues in the chosen mode, so only modes offered remotely may be named.
const PLAN_DECISIONS = new Set<unknown>(["auto", "acceptEdits", "default", "keep_planning"]);

// How long Claude Code may take to answer: counting the context by category calls the token-count API,
// and turning on or reconnecting an MCP server waits for the server to connect.
export const CONTEXT_MS = 60_000;
export const MCP_CHANGE_MS = 45_000;
// An MCP server's input request left unanswered this long is cancelled.
export const ELICIT_MS = 15 * 60_000;
// A VS Code session's request taken while the app is not open on a phone gets this long for the app to open.
export const ELICIT_UNWATCHED_MS = 2 * 60_000;
// A file of up to 10MB travels base64-encoded in one line.
export const READ_MS = 30_000;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const clipped = (v: unknown, max = TEXT_MAX): string | undefined => (typeof v === "string" && v ? v.slice(0, max) : undefined);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export type Decision =
  | { behavior: "allow"; updatedInput: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: "deny"; message: string; interrupt?: boolean };

export type ElicitAnswer = { action: "accept" | "decline" | "cancel"; content?: Record<string, ElicitValue> };

// A permission prompt or question from Claude Code, in the shape both transports can fill.
export interface Ask {
  requestId: string;
  kind?: PendingKind;
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: unknown[];
  title?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  suppressAlwaysAllowRule?: boolean;
  localOnly?: boolean;
  elicitation?: ElicitInfo;
}

// A Claude Code message content block (image, document, ...), sent in front of the text of a user message.
export type ContentBlock = Record<string, unknown>;

// The command list from Claude Code's initialize answer.
export function commandInfo(list: unknown): CommandInfo[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((c): c is Record<string, unknown> => c !== null && typeof c === "object" && typeof (c as Record<string, unknown>).name === "string")
    .map((c) => ({
      name: c.name as string,
      description: typeof c.description === "string" ? c.description : "",
      ...(typeof c.argumentHint === "string" && c.argumentHint ? { argumentHint: c.argumentHint } : {}),
    }));
}

// The servers of an mcp_status answer, with the number of tools in place of the tool list.
export function mcpServers(list: unknown): McpServerInfo[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((s): s is Obj => isObj(s) && typeof s.name === "string" && s.name !== "")
    .map((s) => {
      const error = clipped(s.error);
      const scope = clipped(s.scope, NAME_MAX) ?? clipped(s.source, NAME_MAX);
      return {
        name: s.name as string,
        status: clipped(s.status, NAME_MAX) ?? "unknown",
        ...(error ? { error } : {}),
        ...(scope ? { scope } : {}),
        ...(Array.isArray(s.tools) ? { tools: s.tools.length } : {}),
      };
    });
}

export function rewindResult(r: unknown): RewindResult {
  const o = isObj(r) ? r : {};
  const error = clipped(o.error);
  const files = Array.isArray(o.filesChanged) ? o.filesChanged.filter((f): f is string => typeof f === "string") : undefined;
  return {
    canRewind: o.canRewind === true,
    ...(error ? { error } : {}),
    ...(files ? { filesChanged: files.slice(0, FILES_MAX) } : {}),
    ...(typeof o.insertions === "number" ? { insertions: o.insertions } : {}),
    ...(typeof o.deletions === "number" ? { deletions: o.deletions } : {}),
  };
}

export interface PendingEntry {
  request: PendingRequest;
  input: Record<string, unknown>;
  suggestions?: unknown[];
}

interface StreamEvent {
  type: string;
  content_block?: { type: string };
  delta?: { type: string; text?: string; thinking?: string };
}

// A session whose Claude Code process the broker can drive: one it runs itself ("owned") or one
// that runs in VS Code and is reached through the wrapper ("attached").
// Events: item, stream, pending_add, pending_remove, state, models, window, applied (model, ultracodeAvailable), closed.
export abstract class SessionCore extends EventEmitter {
  abstract readonly kind: "owned" | "attached";
  abstract readonly host: string;
  id: string;
  cwd: string;
  title?: string;
  readonly builder: ItemBuilder;
  readonly pending = new Map<string, PendingEntry>();
  readonly tasks = new Map<string, TaskInfo>();
  // Messages Claude Code holds until it takes them in, and the ones it has said it holds.
  readonly queue = new Map<string, QueuedMessage>();
  private held = new Set<string>();
  private takingBack = new Set<string>();
  // Claude Code's own watchers, which run for the whole session and are not the user's work.
  private ambientTasks = new Set<string>();
  // How long a task that has ended stays listed.
  taskKeepMs = TASK_KEEP_MS;
  commands?: CommandInfo[];
  busy = false;
  model?: string;
  permissionMode?: string;
  effort?: string;
  ultracode?: boolean;
  ultracodeAvailable?: boolean;
  outputStyles?: string[];
  context?: ContextGauge;
  // The last turn was a local command ("/compact", "/model x", ...), which runs no model turn of its own.
  localTurn = false;
  costUsd?: number;
  lastActivity = Date.now();
  closed = false;
  closedReason?: string;

  private ended = false;
  private appliedSeen = false;
  private appliedOff = false;
  // The output style from the settings, and the one Claude Code last announced, which holds when no setting names one.
  private settingsStyle?: string;
  private initStyle?: string;
  private appliedRefused = false;
  private taskTimers = new Map<string, NodeJS.Timeout>();
  private streamText = "";
  private streamThinking = false;
  private streamTimer?: NodeJS.Timeout;

  constructor(id: string, cwd: string, history: DisplayItem[] = [], title?: string) {
    super();
    this.id = id;
    this.cwd = cwd;
    this.title = title;
    this.builder = new ItemBuilder(cwd);
    this.builder.seed(history);
  }

  abstract send(text: string, blocks?: ContentBlock[]): void;
  abstract interrupt(): Promise<void>;
  abstract setModel(model: string): Promise<void>;
  abstract setEffort(effort: EffortName): Promise<void>;
  abstract setUltracode(on: boolean): Promise<void>;
  protected abstract applyMode(mode: PermissionModeName): Promise<void>;
  protected abstract settle(requestId: string, decision: Decision): void;
  protected abstract refreshContext(): void;

  state(): LiveState {
    return {
      sessionId: this.id,
      cwd: this.cwd,
      title: this.title,
      state: this.closed ? "inactive" : this.kind,
      ...(this.closed ? {} : { host: this.host }),
      busy: this.busy,
      model: this.model,
      permissionMode: this.permissionMode,
      effort: this.effort,
      ...(this.ultracodeAvailable !== undefined ? { ultracode: this.ultracode === true, ultracodeAvailable: this.ultracodeAvailable } : {}),
      ...(this.outputStyle !== undefined ? { outputStyle: this.outputStyle } : {}),
      ...(this.appliedRefused && this.ultracodeAvailable === undefined ? { appliedUnknown: true } : {}),
      ...(this.context ? { context: this.context } : {}),
      costUsd: this.costUsd,
      closedReason: this.closedReason,
      ...(this.tasks.size ? { tasks: [...this.tasks.values()] } : {}),
      ...(this.queue.size ? { queued: [...this.queue.values()] } : {}),
    };
  }

  // Session operations behind the web client's calls; a process type overrides the ones it supports.
  contextDetail(_summary?: boolean): Promise<ContextDetail> {
    return Promise.reject(Error("not available for this session"));
  }

  usage(): Promise<UsageInfo> {
    return Promise.reject(Error("not available for this session"));
  }

  mcpStatus(): Promise<McpServerInfo[]> {
    return Promise.reject(Error("not available for this session"));
  }

  mcpToggle(_server: string, _enabled: boolean): Promise<McpServerInfo[]> {
    return Promise.reject(Error("not available for this session"));
  }

  mcpReconnect(_server: string): Promise<McpServerInfo[]> {
    return Promise.reject(Error("not available for this session"));
  }

  rewind(_userMessageId: string, _dryRun: boolean): Promise<RewindResult> {
    return Promise.reject(Error("not available for this session"));
  }

  stopTask(_taskId: string): Promise<void> {
    return Promise.reject(Error("not available for this session"));
  }

  get outputStyle(): string | undefined {
    return this.settingsStyle ?? this.initStyle;
  }

  async outputStyleInfo(): Promise<OutputStyleInfo> {
    this.ensureOpen();
    this.adoptSettings(await this.readApplied());
    if (!this.outputStyles?.length) throw Error("output styles are not available for this session");
    return { current: this.outputStyle ?? "default", available: this.outputStyles };
  }

  // Saved for the project as VS Code saves it (.claude/settings.local.json); Claude Code applies it from the next turn.
  async setOutputStyle(style: string): Promise<OutputStyleInfo> {
    const { available } = await this.outputStyleInfo();
    if (!available.includes(style)) throw Error("unknown output style");
    await this.writeOutputStyle(style);
    this.settingsStyle = style;
    this.touch();
    return this.outputStyleInfo();
  }

  protected writeOutputStyle(_style: string): Promise<void> {
    return Promise.reject(Error("not available for this session"));
  }

  // Asks the session's Claude Code process for a file, which applies its own read rules; undefined
  // when no process is running.
  readFile(_path: string, _maxBytes: number, _encoding: "utf-8" | "base64"): Promise<FileContents> | undefined {
    return undefined;
  }

  // The web client names servers, messages and tasks; only the ones this session reports are passed on.
  protected async knownServer(name: string): Promise<string> {
    this.ensureOpen();
    if (!name || name.length > NAME_MAX || !(await this.mcpStatus()).some((s) => s.name === name)) throw Error("unknown MCP server");
    return name;
  }

  protected rewindPoint(userMessageId: string, dryRun: boolean): string {
    this.ensureOpen();
    if (!UUID.test(userMessageId) || !this.builder.items.some((i) => i.kind === "user" && i.id === userMessageId)) throw Error("unknown message");
    if (!dryRun && this.busy) throw Error("session is busy");
    return userMessageId;
  }

  protected runningTask(taskId: string): string {
    this.ensureOpen();
    if (this.tasks.get(taskId)?.status !== "running") throw Error("task is not running");
    return taskId;
  }

  // Any count is also the session's gauge and tells the window its model runs with ("window": model, window).
  // The applied model names it: a count taken before the first turn can name another.
  protected counted(detail: ContextDetail): ContextDetail {
    const g = gaugeOf(detail);
    if (g) {
      this.context = g;
      this.emit("window", this.model ?? detail.model, { max: g.max, autoCompactAt: g.autoCompactAt });
    }
    this.emit("state");
    return detail;
  }

  // A message waits below the conversation until Claude Code takes it in, which places it where the model
  // reads it: at the start of a turn, or after a tool result when it arrives mid-turn.
  protected enqueue(id: string, content: unknown, from: QueuedMessage["from"], ts = new Date().toISOString()): void {
    if (this.closed || this.queue.has(id) || this.builder.has(id)) return;
    const { text, attachments } = typedContent(content);
    if (!text && !attachments.length) return;
    this.queue.set(id, { id, ts, text, ...(attachments.length ? { attachments } : {}), from });
    if (this.queue.size > QUEUE_MAX) this.dequeue(this.queue.keys().next().value!);
    this.emit("state");
  }

  protected queueSent(uuid: string, text: string, blocks: ContentBlock[] = []): void {
    this.enqueue(uuid, [...blocks, ...(text ? [{ type: "text", text }] : [])], "remote");
  }

  // Takes back a message sent from here while Claude Code still holds it.
  async unqueue(messageId: string): Promise<void> {
    this.ensureOpen();
    const q = this.queue.get(messageId);
    if (!q) throw Error("message is no longer queued");
    if (q.from !== "remote") throw Error("only a message sent from here can be taken back");
    this.takingBack.add(messageId);
    try {
      if (!(await this.cancelQueued(messageId))) throw Error("message is no longer queued");
    } finally {
      this.takingBack.delete(messageId);
    }
    this.dequeue(messageId);
    this.touch();
  }

  protected cancelQueued(_messageId: string): Promise<boolean> {
    return Promise.reject(Error("not available for this session"));
  }

  private dequeue(id: string): void {
    this.held.delete(id);
    if (this.queue.delete(id)) this.emit("state");
  }

  // A message sent from here that leaves the queue without being taken in, other than by taking it back, stays
  // in the conversation as a note so it is not lost unseen.
  private unsent(id: string): void {
    const q = this.queue.get(id);
    if (q?.from === "remote" && !this.takingBack.has(id)) {
      const item = this.builder.note("unsent", q.text, new Date().toISOString(), `unsent-${id}`, q.attachments?.length);
      if (item) this.emit("item", item);
    }
    this.dequeue(id);
  }

  private deliver(id: string): void {
    const q = this.queue.get(id);
    if (!q) return;
    this.emit("item", this.builder.userText(q.id, q.text, q.ts, q.attachments));
    this.dequeue(id);
  }

  // Claude Code reports each message it is given as queued, then started (taken in) or cancelled. Messages it
  // has confirmed keep its order, ahead of the ones it has not seen yet.
  private onLifecycle(m: Obj): void {
    const id = m.command_uuid;
    const q = typeof id === "string" ? this.queue.get(id) : undefined;
    if (!q) return;
    if (m.state === "queued") {
      const rest = [...this.queue.values()].filter((x) => x.id !== q.id);
      const order = [...rest.filter((x) => this.held.has(x.id)), q, ...rest.filter((x) => !this.held.has(x.id))];
      this.queue.clear();
      for (const x of order) this.queue.set(x.id, x);
      this.held.add(q.id);
      this.emit("state");
    } else if (m.state === "started" || m.state === "completed") this.deliver(q.id);
    else if (UNQUEUED.has(m.state)) this.unsent(q.id);
  }

  async setMode(mode: PermissionModeName): Promise<void> {
    if (!PERMISSION_MODES.includes(mode)) throw Error(`mode ${mode} is not available remotely`);
    this.ensureOpen();
    await this.applyMode(mode);
    this.permissionMode = mode;
    this.touch();
  }

  async answer(requestId: string, answer: Answer): Promise<void> {
    const entry = this.pending.get(requestId);
    if (!entry) throw Error("request is no longer pending");
    if (entry.request.localOnly) throw Error("this request can only be answered where the session is open");
    if (entry.request.kind !== answer?.kind) throw Error("answer does not match the request");
    if (answer.kind === "elicitation") {
      this.settleElicitation(requestId, elicitResult(entry.request.elicitation!, answer.action, answer.content));
      this.unask(requestId);
      this.touch();
      return;
    }
    if (answer.kind === "plan" && !PLAN_DECISIONS.has(answer.decision)) throw Error("invalid answer");
    let decision: Decision;
    if (answer.kind === "permission") {
      decision =
        answer.decision === "deny"
          ? { behavior: "deny", message: answer.message?.trim() || "The user denied this request." }
          : {
              behavior: "allow",
              updatedInput: entry.input,
              ...(answer.decision === "allow_always" && entry.suggestions ? { updatedPermissions: entry.suggestions } : {}),
            };
    } else if (answer.kind === "question") {
      decision = { behavior: "allow", updatedInput: { ...entry.input, answers: answer.answers } };
    } else if (answer.decision === "keep_planning") {
      decision = { behavior: "deny", message: answer.feedback?.trim() || "The user wants to keep planning." };
    } else if (answer.decision === "auto") {
      await this.applyPlanMode();
      decision = { behavior: "allow", updatedInput: entry.input };
    } else {
      decision = {
        behavior: "allow",
        updatedInput: entry.input,
        updatedPermissions: [{ type: "setMode", mode: answer.decision, destination: "session" }],
      };
    }
    if (!this.pending.has(requestId)) throw Error("request is no longer pending");
    this.unask(requestId);
    this.settle(requestId, decision);
    if (answer.kind === "plan" && answer.decision !== "keep_planning" && answer.decision !== "auto") this.permissionMode = answer.decision;
    this.touch();
  }

  // Sends the answer to an MCP server's input request; only a process type that asks for input overrides this.
  protected settleElicitation(_requestId: string, _answer: ElicitAnswer): void {
    throw Error("not available for this session");
  }

  protected ensureOpen(): void {
    if (this.closed) throw Error("session closed");
  }

  protected touch(): void {
    this.lastActivity = Date.now();
    this.emit("state");
  }

  // Approving a plan the way the VS Code extension does: "auto" switches the mode before the answer and
  // falls back to acceptEdits when the classifier is unavailable; the other modes travel with the answer.
  private async applyPlanMode(): Promise<void> {
    try {
      await this.applyMode("auto");
      this.permissionMode = "auto";
    } catch {
      await this.applyMode("acceptEdits");
      this.permissionMode = "acceptEdits";
    }
  }

  protected ask(a: Ask): PendingRequest {
    const kind = a.kind ?? (a.toolName === "AskUserQuestion" ? "question" : a.toolName === "ExitPlanMode" ? "plan" : "permission");
    const request: PendingRequest = {
      id: a.requestId,
      kind,
      toolName: a.toolName,
      title: a.title,
      description: a.description,
      decisionReason: a.decisionReason?.replace(ANSI, ""),
      blockedPath: a.blockedPath,
      input: kind === "plan" ? a.input : (clipInput(a.input) as Record<string, unknown>),
      suggestions: a.suggestions,
      allowAlways: Boolean(a.suggestions?.length) && !a.suppressAlwaysAllowRule,
      ...(a.localOnly && (kind === "permission" || kind === "dialog") ? { localOnly: true } : {}),
      ...(kind === "elicitation" && a.elicitation ? { elicitation: a.elicitation } : {}),
    };
    this.pending.set(request.id, { request, input: a.input, suggestions: a.suggestions });
    this.emit("pending_add", request);
    this.touch();
    return request;
  }

  protected unask(requestId: string): boolean {
    if (!this.pending.delete(requestId)) return false;
    this.emit("pending_remove", requestId);
    return true;
  }

  protected finish(reason: string): void {
    if (this.ended) return;
    for (const id of [...this.queue.keys()]) this.unsent(id);
    this.ended = true;
    this.closed = true;
    this.closedReason = reason;
    this.busy = false;
    for (const id of [...this.pending.keys()]) this.unask(id);
    for (const timer of this.taskTimers.values()) clearTimeout(timer);
    this.taskTimers.clear();
    this.tasks.clear();
    this.queue.clear();
    this.held.clear();
    this.endStream();
    this.emit("closed", reason);
  }

  protected onMessage(m: RawMessage & Record<string, unknown>): void {
    if (m.type === "assistant" || m.type === "user" || m.type === "result" || m.type === "stream_event") this.lastActivity = Date.now();
    if (m.type === "stream_event") {
      if (!m.parent_tool_use_id) this.onStream(m.event as StreamEvent);
      return;
    }
    if (m.type === "command_lifecycle") {
      this.onLifecycle(m);
      return;
    }
    if (m.type === "system") {
      if (m.subtype === "init") {
        this.busy = true;
        if (typeof m.model === "string" && !this.appliedSeen) this.model = m.model;
        if (typeof m.permissionMode === "string") this.permissionMode = m.permissionMode;
        if (typeof m.effort === "string" && !this.appliedSeen) this.effort = m.effort;
        this.adoptStyles(m.output_style);
        this.emit("state");
        this.onInit();
        this.refreshApplied();
        return;
      }
      if (m.subtype === "status") {
        if (typeof m.permissionMode === "string" && m.permissionMode !== this.permissionMode) {
          this.permissionMode = m.permissionMode;
          this.emit("state");
        }
        return;
      }
      if (m.subtype === "session_state_changed") {
        const busy = m.state !== "idle";
        if (busy !== this.busy) {
          this.busy = busy;
          this.emit("state");
        }
        return;
      }
      if (TASK_EVENTS.has(m.subtype ?? "")) this.onTask(m);
    }
    if (m.type === "assistant" && !m.parent_tool_use_id) this.endStream();
    if (m.type === "result") {
      this.busy = false;
      this.localTurn = typeof m.local_command === "string";
      if (typeof m.total_cost_usd === "number") this.costUsd = m.total_cost_usd;
      this.endStream();
      this.refreshContext();
      this.refreshApplied();
      this.emit("state");
    }
    for (const item of this.builder.add(m)) this.emit("item", item);
    if (m.type === "user" && m.isReplay === true && typeof m.uuid === "string") this.dequeue(m.uuid);
  }

  protected onInit(): void {}

  // Claude Code's get_settings answer reduced to `applied`, the effective `outputStyle` and the style names
  // (`outputStyles`); a process type that can ask overrides this.
  protected readApplied(): Promise<Record<string, unknown>> {
    return Promise.reject(Error("not available for this session"));
  }

  // The model, effort and ultracode state the next request runs with, as Claude Code reports them.
  protected refreshApplied(): void {
    if (this.appliedOff || this.closed) return;
    this.readApplied()
      .then((r) => this.adoptSettings(r))
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : "";
        if (/not allowed|not available/.test(message)) this.appliedOff = true;
        if (/request not allowed/.test(message) && !this.appliedRefused) {
          this.appliedRefused = true;
          this.emit("state");
        }
      });
  }

  protected adoptSettings(r: Record<string, unknown>): void {
    const before = this.outputStyle;
    if (Array.isArray(r.outputStyles)) this.adoptStyles(undefined, r.outputStyles);
    if (typeof r.outputStyle === "string" && r.outputStyle) this.settingsStyle = r.outputStyle;
    else if ("applied" in r && !("outputStyle" in r)) this.settingsStyle = undefined;
    if (this.outputStyle !== before) this.emit("state");
    this.adoptApplied(r.applied);
  }

  // The current style and the style names from an init message or an initialize answer.
  protected adoptStyles(current: unknown, names?: unknown): void {
    const before = this.outputStyle;
    if (typeof current === "string" && current && current.length <= NAME_MAX) this.initStyle = current;
    if (Array.isArray(names)) this.outputStyles = names.filter((n): n is string => typeof n === "string" && n !== "" && n.length <= NAME_MAX).slice(0, STYLES_MAX);
    if (this.outputStyle !== before) this.emit("state");
  }

  protected adoptApplied(v: unknown): void {
    if (v === null || typeof v !== "object") return;
    const a = v as Record<string, unknown>;
    const before = [this.model, this.effort, this.ultracode, this.ultracodeAvailable].join("|");
    this.appliedSeen = true;
    if (typeof a.model === "string" && a.model) this.model = a.model;
    if ("effort" in a) this.effort = typeof a.effort === "string" ? a.effort : undefined;
    if (typeof a.ultracode === "boolean") this.ultracode = a.ultracode;
    if (typeof a.ultracodeAvailable === "boolean") this.ultracodeAvailable = a.ultracodeAvailable;
    if (typeof a.model === "string" && typeof a.ultracodeAvailable === "boolean") this.emit("applied", a.model, a.ultracodeAvailable);
    if ([this.model, this.effort, this.ultracode, this.ultracodeAvailable].join("|") !== before) this.emit("state");
  }

  // Changing effort without the ultracode key turns ultracode off, so it goes along while on.
  protected effortSettings(effort: EffortName): { effortLevel: EffortName; ultracode?: true } {
    return { effortLevel: effort, ...(this.ultracode ? { ultracode: true as const } : {}) };
  }

  protected checkUltracode(on: boolean): void {
    if (on && this.ultracodeAvailable === false) throw Error("ultracode is not available for this session");
  }

  // Subagents, shells and workflows as Claude Code reports them. A task_updated carries its changes in
  // `patch`; a task first seen through its progress counts as running. An ended task stays listed a while.
  private onTask(m: Obj): void {
    const id = m.task_id;
    if (typeof id !== "string" || !id || id.length > NAME_MAX || this.ambientTasks.has(id)) return;
    if (m.subtype === "task_started" && m.ambient === true) {
      this.ambientTasks.add(id);
      return;
    }
    const prev = this.tasks.get(id);
    const started = m.subtype === "task_started";
    if (!prev && !started && m.subtype !== "task_progress") return;
    const change = isObj(m.patch) ? m.patch : m;
    const type = clipped(m.subagent_type, NAME_MAX) ?? clipped(m.task_type, NAME_MAX) ?? prev?.type;
    const toolUseId = clipped(m.tool_use_id, NAME_MAX) ?? prev?.toolUseId;
    const next: TaskInfo = {
      id,
      description: clipped(change.description) ?? prev?.description ?? "",
      ...(type ? { type } : {}),
      status: started ? "running" : (TASK_STATUS.get(change.status) ?? prev?.status ?? "running"),
      ...(toolUseId ? { toolUseId } : {}),
    };
    if (JSON.stringify(next) === JSON.stringify(prev)) return;
    this.tasks.set(id, next);
    clearTimeout(this.taskTimers.get(id));
    this.taskTimers.delete(id);
    if (next.status !== "running") {
      const timer = setTimeout(() => {
        this.taskTimers.delete(id);
        if (this.tasks.delete(id)) this.emit("state");
      }, this.taskKeepMs);
      timer.unref();
      this.taskTimers.set(id, timer);
    }
    this.emit("state");
  }

  private onStream(ev: StreamEvent): void {
    if (ev.type === "content_block_start") {
      const t = ev.content_block?.type;
      if (t !== "text" && t !== "thinking") return;
      this.streamText = "";
      this.streamThinking = t === "thinking";
      this.scheduleStream();
    } else if (ev.type === "content_block_delta") {
      const d = ev.delta;
      if (d?.type === "text_delta") this.streamText += d.text ?? "";
      else if (d?.type === "thinking_delta") this.streamText += d.thinking ?? "";
      else return;
      this.scheduleStream();
    }
  }

  private scheduleStream(): void {
    if (this.streamTimer) return;
    this.streamTimer = setTimeout(() => {
      this.streamTimer = undefined;
      this.emit("stream", this.streamText, this.streamThinking);
    }, STREAM_FLUSH_MS);
  }

  protected endStream(): void {
    if (this.streamTimer) clearTimeout(this.streamTimer);
    this.streamTimer = undefined;
    if (this.streamText || this.streamThinking) this.emit("stream", "", false);
    this.streamText = "";
    this.streamThinking = false;
  }
}
