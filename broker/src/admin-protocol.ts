// Shapes of the Claude Code settings, audit log and health endpoints, shared by the broker and the web client.

export type SettingField =
  | { key: string; kind: "choice"; values: string[] }
  | { key: string; kind: "text"; pattern: RegExp }
  | { key: string; kind: "bool" | "rules" | "dirs" };

// Keys of Claude Code's user settings the web client may change; "a.b" is key b inside object a.
// Keys that run commands or widen what Claude Code may do unasked are left out on purpose.
export const CLAUDE_SETTING_FIELDS: SettingField[] = [
  { key: "model", kind: "text", pattern: /^[A-Za-z0-9][\w.:/@[\]-]{0,199}$/ },
  { key: "permissions.defaultMode", kind: "choice", values: ["default", "acceptEdits", "plan", "auto"] },
  { key: "permissions.allow", kind: "rules" },
  { key: "permissions.ask", kind: "rules" },
  { key: "permissions.deny", kind: "rules" },
  { key: "permissions.additionalDirectories", kind: "dirs" },
  { key: "effortLevel", kind: "choice", values: ["low", "medium", "high", "xhigh"] },
  { key: "alwaysThinkingEnabled", kind: "bool" },
  { key: "showThinkingSummaries", kind: "bool" },
  { key: "language", kind: "text", pattern: /^[\p{L}\p{M}][\p{L}\p{M} ()-]{0,39}$/u },
  { key: "theme", kind: "choice", values: ["auto", "dark", "light", "dark-daltonized", "light-daltonized", "dark-ansi", "light-ansi"] },
  { key: "autoCompactEnabled", kind: "bool" },
  { key: "includeGitInstructions", kind: "bool" },
  { key: "respectGitignore", kind: "bool" },
];

export const MAX_RULES = 500;
export const MAX_DIRS = 100;
const RULE = /^([A-Za-z][\w.*-]*)(?:\((.+)\))?$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

// A permission rule in the form Claude Code accepts: Tool or Tool(content); MCP rules take no content.
export function isPermissionRule(rule: string): boolean {
  if (rule.length > 1000 || rule !== rule.trim() || CONTROL_CHARS.test(rule)) return false;
  const m = RULE.exec(rule);
  if (!m) return false;
  if (m[1].startsWith("mcp__")) return m[2] === undefined;
  return m[1].includes("_") || /^[A-Z]/.test(m[1]);
}

// An absolute folder path without "." or ".." parts, doubled or trailing slashes.
export function isAbsoluteDir(dir: string): boolean {
  if (dir.length > 4096 || !dir.startsWith("/") || CONTROL_CHARS.test(dir)) return false;
  if (dir === "/") return true;
  return dir
    .slice(1)
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..");
}

// Why a key of the file is not offered here: it runs commands, it concerns security, or its
// current value is not one that can be picked here.
export type SettingNoteReason = "command" | "security" | "value";

export interface ClaudeSettingsView {
  path: string;
  exists: boolean;
  // Changes are refused unless they name the hash of the file they were made against.
  hash: string;
  // The file is not strict JSON (comments, for example) or not an object, so it is left alone.
  problem?: "not_json" | "not_object";
  values: Record<string, unknown>;
  // Everything else in the file, with environment variable values hidden.
  rest: Record<string, unknown>;
  notes: { key: string; reason: SettingNoteReason }[];
}

export interface AuditEntry {
  ts: string;
  event: string;
  device?: string;
  sessionId?: string;
  [detail: string]: unknown;
}

export interface AuditPage {
  // Newest first.
  entries: AuditEntry[];
  // Passed as `before` for the entries older than these; absent at the start of the log.
  next?: number;
}

// warn: passes, with something to know.
export interface DoctorCheck {
  name: string;
  ok: boolean;
  warn?: boolean;
  detail?: string;
}

export interface DoctorResult {
  ok: boolean;
  at: string;
  extensionVersion?: string;
  cliVersion?: string;
  brokerVersion?: string;
  // The Claude Code broker sessions ran with at the check, as "<version> <source>".
  brokerCli?: string;
  checks: DoctorCheck[];
}

export interface HealthInfo {
  brokerVersion?: string;
  extensionVersion?: string;
  cliVersion?: string;
  // VS Code's claudeCode.claudeProcessWrapper setting: whether it is in effect and points at this broker's wrapper.
  wrapper: { path?: string; on: boolean; thisBroker: boolean; unreadable?: boolean };
  // The Claude Code a broker session starting now runs: set in the config, bundled in VS Code's extension, the global
  // install or the Agent SDK's own.
  brokerCli?: { source: "config" | "vscode" | "global" | "sdk"; version?: string; path?: string };
  last?: DoctorResult;
  running: boolean;
}

// Claude sends files to the phone from broker sessions only with this Claude Code or newer.
export const SEND_FILES_CLI = "2.1.300";
