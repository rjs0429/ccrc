import fs from "node:fs";
import type { PromptCache } from "../protocol.ts";

const FIRST_TAIL = 256 * 1024;
const READ_MAX = 16 * 1024 * 1024;
const KEEP_FILES = 200;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

function ttlOf(usage: Obj): PromptCache["ttl"] {
  const c = isObj(usage.cache_creation) ? usage.cache_creation : {};
  if (count(c.ephemeral_1h_input_tokens)) return "1h";
  if (count(c.ephemeral_5m_input_tokens)) return "5m";
  return undefined;
}

// Follows the prompt cache of the main conversation the way VS Code does. The last request before a response wrote or
// read the cache then; a response that only read it keeps the time to live it was written with, and the parts of one
// response keep the time of its request. A compaction leaves nothing cached until a later response.
export class CacheClock {
  private requestAt?: number;
  private messageId?: string;
  private record?: PromptCache;

  // A message that starts a request: the user's, or tool results going back.
  request(at: number): void {
    if (Number.isFinite(at)) this.requestAt = Math.max(this.requestAt ?? at, at);
  }

  // Whether the clock changed.
  response(messageId: unknown, usage: unknown, at: number): boolean {
    if (!isObj(usage) || !Number.isFinite(at)) return false;
    const read = count(usage.cache_read_input_tokens);
    const written = count(usage.cache_creation_input_tokens);
    const tokens = count(usage.input_tokens) + read + written;
    if (!tokens) return false;
    const id = typeof messageId === "string" && messageId ? messageId : undefined;
    const prev = this.record;
    const same = id !== undefined && id === this.messageId;
    const anchor = same && prev?.at !== undefined ? prev.at : this.requestAt !== undefined && this.requestAt <= at ? this.requestAt : at;
    const ttl = read + written > 0 ? (ttlOf(usage) ?? prev?.ttl) : undefined;
    const compactedAt = prev?.compactedAt !== undefined && (same || at <= prev.compactedAt) ? prev.compactedAt : undefined;
    if (!same) this.requestAt = undefined;
    this.messageId = id;
    return this.put({ at: anchor, ...(ttl ? { ttl } : {}), tokens, ...(compactedAt !== undefined ? { compactedAt } : {}) });
  }

  compact(at: number): boolean {
    return Number.isFinite(at) && this.put({ ...this.record, compactedAt: at });
  }

  // Undefined while nothing says how long the cache lasts.
  value(): PromptCache | undefined {
    const r = this.record;
    return r && (r.compactedAt !== undefined || (r.at !== undefined && r.ttl !== undefined)) ? r : undefined;
  }

  // A clock that has seen nothing yet takes what the transcript last left.
  seed(v: PromptCache | undefined): boolean {
    return Boolean(v) && !this.record && this.put({ ...v });
  }

  private put(next: PromptCache): boolean {
    const changed = JSON.stringify(next) !== JSON.stringify(this.record);
    this.record = next;
    return changed;
  }
}

const time = (v: unknown): number => (typeof v === "string" ? Date.parse(v) : NaN);

// The clock as a transcript's lines, oldest first, leave it.
export function cacheOfLines(lines: string[]): PromptCache | undefined {
  const clock = new CacheClock();
  for (const line of lines) {
    if (!line.includes('"user"') && !line.includes('"assistant"') && !line.includes('"compact_boundary"')) continue;
    let e: Obj;
    try {
      e = JSON.parse(line) as Obj;
    } catch {
      continue;
    }
    if (e.isSidechain === true) continue;
    const at = time(e.timestamp);
    if (e.type === "system" && e.subtype === "compact_boundary") clock.compact(at);
    else if (e.type === "user") {
      if (e.isCompactSummary === true) clock.compact(at);
      else clock.request(at);
    } else if (e.type === "assistant" && isObj(e.message) && e.message.model !== "<synthetic>") clock.response(e.message.id, e.message.usage, at);
  }
  return clock.value();
}

const known = new Map<string, { size: number; mtimeMs: number; value?: PromptCache }>();

// The prompt cache the transcript's last response left, read from the end in growing pieces; kept per file until it
// changes.
export async function lastCache(file: string): Promise<PromptCache | undefined> {
  const fh = await fs.promises.open(file, "r");
  try {
    const { size, mtimeMs } = await fh.stat();
    const kept = known.get(file);
    if (kept && kept.size === size && kept.mtimeMs === mtimeMs) return kept.value;
    let value: PromptCache | undefined;
    for (let want = FIRST_TAIL; ; want *= 8) {
      const start = Math.max(0, size - Math.min(want, READ_MAX));
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      const lines = buf.toString("utf8").split("\n");
      if (start > 0) lines.shift();
      value = cacheOfLines(lines);
      if (value || start === 0 || want >= READ_MAX) break;
    }
    known.delete(file);
    known.set(file, { size, mtimeMs, value });
    for (const old of [...known.keys()].slice(0, -KEEP_FILES)) known.delete(old);
    return value;
  } finally {
    await fh.close();
  }
}
