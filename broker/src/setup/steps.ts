import fs from "node:fs";
import path from "node:path";
import { readApiKey, writeApiKey } from "../api-key.ts";
import { bundledClaude, extensionFolders } from "../claude-cli.ts";
import {
  BROKER_SESSIONS,
  FOLLOW_VSCODE,
  SCHEMA_VERSION,
  applyMigrations,
  checkConfig,
  newConfig,
  parseConfigText,
  readConfig,
  writeConfig,
  type BrokerSessions,
} from "../config.ts";
import { migrateConfigFile } from "../migrate.ts";
import { PushStore } from "../push/subscriptions.ts";
import type { Ctx, Step } from "./engine.ts";
import type { Choice } from "./io.ts";
import { SERVICE, unitFile, unitMatches, unitText } from "./service.ts";
import { dnsName, httpsReady, phones, reachesBroker, servedPorts, tailscaleStatus } from "./tailscale.ts";
import { WRAPPER_SETTING, changeSetting, readSettingsFile, settingsFile } from "./vscode-settings.ts";

type Obj = Record<string, unknown>;

const CLI_INSTALL = "curl -fsSL https://claude.ai/install.sh | bash";
const TAILSCALE_INSTALL = "curl -fsSL https://tailscale.com/install.sh | sh";
const ADMIN_DNS = "https://login.tailscale.com/admin/dns";

async function must(ctx: Ctx, cmd: string, args: string[], attached = false): Promise<void> {
  const shown = [cmd, ...args].join(" ");
  if (attached) {
    const code = await ctx.run.attached(cmd, args);
    if (code !== 0) throw Error(`\`${shown}\` failed (exit code ${code})`);
    return;
  }
  const r = await ctx.run.run(cmd, args);
  if (r.code !== 0) throw Error(`\`${shown}\` failed: ${(r.stderr || r.stdout).trim().split("\n").pop() || `exit code ${r.code}`}`);
}

// config.json brought to this version's format in memory; none when there is no file yet.
function configRaw(ctx: Ctx): Obj | undefined {
  const file = ctx.at.configFile;
  if (!fs.existsSync(file)) return undefined;
  return applyMigrations(parseConfigText(fs.readFileSync(file, "utf8"), file), file).config;
}

// Changes config.json, migrating it first (with its backup) and checking the result as the broker will read it.
function changeConfig(ctx: Ctx, change: (raw: Obj) => void): void {
  const file = ctx.at.configFile;
  migrateConfigFile({ configFile: file, stateDir: ctx.at.stateDir, now: ctx.now() });
  const raw: Obj = fs.existsSync(file) ? parseConfigText(fs.readFileSync(file, "utf8"), file) : { schemaVersion: SCHEMA_VERSION };
  change(raw);
  checkConfig(applyMigrations(raw, file).config, file);
  writeConfig(raw, file);
}

function brokerPort(ctx: Pick<Ctx, "at">): number {
  return fs.existsSync(ctx.at.configFile) ? readConfig(ctx.at.configFile).config.port : newConfig().port;
}

function findClaude(ctx: Ctx): { bin: string; label: string; vscode: boolean } | undefined {
  const ext = extensionFolders(ctx.at.extensionsDir, ctx.at.platform)[0];
  if (ext && fs.existsSync(bundledClaude(ext.dir))) return { bin: bundledClaude(ext.dir), label: `VS Code extension ${ext.version}`, vscode: true };
  const local = path.join(ctx.at.home, ".local", "bin", "claude");
  const cli = ctx.run.which("claude") ?? (fs.existsSync(local) ? local : undefined);
  return cli ? { bin: cli, label: `CLI ${cli}`, vscode: false } : undefined;
}

const claude: Step = {
  id: "claude",
  title: "Claude Code installed and signed in",
  human: true,
  waits: true,
  async check(ctx) {
    const found = findClaude(ctx);
    if (!found) return { ok: false, detail: "neither the VS Code extension nor the CLI found" };
    const r = await ctx.run.run(found.bin, ["auth", "status", "--json"], { timeoutMs: 20_000 });
    let signedIn = false;
    try {
      signedIn = (JSON.parse(r.stdout) as Obj).loggedIn === true;
    } catch {}
    return { ok: signedIn, detail: `${found.label}, ${signedIn ? "signed in" : "not signed in"}` };
  },
  plan(ctx) {
    if (findClaude(ctx)) return ["you sign in to Claude Code; setup waits until it sees the login"];
    const code = ctx.run.which("code");
    return [
      code && !ctx.o.noSystem ? "install the VS Code extension: code --install-extension anthropic.claude-code" : `you install Claude Code: the VS Code extension, or the CLI with ${CLI_INSTALL}`,
      "you sign in to Claude Code; setup waits until it sees the login",
    ];
  },
  async apply(ctx) {
    if (!findClaude(ctx)) {
      const code = ctx.run.which("code");
      if (code && !ctx.o.noSystem && (await ctx.ask.confirm("Install the Claude Code extension in VS Code now?", true))) {
        await must(ctx, code, ["--install-extension", "anthropic.claude-code"], true);
      } else {
        ctx.out("Install Claude Code, either way:");
        ctx.out("  - VS Code: install the extension \"Claude Code\" (anthropic.claude-code) from the Extensions view.");
        ctx.out(`  - Terminal: ${CLI_INSTALL}`);
        ctx.out("  See https://docs.claude.com/en/docs/claude-code/setup");
      }
    }
    ctx.out("Sign in to Claude Code: open the Claude Code panel in VS Code and sign in, or run `claude` in a terminal and type /login.");
  },
};

const tailscaleInstall: Step = {
  id: "tailscale-install",
  title: "Tailscale installed and running",
  sudo: true,
  system: true,
  async check(ctx) {
    if (!ctx.run.which("tailscale")) return { ok: false, detail: "not installed" };
    const st = await tailscaleStatus(ctx.run);
    return st ? { ok: true, detail: `tailscaled ${st.BackendState ?? "running"}` } : { ok: false, detail: "tailscaled does not answer" };
  },
  plan(ctx) {
    if (ctx.run.which("tailscale")) return ["sudo systemctl enable --now tailscaled"];
    if (ctx.at.distro === "arch") return ["sudo pacman -S --needed tailscale", "sudo systemctl enable --now tailscaled"];
    return [`${TAILSCALE_INSTALL}  (Tailscale's own installer; it uses sudo)`];
  },
  async apply(ctx) {
    if (!ctx.run.which("tailscale")) {
      if (ctx.at.distro === "arch") await must(ctx, "sudo", ["pacman", "-S", "--needed", "tailscale"], true);
      else return must(ctx, "sh", ["-c", TAILSCALE_INSTALL], true);
    }
    await must(ctx, "sudo", ["systemctl", "enable", "--now", "tailscaled"], true);
  },
};

const tailscaleLogin: Step = {
  id: "tailscale-login",
  title: "This machine signed in to Tailscale",
  sudo: true,
  system: true,
  human: true,
  waits: true,
  needs: ["tailscale-install"],
  async check(ctx) {
    const st = await tailscaleStatus(ctx.run);
    if (st?.BackendState === "Running") return { ok: true, detail: dnsName(st.Self) };
    return { ok: false, detail: st ? `state ${st.BackendState ?? "unknown"}` : "Tailscale does not answer" };
  },
  plan: (ctx) => [
    `sudo tailscale up --operator=${ctx.at.user} --qr: it shows a sign-in link and QR code`,
    "you sign in there; without a Tailscale account, that page makes one (Google, Microsoft, GitHub or Apple)",
  ],
  apply: (ctx) => must(ctx, "sudo", ["tailscale", "up", `--operator=${ctx.at.user}`, "--qr"], true),
};

const tailscaleOperator: Step = {
  id: "tailscale-operator",
  title: "Tailscale serve usable without sudo",
  sudo: true,
  system: true,
  needs: ["tailscale-login"],
  async check(ctx) {
    const r = await ctx.run.run("tailscale", ["serve", "status"]);
    return r.code === 0 ? { ok: true } : { ok: false, detail: (r.stderr || r.stdout).trim().split("\n")[0] || `exit code ${r.code}` };
  },
  plan: (ctx) => [`sudo tailscale set --operator=${ctx.at.user}`],
  apply: (ctx) => must(ctx, "sudo", ["tailscale", "set", `--operator=${ctx.at.user}`], true),
};

const https: Step = {
  id: "https",
  title: "MagicDNS and HTTPS certificates on in the tailnet",
  human: true,
  waits: true,
  needs: ["tailscale-login"],
  async check(ctx) {
    const st = await tailscaleStatus(ctx.run);
    if (!st) return { ok: false, detail: "Tailscale does not answer" };
    if (httpsReady(st)) return { ok: true, detail: st.CertDomains![0] };
    return { ok: false, detail: st.CurrentTailnet?.MagicDNSEnabled ? "HTTPS certificates off" : "MagicDNS off" };
  },
  plan: () => [`you turn on MagicDNS and HTTPS certificates at ${ADMIN_DNS}; setup waits until Tailscale reports them`],
  async apply(ctx) {
    ctx.out(`In the Tailscale admin console, ${ADMIN_DNS}:`);
    ctx.out("  1. Turn on MagicDNS, if it is off.");
    ctx.out("  2. Under HTTPS Certificates, choose Enable HTTPS.");
    ctx.out("The names of machines that get a certificate are published in the public Certificate Transparency logs.");
  },
};

const devices: Step = {
  id: "devices",
  title: "Phone allowed to connect",
  human: true,
  needs: ["tailscale-login"],
  async check(ctx) {
    const list = configRaw(ctx)?.allowedDevices;
    return Array.isArray(list) && list.length ? { ok: true, detail: list.join(", ") } : { ok: false, detail: "no device allowed yet" };
  },
  async plan(ctx) {
    const found = phones(await tailscaleStatus(ctx.run));
    if (!found.length) return ["you install the Tailscale app on the phone and sign in with the same account; setup waits for it", "you choose the phone, which goes into allowedDevices"];
    return [`you choose from ${found.map((p) => p.name).join(", ")}; the choice goes into allowedDevices`];
  },
  async apply(ctx) {
    let found = phones(await tailscaleStatus(ctx.run));
    if (!found.length) {
      ctx.out("No phone is in this tailnet yet. On the phone, install the Tailscale app and sign in with the same account as this machine.");
      ctx.out(ctx.ask.interactive ? `Waiting for it; press Enter to look again, or type "skip" to leave it for later.` : "Waiting for it.");
      while (!found.length) {
        const typed = await ctx.ask.wait(ctx.pollMs);
        found = phones(await tailscaleStatus(ctx.run));
        if (!found.length && typed !== undefined && /^s(kip)?$/i.test(typed.trim())) return;
      }
    }
    const choices: Choice[] = found.map((p) => ({ value: p.name, label: `${p.name} (${p.os}${p.online ? "" : ", offline"})` }));
    const online = found.filter((p) => p.online).map((p) => p.name);
    const picked = await ctx.ask.pick("Which machines may use ccrc?", choices, online.length ? online : [found[0].name]);
    if (!picked.length) return;
    changeConfig(ctx, (raw) => {
      raw.allowedDevices = picked;
    });
  },
};

const account: Step = {
  id: "account",
  title: "ccrc login (ID and password)",
  human: true,
  async check(ctx) {
    if (!fs.existsSync(ctx.at.credentialsFile)) return { ok: false, detail: "not set" };
    const user = (JSON.parse(fs.readFileSync(ctx.at.credentialsFile, "utf8")) as { user?: { id?: string } }).user;
    return user?.id ? { ok: true, detail: `ID ${user.id}` } : { ok: false, detail: "not set" };
  },
  plan: () => ["you choose the ID and password the phone signs in with (ccrc passwd)"],
  async apply(ctx) {
    if (!ctx.ask.interactive) {
      ctx.out("This needs a terminal: run `ccrc passwd` in one.");
      return;
    }
    ctx.out("Choose the ID and password the phone signs in with.");
    await must(ctx, ctx.at.ccrc, ["passwd"], true);
  },
};

function brokerSessionChoices(ctx: Ctx): Choice<BrokerSessions>[] {
  return [
    {
      value: "off",
      label: "off: the phone drives VS Code's sessions only (default)",
      detail: "The phone shows and drives the Claude Code sessions VS Code runs, and reads past ones.\nIt does not start Claude Code itself.",
    },
    {
      value: "apiKey",
      label: "apiKey: sessions the phone starts sign in with an Anthropic API key",
      detail: `Use is billed to the key. It is kept in ${ctx.at.apiKeyFile}, readable only by you.`,
    },
    {
      value: "subscription",
      label: "subscription: sessions the phone starts use this machine's Claude Code login",
      detail: "Anthropic's documentation asks tools built on the Agent SDK to sign in with an API key.\nChoose this only for your own use, with your own login on your own machine.",
    },
  ];
}

const config: Step = {
  id: "config",
  title: "Settings: folders, Claude Code, broker sessions",
  human: true,
  async check(ctx) {
    const raw = configRaw(ctx);
    if (!raw) return { ok: false, detail: "no config.json yet" };
    const roots = Array.isArray(raw.roots) ? (raw.roots as string[]) : [];
    const missing = [
      !roots.length && "roots",
      raw.claudePath === undefined && claudePathFor(ctx) !== FOLLOW_VSCODE && "claudePath",
      raw.brokerSessions === undefined && "brokerSessions",
      raw.brokerSessions === "apiKey" && !readApiKey(ctx.at.apiKeyFile) && "the API key",
    ].filter(Boolean);
    if (missing.length) return { ok: false, detail: `to set: ${missing.join(", ")}` };
    return { ok: true, detail: `brokerSessions ${String(raw.brokerSessions)}, roots ${roots.join(", ")}` };
  },
  plan(ctx) {
    const raw = configRaw(ctx) ?? {};
    const out: string[] = [];
    if (!Array.isArray(raw.roots) || !raw.roots.length) out.push(`ask which folders new sessions may start in (default ${ctx.at.home})`);
    if (raw.claudePath === undefined) out.push(`set claudePath to ${claudePathFor(ctx)}`);
    if (raw.brokerSessions === undefined) out.push(`ask how sessions the phone starts sign in: ${BROKER_SESSIONS.join(", ")} (default off)`);
    if (raw.brokerSessions === "apiKey" || raw.brokerSessions === undefined) out.push("for apiKey, ask for the key (typed hidden)");
    out.push(`write ${ctx.at.configFile}`);
    return out;
  },
  async apply(ctx) {
    const raw = configRaw(ctx) ?? {};
    const answers: Obj = {};
    if (!Array.isArray(raw.roots) || !raw.roots.length) {
      const text = await ctx.ask.text("Folders new sessions may start in, separated by commas", ctx.at.home);
      answers.roots = text
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => path.resolve(ctx.at.home, s.replace(/^~(?=$|\/)/, ctx.at.home)));
    }
    if (raw.claudePath === undefined) answers.claudePath = claudePathFor(ctx);
    let mode = raw.brokerSessions as BrokerSessions | undefined;
    if (mode === undefined) {
      mode = await ctx.ask.choose("How may sessions the phone starts sign in?", brokerSessionChoices(ctx), "off");
      answers.brokerSessions = mode;
    }
    if (mode === "apiKey" && !readApiKey(ctx.at.apiKeyFile)) {
      if (ctx.ask.interactive) {
        writeApiKey(await ctx.ask.secret("Anthropic API key (typed hidden): "), ctx.at.apiKeyFile);
        ctx.out(`Saved the key to ${ctx.at.apiKeyFile}.`);
      } else ctx.out("Store the API key later: ccrc config set-api-key");
    }
    changeConfig(ctx, (c) => {
      const { brokerSessions: _, ...defaults } = newConfig();
      for (const [k, v] of Object.entries(defaults)) c[k] ??= v;
      Object.assign(c, answers);
    });
  },
};

function claudePathFor(ctx: Ctx): string {
  const found = findClaude(ctx);
  return !found || found.vscode ? FOLLOW_VSCODE : found.bin;
}

interface ServiceState {
  text?: string;
  unitOk: boolean;
  enabled: boolean;
  active: boolean;
  linger: boolean;
  // What /api/ping reports, when the service is up.
  version?: string | null;
}

async function serviceState(ctx: Ctx): Promise<ServiceState> {
  const file = unitFile(ctx.at.xdgConfigHome);
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
  const word = async (args: string[]) => (await ctx.run.run(args[0], args.slice(1))).stdout.trim();
  const enabled = (await word(["systemctl", "--user", "is-enabled", SERVICE])) === "enabled";
  const active = (await word(["systemctl", "--user", "is-active", SERVICE])) === "active";
  const linger = (await word(["loginctl", "show-user", ctx.at.user, "--property=Linger", "--value"])) === "yes";
  const version = active ? await ctx.ping(brokerPort(ctx)) : undefined;
  return { ...(text === undefined ? {} : { text }), unitOk: unitMatches(text, ctx.at), enabled, active, linger, ...(active ? { version } : {}) };
}

const runsOther = (s: ServiceState, ctx: Ctx) => s.active && typeof s.version === "string" && ctx.at.version !== undefined && s.version !== ctx.at.version;

const service: Step = {
  id: "service",
  title: "Broker running as a systemd user service",
  system: true,
  async check(ctx) {
    const s = await serviceState(ctx);
    const problems = [
      !s.unitOk && (s.text === undefined ? "no unit" : "unit runs other code"),
      !s.enabled && "not enabled",
      !s.active && "not running",
      !s.linger && "stops at logout (no linger)",
      s.active && s.version === undefined && "does not answer",
      runsOther(s, ctx) && `runs ${s.version}`,
    ].filter(Boolean);
    return problems.length ? { ok: false, detail: problems.join(", ") } : { ok: true, detail: `${s.version ?? "running"}` };
  },
  plan: (ctx) => [
    `write ${unitFile(ctx.at.xdgConfigHome)}: ExecStart=${ctx.at.ccrc} serve, CCRC_NODE=${ctx.at.node}, Restart=on-failure`,
    `systemctl --user daemon-reload, enable ${SERVICE}, and (re)start it`,
    `loginctl enable-linger ${ctx.at.user} so it runs while you are logged out (with sudo if that is refused)`,
    `check http://127.0.0.1:${brokerPort(ctx)}/api/ping`,
    "on its first start the broker changes the entrypoint field of transcripts in ~/.claude/projects that earlier broker sessions wrote, so VS Code lists them; each file is backed up first",
  ],
  async apply(ctx) {
    const s = await serviceState(ctx);
    const spec = { ccrc: ctx.at.ccrc, node: ctx.at.node, path: ctx.at.path, env: ctx.at.keepEnv };
    if (!s.unitOk) {
      const file = unitFile(ctx.at.xdgConfigHome);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, unitText(spec));
      await must(ctx, "systemctl", ["--user", "daemon-reload"]);
    }
    if (!s.enabled) await must(ctx, "systemctl", ["--user", "enable", SERVICE]);
    if (!s.unitOk || !s.active || s.version === undefined || runsOther(s, ctx)) await must(ctx, "systemctl", ["--user", "restart", SERVICE]);
    if (!s.linger && (await ctx.run.run("loginctl", ["enable-linger", ctx.at.user])).code !== 0) {
      ctx.out(`loginctl enable-linger was refused; with sudo it keeps the broker running while you are logged out.`);
      if (await ctx.ask.confirm(`Run sudo loginctl enable-linger ${ctx.at.user}?`, true)) await must(ctx, "sudo", ["loginctl", "enable-linger", ctx.at.user], true);
    }
    const port = brokerPort(ctx);
    for (let waited = 0; ; waited += 1000) {
      const v = await ctx.ping(port);
      if (v !== undefined && (ctx.at.version === undefined || v === ctx.at.version)) return;
      if (waited >= ctx.pingWaitMs) throw Error(`the broker does not answer at http://127.0.0.1:${port}/api/ping; see: journalctl --user -u ${SERVICE} -n 50`);
      await ctx.sleep(1000);
    }
  },
};

async function phoneUrl(ctx: Ctx): Promise<string | undefined> {
  const host = dnsName((await tailscaleStatus(ctx.run))?.Self);
  const mine = (await servedPorts(ctx.run))?.find((s) => reachesBroker(s.proxy, brokerPort(ctx)));
  if (!host || !mine) return undefined;
  return `https://${host}${mine.httpsPort === 443 ? "" : `:${mine.httpsPort}`}`;
}

const serve: Step = {
  id: "serve",
  title: "Broker reachable in the tailnet (tailscale serve)",
  system: true,
  needs: ["tailscale-operator", "https"],
  skip: (ctx) => (ctx.o.noServe ? "--no-serve" : undefined),
  async check(ctx) {
    const served = await servedPorts(ctx.run);
    if (!served) return { ok: false, detail: "cannot read tailscale serve status" };
    const mine = served.find((s) => reachesBroker(s.proxy, brokerPort(ctx)));
    return mine ? { ok: true, detail: (await phoneUrl(ctx)) ?? `HTTPS port ${mine.httpsPort}` } : { ok: false, detail: "not served" };
  },
  plan: (ctx) => [`tailscale serve --bg --https=${ctx.o.httpsPort} http://127.0.0.1:${brokerPort(ctx)} (kept across restarts)`],
  async apply(ctx) {
    const port = brokerPort(ctx);
    const taken = (await servedPorts(ctx.run))?.find((s) => s.httpsPort === ctx.o.httpsPort && !reachesBroker(s.proxy, port));
    if (taken) throw Error(`HTTPS port ${ctx.o.httpsPort} already passes on to ${taken.proxy}; choose another with --https-port`);
    await must(ctx, "tailscale", ["serve", "--bg", `--https=${ctx.o.httpsPort}`, `http://127.0.0.1:${port}`], true);
    const url = await phoneUrl(ctx);
    if (url) ctx.out(`The phone's address: ${url}`);
  },
};

const vscode: Step = {
  id: "vscode",
  title: "VS Code runs Claude Code through ccrc",
  confirm: true,
  skip(ctx) {
    if (ctx.o.noVscode) return "--no-vscode";
    if (!fs.existsSync(ctx.at.vscodeUserDir)) return `no VS Code settings folder at ${ctx.at.vscodeUserDir}`;
    return undefined;
  },
  async check(ctx) {
    const value = readSettingsFile(settingsFile(ctx.at.vscodeUserDir))?.settings[WRAPPER_SETTING];
    if (value === ctx.at.wrapper) return { ok: true };
    return { ok: false, detail: typeof value === "string" && value ? `set to ${value}` : "not set" };
  },
  plan: (ctx) => [
    `set "${WRAPPER_SETTING}": "${ctx.at.wrapper}" in ${settingsFile(ctx.at.vscodeUserDir)}, keeping its comments and layout`,
    `copy the file to ${path.join(ctx.at.stateDir, "backup")} first`,
  ],
  async apply(ctx) {
    const r = changeSetting(settingsFile(ctx.at.vscodeUserDir), WRAPPER_SETTING, ctx.at.wrapper, path.join(ctx.at.stateDir, "backup"), ctx.now());
    if (r.backup) ctx.out(`The file as it was: ${r.backup}`);
    ctx.out("Claude Code tabs already open keep running without ccrc: close and open them again (or reload the window).");
  },
};

const phone: Step = {
  id: "phone",
  title: "Phone set up (home screen app, notifications)",
  human: true,
  informs: true,
  async check(ctx) {
    const n = new PushStore(ctx.at.configDir).list().length;
    return n ? { ok: true, detail: `notifications on for ${n} subscription${n > 1 ? "s" : ""}` } : { ok: false, detail: "no notifications yet" };
  },
  plan: () => ["show the phone's address (and a QR code when qrencode is installed) and what to do on the phone"],
  async apply(ctx) {
    const url = await phoneUrl(ctx);
    if (!url) {
      ctx.out("The phone's address is https://<this machine's tailnet name>:<HTTPS port> once `tailscale serve` passes it on; run setup again for it.");
      return;
    }
    ctx.out(`The phone's address: ${url}`);
    if (ctx.run.which("qrencode")) {
      const qr = await ctx.run.run("qrencode", ["-t", "ANSIUTF8", url]);
      if (qr.code === 0) ctx.out(qr.stdout.replace(/\n$/, ""));
    }
    ctx.out("On the phone:");
    ctx.out("  1. Open the address in Safari (Chrome on Android) and sign in with the ccrc ID and password.");
    ctx.out("  2. Share > Add to Home Screen, then open ccrc from the home screen.");
    ctx.out("  3. In ccrc's settings, turn on notifications and send a test one (iOS 16.4 or later).");
  },
};

const doctor: Step = {
  id: "doctor",
  title: "Compatibility check with VS Code's Claude Code",
  skip: (ctx) => (ctx.doctor.extensionVersion() ? undefined : "no Claude Code extension in VS Code"),
  async check(ctx) {
    const last = ctx.doctor.last();
    if (last?.ok && last.extensionVersion === ctx.doctor.extensionVersion() && last.brokerVersion === ctx.at.version) return { ok: true, detail: `passed ${last.at}` };
    return { ok: false, detail: !last ? "not run yet" : last.ok ? "last run for other versions" : "last run failed" };
  },
  plan: () => ["start Claude Code through the wrapper without a model call and report what it answers"],
  async apply(ctx) {
    const r = await ctx.doctor.run();
    for (const c of r.checks) ctx.out(`  ${c.ok ? (c.warn ? "warn" : "ok  ") : "FAIL"} ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
  },
};

export const STEPS: readonly Step[] = [claude, tailscaleInstall, tailscaleLogin, tailscaleOperator, https, devices, account, config, service, serve, vscode, phone, doctor];
export const STEP_IDS = STEPS.map((s) => s.id);
export { phoneUrl, brokerPort };
