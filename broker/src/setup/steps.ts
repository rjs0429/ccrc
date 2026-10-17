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
import { SUDO_CONSENT_HINT, askSudo, type Ctx, type Step } from "./engine.ts";
import type { Choice } from "./io.ts";
import { inServiceRefusal } from "../service-cgroup.ts";
import { NEEDED_SSH_KEYGEN, sshKeygenFix, sshKeygenTooOld, type SshKeygenProblem } from "../ssh-keygen.ts";
import { SERVICE, keptLines, unitFile, unitMatches, unitText, writeUnit } from "./service.ts";
import { dnsName, httpsReady, phones, reachesBroker, servedPorts, tailscaleStatus, type Phone, type Phones } from "./tailscale.ts";
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

// Whether setup still has to ask for roots. An empty list is a choice (new sessions only in folders that already have
// sessions), and so is a missing key in a config from ccrc 0.6 or earlier, where it meant the same.
function rootsUnset(ctx: Ctx, raw: Obj): boolean {
  if (Array.isArray(raw.roots)) return false;
  const file = ctx.at.configFile;
  return !fs.existsSync(file) || parseConfigText(fs.readFileSync(file, "utf8"), file).schemaVersion !== undefined;
}

const NO_ROOTS = "none";

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

async function sshKeygenState(ctx: Ctx): Promise<{ path?: string; problem?: SshKeygenProblem }> {
  const found = ctx.run.which("ssh-keygen");
  if (!found) return { problem: "missing" };
  return (await sshKeygenTooOld((cmd, args) => ctx.run.run(cmd, args, { timeoutMs: 10_000 }))) ? { path: found, problem: "old" } : { path: found };
}

// Only says what to do: setup uses sudo for Tailscale and linger alone, and nothing but ccrc update needs it.
const sshKeygen: Step = {
  id: "ssh-keygen",
  title: `${NEEDED_SSH_KEYGEN}, which ccrc update checks release signatures with`,
  human: true,
  skip: (ctx) => (ctx.at.installed ? undefined : "ccrc update is for installs"),
  async check(ctx) {
    const s = await sshKeygenState(ctx);
    if (!s.problem) return { ok: true, detail: s.path };
    return { ok: false, detail: s.problem === "missing" ? "not on PATH" : `${s.path} is older than OpenSSH 8.2` };
  },
  async plan(ctx) {
    const { problem } = await sshKeygenState(ctx);
    return problem ? [`you ${sshKeygenFix(problem, (cmd) => ctx.run.which(cmd))}`] : [];
  },
  async apply(ctx) {
    const s = await sshKeygenState(ctx);
    if (!s.problem) return;
    const fix = sshKeygenFix(s.problem, (cmd) => ctx.run.which(cmd));
    const why = "ccrc update checks that a release tag is signed by a key in .ccrc-allowed-signers (git verify-tag), which needs";
    ctx.out(s.problem === "old" ? `${why} ${NEEDED_SSH_KEYGEN}; ${s.path} is older, so updates stop.` : `${why} ssh-keygen; without it, updates stop.`);
    ctx.out(`${fix[0].toUpperCase()}${fix.slice(1)}`);
  },
};

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
  sudo: "install Tailscale's system package and start its daemon, tailscaled, which ccrc reaches the phone through",
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
  sudo: "sign this machine in to your tailnet, which only root may change",
  system: true,
  human: true,
  waits: true,
  needs: ["tailscale-install"],
  async check(ctx) {
    const st = await tailscaleStatus(ctx.run);
    if (st?.BackendState === "Running") return { ok: true, detail: dnsName(st.Self) };
    return { ok: false, detail: st ? `state ${st.BackendState ?? "unknown"}` : "Tailscale does not answer" };
  },
  plan: () => [
    "sudo tailscale up, with no flags so settings from an earlier Tailscale setup stay: it shows a sign-in link",
    "you sign in there; without a Tailscale account, that page makes one (Google, Microsoft, GitHub or Apple)",
  ],
  // With any flag, `tailscale up` fails unless it is given every setting the machine already has. The operator is
  // set by the next step.
  apply: (ctx) => must(ctx, "sudo", ["tailscale", "up"], true),
};

const tailscaleOperator: Step = {
  id: "tailscale-operator",
  title: "Tailscale serve usable without sudo",
  sudo: "let your user run `tailscale serve`, so ccrc can make the broker reachable from the phone without root",
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

const names = (list: Phone[]) => list.map((p) => p.name).join(", ");
const setDevices = (list: string[]) => `ccrc config set allowedDevices '${JSON.stringify(list)}'`;
const yourUser = (p: Phones) => `your Tailscale user${p.user ? ` (${p.user})` : ""}`;

function notOffered(ctx: Ctx, p: Phones): void {
  if (p.others.length) ctx.out(`Phones of other Tailscale users are not offered: ${names(p.others)}. To allow one anyway, list every device to allow: ${setDevices(["<name>", "..."])}`);
}

// Only phones of the Tailscale user this machine belongs to are offered, and --yes takes one only when it is the only
// one. Machines allowed already stay allowed.
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
    const st = await tailscaleStatus(ctx.run);
    const p = phones(st);
    if (p.unknown) return [`none offered, as ${p.unknown}: you name the phone with ${setDevices(["<name>"])}`];
    if (ctx.o.yes) {
      if (!st) return ["add your phone to allowedDevices if it is the only iOS or Android machine of your Tailscale user in the tailnet; otherwise add none and say how to add yours"];
      if (p.mine.length === 1) return [`add ${p.mine[0].name} to allowedDevices: the only iOS or Android machine of ${yourUser(p)} in the tailnet`];
      return [`add none: --yes adds a phone only when ${yourUser(p)} has exactly one in the tailnet, and it has ${p.mine.length ? `${p.mine.length} (${names(p.mine)})` : "none"}; setup says how to add yours`];
    }
    if (!p.mine.length) return ["you install the Tailscale app on the phone and sign in with the same Tailscale account as this machine; setup waits for it", "you choose the phone, which goes into allowedDevices"];
    return [`you choose from ${names(p.mine)}, the iOS and Android machines of ${yourUser(p)}; the choice goes into allowedDevices`];
  },
  async apply(ctx) {
    let p = phones(await tailscaleStatus(ctx.run));
    if (p.unknown) {
      ctx.out(`Setup cannot tell which phones are yours: ${p.unknown}.`);
      ctx.out(`Name yours by the first label of its MagicDNS name: ${setDevices(["<name>"])}${p.others.length ? ` (iOS and Android machines in the tailnet: ${names(p.others)})` : ""}`);
      return;
    }
    let picked: string[];
    if (ctx.o.yes) {
      if (p.mine.length !== 1) {
        ctx.out(`No phone added: --yes adds one only when ${yourUser(p)} has exactly one iOS or Android machine in the tailnet, and it has ${p.mine.length ? `${p.mine.length}: ${names(p.mine)}` : "none"}${p.others.length ? ` (other users have ${names(p.others)})` : ""}.`);
        ctx.out(
          p.mine.length
            ? `Choose with \`ccrc setup\` in a terminal, without --yes, or name yours: ${setDevices([p.mine[0].name])}`
            : `Sign in to Tailscale on the phone with the same account and run \`ccrc setup\` again, or name it: ${setDevices(["<name>"])}`,
        );
        return;
      }
      picked = [p.mine[0].name];
    } else {
      if (!p.mine.length) {
        ctx.out(`No phone of yours is in the tailnet yet. On the phone, install the Tailscale app and sign in with the same account as this machine${p.user ? ` (${p.user})` : ""}.`);
        notOffered(ctx, p);
        ctx.out(ctx.ask.interactive ? `Waiting for it; press Enter to look again, or type "skip" to leave it for later.` : "Waiting for it.");
        while (!p.mine.length) {
          const typed = await ctx.ask.wait(ctx.pollMs);
          p = phones(await tailscaleStatus(ctx.run));
          if (!p.mine.length && typed !== undefined && /^s(kip)?$/i.test(typed.trim())) return;
        }
      } else notOffered(ctx, p);
      const choices: Choice[] = p.mine.map((x) => ({ value: x.name, label: `${x.name} (${x.os}${x.online ? "" : ", offline"})` }));
      const def = p.mine.length === 1 ? [p.mine[0].name] : p.mine.filter((x) => x.online).map((x) => x.name);
      picked = await ctx.ask.pick("Which of your phones may use ccrc?", choices, def);
    }
    if (!picked.length) return;
    changeConfig(ctx, (raw) => {
      const kept = Array.isArray(raw.allowedDevices) ? (raw.allowedDevices as string[]) : [];
      raw.allowedDevices = [...new Set([...kept, ...picked])];
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
    if ((await ctx.run.attached(ctx.at.ccrc, ["passwd"])) !== 0) ctx.out("The login was not saved; run `ccrc passwd`, or setup again.");
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
      rootsUnset(ctx, raw) && "roots",
      raw.claudePath === undefined && claudePathFor(ctx) !== FOLLOW_VSCODE && "claudePath",
      raw.brokerSessions === undefined && "brokerSessions",
      raw.brokerSessions === "apiKey" && !readApiKey(ctx.at.apiKeyFile) && "the API key",
    ].filter(Boolean);
    if (missing.length) return { ok: false, detail: `to set: ${missing.join(", ")}` };
    return { ok: true, detail: `brokerSessions ${String(raw.brokerSessions)}, roots ${roots.join(", ") || "none (folders with sessions only)"}` };
  },
  plan(ctx) {
    const raw = configRaw(ctx) ?? {};
    const out: string[] = [];
    if (rootsUnset(ctx, raw)) out.push(`ask which folders new sessions may start in (default ${ctx.at.home}; "${NO_ROOTS}" for only folders that already have sessions)`);
    if (raw.claudePath === undefined) out.push(`set claudePath to ${claudePathFor(ctx)}`);
    if (raw.brokerSessions === undefined) out.push(`ask how sessions the phone starts sign in: ${BROKER_SESSIONS.join(", ")} (default off)`);
    if (raw.brokerSessions === "apiKey" || raw.brokerSessions === undefined) out.push("for apiKey, ask for the key (typed hidden)");
    out.push(`write ${ctx.at.configFile}`);
    return out;
  },
  async apply(ctx) {
    const raw = configRaw(ctx) ?? {};
    const answers: Obj = {};
    if (rootsUnset(ctx, raw)) {
      const text = await ctx.ask.text(`Folders new sessions may start in, separated by commas ("${NO_ROOTS}": only folders that already have sessions)`, ctx.at.home);
      answers.roots =
        text.trim().toLowerCase() === NO_ROOTS
          ? []
          : text
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
      s.active && s.version === undefined && "does not answer",
      runsOther(s, ctx) && `runs ${s.version}`,
    ].filter(Boolean);
    if (problems.length) return { ok: false, detail: problems.join(", ") };
    // Linger is optional: without it the broker runs while you are logged in.
    return { ok: true, detail: `${s.version ?? "running"}${s.linger ? "" : `; stops when you log out (optional: loginctl enable-linger ${ctx.at.user})`}` };
  },
  plan: (ctx) => [
    `write ${unitFile(ctx.at.xdgConfigHome)}: ExecStart=${ctx.at.ccrc} serve, CCRC_NODE=${ctx.at.node}, Restart=on-failure; Environment lines of a unit already there that setup does not set are kept`,
    `systemctl --user daemon-reload, enable ${SERVICE}, and (re)start it`,
    `when linger is off, ask whether to turn it on (loginctl enable-linger ${ctx.at.user}) so the broker runs while you are logged out; --yes leaves it off`,
    `check http://127.0.0.1:${brokerPort(ctx)}/api/ping`,
    `on its first start the broker changes the entrypoint field of transcripts in ${ctx.at.claudeProjectsDir} that earlier broker sessions wrote, so VS Code lists them; each file is backed up first`,
  ],
  async apply(ctx) {
    if (ctx.inService()) throw Error(inServiceRefusal("setup"));
    const s = await serviceState(ctx);
    const spec = { ccrc: ctx.at.ccrc, node: ctx.at.node, path: ctx.at.path, env: ctx.at.keepEnv };
    if (!s.unitOk) {
      const file = unitFile(ctx.at.xdgConfigHome);
      let kept: string[] = [];
      if (s.text !== undefined) {
        const backup = path.join(ctx.at.stateDir, "backup", `${SERVICE}-${ctx.now().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`);
        fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
        fs.writeFileSync(backup, s.text);
        ctx.out(`The unit as it was: ${backup}`);
        kept = keptLines(s.text, spec);
        for (const l of kept) ctx.out(`  kept from it: ${l}`);
      }
      writeUnit(file, unitText({ ...spec, kept }));
      await must(ctx, "systemctl", ["--user", "daemon-reload"]);
    }
    if (!s.enabled) await must(ctx, "systemctl", ["--user", "enable", SERVICE]);
    if (!s.unitOk || !s.active || s.version === undefined || runsOther(s, ctx)) await must(ctx, "systemctl", ["--user", "restart", SERVICE]);
    // Linger changes whether the broker outlives your login, so it is asked, and --yes leaves it as it is.
    if (!s.linger) {
      if (ctx.o.yes || !(await ctx.ask.confirm(`Keep the broker running while you are logged out (loginctl enable-linger ${ctx.at.user})?`, true))) {
        ctx.out(`Linger stays off: the broker stops when you log out. To change that: loginctl enable-linger ${ctx.at.user}`);
      } else if ((await ctx.run.run("loginctl", ["enable-linger", ctx.at.user])).code !== 0) {
        ctx.out("loginctl enable-linger was refused.");
        const consent = await askSudo(ctx, `turn on linger for ${ctx.at.user} (sudo loginctl enable-linger ${ctx.at.user}), so the broker keeps running while you are logged out`, `Run sudo loginctl enable-linger ${ctx.at.user}?`);
        if (consent === "yes") {
          const code = await ctx.run.attached("sudo", ["loginctl", "enable-linger", ctx.at.user]);
          if (code !== 0) ctx.out(`sudo loginctl enable-linger ${ctx.at.user} failed (exit code ${code}); the broker stops when you log out until it is run.`);
        } else if (consent === "needs-consent") {
          ctx.out(`Linger stays off (sudo consent needed): ${SUDO_CONSENT_HINT}, or run sudo loginctl enable-linger ${ctx.at.user} yourself.`);
        }
      }
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

export const STEPS: readonly Step[] = [sshKeygen, claude, tailscaleInstall, tailscaleLogin, tailscaleOperator, https, devices, account, config, service, serve, vscode, phone, doctor];
export const STEP_IDS = STEPS.map((s) => s.id);
export { phoneUrl, brokerPort };
