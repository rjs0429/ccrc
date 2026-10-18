import fs from "node:fs";
import { writeFileAtomic } from "../config.ts";

const KEEP_MS = 30 * 24 * 3600_000;
const KEEP_SESSIONS = 500;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The sessions left unread, with when: a turn or a notice the user has not looked at since. Seeing a session at or after
// that time reads it. Only session ids and times are kept, for a month and the latest sessions; given no file, or one
// that cannot be written, it lives in memory.
export class UnreadStore {
  private file?: string;
  private now: () => number;
  private log: (line: string) => void;
  private loaded?: Map<string, number>;

  constructor(file?: string, now: () => number = () => Date.now(), log: (line: string) => void = (line) => console.error(line)) {
    this.file = file;
    this.now = now;
    this.log = log;
  }

  has(sessionId: string): boolean {
    return this.since(sessionId) !== undefined;
  }

  ids(): string[] {
    return [...this.load().keys()].filter((id) => this.has(id));
  }

  // Whether the session became unread.
  mark(sessionId: string, at = this.now()): boolean {
    const was = this.has(sessionId);
    const m = this.load();
    m.delete(sessionId);
    m.set(sessionId, at);
    const now = this.now();
    for (const [id, t] of m) if (now - t > KEEP_MS) m.delete(id);
    for (const old of [...m.keys()].slice(0, -KEEP_SESSIONS)) m.delete(old);
    this.save();
    return !was;
  }

  // Whether the session was unread and is read now; a sight from before it became unread reads nothing.
  seen(sessionId: string, at = this.now()): boolean {
    const since = this.since(sessionId);
    if (since === undefined || at < since) return false;
    this.load().delete(sessionId);
    this.save();
    return true;
  }

  // Drops the sessions `keep` turns down.
  prune(keep: (sessionId: string) => boolean): void {
    const m = this.load();
    const gone = [...m.keys()].filter((id) => !keep(id));
    for (const id of gone) m.delete(id);
    if (gone.length) this.save();
  }

  // When the session became unread, unless it is read or that was over a month ago.
  private since(sessionId: string): number | undefined {
    const at = this.load().get(sessionId);
    return at !== undefined && this.now() - at <= KEEP_MS ? at : undefined;
  }

  private save(): void {
    if (!this.file) return;
    try {
      writeFileAtomic(this.file, JSON.stringify(Object.fromEntries(this.load())) + "\n");
    } catch (e) {
      this.log(`unread: cannot save ${this.file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Oldest first, so the latest sessions are the ones kept.
  private load(): Map<string, number> {
    if (this.loaded) return this.loaded;
    this.loaded = new Map();
    if (!this.file) return this.loaded;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) return this.loaded;
      const valid = Object.entries(saved as Record<string, unknown>).filter((e): e is [string, number] => SESSION_ID.test(e[0]) && typeof e[1] === "number" && Number.isFinite(e[1]));
      for (const [id, at] of valid.sort((a, b) => a[1] - b[1])) this.loaded.set(id, at);
    } catch {}
    return this.loaded;
  }
}
