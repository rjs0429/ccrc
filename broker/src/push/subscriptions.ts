import fs from "node:fs";
import path from "node:path";
import { ECDH } from "node:crypto";
import { writeFileAtomic } from "../config.ts";
import type { ClientKeys } from "./encrypt.ts";
import { DEFAULT_PREFS, VSCODE_DELAYS, type PushPrefs } from "./types.ts";
import { generateVapidKeys, type VapidKeys } from "./vapid.ts";

export interface Subscription {
  endpoint: string;
  keys: ClientKeys;
  // The tailnet machine that subscribed ("local" for this machine).
  device: string;
  // The https origin the app subscribed from; push services get it as the contact for this broker.
  origin?: string;
  createdAt: number;
  prefs: PushPrefs;
}

// A refused request; the message is a code the web client knows. status: the push service's answer.
export class PushError extends Error {
  readonly status: number;

  constructor(code: string, status = 0) {
    super(code);
    this.status = status;
  }
}

const MAX_ENDPOINT = 2048;
const MAX_SUBSCRIPTIONS = 10;
const BASE64 = /^[A-Za-z0-9_+/-]+={0,2}$/;
// The push services of Safari, Chrome, Firefox and Edge. Subscriptions elsewhere are refused, so the
// broker never posts to other hosts.
const SERVICES = [".push.apple.com", ".googleapis.com", ".google.com", ".push.services.mozilla.com", ".notify.windows.com"];

export function isPushService(url: URL): boolean {
  return url.protocol === "https:" && !url.port && !url.username && !url.password && SERVICES.some((s) => url.hostname.endsWith(s));
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export function parseEndpoint(v: unknown): string {
  if (typeof v !== "string" || !v || v.length > MAX_ENDPOINT || !URL.canParse(v)) throw new PushError("invalid_endpoint");
  return v;
}

function keyBytes(v: unknown, size: number): Buffer | undefined {
  if (typeof v !== "string" || v.length > 128 || !BASE64.test(v)) return undefined;
  const b = Buffer.from(v, "base64url");
  return b.length === size ? b : undefined;
}

function onCurve(point: Buffer): boolean {
  try {
    ECDH.convertKey(point, "prime256v1");
    return point[0] === 4;
  } catch {
    return false;
  }
}

// A browser's PushSubscription JSON: an https endpoint at a known push service, a P-256 public key and a 16-byte auth secret.
export function parseSubscription(v: unknown, allow: (url: URL) => boolean): { endpoint: string; keys: ClientKeys } {
  const o = obj(v);
  const endpoint = parseEndpoint(o?.endpoint);
  if (!allow(new URL(endpoint))) throw new PushError("unsupported_push_service");
  const keys = obj(o?.keys);
  const p256dh = keyBytes(keys?.p256dh, 65);
  const auth = keyBytes(keys?.auth, 16);
  if (!p256dh || !auth || !onCurve(p256dh)) throw new PushError("invalid_subscription");
  return { endpoint, keys: { p256dh: p256dh.toString("base64url"), auth: auth.toString("base64url") } };
}

// Applies the fields given in `v` over `base`; unknown fields are ignored.
export function parsePrefs(v: unknown, base: PushPrefs): PushPrefs {
  if (v === undefined) return base;
  const o = obj(v);
  if (!o) throw new PushError("invalid_prefs");
  const out = { ...base };
  if (o.vscodeDelaySec !== undefined) {
    if (typeof o.vscodeDelaySec !== "number" || !VSCODE_DELAYS.includes(o.vscodeDelaySec)) throw new PushError("invalid_prefs");
    out.vscodeDelaySec = o.vscodeDelaySec;
  }
  for (const name of ["turnDone", "details"] as const) {
    if (o[name] === undefined) continue;
    if (typeof o[name] !== "boolean") throw new PushError("invalid_prefs");
    out[name] = o[name];
  }
  return out;
}

interface PushFile {
  vapid?: VapidKeys;
  subscriptions: Subscription[];
}

// The VAPID key pair and the subscribed devices, in <dir>/push.json readable by this user only.
export class PushStore {
  readonly file: string;
  private data?: PushFile;

  constructor(dir: string) {
    this.file = path.join(dir, "push.json");
  }

  private load(): PushFile {
    if (this.data) return this.data;
    const raw = fs.existsSync(this.file) ? (JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<PushFile>) : {};
    this.data = {
      vapid: raw.vapid,
      subscriptions: (raw.subscriptions ?? []).map((s) => ({ ...s, prefs: { ...DEFAULT_PREFS, ...s.prefs } })),
    };
    return this.data;
  }

  private save(): void {
    writeFileAtomic(this.file, JSON.stringify(this.data, null, 2) + "\n");
  }

  // Made on first use and then kept: every subscription is bound to this key.
  get vapid(): VapidKeys {
    const data = this.load();
    if (!data.vapid) {
      data.vapid = generateVapidKeys();
      this.save();
    }
    return data.vapid;
  }

  list(): Subscription[] {
    return [...this.load().subscriptions];
  }

  get(endpoint: string): Subscription | undefined {
    return this.load().subscriptions.find((s) => s.endpoint === endpoint);
  }

  // Adds or replaces the subscription for its endpoint; past the limit the oldest ones go.
  put(sub: Subscription): void {
    const data = this.load();
    const rest = data.subscriptions.filter((s) => s.endpoint !== sub.endpoint);
    data.subscriptions = [...rest, sub].sort((a, b) => a.createdAt - b.createdAt).slice(-MAX_SUBSCRIPTIONS);
    this.save();
  }

  remove(endpoint: string): Subscription | undefined {
    const data = this.load();
    const sub = data.subscriptions.find((s) => s.endpoint === endpoint);
    if (!sub) return undefined;
    data.subscriptions = data.subscriptions.filter((s) => s !== sub);
    this.save();
    return sub;
  }
}
