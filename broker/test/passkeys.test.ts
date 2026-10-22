import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { PasskeyError, Passkeys, passkeysWatch } from "../src/passkeys.ts";
import type { StoredLease } from "../src/store.ts";
import { WebAuthnError, passkeyOrigin, verifyAssertion, verifyRegistration } from "../src/webauthn.ts";
import { Authenticator, FLAGS, type Alg } from "./authenticator.ts";
import { tempDir } from "./helpers.ts";

const ORIGIN = "https://laptop.example.ts.net";
const RP = "laptop.example.ts.net";
const HOUR = 3600_000;
const lease = (o: Partial<StoredLease> = {}): StoredLease => ({ tokenHash: "aa", device: "phone", createdAt: 0, lastSeen: 0, ...o });
const where = { origin: ORIGIN, rpId: RP };
const fileOf = () => path.join(tempDir(), "passkeys.json");
const reason = (e: unknown) => (e instanceof WebAuthnError || e instanceof PasskeyError ? e.message : String(e));

function registered(keys: Passkeys, a = new Authenticator(), l = lease(), now = 1000) {
  const options = keys.registerOptions(l, where, "owner", now);
  return keys.register(l, a.create(options, ORIGIN), "phone", now);
}

test("passkeys are used from https pages on a host name, or http on localhost", () => {
  assert.deepEqual(passkeyOrigin("https://laptop.example.ts.net"), { origin: "https://laptop.example.ts.net", rpId: "laptop.example.ts.net" });
  assert.deepEqual(passkeyOrigin("https://laptop.example.ts.net:8443"), { origin: "https://laptop.example.ts.net:8443", rpId: "laptop.example.ts.net" });
  assert.deepEqual(passkeyOrigin("http://localhost:5173"), { origin: "http://localhost:5173", rpId: "localhost" });
  for (const bad of ["http://laptop.example.ts.net", "https://100.64.0.1", "https://[2001:db8::1]", "https://laptop", "ftp://laptop.example.ts.net", "nope", undefined]) {
    assert.equal(passkeyOrigin(bad), undefined, String(bad));
  }
});

for (const alg of [-7, -8, -257] as Alg[]) {
  test(`a ${alg} passkey registers and then signs a confirmation`, () => {
    const a = new Authenticator(alg);
    const challenge = Buffer.from("registration-challenge-0123456789");
    const made = verifyRegistration(a.create({ rp: { id: RP }, challenge: challenge.toString("base64url") }, ORIGIN), { challenge, origin: ORIGIN, rpId: RP });
    assert.equal(made.id, a.id.toString("base64url"));
    assert.equal(made.alg, alg);
    assert.equal(made.backedUp, true);
    assert.deepEqual(made.transports, ["internal", "hybrid"]);
    const c2 = Buffer.from("assertion-challenge-0123456789abcd");
    const used = verifyAssertion(a.get({ rpId: RP, challenge: c2.toString("base64url") }, ORIGIN), { challenge: c2, origin: ORIGIN, rpId: RP }, made);
    assert.deepEqual(used, { counter: 0, backedUp: true });
  });
}

test("a registration is refused for the wrong challenge, origin, relying party or type, without presence or verification, or with a key that does not match", () => {
  const a = new Authenticator();
  const challenge = Buffer.from("registration-challenge-0123456789");
  const options = { rp: { id: RP }, challenge: challenge.toString("base64url") };
  const expected = { challenge, origin: ORIGIN, rpId: RP };
  const refused = (body: unknown) => {
    try {
      verifyRegistration(body, expected);
      return "accepted";
    } catch (e) {
      return reason(e);
    }
  };
  assert.equal(refused(a.create(options, ORIGIN, { challenge: Buffer.from("other").toString("base64url") })), "challenge");
  assert.equal(refused(a.create(options, ORIGIN, { origin: "https://evil.example" })), "origin");
  assert.equal(refused(a.create(options, ORIGIN, { crossOrigin: true })), "origin");
  assert.equal(refused(a.create(options, ORIGIN, { rpId: "evil.example" })), "rp");
  assert.equal(refused(a.create(options, ORIGIN, { type: "webauthn.get" })), "type");
  assert.equal(refused(a.create(options, ORIGIN, { flags: FLAGS.UV | FLAGS.AT })), "presence");
  assert.equal(refused(a.create(options, ORIGIN, { flags: FLAGS.UP | FLAGS.AT })), "verification");
  assert.equal(refused(a.create(options, ORIGIN, { flags: FLAGS.UP | FLAGS.UV })), "malformed");
  assert.equal(refused(a.create(options, ORIGIN, { id: Buffer.from("another-credential") })), "credential");
  assert.equal(refused(a.create(options, ORIGIN, { alg: -8 })), "key");
  assert.equal(refused(a.create(options, ORIGIN, { alg: -35 })), "key");
  assert.equal(refused(a.create(options, ORIGIN, { spki: Buffer.from("not a key") })), "key");
  assert.equal(refused(new Authenticator(-257, { rsaBits: 1024 }).create(options, ORIGIN)), "key");
  assert.equal(refused({ id: "!", response: {} }), "malformed");
  assert.equal(refused(null), "malformed");
});

test("a confirmation is refused when its signature, challenge or relying party does not hold, or its counter goes back", () => {
  const a = new Authenticator(-7, { counter: 5 });
  const challenge = Buffer.from("registration-challenge-0123456789");
  const made = verifyRegistration(a.create({ rp: { id: RP }, challenge: challenge.toString("base64url") }, ORIGIN), { challenge, origin: ORIGIN, rpId: RP });
  assert.equal(made.counter, 5);
  const c2 = Buffer.from("assertion-challenge-0123456789abcd");
  const options = { rpId: RP, challenge: c2.toString("base64url") };
  const expected = { challenge: c2, origin: ORIGIN, rpId: RP };
  const refused = (body: unknown, stored = made) => {
    try {
      verifyAssertion(body, expected, stored);
      return "accepted";
    } catch (e) {
      return reason(e);
    }
  };
  assert.equal(refused(a.get(options, ORIGIN)), "accepted");
  const good = a.get(options, ORIGIN) as { response: Record<string, string> };
  const data = Buffer.from(good.response.authenticatorData, "base64url");
  data[36] ^= 1;
  assert.equal(refused({ ...good, response: { ...good.response, authenticatorData: data.toString("base64url") } }), "signature");
  assert.equal(refused(a.get(options, ORIGIN, { rpId: "evil.example" })), "rp");
  assert.equal(refused(a.get(options, ORIGIN, { challenge: Buffer.from("x").toString("base64url") })), "challenge");
  assert.equal(refused(a.get(options, ORIGIN, { flags: FLAGS.UP })), "verification");
  assert.equal(refused(a.get(options, ORIGIN, { counter: 5 })), "counter");
  assert.equal(refused(a.get(options, ORIGIN), { ...made, publicKey: new Authenticator().spki().toString("base64url") }), "signature");
  const none = new Authenticator(-8);
  const kept = verifyRegistration(none.create({ rp: { id: RP }, challenge: challenge.toString("base64url") }, ORIGIN), { challenge, origin: ORIGIN, rpId: RP });
  assert.equal(refused(none.get(options, ORIGIN), kept), "accepted", "a passkey without a counter keeps 0");
});

test("a challenge is good once, for the login it was made for, until it expires", () => {
  const keys = new Passkeys(fileOf());
  const a = new Authenticator();
  const p = registered(keys, a);
  assert.equal(p.rpId, RP);
  const replay = () => keys.register(lease(), a.create({ rp: { id: RP }, challenge: "AAAA" }, ORIGIN), "phone");
  assert.throws(replay, /challenge_expired/);
  const options = keys.verifyOptions(lease(), where, 1000);
  assert.throws(() => keys.verify(lease({ tokenHash: "bb" }), a.get(options, ORIGIN), 1000), /challenge_expired/, "another login");
  const late = keys.verifyOptions(lease(), where, 1000);
  assert.throws(() => keys.verify(lease(), a.get(late, ORIGIN), 1000 + 6 * 60_000), /challenge_expired/, "after five minutes");
  const fresh = keys.verifyOptions(lease(), where, 2000);
  const used = keys.verify(lease(), a.get(fresh, ORIGIN), 3000);
  assert.equal(used.lastUsedAt, 3000);
  assert.throws(() => keys.verify(lease(), a.get(fresh, ORIGIN), 3000), /challenge_expired/, "the same challenge again");
});

test("register options exclude the passkeys already made here and keep one user handle; the confirmation lists only this host's", () => {
  const file = fileOf();
  const keys = new Passkeys(file);
  const first = registered(keys);
  const options = keys.registerOptions(lease(), where, "owner", 5000) as { user: { id: string; name: string }; excludeCredentials: { id: string }[]; authenticatorSelection: Record<string, string> };
  assert.deepEqual(
    options.excludeCredentials.map((c) => c.id),
    [first.id],
  );
  assert.equal(options.user.name, "owner");
  assert.equal(options.authenticatorSelection.userVerification, "required");
  const user = (JSON.parse(fs.readFileSync(file, "utf8")) as { user: string }).user;
  assert.equal(options.user.id, user);
  assert.throws(() => keys.verifyOptions(lease(), { origin: "https://other.example.ts.net", rpId: "other.example.ts.net" }), /none_here/);
  assert.equal(keys.reset(), 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { user, passkeys: [] }, "the user handle stays");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("a login waits for a passkey once one is registered: when it starts and after the hours, never on this machine", () => {
  const keys = new Passkeys(fileOf(), 18);
  const now = 100 * HOUR;
  assert.equal(keys.due(lease(), "phone", now), false, "no passkey yet");
  registered(keys);
  assert.deepEqual([keys.hasOwn("phone"), keys.hasOwn("tablet")], [true, false]);
  assert.equal(keys.due(undefined, "phone", now), false, "no login");
  assert.equal(keys.due(lease(), "phone", now), true, "a login no passkey confirmed");
  assert.equal(keys.due(lease(), "local", now), false, "this machine");
  assert.equal(keys.due(lease({ verifiedAt: now - 17 * HOUR }), "phone", now), false);
  assert.equal(keys.due(lease({ verifiedAt: now - 18 * HOUR }), "phone", now), true);
  assert.equal(keys.due(lease({ verifiedAt: now + 2 * HOUR }), "phone", now), true, "a confirmation from the future");
  keys.setHours(1);
  assert.equal(keys.due(lease({ verifiedAt: now - 2 * HOUR }), "phone", now), true);
  assert.equal(keys.dueAt(lease({ verifiedAt: now })), now + HOUR);
});

test("a passkeys file that cannot be read keeps asking, and reset empties it", () => {
  const file = fileOf();
  fs.writeFileSync(file, "{ not json");
  const keys = new Passkeys(file);
  assert.equal(keys.any(), true);
  assert.equal(keys.due(lease(), "phone"), true);
  assert.equal(keys.hasOwn("tablet"), true, "no device registers in place of confirming");
  assert.throws(() => keys.verifyOptions(lease(), where), /unreadable/);
  assert.equal(keys.reset(), undefined);
  assert.deepEqual(keys.list(), []);
  assert.equal(keys.due(lease(), "phone"), false);
});

test("the file is read again when another process changes it, and a passkey can be found by the start of its id and removed", async () => {
  const file = fileOf();
  const keys = new Passkeys(file);
  const p = registered(keys);
  const other = new Passkeys(file);
  assert.equal(other.find(p.id.slice(0, 6))?.id, p.id);
  assert.equal(other.find(""), undefined);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(other.remove(p.id), true);
  assert.equal(other.remove(p.id), false);
  assert.deepEqual(keys.list(), []);
});

test("the watch tells when a first passkey comes or the last one goes, also by another process", async () => {
  const file = fileOf();
  const keys = new Passkeys(file);
  const look = passkeysWatch(keys);
  assert.equal(look(), false);
  const first = registered(keys);
  assert.equal(look(), true, "the first passkey");
  assert.equal(look(), false);
  registered(keys);
  assert.equal(look(), false, "a second one");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(new Passkeys(file).remove(first.id), true);
  assert.equal(look(), false, "one of two removed, as `ccrc passkey remove`");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(new Passkeys(file).reset(), 1);
  assert.equal(look(), true, "the last one gone, as `ccrc passkey reset`");
  assert.equal(look(), false);
});

test("at most ten passkeys are kept", () => {
  const keys = new Passkeys(fileOf());
  for (let i = 0; i < 10; i++) registered(keys);
  assert.throws(() => keys.registerOptions(lease(), where, "owner"), /too_many/);
});
