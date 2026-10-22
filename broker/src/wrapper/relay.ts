import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import net from "node:net";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { DIALOG_CHOICES, dialogAnswer } from "../dialogs.ts";
import { LineSplitter, parseLine } from "../link/lines.ts";
import { LINK_VERSION, REMOTE_PREFIX, isPrivateDir, type BrokerFrame, type Hello, type Party, type WrapperFrame } from "../link/protocol.ts";
import { liveProcesses } from "../sessions/live.ts";
import { HOLD_TEXT, envLang, holderKind } from "./hold.ts";
import { sendFilesEnv } from "./send-files.ts";
import type { TurnStore } from "./turns.ts";

const NL = Buffer.from("\n");
const CONTROL = Buffer.from('"control_');
const INIT = Buffer.from('"subtype":"init"');
const STATUS = Buffer.from('"subtype":"status"');
const MODE = Buffer.from('"permissionMode"');
const STATE = Buffer.from('"subtype":"session_state_changed"');
const TASKS = Buffer.from('"subtype":"background_tasks_changed"');
const MODELS = Buffer.from('"models":');
const RESULT = Buffer.from('"type":"result"');
const USER = Buffer.from('"type":"user"');
const APPLIED = Buffer.from('"applied":');
const RATE_LIMITS = Buffer.from('"rate_limits"');
const STYLES = Buffer.from('"available_output_styles"');
const LIFECYCLE = Buffer.from('"command_lifecycle"');
const REPLAY = Buffer.from('"isReplay":true');
const TASK_EVENT = Buffer.from('"subtype":"task_');
const COMMANDS = Buffer.from('"subtype":"commands_changed"');
const CRON = Buffer.from('"CronCreate"');
const WAKEUP = Buffer.from('"ScheduleWakeup"');
// The broker sees the conversation, these requests from Claude Code (can_use_tool, and an elicitation the
// broker took, may be answered remotely), the answer to VS Code's initialize, the applied part of its get_settings answers, and these
// settings changes from VS Code; other control traffic between VS Code and Claude Code stays between them.
const SHOWN = new Set(["can_use_tool", "elicitation", "request_user_dialog"]);
const HOST_SETTINGS = new Set(["set_model", "set_permission_mode", "apply_flag_settings", "set_max_thinking_tokens"]);
// Control requests the broker may send.
const REMOTE_REQUESTS = new Set([
  "interrupt",
  "set_model",
  "set_permission_mode",
  "apply_flag_settings",
  "get_settings",
  "update_settings",
  "get_context_usage",
  "get_usage",
  "mcp_status",
  "mcp_toggle",
  "mcp_reconnect",
  "rewind_files",
  "stop_task",
  "get_task_output",
  "read_file",
  "cancel_async_message",
  "rename_session",
  "set_max_thinking_tokens",
  "background_tasks",
  "get_workspace_diff",
  "side_question",
  "mcp_authenticate",
  "mcp_oauth_callback_url",
]);
// Told to the broker in the hello, so it offers what this wrapper passes on. `ccrc update` compares this list between
// the old and the new version to say when VS Code tabs opened before need the new wrapper.
const CAPS = ["fast_mode", "thinking", "claude_push", "background_tasks", "workspace_diff", "side_question", "usage_causes", "user_dialogs", "mcp_auth", "hand_over", "claim_notice"];
// The id of the hook this wrapper adds to VS Code's initialize and answers itself.
export const PUSH_HOOK = "ccrc_push_notification";
// Broker requests after which VS Code is told to read the applied settings again.
const SETTINGS_CHANGES = new Set(["set_model", "apply_flag_settings"]);
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
// The only parts of a get_settings answer that leave the wrapper: what the next request runs with and the
// output style. The merged settings and their sources carry env values and hooks and stay between VS Code and Claude Code.
const APPLIED_KEYS = ["model", "effort", "ultracode", "ultracodeAvailable"];
const STYLE_NAME_MAX = 200;
const STYLES_MAX = 100;
// The only parts of a get_usage answer that leave the wrapper: the plan's limit windows, the session totals, and what
// the usage went to: the names and shares of its traits, subagents, skills, plugins and MCP servers.
const USAGE_WINDOWS = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_oauth_apps"];
const SESSION_TOTALS = ["total_cost_usd", "total_duration_ms", "total_api_duration_ms", "total_lines_added", "total_lines_removed"];
const CAUSE_LISTS = ["agents", "skills", "plugins", "mcp_servers"];
const TRAIT_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
const CAUSE_NAME_MAX = 200;
const CAUSES_MAX = 50;
const SETTLED_KEEP = 500;
const WAITING_KEEP = 100;
const ASKED_KEEP = 100;
const LINK_BUFFER_MAX = 16 * 1024 * 1024;
const RELEASE_WAIT_MS = 9000;
const NOTICE_MAX = 2000;
// Tools whose jobs live in the Claude Code process that ran them, so ending it would drop them.
const SCHEDULING = new Set<unknown>(["CronCreate", "ScheduleWakeup"]);
// How long an MCP input request waits for the broker to take it before VS Code gets it.
const ELICIT_TAKE_MS = 5000;
const ELICIT_ACTIONS = new Set<unknown>(["accept", "decline", "cancel"]);
const ELICIT_FIELDS_MAX = 50;
const ELICIT_KEY_MAX = 200;
const ELICIT_TEXT_MAX = 10_000;
const ELICIT_ITEMS_MAX = 200;
const ELICIT_ITEM_MAX = 1000;

export interface RelayOptions {
  claudePath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  socketPath: string;
  hostIn: Readable;
  hostOut: Writable;
  log: (msg: string) => void;
  // How long a launch that resumes a session waits for the broker to acknowledge it, and at most in all.
  claimAckMs?: number;
  claimMaxMs?: number;
  retryMs?: number[];
  // VS Code's process. When it goes away mid-turn, as on a window reload, `turns` notes the turn so the
  // next launch of the session can continue it.
  hostPid?: number;
  turns?: TurnStore;
  // Whether another process holds a session, and how long a resuming launch waits for it to let go; which kind of process
  // it is (as live.ts names it), for the notice of a copy started without the broker.
  heldElsewhere?: (sessionId: string) => boolean;
  holderHost?: (sessionId: string) => string | undefined;
  releaseWaitMs?: number;
  elicitTakeMs?: number;
}

export function argValue(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1];
    if (args[i].startsWith(name + "=")) return args[i].slice(name.length + 1);
  }
  return undefined;
}

// The session a launch runs when the arguments say so. Only a plain resume continues an existing
// session in place, so only that waits for the broker to hand it over.
export function launchSession(args: string[]): { sessionId?: string; claim?: string } {
  const explicit = argValue(args, "--session-id");
  if (explicit) return { sessionId: explicit };
  const resume = argValue(args, "--resume");
  if (resume && !args.includes("--fork-session")) return { sessionId: resume, claim: resume };
  return {};
}

// Settings the broker may change for the session: effort, ultracode and fast mode, nothing that persists.
export function allowedFlagSettings(settings: unknown): boolean {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return false;
  const entries = Object.entries(settings);
  return (
    entries.length > 0 &&
    entries.every(([k, v]) => (k === "effortLevel" ? EFFORT_LEVELS.has(v as string) : (k === "ultracode" || k === "fastMode") && (v === true || v === false || v === null)))
  );
}

const THINKING_KEYS = new Set(["subtype", "max_thinking_tokens"]);
const THINKING_MAX = 128_000;

// set_max_thinking_tokens turns Thinking off (0), on with a budget, or back to how the session started (null), nothing else.
export function allowedThinking(req: Record<string, unknown>): boolean {
  const v = req.max_thinking_tokens;
  return Object.keys(req).every((k) => THINKING_KEYS.has(k)) && (v === null || v === 0 || (Number.isSafeInteger(v) && (v as number) >= 1024 && (v as number) <= THINKING_MAX));
}

const UPDATE_KEYS = new Set(["subtype", "source", "settings"]);

// update_settings only sets the output style for the project, to one of the styles Claude Code listed.
export function allowedUpdateSettings(req: Record<string, unknown>, styles: readonly string[] | undefined): boolean {
  const settings = req.settings;
  if (!Object.keys(req).every((k) => UPDATE_KEYS.has(k)) || req.source !== "localSettings") return false;
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return false;
  const keys = Object.keys(settings);
  const style = (settings as Record<string, unknown>).outputStyle;
  return keys.length === 1 && keys[0] === "outputStyle" && typeof style === "string" && Boolean(styles?.includes(style));
}

// The style names of an initialize or reload_output_styles answer.
export function styleNames(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((n): n is string => typeof n === "string" && n !== "" && n.length <= STYLE_NAME_MAX).slice(0, STYLES_MAX);
}

const READ_FILE_KEYS = new Set(["subtype", "path", "max_bytes", "encoding"]);
const READ_FILE_MAX_BYTES = 10_000_000;

// read_file names a file and how much of it to send, nothing else; Claude Code applies its read rules to the path.
export function allowedReadFile(req: Record<string, unknown>): boolean {
  const { path, max_bytes: max, encoding } = req;
  return (
    Object.keys(req).every((k) => READ_FILE_KEYS.has(k)) &&
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= 4096 &&
    !path.includes("\0") &&
    (max === undefined || (Number.isSafeInteger(max) && (max as number) > 0 && (max as number) <= READ_FILE_MAX_BYTES)) &&
    (encoding === undefined || encoding === "utf-8" || encoding === "base64")
  );
}

const RENAME_KEYS = new Set(["subtype", "title", "source", "session_id"]);
const RENAME_TITLE_MAX = 1000;

// rename_session names only the session this process runs now, as a rename the user made ("host").
export function allowedRename(req: Record<string, unknown>, sessionId: string | undefined): boolean {
  const { title } = req;
  return (
    Object.keys(req).every((k) => RENAME_KEYS.has(k)) &&
    typeof title === "string" &&
    title.length > 0 &&
    title.length <= RENAME_TITLE_MAX &&
    req.source === "host" &&
    typeof sessionId === "string" &&
    req.session_id === sessionId
  );
}

const plainObj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function elicitValue(v: unknown): boolean {
  // The broker counts characters, which may take two UTF-16 units each.
  if (typeof v === "string") return v.length <= 2 * ELICIT_TEXT_MAX;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "boolean") return true;
  return Array.isArray(v) && v.length <= ELICIT_ITEMS_MAX && v.every((x) => typeof x === "string" && x.length <= ELICIT_ITEM_MAX);
}

// The answer to an MCP input request: an action, and with accept the filled-in values, nothing else.
export function elicitAnswer(r: unknown): { action: string; content?: Record<string, unknown> } | undefined {
  const a = plainObj(r);
  if (!ELICIT_ACTIONS.has(a.action)) return undefined;
  if (a.content === undefined) return { action: a.action as string };
  const c = a.content;
  if (a.action !== "accept" || typeof c !== "object" || c === null || Array.isArray(c)) return undefined;
  const entries = Object.entries(c);
  if (entries.length > ELICIT_FIELDS_MAX || !entries.every(([k, v]) => k.length <= ELICIT_KEY_MAX && elicitValue(v))) return undefined;
  return { action: "accept", content: Object.fromEntries(entries) };
}

// get_usage asks for the answer with or without the causes of usage, nothing else.
export function allowedUsage(req: Record<string, unknown>): boolean {
  return Object.keys(req).every((k) => k === "subtype" || k === "skip_behaviors") && (req.skip_behaviors === undefined || typeof req.skip_behaviors === "boolean");
}

const MCP_NAME_MAX = 200;
const CALLBACK_URL_MAX = 4096;
const CALLBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const mcpName = (v: unknown): boolean => typeof v === "string" && v.length > 0 && v.length <= MCP_NAME_MAX && !CONTROL_CHARS.test(v);

// mcp_authenticate names a server and nothing else: Claude Code redirects the sign-in to its own page on this machine,
// never to a redirectUri the broker chose.
export function allowedMcpAuthenticate(req: Record<string, unknown>): boolean {
  return Object.keys(req).every((k) => k === "subtype" || k === "serverName") && mcpName(req.serverName);
}

// The address a sign-in ended on, as Claude Code's own redirect page on this machine gets it: an authorization code or
// an error for it.
export function allowedOAuthCallback(url: unknown): url is string {
  if (typeof url !== "string" || url.length > CALLBACK_URL_MAX || CONTROL_CHARS.test(url)) return false;
  try {
    const u = new URL(url);
    return u.protocol === "http:" && CALLBACK_HOSTS.has(u.hostname) && !u.username && !u.password && (u.searchParams.has("code") || u.searchParams.has("error"));
  } catch {
    return false;
  }
}

const CALLBACK_KEYS = new Set(["subtype", "serverName", "callbackUrl"]);

// mcp_oauth_callback_url hands Claude Code the redirect of the sign-in it started for the server, nothing else.
export function allowedMcpCallback(req: Record<string, unknown>): boolean {
  return Object.keys(req).every((k) => CALLBACK_KEYS.has(k)) && mcpName(req.serverName) && allowedOAuthCallback(req.callbackUrl);
}

// An mcp_authenticate answer reduced to the page to open and whether its redirect comes back by hand.
export function mcpAuthAnswer(msg: Record<string, unknown>): Buffer {
  const r = plainObj(msg.response);
  return reply(r, () => {
    const a = plainObj(r.response);
    return {
      ...(typeof a.authUrl === "string" ? { authUrl: a.authUrl } : {}),
      ...(typeof a.requiresUserAction === "boolean" ? { requiresUserAction: a.requiresUserAction } : {}),
      ...(typeof a.callbackExpected === "boolean" ? { callbackExpected: a.callbackExpected } : {}),
    };
  });
}

const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const BACKGROUND_KEYS = new Set(["subtype", "tool_use_id"]);
// The calls that start in the foreground and may be moved to the background: Bash commands and subagents.
const FOREGROUND_KINDS = new Set<unknown>(["local_bash", "local_agent"]);
const ENDED = new Set<unknown>(["completed", "failed", "killed", "stopped"]);
const FOREGROUND_KEEP = 100;

// background_tasks names one call by its tool_use id and nothing else; without an id Claude Code moves every call.
export function allowedBackground(req: Record<string, unknown>): boolean {
  return Object.keys(req).every((k) => BACKGROUND_KEYS.has(k)) && typeof req.tool_use_id === "string" && TOOL_USE_ID.test(req.tool_use_id);
}

// The calls Claude Code runs in the foreground now, task id to tool_use id, as its task events tell VS Code.
export function noteForeground(calls: Map<string, string>, m: Record<string, unknown>): void {
  const id = m.task_id;
  if (m.type !== "system" || typeof id !== "string") return;
  if (m.subtype === "task_started") {
    calls.delete(id);
    if (m.is_backgrounded !== false || m.skip_transcript === true || typeof m.tool_use_id !== "string" || !FOREGROUND_KINDS.has(m.task_type)) return;
    calls.set(id, m.tool_use_id);
    if (calls.size > FOREGROUND_KEEP) calls.delete(calls.keys().next().value!);
  } else if (m.subtype === "task_updated") {
    const patch = plainObj(m.patch);
    if (patch.is_backgrounded === true || ENDED.has(patch.status)) calls.delete(id);
  } else if (m.subtype === "task_notification") calls.delete(id);
}

// get_task_output names one task by its id, nothing else; Claude Code answers only for this session's shells and monitors.
export function allowedTaskOutput(req: Record<string, unknown>): boolean {
  return Object.keys(req).every((k) => k === "subtype" || k === "task_id") && typeof req.task_id === "string" && TASK_ID.test(req.task_id);
}

// VS Code's initialize with one more PostToolUse hook, for PushNotification, which the wrapper answers (pushHookAnswer);
// an initialize of another shape goes on as it is.
export function withPushHook(msg: Record<string, unknown>): Buffer | undefined {
  const req = plainObj(msg.request);
  if (msg.type !== "control_request" || req.subtype !== "initialize") return undefined;
  if (req.hooks !== undefined && (typeof req.hooks !== "object" || req.hooks === null || Array.isArray(req.hooks))) return undefined;
  const hooks = plainObj(req.hooks);
  const post = hooks.PostToolUse ?? [];
  if (!Array.isArray(post)) return undefined;
  const added = { matcher: "PushNotification", hookCallbackIds: [PUSH_HOOK] };
  return Buffer.from(JSON.stringify({ ...msg, request: { ...req, hooks: { ...hooks, PostToolUse: [...post, added] } } }));
}

// The PostToolUse hook's answer for a PushNotification call Claude Code could not push, as ccrc decided it: "sent"
// reads as requested, "watching" as not needed with the user at the session (Claude Code's words for its own terminal),
// anything else as Claude Code made it. Claude Code takes the replacement output only as an object.
export function pushHookAnswer(input: unknown, notice?: string): Record<string, unknown> {
  const i = plainObj(input);
  const out = plainObj(i.tool_response);
  if ((notice !== "sent" && notice !== "watching") || i.tool_name !== "PushNotification" || typeof out.message !== "string" || out.pushSent === true) return {};
  const told = notice === "sent" ? { pushSent: true, localSent: false } : { pushSent: false, localSent: false, disabledReason: "user_present" };
  return { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: { message: out.message, ...told } } };
}

// A notice in the shape Claude Code writes its own, which VS Code adds below the conversation (any level but "info").
export function informational(content: string, sessionId?: string): Buffer {
  return Buffer.from(JSON.stringify({ type: "system", subtype: "informational", level: "warning", content, uuid: randomUUID(), ...(sessionId ? { session_id: sessionId } : {}) }));
}

// The background tasks a background_tasks_changed line lists as running, counted as VS Code counts them: ambient ones
// aside, and a list it cannot read as one.
export function backgroundCount(m: Record<string, unknown>): number {
  if (!Array.isArray(m.tasks)) return 1;
  return m.tasks.filter((t) => t === null || typeof t !== "object" || (t as Record<string, unknown>).ambient !== true).length;
}

// get_workspace_diff takes nothing; Claude Code reads the changes under its own read rules.
export function allowedWorkspaceDiff(req: Record<string, unknown>): boolean {
  return Object.keys(req).every((k) => k === "subtype");
}

const SIDE_KEYS = new Set(["subtype", "question", "history"]);
const TURN_KEYS = new Set(["question", "response", "fallback_notice"]);
const SIDE_TEXT_MAX = 10_000;
const SIDE_ANSWER_MAX = 100_000;
const SIDE_HISTORY_MAX = 20;
// The UTF-8 the texts of a thread may take together, as the broker takes them from the phone.
const SIDE_THREAD_BYTES = 256 * 1024;
const text = (v: unknown, max: number, empty = false): boolean => typeof v === "string" && (empty || v.length > 0) && v.length <= max;
const utf8 = (v: unknown): number => (typeof v === "string" ? Buffer.byteLength(v) : 0);

// side_question carries the question and the earlier questions and answers of its thread, text only.
export function allowedSideQuestion(req: Record<string, unknown>): boolean {
  const h = req.history;
  return (
    Object.keys(req).every((k) => SIDE_KEYS.has(k)) &&
    text(req.question, SIDE_TEXT_MAX) &&
    (h === undefined ||
      (Array.isArray(h) &&
        h.length <= SIDE_HISTORY_MAX &&
        h.every((t) => {
          const o = plainObj(t);
          return (
            t === o &&
            Object.keys(o).every((k) => TURN_KEYS.has(k)) &&
            text(o.question, SIDE_TEXT_MAX) &&
            text(o.response, SIDE_ANSWER_MAX, true) &&
            (o.fallback_notice === undefined || text(o.fallback_notice, SIDE_TEXT_MAX, true))
          );
        }) &&
        h.reduce((n: number, t: Record<string, unknown>) => n + utf8(t.question) + utf8(t.response) + utf8(t.fallback_notice), 0) <= SIDE_THREAD_BYTES))
  );
}

// A user message written to Claude Code, reduced to what the conversation shows of it: its text and the kind
// of each attachment. `remote` marks one the broker sent.
export function waitingCopy(msg: Record<string, unknown>, remote: boolean): Buffer | undefined {
  if (typeof msg.uuid !== "string" || !msg.uuid || msg.isSynthetic === true || typeof msg.parent_tool_use_id === "string") return undefined;
  const content = plainObj(msg.message).content;
  const blocks = (typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : []).flatMap((v): Record<string, unknown>[] => {
    const b = plainObj(v);
    if (b.type === "text" && typeof b.text === "string") return [{ type: "text", text: b.text }];
    if (b.type === "image") return [{ type: "image" }];
    if (b.type === "document") return [{ type: "document", ...(typeof b.title === "string" ? { title: b.title } : {}) }];
    return [];
  });
  if (!blocks.length) return undefined;
  const copy = { type: "user", uuid: msg.uuid, timestamp: new Date().toISOString(), ...(remote ? { remote: true } : {}), message: { role: "user", content: blocks } };
  return Buffer.from(JSON.stringify(copy));
}

function usageWindow(v: unknown, label?: unknown): Record<string, unknown> {
  const w = plainObj(v);
  const out: Record<string, unknown> = {};
  if (typeof label === "string") out.display_name = label;
  if (typeof w.utilization === "number") out.utilization = w.utilization;
  if (typeof w.resets_at === "string") out.resets_at = w.resets_at;
  return out;
}

function reply(r: Record<string, unknown>, response: () => Record<string, unknown>): Buffer {
  const out =
    r.subtype === "success"
      ? { subtype: "success", request_id: r.request_id, response: response() }
      : { subtype: "error", request_id: r.request_id, error: typeof r.error === "string" ? r.error : "request failed" };
  return Buffer.from(JSON.stringify({ type: "control_response", response: out }));
}

// A get_settings answer reduced to the applied model, effort and ultracode state and the effective output
// style, with the style names Claude Code last listed.
export function appliedAnswer(msg: Record<string, unknown>, styles?: readonly string[]): Buffer {
  const r = plainObj(msg.response);
  const answer = plainObj(r.response);
  const a = plainObj(answer.applied);
  const applied: Record<string, unknown> = {};
  for (const k of APPLIED_KEYS) {
    const v = a[k];
    if (typeof v === "string" || typeof v === "boolean" || v === null) applied[k] = v;
  }
  const style = plainObj(answer.effective).outputStyle;
  return reply(r, () => ({
    applied,
    ...(typeof style === "string" && style.length <= STYLE_NAME_MAX ? { outputStyle: style } : {}),
    ...(styles ? { outputStyles: [...styles] } : {}),
  }));
}

const finite = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function causeWindow(v: unknown): Record<string, unknown> {
  const w = plainObj(v);
  const out: Record<string, unknown> = { request_count: finite(w.request_count), session_count: finite(w.session_count) };
  out.behaviors = (Array.isArray(w.behaviors) ? w.behaviors : [])
    .map(plainObj)
    .filter((b) => typeof b.key === "string" && TRAIT_KEY.test(b.key))
    .slice(0, CAUSES_MAX)
    .map((b) => ({ key: b.key, pct: finite(b.pct), count: finite(b.count) }));
  for (const k of CAUSE_LISTS) {
    out[k] = (Array.isArray(w[k]) ? w[k] : [])
      .map(plainObj)
      .filter((x) => typeof x.name === "string" && x.name !== "")
      .slice(0, CAUSES_MAX)
      .map((x) => ({ name: (x.name as string).slice(0, CAUSE_NAME_MAX), pct: finite(x.pct) }));
  }
  return out;
}

// A get_usage answer reduced to the limit windows, the session totals and, when Claude Code gave them, the causes.
export function usageAnswer(msg: Record<string, unknown>): Buffer {
  const r = plainObj(msg.response);
  return reply(r, () => {
    const a = plainObj(r.response);
    const limits = plainObj(a.rate_limits);
    const session = plainObj(a.session);
    const windows: Record<string, unknown> = {};
    for (const k of USAGE_WINDOWS) if (plainObj(limits[k]).utilization !== undefined) windows[k] = usageWindow(limits[k]);
    if (Array.isArray(limits.model_scoped)) windows.model_scoped = limits.model_scoped.map((m) => usageWindow(m, plainObj(m).display_name));
    const totals: Record<string, unknown> = {};
    for (const k of SESSION_TOTALS) if (typeof session[k] === "number") totals[k] = session[k];
    const b = a.behaviors;
    const causes = typeof b === "object" && b !== null && !Array.isArray(b) ? { behaviors: { day: causeWindow(plainObj(b).day), week: causeWindow(plainObj(b).week) } } : {};
    return { session: totals, rate_limits: windows, ...causes };
  });
}

class Gate {
  readonly opened: Promise<void>;
  isOpen = false;
  private release!: () => void;
  private timer?: NodeJS.Timeout;
  private deadline: number;

  constructor(ms: number, maxMs: number) {
    this.opened = new Promise((resolve) => (this.release = resolve));
    this.deadline = Date.now() + maxMs;
    this.wait(ms);
  }

  wait(ms: number): void {
    if (this.isOpen) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.open(), Math.max(0, Math.min(ms, this.deadline - Date.now())));
  }

  open(): void {
    clearTimeout(this.timer);
    this.isOpen = true;
    this.release();
  }
}

function ask(set: Set<string>, id: string): void {
  set.add(id);
  if (set.size > ASKED_KEEP) set.delete(set.values().next().value!);
}

function askFor<T>(map: Map<string, T>, id: string, value: T): void {
  map.set(id, value);
  if (map.size > ASKED_KEEP) map.delete(map.keys().next().value!);
}

// Sits between VS Code (hostIn/hostOut) and the Claude Code process it asked for. Every line passes
// through unchanged and a copy goes to the broker, which may add user messages, its own control
// requests and answers to open permission prompts. Whichever side answers a prompt first wins.
// An MCP input request, which VS Code declines unseen, waits for the broker instead while one is connected;
// it reaches VS Code when the broker passes it, does not take it in time, or goes away.
// Without a broker the relay keeps working and reconnects in the background.
// Emits "exit" (code, signal) once Claude Code has ended and its output has been passed on.
export class Relay extends EventEmitter {
  private o: RelayOptions;
  private child?: ChildProcess;
  private queued: Buffer[] = [];
  private hostEnded = false;
  private hostGone = false;
  private open = new Map<string, { subtype: string; line: Buffer; kind?: string }>();
  private held = new Map<string, { line: Buffer; taken: boolean; timer?: NodeJS.Timeout }>();
  private settled = new Map<string, Party>();
  // Requests whose answers go on reduced: VS Code's get_settings to the broker as well, the broker's
  // get_settings and get_usage only to it.
  private hostAsked = new Set<string>();
  private remoteAsked = new Map<string, string>();
  // The broker's Thinking changes Claude Code has not answered yet; one it takes is kept like VS Code's own.
  private thinkingAsked = new Map<string, Buffer>();
  // The broker's side questions Claude Code has not answered yet, which only the broker may cancel.
  private sideAsked = new Set<string>();
  // The output styles Claude Code last listed, which the broker may switch the project to.
  private styles?: string[];
  private state = new Map<string, { seq: number; t: "out" | "in"; line: Buffer }>();
  // User messages written to Claude Code that it has not taken in yet, as copies for the broker.
  private waiting = new Map<string, { line: Buffer; remote: boolean }>();
  // The calls running in the foreground, which the broker may move to the background.
  private foreground = new Map<string, string>();
  private seq = 0;
  private sessionId?: string;
  private claim?: string;
  private gate?: Gate;
  private fork = false;
  private claimSettled = false;
  private running = false;
  private hostLeft = false;
  private warnedDir = false;
  private link?: net.Socket;
  private retry = 0;
  private retryTimer?: NodeJS.Timeout;
  private finished = false;
  private childPaused = false;
  private hostPaused = false;
  private hostReady = false;
  private cliStatus: string | null = null;
  // The broker sends Claude's notifications to a device, but not while the remote user has the session in front of them.
  private claudePush = false;
  private watching = false;
  // What VS Code is told once Claude Code has answered its initialize: why the session opened as it did. A copy the
  // broker named is renamed once VS Code's initialize has reached Claude Code, which writes the name with the copy's
  // first message.
  private notice?: string;
  private copyName?: string;
  private initialized = false;
  // What a hand-over would cut short besides a turn, a request or a message: background tasks, and jobs Claude scheduled.
  private backgroundTasks = 0;
  private scheduled = false;

  constructor(o: RelayOptions) {
    super();
    this.o = o;
    const launch = launchSession(o.args);
    this.sessionId = launch.sessionId;
    this.claim = launch.claim;
  }

  async start(): Promise<void> {
    const split = new LineSplitter((line) => this.fromHost(line));
    this.o.hostIn.on("data", (chunk: Buffer) => split.push(chunk));
    this.o.hostIn.on("end", () => {
      this.o.log("VS Code closed its input");
      this.leave();
      split.end();
      this.hostEnded = true;
      this.child?.stdin?.end();
    });
    this.o.hostOut.on("error", () => {
      if (!this.hostGone) this.o.log("VS Code stopped reading");
      this.hostGone = true;
    });
    if (this.claim) this.gate = new Gate(this.o.claimAckMs ?? 3000, this.o.claimMaxMs ?? 45_000);
    this.connect();
    let env = { ...this.o.env, ...sendFilesEnv(this.o.env) };
    this.o.log(`files sent to the user go by path: ${env.CLAUDE_CODE_ATTACHMENTS_BY_PATH ?? "off"}`);
    if (this.gate) {
      const t0 = Date.now();
      await this.gate.opened;
      this.o.log(`claim ${this.claim} took ${Date.now() - t0}ms`);
      if (!this.claimSettled) await this.awaitRelease(this.claim!);
      const extra = this.fork || this.finished || !this.o.hostPid ? undefined : await this.continueEnv(this.claim!, this.o.hostPid);
      if (extra) {
        this.o.log("continuing the turn VS Code left unfinished");
        env = { ...env, ...extra };
      }
    }
    this.spawnChild(env);
  }

  // Forwards a termination signal; before Claude Code has started the relay just ends.
  signal(sig: NodeJS.Signals): void {
    this.leave();
    if (this.child) this.child.kill(sig);
    else this.finish(null, sig);
  }

  private leave(): void {
    if (this.hostLeft) return;
    this.hostLeft = true;
    if (!this.running || !this.sessionId || !this.o.hostPid || !this.o.turns) return;
    try {
      this.o.turns.cut(this.sessionId, this.o.hostPid);
      this.o.log("VS Code left during a turn");
    } catch (e) {
      this.o.log(`cannot note the unfinished turn: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // A note that cannot be read or updated continues nothing, and Claude Code starts all the same.
  private async continueEnv(sessionId: string, hostPid: number): Promise<Record<string, string> | undefined> {
    try {
      return await this.o.turns?.continueEnv(sessionId, hostPid);
    } catch (e) {
      this.o.log(`cannot use the note of an unfinished turn: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  }

  // Only the broker's go-ahead says the session's previous process is gone. Without it the launch waits for
  // that process itself, and starts on a copy if it does not let go, so two processes never share a session.
  private async awaitRelease(sessionId: string): Promise<void> {
    const held = this.o.heldElsewhere ?? ((id: string) => liveProcesses({ fresh: true }).some((l) => l.sessionId === id));
    if (this.finished || !held(sessionId)) return;
    this.o.log(`session ${sessionId} is still open in another process; waiting for it`);
    const until = Date.now() + (this.o.releaseWaitMs ?? RELEASE_WAIT_MS);
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 250));
      if (this.finished || !held(sessionId)) return;
    }
    this.fork = true;
    this.sessionId = undefined;
    const host = this.o.holderHost ? this.o.holderHost(sessionId) : this.o.heldElsewhere ? undefined : liveProcesses({ fresh: true }).find((l) => l.sessionId === sessionId)?.host;
    const words = HOLD_TEXT[envLang(this.o.env)];
    this.notice = words.copy(words.holder[holderKind(host)], false);
  }

  private spawnChild(env: NodeJS.ProcessEnv): void {
    if (this.finished) return;
    const args = this.fork && !this.o.args.includes("--fork-session") ? [...this.o.args, "--fork-session"] : this.o.args;
    if (this.fork) this.o.log(`session ${this.claim} is held by another process; starting a copy of it`);
    const child = spawn(this.o.claudePath, args, { cwd: this.o.cwd, env, stdio: ["pipe", "pipe", "inherit"] });
    this.child = child;
    child.stdin!.on("error", () => {});
    child.on("error", (e) => {
      this.o.log(`cannot start claude: ${e.message}`);
      process.stderr.write(`ccrc-wrapper: cannot start ${this.o.claudePath}: ${e.message}\n`);
      this.finish(127, null);
    });
    const split = new LineSplitter((line) => this.fromChild(line));
    child.stdout!.on("data", (chunk: Buffer) => split.push(chunk));
    child.stdout!.on("end", () => split.end());
    child.on("close", (code, signal) => this.finish(code, signal));
    child.stdin!.on("drain", () => {
      if (this.hostPaused) {
        this.hostPaused = false;
        this.o.hostIn.resume();
      }
    });
    if (child.pid) {
      this.o.log(`spawned claude pid=${child.pid}`);
      this.send({ t: "spawned", cpid: child.pid });
    }
    for (const line of this.queued.splice(0)) this.toChild(line);
    this.nameCopy();
    if (this.hostEnded) child.stdin!.end();
  }

  private nameCopy(): void {
    if (!this.copyName || !this.initialized) return;
    const title = this.copyName;
    this.copyName = undefined;
    this.o.log("naming the copy as the broker said");
    this.toChild(Buffer.from(JSON.stringify({ type: "control_request", request_id: `${REMOTE_PREFIX}${randomUUID()}`, request: { subtype: "rename_session", title, source: "host" } })));
  }

  // Ends Claude Code so the session can move to another tab, only while nothing here would be cut short. VS Code shows
  // the notice first and then sees Claude Code end as when it closes a tab: input closed, exit code 0, no error.
  private handOver(id: unknown, notice: unknown): void {
    if (typeof id !== "string") return;
    const busy = this.busyWith();
    if (busy) {
      this.o.log(`not handing the session over: ${busy}`);
      return this.send({ t: "rejected", id, reason: busy });
    }
    if (typeof notice === "string" && notice && notice.length <= NOTICE_MAX) this.toHost(informational(notice, this.sessionId));
    this.o.log("handing the session over to another tab: closing Claude Code's input");
    this.child!.stdin!.end();
    this.send({ t: "handed_over", id });
  }

  private busyWith(): string | undefined {
    if (!this.child?.stdin?.writable || this.finished || this.hostEnded) return "closed";
    if (this.running) return "turn running";
    if (this.open.size || this.held.size) return "request open";
    if (this.waiting.size) return "message waiting";
    if (this.foreground.size) return "call running";
    if (this.backgroundTasks) return "background task running";
    if (this.scheduled) return "job scheduled";
    return undefined;
  }

  private fromHost(line: Buffer): void {
    const user = line.includes(USER);
    const msg = user || line.includes(CONTROL) ? parseLine(line) : undefined;
    if (user && msg?.type === "user") {
      const copy = waitingCopy(msg, false);
      if (copy) {
        this.wait(msg.uuid as string, copy, false);
        this.copy("in", copy);
      }
    } else if (msg) {
      if (msg.type === "control_response") {
        const id = (msg.response as Record<string, unknown> | undefined)?.request_id;
        if (typeof id === "string") {
          const by = this.settled.get(id);
          if (by) {
            this.send({ t: "dropped", id, from: "host", by });
            return;
          }
          if (this.open.delete(id)) this.settle(id, "host");
        }
      }
      const subtype = msg?.type === "control_request" ? (msg.request as Record<string, unknown> | undefined)?.subtype : undefined;
      if (subtype === "get_settings" && typeof msg?.request_id === "string") ask(this.hostAsked, msg.request_id);
      else if (typeof subtype === "string" && HOST_SETTINGS.has(subtype)) {
        this.remember(`in:${subtype}`, "in", line);
        this.copy("in", line);
      } else if (subtype === "initialize") {
        this.toChild(withPushHook(msg) ?? line);
        this.initialized = true;
        this.nameCopy();
        return;
      }
    }
    this.toChild(line);
  }

  private fromChild(line: Buffer): void {
    let msg: Record<string, unknown> | undefined;
    let shared = true;
    let held = false;
    let withdrawn = false;
    if (line.includes(CONTROL)) {
      msg = parseLine(line);
      const id = msg?.type === "control_response" ? (msg.response as Record<string, unknown> | undefined)?.request_id : msg?.request_id;
      if (msg?.type === "control_response") {
        if (typeof id === "string" && id.startsWith(REMOTE_PREFIX)) {
          const asked = this.remoteAsked.get(id);
          this.remoteAsked.delete(id);
          this.sideAsked.delete(id);
          const thinking = this.thinkingAsked.get(id);
          this.thinkingAsked.delete(id);
          const usage = asked === "get_usage" || (!asked && line.includes(RATE_LIMITS));
          const reduced = asked === "get_usage" || asked === "get_settings";
          const out =
            asked === "update_settings"
              ? reply(plainObj(msg.response), () => ({}))
              : asked === "mcp_authenticate"
                ? mcpAuthAnswer(msg)
                : usage
                  ? usageAnswer(msg)
                  : reduced || line.includes(APPLIED)
                    ? appliedAnswer(msg, this.styles)
                    : line;
          this.copy("reply", out);
          if (asked && SETTINGS_CHANGES.has(asked) && (msg.response as Record<string, unknown> | undefined)?.subtype === "success") this.refreshHost();
          if (thinking && (msg.response as Record<string, unknown> | undefined)?.subtype === "success") this.remember("in:set_max_thinking_tokens", "in", thinking);
          return;
        }
        if (line.includes(STYLES)) this.styles = styleNames(plainObj(plainObj(msg?.response).response).available_output_styles) ?? this.styles;
        if (typeof id === "string" && this.hostAsked.delete(id)) {
          this.toHost(line);
          const answer = appliedAnswer(msg, this.styles);
          if (msg.response && (msg.response as Record<string, unknown>).subtype === "success") {
            this.remember("applied", "out", answer);
            this.copy("out", answer);
          }
          return;
        }
        shared = line.includes(MODELS) && !line.includes(APPLIED);
        if (shared) this.hostReady = true;
      } else if (msg?.type === "control_request") {
        const req = plainObj(msg.request);
        const subtype = req.subtype;
        if (subtype === "hook_callback" && req.callback_id === PUSH_HOOK && typeof id === "string") return this.answerPushHook(id, req.input);
        shared = typeof id === "string" && typeof subtype === "string" && SHOWN.has(subtype);
        if (shared) this.open.set(id as string, { subtype: subtype as string, line, ...(typeof req.dialog_kind === "string" ? { kind: req.dialog_kind } : {}) });
        held = shared && subtype === "elicitation" && this.hold(id as string, line);
      } else if (msg?.type === "control_cancel_request" && typeof id === "string" && this.open.delete(id)) {
        withdrawn = this.unhold(id);
        this.settle(id, "cli");
      } else if (msg?.type === "system" && msg.subtype === "control_request_progress") {
        // Progress goes only to the side that asked.
        if (typeof id === "string" && id.startsWith(REMOTE_PREFIX)) return this.copy("out", line);
        shared = false;
      }
    }
    if (!held && !withdrawn) this.toHost(line);
    if (this.notice && this.hostReady) {
      this.toHost(informational(this.notice, this.sessionId));
      this.notice = undefined;
    }
    this.noteTurn(line, msg);
    if (line.includes(TASK_EVENT)) {
      const m = msg ?? parseLine(line);
      if (m) noteForeground(this.foreground, m);
    }
    if (line.includes(TASKS) || line.includes(CRON) || line.includes(WAKEUP)) this.noteJobs(line, msg);
    if (line.includes(STATUS)) this.noteStatus(line, msg);
    if (this.waiting.size && (line.includes(LIFECYCLE) || line.includes(REPLAY))) this.noteTakenIn(line, msg);
    if (!shared) return;
    this.noteState(line, msg);
    this.copy("out", line);
    if (held) this.send({ t: "held", id: msg!.request_id as string });
  }

  private answerPushHook(id: string, input: unknown): void {
    const notice = !this.claudePush || !this.link || this.link.destroyed ? undefined : this.watching ? "watching" : "sent";
    const answer = pushHookAnswer(input, notice);
    const said = notice === "sent" ? "told Claude the broker sends it" : "told Claude the user is looking at the session";
    this.o.log(`PushNotification: ${answer.hookSpecificOutput ? said : "left as Claude Code answered"}`);
    this.toChild(Buffer.from(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: id, response: answer } })));
  }

  private hold(id: string, line: Buffer): boolean {
    if (!this.link || this.link.destroyed) return false;
    const timer = setTimeout(() => this.release(id, "the broker did not take it"), this.o.elicitTakeMs ?? ELICIT_TAKE_MS);
    this.held.set(id, { line, taken: false, timer });
    return true;
  }

  private unhold(id: string): boolean {
    const h = this.held.get(id);
    if (!h) return false;
    clearTimeout(h.timer);
    this.held.delete(id);
    return true;
  }

  private release(id: string, why: string): void {
    const h = this.held.get(id);
    if (!h) return;
    this.unhold(id);
    this.o.log(`MCP input request ${id} goes to VS Code: ${why}`);
    this.toHost(h.line);
  }

  private decide(t: "take" | "pass", id: unknown): void {
    const h = typeof id === "string" ? this.held.get(id) : undefined;
    if (!h) return this.send({ t: "rejected", ...(typeof id === "string" ? { id } : {}), reason: "not held" });
    if (t === "pass") return this.release(id as string, "the broker passed it");
    h.taken = true;
    clearTimeout(h.timer);
  }

  // A turn runs from its init line or the user message that opens it until its result.
  private noteTurn(line: Buffer, parsed?: Record<string, unknown>): void {
    if (line.includes(RESULT)) {
      if ((parsed ?? parseLine(line))?.type !== "result") return;
      this.running = false;
      if (this.hostLeft || !this.sessionId) return;
      try {
        this.o.turns?.completed(this.sessionId);
      } catch (e) {
        this.o.log(`cannot clear the note of a finished turn: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (!this.running && (line.includes(INIT) || line.includes(USER))) {
      const m = parsed ?? parseLine(line);
      if (m?.type === "user" || (m?.type === "system" && m.subtype === "init")) this.running = true;
    }
  }

  private wait(uuid: string, line: Buffer, remote: boolean): void {
    this.waiting.delete(uuid);
    this.waiting.set(uuid, { line, remote });
    if (this.waiting.size > WAITING_KEEP) this.waiting.delete(this.waiting.keys().next().value!);
  }

  // A message leaves the waiting list once Claude Code starts, finishes or drops it, or replays it as taken in.
  private noteTakenIn(line: Buffer, parsed?: Record<string, unknown>): void {
    const m = parsed ?? parseLine(line);
    if (m?.type === "command_lifecycle" && m.state !== "queued" && typeof m.command_uuid === "string") this.waiting.delete(m.command_uuid);
    else if (m?.type === "user" && m.isReplay === true && typeof m.uuid === "string") this.waiting.delete(m.uuid);
  }

  private noteJobs(line: Buffer, parsed?: Record<string, unknown>): void {
    const m = parsed ?? parseLine(line);
    if (m?.type === "system" && m.subtype === "background_tasks_changed") this.backgroundTasks = backgroundCount(m);
    else if (m?.type === "assistant") {
      const content = plainObj(m.message).content;
      if (Array.isArray(content) && content.some((b) => plainObj(b).type === "tool_use" && SCHEDULING.has(plainObj(b).name))) this.scheduled = true;
    }
  }

  private noteStatus(line: Buffer, parsed?: Record<string, unknown>): void {
    const m = parsed ?? parseLine(line);
    if (m?.type === "system" && m.subtype === "status") this.cliStatus = typeof m.status === "string" ? m.status : null;
  }

  // VS Code reads the applied effort and ultracode state again on the status line its extension sends when
  // Claude Code connects; Claude Code itself sends nothing that does so after a remote change. The line carries
  // Claude Code's current status and no permission mode, so nothing else on VS Code's side changes.
  private refreshHost(): void {
    if (!this.hostReady) return;
    const line = { type: "system", subtype: "status", status: this.cliStatus, connectSnapshot: true, uuid: randomUUID(), ...(this.sessionId ? { session_id: this.sessionId } : {}) };
    this.toHost(Buffer.from(JSON.stringify(line)));
  }

  private noteState(line: Buffer, parsed?: Record<string, unknown>): void {
    let key: string | undefined;
    if (line.includes(INIT)) key = "init";
    else if (line.includes(STATE)) key = "state";
    else if (line.includes(TASKS)) key = "tasks";
    else if (line.includes(COMMANDS)) key = "commands";
    else if (line.includes(STATUS) && line.includes(MODE)) key = "status";
    else if (parsed?.type === "control_response" && line.includes(MODELS)) key = "models";
    if (!key) return;
    const msg = parsed ?? parseLine(line);
    if (!msg || (key !== "models" && msg.type !== "system")) return;
    if (key === "init" && typeof msg.session_id === "string" && msg.session_id) this.sessionId = msg.session_id;
    this.remember(key, "out", line);
  }

  private remember(key: string, t: "out" | "in", line: Buffer): void {
    this.state.set(key, { seq: ++this.seq, t, line });
  }

  private inject(m: Record<string, unknown>): void {
    const reject = (reason: string, id?: unknown) => {
      this.o.log(`rejected remote line: ${reason}`);
      this.send({ t: "rejected", ...(typeof id === "string" ? { id } : {}), reason });
    };
    if (this.hostEnded || this.finished) return reject("closed", m.type === "control_request" ? m.request_id : undefined);
    if (m.type === "user") {
      if ((m.message as Record<string, unknown> | undefined)?.role !== "user") return reject("invalid user message");
      const copy = waitingCopy(m, true);
      if (copy) this.wait(m.uuid as string, copy, true);
      this.toChild(Buffer.from(JSON.stringify(m)));
      return;
    }
    if (m.type === "control_request") {
      const req = m.request as Record<string, unknown> | undefined;
      if (typeof m.request_id !== "string" || !m.request_id.startsWith(REMOTE_PREFIX) || !req) return reject("invalid request", m.request_id);
      if (typeof req.subtype !== "string" || !REMOTE_REQUESTS.has(req.subtype)) return reject("request not allowed", m.request_id);
      if (req.subtype === "get_task_output" && !allowedTaskOutput(req)) return reject("invalid request", m.request_id);
      if (req.subtype === "background_tasks" && !allowedBackground(req)) return reject("invalid request", m.request_id);
      if (req.subtype === "background_tasks" && ![...this.foreground.values()].includes(req.tool_use_id as string)) return reject("not running", m.request_id);
      if (req.subtype === "get_usage" && !allowedUsage(req)) return reject("invalid request", m.request_id);
      if (req.subtype === "set_permission_mode" && req.mode === "bypassPermissions") return reject("mode not allowed", m.request_id);
      if (req.subtype === "apply_flag_settings" && !allowedFlagSettings(req.settings)) return reject("setting not allowed", m.request_id);
      if (req.subtype === "read_file" && !allowedReadFile(req)) return reject("invalid request", m.request_id);
      if (req.subtype === "rename_session" && !allowedRename(req, this.sessionId)) return reject("invalid request", m.request_id);
      if (req.subtype === "update_settings" && !allowedUpdateSettings(req, this.styles)) return reject("setting not allowed", m.request_id);
      if (req.subtype === "set_max_thinking_tokens" && !allowedThinking(req)) return reject("invalid request", m.request_id);
      if (req.subtype === "get_workspace_diff" && !allowedWorkspaceDiff(req)) return reject("invalid request", m.request_id);
      if (req.subtype === "side_question" && !allowedSideQuestion(req)) return reject("invalid request", m.request_id);
      if (req.subtype === "mcp_authenticate" && !allowedMcpAuthenticate(req)) return reject("invalid request", m.request_id);
      if (req.subtype === "mcp_oauth_callback_url" && !allowedMcpCallback(req)) return reject("invalid request", m.request_id);
      if (req.subtype === "side_question") ask(this.sideAsked, m.request_id);
      // Only a message the broker sent may be taken back; VS Code shows a cancelled message of its own as sent.
      if (req.subtype === "cancel_async_message" && !this.cancellable(req)) return reject("message not allowed", m.request_id);
      if (req.subtype === "get_settings" || req.subtype === "get_usage" || req.subtype === "update_settings" || req.subtype === "mcp_authenticate" || SETTINGS_CHANGES.has(req.subtype)) {
        askFor(this.remoteAsked, m.request_id, req.subtype);
      }
      if (req.subtype === "set_max_thinking_tokens") askFor(this.thinkingAsked, m.request_id, Buffer.from(JSON.stringify(m)));
      this.toChild(Buffer.from(JSON.stringify(m)));
      return;
    }
    if (m.type === "control_response") {
      const response = m.response as Record<string, unknown> | undefined;
      const id = response?.request_id;
      if (typeof id !== "string") return reject("invalid response");
      const by = this.settled.get(id);
      if (by) {
        this.send({ t: "dropped", id, from: "remote", by });
        return;
      }
      const open = this.open.get(id);
      const subtype = open?.subtype;
      // VS Code is told to close its own copy of a dialog answered here, as of a permission prompt.
      if (subtype === "request_user_dialog") {
        const kind = open?.kind ?? "";
        const answer = response?.subtype === "success" ? dialogAnswer(kind, response.response) : undefined;
        if (!answer) return reject(Object.hasOwn(DIALOG_CHOICES, kind) ? "invalid answer" : "not answerable", id);
        this.open.delete(id);
        this.toChild(Buffer.from(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: id, response: answer } })));
        this.toHost(Buffer.from(JSON.stringify({ type: "control_cancel_request", request_id: id })));
        this.settle(id, "remote");
        return;
      }
      if (subtype === "elicitation" && this.held.get(id)?.taken) {
        const answer = response?.subtype === "success" ? elicitAnswer(response.response) : undefined;
        if (!answer) return reject("invalid answer", id);
        this.unhold(id);
        this.open.delete(id);
        this.toChild(Buffer.from(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: id, response: answer } })));
        this.settle(id, "remote");
        return;
      }
      if (subtype !== "can_use_tool") return reject("not answerable", id);
      const updates = (response?.response as Record<string, unknown> | undefined)?.updatedPermissions;
      if (Array.isArray(updates) && updates.some((u) => (u as Record<string, unknown> | null)?.mode === "bypassPermissions")) {
        return reject("mode not allowed", id);
      }
      this.open.delete(id);
      this.toChild(Buffer.from(JSON.stringify(m)));
      this.toHost(Buffer.from(JSON.stringify({ type: "control_cancel_request", request_id: id })));
      this.settle(id, "remote");
      return;
    }
    if (m.type === "control_cancel_request") {
      const id = m.request_id;
      if (typeof id !== "string" || Object.keys(m).some((k) => k !== "type" && k !== "request_id") || !this.sideAsked.delete(id)) return reject("not cancellable", id);
      this.toChild(Buffer.from(JSON.stringify({ type: "control_cancel_request", request_id: id })));
      return;
    }
    reject("unsupported");
  }

  private cancellable(req: Record<string, unknown>): boolean {
    const id = req.message_uuid;
    return Object.keys(req).every((k) => k === "subtype" || k === "message_uuid") && typeof id === "string" && this.waiting.get(id)?.remote === true;
  }

  private settle(id: string, by: Party): void {
    this.settled.set(id, by);
    if (this.settled.size > SETTLED_KEEP) this.settled.delete(this.settled.keys().next().value!);
    this.send({ t: "settled", id, by });
  }

  private toChild(line: Buffer): void {
    const stdin = this.child?.stdin;
    if (!stdin) {
      this.queued.push(line);
      return;
    }
    if (!stdin.writable) return;
    stdin.write(line);
    if (!stdin.write(NL) && !this.hostPaused) {
      this.hostPaused = true;
      this.o.hostIn.pause();
    }
  }

  private toHost(line: Buffer): void {
    if (this.hostGone) return;
    const out = this.o.hostOut;
    out.write(line);
    if (!out.write(NL) && !this.childPaused && this.child?.stdout) {
      this.childPaused = true;
      this.child.stdout.pause();
      out.once("drain", () => {
        this.childPaused = false;
        this.child?.stdout?.resume();
      });
    }
  }

  private send(frame: WrapperFrame): void {
    this.write(Buffer.from(JSON.stringify(frame) + "\n"));
  }

  // Embeds the line as it is; the frame type comes after it so it wins over anything inside.
  private copy(t: "out" | "in" | "reply", line: Buffer): void {
    if (!line.length) return;
    this.write(Buffer.concat([Buffer.from('{"m":'), line, Buffer.from(`,"t":"${t}"}\n`)]));
  }

  private write(data: Buffer): void {
    const link = this.link;
    if (!link || link.destroyed) return;
    if (link.writableLength > LINK_BUFFER_MAX) {
      this.o.log("broker is not reading; dropping the connection");
      link.destroy();
      return;
    }
    link.write(data);
  }

  private connect(): void {
    if (this.finished) return;
    if (!isPrivateDir(path.dirname(this.o.socketPath))) {
      if (!this.warnedDir) this.o.log(`not connecting: ${path.dirname(this.o.socketPath)} is missing or not private`);
      this.warnedDir = true;
      this.gate?.open();
      this.retryLater();
      return;
    }
    const sock = net.createConnection(this.o.socketPath);
    sock.on("connect", () => {
      this.link = sock;
      if (this.retry) this.o.log("broker connected");
      this.retry = 0;
      const claiming = this.gate && !this.gate.isOpen;
      const hello: Hello = {
        t: "hello",
        v: LINK_VERSION,
        wpid: process.pid,
        cwd: this.o.cwd,
        args: this.o.args,
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
        ...(claiming ? { claim: this.claim } : {}),
        caps: CAPS,
      };
      this.send(hello);
      if (this.child?.pid) this.send({ t: "spawned", cpid: this.child.pid });
      for (const s of [...this.state.values()].sort((a, b) => a.seq - b.seq)) this.copy(s.t, s.line);
      for (const { line } of this.open.values()) this.copy("out", line);
      for (const { line } of this.waiting.values()) this.copy("in", line);
      if (claiming) this.gate!.wait(this.o.claimAckMs ?? 3000);
    });
    const split = new LineSplitter((line) => this.fromBroker(line));
    sock.on("data", (chunk: Buffer) => split.push(chunk));
    sock.on("error", () => {});
    sock.on("close", () => {
      if (this.link === sock) {
        this.link = undefined;
        this.claudePush = false;
        this.watching = false;
        this.o.log("broker connection closed");
        for (const id of [...this.held.keys()]) this.release(id, "the broker went away");
      }
      this.gate?.open();
      this.retryLater();
    });
  }

  private retryLater(): void {
    if (this.finished) return;
    const delays = this.o.retryMs ?? [1000, 2000, 5000, 10_000, 15_000];
    const ms = delays[Math.min(this.retry++, delays.length - 1)];
    this.retryTimer = setTimeout(() => this.connect(), ms);
    this.retryTimer.unref();
  }

  private fromBroker(line: Buffer): void {
    const f = parseLine(line) as BrokerFrame | undefined;
    if (!f) return;
    try {
      if (f.t === "claim_ok") {
        if (this.gate && !this.gate.isOpen) {
          this.claimSettled = true;
          if (f.fork) {
            this.fork = true;
            this.sessionId = undefined;
            if (typeof f.title === "string" && f.title.trim() && f.title.length <= RENAME_TITLE_MAX) this.copyName = f.title;
          }
          if (typeof f.notice === "string" && f.notice && f.notice.length <= NOTICE_MAX) this.notice = f.notice;
        }
        this.gate?.open();
      } else if (f.t === "claim_wait") this.gate?.wait(Math.max(0, Number(f.ms) || 0));
      else if (f.t === "hand_over") this.handOver(f.id, f.notice);
      else if (f.t === "to_cli" && f.m && typeof f.m === "object") this.inject(f.m);
      else if (f.t === "take" || f.t === "pass") this.decide(f.t, f.id);
      else if (f.t === "claude_push") {
        this.claudePush = f.on === true;
        this.watching = f.watching === true;
      }
    } catch (e) {
      this.o.log(`broker frame failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.retryTimer);
    for (const h of this.held.values()) clearTimeout(h.timer);
    this.held.clear();
    this.gate?.open();
    this.o.log(`claude exited code=${code} signal=${signal}`);
    this.send({ t: "exit", code, signal, hostLeft: this.hostLeft, running: this.running });
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      this.emit("exit", code, signal);
    };
    const link = this.link;
    if (link && !link.destroyed) {
      link.end(end);
      setTimeout(end, 500);
    } else end();
  }
}
