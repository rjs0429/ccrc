import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SENT_MAX_BYTES, type FileView, type SentFile, type SentRef } from "../protocol.ts";
import { MAX_TEXT_BYTES, kindOf, looksBinary, servedType } from "../sessions/file-read.ts";
import { SentError, openSent, type OpenedSent } from "../sessions/sent-files.ts";
import { rawHeaders } from "./raw.ts";
import type { RouteDeps } from "./types.ts";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const INDEX = /^\d{1,2}$/;
const LOGGED_PATH_MAX = 1024;
const STATUS: Record<string, number> = { unknown_session: 404, not_found: 404, not_sent: 404, gone: 404, denied: 403, too_large: 413, failed: 502 };
// The browser may keep a thumbnail but asks again each time, so a signed-out device gets nothing from its cache.
const KEPT = "private, no-cache";

function parseRef(call: unknown, n: unknown, agent: unknown): SentRef | undefined {
  const index = typeof n === "number" ? String(n) : n;
  if (typeof call !== "string" || !ID.test(call) || typeof index !== "string" || !INDEX.test(index)) return undefined;
  if (agent !== undefined && (typeof agent !== "string" || !ID.test(agent))) return undefined;
  return { call, n: Number(index), ...(agent ? { agent } : {}) };
}

export function sentRef(v: unknown): SentRef | undefined {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  return parseRef(r.call, r.n, r.agent);
}

async function readText(o: OpenedSent): Promise<{ text: string; truncated: boolean }> {
  const want = Math.min(o.size, MAX_TEXT_BYTES);
  const data = Buffer.alloc(want);
  let got = 0;
  while (got < want) {
    const { bytesRead } = await o.fh.read(data, got, want - got, got);
    if (!bytesRead) break;
    got += bytesRead;
  }
  return { text: data.subarray(0, got).toString("utf8"), truncated: o.size > got };
}

export interface SentServer {
  raw(req: FastifyRequest, reply: FastifyReply, sessionId: string, ref: SentRef, download: boolean, extra?: Record<string, unknown>): Promise<unknown>;
}

// The files Claude sent with SendUserFile, found by the call that sent them, never by a path the phone gives. They open
// wherever they lie, outside the working folders too, as Claude Code checked them when it sent them; secret files stay
// refused. GET .../sent/:call/:n shows one in the viewer, .../raw serves its bytes.
export async function registerSent(app: FastifyInstance, d: RouteDeps): Promise<SentServer> {
  const find = async (sessionId: string, ref: SentRef): Promise<{ file: SentFile; at?: number } | { error: string }> => {
    let call;
    try {
      call = await d.manager.sentCall(sessionId, ref.call, ref.agent);
    } catch {
      return { error: "unknown_session" };
    }
    const file = call?.files[ref.n];
    return file ? { file, at: call!.at } : { error: "not_found" };
  };
  const log = (req: FastifyRequest, sessionId: string, ref: SentRef, outcome: string, file?: SentFile, extra: Record<string, unknown> = {}) =>
    d.audit.log("file_read", {
      device: req.device,
      sessionId,
      ...(file ? { path: file.path.slice(0, LOGGED_PATH_MAX) } : {}),
      outcome,
      sent: true,
      ...ref,
      via: "broker",
      ...extra,
    });
  const open = async (req: FastifyRequest, reply: FastifyReply, sessionId: string, ref: SentRef, extra: Record<string, unknown> = {}) => {
    const found = await find(sessionId, ref);
    if ("error" in found) {
      log(req, sessionId, ref, found.error, undefined, extra);
      return { failed: reply.code(STATUS[found.error]).send({ error: found.error }) };
    }
    try {
      return { file: found.file, opened: await openSent(found.file, SENT_MAX_BYTES, found.at) };
    } catch (e) {
      const code = e instanceof SentError ? e.code : "failed";
      log(req, sessionId, ref, code, found.file, extra);
      return { failed: reply.code(STATUS[code]).send({ error: code }) };
    }
  };

  app.get<{ Params: { id: string; call: string; n: string }; Querystring: { agent?: unknown } }>(
    "/api/sessions/:id/sent/:call/:n",
    { preHandler: d.requireAuth },
    async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      const ref = parseRef(req.params.call, req.params.n, req.query.agent);
      if (!ref) return reply.code(400).send({ error: "invalid" });
      const o = await open(req, reply, req.params.id, ref);
      if ("failed" in o) return o.failed;
      const { file, opened } = o;
      try {
        let kind = kindOf(file.path);
        let read = kind === "image" || kind === "pdf" || kind === "binary" ? undefined : await readText(opened);
        if (read && looksBinary(read.text)) {
          kind = "binary";
          read = undefined;
        }
        log(req, req.params.id, ref, read?.truncated ? "truncated" : "ok", file);
        const view: FileView = { path: file.path, name: file.name, size: opened.size, kind, ...(read ?? {}), via: "broker", sent: { changed: opened.changed } };
        return view;
      } finally {
        await opened.fh.close();
      }
    },
  );

  // A thumbnail is asked for again whenever it shows; an unchanged file answers 304 with the same policy, which the
  // browser takes over for the bytes it kept.
  const raw: SentServer["raw"] = async (req, reply, sessionId, ref, download, extra = {}) => {
    reply.header("Cache-Control", "no-store");
    const o = await open(req, reply, sessionId, ref, { raw: true, ...extra });
    if ("failed" in o) return o.failed;
    const { file, opened } = o;
    const etag = `"${opened.size}-${opened.mtimeMs}"`;
    rawHeaders(reply, file.name, servedType(file.path), download).header("Cache-Control", KEPT).header("ETag", etag).header("Cross-Origin-Resource-Policy", "same-origin");
    if (req.headers["if-none-match"] === etag) {
      await opened.fh.close();
      log(req, sessionId, ref, "not_modified", file, { raw: true, ...extra });
      return reply.code(304).send();
    }
    log(req, sessionId, ref, "ok", file, { raw: true, ...extra });
    const body = opened.size ? opened.fh.createReadStream({ start: 0, end: opened.size - 1 }) : Buffer.alloc(0);
    if (!opened.size) await opened.fh.close();
    return reply.header("Content-Length", opened.size).send(body);
  };

  app.get<{ Params: { id: string; call: string; n: string }; Querystring: { agent?: unknown; download?: unknown } }>(
    "/api/sessions/:id/sent/:call/:n/raw",
    { preHandler: d.requireAuth },
    async (req, reply) => {
      const ref = parseRef(req.params.call, req.params.n, req.query.agent);
      if (!ref) return reply.code(400).header("Cache-Control", "no-store").send({ error: "invalid" });
      return raw(req, reply, req.params.id, ref, req.query.download === "1");
    },
  );

  return { raw };
}
