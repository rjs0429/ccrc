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

export type NoteCode = "interrupted" | "compacted" | "command" | "command_output" | "error";

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
    }
  | { kind: "note"; id: string; ts?: string; code: NoteCode; text?: string };

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

// Requests the web client makes about one session and their answers ("call" / "call_result").
export interface CallMap {
  context: { args: Record<string, never>; data: ContextDetail };
  mcp_status: { args: Record<string, never>; data: McpServerInfo[] };
  mcp_toggle: { args: { server: string; enabled: boolean }; data: McpServerInfo[] };
  mcp_reconnect: { args: { server: string }; data: McpServerInfo[] };
  rewind: { args: { userMessageId: string; dryRun: boolean }; data: RewindResult };
  stop_task: { args: { taskId: string }; data: Record<string, never> };
  commands: { args: Record<string, never>; data: CommandInfo[] };
  files: { args: { query: string }; data: string[] };
}
export type CallOp = keyof CallMap;
export const CALL_OPS: CallOp[] = ["context", "mcp_status", "mcp_toggle", "mcp_reconnect", "rewind", "stop_task", "commands", "files"];

// A file uploaded for the next message (POST /api/upload).
export interface UploadInfo {
  id: string;
  name: string;
  kind: "image" | "pdf" | "text";
  size: number;
}

// dialog: a confirmation Claude Code asks for outside a tool call; it can only be answered where the session is open.
export type PendingKind = "permission" | "question" | "plan" | "dialog";

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
}

export type Answer =
  | { kind: "permission"; decision: "allow" | "allow_always" | "deny"; message?: string }
  | { kind: "question"; answers: Record<string, string> }
  | { kind: "plan"; decision: "auto" | "acceptEdits" | "default" | "keep_planning"; feedback?: string };

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
  contextPercent?: number;
  costUsd?: number;
  closedReason?: string;
  tasks?: TaskInfo[];
}

export type ClientMsg =
  | { t: "take_window" }
  | { t: "view"; sessionId: string | null }
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
