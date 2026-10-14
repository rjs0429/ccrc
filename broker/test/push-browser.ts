import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from "node:crypto";

// The receiving side of Web Push, written out separately from the broker's code: a browser's
// subscription keys, RFC 8291 decryption step by step (section 3.4), and RFC 8292 token checks.

export function newBrowser() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { privateKey: ecdh.getPrivateKey(), auth, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } };
}

const hmac = (key: Buffer, ...data: Buffer[]) => createHmac("sha256", key).update(Buffer.concat(data)).digest();
const ONE = Buffer.from([1]);

export function decrypt(body: Buffer, privateKey: Buffer, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const serverPublic = body.subarray(21, 21 + body[20]);
  const sealed = body.subarray(21 + body[20]);
  if (sealed.length > recordSize) throw Error("more than one record");
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(privateKey);
  const prkKey = hmac(auth, ecdh.computeSecret(serverPublic));
  const ikm = hmac(prkKey, Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), serverPublic, ONE);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0"), ONE).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0"), ONE).subarray(0, 12);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(sealed.subarray(-16));
  const padded = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
  let end = padded.length - 1;
  while (end > 0 && padded[end] === 0) end--;
  if (padded[end] !== 2) throw Error("not the last record");
  return padded.subarray(0, end);
}

const json = (segment: string) => JSON.parse(Buffer.from(segment, "base64url").toString()) as Record<string, unknown>;

// Checks a `vapid t=<jwt>, k=<key>` header the way a push service does: the JWT is verified with the key it names.
export function readVapid(header: string): { valid: boolean; header: Record<string, unknown>; claims: Record<string, unknown>; key: string } {
  const m = header.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/);
  if (!m) throw Error(`not a vapid header: ${header}`);
  const point = Buffer.from(m[4], "base64url");
  const key = createPublicKey({
    key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33, 65).toString("base64url") },
    format: "jwk",
  });
  const valid = verify("sha256", Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(m[3], "base64url"));
  return { valid, header: json(m[1]), claims: json(m[2]), key: m[4] };
}
