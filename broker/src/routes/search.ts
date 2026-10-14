import type { FastifyInstance } from "fastify";
import { SEARCH_QUERY_MAX } from "../search-protocol.ts";
import { SessionSearch } from "../sessions/search.ts";
import type { RouteDeps } from "./types.ts";

// The query travels in a POST body, which the request log leaves out.
export async function registerSearch(app: FastifyInstance, d: RouteDeps, search = new SessionSearch()): Promise<void> {
  app.post<{ Body: { q?: unknown; limit?: unknown } }>("/api/search", { preHandler: d.requireAuth }, async (req, reply) => {
    const { q, limit } = req.body ?? {};
    if (typeof q !== "string" || q.length > SEARCH_QUERY_MAX || (limit !== undefined && typeof limit !== "number")) {
      return reply.code(400).send({ error: "invalid" });
    }
    return search.search(q, await d.manager.list(), limit);
  });
}
