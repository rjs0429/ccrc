import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import type { Audit } from "./audit.ts";
import { checkCredentials, setCredentials } from "./auth.ts";
import type { ClaudeSettings } from "./claude-settings.ts";
import type { DeviceGate } from "./devices.ts";
import type { Doctor } from "./doctor.ts";
import type { Hub } from "./hub.ts";
import type { Leases } from "./lease.ts";
import { PERMISSION_MODES } from "./protocol.ts";
import type { Push } from "./push/index.ts";
import { registerAudit } from "./routes/audit.ts";
import { registerClaudeSettings } from "./routes/claude-settings.ts";
import { registerHealth } from "./routes/health.ts";
import { registerPush } from "./routes/push.ts";
import { registerUploads } from "./routes/upload.ts";
import type { SessionManager } from "./sessions/manager.ts";
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
  // Claude Code's settings file; ~/.claude/settings.json unless given.
  claudeSettings?: ClaudeSettings;
  webDir: string;
  logLevel?: string;
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
  const app = Fastify({ logger: { level: d.logLevel ?? "info" }, bodyLimit: 256 * 1024 });
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 512 * 1024 } });
  app.decorateRequest("device", "");

  app.addHook("onRequest", async (req, reply) => {
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
    reply.header("Content-Security-Policy", CSP);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
  });

  const token = (req: FastifyRequest): string | undefined => req.cookies[COOKIE];
  const authed = (req: FastifyRequest): boolean => d.leases.validate(token(req));
  const requireAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!authed(req)) return reply.code(401).send({ error: "unauthorized" });
  };

  app.get("/api/me", async (req) => {
    d.store.reload();
    return { configured: Boolean(d.store.state.user), loggedIn: authed(req), device: req.device };
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
    return { ok: true };
  });

  app.post("/api/logout", async (req, reply) => {
    if (authed(req)) {
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
    models: d.manager.models,
    modes: PERMISSION_MODES,
    folders: await d.manager.folders(),
  }));

  const routes = { ...d, requireAuth };
  await registerUploads(app, routes);
  await registerPush(app, routes);
  await registerClaudeSettings(app, routes);
  await registerAudit(app, routes);
  await registerHealth(app, routes);

  app.get("/ws", { websocket: true }, (socket, req) => {
    const t = token(req);
    if (!t || !d.leases.validate(t)) {
      socket.close(4001, "unauthorized");
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
