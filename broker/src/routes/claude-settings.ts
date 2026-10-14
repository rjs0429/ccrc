import type { FastifyInstance } from "fastify";
import { ClaudeSettings, SettingsError } from "../claude-settings.ts";
import type { RouteDeps } from "./types.ts";

export async function registerClaudeSettings(app: FastifyInstance, d: RouteDeps): Promise<void> {
  const settings = d.claudeSettings ?? new ClaudeSettings();

  app.get("/api/claude-settings", { preHandler: d.requireAuth }, async () => settings.read());

  app.put<{ Body: { changes?: unknown; baseHash?: unknown } }>("/api/claude-settings", { preHandler: d.requireAuth }, async (req, reply) => {
    try {
      const { view, changed } = settings.update(req.body?.changes, req.body?.baseHash);
      if (changed.length) d.audit.log("claude_settings", { device: req.device, keys: changed });
      return view;
    } catch (e) {
      if (!(e instanceof SettingsError)) throw e;
      return reply.code(e.status).send({ error: e.message, ...(e.key ? { key: e.key } : {}) });
    }
  });
}
