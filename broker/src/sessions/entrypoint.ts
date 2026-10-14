import fs from "node:fs";
import path from "node:path";
import { paths } from "../config.ts";
import { transcriptPath } from "./history.ts";
import { liveProcesses } from "./live.ts";

// VS Code and `claude --resume` hide sessions whose transcript names an Agent SDK entrypoint (sdk-ts, sdk-py,
// sdk-cli). The broker's sessions name their own, which Claude Code treats as an unknown client.
export const ENTRYPOINT = "ccrc";
const SDK_ENTRYPOINT = "sdk-ts";
const SDK_FIELD = `"entrypoint":"${SDK_ENTRYPOINT}"`;
const OWN_FIELD = `"entrypoint":"${ENTRYPOINT}"`;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The environment of a broker session's Claude Code. Artifacts and drafted feedback stay off unless the
// environment asks for them, as they are under an SDK entrypoint; the user agent names ccrc as the SDK's client app.
export function sessionEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  return {
    ...base,
    CLAUDE_CODE_ENTRYPOINT: ENTRYPOINT,
    CLAUDE_AGENT_SDK_CLIENT_APP: ENTRYPOINT,
    CLAUDE_CODE_ARTIFACT: base.CLAUDE_CODE_ARTIFACT ?? "0",
    CLAUDE_CODE_SEND_FEEDBACK: base.CLAUDE_CODE_SEND_FEEDBACK ?? "0",
  };
}

export interface RetagOptions {
  auditFile?: string;
  backupDir?: string;
  // Whether a Claude Code process holds the session right now.
  running?: (sessionId: string) => boolean;
}

export interface Retagged {
  file: string;
  backup: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

// Sessions the broker created, from the audit log's new_session events.
function createdSessions(auditFile: string): { sessionId: string; cwd?: string }[] {
  let text = "";
  try {
    text = fs.readFileSync(auditFile, "utf8");
  } catch {}
  const found = new Map<string, string | undefined>();
  for (const line of text.split("\n")) {
    if (!line.includes('"new_session"')) continue;
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      if (e.event === "new_session" && typeof e.sessionId === "string" && SESSION_ID.test(e.sessionId)) found.set(e.sessionId, typeof e.cwd === "string" ? e.cwd : undefined);
    } catch {}
  }
  return [...found].map(([sessionId, cwd]) => ({ sessionId, cwd }));
}

// The row with its own entrypoint in place of the SDK one; undefined for any other row.
export function retagLine(line: string): string | undefined {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isObject(row) || row.entrypoint !== SDK_ENTRYPOINT) return undefined;
  for (let at = line.indexOf(SDK_FIELD); at >= 0; at = line.indexOf(SDK_FIELD, at + 1)) {
    const next = line.slice(0, at) + OWN_FIELD + line.slice(at + SDK_FIELD.length);
    try {
      if ((JSON.parse(next) as Record<string, unknown>).entrypoint === ENTRYPOINT) return next;
    } catch {}
  }
  return undefined;
}

function unchanged(a: fs.Stats, b: fs.Stats): boolean {
  return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

// Rewrites one transcript after a backup; leaves it alone when a process holds it or it changes meanwhile.
function retagFile(file: string, sessionId: string, backupDir: string, running: () => boolean): Retagged | undefined {
  if (running()) return undefined;
  const before = fs.statSync(file);
  const raw = fs.readFileSync(file);
  const text = raw.toString("utf8");
  if (!text.includes(SDK_FIELD) || !Buffer.from(text, "utf8").equals(raw)) return undefined;
  let changed = false;
  const out = text
    .split("\n")
    .map((line) => {
      const next = line.includes(SDK_FIELD) ? retagLine(line) : undefined;
      if (next !== undefined) changed = true;
      return next ?? line;
    })
    .join("\n");
  if (!changed) return undefined;
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const backup = path.join(backupDir, `${sessionId}.${Date.now()}.jsonl`);
  fs.writeFileSync(backup, raw, { mode: 0o600, flag: "wx" });
  const tmp = `${file}.${process.pid}.ccrc.tmp`;
  try {
    fs.writeFileSync(tmp, out, { mode: before.mode & 0o777, flag: "wx" });
    fs.utimesSync(tmp, before.atime, before.mtime);
    if (running() || !unchanged(before, fs.statSync(file))) throw Error("changed");
    fs.renameSync(tmp, file);
    return { file, backup };
  } catch {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(backup, { force: true });
    return undefined;
  }
}

// Transcripts of sessions the broker created that still name the SDK entrypoint get the broker's own, so VS Code
// lists them. Sessions running anywhere are left for the next start.
export function retagTranscripts(o: RetagOptions = {}): Retagged[] {
  const backupDir = o.backupDir ?? path.join(paths.stateDir, "backup");
  const running = o.running ?? ((id: string) => liveProcesses({ fresh: true }).some((l) => l.sessionId === id));
  const done: Retagged[] = [];
  for (const { sessionId, cwd } of createdSessions(o.auditFile ?? paths.auditFile)) {
    const file = transcriptPath(sessionId, cwd);
    if (!file) continue;
    try {
      const r = retagFile(file, sessionId, backupDir, () => running(sessionId));
      if (r) done.push(r);
    } catch {}
  }
  return done;
}
