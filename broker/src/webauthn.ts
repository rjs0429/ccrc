import { createHash, createPublicKey, timingSafeEqual, verify, type KeyObject } from "node:crypto";

// The checks of WebAuthn registration and authentication (Web Authentication Level 2, sections 7.1 and 7.2) for
// passkeys made without attestation. The browser hands over the new key as SPKI (getPublicKey()) and the authenticator
// data as bytes, so nothing here decodes CBOR; what is left is comparing bytes and one signature check.

// COSE algorithms a passkey may use: ES256, EdDSA (Ed25519) and RS256.
export const ALGORITHMS: readonly number[] = [-7, -8, -257];
const TRANSPORTS = new Set(["internal", "hybrid", "usb", "nfc", "ble", "smart-card"]);
const UP = 0x01;
const UV = 0x04;
const BS = 0x10;
const AT = 0x40;
const ID_MAX = 1023;
const FIELD_MAX = 16 * 1024;

export class WebAuthnError extends Error {}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const sha256 = (data: Buffer | string): Buffer => createHash("sha256").update(data).digest();
const same = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b);

export function b64url(v: unknown, max = FIELD_MAX): Buffer {
  if (typeof v !== "string" || !v || v.length > max || !/^[A-Za-z0-9_-]+$/.test(v)) throw new WebAuthnError("malformed");
  return Buffer.from(v, "base64url");
}

// Where a passkey can be used from: an https page on a host name, or http on localhost, as browsers allow. The relying
// party is the page's host.
export function passkeyOrigin(origin: unknown): { origin: string; rpId: string } | undefined {
  if (typeof origin !== "string") return undefined;
  try {
    const u = new URL(origin);
    const name = u.hostname;
    if (!name.includes(".") && name !== "localhost") return undefined;
    if (/^[\d.]+$/.test(name) || name.startsWith("[")) return undefined;
    if (u.protocol === "https:" || (u.protocol === "http:" && name === "localhost")) return { origin: u.origin, rpId: name };
  } catch {}
  return undefined;
}

export interface Expected {
  challenge: Buffer;
  origin: string;
  rpId: string;
}

interface AuthData {
  rpIdHash: Buffer;
  flags: number;
  counter: number;
  credentialId?: Buffer;
}

function authData(raw: Buffer, attested: boolean): AuthData {
  if (raw.length < 37) throw new WebAuthnError("malformed");
  const flags = raw[32];
  const out: AuthData = { rpIdHash: raw.subarray(0, 32), flags, counter: raw.readUInt32BE(33) };
  if (!attested) return out;
  if (!(flags & AT) || raw.length < 55) throw new WebAuthnError("malformed");
  const length = raw.readUInt16BE(53);
  if (length < 1 || length > ID_MAX || raw.length <= 55 + length) throw new WebAuthnError("malformed");
  return { ...out, credentialId: raw.subarray(55, 55 + length) };
}

function check(clientDataJSON: Buffer, data: AuthData, type: "webauthn.create" | "webauthn.get", e: Expected): void {
  let c: Obj;
  try {
    c = obj(JSON.parse(clientDataJSON.toString("utf8")));
  } catch {
    throw new WebAuthnError("malformed");
  }
  if (c.type !== type) throw new WebAuthnError("type");
  if (!same(b64url(c.challenge), e.challenge)) throw new WebAuthnError("challenge");
  if (c.origin !== e.origin || c.crossOrigin === true || c.topOrigin !== undefined) throw new WebAuthnError("origin");
  if (!same(data.rpIdHash, sha256(e.rpId))) throw new WebAuthnError("rp");
  if (!(data.flags & UP)) throw new WebAuthnError("presence");
  if (!(data.flags & UV)) throw new WebAuthnError("verification");
}

// A public key of one of the algorithms, the curve or size it must have checked.
export function publicKeyOf(spki: Buffer, alg: number): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey({ key: spki, format: "der", type: "spki" });
  } catch {
    throw new WebAuthnError("key");
  }
  const type = key.asymmetricKeyType;
  const details = key.asymmetricKeyDetails;
  const ok =
    alg === -7
      ? type === "ec" && details?.namedCurve === "prime256v1"
      : alg === -8
        ? type === "ed25519"
        : alg === -257
          ? type === "rsa" && (details?.modulusLength ?? 0) >= 2048
          : false;
  if (!ok) throw new WebAuthnError("key");
  return key;
}

function signed(key: KeyObject, alg: number, data: Buffer, signature: Buffer): boolean {
  try {
    if (alg === -8) return verify(null, data, key, signature);
    return verify("sha256", data, alg === -7 ? { key, dsaEncoding: "der" } : key, signature);
  } catch {
    return false;
  }
}

export interface NewCredential {
  id: string;
  publicKey: string;
  alg: number;
  counter: number;
  backedUp: boolean;
  transports: string[];
}

// A create() response: id (the credential id, base64url) and response.clientDataJSON, authenticatorData, publicKey
// (SPKI), publicKeyAlgorithm and transports, all binary fields base64url.
export function verifyRegistration(body: unknown, e: Expected): NewCredential {
  const b = obj(body);
  const r = obj(b.response);
  const id = b64url(b.id, 2 * ID_MAX);
  const raw = b64url(r.clientDataJSON);
  const authenticatorData = b64url(r.authenticatorData);
  const spki = b64url(r.publicKey);
  const alg = r.publicKeyAlgorithm;
  const data = authData(authenticatorData, true);
  check(raw, data, "webauthn.create", e);
  if (!same(data.credentialId!, id)) throw new WebAuthnError("credential");
  if (typeof alg !== "number" || !ALGORITHMS.includes(alg)) throw new WebAuthnError("key");
  publicKeyOf(spki, alg);
  const transports = Array.isArray(r.transports) ? [...new Set(r.transports.filter((t): t is string => typeof t === "string" && TRANSPORTS.has(t)))] : [];
  return { id: id.toString("base64url"), publicKey: spki.toString("base64url"), alg, counter: data.counter, backedUp: Boolean(data.flags & BS), transports };
}

// A get() response for a stored passkey: response.clientDataJSON, authenticatorData and signature, base64url. A counter
// that does not go up, where the authenticator keeps one, means a copy of the key is in use.
export function verifyAssertion(body: unknown, e: Expected, stored: { publicKey: string; alg: number; counter: number }): { counter: number; backedUp: boolean } {
  const r = obj(obj(body).response);
  const raw = b64url(r.clientDataJSON);
  const authenticatorData = b64url(r.authenticatorData);
  const signature = b64url(r.signature, 2048);
  const data = authData(authenticatorData, false);
  check(raw, data, "webauthn.get", e);
  const key = publicKeyOf(Buffer.from(stored.publicKey, "base64url"), stored.alg);
  if (!signed(key, stored.alg, Buffer.concat([authenticatorData, sha256(raw)]), signature)) throw new WebAuthnError("signature");
  if ((data.counter > 0 || stored.counter > 0) && data.counter <= stored.counter) throw new WebAuthnError("counter");
  return { counter: data.counter, backedUp: Boolean(data.flags & BS) };
}
