// How a turn ended, read from its result message and from what Claude Code reported earlier in the same turn.

// local: a local command (/compact, /model x), which runs no model turn. interrupted: the user stopped it.
// crashed: Claude Code ended mid-turn without being asked to, so no result came.
export type TurnOutcome = "done" | "error" | "limit" | "crashed" | "interrupted" | "local";
// Why a turn stopped on an error: the context is full, the login does not hold, the model is unknown, the API failed.
export type ErrorReason = "context" | "login" | "model" | "api";

export interface TurnEnd {
  outcome: TurnOutcome;
  // When the turn started: the result's duration counted back, else when its init arrived.
  startedAt: number;
  // The session runs in VS Code.
  attached: boolean;
  // When VS Code last wrote a message to Claude Code (VS Code sessions).
  hostInputAt?: number;
  // Messages that waited start the next turn right away.
  queued?: boolean;
  reason?: ErrorReason;
  // The API's answer status.
  status?: number;
  // When the usage limit resets, in ms.
  resetsAt?: number;
}

// What a turn reported before its result; cleared when the next turn starts.
export interface TurnFacts {
  rateLimited?: boolean;
  resetsAt?: number;
  apiError?: string;
  interruptNote?: boolean;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const INTERRUPT_NOTE = /^\[Request interrupted by user[^\]]*\]$/;
// Ends the user asked for: stopping the turn, or sending it to the background.
const STOPPED = new Set<unknown>(["aborted_streaming", "aborted_tools", "background_requested"]);
const CONTEXT = new Set<unknown>(["prompt_too_long", "blocking_limit"]);
const LOGIN = new Set<unknown>(["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "verification_required", "cloud_credential_error"]);

function texts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((b) => (isObj(b) && b.type === "text" && typeof b.text === "string" ? [b.text] : []));
}

export function noteFact(f: TurnFacts, m: Obj): void {
  if (m.parent_tool_use_id) return;
  if (m.type === "rate_limit_event") {
    const info = isObj(m.rate_limit_info) ? m.rate_limit_info : {};
    if (info.status !== "rejected") return;
    f.rateLimited = true;
    if (typeof info.resetsAt === "number" && info.resetsAt > 0) f.resetsAt = info.resetsAt * 1000;
  } else if (m.type === "assistant" && typeof m.error === "string" && m.error) {
    f.apiError = m.error;
    if (m.error === "rate_limit") f.rateLimited = true;
  } else if (m.type === "user" && m.isReplay !== true && texts(isObj(m.message) ? m.message.content : undefined).some((t) => INTERRUPT_NOTE.test(t.trim()))) {
    f.interruptNote = true;
  }
}

// The first rule that holds decides. A CLI that reports no terminal_reason is read as stopped by the user when its
// error_during_execution result followed the interrupt note.
export function classify(m: Obj, f: TurnFacts): Pick<TurnEnd, "outcome" | "reason" | "status" | "resetsAt"> {
  if (typeof m.local_command === "string") return { outcome: "local" };
  const terminal = m.terminal_reason;
  if (typeof terminal === "string" ? STOPPED.has(terminal) : m.subtype === "error_during_execution" && f.interruptNote) return { outcome: "interrupted" };
  if (m.is_error !== true) return { outcome: "done" };
  const status = typeof m.api_error_status === "number" ? m.api_error_status : undefined;
  const withStatus = status !== undefined ? { status } : {};
  if (status === 429 || f.rateLimited) return { outcome: "limit", ...withStatus, ...(f.resetsAt ? { resetsAt: f.resetsAt } : {}) };
  const reason: ErrorReason | undefined = CONTEXT.has(terminal)
    ? "context"
    : LOGIN.has(f.apiError) || status === 401 || status === 403
      ? "login"
      : f.apiError === "model_not_found" || status === 404
        ? "model"
        : status !== undefined && status >= 500
          ? "api"
          : undefined;
  return { outcome: "error", ...(reason ? { reason } : {}), ...withStatus };
}
