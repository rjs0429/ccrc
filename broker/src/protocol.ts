// Messages and shapes shared by the broker and the web client.

export type PermissionModeName = "default" | "acceptEdits" | "plan" | "auto";
export const PERMISSION_MODES: PermissionModeName[] = ["default", "acceptEdits", "plan", "auto"];
export type EffortName = "low" | "medium" | "high" | "xhigh" | "max";

// owned: run by this broker. attached: running in VS Code and reached through the wrapper.
// live: open in another process this broker cannot drive. inactive: no process.
export type SessionState = "owned" | "attached" | "live" | "inactive";

export interface SessionSummary {
  id: string;
  title: string;
  cwd: string;
  branch?: string;
  lastModified: number;
  createdAt?: number;
  state: SessionState;
  // Where the session's process runs ("ccrc", "VS Code", "Terminal", ...).
  host?: string;
  liveStatus?: string;
  busy?: boolean;
  pendingCount?: number;
}

export interface ToolResult {
  text: string;
  isError: boolean;
  truncated: boolean;
}

export type NoteCode = "interrupted" | "compacted" | "command" | "error";

// One hunk of a file change as Claude Code reports it; each line starts with " ", "-" or "+".
export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

// What a subagent started by an Agent/Task tool call has done so far.
export interface SubagentActivity {
  tools: number;
  recent: { name: string; summary: string }[];
  text?: string;
}

// What the user did with a question or plan call (AskUserQuestion, ExitPlanMode). answers, notes and
// previews are keyed by question text; an answer with several choices joins them with ", ". plan: the
// plan as the user edited it before approving.
export type ToolReply =
  | {
      kind: "answered";
      answers: Record<string, string>;
      notes?: Record<string, string>;
      previews?: Record<string, string>;
      response?: string;
      followUp?: boolean;
      timedOut?: boolean;
    }
  | { kind: "unanswered" }
  | { kind: "declined"; reason?: string }
  | { kind: "interrupted" }
  | { kind: "approved"; plan?: string }
  | { kind: "kept_planning"; feedback?: string };

export type DisplayItem =
  // files: names of attached documents.
  | { kind: "user"; id: string; ts?: string; text: string; images?: number; files?: string[] }
  | { kind: "assistant"; id: string; ts?: string; text: string }
  | { kind: "thinking"; id: string; ts?: string; text: string }
  // file and patch: the file a tool changed and how, when Claude Code reports it; patchCut: patch lines
  // left out to keep the item small.
  | {
      kind: "tool";
      id: string;
      ts?: string;
      name: string;
      summary: string;
      input: unknown;
      result?: ToolResult;
      file?: string;
      patch?: Hunk[];
      patchCut?: number;
      sub?: SubagentActivity;
      reply?: ToolReply;
    }
  | { kind: "note"; id: string; ts?: string; code: NoteCode; text?: string }
  // The result of a local command (/usage, /context, ...): its text, and for some the data to draw it from.
  | { kind: "command"; id: string; ts?: string; name?: string; args?: string; text: string; usage?: UsageInfo; context?: ContextDetail };

// A background task of a session (subagent, shell, workflow) as Claude Code reports it.
export interface TaskInfo {
  id: string;
  description: string;
  type?: string;
  status: "running" | "completed" | "failed" | "stopped";
  toolUseId?: string;
}

export interface CommandInfo {
  name: string;
  description: string;
  argumentHint?: string;
}

export interface ContextDetail {
  percentage: number;
  totalTokens: number;
  maxTokens: number;
  model?: string;
  categories: { name: string; tokens: number; kind: string }[];
}

// One of the plan's usage limits. kind: "session", "weekly_all", "weekly_scoped", ...; scope names the model
// or surface a scoped limit is for; severity is Claude's reading of it ("normal", "warning", "critical").
export interface UsageLimit {
  kind: string;
  scope?: string;
  percent: number;
  resetsAt?: string;
  severity?: string;
  active?: boolean;
}

export interface UsageInfo {
  limits: UsageLimit[];
  session?: { costUsd: number; durationMs: number; apiDurationMs: number; linesAdded: number; linesRemoved: number };
}

export interface McpServerInfo {
  name: string;
  status: string;
  error?: string;
  scope?: string;
  tools?: number;
}

export interface RewindResult {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
}

// The session's output style and the styles it can switch to, built-in and custom, as Claude Code lists them.
export interface OutputStyleInfo {
  current: string;
  available: string[];
}

// Requests the web client makes about one session and their answers ("call" / "call_result").
export interface CallMap {
  context: { args: Record<string, never>; data: ContextDetail };
  usage: { args: Record<string, never>; data: UsageInfo };
  mcp_status: { args: Record<string, never>; data: McpServerInfo[] };
  mcp_toggle: { args: { server: string; enabled: boolean }; data: McpServerInfo[] };
  mcp_reconnect: { args: { server: string }; data: McpServerInfo[] };
  rewind: { args: { userMessageId: string; dryRun: boolean }; data: RewindResult };
  stop_task: { args: { taskId: string }; data: Record<string, never> };
  commands: { args: Record<string, never>; data: CommandInfo[] };
  files: { args: { query: string }; data: string[] };
  // Starts the session's Claude Code process here without sending anything.
  resume: { args: Record<string, never>; data: Record<string, never> };
  output_style: { args: Record<string, never>; data: OutputStyleInfo };
  set_output_style: { args: { style: string }; data: OutputStyleInfo };
}
export type CallOp = keyof CallMap;
export const CALL_OPS: CallOp[] = ["context", "usage", "mcp_status", "mcp_toggle", "mcp_reconnect", "rewind", "stop_task", "commands", "files", "resume", "output_style", "set_output_style"];

// A file uploaded for the next message (POST /api/upload).
export interface UploadInfo {
  id: string;
  name: string;
  kind: "image" | "pdf" | "text";
  size: number;
}

export type FileKind = "markdown" | "text" | "json" | "csv" | "tsv" | "image" | "pdf" | "binary";

// A file a link in the conversation points to (GET /api/sessions/:id/file); its bytes are at .../file/raw?path=.
// fallback: found by dropping leading ../ ("parent") or by the end of its path ("suffix").
// via: read by the session's Claude Code process or by ccrc itself.
export interface FileView {
  path: string;
  name: string;
  size: number;
  kind: FileKind;
  text?: string;
  truncated?: boolean;
  fallback?: "parent" | "suffix";
  via: "claude" | "broker";
  line?: number;
  endLine?: number;
  heading?: string;
}

// dialog: a confirmation Claude Code asks for outside a tool call; it can only be answered where the session is open.
// elicitation: input an MCP server asks the user for.
export type PendingKind = "permission" | "question" | "plan" | "dialog" | "elicitation";

export type ElicitFormat = "email" | "uri" | "date" | "date-time";

export interface ElicitOption {
  value: string;
  title: string;
}

// One field of the form an MCP server asks to have filled. choice: one of the options; multi: any number of them.
export type ElicitField = { key: string; title?: string; description?: string; required: boolean } & (
  | { type: "string"; format?: ElicitFormat; minLength?: number; maxLength?: number; default?: string }
  | { type: "number" | "integer"; minimum?: number; maximum?: number; default?: number }
  | { type: "boolean"; default?: boolean }
  | { type: "choice"; options: ElicitOption[]; default?: string }
  | { type: "multi"; options: ElicitOption[]; minItems?: number; maxItems?: number; default?: string[] }
);

export type ElicitValue = string | number | boolean | string[];

// url: a page the user opens and finishes there instead of a form. unsupported: the form has fields the
// phone cannot fill, so it can only be declined or cancelled.
export interface ElicitInfo {
  server: string;
  message: string;
  mode: "form" | "url";
  url?: string;
  title?: string;
  description?: string;
  fields?: ElicitField[];
  unsupported?: boolean;
}

export interface PendingRequest {
  id: string;
  kind: PendingKind;
  toolName: string;
  title?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  input: Record<string, unknown>;
  // Offered by Claude Code for "allow and don't ask again" (for example a session-wide mode switch).
  suggestions?: unknown[];
  allowAlways: boolean;
  // Claude Code allows this answer only where the session is open.
  localOnly?: boolean;
  elicitation?: ElicitInfo;
}

export type Answer =
  | { kind: "permission"; decision: "allow" | "allow_always" | "deny"; message?: string }
  | { kind: "question"; answers: Record<string, string> }
  | { kind: "plan"; decision: "auto" | "acceptEdits" | "default" | "keep_planning"; feedback?: string }
  | { kind: "elicitation"; action: "accept" | "decline" | "cancel"; content?: Record<string, ElicitValue> };

export interface ModelOption {
  value: string;
  resolved?: string;
  label: string;
  description?: string;
  efforts?: EffortName[];
}

export interface LiveState {
  sessionId: string;
  cwd: string;
  title?: string;
  state: SessionState;
  host?: string;
  busy: boolean;
  model?: string;
  permissionMode?: string;
  effort?: string;
  ultracode?: boolean;
  ultracodeAvailable?: boolean;
  outputStyle?: string;
  // The VS Code wrapper is too old to report the applied model, effort and ultracode state.
  appliedUnknown?: boolean;
  contextPercent?: number;
  costUsd?: number;
  closedReason?: string;
  tasks?: TaskInfo[];
}

export type ClientMsg =
  | { t: "take_window" }
  // focus: an item to include, when it lies before the latest items a snapshot holds.
  | { t: "view"; sessionId: string | null; focus?: string }
  // attachments: ids from POST /api/upload, sent before the text as Claude Code content blocks.
  | { t: "send"; sessionId: string; text: string; attachments?: string[] }
  | { t: "new_session"; cwd: string; text: string; model?: string; mode?: PermissionModeName; effort?: EffortName }
  | { t: "answer"; sessionId: string; requestId: string; answer: Answer }
  | { t: "interrupt"; sessionId: string }
  | { t: "set_mode"; sessionId: string; mode: PermissionModeName }
  | { t: "set_model"; sessionId: string; model: string }
  | { t: "set_effort"; sessionId: string; effort: EffortName }
  | { t: "set_ultracode"; sessionId: string; on: boolean }
  | { t: "release"; sessionId: string }
  | { t: "call"; id: number; sessionId: string; op: CallOp; args?: Record<string, unknown> }
  // Whether the page is in front, so the broker knows when to notify instead.
  | { t: "visibility"; visible: boolean }
  | { t: "ping" };

export type ServerMsg =
  | { t: "ready" }
  | { t: "window_conflict" }
  | { t: "window_taken" }
  | { t: "lease_revoked"; reason: string }
  | { t: "snapshot"; sessionId: string; items: DisplayItem[]; pending: PendingRequest[]; state: LiveState; hasMore: boolean }
  | { t: "item"; sessionId: string; item: DisplayItem }
  | { t: "stream"; sessionId: string; text: string; thinking: boolean }
  | { t: "pending_add"; sessionId: string; request: PendingRequest }
  | { t: "pending_remove"; sessionId: string; requestId: string }
  | { t: "state"; sessionId: string; state: LiveState }
  | { t: "session_started"; sessionId: string }
  | { t: "sessions_changed" }
  | { t: "error"; message: string; sessionId?: string }
  | { t: "call_result"; id: number; ok: boolean; data?: unknown; error?: string }
  | { t: "pong" };
