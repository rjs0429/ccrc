import { EventEmitter } from "node:events";
import {
  PERMISSION_MODES,
  type Answer,
  type CommandInfo,
  type ContextDetail,
  type DisplayItem,
  type EffortName,
  type LiveState,
  type McpServerInfo,
  type PendingKind,
  type PendingRequest,
  type PermissionModeName,
  type RewindResult,
  type TaskInfo,
} from "../protocol.ts";
import { ItemBuilder, clipInput, type RawMessage } from "./items.ts";

const STREAM_FLUSH_MS = 80;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export type Decision =
  | { behavior: "allow"; updatedInput: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: "deny"; message: string; interrupt?: boolean };

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
// Events: item, stream, pending_add, pending_remove, state, models, closed.
export abstract class SessionCore extends EventEmitter {
  abstract readonly kind: "owned" | "attached";
  abstract readonly host: string;
  id: string;
  cwd: string;
  title?: string;
  readonly builder: ItemBuilder;
  readonly pending = new Map<string, PendingEntry>();
  readonly tasks = new Map<string, TaskInfo>();
  commands?: CommandInfo[];
  busy = false;
  model?: string;
  permissionMode?: string;
  effort?: string;
  contextPercent?: number;
  costUsd?: number;
  lastActivity = Date.now();
  closed = false;
  closedReason?: string;

  private ended = false;
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
      contextPercent: this.contextPercent,
      costUsd: this.costUsd,
      closedReason: this.closedReason,
      ...(this.tasks.size ? { tasks: [...this.tasks.values()] } : {}),
    };
  }

  // Session operations behind the web client's calls; a process type overrides the ones it supports.
  contextDetail(): Promise<ContextDetail> {
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

  // The item for a message sent from here, before Claude Code echoes it.
  protected sentItem(uuid: string, text: string, blocks: ContentBlock[] = []): DisplayItem {
    const images = blocks.filter((b) => b.type === "image").length;
    const files = blocks.filter((b) => b.type === "document").map((b) => String(b.title ?? ""));
    return this.builder.userText(uuid, text, new Date().toISOString(), images, files.length ? files : undefined);
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
    if (entry.request.kind !== answer.kind) throw Error("answer does not match the request");
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
    this.ended = true;
    this.closed = true;
    this.closedReason = reason;
    this.busy = false;
    for (const id of [...this.pending.keys()]) this.unask(id);
    this.endStream();
    this.emit("closed", reason);
  }

  protected onMessage(m: RawMessage & Record<string, unknown>): void {
    if (m.type === "assistant" || m.type === "user" || m.type === "result" || m.type === "stream_event") this.lastActivity = Date.now();
    if (m.type === "stream_event") {
      if (!m.parent_tool_use_id) this.onStream(m.event as StreamEvent);
      return;
    }
    if (m.type === "system") {
      if (m.subtype === "init") {
        this.busy = true;
        if (typeof m.model === "string") this.model = m.model;
        if (typeof m.permissionMode === "string") this.permissionMode = m.permissionMode;
        if (typeof m.effort === "string") this.effort = m.effort;
        this.emit("state");
        this.onInit();
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
    }
    if (m.type === "assistant" && !m.parent_tool_use_id) this.endStream();
    if (m.type === "result") {
      this.busy = false;
      if (typeof m.total_cost_usd === "number") this.costUsd = m.total_cost_usd;
      this.endStream();
      this.refreshContext();
      this.emit("state");
    }
    for (const item of this.builder.add(m)) this.emit("item", item);
  }

  protected onInit(): void {}

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
