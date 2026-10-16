import fs from "node:fs";
import path from "node:path";
import type { DisplayItem, SentFile } from "../protocol.ts";
import { isSecretPath } from "./secret-paths.ts";

const FILES_MAX = 20;
const PATH_MAX = 4096;
const NAME_MAX = 255;
const MEDIA_TYPE_MAX = 100;
const ERROR_MAX = 200;
// A file written this long after its call had changed by the time it was opened.
const CHANGED_AFTER_MS = 2000;
const CALLS_KEEP = 500;
const SESSIONS_KEEP = 50;
const CHUNK_BYTES = 4 * 1024 * 1024;

type Obj = Record<string, unknown>;

const record = (v: unknown): Obj | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);

// The files a SendUserFile result lists in its structured output; undefined when it has none. A file is served only when
// Claude Code resolved it to an absolute path on this machine and reported no failure for it.
export function sentFiles(output: unknown): SentFile[] | undefined {
  const list = record(output)?.attachments;
  if (!Array.isArray(list)) return undefined;
  const files: SentFile[] = [];
  for (const v of list) {
    if (files.length === FILES_MAX) break;
    const a = record(v);
    const p = a?.path;
    if (!a || typeof p !== "string" || !p) continue;
    const local = a.pathValidated === true && typeof a.upload_error !== "string" && p.length <= PATH_MAX && path.isAbsolute(p) && !p.includes("\0");
    const why = [a.upload_error, a.partial_error].find((e): e is string => typeof e === "string" && e !== "");
    const media = typeof a.media_type === "string" && a.media_type ? a.media_type.slice(0, MEDIA_TYPE_MAX) : undefined;
    files.push({
      name: (path.basename(p) || p).slice(0, NAME_MAX),
      path: p.slice(0, PATH_MAX),
      size: typeof a.size === "number" && Number.isFinite(a.size) && a.size >= 0 ? a.size : 0,
      ...(media ? { mediaType: media } : {}),
      ...(a.isImage === true ? { image: true } : {}),
      ...(local ? {} : { error: why?.slice(0, ERROR_MAX) ?? "" }),
    });
  }
  return files;
}

// A SendUserFile call's files and when it was made, in ms.
export interface SentCall {
  files: SentFile[];
  at?: number;
}

export function sentCall(item: DisplayItem | undefined): SentCall | undefined {
  if (item?.kind !== "tool" || item.name !== "SendUserFile" || !item.sent) return undefined;
  const at = item.ts ? Date.parse(item.ts) : NaN;
  return { files: item.sent, ...(Number.isFinite(at) ? { at } : {}) };
}

// Calls each whole line of a file that holds `needle`, reading the file in chunks.
async function linesWith(file: string, needle: Buffer, each: (line: string) => void): Promise<void> {
  const fh = await fs.promises.open(file, "r");
  try {
    const chunk = Buffer.alloc(CHUNK_BYTES);
    let carry = Buffer.alloc(0);
    let pos = 0;
    for (;;) {
      const { bytesRead } = await fh.read(chunk, 0, CHUNK_BYTES, pos);
      pos += bytesRead;
      const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      const done = bytesRead === 0;
      const end = done ? buf.length : buf.lastIndexOf(10) + 1;
      const whole = buf.subarray(0, end);
      for (let at = whole.indexOf(needle); at >= 0; ) {
        const start = whole.lastIndexOf(10, at) + 1;
        const nl = whole.indexOf(10, at);
        const stop = nl < 0 ? whole.length : nl;
        each(whole.subarray(start, stop).toString("utf8"));
        at = nl < 0 ? -1 : whole.indexOf(needle, stop);
      }
      if (done) return;
      carry = Buffer.from(buf.subarray(end));
    }
  } finally {
    await fh.close();
  }
}

// A SendUserFile call as a transcript keeps it: the call's own row names the tool, the row of its result lists the files.
export async function transcriptCall(file: string, call: string): Promise<SentCall | undefined> {
  let at: number | undefined;
  let named = false;
  let files: SentFile[] | undefined;
  await linesWith(file, Buffer.from(JSON.stringify(call)), (line) => {
    let e: Obj | undefined;
    try {
      e = record(JSON.parse(line));
    } catch {
      return;
    }
    const content = record(e?.message)?.content;
    if (!e || !Array.isArray(content)) return;
    for (const b of content.map(record)) {
      if (b?.type === "tool_use" && b.id === call && b.name === "SendUserFile") {
        named = true;
        const t = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
        if (Number.isFinite(t)) at = t;
      } else if (b?.type === "tool_result" && b.tool_use_id === call && b.is_error !== true) {
        files = sentFiles(e.toolUseResult) ?? files;
      }
    }
  });
  return named && files ? { files, ...(at !== undefined ? { at } : {}) } : undefined;
}

// The SendUserFile calls of sessions no process here runs, by session and call: from the conversations read for the
// phone, and else from their transcripts.
export class SentIndex {
  private sessions = new Map<string, Map<string, SentCall>>();

  add(sessionId: string, items: DisplayItem[]): void {
    for (const item of items) {
      const c = sentCall(item);
      if (c) this.keep(sessionId, item.id, c);
    }
  }

  async find(sessionId: string, call: string, transcript: () => Promise<string | undefined>): Promise<SentCall | undefined> {
    const known = this.sessions.get(sessionId)?.get(call);
    if (known) return known;
    const file = await transcript();
    const found = file ? await transcriptCall(file, call).catch(() => undefined) : undefined;
    if (found) this.keep(sessionId, call, found);
    return found;
  }

  private keep(sessionId: string, call: string, c: SentCall): void {
    const calls = this.sessions.get(sessionId) ?? new Map<string, SentCall>();
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, calls);
    calls.delete(call);
    calls.set(call, c);
    for (const old of [...calls.keys()].slice(0, -CALLS_KEEP)) calls.delete(old);
    for (const old of [...this.sessions.keys()].slice(0, -SESSIONS_KEEP)) this.sessions.delete(old);
  }
}

export type SentErrorCode = "not_sent" | "denied" | "gone" | "too_large";

export class SentError extends Error {
  readonly code: SentErrorCode;

  constructor(code: SentErrorCode) {
    super(code);
    this.code = code;
  }
}

export interface OpenedSent {
  fh: fs.promises.FileHandle;
  size: number;
  mtimeMs: number;
  // The file is not as it was sent: its size differs, or it was written after the call.
  changed: boolean;
}

// Opens a file Claude sent, wherever it lies: never a secret file, by its path or by where its links lead, and only a
// regular file of at most `max` bytes, opened without following a link or waiting on a pipe. `at`: when it was sent.
export async function openSent(file: SentFile, max: number, at?: number): Promise<OpenedSent> {
  if (file.error !== undefined || !path.isAbsolute(file.path) || file.path.includes("\0")) throw new SentError("not_sent");
  if (isSecretPath(file.path)) throw new SentError("denied");
  const real = await fs.promises.realpath(file.path).catch(() => {
    throw new SentError("gone");
  });
  if (isSecretPath(real)) throw new SentError("denied");
  const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
  const fh = await fs.promises.open(real, flags).catch(() => {
    throw new SentError("gone");
  });
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new SentError("gone");
    if (st.size > max) throw new SentError("too_large");
    const changed = st.size !== file.size || (at !== undefined && st.mtimeMs > at + CHANGED_AFTER_MS);
    return { fh, size: st.size, mtimeMs: st.mtimeMs, changed };
  } catch (e) {
    await fh.close();
    throw e;
  }
}
