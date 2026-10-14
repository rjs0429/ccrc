import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { AttachmentReader } from "../sessions/attachments.ts";
import type { RouteDeps } from "./types.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INDEX = /^\d{1,3}$/;
const IMAGE_CSP = "sandbox; default-src 'none'";
// The browser may keep an image but asks again each time, so a signed-out device gets nothing from its cache.
const KEPT = "private, no-cache";

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
      const etag = `"${createHash("sha256").update(found.image.data).digest("base64url").slice(0, 22)}"`;
      reply.header("Cache-Control", KEPT).header("ETag", etag);
      if (req.headers["if-none-match"] === etag) return reply.code(304).send();
      return reply
        .header("Content-Security-Policy", IMAGE_CSP)
        .header("Cross-Origin-Resource-Policy", "same-origin")
        .type(found.image.mediaType)
        .send(found.image.data);
    },
  );
}
