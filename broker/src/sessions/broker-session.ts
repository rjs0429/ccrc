import { randomUUID } from "node:crypto";
import fs from "node:fs";
import {
  query,
  type CanUseTool,
  type ModelInfo,
  type OnElicitation,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKUserMessage,
  type Settings,
} from "@anthropic-ai/claude-agent-sdk";
import { claudeSettingsFile } from "../claude-settings.ts";
import { elicitInfo } from "../elicit.ts";
import type { ContextDetail, DisplayItem, UsageInfo, EffortName, McpServerInfo, PermissionModeName, RewindResult, TaskOutput, WorktreeChoice } from "../protocol.ts";
import { worktreeOf } from "../worktree-names.ts";
import { rememberCommands } from "./commands.ts";
import {
  CONTEXT_MS,
  ELICIT_MS,
  MCP_CHANGE_MS,
  READ_MS,
  SessionCore,
  THINKING_TOKENS,
  commandInfo,
  mcpServers,
  rewindResult,
  shellOutput,
  type ContentBlock,
  type Decision,
  type ElicitAnswer,
} from "./core.ts";
import type { ContextWindow } from "./context-gauge.ts";
import { sessionEnv } from "./entrypoint.ts";
import { fileContents, type FileContents } from "./file-read.ts";
import type { RawMessage } from "./items.ts";
import type { TurnEnd } from "./outcome.ts";
import { contextDetail, usageAnswer } from "./reports.ts";

const CLOSE_WAIT_MS = 10_000;
const REQUEST_MS = 15_000;
const LATER_WAIT_MS = 20_000;
// A process started for one question still has to start up and sign in.
const PROBE_MS = 45_000;
const STDERR_LINES = 20;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

const setOnly = (env: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));

const inside = (dir: string, top: string) => dir === top || dir.startsWith(`${top}/`);

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
  // Starts with Ultracode asked for, as a flag setting, so the first message waits for nothing.
  ultracode?: boolean;
  // Starts with Fast mode asked for, or with Thinking off.
  fast?: boolean;
  thinking?: boolean;
  // Applied once Claude Code has started, the way a running session changes them.
  later?: { effort?: EffortName; ultracode?: boolean };
  // Starts in a worktree Claude Code makes, or opens again, by this name.
  worktree?: WorktreeChoice;
  // Starts as a copy of session `from`, up to and with row `at`; Claude Code writes the copy once its first input comes.
  fork?: { from: string; at?: string };
  // Laid over the session's environment, for its sign-in; an undefined value leaves the variable out.
  env?: Record<string, string | undefined>;
}

class InputQueue {
  private queue: SDKUserMessage[] = [];
  private wake?: () => void;
  private closed = false;
  private given = 0;
  // Nothing goes out before this settles.
  held: Promise<void> = Promise.resolve();

  push(m: SDKUserMessage): void {
    this.queue.push(m);
    this.wake?.();
  }

  // Takes back a message not yet given to Claude Code.
  remove(uuid: string): boolean {
    const i = this.queue.findIndex((m) => m.uuid === uuid);
    if (i < 0) return false;
    this.queue.splice(i, 1);
    return true;
  }

  // Nothing has gone to Claude Code yet and nothing waits to.
  get untouched(): boolean {
    return !this.given && !this.queue.length;
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *messages(): AsyncGenerator<SDKUserMessage> {
    await this.held;
    for (;;) {
      while (this.queue.length) {
        this.given++;
        yield this.queue.shift()!;
      }
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
  // The Claude Code the process runs, while it runs.
  claudePath?: string;
  // What Claude Code last wrote to stderr, where it says why it could not start.
  private stderrLines: string[] = [];
  private stderrPart = "";
  // Asked to start in a worktree, whose folder a WorktreeCreate hook may choose; the worktree a hook made, and the
  // folder the session worked in before it went into a worktree.
  private worktreeStart = false;
  private hooked?: string;
  private before?: string;

  constructor(id: string, cwd: string, history: DisplayItem[] = [], title?: string) {
    super(id, cwd, history, title);
  }

  start(opts: StartOptions): void {
    this.permissionMode = opts.mode;
    this.effort = opts.effort;
    this.claudePath = opts.claudePath;
    this.worktreeStart = Boolean(opts.worktree);
    if (opts.fast) this.fastWanted = true;
    if (opts.thinking === false) this.thinking = false;
    const flags = {
      ...(opts.ultracode ? { ultracode: true } : {}),
      ...(opts.fast ? { fastMode: true } : {}),
      ...(opts.worktree ? { worktree: { baseRef: opts.worktree.base } } : {}),
    };
    // The first message waits for the settings applied after start, so its turn already runs with them.
    let ready = () => {};
    if (opts.later) this.input.held = timed(new Promise<void>((r) => (ready = r)), LATER_WAIT_MS).catch(() => {});
    this.q = query({
      prompt: this.input.messages(),
      options: {
        cwd: this.cwd,
        ...(opts.fork
          ? { resume: opts.fork.from, forkSession: true, sessionId: this.id, ...(opts.fork.at ? { resumeSessionAt: opts.fork.at } : {}) }
          : opts.resume
            ? { resume: this.id }
            : { sessionId: this.id }),
        pathToClaudeCodeExecutable: opts.claudePath,
        permissionMode: opts.mode,
        model: opts.model,
        effort: opts.effort,
        ...(Object.keys(flags).length ? { settings: flags } : {}),
        ...(opts.thinking === false ? { thinking: { type: "disabled" as const } } : {}),
        settingSources: ["user", "project", "local"],
        systemPrompt: { type: "preset", preset: "claude_code" },
        includePartialMessages: true,
        forwardSubagentText: true,
        // The stop button ends only the turn; background agents and workflows are stopped one by one.
        perTaskStopAffordance: true,
        allowDangerouslySkipPermissions: false,
        enableFileCheckpointing: true,
        extraArgs: { "replay-user-messages": null, ...(opts.worktree ? { worktree: opts.worktree.name } : {}) },
        env: setOnly({ ...sessionEnv(), ...opts.env }),
        canUseTool: this.canUseTool,
        onElicitation: this.onElicitation,
        stderr: (data) => this.noteStderr(data),
      },
    });
    this.done = this.consume(this.q);
    this.q
      .initializationResult()
      .then(async (r) => {
        this.adoptStyles(r.output_style, r.available_output_styles);
        this.adoptFast(r.fast_mode_state, r.fast_mode_disabled_reason, true);
        if (opts.later) await this.applyLater(opts.later).catch(() => {});
        ready();
        if (opts.ultracode || opts.later?.ultracode) await this.confirmUltracode();
        else this.refreshApplied();
        this.refreshContext();
      })
      .catch(() => ready());
  }

  // Resolves once Claude Code has started, or fails with the last line it wrote to stderr.
  async started(ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    let late = false;
    const wait = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        late = true;
        reject(Error("late"));
      }, ms);
    });
    try {
      await Promise.race([this.query().initializationResult(), wait]);
    } catch (e) {
      const said = this.stderrLines.at(-1) ?? (this.stderrPart.trim() || undefined);
      if (late) throw Error(`Claude Code did not start in ${Math.round(ms / 1000)}s${said ? `: ${said}` : ""}`);
      throw said ? Error(`Claude Code could not start: ${said}`) : e;
    } finally {
      clearTimeout(timer);
    }
  }

  private noteStderr(data: string): void {
    const lines = (this.stderrPart + data).replace(ANSI, "").split("\n");
    this.stderrPart = lines.pop() ?? "";
    this.stderrLines.push(...lines.map((l) => l.trim()).filter(Boolean));
    this.stderrLines.splice(0, this.stderrLines.length - STDERR_LINES);
  }

  // The init line's cwd is the shell's, which a cd in Bash moves. The session works from the folder Claude Code works
  // from; without that in the line, it follows the shell only into a worktree, to the worktree's top, and out of one
  // back to where it was.
  protected initCwd(cwd: string, original?: string): void {
    if (original) return this.moveTo(original);
    if (this.worktreeStart && !worktreeOf(cwd) && cwd !== this.cwd) this.hooked = cwd;
    this.worktreeStart = false;
    const at = (dir: string) => worktreeOf(dir)?.path ?? (this.hooked && inside(dir, this.hooked) ? this.hooked : undefined);
    const next = at(cwd);
    const now = at(this.cwd);
    if (next === now) return;
    if (next) {
      if (!now) this.before = this.cwd;
      return this.moveTo(next);
    }
    const home = this.before ?? worktreeOf(this.cwd)?.root;
    if (home && !inside(cwd, home) && !inside(home, cwd)) return;
    this.moveTo(this.before ?? cwd);
    this.before = this.hooked = undefined;
  }

  // Claude Code takes Ultracode only with a model that offers it and workflows on; the conversation says so when it did not.
  private async confirmUltracode(): Promise<void> {
    this.adoptSettings(await this.readApplied().catch(() => ({})));
    if (this.ultracodeAvailable === undefined || this.ultracode === true || this.closed) return;
    const item = this.builder.note("ultracode", undefined, new Date().toISOString());
    if (item) this.emit("item", item);
  }

  // Sends a local command ("/rename x") and resolves once Claude Code has run it.
  async command(text: string, ms: number): Promise<void> {
    let off = () => {};
    try {
      await timed(
        new Promise<void>((resolve, reject) => {
          const ended = (end: TurnEnd) => (end.outcome === "local" ? resolve() : reject(Error(`Claude Code did not run ${text.split(" ")[0]}`)));
          const closed = () => reject(Error("session closed"));
          this.on("turn_end", ended);
          this.on("closed", closed);
          off = () => {
            this.off("turn_end", ended);
            this.off("closed", closed);
          };
          this.send(text);
        }),
        ms,
      );
    } finally {
      off();
    }
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
    this.queueSent(uuid, text, blocks);
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

  protected async applyFast(on: boolean): Promise<void> {
    await timed(this.query().applyFlagSettings({ fastMode: on }), REQUEST_MS);
  }

  protected async applyThinking(on: boolean): Promise<void> {
    await timed(this.query().setMaxThinkingTokens(on ? THINKING_TOKENS : 0), REQUEST_MS);
  }

  // As VS Code does: Claude Code keeps Fast mode on and tells again on every turn.
  protected creditsOut(): void {
    this.setFast(false).catch(() => {});
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

  // In place, as Claude Code's own rewind: the message and all after it leave the conversation, and with `files` the
  // files go back to before it too. Claude Code refuses without a change while the session is not still or a turn came
  // after `lastSeen`, the latest message the phone shows. prefill: the message's text.
  async rewindConversation(userMessageId: string, lastSeen: unknown, files: boolean): Promise<{ prefill: string; files?: RewindResult }> {
    const id = this.rewindPoint(userMessageId, false);
    if (this.pending.size) throw Error("rewind refused: prompt_pending");
    if (this.queue.size) throw Error("rewind refused: commands_queued");
    const seen = this.seenItem(lastSeen);
    const r = (await this.request({ subtype: "rewind_conversation", target_message_uuid: id, ...(seen ? { last_seen_user_message_uuid: seen } : {}) })).response ?? {};
    if (r.rewound !== true) throw Error(`rewind refused: ${typeof r.reason === "string" && /^[a-z_]{1,64}$/.test(r.reason) ? r.reason : "unknown"}`);
    const restored = files
      ? await timed(this.query().rewindFiles(id, { dryRun: false }), REQUEST_MS).then(rewindResult, (e: unknown) => ({ canRewind: false, error: e instanceof Error ? e.message : String(e) }))
      : undefined;
    if (typeof r.targetMessageUuid !== "string" || !this.builder.cut(r.targetMessageUuid)) this.builder.cut(id);
    this.touch();
    this.refreshContext();
    return { prefill: typeof r.prefillText === "string" ? r.prefillText : "", ...(restored ? { files: restored } : {}) };
  }

  async stopTask(taskId: string): Promise<void> {
    await timed(this.query().stopTask(this.runningTask(taskId)), REQUEST_MS);
  }

  // "host": a rename made by the user in the program that runs Claude Code, as VS Code sends it.
  async rename(title: string): Promise<void> {
    await this.request({ subtype: "rename_session", title, source: "host", session_id: this.id });
    this.setTitle(title);
  }

  async taskOutput(taskId: string): Promise<TaskOutput> {
    return shellOutput((await this.request({ subtype: "get_task_output", task_id: this.shellTask(taskId) })).response);
  }

  async background(toolUseId: string): Promise<boolean> {
    return timed(this.query().backgroundTasks(this.foregroundCall(toolUseId)), REQUEST_MS);
  }

  protected async cancelQueued(messageId: string): Promise<boolean> {
    if (this.input.remove(messageId)) {
      if (this.input.untouched) this.busy = false;
      return true;
    }
    return (await this.request({ subtype: "cancel_async_message", message_uuid: messageId })).response?.cancelled === true;
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

  // Reduced to what the wrapper passes on for a VS Code session, and the Thinking the settings start Claude Code with.
  protected async readApplied(): Promise<Record<string, unknown>> {
    const [r, init] = await Promise.all([this.request({ subtype: "get_settings" }), this.query().initializationResult()]);
    const settings = r.response ?? {};
    const style = (settings.effective as Record<string, unknown> | undefined)?.outputStyle;
    return {
      applied: settings.applied,
      ...(typeof style === "string" ? { outputStyle: style } : {}),
      outputStyles: init.available_output_styles,
      thinking: thinkingDefault(settings.effective),
    };
  }

  // Thinking stays as the start or a change here set it.
  protected adoptSettings(r: Record<string, unknown>): void {
    if (this.thinking === undefined && typeof r.thinking === "boolean") {
      this.thinking = r.thinking;
      this.emit("state");
    }
    super.adoptSettings(r);
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
        defaultToNo: opts.defaultToNo,
        agentId: opts.agentID,
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

  // Claude Code ending on its own during a turn is a crash; one ccrc closes is not.
  private async consume(q: Query): Promise<void> {
    try {
      for await (const m of q) this.onMessage(m as unknown as RawMessage & Record<string, unknown>);
    } catch (e) {
      if (!this.closed) {
        const item = this.builder.note("error", e instanceof Error ? e.message : String(e));
        if (item) this.emit("item", item);
      }
    }
    const crashed = !this.closed && this.busy;
    if (crashed) this.crashed();
    this.finish(this.closedReason ?? (crashed ? "crashed" : "ended"));
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

// Whether Claude Code thinks when nothing at the start said: MAX_THINKING_TOKENS (0 is off) over alwaysThinkingEnabled.
export function thinkingDefault(effective: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  const e = isObject(effective) ? effective : {};
  const set = isObject(e.env) && typeof e.env.MAX_THINKING_TOKENS === "string" ? e.env.MAX_THINKING_TOKENS : env.MAX_THINKING_TOKENS;
  const tokens = set === undefined ? NaN : Number.parseInt(set, 10);
  return Number.isFinite(tokens) ? tokens > 0 : e.alwaysThinkingEnabled !== false;
}

// What a probe takes from the user's settings without loading them (and so their hooks or Remote Control): the
// env, which may name where the account's credentials are, and the auto-compact window.
export function probeSettings(file = claudeSettingsFile()): { env: Record<string, string>; settings: Settings } {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  if (!isObject(data)) return { env: {}, settings: {} };
  const env = isObject(data.env) ? Object.fromEntries(Object.entries(data.env).filter((e): e is [string, string] => typeof e[1] === "string")) : {};
  const settings: Settings = {};
  if (typeof data.autoCompactWindow === "number") settings.autoCompactWindow = data.autoCompactWindow;
  if (isObject(data.modelSettings)) {
    const windows = Object.entries(data.modelSettings).flatMap(([m, v]) => (isObject(v) && v.autoCompactWindow !== undefined ? [[m, { autoCompactWindow: v.autoCompactWindow }]] : []));
    if (windows.length) settings.modelSettings = Object.fromEntries(windows) as Settings["modelSettings"];
  }
  return { env, settings };
}

// Asks a Claude Code process started for this question alone: it loads no settings files or MCP servers, writes no
// transcript and never starts a turn.
async function probe<T>(cwd: string, claudePath: string | undefined, model: string | undefined, env: Record<string, string | undefined>, ask: (q: Query) => Promise<T>): Promise<T> {
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  async function* nothing(): AsyncGenerator<SDKUserMessage> {
    await held;
  }
  const user = probeSettings();
  const q = query({
    prompt: nothing(),
    options: {
      cwd,
      pathToClaudeCodeExecutable: claudePath,
      model,
      persistSession: false,
      settingSources: [],
      strictMcpConfig: true,
      env: setOnly({ ...process.env, ...user.env, ...env }),
      ...(Object.keys(user.settings).length ? { settings: user.settings } : {}),
      stderr: () => {},
    },
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
export async function probeUsage(cwd: string, claudePath?: string, env: Record<string, string | undefined> = {}): Promise<UsageInfo> {
  const r = await probe(cwd, claudePath, undefined, env, (q) => (q as unknown as Requester).request({ subtype: "get_usage", skip_behaviors: true }));
  return { limits: usageAnswer(r.response).limits };
}

// The context window of a model and where auto-compact starts, from the default settings.
export async function probeWindow(cwd: string, model: string, claudePath?: string, env: Record<string, string | undefined> = {}): Promise<ContextWindow | undefined> {
  const d = contextDetail(await probe(cwd, claudePath, model, env, (q) => q.getContextUsage({ detail: "summary" })));
  return d.maxTokens > 0 ? { max: d.maxTokens, ...(d.autoCompactAt ? { autoCompactAt: d.autoCompactAt } : {}) } : undefined;
}

// The models Claude Code offers.
export function probeModels(cwd: string, claudePath?: string, env: Record<string, string | undefined> = {}): Promise<ModelInfo[]> {
  return probe(cwd, claudePath, undefined, env, (q) => q.supportedModels());
}
