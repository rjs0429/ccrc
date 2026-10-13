import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Audit } from "../src/audit.ts";
import { setCredentials } from "../src/auth.ts";
import { DeviceGate } from "../src/devices.ts";
import type { Hub } from "../src/hub.ts";
import { Leases } from "../src/lease.ts";
import { buildServer } from "../src/server.ts";
import type { SessionManager } from "../src/sessions/manager.ts";
import { tempDir, tempStore } from "./helpers.ts";

const ORIGIN = { origin: "http://localhost:80" };
const status = async () => ({ Peer: { a: { DNSName: "phone.example.ts.net.", TailscaleIPs: ["100.64.0.2"] } } });

async function setup() {
  const store = tempStore();
  const leases = new Leases(store, 60);
  const manager = { list: async () => [], folders: async () => [], models: [] } as unknown as SessionManager;
  const hub = { attach() {} } as unknown as Hub;
  const app = await buildServer({
    store,
    leases,
    gate: new DeviceGate(["phone"], true, status),
    audit: new Audit(path.join(tempDir(), "audit.jsonl")),
    manager,
    hub,
    webDir: tempDir(),
    logLevel: "silent",
  });
  return { app, store, leases };
}

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = String(res.headers["set-cookie"] ?? "");
  return raw.split(";")[0];
}

test("login works only after credentials are set", async () => {
  const { app, store } = await setup();
  const login = { method: "POST" as const, url: "/api/login", headers: ORIGIN, payload: { id: "owner", password: "correct horse battery" } };
  assert.equal((await app.inject(login)).statusCode, 401);
  await setCredentials(store, "owner", "correct horse battery");
  const res = await app.inject(login);
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["set-cookie"]), /HttpOnly/);
  assert.match(String(res.headers["set-cookie"]), /SameSite=Strict/);
  const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: cookieOf(res) } });
  assert.deepEqual(me.json(), { configured: true, loggedIn: true, device: "local" });
});

test("a second login asks before taking over, then ends the first", async () => {
  const { app, store } = await setup();
  await setCredentials(store, "owner", "correct horse battery");
  const payload = { id: "owner", password: "correct horse battery" };
  const first = await app.inject({ method: "POST", url: "/api/login", headers: ORIGIN, payload });
  const second = await app.inject({ method: "POST", url: "/api/login", headers: { ...ORIGIN, "x-forwarded-for": "100.64.0.2" }, payload });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().device, "local");
  const takeover = await app.inject({ method: "POST", url: "/api/login", headers: { ...ORIGIN, "x-forwarded-for": "100.64.0.2" }, payload: { ...payload, takeover: true } });
  assert.equal(takeover.statusCode, 200);
  const old = await app.inject({ method: "GET", url: "/api/sessions", headers: { cookie: cookieOf(first) } });
  assert.equal(old.statusCode, 401);
  const fresh = await app.inject({ method: "GET", url: "/api/sessions", headers: { cookie: cookieOf(takeover), "x-forwarded-for": "100.64.0.2" } });
  assert.equal(fresh.statusCode, 200);
});

test("state-changing requests need a matching Origin", async () => {
  const { app, store } = await setup();
  await setCredentials(store, "owner", "correct horse battery");
  const payload = { id: "owner", password: "correct horse battery" };
  assert.equal((await app.inject({ method: "POST", url: "/api/login", payload })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/login", headers: { origin: "https://evil.example" }, payload })).statusCode, 403);
});

test("unknown tailnet machines are refused before anything else", async () => {
  const { app } = await setup();
  const res = await app.inject({ method: "GET", url: "/api/me", headers: { "x-forwarded-for": "100.64.0.3" } });
  assert.equal(res.statusCode, 403);
});

test("session data needs a login", async () => {
  const { app } = await setup();
  assert.equal((await app.inject({ method: "GET", url: "/api/sessions" })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/api/options" })).statusCode, 401);
});

test("logout ends the login", async () => {
  const { app, store } = await setup();
  await setCredentials(store, "owner", "correct horse battery");
  const res = await app.inject({ method: "POST", url: "/api/login", headers: ORIGIN, payload: { id: "owner", password: "correct horse battery" } });
  const cookie = cookieOf(res);
  assert.equal((await app.inject({ method: "POST", url: "/api/logout", headers: { ...ORIGIN, cookie } })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/sessions", headers: { cookie } })).statusCode, 401);
});
