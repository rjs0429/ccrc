import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Store, StoredLease } from "./store.ts";

const TOUCH_SAVE_MS = 60_000;

function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

// The one remote access grant for the whole system. Emits "revoked" with a reason.
export class Leases extends EventEmitter {
  private store: Store;
  private idleMs: number;

  constructor(store: Store, idleMinutes: number) {
    super();
    this.store = store;
    this.idleMs = idleMinutes * 60_000;
  }

  current(now = Date.now()): StoredLease | undefined {
    const lease = this.store.state.lease;
    if (lease && now - lease.lastSeen > this.idleMs) {
      this.revoke("idle");
      return undefined;
    }
    return lease;
  }

  issue(device: string, now = Date.now()): string {
    if (this.store.state.lease) this.revoke("taken_over");
    const token = randomBytes(32).toString("base64url");
    this.store.state.lease = { tokenHash: digest(token).toString("hex"), device, createdAt: now, lastSeen: now };
    this.store.save();
    return token;
  }

  validate(token: string | undefined, now = Date.now()): boolean {
    const lease = this.current(now);
    if (!lease || !token) return false;
    const expected = Buffer.from(lease.tokenHash, "hex");
    if (!timingSafeEqual(digest(token), expected)) return false;
    if (now - lease.lastSeen > TOUCH_SAVE_MS) {
      lease.lastSeen = now;
      this.store.save();
    }
    return true;
  }

  revoke(reason: string): void {
    if (!this.store.state.lease) return;
    delete this.store.state.lease;
    this.store.save();
    this.emit("revoked", reason);
  }
}
