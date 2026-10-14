import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { Audit } from "../src/audit.ts";
import { registerFiles } from "../src/routes/files.ts";
import type { RouteDeps } from "../src/routes/types.ts";
import type { SessionCore } from "../src/sessions/core.ts";
import {
  ReadError,
  additionalDirectories,
  isSecretPath,
  kindOf,
  looksBinary,
  parseLink,
  readDirect,
  readFailure,
  resolveLink,
  servedType,
} from "../src/sessions/file-read.ts";
import { tempDir } from "./helpers.ts";

function tree(files: Record<string, string>): string {
  const root = fs.realpathSync(tempDir());
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

const listing = (files: string[]) => async () => files;

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof ReadError ? e.code : String(e);
  }
}

test("links parse into a path and an anchor", () => {
  assert.deepEqual(parseLink("src/app.ts#L42"), { path: "src/app.ts", line: 42 });
  assert.deepEqual(parseLink("src/app.ts#L42-L50"), { path: "src/app.ts", line: 42, endLine: 50 });
  assert.deepEqual(parseLink("src/app.ts:42"), { path: "src/app.ts", line: 42 });
  assert.deepEqual(parseLink("src/app.ts:42:7"), { path: "src/app.ts", line: 42 });
  assert.deepEqual(parseLink("./docs/My%20Notes.md#set-up"), { path: "./docs/My Notes.md", heading: "set-up" });
  assert.deepEqual(parseLink("file:///home/u/p/a%20b.ts#L3"), { path: "/home/u/p/a b.ts", line: 3 });
  assert.deepEqual(parseLink("../agents/x/README.md"), { path: "../agents/x/README.md" });
  assert.deepEqual(parseLink("README.md"), { path: "README.md" });
  assert.equal(parseLink("~/notes.md")?.path, path.join(os.homedir(), "notes.md"));
  for (const bad of ["https://example.com/a.md", "mailto:a@b.c", "javascript:alert(1)", "data:text/html,x", "file://other-host/etc/passwd", "", "#top"]) {
    assert.equal(parseLink(bad), undefined, bad);
  }
});

test("a link Claude wrote against the wrong base is found by dropping ../, then by its last segments", async () => {
  const cwd = tree({ "agents/ccrc_phase3_20261014/README.md": "# x", "src/lib/util.ts": "x", "a/notes/todo.md": "1", "b/notes/todo.md": "2" });
  const files = ["agents/ccrc_phase3_20261014/README.md", "src/lib/util.ts", "a/notes/todo.md", "b/notes/todo.md"];
  assert.deepEqual(await resolveLink("agents/ccrc_phase3_20261014/README.md", [cwd], [cwd], listing(files)), {
    abs: path.join(cwd, "agents/ccrc_phase3_20261014/README.md"),
  });
  assert.deepEqual(await resolveLink("../agents/ccrc_phase3_20261014/README.md", [cwd], [cwd], listing(files)), {
    abs: path.join(cwd, "agents/ccrc_phase3_20261014/README.md"),
    fallback: "parent",
  });
  assert.deepEqual(await resolveLink("/elsewhere/project/src/lib/util.ts", [cwd], [cwd], listing(files)), {
    abs: path.join(cwd, "src/lib/util.ts"),
    fallback: "suffix",
  });
  assert.equal(await resolveLink("other/notes/todo.md", [cwd], [cwd], listing(files)), undefined, "two files end the same way");
  assert.equal(await resolveLink("util.ts", [cwd], [cwd], listing(files)), undefined, "one segment is not enough");
  assert.equal(await resolveLink("src/lib", [cwd], [cwd], listing(files)), undefined, "a folder is not a file");
});

test("relative links try the start folder before the latest one", async () => {
  const root = tree({ "start/a.md": "start", "start/sub/a.md": "sub", "start/sub/b.md": "only in sub" });
  const bases = [path.join(root, "start"), path.join(root, "start/sub")];
  assert.equal((await resolveLink("a.md", bases, bases, listing([])))?.abs, path.join(root, "start/a.md"));
  assert.equal((await resolveLink("b.md", bases, bases, listing([])))?.abs, path.join(root, "start/sub/b.md"));
});

test("the broker reads only regular files inside the working directories", async () => {
  const root = tree({ "proj/ok.txt": "hello", "proj/big.txt": "x".repeat(50), "outside/secret.txt": "no", "extra/data.txt": "extra" });
  const proj = path.join(root, "proj");
  fs.symlinkSync(path.join(root, "outside/secret.txt"), path.join(proj, "link.txt"));
  fs.symlinkSync(path.join(root, "outside"), path.join(proj, "linkdir"));
  assert.equal((await readDirect(path.join(proj, "ok.txt"), [proj], 100)).data.toString(), "hello");
  const big = await readDirect(path.join(proj, "big.txt"), [proj], 10);
  assert.deepEqual([big.data.length, big.size, big.truncated], [10, 50, true]);
  assert.equal(await code(readDirect(path.join(proj, "../outside/secret.txt"), [proj], 100)), "denied", "../ escape");
  assert.equal(await code(readDirect(path.join(proj, "link.txt"), [proj], 100)), "denied", "symlink escape");
  assert.equal(await code(readDirect(path.join(proj, "linkdir/secret.txt"), [proj], 100)), "denied", "linked folder escape");
  assert.equal(await code(readDirect(path.join(proj, "missing.txt"), [proj], 100)), "not_found");
  assert.equal(await code(readDirect(proj, [root], 100)), "not_found", "a folder");
  assert.equal(await code(readDirect(path.join(root, "extra/data.txt"), [proj, path.join(root, "extra")], 100)), "ok", "an additional directory");
});

test("secret files are refused even inside the working directory", async () => {
  const home = os.homedir();
  for (const p of [
    "/p/.env",
    "/p/.env.local",
    "/p/certs/server.pem",
    "/p/tls.key",
    "/p/id_ed25519",
    `${home}/.ssh/config`,
    `${home}/.gnupg/pubring.kbx`,
    `${home}/.aws/credentials`,
    `${home}/.netrc`,
    "/p/.npmrc",
    "/p/.pypirc",
    `${home}/.claude/.credentials.json`,
    `${home}/.config/gh/hosts.yml`,
    `${home}/.claude.json`,
    `${home}/.claude/settings.json`,
    `${home}/.claude/settings.local.json`,
    "/proc/self/environ",
  ]) {
    assert.ok(isSecretPath(p), p);
  }
  for (const p of ["/p/README.md", "/p/.claude/settings.json", `${home}/.claude/plans/a.md`, "/p/env.ts", "/p/id_ed25519.pub", "/p/keys.ts", "/p/src/.envrc.md"]) assert.ok(!isSecretPath(p), p);
  const proj = tree({ ".env": "TOKEN=1", "keys/deploy.pem": "-----BEGIN" });
  assert.equal(await code(readDirect(path.join(proj, ".env"), [proj], 100)), "denied");
  fs.symlinkSync(path.join(proj, ".env"), path.join(proj, "env.txt"));
  assert.equal(await code(readDirect(path.join(proj, "env.txt"), [proj], 100)), "denied", "a link to a secret file");
});

test("file kinds, served types and binary text", () => {
  assert.deepEqual(["a.md", "a.png", "a.PDF", "a.json", "a.csv", "a.tsv", "a.ts", "Makefile", "a.zip", "a.svg", "a.html"].map(kindOf), [
    "markdown",
    "image",
    "pdf",
    "json",
    "csv",
    "tsv",
    "text",
    "text",
    "binary",
    "text",
    "text",
  ]);
  assert.deepEqual(["a.png", "a.pdf", "a.svg", "a.html", "a.xml", "a.md"].map(servedType), [
    "image/png",
    "application/pdf",
    "application/octet-stream",
    "application/octet-stream",
    "application/octet-stream",
    "application/octet-stream",
  ]);
  assert.ok(looksBinary("PK\u0003\u0004\u0000\u0000"));
  assert.ok(!looksBinary("const 한글 = 1;\n"));
  assert.deepEqual(
    ["read denied: /x", "File does not exist: x", "Claude Code did not answer"].map((m) => readFailure(Error(m)).code),
    ["denied", "not_found", "failed"],
  );
});

test("additional directories come from the user's and the project's settings", () => {
  const proj = tree({ ".claude/settings.local.json": JSON.stringify({ permissions: { additionalDirectories: ["../shared"] } }) });
  const user = path.join(tree({ "settings.json": JSON.stringify({ permissions: { additionalDirectories: ["/opt/docs", "~/notes"] } }) }), "settings.json");
  assert.deepEqual(additionalDirectories(user, proj).sort(), [path.join(os.homedir(), "notes"), "/opt/docs", path.resolve(proj, "../shared")].sort());
});

async function server(session: { start: string; latest?: string; core?: Partial<SessionCore> }) {
  const app = Fastify({ logger: false });
  app.decorateRequest("device", "");
  app.addHook("onRequest", async (req) => {
    req.device = String(req.headers["x-device"] ?? "phone");
  });
  const lease = { current: { tokenHash: "lease-1" } as { tokenHash: string } | undefined };
  const events: Record<string, unknown>[] = [];
  const named: [string, Record<string, unknown>][] = [];
  const requireAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.headers.authorization !== "ok") return reply.code(401).send({ error: "unauthorized" });
  };
  const audit = { log: (e: string, detail: Record<string, unknown>) => (events.push(detail), named.push([e, detail])) } as unknown as Audit;
  const manager = {
    fileAccess: async (id: string) => {
      if (id !== "s1") throw Error("unknown session");
      return { start: session.start, latest: session.latest, session: session.core };
    },
  };
  const leases = { current: () => lease.current };
  await registerFiles(app, { audit, requireAuth, manager, leases, claudeSettings: { file: "/nonexistent/settings.json" } } as unknown as RouteDeps);
  const get = (url: string) => app.inject({ method: "GET", url, headers: { authorization: "ok" } });
  return { app, events, named, get, lease };
}

test("the file route resolves, reads and serves without rendering active content", async () => {
  const proj = tree({
    "docs/guide.md": "# Guide\n[x](../src/a.ts)",
    "src/a.ts": "export const a = 1;\n",
    "img/p.png": "\x89PNG....",
    "page.html": "<script>x</script>",
    "doc.pdf": "%PDF-1.7",
  });
  const { app, get, events } = await server({ start: proj });
  const q = (href: string, base?: string) => `/api/sessions/s1/file?href=${encodeURIComponent(href)}${base ? `&base=${encodeURIComponent(base)}` : ""}`;

  const md = await get(q("docs/guide.md#usage"));
  assert.equal(md.statusCode, 200);
  assert.equal(md.headers["cache-control"], "no-store");
  assert.deepEqual(
    { ...(md.json() as object), size: 0 },
    {
      path: path.join(proj, "docs/guide.md"),
      name: "guide.md",
      size: 0,
      kind: "markdown",
      text: "# Guide\n[x](../src/a.ts)",
      truncated: false,
      via: "broker",
      heading: "usage",
    },
  );
  const rel = await get(q("../src/a.ts#L1", path.join(proj, "docs")));
  assert.equal(rel.json().path, path.join(proj, "src/a.ts"));
  assert.equal(rel.json().line, 1);
  assert.equal((await get(q("../../etc/passwd"))).json().error, "denied");
  assert.equal((await get(q("nope/missing.md"))).statusCode, 404);
  assert.equal((await get("/api/sessions/zz/file?href=a.md")).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: q("docs/guide.md") })).statusCode, 401);

  const png = await get(q("img/p.png"));
  assert.equal(png.json().kind, "image");
  assert.equal(png.json().text, undefined);
  const raw = await get(`/api/sessions/s1/file/raw?path=${encodeURIComponent(path.join(proj, "img/p.png"))}`);
  assert.equal(raw.headers["content-type"], "image/png");
  assert.equal(raw.headers["x-content-type-options"], undefined, "set by the server's hook, not the route");
  assert.match(String(raw.headers["content-security-policy"]), /sandbox/);
  const html = await get(`/api/sessions/s1/file/raw?path=${encodeURIComponent(path.join(proj, "page.html"))}`);
  assert.equal(html.headers["content-type"], "application/octet-stream");
  assert.match(String(html.headers["content-disposition"]), /^attachment/);
  const pdf = await get(`/api/sessions/s1/file/raw?path=${encodeURIComponent(path.join(proj, "doc.pdf"))}`);
  assert.equal(pdf.headers["content-type"], "application/pdf");
  assert.match(String(pdf.headers["content-disposition"]), /^inline/);
  assert.equal((await get(`/api/sessions/s1/file/raw?path=${encodeURIComponent("/etc/hostname")}`)).statusCode, 403);
  assert.ok(events.some((e) => e.outcome === "denied") && events.some((e) => e.outcome === "ok" && e.raw === true));
});

test("a live session's Claude Code reads the file and its refusal stands", async () => {
  const proj = tree({ "a.md": "local", "b.md": "x" });
  const asked: unknown[] = [];
  const core = {
    readFile: (p: string, max: number, enc: string) => {
      asked.push([p, max, enc]);
      return p.endsWith("b.md")
        ? Promise.reject(Error(`read denied: ${p}`))
        : Promise.resolve({ contents: "from claude", absPath: p, truncated: false, base64: false });
    },
  };
  const { get } = await server({ start: proj, core: core as unknown as SessionCore });
  const a = await get(`/api/sessions/s1/file?href=a.md`);
  assert.deepEqual([a.json().text, a.json().via], ["from claude", "claude"]);
  assert.deepEqual(asked[0], [path.join(proj, "a.md"), 1_000_000, "utf-8"]);
  const b = await get(`/api/sessions/s1/file?href=b.md`);
  assert.deepEqual([b.statusCode, b.json().error], [403, "denied"]);
});

test("a file outside the working directories is refused whatever its size", async () => {
  const proj = tree({ "a.md": "x" });
  const outside = tree({});
  for (const f of [path.join(outside, "big.zip"), path.join(outside, "big.png"), path.join(proj, "big.zip")]) {
    fs.writeFileSync(f, "");
    fs.truncateSync(f, 10_000_001);
  }
  const { get } = await server({ start: proj });
  assert.equal((await get(`/api/sessions/s1/file?href=${encodeURIComponent(path.join(outside, "big.zip"))}`)).statusCode, 403);
  assert.equal((await get(`/api/sessions/s1/file/raw?path=${encodeURIComponent(path.join(outside, "big.png"))}`)).statusCode, 403);
  assert.equal((await get(`/api/sessions/s1/file?href=big.zip`)).statusCode, 413);
});

test("a wrapper that predates read_file leaves the reading to the broker", async () => {
  const proj = tree({ "a.md": "local" });
  const core = { readFile: () => Promise.reject(Error("rejected by the wrapper: request not allowed")) };
  const { get } = await server({ start: proj, core: core as unknown as SessionCore });
  const a = await get(`/api/sessions/s1/file?href=a.md`);
  assert.deepEqual([a.json().text, a.json().via], ["local", "broker"]);
});

test("a ticket opens one file without the cookie, only from the same device and login and only for a minute", async (t) => {
  const proj = tree({ "doc.pdf": "%PDF-1.7", "a.md": "x", ".env": "TOKEN=1" });
  const { app, named, lease } = await server({ start: proj });
  const mint = (p: unknown, id = "s1", auth = "ok") =>
    app.inject({ method: "POST", url: `/api/sessions/${id}/file/ticket`, headers: { authorization: auth, "content-type": "application/json" }, payload: { path: p } });
  const fetch = (url: string, device = "phone") => app.inject({ method: "GET", url, headers: { "x-device": device } });

  assert.equal((await mint(path.join(proj, "doc.pdf"), "s1", "no")).statusCode, 401);
  assert.equal((await mint("doc.pdf")).statusCode, 400);
  assert.equal((await mint(path.join(proj, "doc.pdf"), "zz")).statusCode, 404);
  const m = await mint(path.join(proj, "doc.pdf"));
  assert.equal(m.statusCode, 200);
  const { url } = m.json() as { url: string };
  assert.match(url, /^\/api\/file-ticket\/[A-Za-z0-9_-]{43}$/);
  assert.ok(!url.includes("doc.pdf"), "the URL names no file");

  const first = await fetch(url);
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers["content-type"], "application/pdf");
  assert.match(String(first.headers["content-disposition"]), /^inline/);
  assert.equal(first.headers["cache-control"], "no-store");
  assert.equal((await fetch(url)).statusCode, 200, "a viewer may fetch again");
  const dl = await fetch(`${url}?download=1`);
  assert.match(String(dl.headers["content-disposition"]), /^attachment/);
  assert.ok(named.some(([e, x]) => e === "file_read" && x.ticket === true && x.raw === true && x.outcome === "ok" && x.device === "phone"));

  assert.equal((await fetch(url, "laptop")).statusCode, 401, "another device cannot use it");
  assert.equal((await fetch("/api/file-ticket/nope")).statusCode, 401);
  lease.current = { tokenHash: "lease-2" };
  assert.equal((await fetch(url)).statusCode, 401, "a new login ends it");
  lease.current = { tokenHash: "lease-1" };
  assert.equal((await fetch(url)).statusCode, 200);
  assert.ok(named.some(([e, x]) => e === "file_read" && x.outcome === "ticket_invalid" && x.device === "laptop" && x.path === path.join(proj, "doc.pdf")));

  const secret = (await mint(path.join(proj, ".env"))).json() as { url: string };
  assert.equal((await fetch(secret.url)).statusCode, 403, "secret files stay refused");
  const outside = (await mint("/etc/hostname")).json() as { url: string };
  assert.equal((await fetch(outside.url)).statusCode, 403, "the working-folder scope still applies");

  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 61_000 });
  assert.equal((await fetch(url)).statusCode, 401, "expired");
  assert.equal(named.at(-1)?.[1].outcome, "ticket_expired");
  t.mock.timers.reset();
});
