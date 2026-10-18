import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Audit } from "../src/audit.ts";
import { setCredentials } from "../src/auth.ts";
import { DeviceGate } from "../src/devices.ts";
import { Doctor } from "../src/doctor.ts";
import type { Hub } from "../src/hub.ts";
import { Leases } from "../src/lease.ts";
import { Passkeys } from "../src/passkeys.ts";
import { Push } from "../src/push/index.ts";
import { buildServer } from "../src/server.ts";
import type { SessionManager } from "../src/sessions/manager.ts";
import { Uploads } from "../src/uploads.ts";
import { Authenticator } from "./authenticator.ts";
import { tempDir, tempStore } from "./helpers.ts";

const HOST = "laptop.example.ts.net";
const ORIGIN = `https://${HOST}`;
const PHONE = { host: HOST, origin: ORIGIN, "x-forwarded-for": "100.64.0.2" };
const LOCAL = { origin: "http://localhost:80" };
const PASSWORD = "correct horse battery";
const status = async () => ({ Peer: { a: { DNSName: "phone.example.ts.net.", TailscaleIPs: ["100.64.0.2"] } } });

async function setup() {
  const store = tempStore();
  const leases = new Leases(store, 60 * 24);
  const dir = tempDir();
  const passkeys = new Passkeys(path.join(dir, "passkeys.json"), 18);
  const auditFile = path.join(dir, "audit.jsonl");
  const manager = { list: async () => [], folders: async () => [], modelList: async () => [], brokerSessions: () => ({ mode: "off", ready: false }) } as unknown as SessionManager;
  const app = await buildServer({
    store,
    leases,
    gate: new DeviceGate(["phone"], true, status),
    audit: new Audit(auditFile),
    manager,
    hub: { attach() {} } as unknown as Hub,
    uploads: new Uploads(tempDir()),
    push: new Push(tempDir()),
    doctor: new Doctor(),
    webDir: tempDir(),
    logLevel: "silent",
    passkeys,
  });
  await setCredentials(store, "owner", PASSWORD);
  const audits = () =>
    fs.existsSync(auditFile)
      ? fs
          .readFileSync(auditFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  return { app, store, leases, passkeys, audits };
}

const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers["set-cookie"] ?? "").split(";")[0];

async function login(app: Awaited<ReturnType<typeof setup>>["app"], headers: Record<string, string> = PHONE) {
  const res = await app.inject({ method: "POST", url: "/api/login", headers, payload: { id: "owner", password: PASSWORD, takeover: true } });
  assert.equal(res.statusCode, 200);
  return { cookie: cookieOf(res), body: res.json() as Record<string, unknown> };
}

test("a phone registers a passkey with its password, after which every login of the phone waits for one", async () => {
  const t = await setup();
  const first = await login(t.app);
  assert.equal(first.body.passkey, undefined, "no passkey yet");
  const h = { ...PHONE, cookie: first.cookie };
  const list = await t.app.inject({ method: "GET", url: "/api/passkeys", headers: h });
  assert.deepEqual(list.json(), { passkeys: [], hours: 18, local: false });

  const wrong = await t.app.inject({ method: "POST", url: "/api/passkeys/register/options", headers: h, payload: { password: "nope" } });
  assert.equal(wrong.statusCode, 403);
  assert.equal(wrong.json().error, "wrong_password");
  const opts = await t.app.inject({ method: "POST", url: "/api/passkeys/register/options", headers: h, payload: { password: PASSWORD } });
  assert.equal(opts.statusCode, 200);
  const options = opts.json().options as Record<string, unknown>;
  assert.deepEqual(options.rp, { name: "ccrc", id: HOST });
  const a = new Authenticator();
  const made = await t.app.inject({ method: "POST", url: "/api/passkeys/register", headers: h, payload: { credential: a.create(options, ORIGIN) } });
  assert.equal(made.statusCode, 200);
  assert.equal(made.json().passkey.here, true);
  assert.equal((await t.app.inject({ method: "GET", url: "/api/sessions", headers: h })).statusCode, 200, "registering confirms the login");

  const second = await login(t.app);
  assert.equal(second.body.passkey, "due");
  const h2 = { ...PHONE, cookie: second.cookie };
  const denied = await t.app.inject({ method: "GET", url: "/api/sessions", headers: h2 });
  assert.deepEqual([denied.statusCode, denied.json().error], [401, "passkey_required"]);
  assert.deepEqual((await t.app.inject({ method: "GET", url: "/api/me", headers: h2 })).json(), { configured: true, loggedIn: true, device: "phone", passkey: "due" });
  assert.equal((await t.app.inject({ method: "POST", url: "/api/passkeys/register/options", headers: h2, payload: { password: PASSWORD } })).statusCode, 401, "no new passkey before this one confirms");

  const vo = await t.app.inject({ method: "POST", url: "/api/passkeys/verify/options", headers: h2, payload: {} });
  assert.equal(vo.statusCode, 200);
  const bad = await t.app.inject({ method: "POST", url: "/api/passkeys/verify", headers: h2, payload: { credential: new Authenticator().get(vo.json().options, ORIGIN, { id: a.id }) } });
  assert.deepEqual([bad.statusCode, bad.json().error], [400, "passkey_invalid"]);
  const vo2 = await t.app.inject({ method: "POST", url: "/api/passkeys/verify/options", headers: h2, payload: {} });
  const ok = await t.app.inject({ method: "POST", url: "/api/passkeys/verify", headers: h2, payload: { credential: a.get(vo2.json().options, ORIGIN) } });
  assert.equal(ok.statusCode, 200);
  assert.equal((await t.app.inject({ method: "GET", url: "/api/sessions", headers: h2 })).statusCode, 200);
  assert.deepEqual((await t.app.inject({ method: "GET", url: "/api/me", headers: h2 })).json(), { configured: true, loggedIn: true, device: "phone" });

  t.leases.current()!.verifiedAt = Date.now() - 19 * 3600_000;
  assert.equal((await t.app.inject({ method: "GET", url: "/api/sessions", headers: h2 })).statusCode, 401, "18 hours later");
  assert.equal((await t.app.inject({ method: "POST", url: "/api/logout", headers: h2 })).statusCode, 200, "logging out needs no passkey");
  assert.equal(t.leases.current(), undefined);

  const wanted = ["passkey_registered", "passkey_failed", "passkey_verified", "login_failed"];
  for (let i = 0; i < 100 && !wanted.every((e) => t.audits().some((a) => a.event === e)); i++) await new Promise((r) => setTimeout(r, 20));
  const events = t.audits().map((e) => e.event);
  for (const e of wanted) assert.ok(events.includes(e), e);
  assert.ok(!JSON.stringify(t.audits()).includes(PASSWORD));
});

test("this machine is never asked for a passkey and does not register one", async () => {
  const t = await setup();
  const phone = await login(t.app);
  const options = (await t.app.inject({ method: "POST", url: "/api/passkeys/register/options", headers: { ...PHONE, cookie: phone.cookie }, payload: { password: PASSWORD } })).json().options;
  await t.app.inject({ method: "POST", url: "/api/passkeys/register", headers: { ...PHONE, cookie: phone.cookie }, payload: { credential: new Authenticator().create(options, ORIGIN) } });
  const local = await login(t.app, LOCAL);
  assert.equal(local.body.passkey, undefined);
  assert.equal((await t.app.inject({ method: "GET", url: "/api/sessions", headers: { cookie: local.cookie } })).statusCode, 200);
  const list = (await t.app.inject({ method: "GET", url: "/api/passkeys", headers: { cookie: local.cookie } })).json();
  assert.equal(list.local, true);
  assert.equal(list.passkeys[0].here, false);
  const refused = await t.app.inject({ method: "POST", url: "/api/passkeys/register/options", headers: { ...LOCAL, cookie: local.cookie }, payload: { password: PASSWORD } });
  assert.deepEqual([refused.statusCode, refused.json().error], [400, "local"]);
});

test("removing a passkey asks for the password; with none left the phone is not asked again", async () => {
  const t = await setup();
  const { cookie } = await login(t.app);
  const h = { ...PHONE, cookie };
  const options = (await t.app.inject({ method: "POST", url: "/api/passkeys/register/options", headers: h, payload: { password: PASSWORD } })).json().options;
  const made = (await t.app.inject({ method: "POST", url: "/api/passkeys/register", headers: h, payload: { credential: new Authenticator().create(options, ORIGIN) } })).json().passkey;
  assert.equal((await t.app.inject({ method: "POST", url: "/api/passkeys/remove", headers: h, payload: { id: made.id, password: "nope" } })).statusCode, 403);
  assert.equal((await t.app.inject({ method: "POST", url: "/api/passkeys/remove", headers: h, payload: { id: "unknown", password: PASSWORD } })).statusCode, 404);
  assert.equal((await t.app.inject({ method: "POST", url: "/api/passkeys/remove", headers: h, payload: { id: made.id, password: PASSWORD } })).statusCode, 200);
  assert.equal((await login(t.app)).body.passkey, undefined);
});

test("a page over plain http on a tailnet name cannot register a passkey", async () => {
  const t = await setup();
  const headers = { ...PHONE, origin: `http://${HOST}` };
  const { cookie } = await login(t.app, headers);
  const res = await t.app.inject({ method: "POST", url: "/api/passkeys/register/options", headers: { ...headers, cookie }, payload: { password: PASSWORD } });
  assert.deepEqual([res.statusCode, res.json().error], [400, "insecure_origin"]);
});
