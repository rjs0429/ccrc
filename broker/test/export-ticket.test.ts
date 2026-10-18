import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { Audit } from "../src/audit.ts";
import type { ExportArgs } from "../src/protocol.ts";
import { registerFiles } from "../src/routes/files.ts";
import type { RouteDeps } from "../src/routes/types.ts";

async function server() {
  const app = Fastify({ logger: false });
  app.decorateRequest("device", "");
  app.addHook("onRequest", async (req) => {
    req.device = String(req.headers["x-device"] ?? "phone");
  });
  const lease = { current: { tokenHash: "lease-1" } as { tokenHash: string } | undefined };
  const named: [string, Record<string, unknown>][] = [];
  const asked: [string, ExportArgs][] = [];
  const requireAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.headers.authorization !== "ok") return reply.code(401).send({ error: "unauthorized" });
  };
  const audit = { log: (e: string, detail: Record<string, unknown>) => named.push([e, detail]) } as unknown as Audit;
  const manager = {
    fileAccess: async (id: string) => {
      if (id !== "s1" && id !== "s2") throw Error("unknown session");
      return { start: "/nonexistent" };
    },
    exportConversation: async (id: string, args: ExportArgs) => {
      asked.push([id, args]);
      if (id === "s2") throw Error("nothing to export");
      return { name: "파서 고치기-20261018-1040.md", text: "# 파서 고치기\n\n본문 <script>x</script>\n", messages: 2 };
    },
  };
  await registerFiles(app, { audit, requireAuth, manager, leases: { current: () => lease.current }, claudeSettings: { file: "/nonexistent/settings.json" } } as unknown as RouteDeps);
  const mint = (id: string, body: unknown, auth = "ok") =>
    app.inject({ method: "POST", url: `/api/sessions/${id}/file/ticket`, headers: { authorization: auth, "content-type": "application/json" }, payload: body as Record<string, unknown> });
  const fetch = (url: string, device = "phone") => app.inject({ method: "GET", url, headers: { "x-device": device } });
  return { named, asked, lease, mint, fetch };
}

test("an export ticket downloads the conversation's Markdown, made when fetched, only from the same device and login", async (t) => {
  const { named, asked, lease, mint, fetch } = await server();
  assert.equal((await mint("s1", { export: {} }, "no")).statusCode, 401);
  for (const bad of [{ export: "yes" }, { export: { tools: "yes" } }, { export: { tz: 3 } }, { export: { tz: "x".repeat(65) } }, { export: { tools: true, path: "/etc/hostname" } }, { export: null }]) {
    assert.equal((await mint("s1", bad)).statusCode, 400, JSON.stringify(bad));
  }
  assert.equal((await mint("nope", { export: {} })).statusCode, 404);
  const { url } = (await mint("s1", { export: { tools: false, tz: "Asia/Seoul" }, path: "/etc/hostname" })).json() as { url: string };
  assert.match(url, /^\/api\/file-ticket\/[A-Za-z0-9_-]{43}$/);
  const got = await fetch(`${url}?download=1`);
  assert.equal(got.statusCode, 200);
  assert.equal(got.headers["content-type"], "text/markdown; charset=utf-8");
  assert.equal(got.headers["cache-control"], "no-store");
  assert.match(String(got.headers["content-security-policy"]), /^sandbox/);
  assert.match(String(got.headers["content-disposition"]), /^attachment; filename="_+ _+-20261018-1040\.md"; filename\*=UTF-8''%ED%8C%8C/);
  assert.equal(got.payload, "# 파서 고치기\n\n본문 <script>x</script>\n");
  assert.match(String((await fetch(url)).headers["content-disposition"]), /^attachment/, "it downloads without being asked to");
  assert.deepEqual(asked[0], ["s1", { tools: false, tz: "Asia/Seoul" }]);
  assert.equal((await fetch(url, "laptop")).statusCode, 401, "another device cannot use it");
  lease.current = { tokenHash: "lease-2" };
  assert.equal((await fetch(url)).statusCode, 401, "a new login ends it");
  lease.current = { tokenHash: "lease-1" };
  assert.ok(named.some(([e, d]) => e === "export" && d.ticket === true && d.sessionId === "s1" && d.messages === 2 && d.device === "phone"));
  assert.ok(named.some(([e, d]) => e === "file_read" && d.outcome === "ticket_invalid" && d.export === true && d.device === "laptop"));
  const empty = (await mint("s2", { export: {} })).json() as { url: string };
  assert.equal((await fetch(empty.url)).statusCode, 404, "a session with nothing to export");
  assert.ok(named.some(([e, d]) => e === "export" && d.sessionId === "s2" && d.outcome === "failed"));
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 61_000 });
  assert.equal((await fetch(url)).statusCode, 401, "expired");
  t.mock.timers.reset();
});
