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

export type DisplayItem =
  | { kind: "user"; id: string; ts?: string; text: string; images?: number }
  | { kind: "assistant"; id: string; ts?: string; text: string }
  | { kind: "thinking"; id: string; ts?: string; text: string }
  | { kind: "tool"; id: string; ts?: string; name: string; summary: string; input: unknown; result?: ToolResult }
  | { kind: "note"; id: string; ts?: string; code: NoteCode; text?: string };

export type PendingKind = "permission" | "question" | "plan";

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
  contextPercent?: number;
  costUsd?: number;
  closedReason?: string;
}

export type ClientMsg =
  | { t: "take_window" }
  | { t: "view"; sessionId: string | null }
  | { t: "send"; sessionId: string; text: string }
  | { t: "new_session"; cwd: string; text: string; model?: string; mode?: PermissionModeName; effort?: EffortName }
  | { t: "answer"; sessionId: string; requestId: string; answer: Answer }
  | { t: "interrupt"; sessionId: string }
  | { t: "set_mode"; sessionId: string; mode: PermissionModeName }
  | { t: "set_model"; sessionId: string; model: string }
  | { t: "set_effort"; sessionId: string; effort: EffortName }
  | { t: "release"; sessionId: string }
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
  | { t: "pong" };
