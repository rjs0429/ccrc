import fs from "node:fs";
import path from "node:path";
import { isUtf8 } from "node:buffer";
import { randomBytes } from "node:crypto";
import { ensureDir } from "./config.ts";
import type { ContentBlock } from "./sessions/core.ts";
import type { UploadInfo } from "./protocol.ts";

type Kind = UploadInfo["kind"];

const MB = 1024 * 1024;
const LIMITS: Record<Kind, number> = { image: 5 * MB, pdf: 10 * MB, text: 200 * 1024 };
// The largest body the upload route reads.
export const MAX_UPLOAD_BYTES = 10 * MB;
// All attachments of a message reach Claude Code base64-encoded in one line, which has to pass the wrapper link.
const MAX_MESSAGE_BYTES = 10 * MB;
const KEEP_MS = 24 * 3600_000;
const SWEEP_MS = 3600_000;
const ID = /^[0-9a-f]{32}$/;
const STORED = /^[0-9a-f]{32}(\.json)?$/;

const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp"]);
const TEXT_EXT = new Set(
  (
    "txt md markdown rst adoc org tex csv tsv log json jsonl ndjson yaml yml toml ini cfg conf properties env xml html htm svg css scss sass less " +
    "js mjs cjs jsx ts mts cts tsx vue svelte astro py pyi ipynb rb go rs java kt kts scala groovy gradle swift m mm c h cc cpp cxx hh hpp hxx cs fs " +
    "php pl pm lua r dart ex exs erl hrl hs ml mli clj cljs elm zig nim jl sql graphql gql proto thrift sh bash zsh fish ps1 bat cmd " +
    "dockerfile makefile mk cmake tf hcl nix diff patch lock gitignore gitattributes editorconfig"
  ).split(" "),
);
const TEXT_NAMES = new Set(["makefile", "dockerfile", "license", "readme", "changelog", "procfile", "gemfile", "rakefile", "jenkinsfile"]);
const TEXT_MIME = new Set(["application/json", "application/xml", "application/yaml", "application/x-yaml", "application/javascript", "application/x-sh", "application/toml", "application/sql"]);

// An upload the route answers with an HTTP status; `message` is the error code sent to the client.
export class UploadError extends Error {
  status: number;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
  }
}

interface Stored {
  name: string;
  kind: Kind;
  mediaType: string;
  size: number;
  at: number;
}

function imageType(b: Buffer): string | undefined {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  const head = b.subarray(0, 12).toString("latin1");
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8) === "WEBP") return "image/webp";
  return undefined;
}

function isText(data: Buffer, name: string, ext: string, mime: string): boolean {
  const known = TEXT_EXT.has(ext) || TEXT_NAMES.has(name.toLowerCase()) || mime.startsWith("text/") || TEXT_MIME.has(mime) || /\+(json|xml)$/.test(mime);
  return known && isUtf8(data) && !data.includes(0);
}

// The kind is decided by the content; the name and the browser's type only say which kinds to try.
function detect(data: Buffer, name: string, mime: string): { kind: Kind; mediaType: string } | undefined {
  const ext = path.extname(name).slice(1).toLowerCase() || (name.startsWith(".") ? name.slice(1).toLowerCase() : "");
  const image = imageType(data);
  if (image && (mime.startsWith("image/") || IMAGE_EXT.has(ext))) return { kind: "image", mediaType: image };
  if ((mime === "application/pdf" || ext === "pdf") && data.subarray(0, 1024).includes("%PDF-")) return { kind: "pdf", mediaType: "application/pdf" };
  if (isText(data, name, ext, mime)) return { kind: "text", mediaType: "text/plain" };
  return undefined;
}

function cleanName(name: string): string {
  const base = name.replace(/[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "").split(/[\\/]/).pop() ?? "";
  return base.trim().slice(0, 200) || "file";
}

// The block the VS Code extension builds for the same file.
function block(s: Stored, data: Buffer): ContentBlock {
  if (s.kind === "image") return { type: "image", source: { type: "base64", media_type: s.mediaType, data: data.toString("base64") } };
  if (s.kind === "pdf") return { type: "document", source: { type: "base64", media_type: "application/pdf", data: data.toString("base64") }, title: s.name };
  return { type: "document", source: { type: "text", media_type: "text/plain", data: data.toString("utf8").replace(/^\uFEFF/, "") }, title: s.name };
}

// Files uploaded from the web client for the next message, kept briefly on this machine.
export class Uploads {
  readonly dir: string;
  private sweeper: NodeJS.Timeout;

  constructor(dir: string) {
    this.dir = dir;
    ensureDir(dir);
    fs.chmodSync(dir, 0o700);
    void this.sweep();
    this.sweeper = setInterval(() => void this.sweep(), SWEEP_MS);
    this.sweeper.unref();
  }

  async save(data: Buffer, name: string, mime: string): Promise<UploadInfo> {
    if (!data.length) throw new UploadError(400, "empty");
    const type = detect(data, name, mime);
    if (!type) throw new UploadError(415, "unsupported");
    if (data.length > LIMITS[type.kind]) throw new UploadError(413, "too_large");
    const id = randomBytes(16).toString("hex");
    const stored: Stored = { name: cleanName(name), ...type, size: data.length, at: Date.now() };
    await fs.promises.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(path.join(this.dir, id), data, { mode: 0o600, flag: "wx" });
    await fs.promises.writeFile(path.join(this.dir, `${id}.json`), JSON.stringify(stored), { mode: 0o600, flag: "wx" });
    return { id, name: stored.name, kind: stored.kind, size: stored.size };
  }

  // Claude Code content blocks for uploaded files, in the given order.
  async blocks(ids: string[]): Promise<ContentBlock[]> {
    const stored = await Promise.all(ids.map((id) => this.stored(id)));
    if (stored.reduce((n, s) => n + s.size, 0) > MAX_MESSAGE_BYTES) throw Error("attachments too large");
    return Promise.all(ids.map(async (id, i) => block(stored[i], await this.read(id))));
  }

  // Removes uploads older than a day.
  async sweep(now = Date.now()): Promise<void> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.dir);
    } catch {
      return;
    }
    for (const name of names.filter((n) => STORED.test(n))) {
      const file = path.join(this.dir, name);
      try {
        if (now - (await fs.promises.stat(file)).mtimeMs > KEEP_MS) await fs.promises.rm(file, { force: true });
      } catch {}
    }
  }

  private async stored(id: string): Promise<Stored> {
    if (!ID.test(id)) throw Error("invalid request");
    let s: Stored;
    try {
      s = JSON.parse(await fs.promises.readFile(path.join(this.dir, `${id}.json`), "utf8")) as Stored;
    } catch {
      throw Error("attachment expired");
    }
    if (!(s.kind in LIMITS) || typeof s.size !== "number" || !(Date.now() - s.at <= KEEP_MS)) throw Error("attachment expired");
    return s;
  }

  private async read(id: string): Promise<Buffer> {
    try {
      return await fs.promises.readFile(path.join(this.dir, id));
    } catch {
      throw Error("attachment expired");
    }
  }
}
