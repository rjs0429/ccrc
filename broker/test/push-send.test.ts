import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, test } from "node:test";
import type { Hub } from "../src/hub.ts";
import type { ServerMsg } from "../src/protocol.ts";
import { Push, PushError } from "../src/push/index.ts";
import { REUSE_MS, VapidTokens, generateVapidKeys } from "../src/push/vapid.ts";
import type { SessionManager } from "../src/sessions/manager.ts";
import { tempDir } from "./helpers.ts";
import { decrypt, newBrowser, readVapid } from "./push-browser.ts";

const A = "11111111-2222-4333-8444-555555555555";
const APP = "https://laptop.example.ts.net";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(done: () => boolean, label: string, ms = 3000): Promise<void> {
  for (const end = Date.now() + ms; !done(); await sleep(5)) if (Date.now() > end) throw Error(`timed out waiting for ${label}`);
}

interface Received {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

// A push service on this machine. It answers with the given statuses in turn, then 201.
async function pushService(answers: number[] = []) {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push({ url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(answers.shift() ?? 201).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received };
}

function setup(dir = tempDir(), retryMs = 30) {
  const logs: string[] = [];
  const push = new Push(dir, {
    allow: (url) => url.hostname === "127.0.0.1",
    timing: { ownedMs: 5, retryMs },
    log: (line) => logs.push(line),
  });
  after(() => push.close());
  return { push, logs, dir };
}

test("a notification reaches the push service encrypted for the subscription and signed for the service", async () => {
  const service = await pushService();
  const { push, logs } = setup();
  const browser = newBrowser();
  const endpoint = `${service.origin}/push/device-1`;
  push.subscribe({ endpoint, keys: browser.keys }, undefined, { device: "phone", origin: APP });
  await push.test(endpoint);

  assert.equal(service.received.length, 1);
  const r = service.received[0];
  assert.equal(r.url, "/push/device-1");
  assert.equal(r.headers["content-encoding"], "aes128gcm");
  assert.equal(r.headers.ttl, "3600");
  assert.equal(r.headers.urgency, "normal");
  const vapid = readVapid(String(r.headers.authorization));
  assert.equal(vapid.valid, true);
  assert.equal(vapid.key, push.publicKey());
  assert.equal(vapid.claims.aud, service.origin);
  assert.equal(vapid.claims.sub, APP);
  assert.ok((vapid.claims.exp as number) <= Date.now() / 1000 + 24 * 3600);
  assert.deepEqual(JSON.parse(decrypt(r.body, browser.privateKey, browser.auth).toString()), {
    title: "ccrc",
    body: "테스트 알림입니다",
    tag: "test",
    data: { url: "/#/settings/alerts" },
  });
  assert.equal(push.status(endpoint).lastSent !== undefined, true);
  assert.deepEqual(logs, []);
});

test("a request on a session nobody watches goes out with high urgency", async () => {
  const service = await pushService();
  const { push } = setup();
  const browser = newBrowser();
  const endpoint = `${service.origin}/push/device-2`;
  push.subscribe({ endpoint, keys: browser.keys }, { details: true }, { device: "phone", origin: "http://localhost:5173" });
  const manager = Object.assign(new EventEmitter(), {
    list: async () => [{ id: A, title: "Ship the release", cwd: "/home/u/app", lastModified: 0, state: "owned" }],
    waitingSessions: () => [A],
    unreadSessions: () => [],
    setClaudePush: () => {},
  });
  push.watch(manager as unknown as SessionManager, { isWatching: () => false, remoteActivity: () => undefined } as unknown as Hub);
  manager.emit("event", A, {
    t: "pending_add",
    sessionId: A,
    request: { id: "r1", kind: "permission", toolName: "Bash", input: { command: "rm -rf dist" }, allowAlways: false },
  } satisfies ServerMsg);
  await until(() => service.received.length > 0, "the notification");

  assert.equal(service.received.length, 1);
  const r = service.received[0];
  assert.equal(r.headers.urgency, "high");
  assert.equal("sub" in readVapid(String(r.headers.authorization)).claims, false, "an http page origin is not a contact");
  const payload = JSON.parse(decrypt(r.body, browser.privateKey, browser.auth).toString());
  assert.deepEqual(payload, { title: "Ship the release", body: "권한 요청 · Bash", tag: `${A}:permission`, data: { url: `/#/s/${A}` }, badge: 1 });
  assert.deepEqual(push.badge(endpoint), { subscribed: true, badge: 1, unseen: [] });
  assert.deepEqual(push.badge(`${service.origin}/push/unknown`), { subscribed: false, badge: 0, unseen: [] });
});

test("a subscription the push service no longer knows is removed", async () => {
  for (const gone of [404, 410]) {
    const service = await pushService([gone]);
    const { push, logs } = setup();
    const endpoint = `${service.origin}/push/old`;
    push.subscribe({ endpoint, keys: newBrowser().keys }, undefined, { device: "phone" });
    await assert.rejects(push.test(endpoint), (e: unknown) => e instanceof PushError && e.message === "push_failed" && e.status === gone);
    assert.deepEqual(push.status(endpoint), { subscribed: false });
    assert.equal(logs.length, 1);
    assert.match(logs[0], new RegExp(`^push: 127\\.0\\.0\\.1:\\d+ answered ${gone}$`));
  }
});

test("a busy push service gets one more try a little later, and only one", async () => {
  const service = await pushService([503, 201, 500, 500]);
  const { push, logs } = setup(tempDir(), 120);
  const endpoint = `${service.origin}/push/busy`;
  push.subscribe({ endpoint, keys: newBrowser().keys }, undefined, { device: "phone" });
  const manager = Object.assign(new EventEmitter(), { list: async () => [], waitingSessions: () => [A], unreadSessions: () => [], setClaudePush: () => {} });
  push.watch(manager as unknown as SessionManager, { isWatching: () => false, remoteActivity: () => undefined } as unknown as Hub);
  const ask = (id: string) =>
    manager.emit("event", A, { t: "pending_add", sessionId: A, request: { id, kind: "question", toolName: "AskUserQuestion", input: {}, allowAlways: false } } satisfies ServerMsg);

  ask("r1");
  await until(() => service.received.length === 1, "the first try");
  await until(() => service.received.length === 2, "the retry");
  await until(() => push.status(endpoint).lastSent !== undefined, "the retry's answer");
  assert.equal(push.status(endpoint).lastError, undefined);

  ask("r2");
  await until(() => push.status(endpoint).lastError?.status === 500 && service.received.length === 4, "two failed tries");
  await sleep(300);
  assert.equal(service.received.length, 4, "the retry is not retried");
  assert.equal(push.status(endpoint).lastError?.status, 500);
  assert.equal(push.status(endpoint).subscribed, true);
  assert.ok(logs.every((l) => !l.includes("질문")), "logs carry no notification text");
});

test("an unreachable push service counts as a failed send", async () => {
  const { push } = setup();
  const endpoint = "http://127.0.0.1:1/push/none";
  push.subscribe({ endpoint, keys: newBrowser().keys }, undefined, { device: "local" });
  await assert.rejects(push.test(endpoint), (e: unknown) => e instanceof PushError && e.status === 0);
  assert.equal(push.status(endpoint).lastError?.status, 0);
});

test("a device counts as reachable by notification only through its own subscription whose last send worked", async () => {
  const service = await pushService([503]);
  const { push } = setup();
  const endpoint = `${service.origin}/push/phone`;
  push.subscribe({ endpoint, keys: newBrowser().keys }, undefined, { device: "phone" });
  assert.equal(push.reaches(undefined), false, "no signed-in device");
  assert.equal(push.reaches("old-laptop"), false, "another device's subscription");
  assert.equal(push.reaches("phone"), true);
  await assert.rejects(push.test(endpoint));
  assert.equal(push.reaches("phone"), false, "the last send failed");
  await push.test(endpoint);
  assert.equal(push.reaches("phone"), true, "a send worked again");
});

test("the key pair is made when first needed and kept with the subscriptions in a private file", async () => {
  const dir = tempDir();
  const file = path.join(dir, "push.json");
  const { push } = setup(dir);
  assert.deepEqual(push.status("https://web.push.apple.com/x"), { subscribed: false });
  assert.equal(fs.existsSync(file), false, "nothing is written before the key is needed");
  const first = push.publicKey();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(setup(dir).push.publicKey(), first);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.vapid.publicKey, first);
  assert.deepEqual(saved.subscriptions, []);
});

test("a signed token serves one push service, contact and key for six hours, then a new one is signed", () => {
  const tokens = new VapidTokens();
  const keys = generateVapidKeys();
  const apple = "https://web.push.apple.com/device-1";
  const t0 = Date.UTC(2026, 9, 16, 0, 0, 0);
  const first = tokens.header(apple, keys, APP, t0);
  assert.equal(first.reused, false);
  const again = tokens.header("https://web.push.apple.com/device-2", keys, APP, t0 + REUSE_MS - 1);
  assert.deepEqual(again, { value: first.value, reused: true }, "every subscription at the same origin shares it");
  const claims = readVapid(again.value).claims;
  assert.ok((claims.exp as number) * 1000 - (t0 + REUSE_MS) >= 5 * 3600_000, "a reused token still has hours left");
  assert.ok((claims.exp as number) <= t0 / 1000 + 24 * 3600);
  assert.equal(tokens.header(apple, keys, APP, t0 + REUSE_MS).reused, false, "six hours on");
  const later = tokens.header(apple, keys, APP, t0 + REUSE_MS);
  assert.equal(tokens.header(apple, keys, APP, t0 + REUSE_MS - 3600_000).reused, false, "a clock that went back");
  assert.notEqual(tokens.header("https://fcm.googleapis.com/fcm/send/x", keys, APP, t0 + REUSE_MS).value, later.value, "another push service");
  assert.equal(tokens.header(apple, keys, "https://other.example.ts.net", t0 + REUSE_MS).reused, false, "another contact");
  assert.equal(tokens.header(apple, generateVapidKeys(), APP, t0 + REUSE_MS).reused, false, "another key");
  tokens.header(apple, keys, APP, t0 + REUSE_MS);
  tokens.forget("https://web.push.apple.com/anything");
  assert.equal(tokens.header(apple, keys, APP, t0 + REUSE_MS + 1).reused, false, "a refused token is not used again");
});

test("notifications to one push service share the token; one refused when reused goes again at once with a new token", async () => {
  const service = await pushService([201, 403]);
  const { push, logs } = setup();
  const endpoint = `${service.origin}/push/device-3`;
  push.subscribe({ endpoint, keys: newBrowser().keys }, undefined, { device: "phone", origin: APP });
  await push.test(endpoint);
  await push.test(endpoint);
  await push.test(endpoint);
  const auth = service.received.map((r) => String(r.headers.authorization));
  assert.equal(auth.length, 4);
  assert.equal(auth[1], auth[0], "the second send reuses the token");
  assert.notEqual(auth[2], auth[1], "the refused token is replaced at once");
  assert.equal(auth[3], auth[2], "and the new one is used from then on");
  assert.ok(auth.every((a) => readVapid(a).valid));
  assert.equal(push.status(endpoint).lastError, undefined);
  assert.deepEqual(logs, [`push: ${new URL(service.origin).host} answered 403 to a reused token; signing a new one`]);
});

test("a new token the push service refuses is not sent again", async () => {
  const service = await pushService([403]);
  const { push } = setup();
  const endpoint = `${service.origin}/push/device-4`;
  push.subscribe({ endpoint, keys: newBrowser().keys }, undefined, { device: "phone" });
  await assert.rejects(push.test(endpoint), (e: unknown) => e instanceof PushError && e.status === 403);
  assert.equal(service.received.length, 1);
  await push.test(endpoint);
  assert.notEqual(String(service.received[1].headers.authorization), String(service.received[0].headers.authorization), "the refused token is not kept");
});
