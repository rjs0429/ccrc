import type { FastifyInstance } from "fastify";
import type { RouteDeps } from "./types.ts";

export async function registerHealth(_app: FastifyInstance, _d: RouteDeps): Promise<void> {}
