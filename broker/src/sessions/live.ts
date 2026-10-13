import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface LiveProcess {
  pid: number;
  sessionId: string;
  cwd: string;
  host: string;
  status?: string;
}

const SESSIONS_DIR = path.join(os.homedir(), ".claude", "sessions");
const CACHE_MS = 2000;

const HOSTS: Record<string, string> = {
  "claude-vscode": "VS Code",
  cli: "Terminal",
  "sdk-ts": "SDK",
  "sdk-py": "SDK",
};

let cache: { at: number; list: LiveProcess[] } | undefined;

// Field 22 of /proc/<pid>/stat; Claude Code records the same value as `procStart`.
function startTime(pid: number): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

// Claude Code processes that are running right now, from their registry files.
// A file whose pid is gone or now belongs to another process is ignored.
export function liveProcesses(dir = SESSIONS_DIR): LiveProcess[] {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.list;
  const list: LiveProcess[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {}
  for (const name of names) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      if (typeof r.pid !== "number" || typeof r.sessionId !== "string") continue;
      if (startTime(r.pid) !== String(r.procStart)) continue;
      list.push({
        pid: r.pid,
        sessionId: r.sessionId,
        cwd: r.cwd,
        host: HOSTS[r.entrypoint] ?? r.entrypoint ?? "Claude Code",
        status: r.status,
      });
    } catch {}
  }
  cache = { at: Date.now(), list };
  return list;
}
