import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { Doctor } from "../doctor.ts";
import { brokerVersion, isInstalled, readInstallInfo } from "../install.ts";
import { paths } from "../paths.ts";
import { inBrokerService } from "../service-cgroup.ts";
import { SetupUsageError, runSetup, type Ctx, type SetupOptions, type Where } from "./engine.ts";
import { TerminalPrompt, realRunner, withDefaults } from "./io.ts";
import { STEPS, STEP_IDS } from "./steps.ts";
import { runUninstall } from "./uninstall.ts";

export const SETUP_USAGE = `usage: ccrc setup [--yes] [--allow-sudo] [--dry-run] [--only ids] [--skip ids] [--no-system] [--no-vscode] [--no-serve] [--https-port N]
  Checks each step and does the ones not yet in place; run it again to finish or repair.
  --yes         take the default answer to every question but sudo. Steps that need you still wait, but devices
                does not: it adds your phone only when you have exactly one
  --allow-sudo  without a terminal, let the steps that need sudo run; with one, each is still asked.
                Without either, those steps are left as needing sudo consent
  --dry-run     show what is in place and what setup would do, changing nothing
  --only, --skip  comma-separated step ids: ${STEP_IDS.join(", ")}
  --no-system   leave out steps that use sudo or change the system (Tailscale, the service)
  --no-vscode   leave VS Code's settings alone
  --no-serve    do not set up tailscale serve
  --https-port  the tailnet HTTPS port for the phone (default 8443)`;

export const UNINSTALL_USAGE = `usage: ccrc uninstall [--purge] [--yes] [--dry-run] [--no-system]
  Removes VS Code's wrapper setting (first), the service, tailscale serve, and the installed versions.
  --purge       remove settings and state as well`;

function real(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}

// The Node the service is to run bin/ccrc with: the one this process runs on, by the most lasting name it has.
function serviceNode(dataDir: string): string {
  if (process.env.CCRC_NODE) return process.env.CCRC_NODE;
  const self = real(process.execPath);
  for (const p of [path.join(dataDir, "node", "bin", "node"), readInstallInfo()?.node]) if (p && real(p) === self) return p;
  return process.execPath;
}

function distro(): string | undefined {
  try {
    return /^ID="?([^"\n]+)"?$/m.exec(fs.readFileSync("/etc/os-release", "utf8"))?.[1];
  } catch {
    return undefined;
  }
}

const KEPT_ENV = ["CCRC_CONFIG_DIR", "CCRC_STATE_DIR", "CCRC_DATA_DIR", "CLAUDE_CONFIG_DIR", "CCRC_VSCODE_EXTENSIONS_DIR"];

export function where(): Where {
  const installed = isInstalled();
  const bin = installed ? path.join(paths.dataDir, "current", "bin") : path.join(paths.codeRoot, "bin");
  return {
    home: paths.home,
    user: os.userInfo().username,
    configDir: paths.configDir,
    configFile: paths.configFile,
    credentialsFile: paths.credentialsFile,
    apiKeyFile: paths.apiKeyFile,
    stateDir: paths.stateDir,
    dataDir: paths.dataDir,
    xdgConfigHome: paths.xdgConfigHome,
    claudeProjectsDir: paths.claudeProjectsDir,
    codeRoot: paths.codeRoot,
    installed,
    ccrc: path.join(bin, "ccrc"),
    wrapper: path.join(bin, "ccrc-wrapper"),
    vscodeUserDir: paths.vscodeUserDir,
    extensionsDir: paths.vscodeExtensionsDir,
    platform: `${process.platform}-${process.arch}`,
    distro: distro(),
    node: serviceNode(paths.dataDir),
    path: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    keepEnv: Object.fromEntries(KEPT_ENV.flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : []))),
    version: brokerVersion(),
  };
}

async function ping(port: number): Promise<string | null | undefined> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return undefined;
    const v = (await r.json()) as { version?: unknown };
    return typeof v.version === "string" ? v.version : null;
  } catch {
    return undefined;
  }
}

function realCtx(o: SetupOptions): Ctx {
  const prompt = new TerminalPrompt();
  const doctor = new Doctor();
  return {
    o,
    at: where(),
    run: realRunner,
    ask: o.yes ? withDefaults(prompt) : prompt,
    sudoAsk: prompt,
    out: (line) => console.log(line),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    ping,
    doctor: { last: () => doctor.last(), extensionVersion: () => doctor.extension()?.version, run: () => doctor.run() },
    pollMs: 5000,
    pingWaitMs: 20_000,
    now: () => new Date(),
    inService: () => inBrokerService(),
  };
}

const list = (v: string | undefined) => (v === undefined ? undefined : v.split(",").map((s) => s.trim()).filter(Boolean));

export function parseSetupArgs(args: string[]): SetupOptions {
  const { values: v } = parseArgs({
    args,
    strict: true,
    options: {
      yes: { type: "boolean", short: "y" },
      "allow-sudo": { type: "boolean" },
      "dry-run": { type: "boolean" },
      only: { type: "string" },
      skip: { type: "string" },
      "no-system": { type: "boolean" },
      "no-vscode": { type: "boolean" },
      "no-serve": { type: "boolean" },
      "https-port": { type: "string" },
    },
  });
  const port = v["https-port"] === undefined ? 8443 : Number(v["https-port"]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SetupUsageError(`--https-port takes a port number, not ${v["https-port"]}`);
  return {
    yes: Boolean(v.yes),
    allowSudo: Boolean(v["allow-sudo"]),
    dryRun: Boolean(v["dry-run"]),
    noSystem: Boolean(v["no-system"]),
    noVscode: Boolean(v["no-vscode"]),
    noServe: Boolean(v["no-serve"]),
    httpsPort: port,
    ...(v.only === undefined ? {} : { only: list(v.only) }),
    skip: list(v.skip) ?? [],
  };
}

// ccrc is set up for the user who runs it; as root it would write root's settings and a service for root.
export function rootRefusal(command: string, uid = process.getuid?.()): string | undefined {
  return uid === 0 ? `ccrc ${command}: do not run this as root (or with sudo): run it as the user ccrc is for; it asks before each step that needs sudo` : undefined;
}

function refuseRoot(command: string): void {
  const why = rootRefusal(command);
  if (!why) return;
  console.error(why);
  process.exit(1);
}

function usage(e: unknown, text: string): never {
  console.error(`${(e as Error).message}\n${text}`);
  process.exit(2);
}

export async function setup(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) return console.log(SETUP_USAGE);
  let o: SetupOptions;
  try {
    o = parseSetupArgs(args);
  } catch (e) {
    usage(e, SETUP_USAGE);
  }
  refuseRoot("setup");
  const ctx = realCtx(o);
  console.log(`ccrc setup: ${ctx.at.version ?? "unknown version"}, ${ctx.at.installed ? "installed" : "from"} ${ctx.at.codeRoot}`);
  try {
    const r = await runSetup([...STEPS], ctx);
    if (!r.ok) process.exitCode = 1;
  } catch (e) {
    if (e instanceof SetupUsageError) usage(e, SETUP_USAGE);
    throw e;
  }
}

export async function uninstall(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) return console.log(UNINSTALL_USAGE);
  let v: Record<string, boolean | undefined>;
  try {
    v = parseArgs({ args, strict: true, options: { purge: { type: "boolean" }, yes: { type: "boolean", short: "y" }, "dry-run": { type: "boolean" }, "no-system": { type: "boolean" } } }).values;
  } catch (e) {
    usage(e, UNINSTALL_USAGE);
  }
  refuseRoot("uninstall");
  const prompt = new TerminalPrompt();
  const ok = await runUninstall({
    o: { purge: Boolean(v.purge), yes: Boolean(v.yes), dryRun: Boolean(v["dry-run"]), noSystem: Boolean(v["no-system"]) },
    at: where(),
    run: realRunner,
    ask: prompt,
    out: (line) => console.log(line),
    now: () => new Date(),
    inService: () => inBrokerService(),
  });
  if (!ok) process.exitCode = 1;
}
