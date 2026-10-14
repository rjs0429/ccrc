import fs from "node:fs";
import path from "node:path";
import { setImmediate as yieldNow } from "node:timers/promises";
import type { SessionSummary } from "../protocol.ts";
import { SEARCH_LIMIT_MAX, SEARCH_QUERY_MAX, type Mark, type SearchResponse, type SearchResult, type SearchSnippet } from "../search-protocol.ts";
import { PROJECTS, projectDirName } from "./history.ts";
import { typedText } from "./items.ts";

export interface SearchLimits {
  // Text kept per message and per transcript (the latest messages), and over all transcripts.
  messageChars: number;
  transcriptChars: number;
  totalChars: number;
  // How long a search may spend reading transcripts before it answers with what it has.
  budgetMs: number;
}

const LIMITS: SearchLimits = { messageChars: 16_000, transcriptChars: 400_000, totalChars: 48_000_000, budgetMs: 1500 };
const TERMS_MAX = 8;
const DEFAULT_RESULTS = 30;
const SNIPPETS = 3;
const SNIPPET_BEFORE = 40;
const SNIPPET_CHARS = 140;
const MARKS_MAX = 12;
const HITS_MAX = 500;
const HEAD_BYTES = 256;
const CHUNK_BYTES = 1 << 20;
const SEP = "\u0000";

type Role = SearchSnippet["role"];

interface Message {
  id: string;
  role: Role;
  at?: number;
  text: string;
  earlier?: boolean;
}

// Where a compaction cut the conversation, with the rows it kept; the chat view starts after the last one.
interface Boundary {
  kept: Set<string>;
}
type Parsed = Message | Boundary;

// The searchable text of one transcript: its messages joined by SEP, with where each starts.
interface Entry {
  size: number;
  mtimeMs: number;
  // Bytes read so far, up to the end of the last complete line, and the file's first bytes, which
  // tell an appended file from a rewritten one.
  offset: number;
  head: string;
  text: string;
  starts: number[];
  ids: string[];
  roles: Role[];
  ats: (number | undefined)[];
  earlier: boolean[];
}

interface Row {
  type?: string;
  subtype?: string;
  uuid?: string;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  isApiErrorMessage?: boolean;
  message?: { content?: unknown };
  attachment?: { type?: string; prompt?: unknown; source_uuid?: unknown; isMeta?: boolean; forwardedIntent?: unknown };
  compactMetadata?: { preservedMessages?: { allUuids?: unknown } };
}

function boundaryOf(e: Row): Boundary {
  const kept = e.compactMetadata?.preservedMessages?.allUuids;
  return { kept: new Set(Array.isArray(kept) ? kept.filter((u): u is string => typeof u === "string") : []) };
}

const sanitize = (s: string) => s.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ");

function userMessage(id: string, content: unknown, at: number | undefined, messageChars: number): Message[] {
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
  const texts = blocks
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => (b.text as string).trim())
    .filter((t) => t && typedText(t));
  return texts.length ? [{ id, role: "user", at, text: clip(sanitize(texts.join("\n\n")), messageChars) }] : [];
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = /[\ud800-\udbff]/.test(text[max - 1]) ? max - 1 : max;
  return text.slice(0, cut);
}

// User and assistant text of one transcript row; tool calls, their results and context are left out.
export function rowMessages(e: Row, messageChars: number): Message[] {
  if (e.isSidechain || e.isMeta || !e.uuid) return [];
  const at = e.timestamp ? Date.parse(e.timestamp) || undefined : undefined;
  if (e.type === "user") return e.isCompactSummary ? [] : userMessage(e.uuid, e.message?.content, at, messageChars);
  // A message sent while Claude was working; the chat view shows it under its source uuid.
  const q = e.attachment;
  if (e.type === "attachment" && q?.type === "queued_command" && !q.isMeta && q.forwardedIntent === undefined) {
    return userMessage(typeof q.source_uuid === "string" && q.source_uuid ? q.source_uuid : e.uuid, q.prompt, at, messageChars);
  }
  if (e.type !== "assistant" || e.isApiErrorMessage) return [];
  const content = e.message?.content;
  const blocks = Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
  const out: Message[] = [];
  blocks.forEach((b, i) => {
    if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
      out.push({ id: `${e.uuid}:${i}`, role: "assistant", at, text: clip(sanitize(b.text), messageChars) });
    }
  });
  return out;
}

function parseLines(text: string, messageChars: number, out: Parsed[]): void {
  for (const line of text.split("\n")) {
    const boundary = line.includes('"subtype":"compact_boundary"');
    if (!boundary && !line.includes('"type":"user"') && !line.includes('"type":"assistant"') && !line.includes('"type":"queued_command"')) continue;
    if (line.includes('"toolUseResult":')) continue;
    try {
      const e = JSON.parse(line) as Row;
      if (e.type === "system" && e.subtype === "compact_boundary") out.push(boundaryOf(e));
      else out.push(...rowMessages(e, messageChars));
    } catch {}
  }
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Search words: NFC, without control characters, case-insensitive, each one required.
export function parseQuery(q: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const t of sanitize(q).split(/\s+/)) {
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    terms.push(t);
    if (terms.length === TERMS_MAX) break;
  }
  return terms;
}

function marksIn(text: string, res: RegExp[]): Mark[] {
  const marks: Mark[] = [];
  for (const re of res) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m && marks.length < MARKS_MAX * 4; m = re.exec(text)) {
      marks.push([m.index, m.index + m[0].length]);
      if (!m[0].length) re.lastIndex++;
    }
  }
  marks.sort((a, b) => a[0] - b[0]);
  const merged: Mark[] = [];
  for (const m of marks) {
    const last = merged.at(-1);
    if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1]);
    else merged.push([...m]);
  }
  return merged.slice(0, MARKS_MAX);
}

function snippetOf(e: Entry, i: number, res: RegExp[]): SearchSnippet {
  const end = i + 1 < e.starts.length ? e.starts[i + 1] - SEP.length : e.text.length;
  const msg = e.text.slice(e.starts[i], end);
  let first = msg.length;
  for (const re of res) {
    re.lastIndex = 0;
    const m = re.exec(msg);
    if (m) first = Math.min(first, m.index);
  }
  let from = Math.max(0, Math.min(first - SNIPPET_BEFORE, msg.length - SNIPPET_CHARS));
  if (from > 0 && /[\udc00-\udfff]/.test(msg[from])) from--;
  let to = Math.min(msg.length, from + SNIPPET_CHARS);
  if (to < msg.length && /[\ud800-\udbff]/.test(msg[to - 1])) to--;
  const text = msg.slice(from, to).replace(/\s/g, " ");
  const earlier = e.earlier[i] ? { earlier: true } : {};
  return { itemId: e.ids[i], role: e.roles[i], at: e.ats[i], text, marks: marksIn(text, res), cutStart: from > 0, cutEnd: to < msg.length, ...earlier };
}

function messageAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// Searches the titles and the conversation text of sessions. Transcripts are read when a search first
// needs them and again only when they change, appended files from where the last read stopped.
export class SessionSearch {
  private entries = new Map<string, Entry>();
  private reading = new Map<string, Promise<Entry | undefined>>();
  private queue = new Set<string>();
  private warming = false;
  private limits: SearchLimits;
  private root: string;

  constructor(limits: Partial<SearchLimits> = {}, root = PROJECTS) {
    this.limits = { ...LIMITS, ...limits };
    this.root = root;
  }

  get stats(): { transcripts: number; chars: number } {
    let chars = 0;
    for (const e of this.entries.values()) chars += e.text.length;
    return { transcripts: this.entries.size, chars };
  }

  async search(query: string, sessions: SessionSummary[], limit = DEFAULT_RESULTS): Promise<SearchResponse> {
    const terms = parseQuery(query.slice(0, SEARCH_QUERY_MAX));
    if (!terms.length) return { results: [], total: 0, pending: 0 };
    const res = terms.map((t) => new RegExp(escape(t), "giu"));
    const max = Math.max(1, Math.min(SEARCH_LIMIT_MAX, Math.floor(limit) || DEFAULT_RESULTS));
    const deadline = Date.now() + this.limits.budgetMs;
    const files = await this.locate(sessions);
    const ordered = [...sessions].sort((a, b) => b.lastModified - a.lastModified);
    const titled: SearchResult[] = [];
    const other: SearchResult[] = [];
    let pending = 0;
    for (const s of ordered) {
      const file = files.get(s.id);
      const got = file ? await this.ensure(file, deadline) : undefined;
      if (got && !got.fresh) pending++;
      const r = this.match(s, got?.entry, res);
      if (r) (r.titleMatch ? titled : other).push(r);
      await yieldNow();
    }
    this.forget(new Set(files.values()));
    if (this.queue.size) void this.warm();
    const all = [...titled, ...other];
    return { results: all.slice(0, max), total: all.length, pending };
  }

  private match(s: SessionSummary, e: Entry | undefined, res: RegExp[]): SearchResult | undefined {
    const title = sanitize(s.title);
    const inTitle = res.map((re) => ((re.lastIndex = 0), re.test(title)));
    const found = [...inTitle];
    const hits = new Map<number, Set<number>>();
    if (e) {
      res.forEach((re, k) => {
        re.lastIndex = 0;
        for (let m = re.exec(e.text), n = 0; m && n < HITS_MAX; m = re.exec(e.text), n++) {
          found[k] = true;
          const i = messageAt(e.starts, m.index);
          const set = hits.get(i) ?? new Set<number>();
          set.add(k);
          hits.set(i, set);
        }
      });
    }
    if (!found.every(Boolean)) return undefined;
    const picked = [...hits.entries()].sort((a, b) => b[1].size - a[1].size || b[0] - a[0]).slice(0, SNIPPETS);
    return {
      id: s.id,
      title,
      cwd: s.cwd,
      lastModified: s.lastModified,
      titleMatch: inTitle.every(Boolean),
      titleMarks: inTitle.some(Boolean) ? marksIn(title, res) : [],
      hits: hits.size,
      snippets: e ? picked.map(([i]) => snippetOf(e, i, res)) : [],
    };
  }

  // Transcript files by session id; a session found in several project folders uses the one named
  // after its working directory.
  private async locate(sessions: SessionSummary[]): Promise<Map<string, string>> {
    const wanted = new Map(sessions.map((s) => [s.id, s.cwd]));
    const out = new Map<string, string>();
    let dirs: string[] = [];
    try {
      dirs = await fs.promises.readdir(this.root);
    } catch {
      return out;
    }
    for (const dir of dirs) {
      let names: string[];
      try {
        names = await fs.promises.readdir(path.join(this.root, dir));
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const id = name.slice(0, -6);
        const cwd = wanted.get(id);
        if (cwd === undefined) continue;
        if (!out.has(id) || dir === projectDirName(cwd)) out.set(id, path.join(this.root, dir, name));
      }
    }
    return out;
  }

  // The entry for a file and whether it is current. Past the deadline a changed file is left for later.
  private async ensure(file: string, deadline: number): Promise<{ entry?: Entry; fresh: boolean } | undefined> {
    const st = await fs.promises.stat(file).catch(() => undefined);
    if (!st) return undefined;
    const have = this.entries.get(file);
    if (have && have.size === st.size && have.mtimeMs === st.mtimeMs) return { entry: have, fresh: true };
    if (Date.now() > deadline) {
      this.queue.add(file);
      return { entry: have, fresh: false };
    }
    // A file that cannot be read counts as read, so it does not hold the search pending.
    return { entry: await this.read(file), fresh: true };
  }

  private read(file: string): Promise<Entry | undefined> {
    const running = this.reading.get(file);
    if (running) return running;
    const p = this.refresh(file)
      .catch(() => undefined)
      .finally(() => this.reading.delete(file));
    this.reading.set(file, p);
    return p;
  }

  private async warm(): Promise<void> {
    if (this.warming) return;
    this.warming = true;
    try {
      while (this.queue.size) {
        const file = this.queue.values().next().value!;
        this.queue.delete(file);
        await this.read(file);
        await yieldNow();
      }
    } finally {
      this.warming = false;
    }
  }

  private async refresh(file: string): Promise<Entry | undefined> {
    const fh = await fs.promises.open(file, "r");
    try {
      const st = await fh.stat();
      const headBuf = Buffer.alloc(Math.min(HEAD_BYTES, st.size));
      await fh.read(headBuf, 0, headBuf.length, 0);
      const head = headBuf.toString("latin1");
      const prev = this.entries.get(file);
      const append = prev && st.size >= prev.size && head.startsWith(prev.head);
      const start = append ? prev.offset : 0;
      const messages: Parsed[] = [];
      let consumed = start;
      let carry: Buffer[] = [];
      const buf = Buffer.alloc(CHUNK_BYTES);
      for (let pos = start; pos < st.size; ) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK_BYTES, st.size - pos), pos);
        if (!bytesRead) break;
        pos += bytesRead;
        const chunk = buf.subarray(0, bytesRead);
        const nl = chunk.lastIndexOf(0x0a);
        if (nl < 0) {
          carry.push(Buffer.from(chunk));
          continue;
        }
        const lines = Buffer.concat([...carry, chunk.subarray(0, nl)]);
        consumed += lines.length + 1;
        carry = [Buffer.from(chunk.subarray(nl + 1))];
        parseLines(lines.toString("utf8"), this.limits.messageChars, messages);
      }
      const entry = append ? this.extend(prev, messages) : this.build(messages);
      Object.assign(entry, { size: st.size, mtimeMs: st.mtimeMs, offset: consumed, head });
      this.entries.set(file, entry);
      this.trim(file);
      return entry;
    } finally {
      await fh.close();
    }
  }

  // A message written again keeps its last place; those before the last compaction are marked.
  private build(parsed: Parsed[]): Entry {
    const last = parsed.findLastIndex((m) => "kept" in m);
    const preserved = last >= 0 ? (parsed[last] as Boundary).kept : undefined;
    const byId = new Map<string, Message>();
    parsed.forEach((m, i) => {
      if ("kept" in m) return;
      byId.delete(m.id);
      byId.set(m.id, i < last && !preserved?.has(m.id.split(":")[0]) ? { ...m, earlier: true } : m);
    });
    const messages = [...byId.values()];
    let keep = messages.length;
    let chars = 0;
    while (keep > 0 && chars + messages[keep - 1].text.length + SEP.length <= this.limits.transcriptChars) chars += messages[--keep].text.length + SEP.length;
    const kept = messages.slice(keep);
    const starts: number[] = [];
    let at = 0;
    for (const m of kept) {
      starts.push(at);
      at += m.text.length + SEP.length;
    }
    return {
      size: 0,
      mtimeMs: 0,
      offset: 0,
      head: "",
      text: kept.map((m) => m.text).join(SEP),
      starts,
      ids: kept.map((m) => m.id),
      roles: kept.map((m) => m.role),
      ats: kept.map((m) => m.at),
      earlier: kept.map((m) => Boolean(m.earlier)),
    };
  }

  private extend(prev: Entry, added: Parsed[]): Entry {
    if (!added.length) return { ...prev };
    const old: Message[] = prev.ids.map((id, i) => ({
      id,
      role: prev.roles[i],
      at: prev.ats[i],
      text: prev.text.slice(prev.starts[i], i + 1 < prev.starts.length ? prev.starts[i + 1] - SEP.length : prev.text.length),
      earlier: prev.earlier[i],
    }));
    return this.build([...old, ...added]);
  }

  // Over the total, the transcripts changed longest ago are dropped; a later search reads them again.
  private trim(keep: string): void {
    let total = this.stats.chars;
    if (total <= this.limits.totalChars) return;
    const byAge = [...this.entries.entries()].filter(([f]) => f !== keep).sort((a, b) => a[1].mtimeMs - b[1].mtimeMs);
    for (const [f, e] of byAge) {
      if (total <= this.limits.totalChars) break;
      this.entries.delete(f);
      total -= e.text.length;
    }
  }

  private forget(listed: Set<string>): void {
    for (const f of this.entries.keys()) if (!listed.has(f)) this.entries.delete(f);
    for (const f of this.queue) if (!listed.has(f)) this.queue.delete(f);
  }
}
