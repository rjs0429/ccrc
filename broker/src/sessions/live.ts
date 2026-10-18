import fs from "node:fs";
import path from "node:path";
import { paths } from "../paths.ts";
import { INBOX_PROTOCOL } from "./inbox.ts";

// inbox: the session's inbox socket, when it speaks the line format ccrc knows.
export interface LiveProcess {
  pid: number;
  sessionId: string;
  cwd: string;
  host: string;
  status?: string;
  procStart: string;
  inbox?: string;
}

const CACHE_MS = 2000;

const HOSTS: Record<string, string> = {
  "claude-vscode": "VS Code",
  cli: "Terminal",
  "sdk-cli": "SDK",
  "sdk-ts": "SDK",
  "sdk-py": "SDK",
};

// A background session (claude --bg) runs Claude Code's terminal screen, which `claude agents` and `claude attach` open.
const BACKGROUND = "Background";

let cache: { at: number; list: LiveProcess[] } | undefined;

// Field 22 of /proc/<pid>/stat; Claude Code records the same value as `procStart`.
export function startTime(pid: number): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

// Claude Code processes that are running right now, from their registry files.
// A file whose pid is gone or now belongs to another process is ignored.
export function liveProcesses(opts: { dir?: string; fresh?: boolean } = {}): LiveProcess[] {
  if (!opts.fresh && !opts.dir && cache && Date.now() - cache.at < CACHE_MS) return cache.list;
  const dir = opts.dir ?? paths.claudeSessionsDir;
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
        host: r.kind === "bg" ? BACKGROUND : (HOSTS[r.entrypoint] ?? r.entrypoint ?? "Claude Code"),
        status: r.status,
        procStart: String(r.procStart),
        ...(r.peerProtocol === INBOX_PROTOCOL && typeof r.messagingSocketPath === "string" ? { inbox: r.messagingSocketPath } : {}),
      });
    } catch {}
  }
  if (!opts.dir) cache = { at: Date.now(), list };
  return list;
}
