import fs from "node:fs";
import type { UserAttachment } from "../protocol.ts";

type Block = Record<string, unknown>;

const MEDIA_TYPE_MAX = 100;
const NAME_MAX = 200;
const CHUNK_BYTES = 4 * 1024 * 1024;
const CACHE_BYTES = 32 * 1024 * 1024;
const CACHE_ENTRIES = 64;
export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const record = (v: unknown): Block | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Block) : undefined);

function base64Bytes(data: string): number {
  const pad = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - pad);
}

function sizeOf(source: Block | undefined): number {
  const data = source?.data;
  if (typeof data !== "string") return 0;
  return source?.type === "base64" ? base64Bytes(data) : source?.type === "text" ? Buffer.byteLength(data) : 0;
}

// Images and documents of a user message in block order; a block's position here is its index in the route.
export function attachmentsOf(blocks: readonly Block[]): UserAttachment[] {
  const out: UserAttachment[] = [];
  for (const b of blocks) {
    if (b?.type !== "image" && b?.type !== "document") continue;
    const source = record(b.source);
    const media = typeof source?.media_type === "string" ? source.media_type.slice(0, MEDIA_TYPE_MAX) : "";
    const name = typeof b.title === "string" && b.title ? b.title.slice(0, NAME_MAX) : undefined;
    out.push({ kind: b.type, mediaType: media, size: sizeOf(source), ...(name ? { name } : {}) });
  }
  return out;
}

export interface AttachedImage {
  mediaType: string;
  data: Buffer;
}

// The leading bytes of the four image formats Claude reads.
export function imageType(b: Buffer): string | undefined {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  const head = b.subarray(0, 12).toString("latin1");
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8) === "WEBP") return "image/webp";
  return undefined;
}

// The content of the transcript row that holds a user message: the user row with that uuid, or a
// message sent while Claude was working, kept in a queued_command attachment under its source uuid.
function contentOf(line: string, id: string): Block[] | undefined {
  let e: Block;
  try {
    e = JSON.parse(line) as Block;
  } catch {
    return undefined;
  }
  if (e.isSidechain === true) return undefined;
  let content: unknown;
  if (e.type === "user" && e.uuid === id) content = record(e.message)?.content;
  const q = record(e.attachment);
  if (e.type === "attachment" && q?.type === "queued_command" && (q.source_uuid === id || (!q.source_uuid && e.uuid === id))) content = q.prompt;
  return Array.isArray(content) ? (content as Block[]) : undefined;
}

// Reads the transcript in chunks and parses only lines that name the message.
async function findContent(file: string, id: string): Promise<Block[] | undefined> {
  const needles = [Buffer.from(`"uuid":"${id}"`), Buffer.from(`"source_uuid":"${id}"`)];
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
      for (const needle of needles) {
        for (let at = whole.indexOf(needle); at >= 0; ) {
          const start = whole.lastIndexOf(10, at) + 1;
          const nl = whole.indexOf(10, at);
          const stop = nl < 0 ? whole.length : nl;
          const content = contentOf(whole.subarray(start, stop).toString("utf8"), id);
          if (content) return content;
          at = nl < 0 ? -1 : whole.indexOf(needle, stop);
        }
      }
      if (done) return undefined;
      carry = Buffer.from(buf.subarray(end));
    }
  } finally {
    await fh.close();
  }
}

// A user message's blocks as its transcript row holds them, or undefined when the transcript has no such message.
export function messageBlocks(file: string, id: string): Promise<Block[] | undefined> {
  return findContent(file, id).catch(() => undefined);
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

// The images and documents of a message as files to upload again, in the order attachmentsOf lists them: an image or
// PDF in base64 or a plain text document, or "unreadable" for any other source or broken data.
export function attachedFiles(blocks: readonly Block[]): ({ data: Buffer; name: string; mediaType: string } | { failed: "unreadable" })[] {
  let images = 0;
  return blocks
    .filter((b) => b?.type === "image" || b?.type === "document")
    .map((b) => {
      const source = record(b.source);
      const title = typeof b.title === "string" ? b.title.trim().slice(0, NAME_MAX) : "";
      if (b.type === "image") {
        const data = source?.type === "base64" && typeof source.data === "string" ? Buffer.from(source.data, "base64") : undefined;
        const mediaType = data && imageType(data);
        if (!data || !mediaType) return { failed: "unreadable" as const };
        images++;
        return { data, name: title || `image-${images}.${EXT[mediaType]}`, mediaType };
      }
      if (source?.type === "base64" && source.media_type === "application/pdf" && typeof source.data === "string") {
        return { data: Buffer.from(source.data, "base64"), name: title || "document.pdf", mediaType: "application/pdf" };
      }
      if (source?.type === "text" && typeof source.data === "string") return { data: Buffer.from(source.data, "utf8"), name: title || "document.txt", mediaType: "text/plain" };
      return { failed: "unreadable" as const };
    });
}

export type ImageLookup = { image: AttachedImage } | { error: "not_found" | "not_image" };

interface Entry {
  images: (AttachedImage | undefined)[];
  bytes: number;
}

// Images of user messages read from transcripts on demand. A few recent messages stay decoded, so the
// thumbnails of one message cost one read of the transcript.
export class AttachmentReader {
  private cache = new Map<string, Entry>();
  private bytes = 0;
  private reading = new Map<string, Promise<Entry | undefined>>();

  async image(file: string, messageId: string, index: number): Promise<ImageLookup> {
    const entry = await this.entry(file, messageId);
    if (!entry || index >= entry.images.length) return { error: "not_found" };
    const image = entry.images[index];
    return image ? { image } : { error: "not_image" };
  }

  private async entry(file: string, messageId: string): Promise<Entry | undefined> {
    const key = `${file}\0${messageId}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    let p = this.reading.get(key);
    if (!p) {
      p = this.read(file, messageId).finally(() => this.reading.delete(key));
      this.reading.set(key, p);
    }
    const entry = await p;
    if (entry && !this.cache.has(key)) this.keep(key, entry);
    return entry;
  }

  private async read(file: string, messageId: string): Promise<Entry | undefined> {
    const content = await findContent(file, messageId).catch(() => undefined);
    if (!content) return undefined;
    const images = content
      .filter((b) => b?.type === "image" || b?.type === "document")
      .map((b): AttachedImage | undefined => {
        const source = record(b.source);
        if (b.type !== "image" || source?.type !== "base64" || typeof source.data !== "string" || !IMAGE_TYPES.has(String(source.media_type))) return undefined;
        const data = Buffer.from(source.data, "base64");
        const mediaType = imageType(data);
        return mediaType ? { mediaType, data } : undefined;
      });
    return { images, bytes: images.reduce((n, i) => n + (i?.data.length ?? 0), 0) };
  }

  private keep(key: string, entry: Entry): void {
    if (entry.bytes > CACHE_BYTES) return;
    this.cache.set(key, entry);
    this.bytes += entry.bytes;
    for (const [k, e] of this.cache) {
      if (this.bytes <= CACHE_BYTES && this.cache.size <= CACHE_ENTRIES) break;
      this.cache.delete(k);
      this.bytes -= e.bytes;
    }
  }
}
