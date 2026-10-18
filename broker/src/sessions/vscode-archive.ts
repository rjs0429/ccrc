import fs from "node:fs";
import { writeFileAtomic } from "../config.ts";

const EXTENSION_STATE_KEY = "Anthropic.claude-code";
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// VS Code's own writes give up after a second of waiting, so a read that finds the database busy gives up much sooner.
const BUSY_MS = 200;
const KEEP_SESSIONS = 5000;

// The sessions the Claude Code extension in VS Code archived: its hiddenSessionIds, which also holds the sessions it
// archives after claudeCode.archiveInactiveSessions days without use, read from VS Code's state database and never
// written. Beside them, the ones the remote user brought back in ccrc while VS Code keeps them archived.
export class VscodeArchive {
  private shownFile: string;
  private db: () => string;
  private now: () => number;
  private read?: { key: string; ids: Set<string> };
  private shownIds?: Map<string, number>;

  constructor(shownFile: string, db: () => string, now: () => number = Date.now) {
    this.shownFile = shownFile;
    this.db = db;
    this.now = now;
  }

  // Read again once the database changed; while it cannot be read, the ids read last. Brought-back marks of sessions
  // VS Code no longer hides go.
  async hidden(): Promise<Set<string>> {
    const file = this.db();
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      this.read = undefined;
      return new Set();
    }
    const key = `${st.ino} ${st.size} ${st.mtimeMs}`;
    if (this.read?.key === key) return this.read.ids;
    try {
      const ids = await hiddenIds(file);
      this.read = { key, ids };
      this.prune((id) => ids.has(id));
      return ids;
    } catch {
      return this.read?.ids ?? new Set();
    }
  }

  shown(sessionId: string): boolean {
    return this.load().has(sessionId);
  }

  // Whether the mark changed.
  setShown(sessionId: string, on: boolean): boolean {
    const m = this.load();
    if (on === m.has(sessionId)) return false;
    if (on) m.set(sessionId, this.now());
    else m.delete(sessionId);
    this.save();
    return true;
  }

  prune(keep: (sessionId: string) => boolean): void {
    const m = this.load();
    const gone = [...m.keys()].filter((id) => !keep(id));
    for (const id of gone) m.delete(id);
    if (gone.length) this.save();
  }

  private save(): void {
    const m = this.load();
    for (const old of [...m.keys()].slice(0, -KEEP_SESSIONS)) m.delete(old);
    try {
      writeFileAtomic(this.shownFile, JSON.stringify(Object.fromEntries(m)) + "\n");
    } catch {}
  }

  private load(): Map<string, number> {
    if (this.shownIds) return this.shownIds;
    this.shownIds = new Map();
    try {
      const saved = JSON.parse(fs.readFileSync(this.shownFile, "utf8")) as unknown;
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) return this.shownIds;
      const valid = Object.entries(saved as Record<string, unknown>).filter((e): e is [string, number] => SESSION_ID.test(e[0]) && typeof e[1] === "number" && Number.isFinite(e[1]));
      for (const [id, at] of valid.sort((a, b) => a[1] - b[1])) this.shownIds.set(id, at);
    } catch {}
    return this.shownIds;
  }
}

// One read-only look at the extension's row, closed at once: VS Code keeps writing the same file.
export async function hiddenIds(file: string): Promise<Set<string>> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true, timeout: BUSY_MS });
  try {
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(EXTENSION_STATE_KEY) as { value?: unknown } | undefined;
    const raw = row?.value instanceof Uint8Array ? Buffer.from(row.value).toString("utf8") : row?.value;
    const state = typeof raw === "string" ? (JSON.parse(raw) as { hiddenSessionIds?: unknown }) : undefined;
    const ids = Array.isArray(state?.hiddenSessionIds) ? state.hiddenSessionIds : [];
    return new Set(ids.filter((id): id is string => typeof id === "string" && SESSION_ID.test(id)));
  } finally {
    db.close();
  }
}
