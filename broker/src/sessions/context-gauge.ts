import fs from "node:fs";
import { writeFileAtomic } from "../config.ts";
import type { ContextDetail, ContextGauge } from "../protocol.ts";

const NAME_MAX = 200;
const KEEP_SESSIONS = 500;
const KEEP_MODELS = 50;
const FIRST_TAIL = 256 * 1024;
const READ_MAX = 64 * 1024 * 1024;
const MODEL_TAIL_MAX = 8 * 1024 * 1024;
const MODEL_HEAD = 1024 * 1024;
const ONE_M = /\[1m\]$/i;

// The window a model's context is measured against and where auto-compact starts, as Claude Code reports them.
export interface ContextWindow {
  max: number;
  autoCompactAt?: number;
}

export interface LastUsage {
  tokens: number;
  model?: string;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

function windowOf(v: unknown): ContextWindow | undefined {
  if (!isObj(v)) return undefined;
  const max = num(v.max);
  if (!max) return undefined;
  const at = num(v.autoCompactAt);
  return { max, ...(at ? { autoCompactAt: at } : {}) };
}

export function gauge(tokens: number, w: ContextWindow, last = false): ContextGauge {
  return {
    percent: Math.round((tokens / w.max) * 100),
    tokens,
    max: w.max,
    ...(w.autoCompactAt ? { autoCompactAt: w.autoCompactAt } : {}),
    ...(last ? { last: true } : {}),
  };
}

export function gaugeOf(d: ContextDetail): ContextGauge | undefined {
  return d.maxTokens > 0 ? gauge(d.totalTokens, { max: d.maxTokens, autoCompactAt: d.autoCompactAt }) : undefined;
}

// Input, cache and output tokens of a response: what the next request starts from.
function usageTokens(u: Obj): number {
  return [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens, u.output_tokens].reduce<number>((n, v) => n + (num(v) ?? 0), 0);
}

// Newest line first. null: the transcript gives no number (a compaction that left none); undefined: not in these lines.
function scan(lines: string[]): LastUsage | null | undefined {
  let compacted: number | undefined;
  let sawCompact = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"assistant"') && !line.includes('"compact_boundary"')) continue;
    let e: Obj;
    try {
      e = JSON.parse(line) as Obj;
    } catch {
      continue;
    }
    if (e.isSidechain === true) continue;
    if (e.type === "system" && e.subtype === "compact_boundary") {
      if (!sawCompact) compacted = isObj(e.compactMetadata) ? num(e.compactMetadata.postTokens) : undefined;
      sawCompact = true;
      continue;
    }
    const m = e.type === "assistant" && isObj(e.message) ? e.message : undefined;
    if (!m || !isObj(m.usage) || m.model === "<synthetic>") continue;
    const model = typeof m.model === "string" && m.model ? m.model.slice(0, NAME_MAX) : undefined;
    const tokens = sawCompact ? compacted : usageTokens(m.usage);
    return tokens === undefined ? null : { tokens, ...(model ? { model } : {}) };
  }
  return undefined;
}

// The context in use after the transcript's last main-conversation response, or the size a later compaction
// left, and the model that answered. Read from the end, in growing pieces.
export async function lastUsage(file: string): Promise<LastUsage | undefined> {
  const fh = await fs.promises.open(file, "r");
  try {
    const { size } = await fh.stat();
    for (let want = FIRST_TAIL; ; want *= 8) {
      const start = Math.max(0, size - Math.min(want, READ_MAX));
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      const lines = buf.toString("utf8").split("\n");
      if (start > 0) lines.shift();
      const found = scan(lines);
      if (found !== undefined) return found ?? undefined;
      if (start === 0 || want >= READ_MAX) return undefined;
    }
  } finally {
    await fh.close();
  }
}

function modelRecord(lines: string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"attachment"') || !line.includes('"modelId"')) continue;
    try {
      const e = JSON.parse(line) as Obj;
      const a = isObj(e.attachment) ? e.attachment : undefined;
      const id = a?.type === "model" && isObj(a.identity) ? a.identity.modelId : undefined;
      if (e.isSidechain !== true && typeof id === "string" && id) return id.slice(0, NAME_MAX);
    } catch {}
  }
  return undefined;
}

// The exact model ID in the transcript's newest model record; responses name the model without its [1m] window.
// Read from the end in growing pieces, then from the start, where a session's first record is.
export async function lastModelId(file: string): Promise<string | undefined> {
  const fh = await fs.promises.open(file, "r");
  try {
    const { size } = await fh.stat();
    let start = size;
    for (let want = FIRST_TAIL; start > 0 && want <= MODEL_TAIL_MAX; want *= 8) {
      start = Math.max(0, size - want);
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      const lines = buf.toString("utf8").split("\n");
      if (start > 0) lines.shift();
      const found = modelRecord(lines);
      if (found) return found;
    }
    if (start === 0) return undefined;
    const head = Buffer.alloc(Math.min(MODEL_HEAD, start));
    await fh.read(head, 0, head.length, 0);
    const lines = head.toString("utf8").split("\n");
    lines.pop();
    return modelRecord(lines);
  } finally {
    await fh.close();
  }
}

// The model a stopped session's window is sized by: the transcript's record of the exact model when it is the model
// that answered, else a [1m] default in the user's settings for the same model or model family.
export function exactModel(answered: string, recorded: string | undefined, setting: string | undefined): string {
  if (ONE_M.test(answered)) return answered;
  if (recorded) return base(recorded) === answered ? recorded : answered;
  if (!setting || !ONE_M.test(setting)) return answered;
  const s = base(setting);
  const same = s.includes("-") ? s === answered : answered.startsWith(`claude-${s}-`) || answered.includes(`-${s}-`);
  return same ? `${answered}[1m]` : answered;
}

// A context larger than a model's window ran with its 1M window.
export function widened(model: string, tokens: number, w: ContextWindow): string | undefined {
  return tokens > w.max && !ONE_M.test(model) ? `${model}[1m]` : undefined;
}

interface Saved {
  models: [string, ContextWindow][];
  sessions: [string, ContextWindow & { model?: string }][];
}

// Context windows Claude Code reported, per session and per model, kept across broker restarts. A model
// name with "[1m]" stands for the same model as the transcript names it without.
export class ContextWindows {
  private file: string;
  private loaded?: { models: Map<string, ContextWindow>; sessions: Map<string, ContextWindow & { model?: string }> };

  constructor(file: string) {
    this.file = file;
  }

  get(sessionId: string, model?: string): ContextWindow | undefined {
    const m = this.load();
    const own = m.sessions.get(sessionId);
    if (own && (!model || !own.model || base(own.model) === base(model))) return own;
    return model ? m.models.get(model) : undefined;
  }

  learn(model: string | undefined, w: ContextWindow, sessionId?: string): void {
    if (!(w.max > 0)) return;
    const m = this.load();
    const entry = { max: w.max, ...(w.autoCompactAt ? { autoCompactAt: w.autoCompactAt } : {}) };
    let changed = false;
    if (model && model.length <= NAME_MAX && JSON.stringify(m.models.get(model)) !== JSON.stringify(entry)) {
      m.models.delete(model);
      m.models.set(model, entry);
      changed = true;
    }
    const own = { ...entry, ...(model ? { model: model.slice(0, NAME_MAX) } : {}) };
    if (sessionId && JSON.stringify(m.sessions.get(sessionId)) !== JSON.stringify(own)) {
      m.sessions.delete(sessionId);
      m.sessions.set(sessionId, own);
      changed = true;
    }
    if (!changed) return;
    for (const old of [...m.models.keys()].slice(0, -KEEP_MODELS)) m.models.delete(old);
    for (const old of [...m.sessions.keys()].slice(0, -KEEP_SESSIONS)) m.sessions.delete(old);
    const saved: Saved = { models: [...m.models], sessions: [...m.sessions] };
    try {
      writeFileAtomic(this.file, JSON.stringify(saved) + "\n");
    } catch {}
  }

  private load() {
    if (this.loaded) return this.loaded;
    this.loaded = { models: new Map(), sessions: new Map() };
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<Saved>;
      for (const [key, v] of Array.isArray(saved.models) ? saved.models : []) {
        const w = windowOf(v);
        if (typeof key === "string" && w) this.loaded.models.set(key, w);
      }
      for (const [key, v] of Array.isArray(saved.sessions) ? saved.sessions : []) {
        const w = windowOf(v);
        const model = isObj(v) && typeof v.model === "string" ? v.model : undefined;
        if (typeof key === "string" && w) this.loaded.sessions.set(key, { ...w, ...(model ? { model } : {}) });
      }
    } catch {}
    return this.loaded;
  }
}

function base(model: string): string {
  return model.replace(/\[1m\]$/i, "");
}
