import type { FastifyInstance } from "fastify";
import { AttachmentReader } from "../sessions/attachments.ts";
import type { RouteDeps } from "./types.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INDEX = /^\d{1,3}$/;
const IMAGE_CSP = "sandbox; default-src 'none'";
// A message's attachments never change once written, so the browser keeps them for the device.
const KEPT = "private, max-age=86400, immutable";

export async function registerAttachments(app: FastifyInstance, d: RouteDeps): Promise<void> {
  const reader = new AttachmentReader();

  // One image attached to a user message, read from the session's transcript.
  app.get<{ Params: { id: string; messageId: string; index: string } }>(
    "/api/sessions/:id/messages/:messageId/attachments/:index",
    { preHandler: d.requireAuth },
    async (req, reply) => {
      reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff");
      const { id, messageId, index } = req.params;
      if (!UUID.test(messageId) || !INDEX.test(index)) return reply.code(400).send({ error: "invalid" });
      const file = await d.manager.transcriptFile(id).catch(() => null);
      if (file === null) return reply.code(404).send({ error: "unknown_session" });
      if (!file) return reply.code(404).send({ error: "not_found" });
      const found = await reader.image(file, messageId.toLowerCase(), Number(index));
      if ("error" in found) return reply.code(found.error === "not_image" ? 415 : 404).send({ error: found.error });
      return reply
        .header("Cache-Control", KEPT)
        .header("Content-Security-Policy", IMAGE_CSP)
        .header("Cross-Origin-Resource-Policy", "same-origin")
        .type(found.image.mediaType)
        .send(found.image.data);
    },
  );
}
