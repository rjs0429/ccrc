import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { Audit } from "../src/audit.ts";
import { paths } from "../src/config.ts";
import type { DisplayItem, SentFile } from "../src/protocol.ts";
import { registerFiles } from "../src/routes/files.ts";
import type { RouteDeps } from "../src/routes/types.ts";
import { SentIndex, openSent, transcriptCall, type SentCall } from "../src/sessions/sent-files.ts";
import { tempDir } from "./helpers.ts";

// A 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10"/></svg>';

function tree(files: Record<string, string | Buffer>): string {
  const root = fs.realpathSync(tempDir());
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

const sent = (p: string, extra: Partial<SentFile> = {}): SentFile => ({ name: path.basename(p), path: p, size: fs.existsSync(p) ? fs.statSync(p).size : 0, ...extra });

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
}

async function server(calls: Record<string, SentCall>, agentCalls: Record<string, SentCall> = {}) {
  const app = Fastify({ logger: false });
  app.decorateRequest("device", "");
  app.addHook("onRequest", async (req) => {
    req.device = String(req.headers["x-device"] ?? "phone");
  });
  const lease = { current: { tokenHash: "lease-1" } as { tokenHash: string } | undefined };
  const named: [string, Record<string, unknown>][] = [];
  const requireAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.headers.authorization !== "ok") return reply.code(401).send({ error: "unauthorized" });
  };
  const audit = { log: (e: string, detail: Record<string, unknown>) => named.push([e, detail]) } as unknown as Audit;
  const asked: unknown[][] = [];
  const manager = {
    fileAccess: async (id: string) => {
      if (id !== "s1") throw Error("unknown session");
      return { start: "/nonexistent" };
    },
    sentCall: async (id: string, call: string, agent?: string) => {
      asked.push([id, call, agent]);
      if (id !== "s1") throw Error("unknown session");
      return agent ? agentCalls[`${agent}/${call}`] : calls[call];
    },
  };
  const leases = { current: () => lease.current };
  await registerFiles(app, { audit, requireAuth, manager, leases, claudeSettings: { file: "/nonexistent/settings.json" } } as unknown as RouteDeps);
  const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, headers: { authorization: "ok", ...headers } });
  return { app, named, get, lease, asked };
}

test("a sent file opens by its call and place, wherever it lies, as the viewer and as bytes nothing runs", async () => {
  const proj = tree({ "report.md": "# 보고서\n\n본문" });
  const out = tree({ "chart.png": PNG, "diagram.svg": SVG, "page.html": "<script>x</script>", "data.zip": "PK\u0003\u0004", "doc.pdf": "%PDF-1.7", "blob.txt": "\u0000\u0001\u0002" });
  const files = ["chart.png", "diagram.svg", "page.html", "data.zip", "doc.pdf", "blob.txt"].map((f) => sent(path.join(out, f)));
  const at = Date.now() + 60_000;
  const { app, get, named, asked } = await server({ toolu_a: { files: [sent(path.join(proj, "report.md")), ...files], at } }, { "asub/toolu_b": { files: [sent(path.join(out, "chart.png"))] } });

  const md = await get("/api/sessions/s1/sent/toolu_a/0?path=/etc/hostname&href=/etc/hostname");
  assert.equal(md.statusCode, 200);
  assert.equal(md.headers["cache-control"], "no-store");
  assert.deepEqual(md.json(), {
    path: path.join(proj, "report.md"),
    name: "report.md",
    size: Buffer.byteLength("# 보고서\n\n본문"),
    kind: "markdown",
    text: "# 보고서\n\n본문",
    truncated: false,
    via: "broker",
    sent: { changed: false },
  });
  assert.deepEqual(asked[0], ["s1", "toolu_a", undefined], "the path the phone adds is never read");
  const png = await get("/api/sessions/s1/sent/toolu_a/1");
  assert.deepEqual([png.json().kind, png.json().text, png.json().path], ["image", undefined, path.join(out, "chart.png")], "a file outside the working folder opens");
  assert.equal((await get("/api/sessions/s1/sent/toolu_a/6")).json().kind, "binary", "text that is not text");

  const raw = await get("/api/sessions/s1/sent/toolu_a/1/raw");
  assert.equal(raw.statusCode, 200);
  assert.ok(raw.rawPayload.equals(PNG));
  assert.equal(raw.headers["content-type"], "image/png");
  assert.equal(raw.headers["content-length"], String(PNG.length));
  assert.match(String(raw.headers["content-security-policy"]), /^sandbox; default-src 'none'/);
  assert.match(String(raw.headers["content-disposition"]), /^inline; filename="chart.png"/);
  assert.equal(raw.headers["cross-origin-resource-policy"], "same-origin");
  assert.equal(raw.headers["cache-control"], "private, no-cache");
  const etag = String(raw.headers.etag);
  assert.match(etag, /^"\d+-[\d.]+"$/);
  const again = await get("/api/sessions/s1/sent/toolu_a/1/raw", { "if-none-match": etag });
  assert.equal(again.statusCode, 304, "an unchanged thumbnail is not sent again");
  assert.equal(again.rawPayload.length, 0);
  assert.match(String(again.headers["content-security-policy"]), /^sandbox/, "the policy the browser keeps for it stays the file's");

  const svg = await get("/api/sessions/s1/sent/toolu_a/2/raw");
  assert.equal(svg.headers["content-type"], "image/svg+xml");
  assert.match(String(svg.headers["content-security-policy"]), /sandbox/, "an SVG runs nothing even opened on its own");
  for (const [n, name] of [
    [3, "page.html"],
    [4, "data.zip"],
  ] as const) {
    const r = await get(`/api/sessions/s1/sent/toolu_a/${n}/raw`);
    assert.equal(r.headers["content-type"], "application/octet-stream", name);
    assert.match(String(r.headers["content-disposition"]), /^attachment/, name);
  }
  const pdf = await get("/api/sessions/s1/sent/toolu_a/5/raw");
  assert.equal(pdf.headers["content-type"], "application/pdf");
  assert.doesNotMatch(String(pdf.headers["content-security-policy"]), /sandbox/);
  assert.match(String((await get("/api/sessions/s1/sent/toolu_a/1/raw?download=1")).headers["content-disposition"]), /^attachment/);

  const nested = await get("/api/sessions/s1/sent/toolu_b/0/raw?agent=asub");
  assert.ok(nested.rawPayload.equals(PNG), "a subagent's call is found in its transcript");
  assert.deepEqual(asked.at(-1), ["s1", "toolu_b", "asub"]);

  assert.deepEqual([(await get("/api/sessions/s1/sent/toolu_a/7")).statusCode, (await get("/api/sessions/s1/sent/toolu_a/7")).json().error], [404, "not_found"]);
  assert.equal((await get("/api/sessions/s1/sent/toolu_zz/0")).json().error, "not_found");
  assert.equal((await get("/api/sessions/s1/sent/toolu_b/0")).json().error, "not_found", "a subagent's call needs its agent");
  assert.equal((await get("/api/sessions/zz/sent/toolu_a/0")).json().error, "unknown_session");
  for (const bad of ["toolu.a/0", "toolu_a/100", "toolu_a/-1", "toolu_a/0?agent=..%2Fx", `${"x".repeat(129)}/0`]) {
    assert.ok([400, 414].includes((await get(`/api/sessions/s1/sent/${bad}`)).statusCode), bad);
  }
  assert.equal((await app.inject({ method: "GET", url: "/api/sessions/s1/sent/toolu_a/0" })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/api/sessions/s1/sent/toolu_a/1/raw" })).statusCode, 401);

  const reads = named.filter(([e]) => e === "file_read").map(([, d]) => d);
  assert.ok(reads.some((d) => d.outcome === "ok" && d.sent === true && d.call === "toolu_a" && d.n === 0 && d.via === "broker" && d.path === path.join(proj, "report.md")));
  assert.ok(reads.some((d) => d.outcome === "ok" && d.raw === true && d.n === 1));
  assert.ok(reads.some((d) => d.outcome === "not_modified" && d.raw === true));
  assert.ok(reads.some((d) => d.outcome === "not_found" && d.call === "toolu_zz"));
  assert.ok(reads.some((d) => d.agent === "asub"));
});

test("secret files, links to them, ccrc's own state, folders, pipes, removed and oversized files are refused", async () => {
  const proj = tree({ ".env": "TOKEN=1", "notes.txt": "x", "keys/server.pem": "-----BEGIN", "gone.txt": "bye", "dir/a.txt": "a" });
  fs.symlinkSync(path.join(proj, ".env"), path.join(proj, "env-link.txt"));
  fs.symlinkSync(path.join(proj, "keys"), path.join(proj, "keys-link"));
  execFileSync("mkfifo", [path.join(proj, "pipe.txt")]);
  const big = path.join(proj, "big.bin");
  fs.writeFileSync(big, "");
  fs.truncateSync(big, 50 * 1024 * 1024 + 1);
  const list = [
    sent(path.join(proj, ".env")),
    sent(path.join(proj, "env-link.txt")),
    sent(path.join(proj, "keys-link/server.pem")),
    sent(path.join(paths.stateDir, "audit.jsonl")),
    sent(path.join(proj, "dir")),
    sent(path.join(proj, "pipe.txt")),
    sent(path.join(proj, "gone.txt")),
    sent(big),
    sent(path.join(proj, "notes.txt"), { error: "upload failed" }),
    sent("notes.txt"),
  ];
  fs.rmSync(path.join(proj, "gone.txt"));
  const { get } = await server({ toolu_s: { files: list } });
  const answers: [number, string][] = [];
  for (let n = 0; n < list.length; n++) {
    const r = await get(`/api/sessions/s1/sent/toolu_s/${n}/raw`);
    answers.push([r.statusCode, r.json().error]);
  }
  assert.deepEqual(answers, [
    [403, "denied"],
    [403, "denied"],
    [403, "denied"],
    [403, "denied"],
    [404, "gone"],
    [404, "gone"],
    [404, "gone"],
    [413, "too_large"],
    [404, "not_sent"],
    [404, "not_sent"],
  ]);
  assert.equal((await get("/api/sessions/s1/sent/toolu_s/7")).statusCode, 413, "the viewer refuses it too");
});

test("a file that changed after it was sent is still served, marked as changed", async () => {
  const proj = tree({ "a.txt": "first", "b.txt": "same" });
  const at = Date.now();
  fs.utimesSync(path.join(proj, "b.txt"), new Date(at - 60_000), new Date(at - 60_000));
  const a = sent(path.join(proj, "a.txt"));
  const b = sent(path.join(proj, "b.txt"));
  fs.writeFileSync(path.join(proj, "a.txt"), "second, longer");
  assert.equal((await openSent(b, 100, at).then(async (o) => (await o.fh.close(), o.changed))), false);
  assert.equal((await openSent(a, 100, at).then(async (o) => (await o.fh.close(), o.changed))), true, "its size differs");
  fs.utimesSync(path.join(proj, "b.txt"), new Date(at + 10_000), new Date(at + 10_000));
  assert.equal((await openSent(b, 100, at).then(async (o) => (await o.fh.close(), o.changed))), true, "written after it was sent");
  assert.equal(await code(openSent(b, 3, at)), "too_large");
  const { get } = await server({ toolu_c: { files: [a], at } });
  assert.deepEqual((await get("/api/sessions/s1/sent/toolu_c/0")).json().sent, { changed: true });
  assert.equal((await get("/api/sessions/s1/sent/toolu_c/0")).json().text, "second, longer", "the file as it is now");
});

test("a ticket names a sent file by its call and opens it without the cookie, only from the same device and login", async (t) => {
  const out = tree({ "doc.pdf": "%PDF-1.7", "data.zip": "PK" });
  const { app, named, lease } = await server({ toolu_t: { files: [sent(path.join(out, "doc.pdf")), sent(path.join(out, "data.zip"))] } }, { "asub/toolu_u": { files: [sent(path.join(out, "data.zip"))] } });
  const mint = (body: unknown, auth = "ok") =>
    app.inject({ method: "POST", url: "/api/sessions/s1/file/ticket", headers: { authorization: auth, "content-type": "application/json" }, payload: body as Record<string, unknown> });
  const fetch = (url: string, device = "phone") => app.inject({ method: "GET", url, headers: { "x-device": device } });

  assert.equal((await mint({ sent: { call: "toolu_t", n: 0 } }, "no")).statusCode, 401);
  for (const bad of [{ sent: { call: "toolu_t" } }, { sent: { call: "../x", n: 0 } }, { sent: { call: "toolu_t", n: 100 } }, { sent: "toolu_t" }, { sent: { call: "toolu_t", n: 0, agent: "a/b" } }]) {
    assert.equal((await mint(bad)).statusCode, 400, JSON.stringify(bad));
  }
  assert.equal((await mint({ sent: { call: "toolu_t", n: 1 }, path: "/etc/hostname" })).statusCode, 200, "a path beside the reference is ignored");
  const m = await mint({ sent: { call: "toolu_t", n: 0 } });
  const { url } = m.json() as { url: string };
  assert.match(url, /^\/api\/file-ticket\/[A-Za-z0-9_-]{43}$/);
  const first = await fetch(url);
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers["content-type"], "application/pdf");
  assert.match(String(first.headers["content-disposition"]), /^inline/);
  assert.match(String((await fetch(`${url}?download=1`)).headers["content-disposition"]), /^attachment/);
  assert.equal((await fetch(url, "laptop")).statusCode, 401, "another device cannot use it");
  lease.current = { tokenHash: "lease-2" };
  assert.equal((await fetch(url)).statusCode, 401, "a new login ends it");
  lease.current = { tokenHash: "lease-1" };
  const sub = (await mint({ sent: { call: "toolu_u", n: 0, agent: "asub" } })).json() as { url: string };
  assert.equal((await fetch(sub.url)).rawPayload.toString(), "PK");
  const reads = named.filter(([e]) => e === "file_read").map(([, d]) => d);
  assert.ok(reads.some((d) => d.ticket === true && d.raw === true && d.sent === true && d.call === "toolu_t" && d.n === 0 && d.outcome === "ok"));
  assert.ok(reads.some((d) => d.outcome === "ticket_invalid" && d.device === "laptop" && d.sent === true && d.call === "toolu_t"));
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 61_000 });
  assert.equal((await fetch(url)).statusCode, 401, "expired");
  t.mock.timers.reset();
});

test("a call is found in the transcript when no conversation read here holds it, and remembered", async () => {
  const dir = tempDir();
  const file = path.join(dir, "s.jsonl");
  const attachments = [{ path: "/tmp/r4/report.md", size: 24, isImage: false, media_type: "text/markdown", pathValidated: true }];
  const rows = [
    { type: "user", uuid: "u1", timestamp: "2026-10-16T06:00:00.000Z", message: { role: "user", content: "x".repeat(5_000_000) } },
    { type: "assistant", uuid: "a1", timestamp: "2026-10-16T06:00:01.000Z", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_t1", name: "SendUserFile", input: { files: ["report.md"] } }] } },
    { type: "user", uuid: "u2", timestamp: "2026-10-16T06:00:02.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_t1", content: "1 file delivered to user." }] }, toolUseResult: { attachments } },
    { type: "assistant", uuid: "a2", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/tmp/r4/report.md" } }] } },
    { type: "user", uuid: "u3", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_read", content: "x" }] }, toolUseResult: { attachments } },
    { type: "assistant", uuid: "a3", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_bad", name: "SendUserFile", input: { files: ["/x"] } }] } },
    { type: "user", uuid: "u4", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bad", content: "denied", is_error: true }] }, toolUseResult: { attachments } },
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  assert.deepEqual(await transcriptCall(file, "toolu_t1"), { files: [{ name: "report.md", path: "/tmp/r4/report.md", size: 24, mediaType: "text/markdown" }], at: Date.parse("2026-10-16T06:00:01.000Z") });
  assert.equal(await transcriptCall(file, "toolu_read"), undefined, "only a SendUserFile call");
  assert.equal(await transcriptCall(file, "toolu_bad"), undefined, "a failed call sent nothing");
  assert.equal(await transcriptCall(file, "toolu_none"), undefined);

  const index = new SentIndex();
  let reads = 0;
  const from = async () => (reads++, file);
  assert.equal((await index.find("s1", "toolu_t1", from))?.files.length, 1);
  assert.equal((await index.find("s1", "toolu_t1", from))?.files.length, 1);
  assert.equal(reads, 1, "a call found once is remembered");
  const item: DisplayItem = { kind: "tool", id: "toolu_live", ts: "2026-10-16T07:00:00.000Z", name: "SendUserFile", summary: "", input: {}, sent: [{ name: "a.md", path: "/tmp/a.md", size: 1 }] };
  index.add("s2", [item, { kind: "tool", id: "toolu_x", name: "Read", summary: "", input: {} }]);
  assert.deepEqual(await index.find("s2", "toolu_live", async () => assert.fail("not read")), { files: item.sent, at: Date.parse("2026-10-16T07:00:00.000Z") });
  assert.equal(await index.find("s2", "toolu_x", async () => undefined), undefined);
});
