import type { FastifyReply } from "fastify";

// Served bytes never run as a page on this origin: only images and PDF keep their type, and all but
// PDF (whose viewers a sandbox breaks) come sandboxed.
export const RAW_CSP = "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'";
export const PDF_CSP = "default-src 'none'; object-src 'self'; img-src 'self' data: blob:; style-src 'unsafe-inline'; frame-ancestors 'self'";

// The type, policy and file name of a file's bytes; a type nothing renders always downloads.
export function rawHeaders(reply: FastifyReply, name: string, type: string, download: boolean): FastifyReply {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const disposition = download || type === "application/octet-stream" ? "attachment" : "inline";
  return reply
    .header("Content-Security-Policy", type === "application/pdf" ? PDF_CSP : RAW_CSP)
    .header("Content-Disposition", `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`)
    .type(type);
}
