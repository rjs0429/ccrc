import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import type { DisplayItem } from "../protocol.ts";
import { ItemBuilder, type RawMessage } from "./items.ts";

export const PROJECTS = path.join(os.homedir(), ".claude", "projects");
const TRAILING_COMMANDS = 50;

export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function transcriptPath(sessionId: string, cwd?: string): string | undefined {
  const name = `${sessionId}.jsonl`;
  if (cwd) {
    const guess = path.join(PROJECTS, projectDirName(cwd), name);
    if (fs.existsSync(guess)) return guess;
  }
  try {
    for (const dir of fs.readdirSync(PROJECTS)) {
      const p = path.join(PROJECTS, dir, name);
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
// and the ids a subagent's or workflow's transcript is kept under.
const OUTPUT_KEYS = ["structuredPatch", "totalToolUseCount", "answers", "planWasEdited", "agentId", "runId"];

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

// The SDK's session reader resolves the conversation chain but drops timestamps, structured tool
// output and local command results; take them from the file. Only the outputs items are built from are kept.
async function rows(file: string): Promise<Rows> {
  const out = noRows();
  const text = await fs.promises.readFile(file, "utf8");
  for (const line of text.split("\n")) {
    if (!line.includes('"timestamp"') && !line.includes('"last-prompt"')) continue;
    try {
      const e = JSON.parse(line) as FileRow;
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
    } catch {}
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
  const [messages, r] = await Promise.all([getSessionMessages(sessionId, { includeSystemMessages: true }), file ? rows(file) : Promise.resolve(noRows())]);
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

export async function loadHistory(sessionId: string, cwd: string): Promise<DisplayItem[]> {
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
