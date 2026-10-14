import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import type { AuditEntry, AuditPage } from "../admin-protocol.ts";
import { parseLine } from "../link/lines.ts";
import type { RouteDeps } from "./types.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const CHUNK = 64 * 1024;
const MAX_LINE = 64 * 1024;

function entry(line: Buffer): AuditEntry | undefined {
  const v = parseLine(line);
  return v && typeof v.ts === "string" && typeof v.event === "string" ? (v as AuditEntry) : undefined;
}

// The entries of a JSONL log that end before byte `before` (the end of the file without it), newest
// first. The file is read backwards in chunks, and a line too long to be an entry is skipped unread.
export async function readAuditTail(file: string, limit: number, before?: number, chunkSize = CHUNK): Promise<AuditPage> {
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(file, "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { entries: [] };
    throw e;
  }
  try {
    const entries: AuditEntry[] = [];
    let end = Math.min(before ?? Infinity, (await fh.stat()).size);
    // pending holds the bytes [pos, end) not yet split into lines.
    let pos = end;
    let pending = Buffer.alloc(0);
    let overlong = false;
    while (end > 0 && entries.length < limit) {
      const nl = pending.lastIndexOf(10);
      if (nl === -1 && pos > 0) {
        const len = Math.min(chunkSize, pos);
        const chunk = Buffer.alloc(len);
        await fh.read(chunk, 0, len, pos - len);
        pos -= len;
        const cut = chunk.lastIndexOf(10);
        if (overlong || pending.length + len - cut - 1 > MAX_LINE) {
          overlong = true;
          pending = chunk.subarray(0, cut + 1);
        } else pending = Buffer.concat([chunk, pending]);
        continue;
      }
      const e = overlong ? undefined : entry(pending.subarray(nl + 1));
      if (e) entries.push(e);
      overlong = false;
      pending = pending.subarray(0, Math.max(nl, 0));
      end = pos + Math.max(nl, 0);
    }
    return end > 0 ? { entries, next: end } : { entries };
  } finally {
    await fh.close();
  }
}

export async function registerAudit(app: FastifyInstance, d: RouteDeps): Promise<void> {
  app.get<{ Querystring: { limit?: unknown; before?: unknown } }>("/api/audit", { preHandler: d.requireAuth }, async (req, reply) => {
    const { limit = String(DEFAULT_LIMIT), before } = req.query;
    const n = typeof limit === "string" && /^\d{1,3}$/.test(limit) ? Number(limit) : 0;
    if (n < 1 || n > MAX_LIMIT || (before !== undefined && (typeof before !== "string" || !/^\d{1,15}$/.test(before)))) {
      return reply.code(400).send({ error: "invalid" });
    }
    return readAuditTail(d.audit.file, n, before === undefined ? undefined : Number(before));
  });
}
