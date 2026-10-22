import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

// The phone app's service worker run against a made-up network and Cache API.
const SOURCE = fs.readFileSync(new URL("../../web/public/sw.js", import.meta.url), "utf8");
const ORIGIN = "https://laptop.example.ts.net";

interface Req {
  url: string;
  method: string;
  mode: string;
}

const keyOf = (r: string | Req) => {
  const u = new URL(typeof r === "string" ? r : r.url, ORIGIN);
  return u.pathname + u.search;
};

class FakeCache {
  entries = new Map<string, Response>();
  async match(r: string | Req) {
    return this.entries.get(keyOf(r))?.clone();
  }
  async put(r: string | Req, res: Response) {
    this.entries.set(keyOf(r), res);
  }
  async delete(r: string | Req) {
    return this.entries.delete(keyOf(r));
  }
  async keys() {
    return [...this.entries.keys()].map((k) => ({ url: ORIGIN + k }));
  }
}

class FakeCaches {
  named = new Map<string, FakeCache>();
  async open(name: string) {
    if (!this.named.has(name)) this.named.set(name, new FakeCache());
    return this.named.get(name)!;
  }
  async keys() {
    return [...this.named.keys()];
  }
  async delete(name: string) {
    return this.named.delete(name);
  }
}

type Net = (req: Req) => Promise<Response>;

const html = (assets: string[]) =>
  new Response(`<!doctype html><script type="module" crossorigin src="${assets[0]}"></script>${assets.slice(1).map((a) => `<link rel="stylesheet" href="${a}">`).join("")}`, {
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'" },
  });

// A server with one version of the app at a time; off: every request fails as with the laptop asleep.
function server() {
  const s = { version: ["/assets/a1.js", "/assets/a1.css"], extra: new Set<string>(), off: false, status: 200, hits: [] as string[] };
  const net: Net = async (req) => {
    s.hits.push(keyOf(req));
    if (s.off) throw new TypeError("Failed to fetch");
    const path = keyOf(req);
    if (path === "/") return s.status === 200 ? html(s.version) : new Response("Forbidden", { status: s.status, headers: { "content-type": "text/plain" } });
    if (s.version.includes(path) || s.extra.has(path)) return new Response(`/* ${path} */`, { headers: { "content-type": "text/javascript" } });
    return new Response("not found", { status: 404 });
  };
  return { s, net };
}

function load(net: Net, timers: { instant?: boolean } = {}) {
  const handlers = new Map<string, (event: unknown) => void>();
  let claims = 0;
  const self = {
    addEventListener: (t: string, f: (event: unknown) => void) => handlers.set(t, f),
    location: { origin: ORIGIN },
    skipWaiting() {},
    clients: { claim: async () => void claims++ },
  };
  const caches = new FakeCaches();
  const fetchFn = (input: string | Req) => net(typeof input === "string" ? { url: new URL(input, ORIGIN).href, method: "GET", mode: "cors" } : input);
  const wait = (f: () => void, ms: number) => {
    const t = setTimeout(f, timers.instant ? 0 : ms);
    t.unref();
    return t;
  };
  new Function("self", "caches", "fetch", "setTimeout", SOURCE)(self, caches, fetchFn, wait);
  // settle: wait for what the worker goes on doing after its answer.
  const fire = async (type: string, request?: Req, settle = true) => {
    let answer: Promise<Response> | undefined;
    const waits: Promise<unknown>[] = [];
    handlers.get(type)!({ request, respondWith: (p: Promise<Response>) => (answer = Promise.resolve(p)), waitUntil: (p: Promise<unknown>) => waits.push(p) });
    const res = answer ? await answer.then((r) => r, (e: unknown) => e as Error) : undefined;
    if (settle) await Promise.allSettled(waits);
    return res;
  };
  return { caches, fire, shell: () => caches.open("ccrc-shell-v1"), claims: () => claims };
}

const nav = (path = "/"): Req => ({ url: ORIGIN + path, method: "GET", mode: "navigate" });
const get = (path: string): Req => ({ url: ORIGIN + path, method: "GET", mode: "cors" });
const held = async (sw: ReturnType<typeof load>) => [...(await sw.shell()).entries.keys()].filter((k) => k.startsWith("/assets/")).sort();

test("installing keeps the page and the files it names", async () => {
  const { net } = server();
  const sw = load(net);
  await sw.fire("install");
  const cache = await sw.shell();
  assert.ok(cache.entries.has("/"));
  assert.deepEqual(await held(sw), ["/assets/a1.css", "/assets/a1.js"]);
});

test("opening the app takes the network's page when it answers, else the kept one", async () => {
  const { s, net } = server();
  const sw = load(net);
  await sw.fire("install");
  const up = (await sw.fire("fetch", nav("/?tap=1"))) as Response;
  assert.equal(up.status, 200);
  assert.equal(up.headers.get("content-security-policy"), "default-src 'self'");
  s.off = true;
  const down = (await sw.fire("fetch", nav())) as Response;
  assert.match(await down.text(), /a1\.js/, "the kept page while the network fails");
  assert.equal(down.headers.get("content-security-policy"), "default-src 'self'", "with the page's policy");
  s.off = false;
  for (const status of [403, 502]) {
    s.status = status;
    const refused = (await sw.fire("fetch", nav())) as Response;
    assert.equal(refused.status, 200, `the kept page for ${status}, so the app can tell why`);
  }
});

test("a network that does not answer in time gives the kept page", async () => {
  const { net } = server();
  const sw = load(net);
  await sw.fire("install");
  const hang = load(() => new Promise<Response>(() => {}), { instant: true });
  (await hang.shell()).entries.set("/", (await (await sw.shell()).match("/"))!);
  const res = (await Promise.race([hang.fire("fetch", nav(), false), new Promise((r) => setTimeout(r, 2000, "waited"))])) as Response | string;
  assert.notEqual(res, "waited");
  assert.match(await (res as Response).text(), /a1\.js/);
});

test("with nothing kept the network's answer or failure is what the browser gets", async () => {
  const { s, net } = server();
  const sw = load(net);
  s.status = 403;
  assert.equal(((await sw.fire("fetch", nav())) as Response).status, 403);
  s.off = true;
  assert.ok((await sw.fire("fetch", nav())) instanceof Error);
});

test("the broker's API and anything but GET go to the network untouched", async () => {
  const { s, net } = server();
  const sw = load(net);
  assert.equal(await sw.fire("fetch", get("/api/sessions")), undefined);
  assert.equal(await sw.fire("fetch", nav("/api/file-ticket/x")), undefined, "a download opened in the app");
  assert.equal(await sw.fire("fetch", { ...get("/assets/a1.js"), method: "POST" }), undefined);
  assert.equal(await sw.fire("fetch", get("/manifest.webmanifest")), undefined);
  assert.equal(await sw.fire("fetch", { ...get("/assets/a1.js"), url: "https://example.com/assets/a1.js" }), undefined);
  assert.deepEqual(s.hits, []);
});

test("kept files come without the network; others are fetched and kept", async () => {
  const { s, net } = server();
  const sw = load(net);
  await sw.fire("install");
  s.hits.length = 0;
  s.off = true;
  assert.equal(((await sw.fire("fetch", get("/assets/a1.js"))) as Response).status, 200);
  assert.deepEqual(s.hits, []);
  s.off = false;
  s.extra.add("/assets/Viewer-1.js");
  await sw.fire("fetch", get("/assets/Viewer-1.js"));
  assert.ok((await sw.shell()).entries.has("/assets/Viewer-1.js"));
});

test("files of a page two versions old go; those of the last one stay for a page still open", async () => {
  const { s, net } = server();
  const sw = load(net);
  await sw.fire("install");
  s.extra.add("/assets/Viewer-1.js");
  await sw.fire("fetch", get("/assets/Viewer-1.js"));
  s.version = ["/assets/a2.js", "/assets/a2.css"];
  await sw.fire("fetch", nav());
  assert.deepEqual(await held(sw), ["/assets/Viewer-1.js", "/assets/a1.css", "/assets/a1.js", "/assets/a2.css", "/assets/a2.js"]);
  s.extra.add("/assets/Viewer-2.js");
  await sw.fire("fetch", get("/assets/Viewer-2.js"));
  await sw.fire("fetch", nav());
  assert.equal((await held(sw)).length, 6, "the same page again lets nothing go");
  s.version = ["/assets/a3.js", "/assets/a3.css"];
  await sw.fire("fetch", nav());
  assert.deepEqual(await held(sw), ["/assets/Viewer-2.js", "/assets/a2.css", "/assets/a2.js", "/assets/a3.css", "/assets/a3.js"]);
  s.version = ["/assets/a4.js", "/assets/a4.css"];
  await sw.fire("fetch", nav());
  assert.deepEqual(await held(sw), ["/assets/a3.css", "/assets/a3.js", "/assets/a4.css", "/assets/a4.js"]);
});

test("without a cache to keep things in, the app loads from the network as without the worker", async () => {
  const { s, net } = server();
  const sw = load(net);
  const broken = () => Promise.reject(new DOMException("no storage", "SecurityError"));
  Object.assign(sw.caches, { open: broken, keys: broken });
  assert.equal(((await sw.fire("fetch", get("/assets/a1.js"))) as Response).status, 200);
  assert.equal(((await sw.fire("fetch", nav())) as Response).status, 200);
  s.off = true;
  assert.ok((await sw.fire("fetch", nav())) instanceof Error);
  await sw.fire("activate");
  assert.equal(sw.claims(), 1, "activating still takes the open pages");
});

test("a new worker drops the caches of an older one", async () => {
  const { net } = server();
  const sw = load(net);
  await sw.caches.open("ccrc-shell-v0");
  await sw.caches.open("other");
  await sw.fire("activate");
  assert.deepEqual(await sw.caches.keys(), ["other"]);
  assert.equal(sw.claims(), 1);
});
