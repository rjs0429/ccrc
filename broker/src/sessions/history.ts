import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import type { DisplayItem } from "../protocol.ts";
import { ItemBuilder, type RawMessage } from "./items.ts";

const PROJECTS = path.join(os.homedir(), ".claude", "projects");

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

interface Row {
  timestamp?: string;
  toolUseResult?: unknown;
}

// The SDK's session reader resolves the conversation chain but drops timestamps and structured tool
// output; take them from the file. Only the outputs items are built from (file patches, subagent totals)
// are kept.
async function rows(file: string): Promise<Map<string, Row>> {
  const map = new Map<string, Row>();
  const text = await fs.promises.readFile(file, "utf8");
  for (const line of text.split("\n")) {
    if (!line.includes('"timestamp"')) continue;
    try {
      const e = JSON.parse(line) as Row & { uuid?: string };
      const out = e.toolUseResult;
      const used = out !== null && typeof out === "object" && ("structuredPatch" in out || "totalToolUseCount" in out);
      if (e.uuid) map.set(e.uuid, { timestamp: e.timestamp, ...(used ? { toolUseResult: out } : {}) });
    } catch {}
  }
  return map;
}

export async function loadHistory(sessionId: string, cwd: string): Promise<DisplayItem[]> {
  const file = transcriptPath(sessionId, cwd);
  const [messages, extra] = await Promise.all([
    getSessionMessages(sessionId, { includeSystemMessages: true }),
    file ? rows(file) : Promise.resolve(new Map<string, Row>()),
  ]);
  const builder = new ItemBuilder(cwd);
  for (const m of messages) {
    const row = extra.get(m.uuid);
    builder.add({ ...(m as unknown as RawMessage), toolUseResult: row?.toolUseResult }, row?.timestamp);
  }
  return builder.items;
}
