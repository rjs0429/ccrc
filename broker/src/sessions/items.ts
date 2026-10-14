import type { DisplayItem, Hunk, NoteCode, SubagentActivity, ToolResult } from "../protocol.ts";

const RESULT_LIMIT = 4000;
const INPUT_STRING_LIMIT = 2000;
const SUMMARY_LIMIT = 120;
const PATCH_LINES = 800;
const PATCH_LINE_LIMIT = 500;
const SUB_RECENT = 5;
const SUB_TEXT_LIMIT = 200;

type Block = { type: string; [key: string]: unknown };
type ToolItem = Extract<DisplayItem, { kind: "tool" }>;

// The subset of SDK and transcript messages that the conversation view uses.
export interface RawMessage {
  type: string;
  subtype?: string;
  uuid?: string;
  timestamp?: string;
  parent_tool_use_id?: string | null;
  isSynthetic?: boolean;
  message?: { content?: string | Block[] };
  content?: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  // A tool's structured output next to its tool_result: tool_use_result live, toolUseResult in a transcript.
  tool_use_result?: unknown;
  toolUseResult?: unknown;
  // task_progress and task_notification: the call that started the task and its tool count so far.
  tool_use_id?: string;
  usage?: { tool_uses?: unknown };
}

// Text blocks that carry editor or harness context rather than something the user typed.
const CONTEXT_TAGS =
  /^<(system-reminder|ide_opened_file|ide_selection|ide_diagnostics|local-command-caveat|task-notification|user-prompt-submit-hook)>[\s\S]*<\/\1>$/;
const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]$/;

function clipText(text: string, limit: number): { text: string; truncated: boolean } {
  return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false };
}

function clipped(text: string, limit: number): string {
  const c = clipText(text, limit);
  return c.truncated ? `${c.text}…` : c.text;
}

const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return clipText(line.trim(), SUMMARY_LIMIT).text;
}

// Tool input with long strings shortened for display.
export function clipInput(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return clipped(value, INPUT_STRING_LIMIT);
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => clipInput(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clipInput(v, depth + 1)]));
}

function relative(file: string, cwd: string): string {
  return file.startsWith(cwd + "/") ? file.slice(cwd.length + 1) : file;
}

export function summarizeTool(name: string, input: unknown, cwd: string): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const s = (key: string) => (typeof i[key] === "string" ? (i[key] as string) : "");
  switch (name) {
    case "Bash":
      return firstLine(s("description") || s("command"));
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return relative(s("file_path"), cwd);
    case "NotebookEdit":
      return relative(s("notebook_path"), cwd);
    case "Grep":
      return firstLine(s("pattern") + (s("path") ? ` · ${relative(s("path"), cwd)}` : ""));
    case "Glob":
      return firstLine(s("pattern"));
    case "WebFetch":
      return firstLine(s("url"));
    case "WebSearch":
      return firstLine(s("query"));
    case "Task":
    case "Agent":
      return firstLine(s("description") || s("subagent_type"));
    case "TodoWrite":
      return Array.isArray(i.todos) ? String(i.todos.length) : "";
    case "TaskCreate":
      return firstLine(s("subject"));
    case "TaskUpdate":
      return `#${s("taskId")} ${s("status")}`.trim();
    case "AskUserQuestion": {
      const q = Array.isArray(i.questions) ? (i.questions[0] as { question?: unknown } | undefined)?.question : undefined;
      return typeof q === "string" ? firstLine(q) : "";
    }
    default: {
      const v = Object.values(i).find((x) => typeof x === "string");
      return typeof v === "string" ? firstLine(v) : "";
    }
  }
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    .map((b: Block) => (b.type === "text" ? String(b.text ?? "") : b.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

function hunks(value: unknown): Hunk[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => {
    const h = record(v);
    if (!h || !Array.isArray(h.lines)) return [];
    const n = (key: string) => (typeof h[key] === "number" ? (h[key] as number) : 0);
    const lines = h.lines.filter((l): l is string => typeof l === "string");
    return [{ oldStart: n("oldStart"), oldLines: n("oldLines"), newStart: n("newStart"), newLines: n("newLines"), lines }];
  });
}

function createdFile(content: string): Hunk {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return { oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l) => `+${l}`) };
}

// Keeps the first PATCH_LINES lines of a change. Hunk headers keep their full counts.
function capPatch(all: Hunk[]): { patch: Hunk[]; patchCut?: number } {
  const patch: Hunk[] = [];
  let room = PATCH_LINES;
  let cut = 0;
  for (const h of all) {
    const lines = h.lines.slice(0, room);
    cut += h.lines.length - lines.length;
    room -= lines.length;
    if (lines.length || !h.lines.length) patch.push({ ...h, lines: lines.map((l) => clipped(l, PATCH_LINE_LIMIT)) });
  }
  return cut ? { patch, patchCut: cut } : { patch };
}

// The file a tool changed and how, from its structured output (Edit, Write, MultiEdit). Claude Code
// reports a newly written file without hunks, so its whole content becomes one added hunk.
function fileChange(output: unknown): Pick<ToolItem, "file" | "patch" | "patchCut"> {
  const r = record(output);
  if (!r || typeof r.filePath !== "string" || !Array.isArray(r.structuredPatch) || r.staged === true) return {};
  let all = hunks(r.structuredPatch);
  if (!all.length && r.type === "create" && typeof r.content === "string") all = [createdFile(r.content)];
  return all.length ? { file: r.filePath, ...capPatch(all) } : {};
}

// The activity with the tool count Claude Code reports for a subagent, when that is more than was seen here.
function counted(sub: SubagentActivity | undefined, tools: unknown): SubagentActivity | undefined {
  const known = sub?.tools ?? 0;
  if (typeof tools !== "number" || tools <= known) return undefined;
  return { recent: [], ...sub, tools };
}

function commandNote(text: string): { code: NoteCode; text?: string } | null | undefined {
  if (INTERRUPTED.test(text)) return { code: "interrupted" };
  const name = text.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1];
  if (name !== undefined) {
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] ?? "";
    return { code: "command", text: `${name.trim()} ${args.trim()}`.trim() };
  }
  const out = text.match(/^<local-command-(stdout|stderr)>([\s\S]*)<\/local-command-\1>$/);
  if (out) return out[2].trim() ? { code: "command_output", text: out[2].trim() } : null;
  return undefined;
}

// Turns SDK messages (live or from a transcript) into conversation items. Items keep stable ids
// (message uuid and block index, or tool_use id) so live updates and reloads line up.
export class ItemBuilder {
  items: DisplayItem[] = [];
  private pos = new Map<string, number>();
  // Tool calls made inside subagents, by id, mapped to the top-level call whose item shows them.
  private subCalls = new Map<string, string>();
  private cwd: string;
  private noteCount = 0;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  private put(item: DisplayItem): DisplayItem {
    const at = this.pos.get(item.id);
    if (at === undefined) {
      this.pos.set(item.id, this.items.length);
      this.items.push(item);
    } else {
      this.items[at] = item;
    }
    return item;
  }

  seed(items: DisplayItem[]): void {
    this.items = [...items];
    this.pos = new Map(this.items.map((item, i) => [item.id, i]));
  }

  // Puts earlier items in front of the ones built so far; an item built here wins over the same id from before.
  merge(earlier: DisplayItem[]): void {
    const later = this.items;
    this.seed(earlier);
    for (const item of later) this.put(item);
  }

  note(code: NoteCode, text?: string, ts?: string, id?: string): DisplayItem | undefined {
    const last = this.items.at(-1);
    if (code === "interrupted" && last?.kind === "note" && last.code === "interrupted") return undefined;
    return this.put({ kind: "note", id: id ?? `note-${++this.noteCount}`, ts, code, ...(text ? { text } : {}) });
  }

  userText(id: string, text: string, ts?: string, images?: number, files?: string[]): DisplayItem {
    return this.put({ kind: "user", id, ts, text, ...(images ? { images } : {}), ...(files?.length ? { files } : {}) });
  }

  add(m: RawMessage, fallbackTs?: string): DisplayItem[] {
    if (m.parent_tool_use_id) return this.subagent(m, m.parent_tool_use_id);
    const ts = m.timestamp ?? fallbackTs;
    switch (m.type) {
      case "user":
        return this.user(m, ts);
      case "assistant":
        return this.assistant(m, ts);
      case "system":
        return this.system(m, ts);
      case "result":
        return this.result(m, ts);
      default:
        return [];
    }
  }

  private user(m: RawMessage, ts?: string): DisplayItem[] {
    const out: DisplayItem[] = [];
    const content = m.message?.content;
    const blocks: Block[] = typeof content === "string" ? [{ type: "text", text: content }] : (content ?? []);
    const texts: string[] = [];
    const files: string[] = [];
    let images = 0;
    const results = blocks.filter((b) => b.type === "tool_result").length;
    const output = results === 1 ? (m.tool_use_result ?? m.toolUseResult) : undefined;
    for (const b of blocks) {
      if (b.type === "tool_result") out.push(this.toolResult(b, output));
      else if (b.type === "image") images++;
      else if (b.type === "document") files.push(String(b.title ?? ""));
      else if (b.type === "text") {
        const text = String(b.text ?? "").trim();
        if (text && !CONTEXT_TAGS.test(text)) texts.push(text);
      }
    }
    if (m.isSynthetic || (!texts.length && !images && !files.length)) return out;
    const text = texts.join("\n\n");
    const special = commandNote(text);
    if (special === null) return out;
    const id = m.uuid ?? `user-${this.items.length}`;
    const item = special ? this.note(special.code, special.text, ts, id) : this.userText(id, text, ts, images, files);
    if (item) out.push(item);
    return out;
  }

  private assistant(m: RawMessage, ts?: string): DisplayItem[] {
    const out: DisplayItem[] = [];
    const blocks = Array.isArray(m.message?.content) ? m.message.content : [];
    blocks.forEach((b, i) => {
      const id = `${m.uuid}:${i}`;
      if (b.type === "text" && String(b.text ?? "").trim()) {
        out.push(this.put({ kind: "assistant", id, ts, text: String(b.text) }));
      } else if (b.type === "thinking" && String(b.thinking ?? "").trim()) {
        out.push(this.put({ kind: "thinking", id, ts, text: String(b.thinking) }));
      } else if (b.type === "tool_use") {
        const toolId = String(b.id);
        const name = String(b.name);
        // What was learned from its result or subagent stays when the call is seen again.
        const prev = this.tool(toolId);
        out.push(this.put({ ...prev, kind: "tool", id: toolId, ts, name, summary: summarizeTool(name, b.input, this.cwd), input: clipInput(b.input) }));
      }
    });
    return out;
  }

  private tool(id: string): ToolItem | undefined {
    const at = this.pos.get(id);
    const item = at === undefined ? undefined : this.items[at];
    return item?.kind === "tool" ? item : undefined;
  }

  private toolResult(b: Block, output: unknown): DisplayItem {
    const id = String(b.tool_use_id);
    const text = clipText(resultText(b.content), RESULT_LIMIT);
    const result: ToolResult = { text: text.text, isError: b.is_error === true, truncated: text.truncated };
    const prev: ToolItem = this.tool(id) ?? { kind: "tool", id, name: "", summary: "", input: null };
    if (result.isError) return this.put({ ...prev, result });
    const sub = counted(prev.sub, record(output)?.totalToolUseCount);
    return this.put({ ...prev, result, ...fileChange(output), ...(sub ? { sub } : {}) });
  }

  // Folds a subagent's messages into the call that started it: how many tools it used, the last few,
  // and its latest text. Calls of subagents it starts in turn count toward the same item.
  private subagent(m: RawMessage, parentId: string): DisplayItem[] {
    const owner = this.tool(this.subCalls.get(parentId) ?? parentId);
    if (!owner || m.type !== "assistant" || !Array.isArray(m.message?.content)) return [];
    let sub: SubagentActivity = owner.sub ?? { tools: 0, recent: [] };
    let changed = false;
    for (const b of m.message.content) {
      if (b.type === "tool_use") {
        const id = String(b.id);
        if (this.subCalls.has(id)) continue;
        this.subCalls.set(id, owner.id);
        const name = String(b.name);
        const recent = [...sub.recent, { name, summary: summarizeTool(name, b.input, this.cwd) }].slice(-SUB_RECENT);
        sub = { ...sub, tools: sub.tools + 1, recent };
        changed = true;
      } else if (b.type === "text" && String(b.text ?? "").trim()) {
        sub = { ...sub, text: clipped(String(b.text).trim(), SUB_TEXT_LIMIT) };
        changed = true;
      }
    }
    return changed ? [this.put({ ...owner, sub })] : [];
  }

  private system(m: RawMessage, ts?: string): DisplayItem[] {
    let item: DisplayItem | undefined;
    if (m.subtype === "compact_boundary") item = this.note("compacted", undefined, ts, m.uuid);
    else if (m.subtype === "local_command_output" && m.content?.trim()) item = this.note("command_output", m.content.trim(), ts, m.uuid);
    else if ((m.subtype === "task_progress" || m.subtype === "task_notification") && m.tool_use_id) item = this.taskTools(m.tool_use_id, m.usage?.tool_uses);
    return item ? [item] : [];
  }

  // A subagent that runs in the background reports its progress through task events.
  private taskTools(toolUseId: string, tools: unknown): DisplayItem | undefined {
    const owner = this.tool(toolUseId);
    const sub = owner && counted(owner.sub, tools);
    return owner && sub ? this.put({ ...owner, sub }) : undefined;
  }

  private result(m: RawMessage, ts?: string): DisplayItem[] {
    if (!m.is_error) return [];
    const item =
      m.subtype === "error_during_execution"
        ? this.note("interrupted", undefined, ts)
        : this.note("error", m.result || m.errors?.join("\n") || m.subtype, ts);
    return item ? [item] : [];
  }
}
