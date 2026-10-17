import type { FastifyInstance } from "fastify";
import type { RouteDeps } from "./types.ts";

export async function registerHealth(app: FastifyInstance, d: RouteDeps): Promise<void> {
  const info = async () => ({ ...(await d.doctor.info()), brokerSessions: d.manager.brokerSessions() });
  app.get("/api/health", { preHandler: d.requireAuth }, info);

  app.post("/api/health/check", { preHandler: d.requireAuth }, async (req) => {
    d.audit.log("doctor", { device: req.device });
    await d.doctor.run();
    return info();
  });
}
