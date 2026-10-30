import type { Hub } from "../hub.ts";
import type { Lang } from "../lang.ts";
import type { SessionManager } from "../sessions/manager.ts";
import { MAX_PLAINTEXT, encrypt } from "./encrypt.ts";
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
const MAX_RETRY_AFTER_MS = 10 * 60_000;
const TAGS_KEEP = 500;
const test = (lang: Lang): PushPayload => ({ title: "ccrc", body: PUSH_TEXT[lang].test, tag: "test", data: { url: "/#/settings/alerts" } });

interface Health {
  lastSent?: number;
  lastError?: { status: number; at: number };
}

// A notification too long for one record goes without the sessions it counts; the phone then closes only older ones of
// its tag.
function plaintext(payload: PushPayload): Buffer {
  const full = Buffer.from(JSON.stringify(payload));
  if (full.length <= MAX_PLAINTEXT || !payload.attention) return full;
  const { attention: _, ...rest } = payload;
  return Buffer.from(JSON.stringify(rest));
}

// Why the push service could not be reached: the error, and the network's code for it (ENOTFOUND and the like) or else
// what its cause says.
function failure(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause as { code?: unknown; message?: unknown; errors?: { code?: unknown }[] } | undefined;
  const code = cause?.code ?? (Array.isArray(cause?.errors) ? cause.errors.find((x) => typeof x?.code === "string")?.code : undefined);
  const why = typeof code === "string" && code ? code : typeof cause?.message === "string" ? cause.message.split("\n")[0].slice(0, 120) : "";
  return why ? `${e.message}, ${why}` : e.message;
}

const madeAt = (payload: PushPayload) => (typeof payload.data.at === "number" ? payload.data.at : 0);

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
  // When the last notification of each tag sent to each subscription was made, by `<endpoint> <tag>`.
  private lastOfTag = new Map<string, number>();
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
    const none = { badge: 0, at: Date.now(), unseen: [], waiting: [] };
    if (!sub) return { subscribed: false, ...none };
    return { subscribed: true, ...(this.notifier?.attention() ?? none) };
  }

  async test(endpoint: unknown): Promise<void> {
    const sub = this.store.get(parseEndpoint(endpoint));
    if (!sub) throw new PushError("not_subscribed");
    const status = await this.deliver(sub, this.stamp(test(sub.prefs.lang)), "normal");
    if (status < 200 || status > 299) throw new PushError("push_failed", status);
  }

  // A notification for every subscribed device, in its language; false when there is none.
  announce(payload: (lang: Lang) => PushPayload): boolean {
    const subs = this.store.list();
    for (const sub of subs) this.send(sub, this.stamp(payload(sub.prefs.lang)), "normal");
    return subs.length > 0;
  }

  // Every notification says when it was made, and what the app icon counts once the broker watches the sessions.
  private stamp(payload: PushPayload): PushPayload {
    return this.notifier?.stamp(payload) ?? { ...payload, data: { ...payload.data, at: Date.now() } };
  }

  watch(manager: SessionManager, hub: Hub): void {
    this.notifier?.close();
    this.manager = manager;
    this.notifier = new Notifier(manager, hub, {
      subscriptions: () => this.store.list(),
      deliver: (sub, payload, urgency) => this.send(sub, payload, urgency),
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

  // tries: how many times the notification was tried before.
  private send(sub: Subscription, payload: PushPayload, urgency: Urgency, tries = 0): void {
    const key = `${sub.endpoint} ${payload.tag}`;
    this.lastOfTag.delete(key);
    this.lastOfTag.set(key, madeAt(payload));
    for (const old of [...this.lastOfTag.keys()].slice(0, -TAGS_KEEP)) this.lastOfTag.delete(old);
    this.deliver(sub, payload, urgency, tries).catch((e) => this.log(`push: sending failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  // Answers the push service's status, 0 when it could not be reached. A 404 or 410 means the subscription is gone;
  // no answer, a 429 or a 5xx is tried again later, as timing.retryMs says, unless tries is undefined; a 401 or 403 to a
  // reused token is sent again at once with a new one. A failure is logged with the service's host and answer, never
  // the notification.
  private async deliver(sub: Subscription, payload: PushPayload, urgency: Urgency, tries?: number): Promise<number> {
    const host = new URL(sub.endpoint).host;
    let answer: { status: number; reason: string; retryAfterSec?: number; reused?: boolean };
    try {
      answer = await this.post(sub, payload, urgency);
      if (answer.reused && (answer.status === 401 || answer.status === 403)) {
        this.log(`push: ${host} answered ${answer.status} to a reused token; signing a new one`);
        answer = await this.post(sub, payload, urgency);
      }
    } catch (e) {
      answer = { status: 0, reason: failure(e) };
    }
    const { status, reason, retryAfterSec } = answer;
    if (status >= 200 && status <= 299) {
      this.health.set(sub.endpoint, { lastSent: Date.now() });
      if (tries) this.log(`push: ${host} took it on try ${tries + 1}`);
      return status;
    }
    this.health.set(sub.endpoint, { ...this.health.get(sub.endpoint), lastError: { status, at: Date.now() } });
    const answered = `push: ${host} answered ${status || "nothing"}${reason ? ` (${reason})` : ""}`;
    if (status === 404 || status === 410) {
      this.log(answered);
      this.store.remove(sub.endpoint);
      this.health.delete(sub.endpoint);
      this.changed();
    } else if (tries !== undefined && (status === 0 || status === 429 || status >= 500)) {
      const next = this.timing.retryMs[tries];
      if (next === undefined) {
        this.log(`${answered}; gave up after ${tries + 1} tries`);
        return status;
      }
      const wait = Math.max(next, Math.min((retryAfterSec ?? 0) * 1000, MAX_RETRY_AFTER_MS));
      this.log(`${answered}; trying again in ${Math.round(wait / 1000)} s`);
      this.later(sub.endpoint, payload, urgency, tries + 1, wait);
    } else this.log(answered);
    return status;
  }

  // A try that is due goes only while the subscription stays, no newer notification of its tag went to it, and its news
  // still counts (Notifier.counts); it leaves stamped anew.
  private later(endpoint: string, payload: PushPayload, urgency: Urgency, tries: number, wait: number): void {
    const timer = setTimeout(() => {
      this.retries.delete(timer);
      const sub = this.store.get(endpoint);
      if (!sub) return;
      const newer = (this.lastOfTag.get(`${endpoint} ${payload.tag}`) ?? 0) > madeAt(payload);
      if (newer || this.notifier?.counts(payload) === false) {
        this.log(`push: not trying ${new URL(endpoint).host} again: ${newer ? "a newer notification replaced it" : "it no longer counts"}`);
        return;
      }
      this.send(sub, this.stamp(payload), urgency, tries);
    }, wait);
    timer.unref();
    this.retries.add(timer);
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
      body: encrypt(plaintext(payload), sub.keys),
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
