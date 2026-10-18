import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { claudeSettingsFile } from "../claude-settings.ts";
import type { FileView, SentRef } from "../protocol.ts";
import type { SessionCore } from "../sessions/core.ts";
import {
  MAX_BINARY_BYTES,
  MAX_TEXT_BYTES,
  ReadError,
  additionalDirectories,
  inside,
  isSecretPath,
  kindOf,
  looksBinary,
  parseLink,
  readDirect,
  readFailure,
  resolveLink,
  scopedPath,
  servedType,
  type ReadErrorCode,
} from "../sessions/file-read.ts";
import { rawHeaders } from "./raw.ts";
import { registerSent, sentRef } from "./sent.ts";
import type { RouteDeps } from "./types.ts";

const STATUS: Record<ReadErrorCode, number> = { invalid: 400, not_found: 404, denied: 403, too_large: 413, failed: 502 };
const LOGGED_PATH_MAX = 1024;
const OLD_WRAPPER = "rejected by the wrapper: request not allowed";
const TICKET_MS = 60_000;
const TICKETS_MAX = 64;

// Lets a page outside the app, which has no cookie (a new window from the home-screen app), fetch one
// file: bound to the device and login that asked for it, reusable until it expires since PDF viewers
// may fetch more than once. A file Claude sent is named by its call, not by its path.
interface Ticket {
  sessionId: string;
  path?: string;
  sent?: SentRef;
  device: string;
  lease: string;
  expires: number;
}

interface Access {
  // Working directories the broker enforces when it reads a file itself.
  roots: string[];
  // Where relative links start: the folder the session started in, then the one it last worked in.
  bases: string[];
  session?: SessionCore;
}

interface Read {
  data: Buffer;
  truncated: boolean;
  via: FileView["via"];
}

async function sizeOf(p: string): Promise<number | undefined> {
  try {
    const st = await fs.promises.stat(p);
    return st.isFile() ? st.size : undefined;
  } catch {
    return undefined;
  }
}

// The session's Claude Code process reads the file when one is running; otherwise the broker does,
// within the same working directories. Secret files are refused either way.
async function readFile(a: Access, abs: string, max: number, binary: boolean): Promise<Read> {
  const real = await fs.promises.realpath(abs).catch(() => abs);
  if (isSecretPath(abs) || isSecretPath(real)) throw new ReadError("denied", `read denied: ${abs}`);
  const live = a.session?.readFile(abs, max, binary ? "base64" : "utf-8");
  // A wrapper older than read_file refuses it; the broker then reads within the working directories.
  const r = await live?.catch((e: unknown) => {
    if (e instanceof Error && e.message === OLD_WRAPPER) return undefined;
    throw readFailure(e);
  });
  if (r) {
    if (r.absPath && isSecretPath(r.absPath)) throw new ReadError("denied", `read denied: ${abs}`);
    return { data: Buffer.from(r.contents, r.base64 ? "base64" : "utf8"), truncated: r.truncated, via: "claude" };
  }
  const d = await readDirect(abs, a.roots, max);
  return { data: d.data, truncated: d.truncated, via: "broker" };
}

// A file outside the working directories is refused whatever its size, so a size never shows it exists.
async function tooLarge(a: Access, abs: string): Promise<ReadError> {
  await scopedPath(abs, a.roots);
  return new ReadError("too_large");
}

function fail(reply: FastifyReply, e: unknown): FastifyReply {
  const err = readFailure(e);
  return reply.code(STATUS[err.code]).send({ error: err.code });
}

export async function registerFiles(app: FastifyInstance, d: RouteDeps): Promise<void> {
  const access = async (sessionId: string): Promise<Access | undefined> => {
    try {
      const a = await d.manager.fileAccess(sessionId);
      const bases = [a.start, ...(a.latest ? [a.latest] : [])];
      return { roots: [a.start, ...additionalDirectories(d.claudeSettings?.file ?? claudeSettingsFile(), a.start)], bases, session: a.session };
    } catch {
      return undefined;
    }
  };

  // A link from the conversation or from a file in the viewer (`base`: that file's folder).
  app.get<{ Params: { id: string }; Querystring: { href?: unknown; base?: unknown } }>(
    "/api/sessions/:id/file",
    { preHandler: d.requireAuth },
    async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      const log = (p: string, outcome: string, via?: string) =>
        d.audit.log("file_read", { device: req.device, sessionId: req.params.id, path: p.slice(0, LOGGED_PATH_MAX), outcome, ...(via ? { via } : {}) });
      const href = typeof req.query.href === "string" ? req.query.href : "";
      const target = parseLink(href);
      if (!target) return reply.code(400).send({ error: "invalid" });
      const a = await access(req.params.id);
      if (!a) return reply.code(404).send({ error: "unknown_session" });
      const base = typeof req.query.base === "string" && path.isAbsolute(req.query.base) ? [path.normalize(req.query.base)] : [];
      const bases = [...new Set([...base, ...a.bases])];
      const found = await resolveLink(target.path, bases, a.roots.slice(0, 1));
      if (!found) {
        const meant = path.resolve(bases[0], target.path);
        const code = a.roots.some((r) => inside(meant, r)) ? "not_found" : "denied";
        log(meant, code);
        return reply.code(STATUS[code]).send({ error: code, path: meant });
      }
      const abs = found.abs;
      const size = (await sizeOf(abs)) ?? 0;
      let kind = kindOf(abs);
      const binary = kind === "image" || kind === "pdf" || kind === "binary";
      try {
        if (binary && size > MAX_BINARY_BYTES) throw await tooLarge(a, abs);
        const r = await readFile(a, abs, binary ? 1 : MAX_TEXT_BYTES, binary);
        let text = binary ? undefined : r.data.toString("utf8");
        if (text !== undefined && looksBinary(text)) {
          kind = "binary";
          text = undefined;
        }
        const view: FileView = {
          path: abs,
          name: path.basename(abs),
          size: size || r.data.length,
          kind,
          ...(text !== undefined ? { text, truncated: r.truncated } : {}),
          ...(found.fallback ? { fallback: found.fallback } : {}),
          via: r.via,
          ...(target.line ? { line: target.line } : {}),
          ...(target.endLine ? { endLine: target.endLine } : {}),
          ...(target.heading ? { heading: target.heading } : {}),
        };
        log(abs, text !== undefined && r.truncated ? "truncated" : "ok", r.via);
        return view;
      } catch (e) {
        log(abs, readFailure(e).code, a.session ? "claude" : "broker");
        return fail(reply, e);
      }
    },
  );

  const absolute = (v: unknown): string | undefined =>
    typeof v === "string" && path.isAbsolute(v) && !v.includes("\0") ? path.normalize(v) : undefined;

  const serveRaw = async (req: FastifyRequest, reply: FastifyReply, sessionId: string, p: string, download: boolean, extra: Record<string, unknown> = {}) => {
    reply.header("Cache-Control", "no-store");
    const a = await access(sessionId);
    if (!a) return reply.code(404).send({ error: "unknown_session" });
    const log = (outcome: string, via?: string) =>
      d.audit.log("file_read", {
        device: req.device,
        sessionId,
        path: p.slice(0, LOGGED_PATH_MAX),
        outcome,
        raw: true,
        ...extra,
        ...(via ? { via } : {}),
      });
    try {
      const size = await sizeOf(p);
      if (size === undefined) throw new ReadError(a.roots.some((r) => inside(p, r)) ? "not_found" : "denied");
      if (size > MAX_BINARY_BYTES) throw await tooLarge(a, p);
      const r = await readFile(a, p, MAX_BINARY_BYTES, true);
      log("ok", r.via);
      return rawHeaders(reply, path.basename(p), servedType(p), download).send(r.data);
    } catch (e) {
      log(readFailure(e).code, a.session ? "claude" : "broker");
      return fail(reply, e);
    }
  };

  // The bytes of a file the viewer opened, for images, PDF and downloads.
  app.get<{ Params: { id: string }; Querystring: { path?: unknown; download?: unknown } }>(
    "/api/sessions/:id/file/raw",
    { preHandler: d.requireAuth },
    async (req, reply) => {
      const p = absolute(req.query.path);
      if (!p) return reply.code(400).header("Cache-Control", "no-store").send({ error: "invalid" });
      return serveRaw(req, reply, req.params.id, p, req.query.download === "1");
    },
  );

  const sent = await registerSent(app, d);
  const tickets = new Map<string, Ticket>();
  const prune = (now: number) => {
    for (const [k, t] of tickets) if (t.expires <= now) tickets.delete(k);
    while (tickets.size >= TICKETS_MAX) tickets.delete(tickets.keys().next().value!);
  };

  app.post<{ Params: { id: string }; Body: { path?: unknown; sent?: unknown } }>("/api/sessions/:id/file/ticket", { preHandler: d.requireAuth }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const ref = req.body?.sent === undefined ? undefined : sentRef(req.body.sent);
    const p = req.body?.sent === undefined ? absolute(req.body?.path) : undefined;
    if (!p && !ref) return reply.code(400).send({ error: "invalid" });
    if (!(await access(req.params.id))) return reply.code(404).send({ error: "unknown_session" });
    const lease = d.leases.current();
    if (!lease) return reply.code(401).send({ error: "unauthorized" });
    const now = Date.now();
    prune(now);
    const id = randomBytes(32).toString("base64url");
    tickets.set(id, { sessionId: req.params.id, ...(ref ? { sent: ref } : { path: p }), device: req.device, lease: lease.tokenHash, expires: now + TICKET_MS });
    return { url: `/api/file-ticket/${id}`, expiresInMs: TICKET_MS };
  });

  // The broker's device check has already run; the ticket stands in for the login cookie.
  app.get<{ Params: { ticket: string }; Querystring: { download?: unknown } }>("/api/file-ticket/:ticket", async (req, reply) => {
    const t = tickets.get(req.params.ticket);
    const now = Date.now();
    if (!t || t.expires <= now || t.device !== req.device || d.leases.current()?.tokenHash !== t.lease) {
      if (t && t.expires <= now) tickets.delete(req.params.ticket);
      d.audit.log("file_read", {
        device: req.device,
        ...(t ? { sessionId: t.sessionId, ...(t.path ? { path: t.path.slice(0, LOGGED_PATH_MAX) } : {}), ...(t.sent ? { sent: true, ...t.sent } : {}) } : {}),
        outcome: t && t.expires <= now ? "ticket_expired" : "ticket_invalid",
        raw: true,
        ticket: true,
      });
      return reply.code(401).header("Cache-Control", "no-store").send({ error: "unauthorized" });
    }
    if (d.passkeys?.due(d.leases.current(), req.device)) return reply.code(401).header("Cache-Control", "no-store").send({ error: "passkey_required" });
    if (t.sent) return sent.raw(req, reply, t.sessionId, t.sent, req.query.download === "1", { ticket: true });
    return serveRaw(req, reply, t.sessionId, t.path!, req.query.download === "1", { ticket: true });
  });
}
