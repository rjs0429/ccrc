import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { DisplayItem } from "../src/protocol.ts";

// Transcripts are read from ~/.claude, so the test runs against an empty home of its own.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccrc-home-"));
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
after(() => fs.rmSync(home, { recursive: true, force: true }));

const { loadHistory, projectDirName } = await import("../src/sessions/history.ts");
const { ItemBuilder } = await import("../src/sessions/items.ts");
const { registerAttachments } = await import("../src/routes/attachments.ts");
const { keptItem } = await import("../../web/src/offlineCopy.ts");
type RouteDeps = import("../src/routes/types.ts").RouteDeps;

const SID = "4d8f2a6c-9e13-4b75-a0c2-6e1f8b3d5a97";
const cwd = path.join(home, "ws");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("screenshot-body")]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("photo-body")]);
const image = (media: string, data: Buffer) => ({ type: "image", source: { type: "base64", media_type: media, data: data.toString("base64") } });
const HEAD = "### Result\nTook the screenshot of the page.";
const TAIL = "### Page\n- Page URL: https://example.com/";
// A Playwright MCP screenshot's result: its text, the picture and more text.
const SHOT = [{ type: "text", text: HEAD }, image("image/png", PNG), { type: "text", text: TAIL }];

const tool = (items: unknown[], id: string) => (items as { kind: string; id: string }[]).find((i) => i.kind === "tool" && i.id === id) as
  | { result?: { text: string; images?: { mediaType: string; size: number }[] } }
  | undefined;

test("a tool result's pictures travel as references beside its text; one ccrc cannot serve stays a mark", () => {
  const b = new ItemBuilder(cwd);
  b.add({ type: "assistant", uuid: "a1", message: { content: [{ type: "tool_use", id: "toolu_shot", name: "mcp__playwright__browser_take_screenshot", input: {} }] } });
  b.add({ type: "user", uuid: "u1", message: { content: [{ type: "tool_result", tool_use_id: "toolu_shot", content: SHOT }] } });
  b.add({ type: "assistant", uuid: "a2", message: { content: [{ type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: `${cwd}/a.jpg` } }] } });
  b.add({ type: "user", uuid: "u2", message: { content: [{ type: "tool_result", tool_use_id: "toolu_read", content: [image("image/jpeg", JPEG)] }] } });
  b.add({ type: "assistant", uuid: "a3", message: { content: [{ type: "tool_use", id: "toolu_odd", name: "mcp__x__y", input: {} }] } });
  b.add({
    type: "user",
    uuid: "u3",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_odd",
          content: [{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }, image("image/svg+xml", Buffer.from("<svg/>")), { type: "text", text: "two" }],
        },
      ],
    },
  });
  assert.deepEqual(tool(b.items, "toolu_shot")?.result, { text: `${HEAD}\n${TAIL}`, isError: false, truncated: false, images: [{ mediaType: "image/png", size: PNG.length }] });
  assert.deepEqual(tool(b.items, "toolu_read")?.result, { text: "", isError: false, truncated: false, images: [{ mediaType: "image/jpeg", size: JPEG.length }] });
  assert.deepEqual(tool(b.items, "toolu_odd")?.result, { text: "[image]\n[image]\ntwo", isError: false, truncated: false });
  assert.ok(!JSON.stringify(b.items).includes(PNG.toString("base64")), "no picture data travels with the items");
});

test("the phone's copy of a conversation keeps no picture of a tool's result, and keeps its notices", () => {
  const item: DisplayItem = { kind: "tool", id: "t", name: "Read", summary: "a.png", input: {}, result: { text: "x", isError: false, truncated: false, images: [{ mediaType: "image/png", size: 9 }] } };
  assert.deepEqual(keptItem(item), { kind: "tool", id: "t", name: "Read", summary: "a.png", input: null, result: { text: "", isError: false, truncated: false } });
  const notice: DisplayItem = { kind: "notice", id: "n", notice: "fallback", text: "x".repeat(5000), model: "claude-opus-5-5", fallback: "claude-opus-4-8", detail: "why" };
  const kept = keptItem(notice);
  assert.equal(kept?.kind, "notice");
  assert.ok(kept?.kind === "notice" && kept.text.length <= 4001 && kept.model === "claude-opus-5-5" && kept.fallback === "claude-opus-4-8" && kept.detail === "why");
});

const dir = path.join(home, ".claude", "projects", projectDirName(cwd));
const file = path.join(dir, `${SID}.jsonl`);
const agentDir = path.join(dir, SID, "subagents", "workflows", "wf_example");
const agentFile = path.join(agentDir, "agent-a1b2c3.jsonl");

// Rows in the shape Claude Code 2.1.312 writes them; the screenshot's row follows a row long enough to span read chunks.
function transcript(): string {
  const base = { isSidechain: false, userType: "external", cwd, sessionId: SID, version: "2.1.312", gitBranch: "main" };
  const filler = "x".repeat(4 * 1024 * 1024 - 64);
  const rows = [
    { ...base, parentUuid: null, type: "user", uuid: "00000000-0000-4000-8000-000000000001", timestamp: "2026-10-28T01:00:00.000Z", message: { role: "user", content: "Take a screenshot" } },
    {
      ...base,
      parentUuid: "00000000-0000-4000-8000-000000000001",
      type: "assistant",
      uuid: "00000000-0000-4000-8000-000000000002",
      timestamp: "2026-10-28T01:00:01.000Z",
      message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: filler }, { type: "tool_use", id: "toolu_shot", name: "mcp__playwright__browser_take_screenshot", input: {} }] },
    },
    {
      ...base,
      parentUuid: "00000000-0000-4000-8000-000000000002",
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000003",
      timestamp: "2026-10-28T01:00:02.000Z",
      message: { role: "user", content: [{ tool_use_id: "toolu_shot", type: "tool_result", content: [...SHOT, image("image/png", Buffer.from("<html>"))] }] },
      toolUseResult: SHOT,
    },
    {
      ...base,
      parentUuid: "00000000-0000-4000-8000-000000000003",
      type: "assistant",
      uuid: "00000000-0000-4000-8000-000000000004",
      timestamp: "2026-10-28T01:00:03.000Z",
      message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Done" }] },
    },
  ];
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(file, transcript());
// A subagent's transcript: every row is a sidechain row.
fs.writeFileSync(
  agentFile,
  JSON.stringify({ isSidechain: true, agentId: "a1b2c3", type: "user", uuid: "s1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_sub", content: [image("image/jpeg", JPEG)] }] } }) + "\n",
);

test("a reload lists the pictures of a result as the live view does", async () => {
  const items = await loadHistory(SID, cwd);
  assert.deepEqual(tool(items, "toolu_shot")?.result, {
    text: `${HEAD}\n${TAIL}`,
    isError: false,
    truncated: false,
    images: [
      { mediaType: "image/png", size: PNG.length },
      { mediaType: "image/png", size: 6 },
    ],
  });
});

async function server(known: Record<string, { main?: string; agents?: Record<string, string> }>) {
  const app = Fastify({ logger: false });
  const requireAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.headers.authorization !== "ok") return reply.code(401).send({ error: "unauthorized" });
  };
  const asked: (string | undefined)[] = [];
  const manager = {
    toolTranscript: async (id: string, agent?: string) => {
      asked.push(agent);
      if (!(id in known)) throw Error("unknown session");
      return agent ? known[id].agents?.[agent] : known[id].main;
    },
  };
  await registerAttachments(app, { requireAuth, manager } as unknown as RouteDeps);
  const get = (url: string, headers: Record<string, string> = { authorization: "ok" }) => app.inject({ method: "GET", url, headers });
  return { app, get, asked };
}

test("the tool picture route serves a result's pictures by call and place, with the attachments' headers", async () => {
  const { get, asked } = await server({ [SID]: { main: file, agents: { a1b2c3: agentFile } } });
  const url = (call: string, n: number | string, agent?: string) => `/api/sessions/${SID}/tools/${call}/images/${n}${agent !== undefined ? `?agent=${agent}` : ""}`;
  const r = await get(url("toolu_shot", 0));
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers["content-type"], "image/png");
  assert.deepEqual(r.rawPayload, PNG);
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.match(String(r.headers["content-security-policy"]), /^sandbox; default-src 'none'/);
  assert.equal(r.headers["cache-control"], "private, no-cache");
  const again = await get(url("toolu_shot", 0), { authorization: "ok", "if-none-match": String(r.headers.etag) });
  assert.equal(again.statusCode, 304);
  assert.equal((await get(url("toolu_shot", 0), { "if-none-match": String(r.headers.etag) })).statusCode, 401, "a kept copy is not confirmed once signed out");

  const sub = await get(url("toolu_sub", 0, "a1b2c3"));
  assert.equal(sub.statusCode, 200, "a subagent's picture comes from its own transcript");
  assert.deepEqual(sub.rawPayload, JPEG);
  assert.deepEqual(asked.slice(-1), ["a1b2c3"]);

  const status = async (u: string) => {
    const x = await get(u);
    return [x.statusCode, x.json().error, x.headers["cache-control"]];
  };
  assert.deepEqual(await status(url("toolu_shot", 1)), [415, "not_image", "no-store"], "bytes that are not the named picture");
  assert.deepEqual(await status(url("toolu_shot", 2)), [404, "not_found", "no-store"], "a place past the pictures");
  assert.deepEqual(await status(url("toolu_sub", 0)), [404, "not_found", "no-store"], "a subagent's call is not in the session's transcript");
  assert.deepEqual(await status(url("toolu_shot", 0, "zz9")), [404, "not_found", "no-store"], "a subagent without a transcript");
  assert.deepEqual(await status(url("toolu shot", 0)), [400, "invalid", "no-store"]);
  assert.deepEqual(await status(url("toolu_shot", "0x1")), [400, "invalid", "no-store"]);
  assert.deepEqual(await status(url("toolu_shot", 0, "../x")), [400, "invalid", "no-store"]);
  assert.deepEqual(await status(`/api/sessions/${SID}/tools/toolu_shot/images/0?agent=a&agent=b`), [400, "invalid", "no-store"]);
  const other = await get(`/api/sessions/1b2c3d4e-0000-4000-8000-000000000000/tools/toolu_shot/images/0`);
  assert.deepEqual([other.statusCode, other.json().error], [404, "unknown_session"]);
});

test("pictures are found from the transcript's end back, past and within lines longer than a read", async () => {
  const sid = "7e8f9a0b-0000-4000-8000-0000000000bb";
  const f = path.join(dir, `${sid}.jsonl`);
  const huge = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024, 7)]);
  const row = (call: string, data: Buffer) => JSON.stringify({ type: "user", uuid: call, message: { content: [{ type: "tool_result", tool_use_id: call, content: [image("image/png", data)] }] } });
  fs.writeFileSync(f, [row("toolu_first", PNG), row("toolu_huge", huge), JSON.stringify({ type: "assistant", uuid: "a", message: { content: [{ type: "text", text: "x".repeat(6 * 1024 * 1024) }] } })].join("\n"));
  const { get } = await server({ [sid]: { main: f } });
  const first = await get(`/api/sessions/${sid}/tools/toolu_first/images/0`);
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.rawPayload, PNG);
  const big = await get(`/api/sessions/${sid}/tools/toolu_huge/images/0`);
  assert.equal(big.statusCode, 200);
  assert.equal(big.rawPayload.length, huge.length);
  assert.equal((await get(`/api/sessions/${sid}/tools/toolu_none/images/0`)).statusCode, 404);
});

test("a result written after a first miss is found on the next request", async () => {
  const sid = "7e8f9a0b-0000-4000-8000-0000000000aa";
  const f = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(f, "");
  const { get } = await server({ [sid]: { main: f } });
  const url = `/api/sessions/${sid}/tools/toolu_late/images/0`;
  assert.equal((await get(url)).statusCode, 404);
  fs.appendFileSync(f, JSON.stringify({ type: "user", uuid: "r1", message: { content: [{ type: "tool_result", tool_use_id: "toolu_late", content: [image("image/png", PNG)] }] } }) + "\n");
  const r = await get(url);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.rawPayload, PNG);
});
