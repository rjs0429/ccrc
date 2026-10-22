import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { paths, writeFileAtomic } from "./config.ts";
import type { StoredLease } from "./store.ts";
import { ALGORITHMS, WebAuthnError, b64url, verifyAssertion, verifyRegistration } from "./webauthn.ts";

// A passkey registered from a phone: the credential id and its public key (SPKI), base64url; the host name it was made
// for (the relying party), and the tailnet device that registered it.
export interface StoredPasskey {
  id: string;
  publicKey: string;
  alg: number;
  rpId: string;
  counter: number;
  device: string;
  createdAt: number;
  lastUsedAt?: number;
  backedUp?: boolean;
  transports?: string[];
}

// user: the user handle every passkey is made with, so making one again on the same phone replaces it there.
interface PasskeyFile {
  user?: string;
  passkeys: StoredPasskey[];
}

export const DEFAULT_HOURS = 18;
// The WebSocket close code that tells the page a passkey has to confirm the login first.
export const PASSKEY_CLOSE = 4003;
const CHALLENGE_MS = 5 * 60_000;
const PASSKEYS_MAX = 10;
// A confirmation dated this far ahead of the clock is not trusted.
const SKEW_MS = 60_000;

type Purpose = "register" | "verify";
interface Challenge {
  challenge: Buffer;
  origin: string;
  rpId: string;
  lease: string;
  until: number;
}

export class PasskeyError extends Error {}

// The passkeys registered from phones and the confirmations they give. Once one is registered, a login from any device
// but this machine is confirmed with a passkey when it starts and again each `hours` after (Face ID, or the phone's
// own unlock); a device without one of its own registers one instead, once. The file is read again whenever it
// changes, as `ccrc passkey` edits it while the broker runs.
export class Passkeys {
  readonly file: string;
  private windowMs: number;
  private cache?: { mtimeMs: number; size: number; data: PasskeyFile };
  private pending = new Map<Purpose, Challenge>();

  constructor(file = paths.passkeysFile, hours = DEFAULT_HOURS) {
    this.file = file;
    this.windowMs = hours * 3600_000;
  }

  setHours(hours: number): void {
    this.windowMs = hours * 3600_000;
  }

  get hours(): number {
    return this.windowMs / 3600_000;
  }

  private read(): PasskeyFile {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.file);
    } catch {
      this.cache = undefined;
      return { passkeys: [] };
    }
    if (this.cache?.mtimeMs === st.mtimeMs && this.cache.size === st.size) return this.cache.data;
    let data: PasskeyFile;
    try {
      const v = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<PasskeyFile>;
      data = { ...(typeof v.user === "string" ? { user: v.user } : {}), passkeys: Array.isArray(v.passkeys) ? v.passkeys.filter(valid) : [] };
    } catch {
      throw new PasskeyError("unreadable");
    }
    this.cache = { mtimeMs: st.mtimeMs, size: st.size, data };
    return data;
  }

  private write(data: PasskeyFile): void {
    writeFileAtomic(this.file, JSON.stringify(data, null, 2) + "\n");
    this.cache = undefined;
  }

  list(): StoredPasskey[] {
    return this.read().passkeys;
  }

  // A file that cannot be read still asks for a passkey; it never lets a login go unconfirmed.
  any(): boolean {
    try {
      return this.list().length > 0;
    } catch {
      return true;
    }
  }

  // Whether a passkey was registered from this device. A file that cannot be read counts as one, so no device registers
  // one in place of confirming.
  hasOwn(device: string): boolean {
    try {
      return this.list().some((p) => p.device === device);
    } catch {
      return true;
    }
  }

  // Whether the login has to be confirmed with a passkey before the API answers it.
  due(lease: StoredLease | undefined, device: string, now = Date.now()): boolean {
    if (!lease || device === "local" || !this.any()) return false;
    const at = lease.verifiedAt;
    return at === undefined || now - at >= this.windowMs || at > now + SKEW_MS;
  }

  // When the login next has to be confirmed; undefined when it does not.
  dueAt(lease: StoredLease | undefined): number | undefined {
    if (!lease?.verifiedAt || !this.any()) return undefined;
    return lease.verifiedAt + this.windowMs;
  }

  private challenge(purpose: Purpose, lease: StoredLease, origin: string, rpId: string, now: number): string {
    const challenge = randomBytes(32);
    this.pending.set(purpose, { challenge, origin, rpId, lease: lease.tokenHash, until: now + CHALLENGE_MS });
    return challenge.toString("base64url");
  }

  // A challenge is good once, for the login it was made for, until it expires.
  private take(purpose: Purpose, lease: StoredLease, now: number): Challenge {
    const c = this.pending.get(purpose);
    this.pending.delete(purpose);
    if (!c || c.lease !== lease.tokenHash || now > c.until) throw new PasskeyError("challenge_expired");
    return c;
  }

  // What the phone passes to navigator.credentials.create(), binary fields base64url. The passkey has to verify the
  // user (Face ID or the phone's unlock) and stays on the phone's own authenticator.
  registerOptions(lease: StoredLease, where: { origin: string; rpId: string }, userName: string, now = Date.now()): Record<string, unknown> {
    const data = this.read();
    if (data.passkeys.length >= PASSKEYS_MAX) throw new PasskeyError("too_many");
    let user = data.user;
    if (!user) {
      user = randomBytes(16).toString("base64url");
      this.write({ ...data, user });
    }
    return {
      challenge: this.challenge("register", lease, where.origin, where.rpId, now),
      rp: { name: "ccrc", id: where.rpId },
      user: { id: user, name: userName, displayName: userName },
      pubKeyCredParams: ALGORITHMS.map((alg) => ({ type: "public-key", alg })),
      timeout: CHALLENGE_MS,
      attestation: "none",
      authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "preferred", userVerification: "required" },
      excludeCredentials: data.passkeys.filter((p) => p.rpId === where.rpId).map((p) => ({ type: "public-key", id: p.id, ...(p.transports?.length ? { transports: p.transports } : {}) })),
    };
  }

  register(lease: StoredLease, body: unknown, device: string, now = Date.now()): StoredPasskey {
    const c = this.take("register", lease, now);
    const made = verifyRegistration(body, { challenge: c.challenge, origin: c.origin, rpId: c.rpId });
    const data = this.read();
    if (data.passkeys.some((p) => p.id === made.id)) throw new PasskeyError("already_registered");
    const passkey: StoredPasskey = {
      id: made.id,
      publicKey: made.publicKey,
      alg: made.alg,
      rpId: c.rpId,
      counter: made.counter,
      device,
      createdAt: now,
      lastUsedAt: now,
      ...(made.backedUp ? { backedUp: true } : {}),
      ...(made.transports.length ? { transports: made.transports } : {}),
    };
    this.write({ ...data, passkeys: [...data.passkeys, passkey] });
    return passkey;
  }

  // What the phone passes to navigator.credentials.get(): the passkeys made for the page's host.
  verifyOptions(lease: StoredLease, where: { origin: string; rpId: string }, now = Date.now()): Record<string, unknown> {
    const here = this.list().filter((p) => p.rpId === where.rpId);
    if (!here.length) throw new PasskeyError("none_here");
    return {
      challenge: this.challenge("verify", lease, where.origin, where.rpId, now),
      rpId: where.rpId,
      allowCredentials: here.map((p) => ({ type: "public-key", id: p.id, ...(p.transports?.length ? { transports: p.transports } : {}) })),
      userVerification: "required",
      timeout: CHALLENGE_MS,
    };
  }

  verify(lease: StoredLease, body: unknown, now = Date.now()): StoredPasskey {
    const c = this.take("verify", lease, now);
    const id = b64url((body as { id?: unknown } | null)?.id).toString("base64url");
    const data = this.read();
    const passkey = data.passkeys.find((p) => p.id === id && p.rpId === c.rpId);
    if (!passkey) throw new WebAuthnError("credential");
    const used = verifyAssertion(body, { challenge: c.challenge, origin: c.origin, rpId: c.rpId }, passkey);
    const updated: StoredPasskey = { ...passkey, counter: used.counter, lastUsedAt: now, ...(used.backedUp ? { backedUp: true } : {}) };
    this.write({ ...data, passkeys: data.passkeys.map((p) => (p === passkey ? updated : p)) });
    return updated;
  }

  // The passkey whose id starts with `prefix`, when only one does.
  find(prefix: string): StoredPasskey | undefined {
    const hits = prefix ? this.list().filter((p) => p.id.startsWith(prefix)) : [];
    return hits.length === 1 ? hits[0] : undefined;
  }

  remove(id: string): boolean {
    const data = this.read();
    const kept = data.passkeys.filter((p) => p.id !== id);
    if (kept.length === data.passkeys.length) return false;
    this.write({ ...data, passkeys: kept });
    return true;
  }

  // Removes every passkey, from a file that cannot be read too; logins are then confirmed by the password alone. The user
  // handle stays, so a passkey made again on the same phone takes the old one's place there. The count removed,
  // undefined when the file could not be read.
  reset(): number | undefined {
    let data: PasskeyFile | undefined;
    try {
      data = this.read();
    } catch {}
    if (data?.passkeys.length !== 0 || fs.existsSync(this.file)) this.write({ ...(data?.user ? { user: data.user } : {}), passkeys: [] });
    return data?.passkeys.length;
  }
}

function valid(p: unknown): p is StoredPasskey {
  const o = p as Partial<StoredPasskey> | null;
  return (
    !!o &&
    typeof o.id === "string" &&
    typeof o.publicKey === "string" &&
    typeof o.alg === "number" &&
    typeof o.rpId === "string" &&
    typeof o.counter === "number" &&
    typeof o.device === "string" &&
    typeof o.createdAt === "number"
  );
}
