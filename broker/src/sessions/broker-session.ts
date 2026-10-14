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
import type { DisplayItem, EffortName, PermissionModeName } from "../protocol.ts";
import { SessionCore, commandInfo, type ContentBlock, type Decision } from "./core.ts";
import type { RawMessage } from "./items.ts";

const CLOSE_WAIT_MS = 10_000;

export interface StartOptions {
  resume?: boolean;
  model?: string;
  mode?: PermissionModeName;
  effort?: EffortName;
  claudePath?: string;
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

// One Claude Code process run by the broker through the Agent SDK.
export class BrokerSession extends SessionCore {
  readonly kind = "owned";
  readonly host = "ccrc";

  private input = new InputQueue();
  private q?: Query;
  private done: Promise<void> = Promise.resolve();
  private modelsRequested = false;
  private resolvers = new Map<string, (result: PermissionResult) => void>();

  constructor(id: string, cwd: string, history: DisplayItem[] = [], title?: string) {
    super(id, cwd, history, title);
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
        enableFileCheckpointing: true,
        extraArgs: { "replay-user-messages": null },
        canUseTool: this.canUseTool,
        stderr: () => {},
      },
    });
    this.done = this.consume(this.q);
  }

  send(text: string, blocks: ContentBlock[] = []): void {
    this.ensureOpen();
    const uuid = randomUUID();
    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: [...blocks, ...(text ? [{ type: "text", text }] : [])] as unknown as SDKUserMessage["message"]["content"] },
      parent_tool_use_id: null,
      session_id: this.id,
      uuid,
      origin: { kind: "human" },
    };
    this.emit("item", this.sentItem(uuid, text, blocks));
    this.input.push(message);
    this.busy = true;
    this.touch();
  }

  async interrupt(): Promise<void> {
    await this.query().interrupt();
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

  // Resolves once the current turn is over and nothing waits for an answer, or after `ms`.
  async idle(ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    while (!this.closed && (this.busy || this.pending.size)) {
      if (Date.now() >= until) return false;
      await new Promise((r) => setTimeout(r, 200));
    }
    return true;
  }

  async close(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closedReason = reason;
    for (const id of [...this.pending.keys()]) {
      this.unask(id);
      this.settle(id, { behavior: "deny", message: "The session was closed.", interrupt: true });
    }
    this.input.close();
    this.q?.close();
    await Promise.race([this.done, new Promise((r) => setTimeout(r, CLOSE_WAIT_MS))]);
    this.finish(reason);
  }

  protected async applyMode(mode: PermissionModeName): Promise<void> {
    await this.query().setPermissionMode(mode);
  }

  protected settle(requestId: string, decision: Decision): void {
    const resolve = this.resolvers.get(requestId);
    this.resolvers.delete(requestId);
    resolve?.(decision as PermissionResult);
  }

  protected refreshContext(): void {
    this.q
      ?.getContextUsage({ detail: "summary" })
      .then((u) => {
        this.contextPercent = Math.round(u.percentage);
        this.emit("state");
      })
      .catch(() => {});
  }

  protected onInit(): void {
    if (this.modelsRequested || !this.q) return;
    this.modelsRequested = true;
    this.q
      .supportedModels()
      .then((models: ModelInfo[]) => this.emit("models", models))
      .catch(() => {});
    this.q
      .initializationResult()
      .then((r) => (this.commands = commandInfo(r.commands)))
      .catch(() => {});
  }

  private query(): Query {
    if (!this.q || this.closed) throw Error("session closed");
    return this.q;
  }

  private canUseTool: CanUseTool = (toolName, input, opts) =>
    new Promise<PermissionResult>((resolve, reject) => {
      this.resolvers.set(opts.requestId, resolve);
      this.ask({
        requestId: opts.requestId,
        toolName,
        input,
        suggestions: opts.suggestions as PermissionUpdate[] | undefined,
        title: opts.title,
        description: opts.description,
        decisionReason: opts.decisionReason,
        blockedPath: opts.blockedPath,
        suppressAlwaysAllowRule: opts.suppressAlwaysAllowRule,
      });
      opts.signal.addEventListener(
        "abort",
        () => {
          this.resolvers.delete(opts.requestId);
          this.unask(opts.requestId);
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
}
