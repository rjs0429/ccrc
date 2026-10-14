import { randomUUID } from "node:crypto";
import type { Link } from "../link/server.ts";
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
} from "./core.ts";
import { fileContents, type FileContents } from "./file-read.ts";
import type { RawMessage } from "./items.ts";
import { contextDetail, usageAnswer } from "./reports.ts";

type Obj = Record<string, unknown>;
type Held = { from: "out" | "in" | "settled"; v: unknown };

// The extension's own MCP server inside Claude Code; the extension leaves it out of its server list too.
const HOST_SERVER = "claude-vscode";

const obj = (v: unknown): Obj => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

// A conversation that runs in VS Code and is reached through the wrapper between VS Code and Claude Code.
// Remote input goes in as the same messages VS Code sends. Permission prompts show on both sides and the
// wrapper keeps whichever answer comes first; dialogs show remotely but only VS Code answers them. MCP input
// requests are not shown: the extension declines them itself as soon as they arrive.
export class WrappedSession extends SessionCore {
  readonly kind = "attached";
  readonly host = "VS Code";
  readonly link: Link;
  private toolUse = new Map<string, string>();
  private backlog: Held[] | null = [];

  constructor(link: Link, id: string, cwd: string, title?: string) {
    super(id, cwd, [], title);
    this.link = link;
    this.lastActivity = 0;
  }

  // Puts the conversation so far in front of what has arrived live, then applies, in arrival order,
  // everything the wrapper reported meanwhile.
  seed(history: DisplayItem[]): void {
    this.builder.merge(history);
    const held = this.backlog ?? [];
    this.backlog = null;
    for (const h of held) {
      if (h.from === "out") this.onOut(h.v as Obj);
      else if (h.from === "in") this.onIn(h.v as Obj);
      else this.onSettled(h.v);
    }
  }

  private hold(from: Held["from"], v: unknown): boolean {
    if (!this.backlog) return false;
    this.backlog.push({ from, v });
    return true;
  }

  onOut(m: Obj): void {
    if (this.hold("out", m)) return;
    if (m.type === "control_request") this.onRequest(m);
    else if (m.type === "control_cancel_request") this.drop(m.request_id);
    else if (m.type === "control_response") this.onResponse(obj(obj(m.response).response));
    else this.onMessage(m as RawMessage & Obj);
  }

  // VS Code's own control requests, for settings it changes without Claude Code reporting them, and the
  // messages written to Claude Code that it has not taken in yet ("remote" marks the ones sent from here).
  onIn(m: Obj): void {
    if (this.hold("in", m)) return;
    if (m.type === "user" && typeof m.uuid === "string") {
      this.enqueue(m.uuid, obj(m.message).content, m.remote === true ? "remote" : "host", str(m.timestamp));
      return;
    }
    if (m.type !== "control_request") return;
    const r = obj(m.request);
    if (r.subtype === "set_model" && typeof r.model === "string" && r.model !== "default") this.model = r.model;
    else if (r.subtype === "set_permission_mode" && typeof r.mode === "string") this.permissionMode = r.mode;
    else if (r.subtype === "apply_flag_settings" && typeof obj(r.settings).effortLevel === "string") this.effort = obj(r.settings).effortLevel as string;
    else return;
    this.emit("state");
  }

  onSettled(requestId: unknown): void {
    if (!this.hold("settled", requestId)) this.drop(requestId);
  }

  end(reason: string): void {
    this.finish(reason);
  }

  send(text: string, blocks: ContentBlock[] = []): void {
    this.ensureOpen();
    const uuid = randomUUID();
    this.link.send({
      t: "to_cli",
      m: {
        type: "user",
        uuid,
        session_id: "",
        parent_tool_use_id: null,
        origin: { kind: "human" },
        message: { role: "user", content: [...blocks, ...(text ? [{ type: "text", text }] : [])] },
      },
    });
    this.queueSent(uuid, text, blocks);
    this.busy = true;
    this.touch();
  }

  async interrupt(): Promise<void> {
    this.ensureOpen();
    await this.link.request({ subtype: "interrupt" });
  }

  async setModel(model: string): Promise<void> {
    this.ensureOpen();
    await this.link.request({ subtype: "set_model", model });
    this.model = model;
    this.touch();
    this.refreshApplied();
  }

  async setEffort(effort: EffortName): Promise<void> {
    this.ensureOpen();
    await this.link.request({ subtype: "apply_flag_settings", settings: this.effortSettings(effort) });
    this.effort = effort;
    this.touch();
    this.refreshApplied();
  }

  async setUltracode(on: boolean): Promise<void> {
    this.ensureOpen();
    this.checkUltracode(on);
    await this.link.request({ subtype: "apply_flag_settings", settings: { ultracode: on ? true : null } });
    this.touch();
    this.refreshApplied();
  }

  async contextDetail(summary = false): Promise<ContextDetail> {
    this.ensureOpen();
    return this.counted(contextDetail(await this.link.request({ subtype: "get_context_usage", detail: summary ? "summary" : "full" }, CONTEXT_MS)));
  }

  readFile(path: string, maxBytes: number, encoding: "utf-8" | "base64"): Promise<FileContents> | undefined {
    if (this.closed) return undefined;
    return this.link.request({ subtype: "read_file", path, max_bytes: maxBytes, encoding }, READ_MS).then(fileContents);
  }

  async usage(): Promise<UsageInfo> {
    this.ensureOpen();
    return usageAnswer(await this.link.request({ subtype: "get_usage", skip_behaviors: true }));
  }

  async mcpStatus(): Promise<McpServerInfo[]> {
    this.ensureOpen();
    const r = await this.link.request({ subtype: "mcp_status" });
    return mcpServers(r.mcpServers).filter((s) => s.name !== HOST_SERVER);
  }

  async mcpToggle(server: string, enabled: boolean): Promise<McpServerInfo[]> {
    const serverName = await this.knownServer(server);
    await this.link.request({ subtype: "mcp_toggle", serverName, enabled: enabled === true }, MCP_CHANGE_MS);
    return this.mcpStatus();
  }

  async mcpReconnect(server: string): Promise<McpServerInfo[]> {
    const serverName = await this.knownServer(server);
    await this.link.request({ subtype: "mcp_reconnect", serverName }, MCP_CHANGE_MS);
    return this.mcpStatus();
  }

  async rewind(userMessageId: string, dryRun: boolean): Promise<RewindResult> {
    const id = this.rewindPoint(userMessageId, dryRun);
    return rewindResult(await this.link.request({ subtype: "rewind_files", user_message_id: id, dry_run: dryRun }));
  }

  async stopTask(taskId: string): Promise<void> {
    await this.link.request({ subtype: "stop_task", task_id: this.runningTask(taskId) });
  }

  protected async cancelQueued(messageId: string): Promise<boolean> {
    return (await this.link.request({ subtype: "cancel_async_message", message_uuid: messageId })).cancelled === true;
  }

  protected async applyMode(mode: PermissionModeName): Promise<void> {
    this.ensureOpen();
    await this.link.request({ subtype: "set_permission_mode", mode });
  }

  protected settle(requestId: string, decision: Decision): void {
    const toolUseID = this.toolUse.get(requestId);
    this.toolUse.delete(requestId);
    this.link.send({
      t: "to_cli",
      m: {
        type: "control_response",
        response: { subtype: "success", request_id: requestId, response: { ...decision, ...(toolUseID ? { toolUseID } : {}) } },
      },
    });
  }

  protected refreshContext(): void {
    this.link
      .request({ subtype: "get_context_usage", detail: "summary" })
      .then((r) => {
        if (typeof r.percentage === "number") this.counted(contextDetail(r));
      })
      .catch(() => {});
  }

  protected readApplied(): Promise<Record<string, unknown>> {
    return this.link.request({ subtype: "get_settings" });
  }

  protected async writeOutputStyle(style: string): Promise<void> {
    this.ensureOpen();
    await this.link.request({ subtype: "update_settings", source: "localSettings", settings: { outputStyle: style } });
  }

  private drop(requestId: unknown): void {
    if (typeof requestId !== "string") return;
    this.toolUse.delete(requestId);
    this.unask(requestId);
  }

  private onRequest(m: Obj): void {
    const id = m.request_id;
    const r = obj(m.request);
    if (typeof id !== "string" || this.pending.has(id)) return;
    if (r.subtype === "request_user_dialog") {
      this.ask({ requestId: id, kind: "dialog", toolName: String(r.dialog_kind ?? ""), input: obj(r.payload), localOnly: true });
      return;
    }
    if (r.subtype !== "can_use_tool") return;
    if (typeof r.tool_use_id === "string") this.toolUse.set(id, r.tool_use_id);
    this.ask({
      requestId: id,
      toolName: String(r.tool_name ?? ""),
      input: obj(r.input),
      suggestions: Array.isArray(r.permission_suggestions) ? r.permission_suggestions : undefined,
      title: str(r.title),
      description: str(r.description),
      decisionReason: str(r.decision_reason),
      blockedPath: str(r.blocked_path),
      suppressAlwaysAllowRule: r.suppress_always_allow_rule === true,
      localOnly: r.requires_user_interaction === true,
    });
  }

  // The answer to VS Code's initialize carries the model, command and output style lists and the current
  // mode; the wrapper passes on the applied part and the output style of VS Code's get_settings answers.
  private onResponse(r: Obj): void {
    if (r.applied) this.adoptSettings(r);
    if (Array.isArray(r.available_output_styles)) this.adoptStyles(r.output_style, r.available_output_styles);
    if (Array.isArray(r.models)) {
      this.emit("models", r.models);
      this.refreshApplied();
    }
    if (Array.isArray(r.commands)) {
      this.commands = commandInfo(r.commands);
      rememberCommands(this.cwd, this.commands);
    }
    if (typeof r.current_permission_mode === "string" && r.current_permission_mode !== this.permissionMode) {
      this.permissionMode = r.current_permission_mode;
      this.emit("state");
    }
  }
}
