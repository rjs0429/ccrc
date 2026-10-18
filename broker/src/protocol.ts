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
  // VS Code archived it, which counts as archived here while vscodeArchive is on unless it was brought back here.
  vscodeArchived?: boolean;
  // A turn the remote user waits for ended, or a notice about the session went out, and nobody opened it since.
  unread?: boolean;
  // Open in another program that takes messages from here through its inbox socket.
  inbox?: boolean;
}

// The sender name of a message sent from here to a session open in another program, as Claude and that session show it.
export const INBOX_SENDER = "ccrc 휴대폰";

// How a session open in another program would treat a message from here, as far as ccrc can tell: delivered, held
// until approved in its terminal, held where nobody can approve it (by its permission mode or its settings), or
// dropped by its settings.
export interface InboxInfo {
  gate: "deliver" | "approve" | "held" | "refused";
  why?: "mode" | "setting";
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

// A file Claude sent with SendUserFile, as the call's result names it: its path as Claude Code resolved it and its size
// in bytes when sent. error: why it is not served, as Claude Code put it (empty when it said nothing); a file with an
// error never opens. GET /api/sessions/:id/sent/:call/:n serves the others by their place in the call.
export interface SentFile {
  name: string;
  path: string;
  size: number;
  mediaType?: string;
  image?: boolean;
  error?: string;
}

// The most a phone may fetch of a file Claude sent.
export const SENT_MAX_BYTES = 50 * 1024 * 1024;

// How the phone names a file Claude sent: its call, its place among the call's files, and the subagent whose transcript
// holds the call when it is not the session's own.
export interface SentRef {
  call: string;
  n: number;
  agent?: string;
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
      // SendUserFile: the files its result names; sentCut: those that open left out to keep the item small. by: the
      // Agent call whose subagent sent them, shown here while it runs.
      sent?: SentFile[];
      sentCut?: number;
      by?: string;
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

// Items of the conversation next to the ones the phone holds; more: items remain on that side.
export interface HistoryPage {
  items: DisplayItem[];
  more: boolean;
}

// What the conversation's sheets list from all of it: the user's messages or the file changes.
export type HistoryFind = "users" | "changes";

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

// The prompt cache as the last response of the main conversation left it, read the way VS Code reads it: at, when the
// request that wrote or read it went out (ms since the epoch); ttl, how long Claude Code asked to keep it; tokens, what
// the next request re-caches once it expired. compactedAt: a compaction since, which the cache does not hold.
export interface PromptCache {
  at?: number;
  ttl?: "5m" | "1h";
  tokens?: number;
  compactedAt?: number;
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
// changed: of a session's folder, the files git status lists, which a worktree made from its HEAD leaves behind.
// subfolder: the session's folder lies below the top of its checkout, so a fork of it gets no worktree: the fork would
// work at the worktree's top, where the relative paths of its transcript and file checkpoints name other files.
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
  changed?: number;
  subfolder?: boolean;
}

// A session's worktree as it is now. changed: files git status lists, each new file counted; commits: commits no other
// branch or remote has that removal leaves on the own branch; lock: claude when Claude Code put it, alive while its
// process runs; running: where a process works in it.
export interface WorktreeStatus {
  path: string;
  name: string;
  root: string;
  // The worktree's own branch, and another branch it has checked out, which removal leaves alone.
  branch?: string;
  checkedOut?: string;
  exists: boolean;
  registered: boolean;
  changed: number;
  commits: number;
  // Commits only a detached HEAD holds that the own branch cannot take; removal waits until a branch holds them.
  stranded?: number;
  lock?: { claude: boolean; alive: boolean; reason?: string };
  running?: string;
  ignored: boolean;
}

// What removing a worktree did: its own branch stays when it holds commits no other branch or remote has; checkedOut
// is the other branch it had checked out, left as it was.
export interface WorktreeRemoved {
  path: string;
  branch?: string;
  branchKept: boolean;
  commits: number;
  discarded: number;
  checkedOut?: string;
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

// A trait of the usage in a window as Claude Code names it (an open set: cache_miss, long_context, ...): its share of the
// weighted usage, the traits overlapping, and the requests that show it.
export interface UsageTrait {
  key: string;
  pct: number;
  count: number;
}

export interface UsageShare {
  name: string;
  pct: number;
}

export interface UsageWindowCauses {
  requests: number;
  sessions: number;
  traits: UsageTrait[];
  agents: UsageShare[];
  skills: UsageShare[];
  plugins: UsageShare[];
  mcpServers: UsageShare[];
}

// What the usage of the last day and week went to, from Claude Code's scan of this machine's transcripts. none: Claude
// Code gave no answer to it (not a claude.ai subscription, or the scan failed).
export interface UsageCauses {
  day?: UsageWindowCauses;
  week?: UsageWindowCauses;
  none?: boolean;
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
  // Files left as they are because they are links.
  skippedLinks?: number;
}

// id: the new session's id, chosen by the phone. before: the message the copy leaves out with all after it.
// text and attachments (POST /api/upload ids): the fork's first message, which starts it at once. name: the fork's name
// in place of the original's with " (fork)". worktree: the fork runs in a new worktree Claude Code makes by this name
// from the HEAD of the original's folder.
export type ForkArgs = {
  id: string;
  before?: string;
  text?: string;
  attachments?: string[];
  name?: string;
  worktree?: { name: string };
};

// sent: the fork has its first message, from this request or an earlier one with the same id. draft: the message starts
// the conversation, so nothing comes before it; a new session in its folder stands instead.
export type ForkResult = { sessionId: string; cwd: string; title: string; sent?: boolean } | { draft: { cwd: string } };

// lastSeen: the latest message the phone shows; Claude Code refuses when a later turn came. forkId: the id of the new
// session a rewind opens where it cannot happen in place.
export type RewindConversationArgs = {
  userMessageId: string;
  choice: "both" | "conversation";
  lastSeen?: string;
  forkId?: string;
};

// prefill: the message's text, for the composer. files: how rewinding the code went, when asked for. fallback: Claude Code
// could not rewind in place, so a new session stands instead.
export type RewindConversationResult = { prefill: string; files?: RewindResult } & (
  | { mode: "in_place" }
  | { mode: "forked"; sessionId: string; fallback?: boolean }
  | { mode: "draft"; cwd: string }
);

// The session's output style and the styles it can switch to, built-in and custom, as Claude Code lists them.
export interface OutputStyleInfo {
  current: string;
  available: string[];
}

// One file of a session folder's git changes. path: from the repository's top as git names it, "old => new" for a rename,
// whose plain names are previousPath and newPath. hunks: none for a binary, untracked or too large ("large") file, nor
// for one whose contents stay hidden: a key or token file, or one outside the session's folders. cut: lines left out.
export interface GitFileChange {
  path: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied";
  added: number;
  removed: number;
  binary?: boolean;
  untracked?: boolean;
  previousPath?: string;
  newPath?: string;
  hunks?: Hunk[];
  cut?: number;
  large?: boolean;
  hidden?: boolean;
}

// A session folder's git changes as the official diff panel shows them: since the branch left its base branch when it is
// ahead of it (committed and uncommitted together), else since HEAD. state "none": no repository; "busy": mid merge or
// rebase. more: files beyond the ones listed. via: Claude Code worked them out, or ccrc did with git.
export interface GitChanges {
  state: "ok" | "none" | "busy";
  root?: string;
  base?: { branch: string; ref: string };
  stats?: { files: number; added: number; removed: number };
  files: GitFileChange[];
  more?: number;
  via: "claude" | "broker";
}

// A file change a subagent made, from its transcript: the call that made it (id), the subagent, what the subagent is
// for (agent), the tool and when.
export interface AgentFileChange {
  id: string;
  agentId: string;
  agent?: string;
  name: string;
  ts?: string;
  file: string;
  patch: Hunk[];
  patchCut?: number;
}

// The most UTF-8 a side question's thread may take as JSON: with the question it stays well inside one WebSocket message.
export const SIDE_THREAD_BYTES = 256 * 1024;

// An earlier side question and its answer, which a follow-up is asked with.
export interface SideTurn {
  question: string;
  answer: string;
  notice?: string;
}

// The answer to a side question; null when Claude Code had none. synthetic: the text is Claude Code's notice in place of
// an answer. notice: the answer came from another model after a refusal.
export interface SideAnswer {
  answer: string | null;
  synthetic?: boolean;
  notice?: string;
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
  // Copies the conversation into a new session the broker runs: up to a message, or as it stands without a turn that runs.
  // The same id gives the same session.
  fork: { args: ForkArgs; data: ForkResult };
  // Takes the conversation back to before a message: in place where the broker runs the session, else in a new session.
  rewind_conversation: { args: RewindConversationArgs; data: RewindConversationResult };
  stop_task: { args: { taskId: string }; data: Record<string, never> };
  // A subagent's transcript, by its id or else by the Agent call that started it: the latest page, the page before
  // item `before`, or what follows the items the phone holds.
  agent_transcript: { args: { agentId?: string; toolUseId?: string; before?: number; after?: TranscriptAfter }; data: AgentTranscript };
  // The page of the conversation before item `before`, or the items after item `after` up to item `until` (a gap).
  history: { args: { before: string } | { after: string; until?: string }; data: HistoryPage };
  history_find: { args: { find: HistoryFind }; data: { items: DisplayItem[] } };
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
  // The git changes of the session's folder.
  git_changes: { args: Record<string, never>; data: GitChanges };
  // The file changes the session's subagents made; follow: asked again while the sheet stays open.
  agent_changes: { args: { follow?: boolean }; data: AgentFileChange[] };
  // A question beside the conversation that neither interrupts a turn nor enters the conversation, answered after
  // call_progress lines. history: the earlier questions and answers of the same thread. ask: the phone's id for it.
  side_question: { args: { question: string; history?: SideTurn[]; ask?: string }; data: SideAnswer };
  // The side question asked with `ask`, waited for again after the connection dropped; how it ended is kept a while.
  side_question_wait: { args: { ask: string }; data: SideAnswer };
  // Gives up the side question under way, only the one asked with `ask` where given.
  side_question_cancel: { args: { ask?: string }; data: Record<string, never> };
}
export type CallOp = keyof CallMap;
export const CALL_OPS: CallOp[] = ["context", "usage", "mcp_status", "mcp_toggle", "mcp_reconnect", "rewind", "stop_task", "commands", "files", "resume", "output_style", "set_output_style", "unqueue", "rename", "archive"];
// The calls the new-session screen makes about a folder before any session runs in it.
export type FolderOp = "files" | "commands" | "usage" | "git" | "usage_causes";
export const FOLDER_OPS: FolderOp[] = ["files", "commands", "usage", "git", "usage_causes"];

// The agent map's reads, about one session like the calls above.
CALL_OPS.push("agent_transcript", "task_output", "workflow_agents");
CALL_OPS.push("worktree_status", "worktree_remove");
CALL_OPS.push("fork", "rewind_conversation");
CALL_OPS.push("history", "history_find");
CALL_OPS.push("git_changes", "agent_changes", "side_question", "side_question_wait", "side_question_cancel");

export interface CallMap {
  // Marks the session unread until it is opened again, or read.
  mark_unread: { args: { unread: boolean }; data: { unread: boolean } };
}
CALL_OPS.push("mark_unread");

// Keeps what the phone shows of a subagent's transcript or a shell's output current; id names it in "follow" messages.
// after: what the phone holds of the transcript, as for agent_transcript.
export type FollowArgs = { id: string } & ({ kind: "transcript"; agentId?: string; toolUseId?: string; after: TranscriptAfter } | { kind: "output"; taskId: string });

// live: the broker sends changes as they happen; false when it cannot watch, so the phone reads again itself.
// transcript: what changed since `after`; output: the output as it stands.
export interface FollowStart {
  live: boolean;
  transcript?: AgentTranscript;
  output?: TaskOutput;
}

export interface CallMap {
  // Moves a call the turn waits on, a Bash command or a subagent in the foreground, to the background, and the turn goes
  // on. backgrounded: false when it no longer ran in the foreground.
  background: { args: { toolUseId: string }; data: { backgrounded: boolean } };
  follow: { args: FollowArgs; data: FollowStart };
}
CALL_OPS.push("background", "follow");

export interface LiveState {
  // The VS Code wrapper is too old to move calls to the background.
  backgroundUnknown?: boolean;
}

// One image or document of a user message made an upload again, or why it could not be: "unreadable" when it is not one
// the phone attaches, "too_large" past the upload limits.
export type ReattachedFile = { upload: UploadInfo } | { failed: "unreadable" | "too_large" };

// files: in the order the message holds them, as many as one message from the phone carries. gone: the transcript no
// longer holds the message.
export interface ReattachResult {
  files: ReattachedFile[];
  gone?: boolean;
}

// fork_git: the folder call git about the folder a fork of the session starts in. reattach: a message's images and
// documents as uploads, for the message a fork or a rewind puts back in a composer.
export interface CallMap {
  fork_git: { args: Record<string, never>; data: GitFolderInfo };
  reattach: { args: { messageId: string }; data: ReattachResult };
}
CALL_OPS.push("fork_git", "reattach");

// The conversation as a Markdown file, made from the transcript. tools: with a line per tool call; tz: the phone's time
// zone, which the times are written in.
export type ExportArgs = {
  tools?: boolean;
  tz?: string;
};

export interface ExportInfo {
  name: string;
  text: string;
  messages: number;
  // Items left out at the end to keep the file within its limit.
  cut?: number;
}

export interface CallMap {
  export: { args: ExportArgs; data: ExportInfo };
  // Slow: Claude Code reads every transcript of the last seven days.
  usage_causes: { args: Record<string, never>; data: UsageCauses };
}
CALL_OPS.push("export", "usage_causes");

export interface CallMap {
  // Sends text to a session open in another program through its inbox socket; Claude gets it as a message from
  // another session. What becomes of it shows in the transcript.
  inbox_send: { args: { text: string }; data: Record<string, never> };
}
CALL_OPS.push("inbox_send");

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
  // A file Claude sent: whether it changed after it was sent.
  sent?: { changed: boolean };
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

// How the Claude Code processes the broker starts sign in (the brokerSessions setting), and whether one may start now:
// not when it is "off", nor "apiKey" without a key.
export interface BrokerSessionsInfo {
  mode: "off" | "apiKey" | "subscription";
  ready: boolean;
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
  // The VS Code wrapper is too old to change Fast mode and Thinking, or to pass side questions on.
  optionsUnknown?: boolean;
  sideUnknown?: boolean;
  cache?: PromptCache;
  // Changes whenever the session's "/" command list does, so the phone asks for it again.
  commands?: string;
  // A session open in another program that takes messages from here (inbox_send).
  inbox?: InboxInfo;
}

export type ClientMsg =
  | { t: "take_window" }
  // focus: an item to include, when it lies before the latest items a snapshot holds. from: the first item the phone
  // holds, for a snapshot that keeps holding from there.
  | { t: "view"; sessionId: string | null; focus?: string; from?: string }
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
  // The phone no longer shows what it followed.
  | { t: "unfollow"; id: string }
  | { t: "ping" };

// Items a snapshot leaves out between a far-back focused part and the latest items, which start at `before`.
export interface SnapshotGap {
  before: string;
  skipped: number;
}

// The latest part of the conversation, or a focused part and the latest one with a gap between. earlier: the agent and
// to-do calls among the items left out, in order, the last `earlierInGap` of them from the gap.
export interface SnapshotPart {
  items: DisplayItem[];
  hasMore: boolean;
  gap?: SnapshotGap;
  earlier?: DisplayItem[];
  earlierInGap?: number;
}

export type ServerMsg =
  | { t: "ready" }
  | { t: "window_conflict" }
  | { t: "window_taken" }
  | { t: "lease_revoked"; reason: string }
  | ({ t: "snapshot"; sessionId: string; pending: PendingRequest[]; state: LiveState } & SnapshotPart)
  // prev: the item before it in the conversation, null for the first; absent from a broker that does not say.
  | { t: "item"; sessionId: string; item: DisplayItem; prev?: string | null }
  | { t: "stream"; sessionId: string; text: string; thinking: boolean }
  | { t: "pending_add"; sessionId: string; request: PendingRequest }
  | { t: "pending_remove"; sessionId: string; requestId: string }
  | { t: "state"; sessionId: string; state: LiveState }
  | { t: "session_started"; sessionId: string; draftId?: string }
  | { t: "sessions_changed" }
  // What /api/options gives changed: the folders new sessions may start in, or how broker sessions sign in.
  | { t: "options_changed" }
  // The password was set again (`ccrc passwd` while the broker runs): /api/me says when.
  | { t: "login_changed" }
  | { t: "error"; message: string; sessionId?: string; draftId?: string }
  | { t: "call_result"; id: number; ok: boolean; data?: unknown; error?: string }
  // A change in what the phone follows: the transcript since `base`, where the broker's last word left it, or the output
  // as it stands. follow_end: the broker no longer watches it.
  | { t: "follow"; sessionId: string; id: string; base?: { count: number; lastId: string }; transcript?: AgentTranscript; output?: TaskOutput }
  | { t: "follow_end"; sessionId: string; id: string }
  // How a long call is going: Claude Code took the side question up, or retries the API after an error.
  | { t: "call_progress"; id: number; status: "started" | "retry"; attempt?: number; maxRetries?: number; retryInMs?: number }
  | { t: "pong" };
