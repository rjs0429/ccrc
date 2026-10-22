import { settled } from "../../broker/src/push/attention.ts";
import type { PushBadge, PushPrefs, PushRecent, PushStatus } from "../../broker/src/push/types.ts";
import { ApiError, request } from "./api.ts";
import { lang } from "./i18n/index.ts";

const SW = "/sw.js";
const READY_MS = 10_000;

// Why this browser cannot receive push notifications, when it cannot.
export type PushBlock = "insecure" | "ios_install" | "ios_update" | "unsupported";

export function isIos(): boolean {
  return /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);
}

// iOS offers Web Push only to a web app opened from the Home Screen, from iOS 16.4.
export function pushBlock(): PushBlock | undefined {
  if (!window.isSecureContext) return "insecure";
  if ("serviceWorker" in navigator && "PushManager" in window && "Notification" in window) return undefined;
  if (!isIos()) return "unsupported";
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia("(display-mode: standalone)").matches;
  return standalone ? "ios_update" : "ios_install";
}

// Where the last notification tap took the app, and when: the service worker's message to the open app, or the address
// the worker opened the app at, which it marks with TAP_PARAM.
const TAP_PARAM = "tap";
let tap: { at: number; hash: string } | undefined;

export function lastTap(): { at: number; hash: string } | undefined {
  return tap;
}

// The service worker shows the notifications; tapping one while the app is open sends the app to its session.
export function registerServiceWorker(): void {
  if (!window.isSecureContext || !("serviceWorker" in navigator)) return;
  const opened = new URL(location.href);
  if (opened.searchParams.has(TAP_PARAM)) {
    tap = { at: Date.now(), hash: opened.hash };
    opened.searchParams.delete(TAP_PARAM);
    history.replaceState(history.state, "", `${opened.pathname}${opened.search}${opened.hash}`);
  }
  navigator.serviceWorker.register(SW).catch(() => {});
  navigator.serviceWorker.addEventListener("message", (e: MessageEvent) => {
    const msg = e.data as { t?: unknown; url?: unknown } | null;
    if (msg?.t !== "navigate" || typeof msg.url !== "string") return;
    const url = new URL(msg.url, location.origin);
    if (url.origin !== location.origin) return;
    tap = { at: Date.now(), hash: url.hash };
    if (url.hash.startsWith("#/")) location.hash = url.hash;
  });
}

async function ready(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register(SW);
  let timer = 0;
  const late = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(Error("알림 준비가 끝나지 않았습니다. 앱을 다시 열어 보세요")), READY_MS);
  });
  try {
    return await Promise.race([navigator.serviceWorker.ready, late]);
  } finally {
    clearTimeout(timer);
  }
}

// This browser's side of push: the service worker, the broker's key, the browser's subscription and
// what the broker knows about it.
export interface PushDevice {
  reg: ServiceWorkerRegistration;
  key: string;
  sub: PushSubscription | null;
  status: PushStatus;
}

export async function loadDevice(): Promise<PushDevice> {
  const [reg, { key }] = await Promise.all([ready(), request<{ key: string }>("GET", "/api/push/key")]);
  const sub = await reg.pushManager.getSubscription();
  const status = sub ? await request<PushStatus>("GET", `/api/push/status?endpoint=${encodeURIComponent(sub.endpoint)}`) : { subscribed: false };
  return { reg, key, sub, status };
}

function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(key.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}

// The choices of the subscription turned off last, which the next one on this browser starts with.
const LAST_PREFS = "ccrc.pushPrefs";

function lastPrefs(): Partial<PushPrefs> | undefined {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(LAST_PREFS) ?? "null");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Partial<PushPrefs>) : undefined;
  } catch {
    return undefined;
  }
}

// Call this straight from a tap: iOS asks for permission only in answer to one. A subscription the
// broker does not know may be expired or bound to an older key, so a fresh one replaces it.
export async function turnOn(device: PushDevice, prefs?: Partial<PushPrefs>): Promise<PushDevice> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw Error(permission === "denied" ? "알림 권한이 거부되었습니다" : "알림을 허용하지 않았습니다");
  await (await device.reg.pushManager.getSubscription())?.unsubscribe();
  const sub = await device.reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(device.key) });
  const subscribe = (p?: Partial<PushPrefs>) => request<PushStatus>("POST", "/api/push/subscribe", { subscription: sub.toJSON(), prefs: { ...p, lang: lang() } });
  const kept = prefs ? undefined : lastPrefs();
  const status = await subscribe(prefs ?? kept).catch((e: unknown) => {
    if (kept && e instanceof ApiError && e.body.error === "invalid_prefs") return subscribe();
    throw e;
  });
  closingAll = undefined;
  clearTimeout(closeAllTimer);
  return { ...device, sub, status };
}

export async function turnOff(device: PushDevice): Promise<PushDevice> {
  if (device.status.prefs) {
    try {
      localStorage.setItem(LAST_PREFS, JSON.stringify(device.status.prefs));
    } catch {}
  }
  if (device.sub) {
    await request("POST", "/api/push/unsubscribe", { endpoint: device.sub.endpoint });
    await device.sub.unsubscribe().catch(() => false);
  }
  await clearBadge();
  closingAll = device.reg;
  await closeAll();
  return { ...device, sub: null, status: { subscribed: false } };
}

// The app icon and the notifications change only while notifications reach this browser; without the permission, or
// the Badging API for the icon, nothing changes.
function granted(): boolean {
  return window.isSecureContext && "serviceWorker" in navigator && "Notification" in window && Notification.permission === "granted";
}

function badgeable(): boolean {
  return granted() && "setAppBadge" in navigator;
}

async function clearBadge(): Promise<void> {
  if (badgeable()) await navigator.clearAppBadge().catch(() => {});
}

// iOS leaves a notification open when asked to close it within 30 seconds of showing it.
const CLOSE_AFTER_MS = 31_000;

// Closes this app's notifications that `gone` picks; answers how long until one closed too soon for iOS may be closed,
// 0 when none.
async function closeNotifications(reg: ServiceWorkerRegistration | undefined, gone: (n: Notification, list: Notification[]) => boolean): Promise<number> {
  if (!reg || !granted() || !("getNotifications" in reg)) return 0;
  const list = await reg.getNotifications();
  let wait = 0;
  for (const n of list) {
    if (!gone(n, list)) continue;
    n.close();
    const shown = (n.data as { shown?: unknown } | null)?.shown;
    const age = Date.now() - (typeof shown === "number" ? shown : 0);
    if (age < CLOSE_AFTER_MS) wait = Math.max(wait, CLOSE_AFTER_MS - age);
  }
  return wait;
}

// Turning notifications off closes all of them. With no notification to come, those iOS kept are closed once it lets
// them, while the app is in front, unless notifications are turned on again first.
let closingAll: ServiceWorkerRegistration | undefined;
let closeAllTimer: number | undefined;

async function closeAll(): Promise<void> {
  clearTimeout(closeAllTimer);
  const reg = closingAll;
  if (!reg || document.visibilityState !== "visible") return;
  const wait = await closeNotifications(reg, () => true).catch(() => 0);
  if (closingAll !== reg) return;
  clearTimeout(closeAllTimer);
  if (!wait) closingAll = undefined;
  else if (document.visibilityState === "visible") closeAllTimer = window.setTimeout(() => void closeAll(), wait);
}

document.addEventListener("visibilitychange", () => void closeAll());

// Sets the app icon to what the broker counts for this browser's subscription, the same number its notifications carry,
// and closes the notifications that no longer count by the same state (viewing: the session the app shows). Answers how
// long until one closed too soon for iOS may be closed, 0 when none.
export async function syncAttention(viewing?: string): Promise<number> {
  if (!granted()) return 0;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  const state = sub ? await request<PushBadge>("GET", `/api/push/badge?endpoint=${encodeURIComponent(sub.endpoint)}`) : undefined;
  if (badgeable()) await (state?.badge ? navigator.setAppBadge(state.badge) : navigator.clearAppBadge()).catch(() => {});
  if (!state?.subscribed) return 0;
  return closeNotifications(reg, (n, list) => settled(n, list, state, viewing));
}

// The request this browser was notified of lately that still waits for an answer; none without notifications.
export async function recentRequest(): Promise<PushRecent["request"]> {
  if (!window.isSecureContext || !("serviceWorker" in navigator)) return undefined;
  const sub = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription();
  if (!sub) return undefined;
  return (await request<PushRecent>("GET", `/api/push/recent?endpoint=${encodeURIComponent(sub.endpoint)}`)).request;
}

let langSync = Promise.resolve();

// Notifications are written in the app's language; the broker hears of it whenever what it keeps differs.
export function syncPushLang(): Promise<void> {
  langSync = langSync.catch(() => {}).then(async () => {
    if (!window.isSecureContext || !("serviceWorker" in navigator)) return;
    const sub = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription();
    if (!sub) return;
    const status = await request<PushStatus>("GET", `/api/push/status?endpoint=${encodeURIComponent(sub.endpoint)}`);
    if (status.prefs && status.prefs.lang !== lang()) await request("POST", "/api/push/prefs", { endpoint: sub.endpoint, prefs: { lang: lang() } });
  });
  return langSync;
}

export async function savePrefs(device: PushDevice, prefs: Partial<PushPrefs>): Promise<PushPrefs> {
  if (!device.sub) throw Error("not_subscribed");
  return (await request<{ prefs: PushPrefs }>("POST", "/api/push/prefs", { endpoint: device.sub.endpoint, prefs })).prefs;
}

export async function sendTest(device: PushDevice): Promise<void> {
  if (!device.sub) throw Error("not_subscribed");
  await request("POST", "/api/push/test", { endpoint: device.sub.endpoint });
}

// A failed push request as a message for toast(), which words the broker's codes (labels.ts).
export function pushErrorText(e: unknown): string {
  if (e instanceof ApiError && e.body.error === "push_failed") return `push_failed ${Number(e.body.status) || 0}`;
  return e instanceof Error ? e.message : String(e);
}
