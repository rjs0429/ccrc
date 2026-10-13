import type { DisplayItem, NoteCode, ToolResult } from "../protocol.ts";

const RESULT_LIMIT = 4000;
const INPUT_STRING_LIMIT = 2000;
const SUMMARY_LIMIT = 120;

type Block = { type: string; [key: string]: unknown };

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
}

// Text blocks that carry editor or harness context rather than something the user typed.
const CONTEXT_TAGS =
  /^<(system-reminder|ide_opened_file|ide_selection|ide_diagnostics|local-command-caveat|task-notification|user-prompt-submit-hook)>[\s\S]*<\/\1>$/;
const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]$/;

function clipText(text: string, limit: number): { text: string; truncated: boolean } {
  return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false };
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return clipText(line.trim(), SUMMARY_LIMIT).text;
}

// Tool input with long strings shortened for display.
export function clipInput(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    const c = clipText(value, INPUT_STRING_LIMIT);
    return c.truncated ? `${c.text}…` : c.text;
  }
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

  note(code: NoteCode, text?: string, ts?: string, id?: string): DisplayItem | undefined {
    const last = this.items.at(-1);
    if (code === "interrupted" && last?.kind === "note" && last.code === "interrupted") return undefined;
    return this.put({ kind: "note", id: id ?? `note-${++this.noteCount}`, ts, code, ...(text ? { text } : {}) });
  }

  userText(id: string, text: string, ts?: string, images?: number): DisplayItem {
    return this.put({ kind: "user", id, ts, text, ...(images ? { images } : {}) });
  }

  add(m: RawMessage, fallbackTs?: string): DisplayItem[] {
    if (m.parent_tool_use_id) return [];
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
    let images = 0;
    for (const b of blocks) {
      if (b.type === "tool_result") out.push(this.toolResult(b));
      else if (b.type === "image") images++;
      else if (b.type === "text") {
        const text = String(b.text ?? "").trim();
        if (text && !CONTEXT_TAGS.test(text)) texts.push(text);
      }
    }
    if (m.isSynthetic || (!texts.length && !images)) return out;
    const text = texts.join("\n\n");
    const special = commandNote(text);
    if (special === null) return out;
    const id = m.uuid ?? `user-${this.items.length}`;
    const item = special ? this.note(special.code, special.text, ts, id) : this.userText(id, text, ts, images);
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
        const at = this.pos.get(toolId);
        const prev = at === undefined ? undefined : this.items[at];
        const name = String(b.name);
        out.push(
          this.put({
            kind: "tool",
            id: toolId,
            ts,
            name,
            summary: summarizeTool(name, b.input, this.cwd),
            input: clipInput(b.input),
            ...(prev?.kind === "tool" && prev.result ? { result: prev.result } : {}),
          }),
        );
      }
    });
    return out;
  }

  private toolResult(b: Block): DisplayItem {
    const id = String(b.tool_use_id);
    const clipped = clipText(resultText(b.content), RESULT_LIMIT);
    const result: ToolResult = { text: clipped.text, isError: b.is_error === true, truncated: clipped.truncated };
    const at = this.pos.get(id);
    const prev = at === undefined ? undefined : this.items[at];
    if (prev?.kind === "tool") return this.put({ ...prev, result });
    return this.put({ kind: "tool", id, name: "", summary: "", input: null, result });
  }

  private system(m: RawMessage, ts?: string): DisplayItem[] {
    let item: DisplayItem | undefined;
    if (m.subtype === "compact_boundary") item = this.note("compacted", undefined, ts, m.uuid);
    else if (m.subtype === "local_command_output" && m.content?.trim()) item = this.note("command_output", m.content.trim(), ts, m.uuid);
    return item ? [item] : [];
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
