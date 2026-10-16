import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";

// The broker's P-256 signing key pair, base64url: the uncompressed public point and the private scalar.
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

const TOKEN_SEC = 12 * 3600;
// A signed token serves this long before a new one is signed: well over the hour Apple asks a token to last at least,
// and well short of its expiry.
export const REUSE_MS = 6 * 3600_000;

export function generateVapidKeys(): VapidKeys {
  const jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x ?? "", "base64url"), Buffer.from(jwk.y ?? "", "base64url")]);
  return { publicKey: point.toString("base64url"), privateKey: jwk.d ?? "" };
}

const segment = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");

// RFC 8292 Authorization header for a push service: an ES256 JWT for the endpoint's origin, valid
// for less than a day, and the key that signed it. `sub` is the https origin of the app, if known.
export function vapidAuthorization(endpoint: string, keys: VapidKeys, sub?: string, now = Date.now()): string {
  const point = Buffer.from(keys.publicKey, "base64url");
  const key = createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33, 65).toString("base64url"),
      d: keys.privateKey,
    },
    format: "jwk",
  });
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + TOKEN_SEC, ...(sub ? { sub } : {}) };
  const unsigned = `${segment({ typ: "JWT", alg: "ES256" })}.${segment(claims)}`;
  const signature = sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${unsigned}.${signature.toString("base64url")}, k=${keys.publicKey}`;
}

// Authorization headers kept in memory per push service origin, contact and key (RFC 8292 lets a token serve every
// subscription at one origin). A clock that jumps either way gets a new token.
export class VapidTokens {
  private cache = new Map<string, { value: string; at: number }>();

  header(endpoint: string, keys: VapidKeys, sub?: string, now = Date.now()): { value: string; reused: boolean } {
    const key = `${new URL(endpoint).origin} ${sub ?? ""} ${keys.publicKey}`;
    const hit = this.cache.get(key);
    if (hit && now >= hit.at && now - hit.at < REUSE_MS) return { value: hit.value, reused: true };
    for (const [k, v] of this.cache) if (now < v.at || now - v.at >= REUSE_MS) this.cache.delete(k);
    const value = vapidAuthorization(endpoint, keys, sub, now);
    this.cache.set(key, { value, at: now });
    return { value, reused: false };
  }

  // A push service that refuses a token gets a new one from then on.
  forget(endpoint: string): void {
    const origin = new URL(endpoint).origin;
    for (const k of [...this.cache.keys()]) if (k.startsWith(`${origin} `)) this.cache.delete(k);
  }
}
