import { randomUUID } from "node:crypto";
import {
  query,
  type CanUseTool,
  type ModelInfo,
  type OnElicitation,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { elicitInfo } from "../elicit.ts";
import type { ContextDetail, DisplayItem, UsageInfo, EffortName, McpServerInfo, PermissionModeName, RewindResult } from "../protocol.ts";
import { rememberCommands } from "./commands.ts";
import {
  CONTEXT_MS,
  MCP_CHANGE_MS,
  READ_MS,
  SessionCore,
  commandInfo,
  mcpServers,
  rewindResult,
  type ContentBlock,
  type Decision,
  type ElicitAnswer,
} from "./core.ts";
import type { ContextWindow } from "./context-gauge.ts";
import { fileContents, type FileContents } from "./file-read.ts";
import type { RawMessage } from "./items.ts";
import { contextDetail, usageAnswer } from "./reports.ts";

const CLOSE_WAIT_MS = 10_000;
const REQUEST_MS = 15_000;
const LATER_WAIT_MS = 20_000;
// A process started for one question still has to start up and sign in.
const PROBE_MS = 45_000;
// An MCP server's input request left unanswered this long is cancelled.
const ELICIT_MS = 15 * 60_000;

type Requester = { request(r: Record<string, unknown>): Promise<{ response?: Record<string, unknown> }> };

// Claude Code's answer, or an error once `ms` pass without one.
function timed<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Error("Claude Code did not answer")), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

export interface StartOptions {
  resume?: boolean;
  model?: string;
  mode?: PermissionModeName;
  effort?: EffortName;
  claudePath?: string;
  // Applied once Claude Code has started, the way a running session changes them.
  later?: { effort?: EffortName; ultracode?: boolean };
}

class InputQueue {
  private queue: SDKUserMessage[] = [];
  private wake?: () => void;
  private closed = false;
  // Nothing goes out before this settles.
  held: Promise<void> = Promise.resolve();

  push(m: SDKUserMessage): void {
    this.queue.push(m);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *messages(): AsyncGenerator<SDKUserMessage> {
    await this.held;
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
  private elicits = new Map<string, (result: ElicitAnswer) => void>();
  elicitMs = ELICIT_MS;

  constructor(id: string, cwd: string, history: DisplayItem[] = [], title?: string) {
    super(id, cwd, history, title);
  }

  start(opts: StartOptions): void {
    this.permissionMode = opts.mode;
    this.effort = opts.effort;
    // The first message waits for the settings applied after start, so its turn already runs with them.
    let ready = () => {};
    if (opts.later) this.input.held = timed(new Promise<void>((r) => (ready = r)), LATER_WAIT_MS).catch(() => {});
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
        forwardSubagentText: true,
        allowDangerouslySkipPermissions: false,
        enableFileCheckpointing: true,
        extraArgs: { "replay-user-messages": null },
        canUseTool: this.canUseTool,
        onElicitation: this.onElicitation,
        stderr: () => {},
      },
    });
    this.done = this.consume(this.q);
    this.q
      .initializationResult()
      .then(async (r) => {
        this.adoptStyles(r.output_style, r.available_output_styles);
        if (opts.later) await this.applyLater(opts.later).catch(() => {});
        ready();
        this.refreshApplied();
        this.refreshContext();
      })
      .catch(() => ready());
  }

  // Ultracode goes on only where the model offers it.
  private async applyLater({ effort, ultracode }: NonNullable<StartOptions["later"]>): Promise<void> {
    if (ultracode) this.adoptSettings(await this.readApplied().catch(() => ({})));
    const on = ultracode === true && this.ultracodeAvailable !== false;
    if (!effort && !on) return;
    await this.query().applyFlagSettings({ ...(effort ? { effortLevel: effort } : {}), ...(on ? { ultracode: true } : {}) });
    if (effort) this.effort = effort;
    this.touch();
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

  // An input request belongs to the turn, so it ends with it.
  async interrupt(): Promise<void> {
    await this.query().interrupt();
    for (const id of [...this.elicits.keys()]) this.endElicitation(id);
  }

  async setModel(model: string): Promise<void> {
    await this.query().setModel(model);
    this.model = model;
    this.touch();
    this.refreshApplied();
  }

  async setEffort(effort: EffortName): Promise<void> {
    await this.query().applyFlagSettings(this.effortSettings(effort));
    this.effort = effort;
    this.touch();
    this.refreshApplied();
  }

  async setUltracode(on: boolean): Promise<void> {
    this.checkUltracode(on);
    await this.query().applyFlagSettings({ ultracode: on ? true : null });
    this.touch();
    this.refreshApplied();
  }

  async contextDetail(summary = false): Promise<ContextDetail> {
    return this.counted(contextDetail(await timed(this.query().getContextUsage({ detail: summary ? "summary" : "full" }), CONTEXT_MS)));
  }

  async usage(): Promise<UsageInfo> {
    return usageAnswer((await this.request({ subtype: "get_usage", skip_behaviors: true })).response);
  }

  async mcpStatus(): Promise<McpServerInfo[]> {
    return mcpServers(await timed(this.query().mcpServerStatus(), REQUEST_MS));
  }

  async mcpToggle(server: string, enabled: boolean): Promise<McpServerInfo[]> {
    const name = await this.knownServer(server);
    await timed(this.query().toggleMcpServer(name, enabled === true), MCP_CHANGE_MS);
    return this.mcpStatus();
  }

  async mcpReconnect(server: string): Promise<McpServerInfo[]> {
    const name = await this.knownServer(server);
    await timed(this.query().reconnectMcpServer(name), MCP_CHANGE_MS);
    return this.mcpStatus();
  }

  async rewind(userMessageId: string, dryRun: boolean): Promise<RewindResult> {
    const id = this.rewindPoint(userMessageId, dryRun);
    return rewindResult(await timed(this.query().rewindFiles(id, { dryRun }), REQUEST_MS));
  }

  async stopTask(taskId: string): Promise<void> {
    await timed(this.query().stopTask(this.runningTask(taskId)), REQUEST_MS);
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
      if (this.elicits.has(id)) {
        this.endElicitation(id);
        continue;
      }
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

  protected settleElicitation(requestId: string, answer: ElicitAnswer): void {
    const resolve = this.elicits.get(requestId);
    if (!resolve) throw Error("request is no longer pending");
    this.elicits.delete(requestId);
    resolve(answer);
  }

  private endElicitation(requestId: string): void {
    this.elicits.get(requestId)?.({ action: "cancel" });
    this.elicits.delete(requestId);
    this.unask(requestId);
  }

  protected refreshContext(): void {
    this.q
      ?.getContextUsage({ detail: "summary" })
      .then((u) => this.counted(contextDetail(u)))
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
      .then((r) => {
        this.commands = commandInfo(r.commands);
        rememberCommands(this.cwd, this.commands);
      })
      .catch(() => {});
  }

  readFile(path: string, maxBytes: number, encoding: "utf-8" | "base64"): Promise<FileContents> | undefined {
    if (this.closed || !this.q) return undefined;
    const q = this.q as unknown as Requester;
    return timed(q.request({ subtype: "read_file", path, max_bytes: maxBytes, encoding }), READ_MS).then((r) => fileContents(r.response));
  }

  // Reduced to what the wrapper passes on for a VS Code session.
  protected async readApplied(): Promise<Record<string, unknown>> {
    const [r, init] = await Promise.all([this.request({ subtype: "get_settings" }), this.query().initializationResult()]);
    const settings = r.response ?? {};
    const style = (settings.effective as Record<string, unknown> | undefined)?.outputStyle;
    return { applied: settings.applied, ...(typeof style === "string" ? { outputStyle: style } : {}), outputStyles: init.available_output_styles };
  }

  protected async writeOutputStyle(style: string): Promise<void> {
    await timed(this.query().updateSettings("localSettings", { outputStyle: style }), REQUEST_MS);
  }

  // A control request the SDK sends but does not declare.
  private request(r: Record<string, unknown>): Promise<{ response?: Record<string, unknown> }> {
    return timed((this.query() as unknown as Requester).request(r), REQUEST_MS);
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

  private onElicitation: OnElicitation = (request, opts) =>
    new Promise((resolve) => {
      const id = opts.requestId;
      const timer = setTimeout(() => this.endElicitation(id), this.elicitMs);
      timer.unref();
      this.elicits.set(id, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
      opts.signal.addEventListener("abort", () => this.endElicitation(id), { once: true });
      const elicitation = elicitInfo(request);
      this.ask({ requestId: id, kind: "elicitation", toolName: elicitation.server, input: {}, elicitation });
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

// Asks a Claude Code process started for this question alone: it loads no settings or MCP servers, writes no
// transcript and never starts a turn.
async function probe<T>(cwd: string, claudePath: string | undefined, model: string | undefined, ask: (q: Query) => Promise<T>): Promise<T> {
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  async function* nothing(): AsyncGenerator<SDKUserMessage> {
    await held;
  }
  const q = query({
    prompt: nothing(),
    options: { cwd, pathToClaudeCodeExecutable: claudePath, model, persistSession: false, settingSources: [], strictMcpConfig: true, stderr: () => {} },
  });
  void (async () => {
    try {
      for await (const _ of q);
    } catch {}
  })();
  try {
    return await timed(ask(q), PROBE_MS);
  } finally {
    release();
    q.close();
  }
}

// The account's plan limits.
export async function probeUsage(cwd: string, claudePath?: string): Promise<UsageInfo> {
  const r = await probe(cwd, claudePath, undefined, (q) => (q as unknown as Requester).request({ subtype: "get_usage", skip_behaviors: true }));
  return { limits: usageAnswer(r.response).limits };
}

// The context window of a model and where auto-compact starts, from the default settings.
export async function probeWindow(cwd: string, model: string, claudePath?: string): Promise<ContextWindow | undefined> {
  const d = contextDetail(await probe(cwd, claudePath, model, (q) => q.getContextUsage({ detail: "summary" })));
  return d.maxTokens > 0 ? { max: d.maxTokens, ...(d.autoCompactAt ? { autoCompactAt: d.autoCompactAt } : {}) } : undefined;
}

// The models Claude Code offers.
export function probeModels(cwd: string, claudePath?: string): Promise<ModelInfo[]> {
  return probe(cwd, claudePath, undefined, (q) => q.supportedModels());
}
