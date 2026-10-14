import type { PushPrefs, PushStatus } from "../../broker/src/push/types.ts";
import { ApiError, request } from "./api.ts";

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

// The service worker shows the notifications; tapping one while the app is open sends the app to its session.
export function registerServiceWorker(): void {
  if (!window.isSecureContext || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register(SW).catch(() => {});
  navigator.serviceWorker.addEventListener("message", (e: MessageEvent) => {
    const msg = e.data as { t?: unknown; url?: unknown } | null;
    if (msg?.t !== "navigate" || typeof msg.url !== "string") return;
    const url = new URL(msg.url, location.origin);
    if (url.origin === location.origin && url.hash.startsWith("#/")) location.hash = url.hash;
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

// Call this straight from a tap: iOS asks for permission only in answer to one. A subscription the
// broker does not know may be expired or bound to an older key, so a fresh one replaces it.
export async function turnOn(device: PushDevice, prefs?: Partial<PushPrefs>): Promise<PushDevice> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw Error(permission === "denied" ? "알림 권한이 거부되었습니다" : "알림을 허용하지 않았습니다");
  await (await device.reg.pushManager.getSubscription())?.unsubscribe();
  const sub = await device.reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(device.key) });
  const status = await request<PushStatus>("POST", "/api/push/subscribe", { subscription: sub.toJSON(), prefs });
  return { ...device, sub, status };
}

export async function turnOff(device: PushDevice): Promise<PushDevice> {
  if (device.sub) {
    await request("POST", "/api/push/unsubscribe", { endpoint: device.sub.endpoint });
    await device.sub.unsubscribe().catch(() => false);
  }
  return { ...device, sub: null, status: { subscribed: false } };
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
