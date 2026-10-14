import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FileKind } from "../protocol.ts";
import { indexedFiles } from "./files.ts";
import { inside, isSecretPath } from "./secret-paths.ts";

export { inside, isSecretPath };

// What Claude Code's read_file allows at most, and what the viewer reads of a text file.
export const MAX_BINARY_BYTES = 10_000_000;
export const MAX_TEXT_BYTES = 1_000_000;
const MAX_HREF = 4096;
const SNIFF_CHARS = 8000;

export type ReadErrorCode = "invalid" | "not_found" | "denied" | "too_large" | "failed";

export class ReadError extends Error {
  readonly code: ReadErrorCode;

  constructor(code: ReadErrorCode, message: string = code) {
    super(message);
    this.code = code;
  }
}

export interface LinkTarget {
  path: string;
  line?: number;
  endLine?: number;
  heading?: string;
}

export interface Resolved {
  abs: string;
  fallback?: "parent" | "suffix";
}

export interface FileContents {
  contents: string;
  absPath?: string;
  truncated: boolean;
  base64: boolean;
}

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const lineNo = (s: string | undefined): number | undefined => {
  const n = s === undefined ? NaN : Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
};

// A link in Claude's answer as a path and an anchor: relative or absolute paths, file:// URLs,
// percent-encoding, #L42, #L42-L50, :42, :42:7 and #heading. Other URL schemes are not files.
export function parseLink(href: string): LinkTarget | undefined {
  let s = href.trim();
  let hash = "";
  if (!s || s.length > MAX_HREF || s.includes("\0")) return undefined;
  if (/^file:/i.test(s)) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return undefined;
    }
    if (u.host && u.host !== "localhost") return undefined;
    hash = u.hash.slice(1);
    s = decode(u.pathname);
  } else {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(javascript|data|mailto|tel|blob|vbscript|about):/i.test(s)) return undefined;
    const at = s.indexOf("#");
    if (at !== -1) {
      hash = s.slice(at + 1);
      s = s.slice(0, at);
    }
    s = decode(s);
  }
  const out: LinkTarget = { path: s };
  const setLines = (from?: string, to?: string) => {
    const line = lineNo(from);
    const end = lineNo(to);
    if (line) out.line = line;
    if (line && end && end >= line) out.endLine = end;
  };
  const range = /^L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/i.exec(hash) ?? /^(\d+)(?:-(\d+))?$/.exec(hash);
  if (range) setLines(range[1], range[2]);
  else if (hash) out.heading = decode(hash);
  const m = out.line ? null : /^(.+?):(\d+)(?::\d+)?(?:-(\d+))?$/.exec(s);
  if (m) {
    out.path = m[1];
    setLines(m[2], m[3]);
  }
  if (out.path === "~" || out.path.startsWith("~/")) out.path = path.join(os.homedir(), out.path.slice(1));
  return out.path && !out.path.includes("\0") ? out : undefined;
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isFile();
  } catch {
    return false;
  }
}

// Finds the file a link means. Relative links try each base in turn; when none has the file, the
// leading ./ and ../ are dropped, and then a file under a root whose path ends with the link's last
// segments counts if it is the only one.
export async function resolveLink(p: string, bases: string[], roots: string[], index = indexedFiles): Promise<Resolved | undefined> {
  const absolute = path.isAbsolute(p);
  for (const t of absolute ? [path.normalize(p)] : bases.map((b) => path.resolve(b, p))) {
    if (await isFile(t)) return { abs: t };
  }
  const segs = p.split(/[\\/]+/).filter(Boolean);
  if (!absolute) {
    let i = 0;
    while (i < segs.length && (segs[i] === "." || segs[i] === "..")) i++;
    if (i > 0 && i < segs.length) {
      for (const b of bases) {
        const t = path.join(b, ...segs.slice(i));
        if (await isFile(t)) return { abs: t, fallback: "parent" };
      }
    }
  }
  const last = Math.max(segs.lastIndexOf("."), segs.lastIndexOf(".."));
  const tail = segs.slice(last + 1);
  if (tail.length < 2) return undefined;
  const lists = await Promise.all(roots.map(async (r) => ({ root: r, files: await index(r).catch(() => [] as string[]) })));
  for (let n = tail.length; n >= 2; n--) {
    const suffix = tail.slice(-n).join("/");
    const found = new Set<string>();
    for (const { root, files } of lists) {
      for (const f of files) if (f === suffix || f.endsWith(`/${suffix}`)) found.add(path.join(root, f));
    }
    if (found.size > 1) return undefined;
    if (found.size === 1) {
      const abs = [...found][0];
      return (await isFile(abs)) ? { abs, fallback: "suffix" } : undefined;
    }
  }
  return undefined;
}

// The real path when it lies inside one of the roots, after links are resolved on both sides.
export async function scopedPath(abs: string, roots: string[]): Promise<string> {
  let real: string;
  try {
    real = await fs.promises.realpath(abs);
  } catch {
    throw new ReadError("not_found");
  }
  for (const r of roots) {
    const root = await fs.promises.realpath(r).catch(() => undefined);
    if (root && inside(real, root)) return real;
  }
  throw new ReadError("denied", `read denied: ${abs}`);
}

// Reads a file the broker checked itself: at most `max` bytes of a regular file inside the roots.
export async function readDirect(abs: string, roots: string[], max: number): Promise<{ data: Buffer; size: number; truncated: boolean }> {
  if (isSecretPath(abs)) throw new ReadError("denied", `read denied: ${abs}`);
  const real = await scopedPath(abs, roots);
  if (isSecretPath(real)) throw new ReadError("denied", `read denied: ${abs}`);
  const fh = await fs.promises.open(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW).catch(() => {
    throw new ReadError("not_found");
  });
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new ReadError("not_found");
    const want = Math.min(st.size, max);
    const data = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const { bytesRead } = await fh.read(data, got, want - got, got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    return { data: data.subarray(0, got), size: st.size, truncated: st.size > got };
  } finally {
    await fh.close();
  }
}

// Claude Code's answer to read_file.
export function fileContents(r: Record<string, unknown> | undefined): FileContents {
  if (!r || typeof r.contents !== "string") throw new ReadError("failed", "Claude Code gave no file");
  return {
    contents: r.contents,
    absPath: typeof r.absPath === "string" ? r.absPath : undefined,
    truncated: r.truncated === true,
    base64: r.encoding === "base64",
  };
}

// Claude Code reports a refusal or a missing file as an error message.
export function readFailure(e: unknown): ReadError {
  if (e instanceof ReadError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  if (/denied|not allowed|permission/i.test(msg)) return new ReadError("denied", msg);
  if (/ENOENT|not found|no such file|does not exist|not a (regular )?file|EISDIR/i.test(msg)) return new ReadError("not_found", msg);
  if (/too large|exceeds/i.test(msg)) return new ReadError("too_large", msg);
  return new ReadError("failed", msg);
}

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  heic: "image/heic",
};
const BINARY_EXT = new Set(
  "zip gz tgz bz2 xz zst 7z rar tar exe dll so dylib bin o a class jar war wasm mp3 mp4 m4a mov avi mkv webm wav flac ogg ttf otf woff woff2 eot sqlite sqlite3 db pyc pyo npy npz pt pth onnx safetensors ckpt h5 pkl parquet xls xlsx doc docx ppt pptx key numbers pages psd ai dmg iso img deb rpm".split(
    " ",
  ),
);

export function extOf(p: string): string {
  const name = path.basename(p).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

// The kind is known from the name for everything but text, which may turn out to be binary.
export function kindOf(p: string): FileKind {
  const ext = extOf(p);
  if (IMAGE_TYPES[ext]) return "image";
  if (ext === "pdf") return "pdf";
  if (ext === "md" || ext === "markdown" || ext === "mdx") return "markdown";
  if (ext === "json") return "json";
  if (ext === "csv") return "csv";
  if (ext === "tsv") return "tsv";
  if (BINARY_EXT.has(ext)) return "binary";
  return "text";
}

// The only types served as themselves; anything else is sent as bytes nothing renders.
export function servedType(p: string): string {
  const ext = extOf(p);
  return IMAGE_TYPES[ext] ?? (ext === "pdf" ? "application/pdf" : "application/octet-stream");
}

export function looksBinary(text: string): boolean {
  const head = text.slice(0, SNIFF_CHARS);
  if (head.includes("\0")) return true;
  let bad = 0;
  for (const c of head) if (c === "�" && ++bad > 8) return true;
  return false;
}

function dirsFrom(file: string, base: string): string[] {
  try {
    const dirs = (JSON.parse(fs.readFileSync(file, "utf8")) as { permissions?: { additionalDirectories?: unknown } }).permissions?.additionalDirectories;
    if (!Array.isArray(dirs)) return [];
    return dirs
      .filter((d): d is string => typeof d === "string" && d.length > 0)
      .map((d) => (d === "~" || d.startsWith("~/") ? path.join(os.homedir(), d.slice(1)) : path.resolve(base, d)));
  } catch {
    return [];
  }
}

// Additional working directories from the user's and the project's Claude Code settings.
export function additionalDirectories(userSettings: string, cwd: string): string[] {
  const files = [userSettings, path.join(cwd, ".claude", "settings.json"), path.join(cwd, ".claude", "settings.local.json")];
  return [...new Set(files.flatMap((f) => dirsFrom(f, cwd)))];
}
