import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AttachmentReader, type ImageLookup } from "../sessions/attachments.ts";
import type { RouteDeps } from "./types.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const INDEX = /^\d{1,3}$/;
const IMAGE_CSP = "sandbox; default-src 'none'";
// The browser may keep an image but asks again each time, so a signed-out device gets nothing from its cache.
const KEPT = "private, no-cache";

function serve(req: FastifyRequest, reply: FastifyReply, found: ImageLookup) {
  if ("error" in found) return reply.code(found.error === "not_image" ? 415 : 404).send({ error: found.error });
  const etag = `"${createHash("sha256").update(found.image.data).digest("base64url").slice(0, 22)}"`;
  reply.header("Cache-Control", KEPT).header("ETag", etag);
  if (req.headers["if-none-match"] === etag) return reply.code(304).send();
  return reply
    .header("Content-Security-Policy", IMAGE_CSP)
    .header("Cross-Origin-Resource-Policy", "same-origin")
    .type(found.image.mediaType)
    .send(found.image.data);
}

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
      return serve(req, reply, await reader.image(file, messageId.toLowerCase(), Number(index)));
    },
  );

  // One picture of a tool call's result, read from the transcript that holds the call: the session's, or that of its
  // subagent `agent`.
  app.get<{ Params: { id: string; call: string; n: string }; Querystring: { agent?: unknown } }>(
    "/api/sessions/:id/tools/:call/images/:n",
    { preHandler: d.requireAuth },
    async (req, reply) => {
      reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff");
      const { id, call, n } = req.params;
      const agent = req.query.agent;
      if (!ID.test(call) || !INDEX.test(n) || (agent !== undefined && (typeof agent !== "string" || !ID.test(agent)))) return reply.code(400).send({ error: "invalid" });
      const file = await d.manager.toolTranscript(id, agent).catch(() => null);
      if (file === null) return reply.code(404).send({ error: "unknown_session" });
      if (!file) return reply.code(404).send({ error: "not_found" });
      return serve(req, reply, await reader.toolImage(file, call, Number(n)));
    },
  );
}
