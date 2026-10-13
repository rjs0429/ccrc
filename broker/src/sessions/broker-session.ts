import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  query,
  type CanUseTool,
  type ModelInfo,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  PERMISSION_MODES,
  type Answer,
  type DisplayItem,
  type EffortName,
  type LiveState,
  type PendingRequest,
  type PermissionModeName,
} from "../protocol.ts";
import { ItemBuilder, clipInput, type RawMessage } from "./items.ts";

const STREAM_FLUSH_MS = 80;
const CLOSE_WAIT_MS = 10_000;

export interface StartOptions {
  resume?: boolean;
  model?: string;
  mode?: PermissionModeName;
  effort?: EffortName;
  claudePath?: string;
}

interface PendingEntry {
  request: PendingRequest;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  resolve: (result: PermissionResult) => void;
}

class InputQueue {
  private queue: SDKUserMessage[] = [];
  private wake?: () => void;
  private closed = false;

  push(m: SDKUserMessage): void {
    this.queue.push(m);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *messages(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (this.queue.length) yield this.queue.shift()!;
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = undefined;
    }
  }
}

interface StreamEvent {
  type: string;
  content_block?: { type: string };
  delta?: { type: string; text?: string; thinking?: string };
}

// One Claude Code process run by the broker through the Agent SDK.
// Events: item, stream, pending_add, pending_remove, state, models, closed.
export class BrokerSession extends EventEmitter {
  readonly id: string;
  readonly cwd: string;
  title?: string;
  readonly builder: ItemBuilder;
  readonly pending = new Map<string, PendingEntry>();
  busy = false;
  model?: string;
  permissionMode?: string;
  effort?: string;
  contextPercent?: number;
  costUsd?: number;
  lastActivity = Date.now();
  closed = false;
  closedReason?: string;

  private input = new InputQueue();
  private q?: Query;
  private done: Promise<void> = Promise.resolve();
  private ended = false;
  private modelsRequested = false;
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

  start(opts: StartOptions): void {
    this.permissionMode = opts.mode;
    this.effort = opts.effort;
    this.q = query({
      prompt: this.input.messages(),
      options: {
        cwd: this.cwd,
        ...(opts.resume ? { resume: this.id } : { sessionId: this.id }),
        pathToClaudeCodeExecutable: opts.claudePath,
        permissionMode: opts.mode,
        model: opts.model,
        effort: opts.effort,
        settingSources: ["user", "project", "local"],
        systemPrompt: { type: "preset", preset: "claude_code" },
        includePartialMessages: true,
        allowDangerouslySkipPermissions: false,
        extraArgs: { "replay-user-messages": null },
        canUseTool: this.canUseTool,
        stderr: () => {},
      },
    });
    this.done = this.consume(this.q);
  }

  state(): LiveState {
    return {
      sessionId: this.id,
      cwd: this.cwd,
      title: this.title,
      owned: !this.closed,
      busy: this.busy,
      model: this.model,
      permissionMode: this.permissionMode,
      effort: this.effort,
      contextPercent: this.contextPercent,
      costUsd: this.costUsd,
      closedReason: this.closedReason,
    };
  }

  send(text: string): void {
    if (this.closed) throw Error("session closed");
    const uuid = randomUUID();
    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
      session_id: this.id,
      uuid,
      origin: { kind: "human" },
    };
    this.emit("item", this.builder.userText(uuid, text, new Date().toISOString()));
    this.input.push(message);
    this.busy = true;
    this.touch();
  }

  async answer(requestId: string, answer: Answer): Promise<void> {
    const entry = this.pending.get(requestId);
    if (!entry) throw Error("request is no longer pending");
    if (entry.request.kind !== answer.kind) throw Error("answer does not match the request");
    let result: PermissionResult;
    if (answer.kind === "permission") {
      result =
        answer.decision === "deny"
          ? { behavior: "deny", message: answer.message?.trim() || "The user denied this request." }
          : {
              behavior: "allow",
              updatedInput: entry.input,
              ...(answer.decision === "allow_always" && entry.suggestions ? { updatedPermissions: entry.suggestions } : {}),
            };
    } else if (answer.kind === "question") {
      result = { behavior: "allow", updatedInput: { ...entry.input, answers: answer.answers } };
    } else if (answer.decision === "keep_planning") {
      result = { behavior: "deny", message: answer.feedback?.trim() || "The user wants to keep planning." };
    } else {
      await this.applyPlanMode(answer.decision);
      result = { behavior: "allow", updatedInput: entry.input };
    }
    if (!this.pending.delete(requestId)) return;
    this.emit("pending_remove", requestId);
    entry.resolve(result);
    this.touch();
  }

  async interrupt(): Promise<void> {
    await this.query().interrupt();
  }

  async setMode(mode: PermissionModeName): Promise<void> {
    if (!PERMISSION_MODES.includes(mode)) throw Error(`mode ${mode} is not available remotely`);
    await this.query().setPermissionMode(mode);
    this.permissionMode = mode;
    this.touch();
  }

  async setModel(model: string): Promise<void> {
    await this.query().setModel(model);
    this.model = model;
    this.touch();
  }

  async setEffort(effort: EffortName): Promise<void> {
    await this.query().applyFlagSettings({ effortLevel: effort });
    this.effort = effort;
    this.touch();
  }

  async close(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closedReason = reason;
    for (const [id, entry] of this.pending) {
      entry.resolve({ behavior: "deny", message: "The session was closed.", interrupt: true });
      this.emit("pending_remove", id);
    }
    this.pending.clear();
    this.input.close();
    this.q?.close();
    await Promise.race([this.done, new Promise((r) => setTimeout(r, CLOSE_WAIT_MS))]);
    this.finish(reason);
  }

  private query(): Query {
    if (!this.q || this.closed) throw Error("session closed");
    return this.q;
  }

  private touch(): void {
    this.lastActivity = Date.now();
    this.emit("state");
  }

  // "auto" needs the classifier to be available; fall back the way the VS Code extension does.
  private async applyPlanMode(mode: "auto" | "acceptEdits" | "default"): Promise<void> {
    try {
      await this.query().setPermissionMode(mode);
      this.permissionMode = mode;
    } catch (e) {
      if (mode !== "auto") throw e;
      await this.query().setPermissionMode("acceptEdits");
      this.permissionMode = "acceptEdits";
    }
  }

  private canUseTool: CanUseTool = (toolName, input, opts) =>
    new Promise<PermissionResult>((resolve, reject) => {
      const kind = toolName === "AskUserQuestion" ? "question" : toolName === "ExitPlanMode" ? "plan" : "permission";
      const shown = kind === "plan" ? input : (clipInput(input) as Record<string, unknown>);
      const request: PendingRequest = {
        id: opts.requestId,
        kind,
        toolName,
        title: opts.title,
        description: opts.description,
        decisionReason: opts.decisionReason,
        blockedPath: opts.blockedPath,
        input: shown,
        suggestions: opts.suggestions,
        allowAlways: Boolean(opts.suggestions?.length) && !opts.suppressAlwaysAllowRule,
      };
      this.pending.set(request.id, { request, input, suggestions: opts.suggestions, resolve });
      this.emit("pending_add", request);
      this.touch();
      opts.signal.addEventListener(
        "abort",
        () => {
          if (this.pending.delete(request.id)) this.emit("pending_remove", request.id);
          reject(Error("aborted"));
        },
        { once: true },
      );
    });

  private async consume(q: Query): Promise<void> {
    try {
      for await (const m of q) this.onMessage(m as unknown as RawMessage & Record<string, unknown>);
    } catch (e) {
      if (!this.closed) {
        const item = this.builder.note("error", e instanceof Error ? e.message : String(e));
        if (item) this.emit("item", item);
      }
    }
    this.finish(this.closedReason ?? "ended");
  }

  private finish(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.closed = true;
    this.closedReason = reason;
    this.busy = false;
    this.endStream();
    this.emit("closed", reason);
  }

  private onMessage(m: RawMessage & Record<string, unknown>): void {
    this.lastActivity = Date.now();
    if (m.type === "stream_event") {
      if (!m.parent_tool_use_id) this.onStream(m.event as StreamEvent);
      return;
    }
    if (m.type === "system" && m.subtype === "init") {
      this.model = m.model as string;
      this.permissionMode = m.permissionMode as string;
      if (typeof m.effort === "string") this.effort = m.effort;
      this.emit("state");
      this.requestModels();
      return;
    }
    if (m.type === "system" && m.subtype === "status") {
      if (typeof m.permissionMode === "string") {
        this.permissionMode = m.permissionMode;
        this.emit("state");
      }
      return;
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

  private endStream(): void {
    if (this.streamTimer) clearTimeout(this.streamTimer);
    this.streamTimer = undefined;
    if (this.streamText || this.streamThinking) this.emit("stream", "", false);
    this.streamText = "";
    this.streamThinking = false;
  }

  private requestModels(): void {
    if (this.modelsRequested || !this.q) return;
    this.modelsRequested = true;
    this.q
      .supportedModels()
      .then((models: ModelInfo[]) => this.emit("models", models))
      .catch(() => {});
  }

  private refreshContext(): void {
    this.q
      ?.getContextUsage()
      .then((u) => {
        this.contextPercent = Math.round(u.percentage);
        this.emit("state");
      })
      .catch(() => {});
  }
}
