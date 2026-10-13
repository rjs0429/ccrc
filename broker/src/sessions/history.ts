import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import type { DisplayItem } from "../protocol.ts";
import { ItemBuilder, type RawMessage } from "./items.ts";

const PROJECTS = path.join(os.homedir(), ".claude", "projects");

export function transcriptPath(sessionId: string, cwd?: string): string | undefined {
  const name = `${sessionId}.jsonl`;
  if (cwd) {
    const guess = path.join(PROJECTS, cwd.replace(/[^a-zA-Z0-9]/g, "-"), name);
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

// The SDK's session reader resolves the conversation chain but drops timestamps; take them from the file.
async function timestamps(file: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const text = await fs.promises.readFile(file, "utf8");
  for (const line of text.split("\n")) {
    if (!line.includes('"timestamp"')) continue;
    try {
      const e = JSON.parse(line) as { uuid?: string; timestamp?: string };
      if (e.uuid && e.timestamp) map.set(e.uuid, e.timestamp);
    } catch {}
  }
  return map;
}

export async function loadHistory(sessionId: string, cwd: string): Promise<DisplayItem[]> {
  const file = transcriptPath(sessionId, cwd);
  const [messages, times] = await Promise.all([
    getSessionMessages(sessionId, { dir: cwd, includeSystemMessages: true }),
    file ? timestamps(file) : Promise.resolve(new Map<string, string>()),
  ]);
  const builder = new ItemBuilder(cwd);
  for (const m of messages) builder.add(m as unknown as RawMessage, times.get(m.uuid));
  return builder.items;
}
