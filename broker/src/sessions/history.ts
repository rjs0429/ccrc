import fs from "node:fs";
import path from "node:path";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { paths } from "../paths.ts";
import type { DisplayItem } from "../protocol.ts";
import { ItemBuilder, type RawMessage } from "./items.ts";

const TRAILING_COMMANDS = 50;

export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function transcriptPath(sessionId: string, cwd?: string): string | undefined {
  const name = `${sessionId}.jsonl`;
  const projects = paths.claudeProjectsDir;
  if (cwd) {
    const guess = path.join(projects, projectDirName(cwd), name);
    if (fs.existsSync(guess)) return guess;
  }
  try {
    for (const dir of fs.readdirSync(projects)) {
      const p = path.join(projects, dir, name);
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  return undefined;
}

const TAIL_BYTES = 256 * 1024;

// The working directory the transcript's last lines were written in.
export async function lastCwd(sessionId: string, cwd: string): Promise<string | undefined> {
  const file = transcriptPath(sessionId, cwd);
  if (!file) return undefined;
  try {
    const fh = await fs.promises.open(file, "r");
    try {
      const { size } = await fh.stat();
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      const found = [...buf.toString("utf8").matchAll(/"cwd":("(?:[^"\\]|\\.)*")/g)].pop();
      const dir = found ? (JSON.parse(found[1]) as unknown) : undefined;
      return typeof dir === "string" && path.isAbsolute(dir) ? dir : undefined;
    } finally {
      await fh.close();
    }
  } catch {
    return undefined;
  }
}

interface Row {
  timestamp?: string;
  toolUseResult?: unknown;
  command?: Pick<RawMessage, "subtype" | "content" | "local_command_run" | "usage_report" | "context_usage">;
}

interface FileRow {
  uuid?: string;
  parentUuid?: string | null;
  type?: string;
  subtype?: string;
  timestamp?: string;
  toolUseResult?: unknown;
  content?: unknown;
  commandRun?: unknown;
  usageReport?: unknown;
  contextUsage?: unknown;
  isSidechain?: boolean;
  isMeta?: boolean;
  message?: { content?: unknown };
  attachment?: { type?: string; source_uuid?: unknown };
  source_uuid?: unknown;
  leafUuid?: string | null;
  explicit?: boolean;
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  origin?: { kind?: unknown };
  logicalParentUuid?: string | null;
}

// The rows Claude Code counts as the conversation's; one written after a rewind's last-prompt row ends the rewind.
const MESSAGE_ROWS = new Set<unknown>(["user", "assistant", "attachment", "system"]);

// Where a rewind left the conversation, as Claude Code reads the transcript: the row it kept last, or null when it
// rewound to before the first message. A last-prompt row that names the same row again keeps it.
type Rewound = { leaf: string | null } | undefined;

function rewoundAt(was: Rewound, e: FileRow): Rewound {
  if (typeof e.leafUuid === "string" && e.leafUuid) return e.explicit === true || was?.leaf === e.leafUuid ? { leaf: e.leafUuid } : undefined;
  return e.leafUuid === null && e.explicit === true ? { leaf: null } : was;
}

const counts = (e: FileRow) => MESSAGE_ROWS.has(e.type) && !e.isSidechain && e.attachment?.type !== "fork_briefing";

// The structured tool outputs items are built from: file patches, subagent totals, question answers, edited plans,
// the ids a subagent's or workflow's transcript is kept under, and the files Claude sent.
const OUTPUT_KEYS = ["structuredPatch", "totalToolUseCount", "answers", "planWasEdited", "agentId", "runId", "attachments"];

export function usedOutput(out: unknown): boolean {
  return out !== null && typeof out === "object" && OUTPUT_KEYS.some((k) => k in out);
}

// A local command's result row, which the SDK's reader returns without its subtype and content.
function commandRow(e: FileRow): Row["command"] {
  if (e.type !== "system" || e.subtype !== "local_command" || typeof e.content !== "string") return undefined;
  return { subtype: e.subtype, content: e.content, local_command_run: e.commandRun, usage_report: e.usageReport, context_usage: e.contextUsage };
}

interface Rows {
  map: Map<string, Row>;
  after: Map<string, string>;
  parents: Map<string, string | null>;
  // A message sent while Claude worked is kept on a queued_command row; the reader names it by the message's own uuid.
  aliases: Map<string, string>;
  rewound: Rewound;
}

const noRows = (): Rows => ({ map: new Map(), after: new Map(), parents: new Map(), aliases: new Map(), rewound: undefined });

const CHUNK_BYTES = 1024 * 1024;

// The rows of the file from the earliest one that names a message in `wanted` to its end, read from the end back.
async function lastRows(file: string, wanted: Set<string>): Promise<FileRow[]> {
  const missing = new Set(wanted);
  const found: FileRow[] = [];
  const take = (line: Buffer) => {
    const text = line.toString("utf8");
    if (!text.includes('"timestamp"') && !text.includes('"last-prompt"')) return;
    try {
      const e = JSON.parse(text) as FileRow;
      found.push(e);
      if (e.uuid) missing.delete(e.uuid);
      if (typeof e.attachment?.source_uuid === "string") missing.delete(e.attachment.source_uuid);
    } catch {}
  };
  const fh = await fs.promises.open(file, "r");
  try {
    let pos = (await fh.stat()).size;
    let rest = Buffer.alloc(0);
    while (pos > 0 && missing.size) {
      const start = Math.max(0, pos - CHUNK_BYTES);
      const buf = Buffer.alloc(pos - start);
      await fh.read(buf, 0, buf.length, start);
      pos = start;
      const data = rest.length ? Buffer.concat([buf, rest]) : buf;
      let end = data.length;
      while (missing.size && end > 0) {
        const nl = data.lastIndexOf(10, end - 1);
        if (nl < 0) break;
        take(data.subarray(nl + 1, end));
        end = nl;
      }
      rest = data.subarray(0, end);
      if (pos === 0 && missing.size) take(rest);
    }
  } finally {
    await fh.close();
  }
  return found.reverse();
}

// The SDK's session reader resolves the conversation chain but drops timestamps, structured tool
// output and local command results; take them from the file, from the first message it returned on (what came before
// does not bear on its messages, their trailing commands or a rewind after them). Only the outputs items are built
// from are kept.
async function rows(file: string, wanted: Set<string>): Promise<Rows> {
  const out = noRows();
  for (const e of await lastRows(file, wanted)) {
    if (e.type === "last-prompt") {
      out.rewound = rewoundAt(out.rewound, e);
      continue;
    }
    const output = e.toolUseResult;
    const used = usedOutput(output);
    const command = commandRow(e);
    if (!e.uuid) continue;
    if (counts(e)) out.rewound = undefined;
    out.parents.set(e.uuid, e.parentUuid ?? null);
    if (e.attachment?.type === "queued_command" && typeof e.attachment.source_uuid === "string") out.aliases.set(e.uuid, e.attachment.source_uuid);
    out.map.set(e.uuid, { timestamp: e.timestamp, ...(used ? { toolUseResult: output } : {}), ...(command ? { command } : {}) });
    if (command && e.parentUuid) out.after.set(e.parentUuid, e.uuid);
  }
  return out;
}

type Message = Awaited<ReturnType<typeof getSessionMessages>>[number];

// The reader follows the branch written last, so a rewind no message followed yet ends the conversation where it left
// it: at the row it kept, or the nearest one above it the reader returns.
function untilRewind(messages: Message[], r: Rows): Message[] {
  if (!r.rewound) return messages;
  if (r.rewound.leaf === null) return [];
  const at = new Map(messages.map((m, i) => [m.uuid, i]));
  const seen = new Set<string>();
  for (let id: string | null | undefined = r.rewound.leaf; id && !seen.has(id); id = r.parents.get(id)) {
    seen.add(id);
    const i = at.get(id) ?? at.get(r.aliases.get(id) ?? "");
    if (i !== undefined) return messages.slice(0, i + 1);
  }
  return messages;
}

async function read(sessionId: string, cwd: string): Promise<{ messages: Message[]; rows: Rows }> {
  const file = transcriptPath(sessionId, cwd);
  const messages = await getSessionMessages(sessionId, { includeSystemMessages: true });
  const r = file ? await rows(file, new Set(messages.map((m) => m.uuid))) : noRows();
  return { messages: untilRewind(messages, r), rows: r };
}

// The conversation as Claude Code resumes it.
export async function currentMessages(sessionId: string, cwd: string): Promise<Message[]> {
  return (await read(sessionId, cwd)).messages;
}

const CAVEAT = "<local-command-caveat>";

function caveat(e: FileRow): boolean {
  const c = e.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? (c[0] as { text?: unknown } | undefined)?.text : undefined;
  return e.type === "user" && e.isMeta === true && typeof text === "string" && text.startsWith(CAVEAT);
}

// Where a copy that leaves out message `messageId` and all after it ends: the row it hangs from (its queued_command or
// stand-in row for one sent while Claude worked, a local command with its caveat row), else the message read before it;
// `at` absent when the message starts the conversation, undefined when it is not there.
export async function forkPoint(sessionId: string, cwd: string, messageId: string): Promise<{ at?: string } | undefined> {
  const file = transcriptPath(sessionId, cwd);
  if (file) {
    const found = new Map<string, { parent: string | null; caveat: boolean }>();
    let hit: string | null | undefined;
    for (const line of (await fs.promises.readFile(file, "utf8")).split("\n")) {
      if (!line.includes('"uuid"')) continue;
      try {
        const e = JSON.parse(line) as FileRow;
        if (!e.uuid || e.isSidechain) continue;
        found.set(e.uuid, { parent: e.parentUuid ?? null, caveat: caveat(e) });
        const source = e.type === "attachment" && e.attachment?.type === "queued_command" ? e.attachment.source_uuid : e.type === "system" && e.subtype === "rewind_stand_in" ? e.source_uuid : undefined;
        if (e.uuid === messageId || source === messageId) hit = e.parentUuid ?? null;
      } catch {}
    }
    if (hit !== undefined) {
      const above = hit ? found.get(hit) : undefined;
      const at = above?.caveat ? above.parent : hit;
      return at ? { at } : {};
    }
  }
  const messages = await currentMessages(sessionId, cwd);
  const i = messages.findIndex((m) => m.uuid === messageId);
  if (i < 0) return undefined;
  return i > 0 ? { at: messages[i - 1].uuid } : {};
}

// Text Claude Code writes in a user row that starts no turn: an interruption's mark, a local or shell command's output.
const NO_TURN = /^(?:\[Request interrupted by user[^\]]*\]$|<(?:local-command-std(?:out|err)|bash-std(?:out|err))>)/;

// A row that starts a turn: what the user sent, a command among it, or a message or notice Claude Code took in while it
// waited. A message sent while Claude worked joins the turn on an attachment row; tool results and context rows are its own.
function startsTurn(e: FileRow): boolean {
  if (e.type !== "user" || e.isCompactSummary || e.isVisibleInTranscriptOnly) return false;
  if (e.isMeta && (e.origin?.kind === undefined || e.origin.kind === "human")) return false;
  const c = e.message?.content;
  const first = (typeof c === "string" ? { type: "text", text: c } : Array.isArray(c) ? c[0] : undefined) as { type?: unknown; text?: unknown } | undefined;
  if (first?.type === "tool_result") return false;
  return !(first?.type === "text" && typeof first.text === "string" && NO_TURN.test(first.text.trim()));
}

// Where a copy that leaves out the turn running now ends: the row above the one that started it, a local command with its
// caveat row. `at` absent when that turn starts the conversation, undefined when the transcript shows no turn.
export async function turnPoint(sessionId: string, cwd: string): Promise<{ at?: string } | undefined> {
  const file = transcriptPath(sessionId, cwd);
  if (!file) return undefined;
  const found = new Map<string, { parent: string | null; caveat: boolean; starts: boolean }>();
  let leaf: string | undefined;
  for (const line of (await fs.promises.readFile(file, "utf8")).split("\n")) {
    if (!line.includes('"uuid"')) continue;
    try {
      const e = JSON.parse(line) as FileRow;
      if (!e.uuid || e.isSidechain) continue;
      found.set(e.uuid, { parent: e.parentUuid ?? e.logicalParentUuid ?? null, caveat: caveat(e), starts: startsTurn(e) });
      if (counts(e)) leaf = e.uuid;
    } catch {}
  }
  const seen = new Set<string>();
  for (let id = leaf; id && !seen.has(id); id = found.get(id)?.parent ?? undefined) {
    seen.add(id);
    const row = found.get(id);
    if (!row?.starts) continue;
    const above = row.parent ? found.get(row.parent) : undefined;
    const at = above?.caveat ? above.parent : row.parent;
    return at ? { at } : {};
  }
  return undefined;
}

const KEPT_MAX = 6;
// Built conversations by transcript and folder, latest used last, with the size and time of the file they were read
// from; a file that changed since is read again. Callers share the arrays and must not change them.
const kept = new Map<string, { size: number; mtimeMs: number; items: DisplayItem[] }>();
const building = new Map<string, Promise<DisplayItem[]>>();

export async function loadHistory(sessionId: string, cwd: string): Promise<DisplayItem[]> {
  const file = transcriptPath(sessionId, cwd);
  const stat = file ? await fs.promises.stat(file).catch(() => undefined) : undefined;
  if (!file || !stat) return build(sessionId, cwd);
  const key = `${file}\0${cwd}`;
  const hit = kept.get(key);
  if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) {
    kept.delete(key);
    kept.set(key, hit);
    return hit.items;
  }
  const at = `${key}\0${stat.size}\0${stat.mtimeMs}`;
  let p = building.get(at);
  if (!p) {
    p = build(sessionId, cwd).finally(() => building.delete(at));
    building.set(at, p);
  }
  const items = await p;
  const now = await fs.promises.stat(file).catch(() => undefined);
  if (now && now.size === stat.size && now.mtimeMs === stat.mtimeMs) {
    kept.delete(key);
    kept.set(key, { size: stat.size, mtimeMs: stat.mtimeMs, items });
    for (const old of [...kept.keys()].slice(0, -KEPT_MAX)) kept.delete(old);
  }
  return items;
}

async function build(sessionId: string, cwd: string): Promise<DisplayItem[]> {
  const {
    messages,
    rows: { map: extra, after },
  } = await read(sessionId, cwd);
  const builder = new ItemBuilder(cwd);
  for (const m of messages) {
    const row = extra.get(m.uuid);
    builder.add({ ...(m as unknown as RawMessage), toolUseResult: row?.toolUseResult, ...row?.command }, row?.timestamp);
  }
  // The reader's chain ends at the last user or assistant message, before the results of commands run last.
  let tail = messages.at(-1)?.uuid;
  for (let n = 0; tail && after.has(tail) && n < TRAILING_COMMANDS; n++) {
    tail = after.get(tail)!;
    const row = extra.get(tail);
    if (row?.command) builder.add({ type: "system", uuid: tail, ...row.command }, row.timestamp);
  }
  return builder.items;
}
