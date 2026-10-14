import type { FastifyInstance } from "fastify";
import { MAX_UPLOAD_BYTES, UploadError } from "../uploads.ts";
import type { RouteDeps } from "./types.ts";

// The file name travels URI-encoded in a header next to the raw body.
function fileName(v: unknown): string | undefined {
  if (typeof v !== "string" || !v || v.length > 1024) return undefined;
  try {
    return decodeURIComponent(v);
  } catch {
    return undefined;
  }
}

export async function registerUploads(app: FastifyInstance, d: RouteDeps): Promise<void> {
  // Every content type arrives here as raw bytes; the login is checked before the body is read.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    scope.post("/api/upload", { onRequest: d.requireAuth, bodyLimit: MAX_UPLOAD_BYTES }, async (req, reply) => {
      const name = fileName(req.headers["x-file-name"]);
      const mime = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      if (name === undefined || !Buffer.isBuffer(req.body)) return reply.code(400).send({ error: "invalid" });
      try {
        const info = await d.uploads.save(req.body, name, mime);
        d.audit.log("upload", { device: req.device, kind: info.kind, size: info.size });
        return info;
      } catch (e) {
        if (e instanceof UploadError) return reply.code(e.status).send({ error: e.message });
        throw e;
      }
    });
  });
}
