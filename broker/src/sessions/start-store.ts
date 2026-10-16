import fs from "node:fs";
import { writeFileAtomic } from "../config.ts";
import { PERMISSION_MODES, type EffortName, type StartSettings } from "../protocol.ts";

const KEEP_MS = 3 * 24 * 60 * 60 * 1000;
const KEEP_SESSIONS = 200;
const EFFORTS: EffortName[] = ["low", "medium", "high", "xhigh", "max"];
export const MODEL_NAME = /^[A-Za-z0-9][\w.:[\]\/@-]{0,99}$/;
const SESSION_ID = /^[0-9a-f-]{36}$/;

type Saved = Record<string, { at: number; start: StartSettings }>;

function settingsOf(v: unknown): StartSettings | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const out: StartSettings = {};
  if (typeof o.model === "string" && MODEL_NAME.test(o.model)) out.model = o.model;
  if (PERMISSION_MODES.includes(o.mode as never)) out.mode = o.mode as StartSettings["mode"];
  if (EFFORTS.includes(o.effort as never)) out.effort = o.effort as EffortName;
  if (o.ultracode === true) out.ultracode = true;
  if (o.fast === true) out.fast = true;
  if (o.thinking === false) out.thinking = false;
  return Object.keys(out).length ? out : undefined;
}

// Start settings chosen for sessions without a process, kept across broker restarts for a few days.
export class StartStore {
  private file: string;
  private now: () => number;
  private loaded?: Map<string, { at: number; start: StartSettings }>;

  constructor(file: string, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
  }

  get(sessionId: string): StartSettings | undefined {
    const e = this.load().get(sessionId);
    if (!e) return undefined;
    if (this.now() - e.at <= KEEP_MS) return e.start;
    this.delete(sessionId);
    return undefined;
  }

  set(sessionId: string, start: StartSettings): void {
    const m = this.load();
    m.delete(sessionId);
    if (Object.keys(start).length) m.set(sessionId, { at: this.now(), start });
    this.save();
  }

  delete(sessionId: string): void {
    if (this.load().delete(sessionId)) this.save();
  }

  private save(): void {
    const m = this.load();
    const cutoff = this.now() - KEEP_MS;
    for (const [id, e] of m) if (e.at < cutoff) m.delete(id);
    for (const old of [...m.keys()].slice(0, -KEEP_SESSIONS)) m.delete(old);
    try {
      writeFileAtomic(this.file, JSON.stringify(Object.fromEntries(m) satisfies Saved) + "\n");
    } catch {}
  }

  private load() {
    if (this.loaded) return this.loaded;
    this.loaded = new Map();
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) return this.loaded;
      for (const [id, v] of Object.entries(saved as Record<string, unknown>)) {
        const e = v as { at?: unknown; start?: unknown } | null;
        const start = settingsOf(e?.start);
        if (SESSION_ID.test(id) && start && typeof e?.at === "number" && Number.isFinite(e.at)) this.loaded.set(id, { at: e.at, start });
      }
    } catch {}
    return this.loaded;
  }
}
