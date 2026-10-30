import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import zlib from "node:zlib";
import { Audit } from "../src/audit.ts";
import { setCredentials } from "../src/auth.ts";
import { DeviceGate } from "../src/devices.ts";
import { Doctor } from "../src/doctor.ts";
import type { Hub } from "../src/hub.ts";
import { Leases } from "../src/lease.ts";
import { Push } from "../src/push/index.ts";
import { buildServer } from "../src/server.ts";
import type { SessionManager } from "../src/sessions/manager.ts";
import { Uploads } from "../src/uploads.ts";
import { tempDir, tempStore } from "./helpers.ts";

const ORIGIN = "http://localhost:80";
const PAGE = (build: string) => `<!doctype html><html><head><script type="module" crossorigin src="/assets/index-a1.js"></script><meta name="ccrc-build" content="${build}"></head><body></body></html>`;

async function setup(sessions = 200) {
  const store = tempStore();
  const leases = new Leases(store, 60);
  const web = tempDir();
  fs.mkdirSync(path.join(web, "assets"));
  fs.writeFileSync(path.join(web, "index.html"), PAGE("b1"));
  fs.writeFileSync(path.join(web, "assets", "index-a1.js"), "export const a = 1;\n".repeat(200));
  fs.writeFileSync(path.join(web, "assets", "index-a1.js.br"), zlib.brotliCompressSync(fs.readFileSync(path.join(web, "assets", "index-a1.js"))));
  const list = Array.from({ length: sessions }, (_, i) => ({ id: `s-${i}`, title: `세션 ${i}`, cwd: "/work/app", lastModified: i, state: "inactive" }));
  const manager = { list: async () => list, folders: async () => [], modelList: async () => [] } as unknown as SessionManager;
  const hub = { attach() {} } as unknown as Hub;
  const app = await buildServer({
    store,
    leases,
    gate: new DeviceGate([], true),
    audit: new Audit(path.join(tempDir(), "audit.jsonl")),
    manager,
    hub,
    uploads: new Uploads(tempDir()),
    push: new Push(tempDir()),
    doctor: new Doctor(),
    webDir: web,
    logLevel: "silent",
    version: () => "v0.8.2",
  });
  await setCredentials(store, "tester", "test-password-123");
  const login = await app.inject({ method: "POST", url: "/api/login", headers: { origin: ORIGIN }, payload: { id: "tester", password: "test-password-123" } });
  const cookie = String(login.headers["set-cookie"]).split(";")[0];
  return { app, hub, web, cookie };
}

test("the socket's origin is checked whatever its address asks", async () => {
  const { app } = await setup(0);
  for (const url of ["/ws", "/ws?w=page-aaaa&n=1", "/ws?n=1"]) {
    const res = await app.inject({ method: "GET", url, headers: { origin: "https://evil.example" } });
    assert.equal(res.statusCode, 403, url);
    assert.deepEqual(res.json(), { error: "bad_origin" });
  }
  await app.close();
});

test("a file under /assets/ the build does not have is missing, while other addresses give the app's page", async () => {
  const { app } = await setup(0);
  const missing = await app.inject({ method: "GET", url: "/assets/FileViewer-old.js" });
  assert.equal(missing.statusCode, 404);
  assert.match(String(missing.headers["content-type"]), /application\/json/);
  const route = await app.inject({ method: "GET", url: "/settings/status" });
  assert.equal(route.statusCode, 200);
  assert.match(route.body, /ccrc-build/);
  await app.close();
});

test("a built file goes as its compressed copy to a browser that takes it", async () => {
  const { app } = await setup(0);
  const br = await app.inject({ method: "GET", url: "/assets/index-a1.js", headers: { "accept-encoding": "gzip, deflate, br" } });
  assert.equal(br.headers["content-encoding"], "br");
  assert.match(String(br.headers["content-type"]), /javascript/);
  assert.match(String(br.headers.vary), /accept-encoding/i);
  assert.equal(zlib.brotliDecompressSync(br.rawPayload).toString(), "export const a = 1;\n".repeat(200));
  const plain = await app.inject({ method: "GET", url: "/assets/index-a1.js", headers: { "accept-encoding": "gzip" } });
  assert.equal(plain.headers["content-encoding"], undefined, "no .gz copy: the file as it is");
  assert.equal(plain.body, "export const a = 1;\n".repeat(200));
  await app.close();
});

test("answers in JSON are compressed for a browser that takes it, small ones are not", async () => {
  const { app, cookie } = await setup();
  const ask = (enc?: string) => app.inject({ method: "GET", url: "/api/sessions", headers: { cookie, ...(enc === undefined ? {} : { "accept-encoding": enc }) } });
  const plain = await ask();
  assert.equal(plain.headers["content-encoding"], undefined);
  const list = plain.json();
  assert.equal(list.length, 200);
  const br = await ask("gzip, deflate, br, zstd");
  assert.equal(br.headers["content-encoding"], "br");
  assert.match(String(br.headers.vary), /Accept-Encoding/);
  assert.ok(br.rawPayload.length < plain.rawPayload.length / 4, `${br.rawPayload.length} of ${plain.rawPayload.length}`);
  assert.deepEqual(JSON.parse(zlib.brotliDecompressSync(br.rawPayload).toString()), list);
  const gz = await ask("gzip;q=1, br;q=0");
  assert.equal(gz.headers["content-encoding"], "gzip");
  assert.deepEqual(JSON.parse(zlib.gunzipSync(gz.rawPayload).toString()), list);
  const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie, "accept-encoding": "br" } });
  assert.equal(me.headers["content-encoding"], undefined, "a small answer goes as it is");
  await app.close();
});

test("the broker names the build index.html names, read again when a build replaces it", async () => {
  const { app, hub, web } = await setup(0);
  assert.equal(hub.webBuild?.(), "b1");
  const file = path.join(web, "index.html");
  fs.writeFileSync(file, PAGE("b2"));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.equal(hub.webBuild?.(), "b2");
  fs.rmSync(file);
  assert.equal(hub.webBuild?.(), undefined);
  await app.close();
});

test("a login checked without counting as activity does not move its idle time", () => {
  const store = tempStore();
  const leases = new Leases(store, 60);
  const token = leases.issue("phone", 1000);
  const seen = () => store.state.lease?.lastSeen;
  assert.ok(leases.validate(token, 1000 + 120_000, false));
  assert.equal(seen(), 1000);
  assert.ok(leases.validate(token, 1000 + 120_000));
  assert.equal(seen(), 121_000);
});
