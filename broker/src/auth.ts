import { hash, verify } from "@node-rs/argon2";
import { timingSafeEqual } from "node:crypto";
import type { Store } from "./store.ts";

// OWASP minimum for Argon2id (the library default algorithm).
const HASH_OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
const FREE_FAILURES = 5;
const BASE_LOCK_MS = 5 * 60_000;
const MAX_LOCK_MS = 60 * 60_000;

export const ID_PATTERN = /^[A-Za-z0-9._-]{3,32}$/;
export const MIN_PASSWORD_LENGTH = 10;

let dummyHash: Promise<string> | undefined;

export function hashPassword(password: string): Promise<string> {
  return hash(password, HASH_OPTIONS);
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export type LoginCheck = { ok: true } | { ok: false; reason: "not_configured" | "invalid" | "locked"; retryAfterSec?: number };

// Verifies ID and password with lockout. A wrong ID still costs one hash check.
export async function checkCredentials(store: Store, id: string, password: string, now = Date.now()): Promise<LoginCheck> {
  store.reload();
  const { user, lockout } = store.state;
  if (!user) return { ok: false, reason: "not_configured" };
  if (lockout.lockedUntil > now) return { ok: false, reason: "locked", retryAfterSec: Math.ceil((lockout.lockedUntil - now) / 1000) };

  const idMatches = sameText(id, user.id);
  dummyHash ??= hashPassword("ccrc-dummy-password");
  const passwordMatches = await verify(idMatches ? user.passwordHash : await dummyHash, password);
  if (idMatches && passwordMatches) {
    store.state.lockout = { failures: 0, lockedUntil: 0 };
    store.save();
    return { ok: true };
  }

  const failures = lockout.failures + 1;
  const extra = failures - FREE_FAILURES;
  const lockedUntil = extra >= 0 ? now + Math.min(BASE_LOCK_MS * 2 ** extra, MAX_LOCK_MS) : 0;
  store.state.lockout = { failures, lockedUntil };
  store.save();
  if (lockedUntil) return { ok: false, reason: "locked", retryAfterSec: Math.ceil((lockedUntil - now) / 1000) };
  return { ok: false, reason: "invalid" };
}

// Reads the credentials file again after it changed while the broker runs (`ccrc passwd`, `ccrc logout`): whether the
// login's lease went, and whether the password was set since the last look. The last look is kept here, since other
// readers reload the store too.
export function credentialsWatch(store: Store): () => { leaseGone: boolean; passwordSet: boolean } {
  let setAt = store.state.user?.changedAt;
  return () => {
    const hadLease = Boolean(store.state.lease);
    store.reload();
    const at = store.state.user?.changedAt;
    const passwordSet = at !== setAt;
    setAt = at;
    return { leaseGone: hadLease && !store.state.lease, passwordSet };
  };
}

export async function setCredentials(store: Store, id: string, password: string): Promise<void> {
  if (!ID_PATTERN.test(id)) throw Error("ID must be 3-32 characters: letters, digits, . _ -");
  if (password.length < MIN_PASSWORD_LENGTH) throw Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  store.reload();
  store.state.user = { id, passwordHash: await hashPassword(password), changedAt: new Date().toISOString() };
  store.state.lockout = { failures: 0, lockedUntil: 0 };
  store.save();
}
