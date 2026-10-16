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
  // A session without a process whose working folder is gone: Claude Code cannot start in it.
  folderMissing?: boolean;
  // Archived in ccrc: left out of the full list here, and nowhere else.
  archived?: boolean;
}

export interface ToolResult {
  text: string;
  isError: boolean;
  truncated: boolean;
}

// "ultracode": Ultracode was asked for at the start but Claude Code could not turn it on.
// "fast": Fast mode asked for here could not go on (text: Claude Code's reason), or the usage credits ran out ("credits").
export type NoteCode = "interrupted" | "compacted" | "command" | "error" | "unsent" | "ultracode" | "fast";

// One hunk of a file change as Claude Code reports it; each line starts with " ", "-" or "+".
export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

// What a subagent started by an Agent/Task tool call has done so far. ended: how it ended, from the notice
// Claude Code gives the model (agents and agentsFailed for a workflow). agentId: the subagent's id, which names its
// transcript; runId: a workflow's run, which names the folder of its agents. Both come from the call's result.
export interface SubagentActivity {
  tools: number;
  recent: { name: string; summary: string }[];
  text?: string;
  ended?: { status: "completed" | "failed" | "stopped"; tokens?: number; ms?: number; agents?: number; agentsFailed?: number };
  agentId?: string;
  runId?: string;
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

// An image or document attached to a user message, without its data; size in bytes, 0 when unknown.
// GET /api/sessions/:id/messages/:messageId/attachments/:index serves the images.
export interface UserAttachment {
  kind: "image" | "document";
  mediaType: string;
  size: number;
  name?: string;
}

export type DisplayItem =
  | { kind: "user"; id: string; ts?: string; text: string; attachments?: UserAttachment[] }
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
  // "unsent": a message sent from here that Claude Code never took in; its text, and how many files it carried.
  | { kind: "note"; id: string; ts?: string; code: NoteCode; text?: string; attachments?: number }
  // The result of a local command (/usage, /context, ...): its text, and for some the data to draw it from.
  | { kind: "command"; id: string; ts?: string; name?: string; args?: string; text: string; usage?: UsageInfo; context?: ContextDetail }
  // A message Claude Code passed to the model from someone other than the user: a subagent's report ("agent"),
  // another Claude session ("session") or a channel ("channel"). text: Markdown, without the frame Claude Code
  // puts around a report.
  | { kind: "message"; id: string; ts?: string; from: "agent" | "session" | "channel"; name?: string; text: string }
  // Claude Code's notice to the model about a background task: how it ended, its summary, and the result or
  // event it carried.
  | { kind: "task"; id: string; ts?: string; status?: "completed" | "failed" | "stopped"; summary: string; text?: string }
  // A shell command run with "!" in the terminal, and its output once it is in.
  | { kind: "shell"; id: string; ts?: string; command: string; output?: string };

// A task of a session as Claude Code reports it: a subagent, a workflow, a shell, a monitor, ...
// description: as the task started; activity: what it does now. kind: Claude Code's task_type (local_agent,
// local_workflow, local_bash, monitor_mcp, ...); agentType: the subagent type. type: agentType or kind.
// parentId: the subagent that started it. ms: how long it has run as the broker measured it when the state was
// made, or in all once it ended.
export interface TaskInfo {
  id: string;
  description: string;
  type?: string;
  kind?: string;
  agentType?: string;
  status: "running" | "completed" | "failed" | "stopped";
  toolUseId?: string;
  parentId?: string;
  depth?: number;
  background?: boolean;
  ms?: number;
  tokens?: number;
  tools?: number;
  activity?: string;
  summary?: string;
  error?: string;
  workflow?: WorkflowInfo;
}

export type WorkflowAgentState = "queued" | "running" | "done" | "failed";

// An agent of a workflow; id: its agent id, which a permission request it makes carries. phase: index into phases.
export interface WorkflowAgent {
  label: string;
  id?: string;
  phase?: number;
  state: WorkflowAgentState;
  model?: string;
  tokens?: number;
  tools?: number;
  ms?: number;
  activity?: string;
  error?: string;
}

// A workflow's phases and agents as its progress reports them; agents lists at most the first 40, the counts cover all.
export interface WorkflowInfo {
  name?: string;
  phases: string[];
  phase?: number;
  agents: WorkflowAgent[];
  total: number;
  running: number;
  done: number;
  failed: number;
}

// What the phone holds of a transcript it follows: how many items from the start, the last one's id, and the tool
// items still without a result.
export interface TranscriptAfter {
  count: number;
  lastId: string;
  open?: string[];
}

// A page of a subagent's transcript as conversation items. from: where items[0] stands among all `total` items.
// changed: items the phone holds that changed since (after.open). reset: the phone's items no longer line up, so this
// is the latest page instead. promptId: the item of the subagent's instructions. missing: no transcript yet.
export interface AgentTranscript {
  agentId: string;
  items: DisplayItem[];
  from: number;
  total: number;
  changed?: DisplayItem[];
  reset?: boolean;
  promptId?: string;
  agentType?: string;
  description?: string;
  missing?: boolean;
}

// The end of a shell or monitor task's output as Claude Code hands it out; truncated: the output began earlier.
export interface TaskOutput {
  text: string;
  totalBytes: number;
  truncated: boolean;
}

// A message sent while Claude Code works, which it holds until it takes it in: from here ("remote") or from VS Code ("host").
export interface QueuedMessage {
  id: string;
  ts: string;
  text: string;
  attachments?: UserAttachment[];
  from: "remote" | "host";
}

export interface CommandInfo {
  name: string;
  description: string;
  argumentHint?: string;
}

// autoCompactAt: the token count at which Claude Code compacts on its own, absent while auto-compact is off.
export interface ContextDetail {
  percentage: number;
  totalTokens: number;
  maxTokens: number;
  autoCompactAt?: number;
  model?: string;
  categories: { name: string; tokens: number; kind: string }[];
  memoryFiles?: { path: string; tokens: number }[];
  agents?: { name: string; tokens: number }[];
}

// How full the session's context window is. last: read from the transcript of a session without a process.
export interface ContextGauge {
  percent: number;
  tokens: number;
  max: number;
  autoCompactAt?: number;
  last?: boolean;
}

// What a session without a process starts with when the broker next starts it.
export interface StartSettings {
  model?: string;
  mode?: PermissionModeName;
  effort?: EffortName;
  ultracode?: boolean;
  // Fast mode on, or Thinking off, from the start; kept only when set that way.
  fast?: boolean;
  thinking?: boolean;
}

// A new session's own worktree, made by Claude Code (--worktree). base: what its branch starts from, origin's default
// branch ("fresh", the local HEAD when there is none) or the folder's HEAD.
export interface WorktreeChoice {
  name: string;
  base: "fresh" | "head";
}

// Whether a new session can start in a worktree of the folder. root: the checkout worktrees go under; origin: the ref
// "fresh" starts from when known here, "origin" when only the remote is; hook: a WorktreeCreate hook makes it instead.
// existing: worktrees Claude Code opens again by that name; blocked: names whose branch is left without its worktree.
export interface GitFolderInfo {
  repo: boolean;
  root?: string;
  branch?: string;
  head?: string;
  origin?: string;
  hook: boolean;
  suggested: string;
  existing: string[];
  blocked: string[];
}

// A session's worktree as it is now. changed: files git status lists; commits: commits no other branch or remote has;
// lock: claude when Claude Code put it, alive while its process runs; running: where a process works in it.
export interface WorktreeStatus {
  path: string;
  name: string;
  root: string;
  branch?: string;
  exists: boolean;
  registered: boolean;
  changed: number;
  commits: number;
  lock?: { claude: boolean; alive: boolean; reason?: string };
  running?: string;
  ignored: boolean;
}

// What removing a worktree did: the branch stays when it holds commits no other branch or remote has.
export interface WorktreeRemoved {
  path: string;
  branch?: string;
  branchKept: boolean;
  commits: number;
  discarded: number;
}

// The worktree calls: about a session's worktree, and (git) about a folder before a session starts in it.
export interface CallMap {
  git: { args: Record<string, never>; data: GitFolderInfo };
  worktree_status: { args: Record<string, never>; data: WorktreeStatus };
  // discard: the user agreed a second time to drop changed files, or to leave commits on a kept branch.
  worktree_remove: { args: { discard: boolean }; data: WorktreeRemoved };
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
  // summary: from the last response's usage, without counting each category.
  context: { args: { summary?: boolean }; data: ContextDetail };
  usage: { args: Record<string, never>; data: UsageInfo };
  mcp_status: { args: Record<string, never>; data: McpServerInfo[] };
  mcp_toggle: { args: { server: string; enabled: boolean }; data: McpServerInfo[] };
  mcp_reconnect: { args: { server: string }; data: McpServerInfo[] };
  rewind: { args: { userMessageId: string; dryRun: boolean }; data: RewindResult };
  stop_task: { args: { taskId: string }; data: Record<string, never> };
  // A subagent's transcript, by its id or else by the Agent call that started it: the latest page, the page before
  // item `before`, or what follows the items the phone holds.
  agent_transcript: { args: { agentId?: string; toolUseId?: string; before?: number; after?: TranscriptAfter }; data: AgentTranscript };
  task_output: { args: { taskId: string }; data: TaskOutput };
  // The agents of a workflow run, from the journal Claude Code keeps of it.
  workflow_agents: { args: { runId: string }; data: WorkflowInfo };
  commands: { args: Record<string, never>; data: CommandInfo[] };
  files: { args: { query: string }; data: string[] };
  // Starts the session's Claude Code process here without sending anything.
  resume: { args: Record<string, never>; data: Record<string, never> };
  output_style: { args: Record<string, never>; data: OutputStyleInfo };
  set_output_style: { args: { style: string }; data: OutputStyleInfo };
  // Takes back a message sent from here that Claude Code has not taken in yet.
  unqueue: { args: { messageId: string }; data: Record<string, never> };
  // Names the session where Claude Code keeps names; data.title: the name as Claude Code keeps it.
  rename: { args: { title: string }; data: { title: string } };
  // Leaves the session out of ccrc's full list, or brings it back.
  archive: { args: { archived: boolean }; data: { archived: boolean } };
}
export type CallOp = keyof CallMap;
export const CALL_OPS: CallOp[] = ["context", "usage", "mcp_status", "mcp_toggle", "mcp_reconnect", "rewind", "stop_task", "commands", "files", "resume", "output_style", "set_output_style", "unqueue", "rename", "archive"];
// The calls the new-session screen makes about a folder before any session runs in it.
export type FolderOp = "files" | "commands" | "usage" | "git";
export const FOLDER_OPS: FolderOp[] = ["files", "commands", "usage", "git"];

// The agent map's reads, about one session like the calls above.
CALL_OPS.push("agent_transcript", "task_output", "workflow_agents");
CALL_OPS.push("worktree_status", "worktree_remove");

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
  // The auto-mode classifier blocked the call and handed it to a person: allow or deny, never a lasting rule.
  personOnly?: boolean;
  // The answer must not be an approval by a stray tap.
  defaultToNo?: boolean;
  elicitation?: ElicitInfo;
  // The task id of the subagent that asks, when one does.
  agentId?: string;
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
  // Whether Claude Code offered Ultracode with this model in an earlier session; absent when not known.
  ultracode?: boolean;
  // Whether the model runs in Fast mode, and whether its Thinking can be turned off; absent when not known.
  fast?: boolean;
  thinkingOff?: boolean;
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
  context?: ContextGauge;
  start?: StartSettings;
  costUsd?: number;
  closedReason?: string;
  tasks?: TaskInfo[];
  folderMissing?: boolean;
  // A session whose worktree is gone starts again here, the folder it was made from.
  resumeIn?: string;
  // In the order Claude Code takes them in.
  queued?: QueuedMessage[];
  // Fast mode as Claude Code last reported it, with its reason when it cannot run; fastWanted: a change asked for here
  // that no report has confirmed yet; fastCredits: the usage credits ran out.
  fastMode?: "off" | "on" | "cooldown";
  fastReason?: string;
  fastWanted?: boolean;
  fastCredits?: boolean;
  // Thinking as the broker knows it; absent when it cannot know.
  thinking?: boolean;
  // The VS Code wrapper is too old to change Fast mode and Thinking.
  optionsUnknown?: boolean;
}

export type ClientMsg =
  | { t: "take_window" }
  // focus: an item to include, when it lies before the latest items a snapshot holds.
  | { t: "view"; sessionId: string | null; focus?: string }
  // attachments: ids from POST /api/upload, sent before the text as Claude Code content blocks.
  | { t: "send"; sessionId: string; text: string; attachments?: string[] }
  // draftId: the phone's name for the start, returned with session_started or an error about it.
  | {
      t: "new_session";
      cwd: string;
      text: string;
      model?: string;
      mode?: PermissionModeName;
      effort?: EffortName;
      ultracode?: boolean;
      fast?: boolean;
      thinking?: boolean;
      attachments?: string[];
      draftId?: string;
      worktree?: WorktreeChoice;
    }
  | { t: "answer"; sessionId: string; requestId: string; answer: Answer }
  | { t: "interrupt"; sessionId: string }
  | { t: "set_mode"; sessionId: string; mode: PermissionModeName }
  | { t: "set_model"; sessionId: string; model: string }
  | { t: "set_effort"; sessionId: string; effort: EffortName }
  | { t: "set_ultracode"; sessionId: string; on: boolean }
  | { t: "set_fast"; sessionId: string; on: boolean }
  | { t: "set_thinking"; sessionId: string; on: boolean }
  | { t: "release"; sessionId: string }
  | { t: "call"; id: number; sessionId: string; op: CallOp; args?: Record<string, unknown> }
  | { t: "call"; id: number; cwd: string; op: FolderOp; args?: Record<string, unknown> }
  // Whether the page is in front, so the broker knows when to notify instead.
  | { t: "visibility"; visible: boolean }
  | { t: "ping" };

// Items a snapshot leaves out between a far-back focused part and the latest items, which start at `before`.
export interface SnapshotGap {
  before: string;
  skipped: number;
}

export type ServerMsg =
  | { t: "ready" }
  | { t: "window_conflict" }
  | { t: "window_taken" }
  | { t: "lease_revoked"; reason: string }
  | { t: "snapshot"; sessionId: string; items: DisplayItem[]; pending: PendingRequest[]; state: LiveState; hasMore: boolean; gap?: SnapshotGap }
  | { t: "item"; sessionId: string; item: DisplayItem }
  | { t: "stream"; sessionId: string; text: string; thinking: boolean }
  | { t: "pending_add"; sessionId: string; request: PendingRequest }
  | { t: "pending_remove"; sessionId: string; requestId: string }
  | { t: "state"; sessionId: string; state: LiveState }
  | { t: "session_started"; sessionId: string; draftId?: string }
  | { t: "sessions_changed" }
  | { t: "error"; message: string; sessionId?: string; draftId?: string }
  | { t: "call_result"; id: number; ok: boolean; data?: unknown; error?: string }
  | { t: "pong" };
