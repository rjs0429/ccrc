import assert from "node:assert/strict";
import { test } from "node:test";
import { encrypt, MAX_PLAINTEXT } from "../src/push/encrypt.ts";
import { generateVapidKeys, vapidAuthorization } from "../src/push/vapid.ts";
import { decrypt, newBrowser, readVapid } from "./push-browser.ts";

const b64 = (s: string) => Buffer.from(s.replace(/\s+/g, ""), "base64url");

// RFC 8291 section 5 and appendix A.
const RFC8291 = {
  plaintext: "When I grow up, I want to be a watermelon",
  senderPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  receiverPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  receiverPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  body: `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
         mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
         pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`,
  ciphertext: `8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs
               bI_0LpXMuGvnzQ`,
};

test("encryption reproduces the RFC 8291 example exactly", () => {
  const out = encrypt(
    Buffer.from(RFC8291.plaintext),
    { p256dh: RFC8291.receiverPublic, auth: RFC8291.auth },
    { salt: b64(RFC8291.salt), privateKey: b64(RFC8291.senderPrivate) },
  );
  assert.equal(out.length, 144);
  assert.deepEqual(out.subarray(86), b64(RFC8291.ciphertext));
  assert.deepEqual(out, b64(RFC8291.body));
});

test("the receiver's decryption reads the RFC 8291 example", () => {
  assert.equal(decrypt(b64(RFC8291.body), b64(RFC8291.receiverPrivate), b64(RFC8291.auth)).toString(), RFC8291.plaintext);
});

test("a message encrypted for a subscription decrypts with its private key only", () => {
  const browser = newBrowser();
  const message = Buffer.from(JSON.stringify({ title: "프로젝트", body: "권한 요청" }));
  const body = encrypt(message, browser.keys);
  assert.deepEqual(decrypt(body, browser.privateKey, browser.auth), message);
  assert.notDeepEqual(encrypt(message, browser.keys), body, "each message gets a fresh key pair and salt");
  const other = newBrowser();
  assert.throws(() => decrypt(body, other.privateKey, other.auth));
  const tampered = Buffer.from(body);
  tampered[tampered.length - 20] ^= 1;
  assert.throws(() => decrypt(tampered, browser.privateKey, browser.auth));
  assert.throws(() => encrypt(Buffer.alloc(MAX_PLAINTEXT + 1), browser.keys), /too long/);
});

test("the test's token check accepts the RFC 8292 example and rejects a changed one", () => {
  const t =
    "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL3B1c2guZXhhbXBsZS5uZXQiLCJleHAiOjE0NTM1MjM3NjgsInN1YiI6Im1haWx0bzpwdXNoQGV4YW1wbGUuY29tIn0." +
    "i3CYb7t4xfxCDquptFOepC9GAu_HLGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA";
  const k = "BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs";
  const example = readVapid(`vapid t=${t}, k=${k}`);
  assert.equal(example.valid, true);
  assert.equal(example.claims.aud, "https://push.example.net");
  const [h, , s] = t.split(".");
  const changed = Buffer.from(JSON.stringify({ aud: "https://push.example.org", exp: 1453523768 })).toString("base64url");
  assert.equal(readVapid(`vapid t=${h}.${changed}.${s}, k=${k}`).valid, false);
});

test("the VAPID header holds an ES256 JWT for the push service's origin, signed by the key it names", () => {
  const keys = generateVapidKeys();
  assert.equal(b64(keys.publicKey).length, 65);
  assert.equal(b64(keys.publicKey)[0], 4);
  assert.equal(b64(keys.privateKey).length, 32);
  const now = Date.now();
  const v = readVapid(vapidAuthorization("https://web.push.apple.com/QGuQyavXut", keys, "https://laptop.example.ts.net", now));
  assert.equal(v.valid, true);
  assert.deepEqual(v.header, { typ: "JWT", alg: "ES256" });
  assert.equal(v.claims.aud, "https://web.push.apple.com");
  assert.equal(v.claims.sub, "https://laptop.example.ts.net");
  const exp = v.claims.exp as number;
  assert.ok(Number.isInteger(exp) && exp > now / 1000 && exp <= now / 1000 + 24 * 3600, "expires within a day");
  assert.equal(v.key, keys.publicKey);
  assert.equal("sub" in readVapid(vapidAuthorization("https://fcm.googleapis.com/fcm/send/x", keys)).claims, false);
  assert.equal(readVapid(vapidAuthorization("https://fcm.googleapis.com/x", keys).replace(keys.publicKey, generateVapidKeys().publicKey)).valid, false);
});
