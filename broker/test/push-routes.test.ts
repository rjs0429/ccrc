import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { Audit } from "../src/audit.ts";
import { Push } from "../src/push/index.ts";
import { DEFAULT_PREFS } from "../src/push/types.ts";
import { registerPush } from "../src/routes/push.ts";
import type { RouteDeps } from "../src/routes/types.ts";
import { tempDir } from "./helpers.ts";
import { newBrowser } from "./push-browser.ts";

const APPLE = "https://web.push.apple.com/QGuQyavXutnMHTEoWSwlHyGUyzlLkqPA";
const AUTHED = { cookie: "ccrc=ok" };

async function setup() {
  const dir = tempDir();
  const push = new Push(dir, { log: () => {} });
  const audited: { event: string; detail: Record<string, unknown> }[] = [];
  const audit = { log: (event: string, detail: Record<string, unknown> = {}) => audited.push({ event, detail }) } as unknown as Audit;
  const app = Fastify();
  app.decorateRequest("device", "");
  app.addHook("onRequest", async (req) => {
    req.device = "phone";
  });
  await registerPush(app, {
    push,
    audit,
    requireAuth: async (req: FastifyRequest, reply: FastifyReply) => {
      if (req.headers.cookie !== AUTHED.cookie) return reply.code(401).send({ error: "unauthorized" });
    },
  } as unknown as RouteDeps);
  const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => app.inject({ method: "POST", url, payload: payload as object, headers: { ...AUTHED, ...headers } });
  return { app, push, audited, post, file: path.join(dir, "push.json") };
}

test("push routes need a login", async () => {
  const { app } = await setup();
  for (const [method, url] of [["GET", "/api/push/key"], ["GET", "/api/push/status?endpoint=x"], ["GET", "/api/push/badge?endpoint=x"], ["GET", "/api/push/recent?endpoint=x"], ["POST", "/api/push/subscribe"], ["POST", "/api/push/test"]] as const) {
    assert.equal((await app.inject({ method, url, payload: method === "POST" ? {} : undefined })).statusCode, 401, url);
  }
});

test("the key is the broker's P-256 public key", async () => {
  const { app, push } = await setup();
  const res = await app.inject({ method: "GET", url: "/api/push/key", headers: AUTHED });
  assert.equal(res.json().key, push.publicKey());
  assert.equal(Buffer.from(res.json().key, "base64url").length, 65);
});

test("a subscription is checked before it is kept", async () => {
  const { post, audited } = await setup();
  const keys = newBrowser().keys;
  const bad: [unknown, string][] = [
    [{ endpoint: "http://web.push.apple.com/x", keys }, "unsupported_push_service"],
    [{ endpoint: "https://push.example.net/x", keys }, "unsupported_push_service"],
    [{ endpoint: "https://web.push.apple.com:8443/x", keys }, "unsupported_push_service"],
    [{ endpoint: "https://user@web.push.apple.com/x", keys }, "unsupported_push_service"],
    [{ endpoint: "https://web.push.apple.com.example.net/x", keys }, "unsupported_push_service"],
    [{ endpoint: `${APPLE}/${"x".repeat(2048)}`, keys }, "invalid_endpoint"],
    [{ endpoint: 42, keys }, "invalid_endpoint"],
    [{ endpoint: APPLE, keys: { ...keys, auth: Buffer.alloc(15).toString("base64url") } }, "invalid_subscription"],
    [{ endpoint: APPLE, keys: { ...keys, p256dh: Buffer.alloc(64, 4).toString("base64url") } }, "invalid_subscription"],
    [{ endpoint: APPLE, keys: { ...keys, p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString("base64url") } }, "invalid_subscription"],
    [{ endpoint: APPLE, keys: { ...keys, p256dh: `${keys.p256dh}!` } }, "invalid_subscription"],
    [{ endpoint: APPLE }, "invalid_subscription"],
    ["nonsense", "invalid_endpoint"],
  ];
  for (const [subscription, error] of bad) {
    const res = await post("/api/push/subscribe", { subscription });
    assert.equal(res.statusCode, 400, JSON.stringify(subscription).slice(0, 80));
    assert.equal(res.json().error, error, JSON.stringify(subscription).slice(0, 80));
  }
  for (const prefs of [{ vscodeDelaySec: 45 }, { vscodeDelaySec: "30" }, { turnEnd: "sometimes" }, { turnEnd: true }, { turnDone: "yes" }, [true]]) {
    const res = await post("/api/push/subscribe", { subscription: { endpoint: APPLE, keys }, prefs });
    assert.equal(res.json().error, "invalid_prefs", JSON.stringify(prefs));
  }
  assert.deepEqual(audited, []);
});

test("subscribing keeps the device, the page's https origin and the settings", async () => {
  const { post, audited, file } = await setup();
  const keys = newBrowser().keys;
  const res = await post("/api/push/subscribe", { subscription: { endpoint: APPLE, expirationTime: null, keys }, prefs: { details: true } }, { origin: "https://laptop.example.ts.net" });
  assert.equal(res.statusCode, 200);
  const status = res.json();
  assert.equal(status.subscribed, true);
  assert.equal(status.device, "phone");
  assert.deepEqual(status.prefs, { ...DEFAULT_PREFS, details: true });
  assert.deepEqual(audited, [{ event: "push_subscribe", detail: { device: "phone", service: "web.push.apple.com", prefs: status.prefs } }]);
  const saved = JSON.parse(fs.readFileSync(file, "utf8")).subscriptions;
  assert.deepEqual(saved, [{ endpoint: APPLE, keys, device: "phone", origin: "https://laptop.example.ts.net", createdAt: status.createdAt, prefs: status.prefs }]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const again = await post("/api/push/subscribe", { subscription: { endpoint: APPLE, keys } }, { origin: "http://localhost:5173" });
  assert.equal(again.json().createdAt, status.createdAt);
  assert.deepEqual(again.json().prefs, status.prefs, "settings stay when the browser subscribes again");
  const resaved = JSON.parse(fs.readFileSync(file, "utf8")).subscriptions;
  assert.equal(resaved.length, 1);
  assert.equal("origin" in resaved[0], false, "only an https origin is a contact");
});

test("settings, status and unsubscribing work on this device's endpoint", async () => {
  const { app, post, audited } = await setup();
  const endpoint = APPLE;
  await post("/api/push/subscribe", { subscription: { endpoint, keys: newBrowser().keys } });
  const prefs = await post("/api/push/prefs", { endpoint, prefs: { vscodeDelaySec: 120, turnEnd: "all", extra: 1 } });
  assert.deepEqual(prefs.json(), { prefs: { vscodeDelaySec: 120, turnEnd: "all", details: false, claude: true, lang: "ko" } });
  assert.equal(audited.at(-1)?.event, "push_subscribe");
  const status = await app.inject({ method: "GET", url: `/api/push/status?endpoint=${encodeURIComponent(endpoint)}`, headers: AUTHED });
  assert.deepEqual(status.json().prefs, prefs.json().prefs);

  assert.deepEqual((await post("/api/push/unsubscribe", { endpoint })).json(), { ok: true });
  assert.deepEqual(audited.at(-1), { event: "push_unsubscribe", detail: { device: "phone", service: "web.push.apple.com", subscribedFrom: "phone" } });
  const gone = await app.inject({ method: "GET", url: `/api/push/status?endpoint=${encodeURIComponent(endpoint)}`, headers: AUTHED });
  assert.deepEqual(gone.json(), { subscribed: false });

  assert.equal((await post("/api/push/prefs", { endpoint, prefs: { details: true } })).statusCode, 404);
  assert.equal((await post("/api/push/test", { endpoint })).json().error, "not_subscribed");
  assert.equal((await post("/api/push/unsubscribe", { endpoint })).statusCode, 200);
  assert.equal((await post("/api/push/unsubscribe", { endpoint: ["x"] })).json().error, "invalid_endpoint");
  assert.equal(audited.length, 3, "nothing is logged for what did not change");
});

test("the notifications Claude sends are on by default and switch off and on", async () => {
  const { post } = await setup();
  const endpoint = APPLE;
  await post("/api/push/subscribe", { subscription: { endpoint, keys: newBrowser().keys } });
  assert.deepEqual((await post("/api/push/prefs", { endpoint, prefs: { claude: false } })).json().prefs, { ...DEFAULT_PREFS, claude: false });
  assert.equal((await post("/api/push/prefs", { endpoint, prefs: { claude: "no" } })).statusCode, 400);
  assert.deepEqual((await post("/api/push/prefs", { endpoint, prefs: { claude: true } })).json().prefs, DEFAULT_PREFS);
});

test("a screen from before the turn-end choice still switches it with turnDone", async () => {
  const { post } = await setup();
  await post("/api/push/subscribe", { subscription: { endpoint: APPLE, keys: newBrowser().keys } });
  assert.deepEqual((await post("/api/push/prefs", { endpoint: APPLE, prefs: { turnDone: false } })).json().prefs, { ...DEFAULT_PREFS, turnEnd: "off" });
  assert.deepEqual((await post("/api/push/prefs", { endpoint: APPLE, prefs: { turnDone: true } })).json().prefs, { ...DEFAULT_PREFS, turnEnd: "remote" });
  assert.deepEqual((await post("/api/push/prefs", { endpoint: APPLE, prefs: { turnEnd: "all", turnDone: false } })).json().prefs.turnEnd, "all", "the new field wins");
});

test("settings saved before the turn-end choice load as its values and are saved in the new shape", async () => {
  const dir = tempDir();
  const keys = newBrowser().keys;
  const sub = (n: number, prefs: Record<string, unknown>) => ({ endpoint: `${APPLE}${n}`, keys, device: "phone", createdAt: n, prefs });
  fs.writeFileSync(
    path.join(dir, "push.json"),
    JSON.stringify({ subscriptions: [sub(1, { vscodeDelaySec: 0, turnDone: true, details: true }), sub(2, { vscodeDelaySec: 120, turnDone: false, details: false }), sub(3, {})] }),
  );
  const push = new Push(dir, { log: () => {} });
  assert.deepEqual(push.status(`${APPLE}1`).prefs, { vscodeDelaySec: 0, turnEnd: "remote", details: true, claude: true, lang: "ko" });
  assert.deepEqual(push.status(`${APPLE}2`).prefs, { vscodeDelaySec: 120, turnEnd: "off", details: false, claude: true, lang: "ko" });
  assert.deepEqual(push.status(`${APPLE}3`).prefs, DEFAULT_PREFS);
  push.setPrefs(`${APPLE}3`, { details: true });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "push.json"), "utf8")).subscriptions;
  assert.deepEqual(
    saved.map((s: { prefs: unknown }) => s.prefs),
    [
      { vscodeDelaySec: 0, turnEnd: "remote", details: true, claude: true, lang: "ko" },
      { vscodeDelaySec: 120, turnEnd: "off", details: false, claude: true, lang: "ko" },
      { ...DEFAULT_PREFS, details: true },
    ],
  );
});

test("a device names its language when it subscribes and when it changes; one saved before languages is written to in Korean", async () => {
  const { post } = await setup();
  const keys = newBrowser().keys;
  const on = await post("/api/push/subscribe", { subscription: { endpoint: APPLE, keys }, prefs: { lang: "en" } });
  assert.equal(on.json().prefs.lang, "en");
  assert.equal((await post("/api/push/prefs", { endpoint: APPLE, prefs: { lang: "ko" } })).json().prefs.lang, "ko");
  for (const bad of ["fr", "EN", 1, null]) assert.equal((await post("/api/push/prefs", { endpoint: APPLE, prefs: { lang: bad } })).json().error, "invalid_prefs", String(bad));
  assert.equal((await post("/api/push/subscribe", { subscription: { endpoint: APPLE, keys }, prefs: { lang: "de" } })).statusCode, 400);

  const dir = tempDir();
  const sub = (n: number, prefs: Record<string, unknown>) => ({ endpoint: `${APPLE}${n}`, keys, device: "phone", createdAt: n, prefs });
  fs.writeFileSync(path.join(dir, "push.json"), JSON.stringify({ subscriptions: [sub(1, { claude: false }), sub(2, { lang: "en" }), sub(3, { lang: "xx" })] }));
  const push = new Push(dir, { log: () => {} });
  assert.deepEqual([1, 2, 3].map((n) => push.status(`${APPLE}${n}`).prefs?.lang), ["ko", "en", "ko"]);
});

test("the badge is asked for by endpoint; an unknown one counts nothing", async () => {
  const { app, post } = await setup();
  const get = async (endpoint: string) => {
    const { at, ...rest } = (await app.inject({ method: "GET", url: `/api/push/badge?endpoint=${encodeURIComponent(endpoint)}`, headers: AUTHED })).json();
    assert.ok(Math.abs(at - Date.now()) < 5000, "the broker's time of the count");
    return rest;
  };
  assert.deepEqual(await get(APPLE), { subscribed: false, badge: 0, unseen: [], waiting: [] });
  await post("/api/push/subscribe", { subscription: { endpoint: APPLE, keys: newBrowser().keys } });
  assert.deepEqual(await get(APPLE), { subscribed: true, badge: 0, unseen: [], waiting: [] });
  const bad = await app.inject({ method: "GET", url: "/api/push/badge", headers: AUTHED });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, "invalid_endpoint");
});

test("the request a device was told of lately is asked for by its endpoint", async () => {
  const { app, post } = await setup();
  const get = (endpoint: string) => app.inject({ method: "GET", url: `/api/push/recent?endpoint=${encodeURIComponent(endpoint)}`, headers: AUTHED });
  const unknown = await get(APPLE);
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json().error, "not_subscribed");
  await post("/api/push/subscribe", { subscription: { endpoint: APPLE, keys: newBrowser().keys } });
  assert.deepEqual((await get(APPLE)).json(), {});
  assert.equal((await app.inject({ method: "GET", url: "/api/push/recent", headers: AUTHED })).json().error, "invalid_endpoint");
});
