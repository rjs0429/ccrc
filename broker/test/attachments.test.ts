import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

// Transcripts are read from ~/.claude, so the test runs against an empty home of its own.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccrc-home-"));
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
after(() => fs.rmSync(home, { recursive: true, force: true }));

const { loadHistory, projectDirName } = await import("../src/sessions/history.ts");
const { registerAttachments } = await import("../src/routes/attachments.ts");
type RouteDeps = import("../src/routes/types.ts").RouteDeps;

const SID = "5b0c2d7e-1a9f-4c3e-8d6b-7f2a1e9c4b50";
const U1 = "0dff1d70-6010-45a1-96e2-2816d63ea8ae";
const Q1 = "5859e9e3-9599-4c4d-9d99-4c9984c7792a";
const BIG = "9a3e5c1b-7d2f-4e6a-b8c0-1f4d2e7a9b36";
const cwd = path.join(home, "ws");

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png-body")]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg-body")]);
const GIF = Buffer.from("GIF89a-gif-body");
const WEBP = Buffer.from("RIFF\0\0\0\0WEBPVP8 body");
const image = (media: string, data: Buffer) => ({ type: "image", source: { type: "base64", media_type: media, data: data.toString("base64") } });
const doc = { type: "document", title: "codeword.txt", source: { type: "text", media_type: "text/plain", data: "The code word is MARIGOLD" } };

// Rows in the shape Claude Code 2.1.296 writes them: a message with attachments, then one sent while
// Claude was working, which lands in a queued_command attachment row when it is delivered.
function transcript(): string {
  const base = { isSidechain: false, userType: "external", cwd, sessionId: SID, version: "2.1.296", gitBranch: "HEAD" };
  const filler = "x".repeat(5 * 1024 * 1024);
  const rows = [
    {
      ...base,
      parentUuid: null,
      type: "user",
      uuid: U1,
      timestamp: "2026-10-14T06:54:04.010Z",
      message: { role: "user", content: [image("image/png", PNG), doc, image("image/jpeg", JPEG), image("image/svg+xml", Buffer.from("<svg/>")), image("image/png", Buffer.from("<html>"))] },
    },
    {
      ...base,
      parentUuid: U1,
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-10-14T06:54:06.000Z",
      message: { role: "assistant", content: [{ type: "text", text: filler.slice(0, 4 * 1024 * 1024 - 100) }] },
    },
    {
      ...base,
      parentUuid: "a1",
      type: "attachment",
      uuid: "11140cf1-0ed5-4a3d-85e0-10d39553e469",
      timestamp: "2026-10-14T06:55:00.000Z",
      attachment: {
        type: "queued_command",
        prompt: [image("image/gif", GIF), image("image/webp", WEBP), { type: "text", text: "사진을 아이폰에서 첨부한거야." }],
        source_uuid: Q1,
        commandMode: "prompt",
        origin: { kind: "human" },
        humanTurn: true,
      },
    },
    {
      ...base,
      parentUuid: "11140cf1-0ed5-4a3d-85e0-10d39553e469",
      type: "assistant",
      uuid: "a1b",
      timestamp: "2026-10-14T06:55:02.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Both photos arrived" }] },
    },
    {
      ...base,
      parentUuid: "a1b",
      type: "user",
      uuid: BIG,
      timestamp: "2026-10-14T06:56:00.000Z",
      message: { role: "user", content: [image("image/png", Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)])), { type: "text", text: "big" }] },
    },
    {
      ...base,
      parentUuid: BIG,
      type: "assistant",
      uuid: "a2",
      timestamp: "2026-10-14T06:56:05.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
    },
  ];
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

const dir = path.join(home, ".claude", "projects", projectDirName(cwd));
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${SID}.jsonl`);
fs.writeFileSync(file, transcript());

test("history lists the attachments of user rows and of messages queued while Claude worked", async () => {
  const items = await loadHistory(SID, cwd);
  const users = items.filter((i) => i.kind === "user");
  assert.deepEqual(
    users.map((i) => [i.id, i.text, i.attachments]),
    [
      [
        U1,
        "",
        [
          { kind: "image", mediaType: "image/png", size: PNG.length },
          { kind: "document", mediaType: "text/plain", size: 25, name: "codeword.txt" },
          { kind: "image", mediaType: "image/jpeg", size: JPEG.length },
          { kind: "image", mediaType: "image/svg+xml", size: 6 },
          { kind: "image", mediaType: "image/png", size: 6 },
        ],
      ],
      [Q1, "사진을 아이폰에서 첨부한거야.", [{ kind: "image", mediaType: "image/gif", size: GIF.length }, { kind: "image", mediaType: "image/webp", size: WEBP.length }]],
      [BIG, "big", [{ kind: "image", mediaType: "image/png", size: PNG.length + 3 * 1024 * 1024 }]],
    ],
  );
  assert.ok(JSON.stringify(items).length < 4096 + 4 * 1024 * 1024, "no image data in the items");
  assert.ok(!JSON.stringify(users).includes(PNG.toString("base64")));
});

async function server(known: Record<string, string | undefined>) {
  const app = Fastify({ logger: false });
  const requireAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.headers.authorization !== "ok") return reply.code(401).send({ error: "unauthorized" });
  };
  const manager = {
    transcriptFile: async (id: string) => {
      if (!(id in known)) throw Error("unknown session");
      return known[id];
    },
  };
  await registerAttachments(app, { requireAuth, manager } as unknown as RouteDeps);
  const get = (url: string, auth = true) => app.inject({ method: "GET", url, headers: auth ? { authorization: "ok" } : {} });
  return { app, get };
}

test("the attachment route serves the four image types with safe headers", async () => {
  const { get } = await server({ [SID]: file });
  const url = (msg: string, n: number | string) => `/api/sessions/${SID}/messages/${msg}/attachments/${n}`;
  for (const [msg, n, type, body] of [
    [U1, 0, "image/png", PNG],
    [U1, 2, "image/jpeg", JPEG],
    [Q1, 0, "image/gif", GIF],
    [Q1, 1, "image/webp", WEBP],
    [Q1.toUpperCase(), 1, "image/webp", WEBP],
  ] as const) {
    const r = await get(url(msg, n));
    assert.equal(r.statusCode, 200, `${msg} ${n}`);
    assert.equal(r.headers["content-type"], type);
    assert.deepEqual(r.rawPayload, body);
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.match(String(r.headers["content-security-policy"]), /^sandbox; default-src 'none'/);
    assert.match(String(r.headers["cache-control"]), /^private, /);
  }
  const big = await get(url(BIG, 0));
  assert.equal(big.statusCode, 200, "a row that spans read chunks is found");
  assert.equal(big.rawPayload.length, PNG.length + 3 * 1024 * 1024);

  const status = async (u: string, auth = true) => {
    const r = await get(u, auth);
    return [r.statusCode, r.json().error, r.headers["cache-control"]];
  };
  assert.deepEqual(await status(url(U1, 1)), [415, "not_image", "no-store"], "a document is not served");
  assert.deepEqual(await status(url(U1, 3)), [415, "not_image", "no-store"], "SVG is not served");
  assert.deepEqual(await status(url(U1, 4)), [415, "not_image", "no-store"], "bytes that are not the named image are not served");
  assert.deepEqual(await status(url(U1, 5)), [404, "not_found", "no-store"], "an index past the attachments");
  assert.deepEqual(await status(url("2f1e0d3c-4b5a-4968-8776-655443322110", 0)), [404, "not_found", "no-store"], "an unknown message");
  assert.deepEqual(await status(url(U1, -1)), [400, "invalid", "no-store"]);
  assert.deepEqual(await status(url(U1, "0x1")), [400, "invalid", "no-store"]);
  assert.deepEqual(await status(url("a1", 0)), [400, "invalid", "no-store"], "message ids are uuids");
  assert.deepEqual(await status(url(U1, 0), false), [401, "unauthorized", undefined]);
  const other = await get(`/api/sessions/1b2c3d4e-0000-4000-8000-000000000000/messages/${U1}/attachments/0`);
  assert.deepEqual([other.statusCode, other.json().error], [404, "unknown_session"], "a message of another session is not reached through it");
});

test("a message of one session is not found through another session's transcript", async () => {
  const empty = path.join(dir, "1b2c3d4e-0000-4000-8000-000000000000.jsonl");
  fs.writeFileSync(empty, JSON.stringify({ type: "user", uuid: "x", message: { content: "hi" } }) + "\n");
  const { get } = await server({ "1b2c3d4e-0000-4000-8000-000000000000": empty, "6c7d8e9f-0000-4000-8000-000000000000": undefined });
  const r = await get(`/api/sessions/1b2c3d4e-0000-4000-8000-000000000000/messages/${U1}/attachments/0`);
  assert.deepEqual([r.statusCode, r.json().error], [404, "not_found"]);
  const none = await get(`/api/sessions/6c7d8e9f-0000-4000-8000-000000000000/messages/${U1}/attachments/0`);
  assert.deepEqual([none.statusCode, none.json().error], [404, "not_found"], "a session without a transcript yet");
});

test("a message delivered after a first miss is found on the next request", async () => {
  const sid = "7e8f9a0b-0000-4000-8000-000000000000";
  const late = "8f9a0b1c-0000-4000-8000-000000000000";
  const f = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(f, "");
  const { get } = await server({ [sid]: f });
  const url = `/api/sessions/${sid}/messages/${late}/attachments/0`;
  assert.equal((await get(url)).statusCode, 404);
  fs.appendFileSync(f, JSON.stringify({ type: "attachment", uuid: "r1", attachment: { type: "queued_command", source_uuid: late, prompt: [image("image/png", PNG)] } }) + "\n");
  const r = await get(url);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.rawPayload, PNG);
});
