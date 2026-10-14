import type { FastifyReply, FastifyRequest } from "fastify";
import type { ServerDeps } from "../server.ts";

export type RouteDeps = ServerDeps & {
  requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
};
