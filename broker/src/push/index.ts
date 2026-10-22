import type { Hub } from "../hub.ts";
import type { Lang } from "../lang.ts";
import type { SessionManager } from "../sessions/manager.ts";
import { encrypt } from "./encrypt.ts";
import { Notifier, TIMING, type PushTiming, type Urgency } from "./rules.ts";
import { PushError, PushStore, isPushService, parseEndpoint, parsePrefs, parseSubscription, type Subscription } from "./subscriptions.ts";
import { PUSH_TEXT } from "./text.ts";
import { DEFAULT_PREFS, type PushBadge, type PushPayload, type PushRecent, type PushStatus } from "./types.ts";
import { VapidTokens } from "./vapid.ts";

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
const test = (lang: Lang): PushPayload => ({ title: "ccrc", body: PUSH_TEXT[lang].test, tag: "test", data: { url: "/#/settings/alerts" } });

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
  private manager?: SessionManager;
  private health = new Map<string, Health>();
  private retries = new Set<NodeJS.Timeout>();
  private tokens = new VapidTokens();

  constructor(dir: string, opts: PushOptions = {}) {
    this.dir = dir;
    this.store = new PushStore(dir);
    this.allow = opts.allow ?? isPushService;
    this.timing = { ...TIMING, ...opts.timing };
    this.log = opts.log ?? ((line) => console.error(line));
  }

  // Whether a notification can reach the device: one of its subscriptions whose last send did not fail.
  reaches(device: string | undefined): boolean {
    if (!device) return false;
    return this.store.list().some((sub) => sub.device === device && !this.health.get(sub.endpoint)?.lastError);
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
    this.changed();
    return sub;
  }

  unsubscribe(endpoint: unknown): Subscription | undefined {
    const sub = this.store.remove(parseEndpoint(endpoint));
    if (sub) this.health.delete(sub.endpoint);
    this.changed();
    return sub;
  }

  setPrefs(endpoint: unknown, prefs: unknown): Subscription {
    const sub = this.store.get(parseEndpoint(endpoint));
    if (!sub) throw new PushError("not_subscribed");
    const next = { ...sub, prefs: parsePrefs(prefs, sub.prefs) };
    this.store.put(next);
    this.changed();
    return next;
  }

  // The language a device's notifications are written in, or the newest subscription's when it has none.
  lang(device: string | undefined): Lang | undefined {
    const subs = this.store.list().sort((a, b) => b.createdAt - a.createdAt);
    return (subs.find((s) => s.device === device) ?? subs[0])?.prefs.lang;
  }

  // Whether any device takes the notifications Claude sends.
  claudeWanted(): boolean {
    return this.store.list().some((s) => s.prefs.claude);
  }

  status(endpoint: unknown): PushStatus {
    const sub = this.store.get(parseEndpoint(endpoint));
    if (!sub) return { subscribed: false };
    return { subscribed: true, device: sub.device, createdAt: sub.createdAt, prefs: sub.prefs, ...this.health.get(sub.endpoint) };
  }

  // The request this device was notified of lately that still waits for an answer.
  recent(endpoint: unknown): PushRecent {
    const sub = this.store.get(parseEndpoint(endpoint));
    if (!sub) throw new PushError("not_subscribed");
    const request = this.notifier?.recent(sub.endpoint);
    return request ? { request } : {};
  }

  badge(endpoint: unknown): PushBadge {
    const sub = this.store.get(parseEndpoint(endpoint));
    if (!sub) return { subscribed: false, badge: 0, unseen: [] };
    return { subscribed: true, ...(this.notifier?.badge() ?? { badge: 0, unseen: [] }) };
  }

  async test(endpoint: unknown): Promise<void> {
    const sub = this.store.get(parseEndpoint(endpoint));
    if (!sub) throw new PushError("not_subscribed");
    const status = await this.deliver(sub, test(sub.prefs.lang), "normal", false);
    if (status < 200 || status > 299) throw new PushError("push_failed", status);
  }

  // A notification for every subscribed device, in its language; false when there is none.
  announce(payload: (lang: Lang) => PushPayload): boolean {
    const subs = this.store.list();
    for (const sub of subs) this.send(sub, payload(sub.prefs.lang), "normal", true);
    return subs.length > 0;
  }

  watch(manager: SessionManager, hub: Hub): void {
    this.notifier?.close();
    this.manager = manager;
    this.notifier = new Notifier(manager, hub, {
      subscriptions: () => this.store.list(),
      deliver: (sub, payload, urgency) => this.send(sub, payload, urgency, true),
      timing: this.timing,
      log: this.log,
    });
    this.changed();
  }

  // VS Code sessions tell Claude its notification went out only while a device takes them.
  private changed(): void {
    this.manager?.setClaudePush(this.claudeWanted());
  }

  close(): void {
    this.notifier?.close();
    for (const t of this.retries) clearTimeout(t);
    this.retries.clear();
  }

  private send(sub: Subscription, payload: PushPayload, urgency: Urgency, retry: boolean): void {
    this.deliver(sub, payload, urgency, retry).catch((e) => this.log(`push: sending failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  // Answers the push service's status, 0 when it could not be reached. A 404 or 410 means the subscription is gone;
  // a 429 or 5xx is tried once more a little later; a 401 or 403 to a reused token is sent again at once with a new
  // one. A failure is logged with the service's host and answer, never the notification.
  private async deliver(sub: Subscription, payload: PushPayload, urgency: Urgency, retry: boolean): Promise<number> {
    let answer: { status: number; reason: string; retryAfterSec?: number; reused?: boolean };
    try {
      answer = await this.post(sub, payload, urgency);
      if (answer.reused && (answer.status === 401 || answer.status === 403)) {
        this.log(`push: ${new URL(sub.endpoint).host} answered ${answer.status} to a reused token; signing a new one`);
        answer = await this.post(sub, payload, urgency);
      }
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
      this.changed();
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

  private async post(sub: Subscription, payload: PushPayload, urgency: Urgency): Promise<{ status: number; reason: string; retryAfterSec?: number; reused: boolean }> {
    const url = new URL(sub.endpoint);
    if (!this.allow(url)) throw Error("not a push service");
    const token = this.tokens.header(sub.endpoint, this.store.vapid, sub.origin);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        TTL: String(TTL_SEC),
        Urgency: urgency,
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "aes128gcm",
        Authorization: token.value,
      },
      body: encrypt(Buffer.from(JSON.stringify(payload)), sub.keys),
      redirect: "error",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) this.tokens.forget(sub.endpoint);
    const text = await res.text().catch(() => "");
    return {
      status: res.status,
      reason: res.ok ? "" : text.replace(/\s+/g, " ").trim().slice(0, 120),
      retryAfterSec: Number(res.headers.get("retry-after")) || undefined,
      reused: token.reused,
    };
  }
}
