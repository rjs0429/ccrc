import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { claudeSettingsFile } from "../claude-settings.ts";
import type { FileView } from "../protocol.ts";
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
  servedType,
  type ReadErrorCode,
} from "../sessions/file-read.ts";
import type { RouteDeps } from "./types.ts";

// Served bytes never run as a page on this origin: only images and PDF keep their type, and all but
// PDF (whose viewers a sandbox breaks) come sandboxed.
const RAW_CSP = "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'";
const PDF_CSP = "default-src 'none'; object-src 'self'; img-src 'self' data: blob:; style-src 'unsafe-inline'; frame-ancestors 'self'";
const STATUS: Record<ReadErrorCode, number> = { invalid: 400, not_found: 404, denied: 403, too_large: 413, failed: 502 };
const LOGGED_PATH_MAX = 1024;

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
  if (live) {
    const r = await live.catch((e: unknown) => {
      throw readFailure(e);
    });
    if (r.absPath && isSecretPath(r.absPath)) throw new ReadError("denied", `read denied: ${abs}`);
    return { data: Buffer.from(r.contents, r.base64 ? "base64" : "utf8"), truncated: r.truncated, via: "claude" };
  }
  const r = await readDirect(abs, a.roots, max);
  return { data: r.data, truncated: r.truncated, via: "broker" };
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
        if (binary && size > MAX_BINARY_BYTES) throw new ReadError("too_large");
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

  // The bytes of a file the viewer opened, for images, PDF and downloads.
  app.get<{ Params: { id: string }; Querystring: { path?: unknown; download?: unknown } }>(
    "/api/sessions/:id/file/raw",
    { preHandler: d.requireAuth },
    async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      const p =
        typeof req.query.path === "string" && path.isAbsolute(req.query.path) && !req.query.path.includes("\0") ? path.normalize(req.query.path) : undefined;
      if (!p) return reply.code(400).send({ error: "invalid" });
      const a = await access(req.params.id);
      if (!a) return reply.code(404).send({ error: "unknown_session" });
      const log = (outcome: string, via?: string) =>
        d.audit.log("file_read", {
          device: req.device,
          sessionId: req.params.id,
          path: p.slice(0, LOGGED_PATH_MAX),
          outcome,
          raw: true,
          ...(via ? { via } : {}),
        });
      try {
        const size = await sizeOf(p);
        if (size === undefined) throw new ReadError(a.roots.some((r) => inside(p, r)) ? "not_found" : "denied");
        if (size > MAX_BINARY_BYTES) throw new ReadError("too_large");
        const r = await readFile(a, p, MAX_BINARY_BYTES, true);
        log("ok", r.via);
        const type = servedType(p);
        const name = path.basename(p);
        const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
        const disposition = req.query.download === "1" || type === "application/octet-stream" ? "attachment" : "inline";
        return reply
          .header("Content-Security-Policy", type === "application/pdf" ? PDF_CSP : RAW_CSP)
          .header("Content-Disposition", `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`)
          .type(type)
          .send(r.data);
      } catch (e) {
        log(readFailure(e).code, a.session ? "claude" : "broker");
        return fail(reply, e);
      }
    },
  );
}
