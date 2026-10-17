import { execFile } from "node:child_process";

export type DeviceCheck = { ok: true; device: string } | { ok: false; ip?: string };

interface TailscaleNode {
  HostName?: string;
  DNSName?: string;
  TailscaleIPs?: string[];
}

interface TailscaleStatus {
  Self?: TailscaleNode;
  Peer?: Record<string, TailscaleNode>;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const REFRESH_MS = 60_000;
const MISS_REFRESH_MS = 10_000;

export function runTailscaleStatus(): Promise<TailscaleStatus> {
  return new Promise((resolve, reject) => {
    execFile("tailscale", ["status", "--json"], { timeout: 5000, maxBuffer: 8 << 20 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(stdout) as TailscaleStatus);
      } catch (e) {
        reject(e);
      }
    });
  });
}

function normalizeIp(ip: string): string {
  const v = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return v.startsWith("::ffff:") && v.includes(".") ? v.slice(7) : v;
}

// Requests through `tailscale serve` arrive from loopback with the tailnet client address as the
// last X-Forwarded-For entry. Only allowed machines (by tailnet name) get through; a request
// without the header comes from this machine.
export class DeviceGate {
  private names: Set<string>;
  private allowLocal: boolean;
  private status: () => Promise<TailscaleStatus>;
  private ipToName = new Map<string, string>();
  private refreshedAt = 0;

  constructor(names: string[], allowLocal: boolean, status = runTailscaleStatus) {
    this.names = new Set(names.map((n) => n.toLowerCase()));
    this.allowLocal = allowLocal;
    this.status = status;
  }

  // Takes a changed config: the next request maps addresses to names again.
  update(names: string[], allowLocal: boolean): void {
    this.names = new Set(names.map((n) => n.toLowerCase()));
    this.allowLocal = allowLocal;
    this.ipToName = new Map();
    this.refreshedAt = 0;
  }

  // A request this machine made itself, not one `tailscale serve` passed on.
  static direct(remoteAddress: string | undefined, forwardedFor: string | string[] | undefined): boolean {
    return Boolean(remoteAddress && LOOPBACK.has(remoteAddress)) && !(Array.isArray(forwardedFor) ? forwardedFor.join("") : forwardedFor);
  }

  async refresh(): Promise<void> {
    const st = await this.status();
    const map = new Map<string, string>();
    for (const node of [st.Self, ...Object.values(st.Peer ?? {})]) {
      if (!node) continue;
      const label = (node.DNSName ?? "").split(".")[0].toLowerCase();
      const host = (node.HostName ?? "").toLowerCase();
      const name = this.names.has(label) ? label : this.names.has(host) ? host : undefined;
      if (!name) continue;
      for (const ip of node.TailscaleIPs ?? []) map.set(normalizeIp(ip), name);
    }
    this.ipToName = map;
    this.refreshedAt = Date.now();
  }

  async check(remoteAddress: string | undefined, forwardedFor: string | string[] | undefined): Promise<DeviceCheck> {
    if (!remoteAddress || !LOOPBACK.has(remoteAddress)) return { ok: false };
    const header = Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor;
    if (!header) return this.allowLocal ? { ok: true, device: "local" } : { ok: false };

    const ip = normalizeIp(header.split(",").filter((s) => s.trim()).at(-1) ?? "");
    const age = Date.now() - this.refreshedAt;
    if (age > REFRESH_MS || (!this.ipToName.has(ip) && age > MISS_REFRESH_MS)) {
      await this.refresh().catch(() => {});
    }
    const name = this.ipToName.get(ip);
    return name ? { ok: true, device: name } : { ok: false, ip };
  }
}
