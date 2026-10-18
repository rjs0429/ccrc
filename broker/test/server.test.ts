import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { Audit } from "../src/audit.ts";
import { setCredentials } from "../src/auth.ts";
import { DeviceGate } from "../src/devices.ts";
import type { Hub } from "../src/hub.ts";
import { Doctor } from "../src/doctor.ts";
import { Leases } from "../src/lease.ts";
import { Push } from "../src/push/index.ts";
import { buildServer, loggedUrl } from "../src/server.ts";
import { Uploads } from "../src/uploads.ts";
import type { SessionManager } from "../src/sessions/manager.ts";
import { tempDir, tempStore } from "./helpers.ts";

const ORIGIN = { origin: "http://localhost:80" };
const status = async () => ({ Peer: { a: { DNSName: "phone.example.ts.net.", TailscaleIPs: ["100.64.0.2"] } } });

async function setup(log?: { stream: NodeJS.WritableStream }, o: { allowLocal?: boolean } = {}) {
  const store = tempStore();
  const leases = new Leases(store, 60);
  let vscodeArchive = false;
  const manager = {
    list: async () => [],
    folders: async () => [],
    modelList: async () => [],
    brokerSessions: () => ({ mode: "off", ready: false }),
    vscodeArchiveOn: () => vscodeArchive,
    setVscodeArchive: (on: boolean) => (vscodeArchive = on),
  } as unknown as SessionManager;
  const hub = { attach() {} } as unknown as Hub;
  const app = await buildServer({
    store,
    leases,
    gate: new DeviceGate(["phone"], o.allowLocal ?? true, status),
    audit: new Audit(path.join(tempDir(), "audit.jsonl")),
    manager,
    hub,
    uploads: new Uploads(tempDir()),
    push: new Push(tempDir()),
    doctor: new Doctor(),
    webDir: tempDir(),
    logLevel: log ? "info" : "silent",
    logStream: log?.stream,
    version: () => "v0.7.0-2-gabcdef1",
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

test("ping answers the version without a login, to this machine even when allowLocal is off", async () => {
  const { app } = await setup(undefined, { allowLocal: false });
  const local = await app.inject({ method: "GET", url: "/api/ping" });
  assert.equal(local.statusCode, 200);
  assert.deepEqual(local.json(), { ok: true, version: "v0.7.0-2-gabcdef1" });
  assert.equal((await app.inject({ method: "GET", url: "/api/ping?x=1" })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/me" })).statusCode, 403, "nothing else is let in");
  assert.equal((await app.inject({ method: "GET", url: "/api/ping", headers: { "x-forwarded-for": "100.64.0.2" } })).statusCode, 200, "an allowed device");
  assert.equal((await app.inject({ method: "GET", url: "/api/ping", headers: { "x-forwarded-for": "100.64.0.3" } })).statusCode, 403, "another machine");
  assert.equal((await app.inject({ method: "GET", url: "/api/ping", remoteAddress: "100.64.0.3" })).statusCode, 403, "not through tailscale serve");
});

test("options say how broker sessions sign in", async () => {
  const { app, store } = await setup();
  await setCredentials(store, "owner", "correct horse battery");
  const login = await app.inject({ method: "POST", url: "/api/login", headers: ORIGIN, payload: { id: "owner", password: "correct horse battery" } });
  const res = await app.inject({ method: "GET", url: "/api/options", headers: { cookie: cookieOf(login) } });
  assert.deepEqual(res.json().brokerSessions, { mode: "off", ready: false });
});

test("the phone turns the VS Code archive on and off in config.json, and nothing else", async (t) => {
  const dir = tempDir();
  const saved = process.env.CCRC_CONFIG_DIR;
  process.env.CCRC_CONFIG_DIR = dir;
  t.after(() => (saved === undefined ? delete process.env.CCRC_CONFIG_DIR : (process.env.CCRC_CONFIG_DIR = saved)));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, port: 0, roots: ["/home/user/work"], updateCheck: false }, null, 2) + "\n");
  const { app, store } = await setup();
  await setCredentials(store, "owner", "correct horse battery");
  const login = await app.inject({ method: "POST", url: "/api/login", headers: ORIGIN, payload: { id: "owner", password: "correct horse battery" } });
  const headers = { ...ORIGIN, cookie: cookieOf(login) };
  assert.equal((await app.inject({ method: "GET", url: "/api/options", headers })).json().vscodeArchive, false);
  const on = await app.inject({ method: "POST", url: "/api/options/vscode-archive", headers, payload: { on: true } });
  assert.deepEqual(on.json(), { vscodeArchive: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { schemaVersion: 1, port: 0, roots: ["/home/user/work"], updateCheck: false, vscodeArchive: true });
  assert.equal((await app.inject({ method: "GET", url: "/api/options", headers })).json().vscodeArchive, true);
  for (const payload of [{ on: "yes" }, {}, { on: true, port: 1 }]) {
    const res = await app.inject({ method: "POST", url: "/api/options/vscode-archive", headers, payload });
    assert.equal(res.statusCode, Object.hasOwn(payload, "port") ? 200 : 400, JSON.stringify(payload));
  }
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).port, 0, "only the one key is written");
  assert.equal((await app.inject({ method: "POST", url: "/api/options/vscode-archive", headers: ORIGIN, payload: { on: false } })).statusCode, 401);
  fs.writeFileSync(file, "{ broken");
  assert.deepEqual((await app.inject({ method: "POST", url: "/api/options/vscode-archive", headers, payload: { on: false } })).json(), { error: "config_unwritable" });
  assert.equal((await app.inject({ method: "GET", url: "/api/options", headers })).json().vscodeArchive, true, "a file that cannot be written changes nothing");
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

test("request logs hide the token of a file ticket", async () => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      lines.push(String(chunk));
      done();
    },
  });
  const { app } = await setup({ stream });
  const token = "Zk3v9QxY2b7LmN4pR8sT1uW6yA0cE5gH-iJ_oKqMnBd";
  assert.equal((await app.inject({ method: "GET", url: `/api/file-ticket/${token}?download=1` })).statusCode, 401);
  await app.inject({ method: "GET", url: "/api/me" });
  const log = lines.join("");
  assert.ok(lines.length >= 2);
  assert.ok(!log.includes(token), "the token is not logged");
  assert.match(log, /"url":"\/api\/file-ticket\/\[redacted\]\?download=1"/);
  assert.match(log, /"url":"\/api\/me"/);
  assert.equal(loggedUrl(`/api/file-ticket/${token}`), "/api/file-ticket/[redacted]");
  assert.equal(loggedUrl("/api/sessions/x/file/ticket"), "/api/sessions/x/file/ticket");
  await app.close();
});
