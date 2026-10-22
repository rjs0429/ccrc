import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import type { Audit } from "./audit.ts";
import { checkCredentials, setCredentials } from "./auth.ts";
import { setConfigKey } from "./config.ts";
import type { ClaudeSettings } from "./claude-settings.ts";
import { DeviceGate } from "./devices.ts";
import type { Doctor } from "./doctor.ts";
import type { UpdateCheck } from "./update-check.ts";
import type { Hub } from "./hub.ts";
import type { Leases } from "./lease.ts";
import { PASSKEY_CLOSE, type Passkeys } from "./passkeys.ts";
import { PERMISSION_MODES } from "./protocol.ts";
import type { Push } from "./push/index.ts";
import { registerAttachments } from "./routes/attachments.ts";
import { registerAudit } from "./routes/audit.ts";
import { registerClaudeSettings } from "./routes/claude-settings.ts";
import { registerFiles } from "./routes/files.ts";
import { registerHealth } from "./routes/health.ts";
import { registerPasskeys } from "./routes/passkeys.ts";
import { registerPush } from "./routes/push.ts";
import { registerSearch } from "./routes/search.ts";
import { registerUploads } from "./routes/upload.ts";
import type { SessionManager } from "./sessions/manager.ts";
import type { SessionSearch } from "./sessions/search.ts";
import type { Store } from "./store.ts";
import type { Uploads } from "./uploads.ts";

declare module "fastify" {
  interface FastifyRequest {
    device: string;
  }
}

const COOKIE = "ccrc";
const COOKIE_MAX_AGE_SEC = 30 * 24 * 3600;
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self' wss:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

export interface ServerDeps {
  store: Store;
  leases: Leases;
  gate: DeviceGate;
  audit: Audit;
  manager: SessionManager;
  hub: Hub;
  uploads: Uploads;
  push: Push;
  doctor: Doctor;
  updates?: UpdateCheck;
  // Claude Code's settings file; ~/.claude/settings.json unless given.
  claudeSettings?: ClaudeSettings;
  webDir: string;
  logLevel?: string;
  logStream?: NodeJS.WritableStream;
  search?: SessionSearch;
  // The version /api/ping reports; the doctor's unless given.
  version?: () => string | undefined;
  // The phones' passkeys; without them no login waits for one.
  passkeys?: Passkeys;
}


// A file ticket in a URL opens the file without the login cookie until it expires, so request logs hide it.
export function loggedUrl(url: string): string {
  return url.replace(/^(\/api\/file-ticket\/)[^/?#]+/, "$1[redacted]");
}

// Browsers send Origin on POST and WebSocket requests; it must name this host. Hosts are compared
// as URLs under the origin's scheme, so a default port written out on one side still matches.
function sameOrigin(req: FastifyRequest): boolean {
  let origin: URL;
  try {
    origin = new URL(req.headers.origin ?? "");
  } catch {
    return false;
  }
  return [req.headers.host, req.headers["x-forwarded-host"]].flat().some((h) => {
    if (!h) return false;
    try {
      return new URL(`${origin.protocol}//${h}`).host === origin.host;
    } catch {
      return false;
    }
  });
}

export async function buildServer(d: ServerDeps) {
  const app = Fastify({
    logger: {
      level: d.logLevel ?? "info",
      ...(d.logStream ? { stream: d.logStream } : {}),
      serializers: {
        req: (req: FastifyRequest) => ({ method: req.method, url: loggedUrl(req.url), host: req.host, remoteAddress: req.ip, remotePort: req.socket?.remotePort }),
      },
    },
    bodyLimit: 256 * 1024,
  });
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 512 * 1024, perMessageDeflate: { threshold: 1024 } } });
  app.decorateRequest("device", "");

  app.addHook("onRequest", async (req, reply) => {
    // The installer and `ccrc update` ask for the version on this machine whether or not allowLocal lets it in.
    if (req.method === "GET" && req.url.split("?")[0] === "/api/ping" && DeviceGate.direct(req.socket.remoteAddress, req.headers["x-forwarded-for"])) {
      req.device = "local";
      return;
    }
    const check = await d.gate.check(req.socket.remoteAddress, req.headers["x-forwarded-for"]);
    if (!check.ok) {
      d.audit.log("device_denied", { ip: check.ip });
      return reply.code(403).type("text/plain").send("Forbidden");
    }
    req.device = check.device;
    const unsafe = req.method !== "GET" && req.method !== "HEAD";
    if ((unsafe || req.url === "/ws") && !sameOrigin(req)) return reply.code(403).send({ error: "bad_origin" });
  });

  app.addHook("onSend", async (_req, reply) => {
    if (!reply.hasHeader("Content-Security-Policy")) reply.header("Content-Security-Policy", CSP);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
  });

  const token = (req: FastifyRequest): string | undefined => req.cookies[COOKIE];
  const loggedIn = (req: FastifyRequest): boolean => d.leases.validate(token(req));
  const passkeyDue = (req: FastifyRequest): boolean => Boolean(d.passkeys?.due(d.leases.current(), req.device));
  const requireAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!loggedIn(req)) return reply.code(401).send({ error: "unauthorized" });
    if (passkeyDue(req)) return reply.code(401).send({ error: "passkey_required" });
  };
  const requireLogin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!loggedIn(req)) return reply.code(401).send({ error: "unauthorized" });
  };

  const version = d.version ?? (() => d.doctor.brokerVersion());
  app.get("/api/ping", async () => ({ ok: true, version: version() ?? null }));

  // passkey "due": the login holds, and a passkey has to confirm it before anything else answers.
  app.get("/api/me", async (req) => {
    d.store.reload();
    const loggedInNow = loggedIn(req);
    return { configured: Boolean(d.store.state.user), loggedIn: loggedInNow, device: req.device, ...(loggedInNow && passkeyDue(req) ? { passkey: "due" } : {}) };
  });

  app.post<{ Body: { id?: unknown; password?: unknown; takeover?: unknown } }>("/api/login", async (req, reply) => {
    const { id, password, takeover } = req.body ?? {};
    if (typeof id !== "string" || typeof password !== "string" || id.length > 64 || password.length > 1024) {
      return reply.code(400).send({ error: "invalid" });
    }
    const check = await checkCredentials(d.store, id, password);
    if (!check.ok) {
      d.audit.log("login_failed", { device: req.device, reason: check.reason });
      return reply.code(check.reason === "locked" ? 429 : 401).send({ error: check.reason, retryAfterSec: check.retryAfterSec });
    }
    const current = d.leases.current();
    if (current && takeover !== true) {
      return reply.code(409).send({ error: "in_use", device: current.device, lastSeen: current.lastSeen });
    }
    const issued = d.leases.issue(req.device);
    d.audit.log("login", { device: req.device, takeover: Boolean(current) });
    reply.setCookie(COOKIE, issued, { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: COOKIE_MAX_AGE_SEC });
    return { ok: true, ...(d.passkeys?.due(d.leases.current(), req.device) ? { passkey: "due" } : {}) };
  });

  app.post("/api/logout", async (req, reply) => {
    if (loggedIn(req)) {
      d.leases.revoke("logout");
      d.audit.log("logout", { device: req.device });
    }
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  app.post<{ Body: { current?: unknown; next?: unknown } }>("/api/password", { preHandler: requireAuth }, async (req, reply) => {
    const { current, next } = req.body ?? {};
    const user = d.store.state.user;
    if (typeof current !== "string" || typeof next !== "string" || !user) return reply.code(400).send({ error: "invalid" });
    const check = await checkCredentials(d.store, user.id, current);
    if (!check.ok) return reply.code(check.reason === "locked" ? 429 : 401).send({ error: check.reason, retryAfterSec: check.retryAfterSec });
    try {
      await setCredentials(d.store, user.id, next);
    } catch (e) {
      return reply.code(400).send({ error: "weak_password", message: e instanceof Error ? e.message : String(e) });
    }
    d.audit.log("password_changed", { device: req.device });
    return { ok: true };
  });

  app.get("/api/sessions", { preHandler: requireAuth }, async () => d.manager.list());

  app.get("/api/options", { preHandler: requireAuth }, async () => ({
    models: await d.manager.modelList(),
    modes: PERMISSION_MODES,
    folders: await d.manager.folders(),
    brokerSessions: d.manager.brokerSessions(),
    vscodeArchive: d.manager.vscodeArchiveOn(),
  }));

  // The one config key the phone sets: whether sessions VS Code archived count as archived in the list.
  app.post<{ Body: { on?: unknown } }>("/api/options/vscode-archive", { preHandler: requireAuth }, async (req, reply) => {
    const on = req.body?.on;
    if (typeof on !== "boolean") return reply.code(400).send({ error: "invalid" });
    try {
      setConfigKey("vscodeArchive", on);
    } catch (e) {
      req.log.warn({ err: e }, "config not written");
      return reply.code(500).send({ error: "config_unwritable" });
    }
    d.manager.setVscodeArchive(on);
    d.audit.log("config", { device: req.device, key: "vscodeArchive", value: on });
    return { vscodeArchive: on };
  });

  const routes = { ...d, requireAuth };
  if (d.passkeys) await registerPasskeys(app, { ...routes, passkeys: d.passkeys, requireLogin });
  await registerUploads(app, routes);
  await registerPush(app, routes);
  await registerClaudeSettings(app, routes);
  await registerAudit(app, routes);
  await registerHealth(app, routes);
  await registerFiles(app, routes);
  await registerAttachments(app, routes);
  await registerSearch(app, routes, d.search);

  app.get("/ws", { websocket: true }, (socket, req) => {
    const t = token(req);
    if (!t || !d.leases.validate(t)) {
      socket.close(4001, "unauthorized");
      return;
    }
    if (passkeyDue(req)) {
      socket.close(PASSKEY_CLOSE, "passkey required");
      return;
    }
    d.hub.attach(socket, req.device, t);
  });

  if (fs.existsSync(path.join(d.webDir, "index.html"))) {
    await app.register(fastifyStatic, {
      root: d.webDir,
      prefix: "/",
      setHeaders: (res, file) => {
        res.header("Cache-Control", file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache");
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/")) return reply.header("Cache-Control", "no-cache").sendFile("index.html");
      return reply.code(404).send({ error: "not_found" });
    });
  } else {
    app.get("/", async (_req, reply) => reply.type("text/plain").send("ccrc: the web app is not built (npm run build)"));
  }

  return app;
}
