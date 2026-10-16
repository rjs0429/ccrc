import type { FastifyInstance } from "fastify";
import { SEARCH_QUERY_MAX } from "../search-protocol.ts";
import { currentMessages, transcriptPath } from "../sessions/history.ts";
import { SessionSearch } from "../sessions/search.ts";
import { threadAround } from "../sessions/thread.ts";
import type { RouteDeps } from "./types.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The query and the message asked for travel in a POST body, which the request log leaves out.
export async function registerSearch(app: FastifyInstance, d: RouteDeps, search = new SessionSearch()): Promise<void> {
  app.post<{ Body: { q?: unknown; limit?: unknown } }>("/api/search", { preHandler: d.requireAuth }, async (req, reply) => {
    const { q, limit } = req.body ?? {};
    if (typeof q !== "string" || q.length > SEARCH_QUERY_MAX || (limit !== undefined && typeof limit !== "number")) {
      return reply.code(400).send({ error: "invalid" });
    }
    return search.search(q, await d.manager.list(), limit);
  });

  app.post<{ Body: { sessionId?: unknown; itemId?: unknown } }>("/api/thread", { preHandler: d.requireAuth }, async (req, reply) => {
    const { sessionId, itemId } = req.body ?? {};
    if (typeof sessionId !== "string" || !UUID.test(sessionId) || typeof itemId !== "string" || !itemId || itemId.length > 128) {
      return reply.code(400).send({ error: "invalid" });
    }
    const s = (await d.manager.list()).find((x) => x.id === sessionId);
    const file = s && transcriptPath(sessionId, s.cwd);
    if (!file) return reply.code(404).send({ error: "unknown session" });
    const current = new Set((await currentMessages(sessionId, s.cwd)).map((m) => m.uuid));
    const thread = await threadAround(file, itemId, current);
    return thread ?? reply.code(404).send({ error: "not found" });
  });
}
