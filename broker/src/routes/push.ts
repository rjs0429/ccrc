import type { FastifyInstance, FastifyReply } from "fastify";
import { PushError } from "../push/index.ts";
import type { RouteDeps } from "./types.ts";

type EndpointBody = { Body: { endpoint?: unknown } };

function refuse(reply: FastifyReply, e: unknown) {
  if (!(e instanceof PushError)) throw e;
  if (e.message === "push_failed") return reply.code(502).send({ error: e.message, status: e.status });
  return reply.code(e.message === "not_subscribed" ? 404 : 400).send({ error: e.message });
}

const service = (endpoint: string) => new URL(endpoint).host;

// Push subscriptions of this browser. Subscribing keeps the page's Origin as the contact push services see.
export async function registerPush(app: FastifyInstance, d: RouteDeps): Promise<void> {
  const auth = { preHandler: d.requireAuth };

  app.get("/api/push/key", auth, async () => ({ key: d.push.publicKey() }));

  app.get<{ Querystring: { endpoint?: unknown } }>("/api/push/status", auth, async (req, reply) => {
    try {
      return d.push.status(req.query.endpoint);
    } catch (e) {
      return refuse(reply, e);
    }
  });

  app.get<{ Querystring: { endpoint?: unknown } }>("/api/push/badge", auth, async (req, reply) => {
    try {
      return d.push.badge(req.query.endpoint);
    } catch (e) {
      return refuse(reply, e);
    }
  });

  app.post<{ Body: { subscription?: unknown; prefs?: unknown } }>("/api/push/subscribe", auth, async (req, reply) => {
    try {
      const sub = d.push.subscribe(req.body?.subscription, req.body?.prefs, { device: req.device, origin: req.headers.origin });
      d.audit.log("push_subscribe", { device: req.device, service: service(sub.endpoint), prefs: sub.prefs });
      return d.push.status(sub.endpoint);
    } catch (e) {
      return refuse(reply, e);
    }
  });

  app.post<EndpointBody>("/api/push/unsubscribe", auth, async (req, reply) => {
    try {
      const sub = d.push.unsubscribe(req.body?.endpoint);
      if (sub) d.audit.log("push_unsubscribe", { device: req.device, service: service(sub.endpoint), subscribedFrom: sub.device });
      return { ok: true };
    } catch (e) {
      return refuse(reply, e);
    }
  });

  app.post<{ Body: { endpoint?: unknown; prefs?: unknown } }>("/api/push/prefs", auth, async (req, reply) => {
    try {
      const sub = d.push.setPrefs(req.body?.endpoint, req.body?.prefs);
      d.audit.log("push_subscribe", { device: req.device, service: service(sub.endpoint), prefs: sub.prefs });
      return { prefs: sub.prefs };
    } catch (e) {
      return refuse(reply, e);
    }
  });

  app.post<EndpointBody>("/api/push/test", auth, async (req, reply) => {
    try {
      await d.push.test(req.body?.endpoint);
      return { ok: true };
    } catch (e) {
      return refuse(reply, e);
    }
  });
}
