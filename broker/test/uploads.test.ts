import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { Audit } from "../src/audit.ts";
import { registerUploads } from "../src/routes/upload.ts";
import type { RouteDeps } from "../src/routes/types.ts";
import { Uploads } from "../src/uploads.ts";
import { tempDir } from "./helpers.ts";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");

test("uploads become the content blocks the VS Code extension sends", async () => {
  const u = new Uploads(tempDir());
  const image = await u.save(JPEG, "IMG_0001.JPG", "image/jpeg");
  const pdf = await u.save(PDF, "spec.pdf", "application/pdf");
  const text = await u.save(Buffer.from("\uFEFFconst a = 1;\n"), "main.ts", "video/mp2t");
  assert.deepEqual([image.kind, pdf.kind, text.kind], ["image", "pdf", "text"]);
  assert.match(image.id, /^[0-9a-f]{32}$/);
  assert.deepEqual(text, { id: text.id, name: "main.ts", kind: "text", size: 16 });
  assert.deepEqual(await u.blocks([text.id, image.id, pdf.id]), [
    { type: "document", source: { type: "text", media_type: "text/plain", data: "const a = 1;\n" }, title: "main.ts" },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPEG.toString("base64") } },
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF.toString("base64") }, title: "spec.pdf" },
  ]);
});

test("stored uploads are private to this user", async () => {
  const dir = path.join(tempDir(), "uploads");
  const u = new Uploads(dir);
  const { id } = await u.save(PNG, "a.png", "image/png");
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, id)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, `${id}.json`)).mode & 0o777, 0o600);
});

test("the kind comes from the content, and each kind has its size limit", async () => {
  const u = new Uploads(tempDir());
  const png = await u.save(PNG, "photo.jpg", "image/jpeg");
  assert.deepEqual((await u.blocks([png.id]))[0].source, { type: "base64", media_type: "image/png", data: PNG.toString("base64") });
  const reject = async (data: Buffer, name: string, mime: string, status: number) => {
    await assert.rejects(u.save(data, name, mime), (e: Error & { status?: number }) => e.status === status, `${name} ${mime}`);
  };
  await reject(PNG, "fake.pdf", "application/pdf", 415);
  await reject(Buffer.from([0xff, 0xfe, 0x00, 0x41]), "notes.txt", "text/plain", 415);
  await reject(Buffer.from("MZ\x90\x00binary"), "tool.exe", "application/octet-stream", 415);
  await reject(Buffer.from("plain words"), "image.heic", "image/heic", 415);
  await reject(Buffer.alloc(0), "empty.txt", "text/plain", 400);
  await reject(Buffer.alloc(200 * 1024 + 1, 0x61), "big.txt", "text/plain", 413);
  await reject(Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024)]), "big.jpg", "image/jpeg", 413);
  assert.equal((await u.save(Buffer.from("all: build\n"), "Makefile", "")).kind, "text");
  assert.equal((await u.save(Buffer.from('{"a":1}'), "data", "application/json")).kind, "text");
});

test("names are reduced to a plain file name", async () => {
  const u = new Uploads(tempDir());
  const info = await u.save(Buffer.from("x"), "../../etc/\u202Egnp.txt\u0007", "text/plain");
  assert.equal(info.name, "gnp.txt");
});

test("unknown, malformed or old upload ids are refused", async () => {
  const dir = tempDir();
  const u = new Uploads(dir);
  await assert.rejects(u.blocks(["0".repeat(32)]), /^Error: attachment expired$/);
  await assert.rejects(u.blocks(["../state"]), /^Error: invalid request$/);
  const { id } = await u.save(PNG, "a.png", "image/png");
  const meta = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8"));
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ ...meta, at: Date.now() - 25 * 3600_000 }));
  await assert.rejects(u.blocks([id]), /^Error: attachment expired$/);
});

test("one message carries a bounded amount of attachments", async () => {
  const u = new Uploads(tempDir());
  const pdf = Buffer.concat([PDF, Buffer.alloc(6 * 1024 * 1024)]);
  const a = await u.save(pdf, "a.pdf", "application/pdf");
  const b = await u.save(pdf, "b.pdf", "application/pdf");
  assert.equal((await u.blocks([a.id])).length, 1);
  await assert.rejects(u.blocks([a.id, b.id]), /^Error: attachments too large$/);
});

test("the sweep removes uploads older than a day and nothing else", async () => {
  const dir = tempDir();
  const u = new Uploads(dir);
  const old = await u.save(PNG, "old.png", "image/png");
  const fresh = await u.save(PNG, "new.png", "image/png");
  fs.writeFileSync(path.join(dir, "keep.txt"), "not ours");
  const past = new Date(Date.now() - 25 * 3600_000);
  for (const f of [old.id, `${old.id}.json`, "keep.txt"]) fs.utimesSync(path.join(dir, f), past, past);
  await u.sweep();
  assert.deepEqual(fs.readdirSync(dir).sort(), [fresh.id, `${fresh.id}.json`, "keep.txt"].sort());
});

async function serve() {
  const events: [string, Record<string, unknown>][] = [];
  const app = Fastify({ bodyLimit: 256 * 1024, logger: false });
  app.decorateRequest("device", "");
  app.addHook("onRequest", async (req) => {
    req.device = "local";
  });
  app.post("/api/echo", async (req) => req.body);
  const requireAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.headers.cookie !== "ccrc=ok") return reply.code(401).send({ error: "unauthorized" });
  };
  const audit = { log: (event: string, detail: Record<string, unknown>) => events.push([event, detail]) } as unknown as Audit;
  await registerUploads(app, { uploads: new Uploads(tempDir()), audit, requireAuth } as unknown as RouteDeps);
  return { app, events };
}

test("POST /api/upload stores a file for a logged-in window and records it", async () => {
  const { app, events } = await serve();
  const cookie = "ccrc=ok";
  const upload = (headers: Record<string, string>, payload: Buffer) => app.inject({ method: "POST", url: "/api/upload", headers, payload });
  const md = Buffer.from("# 안건\n");
  const ok = await upload({ cookie, "content-type": "text/markdown; charset=utf-8", "x-file-name": encodeURIComponent("회의 메모.md") }, md);
  assert.equal(ok.statusCode, 200);
  assert.deepEqual({ ...(ok.json() as object), id: "" }, { id: "", name: "회의 메모.md", kind: "text", size: md.length });
  assert.deepEqual(events.at(-1), ["upload", { device: "local", kind: "text", size: md.length }]);
  const json = await upload({ cookie, "content-type": "application/json", "x-file-name": "a.json" }, Buffer.from("[1,2]"));
  assert.equal(json.json().kind, "text", "JSON files arrive as bytes, not parsed");

  const big = Buffer.alloc(10 * 1024 * 1024 + 1);
  assert.equal((await upload({ "content-type": "application/pdf", "x-file-name": "a.pdf" }, big)).statusCode, 401, "the login is checked before the body");
  assert.equal((await upload({ cookie, "content-type": "application/pdf", "x-file-name": "a.pdf" }, big)).statusCode, 413);
  assert.equal((await upload({ cookie, "content-type": "image/png" }, PNG)).statusCode, 400);
  assert.equal((await upload({ cookie, "content-type": "image/png", "x-file-name": "%E0%A4%A" }, PNG)).statusCode, 400);
  assert.equal((await upload({ cookie, "content-type": "application/zip", "x-file-name": "a.zip" }, Buffer.from("PK\x03\x04"))).statusCode, 415);
  assert.equal(events.filter(([e]) => e === "upload").length, 2);
});

test("other routes keep the small JSON body limit", async () => {
  const { app } = await serve();
  const echo = (payload: unknown) => app.inject({ method: "POST", url: "/api/echo", payload: payload as Record<string, unknown> });
  assert.deepEqual((await echo({ a: 1 })).json(), { a: 1 });
  assert.equal((await echo({ a: "x".repeat(300 * 1024) })).statusCode, 413);
});
