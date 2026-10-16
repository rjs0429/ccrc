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
}

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

// The SDK's session reader resolves the conversation chain but drops timestamps, structured tool
// output and local command results; take them from the file. Only the outputs items are built from are kept.
async function rows(file: string): Promise<{ map: Map<string, Row>; after: Map<string, string> }> {
  const map = new Map<string, Row>();
  const after = new Map<string, string>();
  const text = await fs.promises.readFile(file, "utf8");
  for (const line of text.split("\n")) {
    if (!line.includes('"timestamp"')) continue;
    try {
      const e = JSON.parse(line) as FileRow;
      const out = e.toolUseResult;
      const used = usedOutput(out);
      const command = commandRow(e);
      if (!e.uuid) continue;
      map.set(e.uuid, { timestamp: e.timestamp, ...(used ? { toolUseResult: out } : {}), ...(command ? { command } : {}) });
      if (command && e.parentUuid) after.set(e.parentUuid, e.uuid);
    } catch {}
  }
  return { map, after };
}

export async function loadHistory(sessionId: string, cwd: string): Promise<DisplayItem[]> {
  const file = transcriptPath(sessionId, cwd);
  const [messages, { map: extra, after }] = await Promise.all([
    getSessionMessages(sessionId, { includeSystemMessages: true }),
    file ? rows(file) : Promise.resolve({ map: new Map<string, Row>(), after: new Map<string, string>() }),
  ]);
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
