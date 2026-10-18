import { EventEmitter } from "node:events";
import path from "node:path";
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
  type SideAnswer,
  type SideTurn,
  type TaskOutput,
  type UsageInfo,
} from "../protocol.ts";
import { elicitResult } from "../elicit.ts";
import { cleanTitle } from "../titles.ts";
import { gaugeOf } from "./context-gauge.ts";
import type { FileContents } from "./file-read.ts";
import { ItemBuilder, clipInput, typedContent, type RawMessage } from "./items.ts";
import { classify, noteFact, type TurnEnd, type TurnFacts } from "./outcome.ts";
import { TaskBook } from "./tasks.ts";

const STREAM_FLUSH_MS = 80;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_MAX = 200;
const TEXT_MAX = 1000;
const FILES_MAX = 500;
const STYLES_MAX = 100;
const QUEUE_MAX = 100;
// Command lifecycle states that end a queued message without Claude Code taking it in.
const UNQUEUED = new Set<unknown>(["cancelled", "discarded", "refused"]);
// An approved plan continues in the chosen mode, so only modes offered remotely may be named.
const PLAN_DECISIONS = new Set<unknown>(["auto", "acceptEdits", "default", "keep_planning"]);
const FAST_STATES = new Set<unknown>(["off", "on", "cooldown"]);
// Claude Code's notice, on every turn while Fast mode stays on, that the usage credits ran out.
const FAST_CREDITS = "fast-mode-overage-rejected";
// The tasks whose output Claude Code hands out: shells and monitors.
const SHELL_TASKS = new Set<unknown>(["local_bash", "monitor_mcp", "monitor_ws"]);
const OUTPUT_MAX = 64 * 1024;

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
// Claude Code gives itself a few seconds for the git changes of its folder.
export const DIFF_MS = 10_000;
// A side question unanswered this long is cancelled, as VS Code does.
export const SIDE_MS = 5 * 60_000;
// Cancelling a side question waits this long for it to end.
const SIDE_CANCEL_MS = 5000;
const ANSWER_MAX = 100_000;
const NOTICE_MAX = 10_000;
// The budget VS Code turns Thinking on with; a model that thinks adaptively ignores it.
export const THINKING_TOKENS = 31_999;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const clipped = (v: unknown, max = TEXT_MAX): string | undefined => (typeof v === "string" && v ? v.slice(0, max) : undefined);

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
  personOnly?: boolean;
  defaultToNo?: boolean;
  elicitation?: ElicitInfo;
  agentId?: unknown;
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
    ...(typeof o.skippedLinks === "number" && o.skippedLinks > 0 ? { skippedLinks: o.skippedLinks } : {}),
  };
}

// Claude Code's side_question answer: an empty response is no answer.
export function sideAnswer(r: unknown): SideAnswer {
  const o = isObj(r) ? r : {};
  const answer = typeof o.response === "string" && o.response.trim() ? o.response.slice(0, ANSWER_MAX) : null;
  const notice = clipped(isObj(o.refusal_fallback) ? o.refusal_fallback.content : undefined, NOTICE_MAX);
  return { answer, ...(answer && o.synthetic === true ? { synthetic: true } : {}), ...(answer && notice ? { notice } : {}) };
}

// A thread's earlier questions and answers as Claude Code takes them.
export function sideHistory(history: SideTurn[]): Record<string, string>[] {
  return history.map((t) => ({ question: t.question, response: t.answer, ...(t.notice ? { fallback_notice: t.notice } : {}) }));
}

export type SideProgress = { status: "started" | "retry"; attempt?: number; maxRetries?: number; retryInMs?: number };

// A control_request_progress line as the phone hears of it.
export function sideProgress(m: Record<string, unknown>): SideProgress | undefined {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
  if (m.status === "started") return { status: "started" };
  if (m.status !== "api_retry") return undefined;
  const [attempt, maxRetries, retryInMs] = [n(m.attempt), n(m.max_retries), n(m.retry_delay_ms)];
  return { status: "retry", ...(attempt !== undefined ? { attempt } : {}), ...(maxRetries !== undefined ? { maxRetries } : {}), ...(retryInMs !== undefined ? { retryInMs } : {}) };
}

// Claude Code's get_task_output answer.
export function shellOutput(r: unknown): TaskOutput {
  const o = isObj(r) ? r : {};
  return {
    text: typeof o.output === "string" ? o.output.slice(-OUTPUT_MAX) : "",
    totalBytes: typeof o.total_bytes === "number" && o.total_bytes >= 0 ? o.total_bytes : 0,
    truncated: o.truncated === true || (typeof o.output === "string" && o.output.length > OUTPUT_MAX),
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
// Events: item, stream, pending_add, pending_remove, state, models, window, applied (model, ultracodeAvailable), turn_end (TurnEnd), title, cwd, closed,
// request_progress (a control_request_progress line).
export abstract class SessionCore extends EventEmitter {
  abstract readonly kind: "owned" | "attached";
  abstract readonly host: string;
  id: string;
  cwd: string;
  title?: string;
  readonly builder: ItemBuilder;
  readonly pending = new Map<string, PendingEntry>();
  readonly tasks = new TaskBook(() => this.emit("state"));
  // Messages Claude Code holds until it takes them in, and the ones it has said it holds.
  readonly queue = new Map<string, QueuedMessage>();
  private held = new Set<string>();
  private takingBack = new Set<string>();
  commands?: CommandInfo[];
  busy = false;
  model?: string;
  permissionMode?: string;
  effort?: string;
  ultracode?: boolean;
  ultracodeAvailable?: boolean;
  fastMode?: "off" | "on" | "cooldown";
  fastReason?: string;
  fastWanted?: boolean;
  fastCredits?: boolean;
  thinking?: boolean;
  optionsUnknown?: boolean;
  sideUnknown?: boolean;
  sideMs = SIDE_MS;
  outputStyles?: string[];
  context?: ContextGauge;
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
  private fastRefused?: string;
  private streamText = "";
  private streamThinking = false;
  private streamTimer?: NodeJS.Timeout;
  private turnStartedAt?: number;
  private facts: TurnFacts = {};
  // The side question under way, one at a time: the id it was asked with, and who hears of its progress.
  private side?: { ask?: string; ac: AbortController; hear: Set<(p: SideProgress) => void>; done: Promise<SideAnswer> };
  // When VS Code last wrote a message to Claude Code.
  protected hostInputAt?: number;

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
  protected abstract applyFast(on: boolean): Promise<void>;
  protected abstract applyThinking(on: boolean): Promise<void>;
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
      ...this.toggles(),
      ...(this.context ? { context: this.context } : {}),
      costUsd: this.costUsd,
      closedReason: this.closedReason,
      ...(this.tasks.size ? { tasks: this.tasks.values() } : {}),
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

  // Claude Code saves the name and announces it; `title` is already in its form.
  rename(_title: string): Promise<void> {
    return Promise.reject(Error("not available for this session"));
  }

  protected setTitle(title: string): void {
    if (!title || title === this.title) return;
    this.title = title;
    this.emit("state");
    this.emit("title");
  }

  taskOutput(_taskId: string): Promise<TaskOutput> {
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

  // Claude Code's get_workspace_diff answer for the folder it works in, under its own read rules; undefined where the
  // process cannot be asked.
  workspaceDiff(): Promise<Record<string, unknown>> | undefined {
    return undefined;
  }

  // A question beside the conversation, which Claude Code answers from it without interrupting a turn or adding to it.
  // It is cancelled when sideMs passes, when cancelSideQuestion is called or when the session closes. ask: an id to wait
  // for it again by (sideWait).
  async sideQuestion(question: string, history: SideTurn[], onProgress: (p: SideProgress) => void = () => {}, ask?: string): Promise<SideAnswer> {
    this.ensureOpen();
    if (this.side) throw Error("a side question is under way");
    const ac = new AbortController();
    const hear = new Set([onProgress]);
    const done = this.runSide(question, history, ac, hear);
    this.side = { ac, hear, done, ...(ask ? { ask } : {}) };
    return done;
  }

  private async runSide(question: string, history: SideTurn[], ac: AbortController, hear: Set<(p: SideProgress) => void>): Promise<SideAnswer> {
    const timer = setTimeout(() => ac.abort("timeout"), this.sideMs);
    timer.unref();
    const progress = (m: Record<string, unknown>) => {
      const p = sideProgress(m);
      if (p && !ac.signal.aborted) for (const h of hear) h(p);
    };
    try {
      return sideAnswer(await this.askSide(question, history, progress, ac.signal));
    } catch (e) {
      if (ac.signal.aborted) throw Error(ac.signal.reason === "timeout" ? "side question timed out" : this.closed ? "session closed" : "side question cancelled");
      throw e;
    } finally {
      clearTimeout(timer);
      if (this.side?.ac === ac) this.side = undefined;
    }
  }

  sideRunning(ask: string): boolean {
    return this.side?.ask === ask;
  }

  // The side question asked with `ask`, waited for again with its progress; undefined when it is not under way.
  sideWait(ask: string, onProgress: (p: SideProgress) => void = () => {}): Promise<SideAnswer> | undefined {
    const run = this.side;
    if (!run || run.ask !== ask) return undefined;
    run.hear.add(onProgress);
    return run.done.finally(() => run.hear.delete(onProgress));
  }

  // Gives up the side question under way, only the one asked with `ask` where given, and waits a little for it to end.
  async cancelSideQuestion(ask?: string): Promise<void> {
    const run = this.side;
    if (!run || (ask !== undefined && run.ask !== ask)) return;
    run.ac.abort("cancel");
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([run.done.catch(() => {}), new Promise<void>((r) => (timer = setTimeout(r, SIDE_CANCEL_MS)))]);
    clearTimeout(timer);
  }

  protected askSide(_question: string, _history: SideTurn[], _progress: (m: Record<string, unknown>) => void, _signal: AbortSignal): Promise<unknown> {
    return Promise.reject(Error("not available for this session"));
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

  // The latest message the phone says it shows, passed on only when this session holds it.
  protected seenItem(id: unknown): string | undefined {
    return typeof id === "string" && UUID.test(id) && this.builder.items.some((i) => i.id === id || i.id.startsWith(`${id}:`)) ? id : undefined;
  }

  protected runningTask(taskId: string): string {
    this.ensureOpen();
    if (this.tasks.get(taskId)?.status !== "running") throw Error("task is not running");
    return taskId;
  }

  // A listed shell or monitor task, running or ended a while ago.
  protected shellTask(taskId: string): string {
    this.ensureOpen();
    if (!SHELL_TASKS.has(this.tasks.get(taskId)?.kind)) throw Error("not a shell task");
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
              ...(answer.decision === "allow_always" && entry.request.allowAlways && entry.suggestions ? { updatedPermissions: entry.suggestions } : {}),
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
      allowAlways: Boolean(a.suggestions?.length) && !a.suppressAlwaysAllowRule && !a.personOnly,
      ...(a.localOnly && (kind === "permission" || kind === "dialog") ? { localOnly: true } : {}),
      ...(a.personOnly && kind === "permission" ? { personOnly: true } : {}),
      ...(a.defaultToNo && kind === "permission" ? { defaultToNo: true } : {}),
      ...(kind === "elicitation" && a.elicitation ? { elicitation: a.elicitation } : {}),
      ...(typeof a.agentId === "string" && a.agentId && a.agentId.length <= NAME_MAX ? { agentId: a.agentId } : {}),
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
    this.side?.ac.abort("closed");
    for (const id of [...this.pending.keys()]) this.unask(id);
    this.tasks.clear();
    this.queue.clear();
    this.held.clear();
    this.endStream();
    this.emit("closed", reason);
  }

  // Claude Code ended in the middle of a turn without being asked to.
  protected crashed(): void {
    this.emit("turn_end", this.turnEnd({ outcome: "crashed" }));
  }

  private turnEnd(how: Pick<TurnEnd, "outcome" | "reason" | "status" | "resetsAt">, startedAt = this.turnStartedAt ?? Date.now(), queued = false): TurnEnd {
    return {
      ...how,
      startedAt,
      attached: this.kind === "attached",
      ...(this.hostInputAt !== undefined ? { hostInputAt: this.hostInputAt } : {}),
      ...(queued ? { queued: true } : {}),
    };
  }

  // at: when the broker received the message, the time of its items when Claude Code gives the message none.
  protected onMessage(m: RawMessage & Record<string, unknown>, at = new Date().toISOString()): void {
    if (m.type === "assistant" || m.type === "user" || m.type === "result" || m.type === "stream_event") this.lastActivity = Date.now();
    noteFact(this.facts, m);
    if (m.type === "stream_event") {
      if (!m.parent_tool_use_id) this.onStream(m.event as StreamEvent);
      return;
    }
    if (m.type === "command_lifecycle") {
      this.onLifecycle(m);
      return;
    }
    if (m.type === "system") {
      if (m.subtype === "control_request_progress") {
        this.emit("request_progress", m);
        return;
      }
      if (m.subtype === "init") {
        this.busy = true;
        this.turnStartedAt = Date.now();
        this.facts = {};
        if (typeof m.model === "string" && !this.appliedSeen) this.model = m.model;
        if (typeof m.permissionMode === "string") this.permissionMode = m.permissionMode;
        if (typeof m.effort === "string" && !this.appliedSeen) this.effort = m.effort;
        this.adoptStyles(m.output_style);
        this.adoptFast(m.fast_mode_state, m.fast_mode_disabled_reason, true);
        if (typeof m.cwd === "string") this.initCwd(m.cwd, typeof m.original_cwd === "string" ? m.original_cwd : undefined);
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
      // The name a user gave the session, wherever it was given, as Claude Code starts and whenever it changes.
      if (m.subtype === "session_title_changed") {
        if (typeof m.title === "string" && (!m.session_id || m.session_id === this.id)) this.setTitle(cleanTitle(m.title));
        return;
      }
      if (m.subtype === "notification" && m.key === FAST_CREDITS) {
        this.outOfCredits();
        return;
      }
      if (TaskBook.handles(m.subtype)) this.tasks.on(m);
    }
    if (m.type === "assistant" && !m.parent_tool_use_id) this.endStream();
    if (m.type === "result") {
      this.busy = false;
      if (typeof m.total_cost_usd === "number") this.costUsd = m.total_cost_usd;
      this.adoptFast(m.fast_mode_state, m.fast_mode_disabled_reason);
      this.endStream();
      this.refreshContext();
      this.refreshApplied();
      this.emit("state");
      const queued = typeof m.queued_turn_count === "number" && m.queued_turn_count > 0;
      this.emit("turn_end", this.turnEnd(classify(m, this.facts), typeof m.duration_ms === "number" ? Date.now() - m.duration_ms : undefined, queued));
    }
    for (const item of this.builder.add(m, at)) this.emit("item", item);
    if (m.type === "user" && m.isReplay === true && typeof m.uuid === "string") this.dequeue(m.uuid);
  }

  protected onInit(): void {}

  // The folders a turn's init line names: where Claude Code's shell is, and, from Claude Code 2.1.301, the folder it
  // works from. A process type that follows them overrides this.
  protected initCwd(_cwd: string, _original?: string): void {}

  // Where Claude Code works now: a worktree it made or entered, or the folder it went back to.
  moveTo(cwd: string): void {
    if (!path.isAbsolute(cwd) || cwd === this.cwd) return;
    this.cwd = cwd;
    this.builder.setCwd(cwd);
    this.emit("state");
    this.emit("cwd");
  }

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

  // For this session only: Claude Code takes Fast mode from the next turn, and the next report settles it.
  async setFast(on: boolean): Promise<void> {
    this.ensureOpen();
    await this.applyFast(on);
    this.fastWanted = on;
    if (on) this.fastCredits = undefined;
    this.touch();
  }

  async setThinking(on: boolean): Promise<void> {
    this.ensureOpen();
    await this.applyThinking(on);
    this.thinking = on;
    this.touch();
  }

  private toggles(): Partial<LiveState> {
    return {
      ...(this.fastMode ? { fastMode: this.fastMode } : {}),
      ...(this.fastReason ? { fastReason: this.fastReason } : {}),
      ...(this.fastWanted !== undefined ? { fastWanted: this.fastWanted } : {}),
      ...(this.fastCredits ? { fastCredits: true } : {}),
      ...(this.thinking !== undefined ? { thinking: this.thinking } : {}),
      ...(this.optionsUnknown ? { optionsUnknown: true } : {}),
      ...(this.sideUnknown ? { sideUnknown: true } : {}),
    };
  }

  // Fast mode as an initialize answer, a turn's init line or a result reports it. Only the first two settle a change
  // asked for here, whatever they report, as a result may close a turn begun before it. A change that cannot go on is
  // asked off again, so it does not come on by itself later, when it costs more, and noted once the turn is over.
  protected adoptFast(state: unknown, reason: unknown, settles = false): void {
    if (FAST_STATES.has(state)) {
      const before = JSON.stringify(this.toggles());
      this.fastMode = state as "off" | "on" | "cooldown";
      this.fastReason = typeof reason === "string" && reason && reason.length <= NAME_MAX ? reason : undefined;
      if (state === "off") this.fastCredits = undefined;
      const wanted = this.fastWanted;
      if (settles && wanted !== undefined && this.fastReason !== "pending") {
        this.fastWanted = undefined;
        if (wanted && state === "off" && this.fastReason) {
          this.fastRefused = this.fastReason;
          this.applyFast(false).catch(() => {});
        }
      }
      if (JSON.stringify(this.toggles()) !== before) this.emit("state");
    }
    if (this.fastRefused && !this.busy) {
      const item = this.builder.note("fast", this.fastRefused, new Date().toISOString());
      this.fastRefused = undefined;
      if (item) this.emit("item", item);
    }
  }

  private outOfCredits(): void {
    if (this.fastCredits) return;
    this.fastCredits = true;
    const item = this.builder.note("fast", "credits", new Date().toISOString());
    if (item) this.emit("item", item);
    this.emit("state");
    this.creditsOut();
  }

  // What a session does once the usage credits ran out with Fast mode on.
  protected creditsOut(): void {}

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
