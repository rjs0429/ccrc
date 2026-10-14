import type { Hub } from "../hub.ts";
import type { SessionManager } from "../sessions/manager.ts";
import { encrypt } from "./encrypt.ts";
import { Notifier, TIMING, type PushTiming, type Urgency } from "./rules.ts";
import { PushError, PushStore, isPushService, parseEndpoint, parsePrefs, parseSubscription, type Subscription } from "./subscriptions.ts";
import { DEFAULT_PREFS, type PushPayload, type PushStatus } from "./types.ts";
import { vapidAuthorization } from "./vapid.ts";

export { PushError, type Subscription };

export interface PushOptions {
  // Which push service URLs the broker posts to; by default the browsers' own services over https.
  allow?: (url: URL) => boolean;
  timing?: Partial<PushTiming>;
  log?: (line: string) => void;
}

const TTL_SEC = 3600;
const SEND_TIMEOUT_MS = 15_000;
const MAX_RETRY_MS = 60_000;
const TEST: PushPayload = { title: "ccrc", body: "시험 알림입니다", tag: "test", data: { url: "/#/settings" } };

interface Health {
  lastSent?: number;
  lastError?: { status: number; at: number };
}

// The https origin in an Origin header, if it is one.
function contact(origin: string | undefined): string | undefined {
  if (!origin || !URL.canParse(origin)) return undefined;
  const url = new URL(origin);
  return url.protocol === "https:" ? url.origin : undefined;
}

// Web Push notifications to subscribed devices (RFC 8030, encrypted per RFC 8291, signed per RFC 8292).
export class Push {
  readonly dir: string;
  private store: PushStore;
  private allow: (url: URL) => boolean;
  private timing: PushTiming;
  private log: (line: string) => void;
  private notifier?: Notifier;
  private health = new Map<string, Health>();
  private retries = new Set<NodeJS.Timeout>();

  constructor(dir: string, opts: PushOptions = {}) {
    this.dir = dir;
    this.store = new PushStore(dir);
    this.allow = opts.allow ?? isPushService;
    this.timing = { ...TIMING, ...opts.timing };
    this.log = opts.log ?? ((line) => console.error(line));
  }

  publicKey(): string {
    return this.store.vapid.publicKey;
  }

  subscribe(subscription: unknown, prefs: unknown, from: { device: string; origin?: string }): Subscription {
    const { endpoint, keys } = parseSubscription(subscription, this.allow);
    const known = this.store.get(endpoint);
    const origin = contact(from.origin);
    const sub: Subscription = {
      endpoint,
      keys,
      device: from.device,
      ...(origin ? { origin } : {}),
      createdAt: known?.createdAt ?? Date.now(),
      prefs: parsePrefs(prefs, known?.prefs ?? DEFAULT_PREFS),
    };
    this.store.put(sub);
    return sub;
  }

  unsubscribe(endpoint: unknown): Subscription | undefined {
    const sub = this.store.remove(parseEndpoint(endpoint));
    if (sub) this.health.delete(sub.endpoint);
    return sub;
  }

  setPrefs(endpoint: unknown, prefs: unknown): Subscription {
    const sub = this.store.get(parseEndpoint(endpoint));
    if (!sub) throw new PushError("not_subscribed");
    const next = { ...sub, prefs: parsePrefs(prefs, sub.prefs) };
    this.store.put(next);
    return next;
  }

  status(endpoint: unknown): PushStatus {
    const sub = this.store.get(parseEndpoint(endpoint));
    if (!sub) return { subscribed: false };
    return { subscribed: true, device: sub.device, createdAt: sub.createdAt, prefs: sub.prefs, ...this.health.get(sub.endpoint) };
  }

  async test(endpoint: unknown): Promise<void> {
    const sub = this.store.get(parseEndpoint(endpoint));
    if (!sub) throw new PushError("not_subscribed");
    const status = await this.deliver(sub, TEST, "normal", false);
    if (status < 200 || status > 299) throw new PushError("push_failed", status);
  }

  watch(manager: SessionManager, hub: Hub): void {
    this.notifier?.close();
    this.notifier = new Notifier(manager, hub, {
      subscriptions: () => this.store.list(),
      deliver: (sub, payload, urgency) => this.send(sub, payload, urgency, true),
      timing: this.timing,
      log: this.log,
    });
  }

  close(): void {
    this.notifier?.close();
    for (const t of this.retries) clearTimeout(t);
    this.retries.clear();
  }

  private send(sub: Subscription, payload: PushPayload, urgency: Urgency, retry: boolean): void {
    this.deliver(sub, payload, urgency, retry).catch((e) => this.log(`push: sending failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  // Answers the push service's status, 0 when it could not be reached. A 404 or 410 means the
  // subscription is gone; a 429 or 5xx is tried once more a little later. A failure is logged with the
  // service's host and answer, never the notification.
  private async deliver(sub: Subscription, payload: PushPayload, urgency: Urgency, retry: boolean): Promise<number> {
    let answer: { status: number; reason: string; retryAfterSec?: number };
    try {
      answer = await this.post(sub, payload, urgency);
    } catch (e) {
      answer = { status: 0, reason: e instanceof Error ? e.message : String(e) };
    }
    const { status, reason, retryAfterSec } = answer;
    if (status >= 200 && status <= 299) {
      this.health.set(sub.endpoint, { lastSent: Date.now() });
      return status;
    }
    this.health.set(sub.endpoint, { ...this.health.get(sub.endpoint), lastError: { status, at: Date.now() } });
    this.log(`push: ${new URL(sub.endpoint).host} answered ${status || "nothing"}${reason ? ` (${reason})` : ""}`);
    if (status === 404 || status === 410) {
      this.store.remove(sub.endpoint);
      this.health.delete(sub.endpoint);
    } else if (retry && (status === 0 || status === 429 || status >= 500)) {
      const wait = Math.min(Math.max(this.timing.retryMs, (retryAfterSec ?? 0) * 1000), MAX_RETRY_MS);
      const timer = setTimeout(() => {
        this.retries.delete(timer);
        const current = this.store.get(sub.endpoint);
        if (current) this.send(current, payload, urgency, false);
      }, wait);
      timer.unref();
      this.retries.add(timer);
    }
    return status;
  }

  private async post(sub: Subscription, payload: PushPayload, urgency: Urgency): Promise<{ status: number; reason: string; retryAfterSec?: number }> {
    const url = new URL(sub.endpoint);
    if (!this.allow(url)) throw Error("not a push service");
    const res = await fetch(url, {
      method: "POST",
      headers: {
        TTL: String(TTL_SEC),
        Urgency: urgency,
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "aes128gcm",
        Authorization: vapidAuthorization(sub.endpoint, this.store.vapid, sub.origin),
      },
      body: encrypt(Buffer.from(JSON.stringify(payload)), sub.keys),
      redirect: "error",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const text = await res.text().catch(() => "");
    return {
      status: res.status,
      reason: res.ok ? "" : text.replace(/\s+/g, " ").trim().slice(0, 120),
      retryAfterSec: Number(res.headers.get("retry-after")) || undefined,
    };
  }
}
