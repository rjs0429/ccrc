import { inThisTailnet } from "../devices.ts";
import type { Runner } from "./io.ts";

// What setup reads from `tailscale status --json` and `tailscale serve status --json`.

export interface TsNode {
  HostName?: string;
  DNSName?: string;
  OS?: string;
  Online?: boolean;
  UserID?: number;
  Tags?: string[];
  ShareeNode?: boolean;
}

export interface TsStatus {
  BackendState?: string;
  Self?: TsNode;
  Peer?: Record<string, TsNode>;
  User?: Record<string, { LoginName?: string }>;
  CurrentTailnet?: { MagicDNSEnabled?: boolean; MagicDNSSuffix?: string };
  CertDomains?: string[] | null;
}

interface ServeConfig {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

async function json(run: Runner, args: string[]): Promise<Obj | undefined> {
  const r = await run.run("tailscale", args, { timeoutMs: 10_000 });
  if (r.code !== 0) return undefined;
  try {
    const v: unknown = JSON.parse(r.stdout);
    return isObject(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

// None when Tailscale is missing or its daemon does not answer.
export async function tailscaleStatus(run: Runner): Promise<TsStatus | undefined> {
  return (await json(run, ["status", "--json"])) as TsStatus | undefined;
}

// The machine's first DNS label, the name allowedDevices takes.
export function machineName(n: TsNode): string {
  return (n.DNSName ?? "").split(".")[0] || (n.HostName ?? "").toLowerCase();
}

export function dnsName(n: TsNode | undefined): string | undefined {
  return n?.DNSName?.replace(/\.$/, "") || undefined;
}

export interface Phone {
  name: string;
  os: string;
  online: boolean;
}

export interface Phones {
  // Those of the Tailscale user this machine belongs to.
  mine: Phone[];
  others: Phone[];
  // That user's login name, when the status gives it.
  user?: string;
  // Why no machine can count as that user's, when the status does not tell.
  unknown?: string;
}

// A tagged machine belongs to its tags, whatever user the status gives it.
function owner(n: TsNode | undefined): number | undefined {
  return n && !n.Tags?.length && typeof n.UserID === "number" && n.UserID !== 0 ? n.UserID : undefined;
}

// iOS and Android machines of the tailnet that the broker can let in, online ones first, by whose they are.
export function phones(st: TsStatus | undefined): Phones {
  const self = st?.Self;
  const me = owner(self);
  const out: Phones = { mine: [], others: [] };
  const found = Object.values(st?.Peer ?? {})
    .filter((p) => /^(ios|android)$/i.test(p.OS ?? "") && inThisTailnet(p, self) && machineName(p))
    .sort((a, b) => Number(Boolean(b.Online)) - Number(Boolean(a.Online)) || machineName(a).localeCompare(machineName(b)));
  for (const p of found) (me !== undefined && owner(p) === me ? out.mine : out.others).push({ name: machineName(p), os: p.OS!, online: Boolean(p.Online) });
  const user = me === undefined ? undefined : st?.User?.[String(me)]?.LoginName;
  if (user) out.user = user;
  if (st && self?.Tags?.length) out.unknown = `this machine is tagged (${self.Tags.join(", ")}), so it belongs to no Tailscale user`;
  else if (st && me === undefined) out.unknown = "Tailscale here does not say which user each machine belongs to";
  return out;
}

export function httpsReady(st: TsStatus | undefined): boolean {
  return Boolean(st?.CurrentTailnet?.MagicDNSEnabled) && (st?.CertDomains?.length ?? 0) > 0;
}

export interface Served {
  httpsPort: number;
  proxy: string;
}

// Every HTTPS port `tailscale serve` passes on at "/", with where it goes.
export async function servedPorts(run: Runner): Promise<Served[] | undefined> {
  const v = (await json(run, ["serve", "status", "--json"])) as ServeConfig | undefined;
  if (!v) return undefined;
  const out: Served[] = [];
  for (const [hostPort, web] of Object.entries(v.Web ?? {})) {
    const port = Number(hostPort.split(":").at(-1));
    const proxy = web?.Handlers?.["/"]?.Proxy;
    if (Number.isInteger(port) && proxy) out.push({ httpsPort: port, proxy });
  }
  return out;
}

// Whether a serve proxy target is the broker on this machine.
export function reachesBroker(proxy: string, brokerPort: number): boolean {
  const m = /^(?:https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\]):(\d+)\/?$/.exec(proxy.trim());
  return Boolean(m) && Number(m![2]) === brokerPort;
}
