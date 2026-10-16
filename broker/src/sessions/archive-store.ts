import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../config.ts";

const KEEP_SESSIONS = 5000;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The sessions archived in ccrc and when, oldest first. Claude Code's transcripts carry no shared archive mark, so
// like VS Code and claude.ai ccrc keeps its own list; a file that cannot be read is an empty list.
export class ArchiveStore {
  private file: string;
  private now: () => number;
  private loaded?: Map<string, number>;

  constructor(file: string, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
  }

  has(sessionId: string): boolean {
    return this.load().has(sessionId);
  }

  // Whether the session's mark changed.
  set(sessionId: string, on: boolean): boolean {
    const m = this.load();
    if (on === m.has(sessionId)) return false;
    if (on) m.set(sessionId, this.now());
    else m.delete(sessionId);
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

  private save(): void {
    const m = this.load();
    for (const old of [...m.keys()].slice(0, -KEEP_SESSIONS)) m.delete(old);
    try {
      writeFileAtomic(this.file, JSON.stringify(Object.fromEntries(m)) + "\n");
    } catch {}
  }

  private load(): Map<string, number> {
    if (this.loaded) return this.loaded;
    this.loaded = new Map();
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) return this.loaded;
      const valid = Object.entries(saved as Record<string, unknown>).filter((e): e is [string, number] => SESSION_ID.test(e[0]) && typeof e[1] === "number" && Number.isFinite(e[1]));
      for (const [id, at] of valid.sort((a, b) => a[1] - b[1])) this.loaded.set(id, at);
    } catch {}
    return this.loaded;
  }
}

// The ids of the sessions with a transcript in a project folder under `root`; undefined when a folder cannot be read.
export function transcriptIds(root: string): Set<string> | undefined {
  try {
    const ids = new Set<string>();
    for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      for (const name of fs.readdirSync(path.join(root, dir.name))) if (name.endsWith(".jsonl")) ids.add(name.slice(0, -".jsonl".length));
    }
    return ids;
  } catch {
    return undefined;
  }
}
