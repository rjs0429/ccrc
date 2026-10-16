import fs from "node:fs";
import { writeFileAtomic } from "./config.ts";

const KEEP_MS = 24 * 3600_000;
const KEEP_SESSIONS = 200;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// When a ccrc window last sent to, started or answered in each session: session ids and times only, for a day and the
// latest sessions. Given a file, it outlasts a broker restart; a file that cannot be written leaves it in memory.
export class RemoteActivity {
  private file?: string;
  private now: () => number;
  private log: (line: string) => void;
  private loaded?: Map<string, number>;

  constructor(file?: string, now: () => number = Date.now, log: (line: string) => void = (line) => console.error(line)) {
    this.file = file;
    this.now = now;
    this.log = log;
  }

  get(sessionId: string): number | undefined {
    const at = this.load().get(sessionId);
    return at !== undefined && this.now() - at <= KEEP_MS ? at : undefined;
  }

  note(sessionId: string): void {
    const m = this.load();
    const now = this.now();
    m.delete(sessionId);
    m.set(sessionId, now);
    for (const [id, at] of m) if (now - at > KEEP_MS) m.delete(id);
    for (const old of [...m.keys()].slice(0, -KEEP_SESSIONS)) m.delete(old);
    if (!this.file) return;
    try {
      writeFileAtomic(this.file, JSON.stringify(Object.fromEntries(m)) + "\n");
    } catch (e) {
      this.log(`remote activity: cannot save ${this.file}: ${e instanceof Error ? e.message : String(e)}`);
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
      const entries = Object.entries(saved).filter((e): e is [string, number] => SESSION_ID.test(e[0]) && typeof e[1] === "number" && Number.isFinite(e[1]));
      for (const [id, at] of entries.sort((a, b) => a[1] - b[1])) this.loaded.set(id, at);
    } catch {}
    return this.loaded;
  }
}
