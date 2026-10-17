import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DoctorResult } from "../src/admin-protocol.ts";
import { SetupUsageError, runSetup, type Ctx, type SetupOptions, type Where } from "../src/setup/engine.ts";
import { realRunner, withDefaults, type Choice, type Prompt, type RunResult, type Runner } from "../src/setup/io.ts";
import { parseSetupArgs, rootRefusal } from "../src/setup/cli.ts";
import { unitMatches, unitProgram, unitText } from "../src/setup/service.ts";
import { STEPS } from "../src/setup/steps.ts";
import { gitSshKeygenProblem, sshKeygenFix, sshKeygenInstall, sshKeygenTooOld } from "../src/ssh-keygen.ts";
import { phones, reachesBroker, type TsNode } from "../src/setup/tailscale.ts";
import { runUninstall, safeToRemove } from "../src/setup/uninstall.ts";
import { WRAPPER_SETTING, changeSetting, editSettingsText, parseSettingsText } from "../src/setup/vscode-settings.ts";
import { tempDir } from "./helpers.ts";

const VERSION = "v0.7.0";
const PLATFORM = "linux-x64";

// A machine as setup sees it through its commands. Commands that run on the terminal change it the way the real ones would.
interface World {
  tailscale: boolean;
  daemon: boolean;
  backend: string;
  operator: boolean;
  magicDns: boolean;
  certs: boolean;
  // This machine belongs to Tailscale user 1 (user@example.com) unless self says otherwise.
  self?: TsNode;
  peers: TsNode[];
  served: Record<number, string>;
  enabled: boolean;
  active: boolean;
  linger: boolean;
  lingerNeedsSudo: boolean;
  // What /api/ping says once the service runs; undefined: it never answers.
  runs: string | undefined;
  loggedIn: boolean;
  code: boolean;
  qrencode: boolean;
  sshKeygen: boolean;
  // An ssh-keygen from before OpenSSH 8.2, without -Y find-principals.
  oldOpenSsh: boolean;
  doctor?: DoctorResult;
}

function freshWorld(): World {
  return {
    tailscale: false,
    daemon: false,
    backend: "NoState",
    operator: false,
    magicDns: false,
    certs: false,
    peers: [],
    served: {},
    enabled: false,
    active: false,
    linger: false,
    lingerNeedsSudo: false,
    runs: VERSION,
    loggedIn: false,
    code: true,
    qrencode: true,
    sshKeygen: true,
    oldOpenSsh: false,
  };
}

function readyWorld(): World {
  return {
    ...freshWorld(),
    tailscale: true,
    daemon: true,
    backend: "Running",
    operator: true,
    magicDns: true,
    certs: true,
    peers: [{ DNSName: "phone.example.ts.net.", OS: "iOS", Online: true, UserID: 1 }],
    served: { 8443: "http://127.0.0.1:8737" },
    enabled: true,
    active: true,
    linger: true,
    loggedIn: true,
  };
}

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string, code = 1): RunResult => ({ code, stdout: "", stderr });

// Commands that only read; --dry-run and the checks must not run any other.
const READ_ONLY = [
  /^ssh-keygen -Y find-principals -f \/dev\/null -s \/dev\/null$/,
  /^tailscale status --json$/,
  /^tailscale serve status( --json)?$/,
  /auth status --json$/,
  /^systemctl --user is-(enabled|active) ccrc\.service$/,
  /^loginctl show-user \S+ --property=Linger --value$/,
];

interface Machine {
  world: World;
  at: Where;
  calls: string[];
  runner: Runner;
  extension(): void;
}

function machine(world: World, o: { extension?: boolean; vscode?: boolean } = {}): Machine {
  const home = tempDir("ccrc-setup-");
  const dataDir = path.join(home, ".local", "share", "ccrc");
  const at: Where = {
    home,
    user: "user",
    configDir: path.join(home, ".config", "ccrc"),
    configFile: path.join(home, ".config", "ccrc", "config.json"),
    credentialsFile: path.join(home, ".config", "ccrc", "state.json"),
    apiKeyFile: path.join(home, ".config", "ccrc", "anthropic-api-key"),
    stateDir: path.join(home, ".local", "state", "ccrc"),
    dataDir,
    xdgConfigHome: path.join(home, ".config"),
    claudeProjectsDir: path.join(home, ".claude", "projects"),
    codeRoot: path.join(dataDir, "versions", VERSION),
    installed: true,
    ccrc: path.join(dataDir, "current", "bin", "ccrc"),
    wrapper: path.join(dataDir, "current", "bin", "ccrc-wrapper"),
    vscodeUserDir: path.join(home, ".config", "Code"),
    extensionsDir: path.join(home, ".vscode", "extensions"),
    platform: PLATFORM,
    distro: "ubuntu",
    node: path.join(dataDir, "node", "bin", "node"),
    path: "/usr/local/bin:/usr/bin:/bin",
    keepEnv: {},
    version: VERSION,
  };
  const extDir = path.join(at.extensionsDir, `anthropic.claude-code-2.1.301-${PLATFORM}`);
  const bundled = path.join(extDir, "resources", "native-binary", "claude");
  const extension = () => {
    fs.mkdirSync(path.dirname(bundled), { recursive: true });
    fs.writeFileSync(bundled, "");
  };
  if (o.extension ?? true) extension();
  if (o.vscode ?? true) fs.mkdirSync(path.join(at.vscodeUserDir, "User"), { recursive: true });

  const calls: string[] = [];
  const status = () => ({
    BackendState: world.backend,
    Self: world.self ?? { DNSName: "laptop.example.ts.net.", OS: "linux", Online: true, UserID: 1 },
    Peer: Object.fromEntries(world.peers.map((p, i) => [`k${i}`, p])),
    User: { "1": { ID: 1, LoginName: "user@example.com" }, "2": { ID: 2, LoginName: "other@example.com" } },
    CurrentTailnet: { MagicDNSEnabled: world.magicDns },
    CertDomains: world.certs ? ["laptop.example.ts.net"] : null,
  });
  const serveJson = () => ({ Web: Object.fromEntries(Object.entries(world.served).map(([p, proxy]) => [`laptop.example.ts.net:${p}`, { Handlers: { "/": { Proxy: proxy } } }])) });
  const runner: Runner = {
    which(cmd) {
      if (cmd === "tailscale") return world.tailscale ? "/usr/bin/tailscale" : undefined;
      if (cmd === "code") return world.code ? "/usr/bin/code" : undefined;
      if (cmd === "qrencode") return world.qrencode ? "/usr/bin/qrencode" : undefined;
      if (cmd === "ssh-keygen") return world.sshKeygen ? "/usr/bin/ssh-keygen" : undefined;
      if (cmd === "apt-get") return "/usr/bin/apt-get";
      return undefined;
    },
    async run(cmd, args) {
      const line = [cmd, ...args].join(" ");
      calls.push(`run ${line}`);
      if (cmd === "tailscale" && !world.tailscale) return fail("not found", 127);
      if (line === "tailscale status --json") return world.daemon ? ok(JSON.stringify(status())) : fail("failed to connect to local tailscaled");
      if (line === "tailscale serve status") return world.operator ? ok("") : fail("Access denied: serve config denied");
      if (line === "tailscale serve status --json") return ok(JSON.stringify(serveJson()));
      const off = /^tailscale serve --https=(\d+) off$/.exec(line);
      if (off) {
        delete world.served[Number(off[1])];
        return ok();
      }
      if (line === `${bundled} auth status --json`) return { code: world.loggedIn ? 0 : 1, stdout: JSON.stringify({ loggedIn: world.loggedIn }), stderr: "" };
      if (line === "systemctl --user is-enabled ccrc.service") return { code: world.enabled ? 0 : 1, stdout: world.enabled ? "enabled\n" : "disabled\n", stderr: "" };
      if (line === "systemctl --user is-active ccrc.service") return { code: world.active ? 0 : 3, stdout: world.active ? "active\n" : "inactive\n", stderr: "" };
      if (line === "systemctl --user daemon-reload") return ok();
      if (line === "systemctl --user enable ccrc.service") {
        world.enabled = true;
        return ok();
      }
      if (line === "systemctl --user restart ccrc.service") {
        world.active = true;
        return ok();
      }
      if (line === "systemctl --user disable --now ccrc.service") {
        world.enabled = world.active = false;
        return ok();
      }
      if (line === "loginctl show-user user --property=Linger --value") return ok(world.linger ? "yes\n" : "no\n");
      if (line === "loginctl enable-linger user") {
        if (world.lingerNeedsSudo) return fail("Access denied");
        world.linger = true;
        return ok();
      }
      if (cmd === "qrencode") return ok("[QR]\n");
      if (line === "ssh-keygen -Y find-principals -f /dev/null -s /dev/null") {
        if (!world.sshKeygen) return fail("spawn ssh-keygen ENOENT", 127);
        return world.oldOpenSsh ? fail("unknown option -- Y\nusage: ssh-keygen [-q] [-b bits] [-t dsa | ecdsa | ed25519 | rsa]\n") : fail("Couldn't parse signature: missing header\n", 255);
      }
      return fail(`unexpected: ${line}`, 99);
    },
    async attached(cmd, args) {
      const line = [cmd, ...args].join(" ");
      calls.push(`attached ${line}`);
      if (line === "sh -c curl -fsSL https://tailscale.com/install.sh | sh") Object.assign(world, { tailscale: true, daemon: true, backend: "NeedsLogin" });
      else if (line === "sudo pacman -S --needed tailscale") world.tailscale = true;
      else if (line === "sudo systemctl enable --now tailscaled") Object.assign(world, { daemon: true, backend: "NeedsLogin" });
      else if (line === "sudo tailscale up") world.backend = "Running";
      else if (line === "sudo tailscale set --operator=user") world.operator = true;
      else if (/^tailscale serve --bg --https=(\d+) (\S+)$/.test(line)) {
        const [, p, target] = /^tailscale serve --bg --https=(\d+) (\S+)$/.exec(line)!;
        world.served[Number(p)] = target;
      } else if (line === "sudo loginctl enable-linger user") world.linger = true;
      else if (line === `${at.ccrc} passwd`) {
        fs.mkdirSync(at.configDir, { recursive: true });
        fs.writeFileSync(at.credentialsFile, JSON.stringify({ user: { id: "me", passwordHash: "x", changedAt: "now" }, lockout: { failures: 0, lockedUntil: 0 } }));
      } else if (line === "/usr/bin/code --install-extension anthropic.claude-code") extension();
      else return 99;
      return 0;
    },
  };
  return { world, at, calls, runner, extension };
}

interface Answers {
  confirm?: boolean[];
  choose?: string[];
  pick?: string[][];
  text?: string[];
  secret?: string[];
  // Called on each wait, with the count so far; returns what the person typed, if anything.
  wait?: (n: number) => string | undefined;
  interactive?: boolean;
}

function fakePrompt(a: Answers = {}): Prompt & { asked: string[]; offered: string[][] } {
  const asked: string[] = [];
  const offered: string[][] = [];
  let waits = 0;
  return {
    asked,
    offered,
    interactive: a.interactive ?? true,
    confirm: async (q, def) => (asked.push(q), a.confirm?.length ? a.confirm.shift()! : def),
    choose: async <T extends string>(q: string, _c: Choice<T>[], def: T) => (asked.push(q), (a.choose?.shift() as T | undefined) ?? def),
    pick: async (q, c, def) => (asked.push(q), offered.push(c.map((x) => x.value)), a.pick?.shift() ?? def),
    text: async (q, def) => (asked.push(q), a.text?.shift() ?? def),
    secret: async (q) => (asked.push(q), a.secret?.shift() ?? ""),
    wait: async () => {
      waits++;
      if (waits > 50) throw Error("waited too long");
      return a.wait?.(waits);
    },
  };
}

const OPTIONS: SetupOptions = { yes: false, allowSudo: false, dryRun: false, noSystem: false, noVscode: false, noServe: false, httpsPort: 8443, skip: [] };

function ctxOf(m: Machine, o: Partial<SetupOptions> = {}, answers?: Answers): Ctx & { lines: string[]; ask: ReturnType<typeof fakePrompt> } {
  const lines: string[] = [];
  const ask = fakePrompt(answers);
  return {
    o: { ...OPTIONS, ...o },
    at: m.at,
    run: m.runner,
    ask,
    sudoAsk: ask,
    out: (l) => lines.push(l),
    sleep: async () => {},
    ping: async () => (m.world.active ? m.world.runs : undefined),
    doctor: {
      last: () => m.world.doctor,
      extensionVersion: () => (fs.existsSync(m.at.extensionsDir) ? "2.1.301" : undefined),
      run: async () => (m.world.doctor = { ok: true, at: "2026-10-17T00:00:00Z", extensionVersion: "2.1.301", brokerVersion: VERSION, checks: [{ name: "initialize", ok: true }] }),
    },
    pollMs: 1,
    pingWaitMs: 3000,
    now: () => new Date("2026-10-17T00:00:00Z"),
    inService: () => false,
    lines,
  };
}

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => path.relative(dir, path.join(d.parentPath, d.name))).sort();
}

const outcomes = (r: { reports: { id: string; outcome: string }[] }) => Object.fromEntries(r.reports.map((x) => [x.id, x.outcome]));
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, unknown>;

test("dry-run on a new machine runs only reading commands and writes nothing", async () => {
  const m = machine(freshWorld());
  const before = filesUnder(m.at.home);
  const ctx = ctxOf(m, { dryRun: true });
  const r = await runSetup([...STEPS], ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(filesUnder(m.at.home), before);
  for (const c of m.calls) assert.ok(c.startsWith("run ") && READ_ONLY.some((re) => re.test(c.slice(4))), `not a reading command: ${c}`);
  assert.equal(ctx.ask.asked.length, 0);
  const text = ctx.lines.join("\n");
  assert.match(text, /\[todo\] tailscale-install/);
  assert.match(text, /curl -fsSL https:\/\/tailscale\.com\/install\.sh \| sh/);
  assert.match(text, /ExecStart=.*current\/bin\/ccrc serve/);
  assert.ok(text.includes(path.join(m.at.home, ".claude", "projects")));
});

test("a full run on a new machine does every step, and a second run finds nothing to do", async () => {
  const m = machine(freshWorld());
  m.world.peers = [
    { DNSName: "phone.example.ts.net.", OS: "iOS", Online: true, UserID: 1 },
    { DNSName: "other-host.example.ts.net.", OS: "linux", Online: true, UserID: 1 },
  ];
  // The person signs in to Claude Code, then turns on HTTPS in the admin console while setup waits.
  const ctx = ctxOf(m, {}, {
    wait: (n) => {
      if (n === 2) m.world.loggedIn = true;
      if (n === 4) Object.assign(m.world, { magicDns: true, certs: true });
      return undefined;
    },
  });
  const r = await runSetup([...STEPS], ctx);
  assert.equal(r.ok, true, ctx.lines.join("\n"));
  assert.deepEqual(outcomes(r), {
    "ssh-keygen": "ok",
    claude: "done",
    "tailscale-install": "done",
    "tailscale-login": "done",
    "tailscale-operator": "done",
    https: "done",
    devices: "done",
    account: "done",
    config: "done",
    service: "done",
    serve: "done",
    vscode: "done",
    phone: "shown",
    doctor: "done",
  });
  const attached = m.calls.filter((c) => c.startsWith("attached "));
  assert.deepEqual(attached, [
    "attached sh -c curl -fsSL https://tailscale.com/install.sh | sh",
    "attached sudo tailscale up",
    "attached sudo tailscale set --operator=user",
    `attached ${m.at.ccrc} passwd`,
    "attached tailscale serve --bg --https=8443 http://127.0.0.1:8737",
  ]);

  const config = readJson(m.at.configFile);
  assert.deepEqual(config.allowedDevices, ["phone"]);
  assert.deepEqual(config.roots, [m.at.home]);
  assert.equal(config.brokerSessions, "off");
  assert.equal(config.claudePath, "vscode");
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.port, 8737);

  const unit = fs.readFileSync(path.join(m.at.xdgConfigHome, "systemd", "user", "ccrc.service"), "utf8");
  assert.match(unit, new RegExp(`^ExecStart=${m.at.ccrc} serve$`, "m"));
  assert.match(unit, new RegExp(`^Environment=CCRC_NODE=${m.at.node}$`, "m"));
  assert.match(unit, /^Restart=on-failure$/m);
  assert.ok(m.calls.includes("run systemctl --user daemon-reload"));
  assert.ok(m.calls.includes("run loginctl enable-linger user"));

  const settings = parseSettingsText(fs.readFileSync(path.join(m.at.vscodeUserDir, "User", "settings.json"), "utf8"));
  assert.equal(settings[WRAPPER_SETTING], m.at.wrapper);
  assert.match(ctx.lines.join("\n"), /The phone's address: https:\/\/laptop\.example\.ts\.net:8443/);
  assert.match(ctx.lines.join("\n"), /\[QR\]/);

  // Only the phone step shows itself again until the phone turns notifications on.
  const r2 = await runSetup([...STEPS], ctxOf(m));
  assert.deepEqual(
    r2.reports.filter((x) => x.outcome !== "ok").map((x) => [x.id, x.outcome]),
    [["phone", "shown"]],
  );
  assert.equal(m.calls.filter((c) => c.startsWith("attached ")).length, attached.length);
});

test("a machine set up before needs nothing, and keeps its settings", async () => {
  const m = machine(readyWorld());
  fs.mkdirSync(m.at.configDir, { recursive: true });
  // A 0.6 config, of no format version: broker sessions stay on Claude Code's own login.
  fs.writeFileSync(m.at.configFile, JSON.stringify({ allowedDevices: ["phone"], roots: ["/home/user/src"] }));
  fs.writeFileSync(m.at.credentialsFile, JSON.stringify({ user: { id: "me" }, lockout: { failures: 0, lockedUntil: 0 } }));
  fs.writeFileSync(path.join(m.at.vscodeUserDir, "User", "settings.json"), JSON.stringify({ [WRAPPER_SETTING]: m.at.wrapper }));
  fs.writeFileSync(path.join(m.at.configDir, "push.json"), JSON.stringify({ subscriptions: [{ endpoint: "https://push.example.com/1", keys: {} }] }));
  const unitFile = path.join(m.at.xdgConfigHome, "systemd", "user", "ccrc.service");
  fs.mkdirSync(path.dirname(unitFile), { recursive: true });
  fs.writeFileSync(unitFile, unitText({ ccrc: m.at.ccrc, node: m.at.node, path: "/somewhere/else:/usr/bin", env: {} }));
  m.world.doctor = { ok: true, at: "2026-10-16T00:00:00Z", extensionVersion: "2.1.301", brokerVersion: VERSION, checks: [] };
  const ctx = ctxOf(m);
  const r = await runSetup([...STEPS], ctx);
  assert.ok(ctx.lines.includes("Nothing to do."), ctx.lines.join("\n"));
  assert.ok(r.reports.every((x) => x.outcome === "ok"));
  assert.match(ctx.lines.join("\n"), /brokerSessions subscription/);
  assert.ok(m.calls.every((c) => READ_ONLY.some((re) => re.test(c.slice(4)))));
  assert.equal(readJson(m.at.configFile).schemaVersion, undefined, "a check does not migrate the file");
});

test("--no-system leaves out sudo and service steps, their checks too", async () => {
  const m = machine(freshWorld());
  const ctx = ctxOf(m, { noSystem: true, dryRun: true });
  const r = await runSetup([...STEPS], ctx);
  const o = outcomes(r);
  for (const id of ["tailscale-install", "tailscale-login", "tailscale-operator", "service", "serve"]) assert.equal(o[id], "skipped", id);
  assert.ok(!m.calls.some((c) => /systemctl|loginctl|serve status/.test(c)), m.calls.join("\n"));
});

test("--only and --skip pick steps; an unknown id is refused", async () => {
  const m = machine(readyWorld());
  const ctx = ctxOf(m, { only: ["https", "devices"], skip: ["devices"], dryRun: true });
  const r = await runSetup([...STEPS], ctx);
  assert.deepEqual(
    r.reports.filter((x) => x.outcome !== "skipped").map((x) => x.id),
    ["https"],
  );
  await assert.rejects(runSetup([...STEPS], ctxOf(m, { only: ["nope"] })), SetupUsageError);
  await assert.rejects(runSetup([...STEPS], ctxOf(m, { skip: ["tailscale"] })), /no step "tailscale"/);
});

test("a declined sudo step is not run, and the steps that need it wait for a later run", async () => {
  const m = machine({ ...readyWorld(), backend: "NeedsLogin", operator: false });
  const ctx = ctxOf(m, { only: ["tailscale-login", "tailscale-operator"] }, { confirm: [true, false] });
  const r = await runSetup([...STEPS], ctx);
  assert.deepEqual(outcomes(r), { "tailscale-login": "declined", "tailscale-operator": "blocked" });
  assert.ok(!m.calls.some((c) => c.startsWith("attached")));
  assert.match(ctx.lines.join("\n"), /Still to do: tailscale-login \(declined\), tailscale-operator \(blocked\)/);
});

test("a failing step stops setup with its name and a way on; the next run picks up from it", async () => {
  const m = machine(readyWorld());
  Object.assign(m.world, { enabled: false, active: false, runs: undefined });
  fs.mkdirSync(m.at.configDir, { recursive: true });
  fs.writeFileSync(m.at.configFile, JSON.stringify({ schemaVersion: 1, allowedDevices: ["phone"], roots: ["/home/user"], brokerSessions: "off", claudePath: "vscode" }));
  const ctx = ctxOf(m, { only: ["service", "serve", "vscode"] });
  const r = await runSetup([...STEPS], ctx);
  assert.equal(r.ok, false);
  assert.deepEqual(outcomes(r), { service: "failed", serve: "ok", vscode: "todo" });
  const text = ctx.lines.join("\n");
  assert.match(text, /Step service \(Broker running as a systemd user service\) failed: the broker does not answer at http:\/\/127\.0\.0\.1:8737\/api\/ping/);
  assert.match(text, /journalctl --user -u ccrc\.service/);
  assert.match(text, /run `ccrc setup` again/);

  assert.ok(!fs.existsSync(path.join(m.at.stateDir, "backup")), "no unit to keep a copy of");

  m.world.runs = VERSION;
  const again = ctxOf(m, { only: ["service", "serve", "vscode"] });
  const r2 = await runSetup([...STEPS], again);
  assert.deepEqual(outcomes(r2), { service: "ok", serve: "ok", vscode: "done" });
  assert.equal(m.calls.filter((c) => c === "run systemctl --user daemon-reload").length, 1, "the unit was already written");
});

test("the service step takes linger with sudo when loginctl refuses, and restarts a broker of another version", async () => {
  const m = machine(readyWorld());
  Object.assign(m.world, { linger: false, lingerNeedsSudo: true, runs: "v0.6.0" });
  const unitFile = path.join(m.at.xdgConfigHome, "systemd", "user", "ccrc.service");
  fs.mkdirSync(path.dirname(unitFile), { recursive: true });
  fs.writeFileSync(unitFile, unitText({ ccrc: m.at.ccrc, node: m.at.node, path: "/usr/bin", env: {} }));
  const ctx = ctxOf(m, { only: ["service"] });
  const first = await runSetup([...STEPS], ctx);
  assert.match(ctx.lines.join("\n"), /\(runs v0\.6\.0\)/);
  assert.equal(first.ok, false, "a broker that keeps answering with the old version fails the step");
  assert.ok(m.calls.includes("run systemctl --user restart ccrc.service"));
  assert.ok(m.calls.includes("attached sudo loginctl enable-linger user"));
  assert.ok(!m.calls.includes("run systemctl --user daemon-reload"), "the unit already matched");
});

test("a refused sudo linger leaves linger for later and setup goes on", async () => {
  const m = machine(readyWorld());
  Object.assign(m.world, { enabled: false, active: false, linger: false, lingerNeedsSudo: true });
  fs.mkdirSync(m.at.configDir, { recursive: true });
  fs.writeFileSync(m.at.configFile, JSON.stringify({ schemaVersion: 1, allowedDevices: ["phone"], roots: ["/home/user"], brokerSessions: "off", claudePath: "vscode" }));
  const runner = m.runner;
  const attached = runner.attached.bind(runner);
  runner.attached = async (cmd, args) => (cmd === "sudo" && args[0] === "loginctl" ? (m.calls.push(`attached ${cmd} ${args.join(" ")}`), 1) : attached(cmd, args));
  const ctx = ctxOf(m, { only: ["service", "vscode"] });
  const r = await runSetup([...STEPS], ctx);
  assert.equal(r.ok, true, ctx.lines.join("\n"));
  assert.deepEqual(outcomes(r), { service: "done", vscode: "done" });
  assert.ok(m.world.active && m.world.enabled);
  assert.match(ctx.lines.join("\n"), /sudo loginctl enable-linger user failed \(exit code 1\)/);
  assert.match(ctx.lines.join("\n"), /stops when you log out \(optional: loginctl enable-linger user\)/);
});

test("a unit that runs other code is copied aside, then written for this install", async () => {
  const m = machine(readyWorld());
  const unitFile = path.join(m.at.xdgConfigHome, "systemd", "user", "ccrc.service");
  const old = unitText({ ccrc: "/home/user/ccrc/bin/ccrc", node: "/usr/bin/node", path: "/usr/bin", env: {} });
  fs.mkdirSync(path.dirname(unitFile), { recursive: true });
  fs.writeFileSync(unitFile, old);
  const ctx = ctxOf(m, { only: ["service"] });
  const r = await runSetup([...STEPS], ctx);
  assert.deepEqual(outcomes(r), { service: "done" });
  assert.match(fs.readFileSync(unitFile, "utf8"), new RegExp(`^ExecStart=${m.at.ccrc} serve$`, "m"));
  assert.equal(fs.readFileSync(path.join(m.at.stateDir, "backup", "ccrc.service-20261017T000000Z"), "utf8"), old);
  assert.ok(m.calls.includes("run systemctl --user restart ccrc.service"));
});

test("the unit file quotes what systemd would split, and a change of PATH alone is no change", () => {
  const spec = { ccrc: "/home/user/my apps/ccrc/current/bin/ccrc", node: "/opt/node 22/bin/node", path: "/usr/bin:/bin", env: { CCRC_CONFIG_DIR: "/home/user/100%/cfg" } };
  const text = unitText(spec);
  assert.match(text, /^ExecStart="\/home\/user\/my apps\/ccrc\/current\/bin\/ccrc" serve$/m);
  assert.match(text, /^Environment="CCRC_NODE=\/opt\/node 22\/bin\/node"$/m);
  assert.match(text, /^Environment=CCRC_CONFIG_DIR=\/home\/user\/100%%\/cfg$/m);
  assert.equal(unitProgram(text), spec.ccrc);
  assert.equal(unitMatches(text.replace("PATH=/usr/bin:/bin", "PATH=/elsewhere"), spec), true);
  assert.equal(unitMatches(text, { ...spec, node: "/usr/bin/node" }), false);
  assert.equal(unitMatches(undefined, spec), false);
});

test("config: apiKey asks for the key and keeps it out of what setup prints", async () => {
  const m = machine(readyWorld());
  const key = "sk-ant-api03-example-key";
  const ctx = ctxOf(m, { only: ["config"] }, { text: ["~/src, /srv/work"], choose: ["apiKey"], secret: [key] });
  const r = await runSetup([...STEPS], ctx);
  assert.deepEqual(outcomes(r), { config: "done" });
  const config = readJson(m.at.configFile);
  assert.equal(config.brokerSessions, "apiKey");
  assert.deepEqual(config.roots, [path.join(m.at.home, "src"), "/srv/work"]);
  assert.equal(fs.readFileSync(m.at.apiKeyFile, "utf8"), key + "\n");
  assert.equal(fs.statSync(m.at.apiKeyFile).mode & 0o777, 0o600);
  assert.ok(!ctx.lines.join("\n").includes(key));
  assert.match(ctx.lines.join("\n"), /brokerSessions apiKey/);
});

test("config without a terminal takes the defaults it can and leaves the API key for later", async () => {
  const m = machine(readyWorld());
  fs.mkdirSync(m.at.configDir, { recursive: true });
  fs.writeFileSync(m.at.configFile, JSON.stringify({ schemaVersion: 1, roots: ["/home/user"], brokerSessions: "apiKey", claudePath: "vscode" }));
  const ctx = ctxOf(m, { only: ["config", "account"] }, { interactive: false });
  const r = await runSetup([...STEPS], ctx);
  assert.deepEqual(outcomes(r), { account: "left", config: "left" });
  assert.match(ctx.lines.join("\n"), /ccrc config set-api-key/);
  assert.match(ctx.lines.join("\n"), /run `ccrc passwd`/);
  assert.ok(!m.calls.some((c) => c.includes("passwd")));
});

test("a login that ccrc passwd does not save is left for later, and setup goes on", async () => {
  const m = machine(readyWorld());
  const attached = m.runner.attached.bind(m.runner);
  m.runner.attached = async (cmd, args) => (args[0] === "passwd" ? (m.calls.push(`attached ${cmd} passwd`), 1) : attached(cmd, args));
  const ctx = ctxOf(m, { only: ["account", "config"] });
  const r = await runSetup([...STEPS], ctx);
  assert.deepEqual(outcomes(r), { account: "left", config: "done" });
  assert.match(ctx.lines.join("\n"), /The login was not saved/);
});

test("devices waits for a phone to join the tailnet, or is left when the person skips", async () => {
  const m = machine(readyWorld());
  m.world.peers = [];
  const ctx = ctxOf(m, { only: ["devices"] }, {
    wait: (n) => {
      if (n === 3) m.world.peers = [{ DNSName: "phone.example.ts.net.", OS: "android", Online: false, UserID: 1 }];
      return undefined;
    },
  });
  const r = await runSetup([...STEPS], ctx);
  assert.deepEqual(outcomes(r), { devices: "done" });
  assert.deepEqual(readJson(m.at.configFile).allowedDevices, ["phone"]);
  assert.equal(readJson(m.at.configFile).brokerSessions, undefined, "left for the config step to ask");

  const m2 = machine(readyWorld());
  m2.world.peers = [];
  const skipped = await runSetup([...STEPS], ctxOf(m2, { only: ["devices"] }, { wait: () => "skip" }));
  assert.deepEqual(outcomes(skipped), { devices: "left" });
  assert.ok(!fs.existsSync(m2.at.configFile));
});

const mine = (name: string, Online = true): TsNode => ({ DNSName: `${name}.example.ts.net.`, OS: "iOS", Online, UserID: 1 });
const theirs = (name: string): TsNode => ({ DNSName: `${name}.example.ts.net.`, OS: "android", Online: true, UserID: 2 });
const noWait = () => {
  throw Error("devices waited under --yes");
};

test("devices --yes adds the phone when it is the only one of this machine's Tailscale user, online or not", async () => {
  for (const peers of [[mine("phone")], [mine("phone", false), theirs("phone-b")]]) {
    const m = machine(readyWorld());
    m.world.peers = peers;
    const { ctx, term, lines } = yesCtx(m, { only: ["devices"] }, false, [], { wait: noWait });
    const r = await runSetup([...STEPS], ctx);
    assert.deepEqual(outcomes(r), { devices: "done" }, lines.join("\n"));
    assert.deepEqual(readJson(m.at.configFile).allowedDevices, ["phone"]);
    assert.deepEqual(term.asked, []);
    assert.match(lines.join("\n"), /add phone to allowedDevices: the only iOS or Android machine of your Tailscale user \(user@example\.com\) in the tailnet/);
  }
});

test("devices --yes adds none when this user has two phones or none, says how to add one, and does not wait", async () => {
  const cases = [
    {
      peers: [mine("tablet", false), mine("phone"), theirs("phone-b")],
      says: "it has 2: phone, tablet (other users have phone-b).",
      how: "Choose with `ccrc setup` in a terminal, without --yes, or name yours: ccrc config set allowedDevices '[\"phone\"]'",
    },
    {
      peers: [theirs("phone-b")],
      says: "it has none (other users have phone-b).",
      how: "Sign in to Tailscale on the phone with the same account and run `ccrc setup` again, or name it: ccrc config set allowedDevices '[\"<name>\"]'",
    },
    { peers: [], says: "it has none.", how: "Sign in to Tailscale on the phone with the same account and run `ccrc setup` again" },
  ];
  for (const c of cases) {
    const m = machine(readyWorld());
    m.world.peers = c.peers;
    const { ctx, term, lines } = yesCtx(m, { only: ["devices"] }, false, [], { wait: noWait });
    const r = await runSetup([...STEPS], ctx);
    assert.equal(r.ok, true);
    assert.deepEqual(outcomes(r), { devices: "left" }, lines.join("\n"));
    const said = lines.slice(lines.findIndex((l) => l.startsWith("No phone added")));
    assert.equal(said[0], `No phone added: --yes adds one only when your Tailscale user (user@example.com) has exactly one iOS or Android machine in the tailnet, and ${c.says}`);
    assert.ok(said[1].startsWith(c.how), said[1]);
    assert.match(said[2], /^Not finished: no device allowed yet/);
    assert.ok(!fs.existsSync(m.at.configFile));
    assert.deepEqual(term.asked, []);
  }
});

test("devices offers only this user's phones, and names the others as not offered", async () => {
  const m = machine(readyWorld());
  m.world.peers = [theirs("phone-b"), mine("tablet", false), mine("phone")];
  const ctx = ctxOf(m, { only: ["devices"] });
  const r = await runSetup([...STEPS], ctx);
  assert.deepEqual(outcomes(r), { devices: "done" });
  assert.deepEqual(ctx.ask.offered, [["phone", "tablet"]]);
  assert.ok(ctx.ask.asked.includes("Which of your phones may use ccrc?"));
  assert.deepEqual(readJson(m.at.configFile).allowedDevices, ["phone"], "the online ones unless chosen otherwise");
  assert.match(ctx.lines.join("\n"), /Phones of other Tailscale users are not offered: phone-b\. To allow one anyway, list every device to allow: ccrc config set allowedDevices '\["<name>","\.\.\."\]'/);

  const picked = machine(readyWorld());
  picked.world.peers = [theirs("phone-b"), mine("tablet", false), mine("phone")];
  await runSetup([...STEPS], ctxOf(picked, { only: ["devices"] }, { pick: [["tablet", "phone"]] }));
  assert.deepEqual(readJson(picked.at.configFile).allowedDevices, ["tablet", "phone"]);
});

test("devices waits for a phone of this user to join, not for one of another user", async () => {
  const m = machine(readyWorld());
  m.world.peers = [theirs("phone-b")];
  const ctx = ctxOf(m, { only: ["devices"] }, { wait: (n) => (n === 2 && m.world.peers.push(mine("phone", false)), undefined) });
  const r = await runSetup([...STEPS], ctx);
  assert.deepEqual(outcomes(r), { devices: "done" });
  assert.deepEqual(ctx.ask.offered, [["phone"]]);
  assert.deepEqual(readJson(m.at.configFile).allowedDevices, ["phone"]);
  const text = ctx.lines.join("\n");
  assert.match(text, /No phone of yours is in the tailnet yet\. On the phone, install the Tailscale app and sign in with the same account as this machine \(user@example\.com\)\./);
  assert.match(text, /Phones of other Tailscale users are not offered: phone-b\./);
});

test("devices offers and adds no phone when Tailscale does not tell whose machines are whose", async () => {
  const selves: TsNode[] = [
    { DNSName: "laptop.example.ts.net.", OS: "linux", Online: true },
    { DNSName: "laptop.example.ts.net.", OS: "linux", Online: true, UserID: 9, Tags: ["tag:server"] },
  ];
  const why = ["Tailscale here does not say which user each machine belongs to", "this machine is tagged (tag:server), so it belongs to no Tailscale user"];
  for (const [i, self] of selves.entries()) {
    for (const yes of [true, false]) {
      const m = machine(readyWorld());
      m.world.self = self;
      m.world.peers = [
        { DNSName: "phone.example.ts.net.", OS: "iOS", Online: true, UserID: 9, Tags: ["tag:phone"] },
        { DNSName: "phone-b.example.ts.net.", OS: "android", Online: true },
      ];
      const ctx = ctxOf(m, { only: ["devices"], yes }, { wait: noWait });
      const r = await runSetup([...STEPS], ctx);
      assert.deepEqual(outcomes(r), { devices: "left" }, ctx.lines.join("\n"));
      assert.deepEqual(ctx.ask.offered, []);
      assert.ok(!fs.existsSync(m.at.configFile));
      const text = ctx.lines.join("\n");
      assert.ok(text.includes(`Setup cannot tell which phones are yours: ${why[i]}.`), text);
      assert.ok(text.includes(`Name yours by the first label of its MagicDNS name: ccrc config set allowedDevices '["<name>"]' (iOS and Android machines in the tailnet: phone, phone-b)`), text);
    }
  }
});

test("devices leaves an allowedDevices list already set as it is, whoever's machines it names", async () => {
  for (const yes of [true, false]) {
    const m = machine(readyWorld());
    m.world.peers = [mine("phone"), theirs("phone-b")];
    fs.mkdirSync(m.at.configDir, { recursive: true });
    const before = JSON.stringify({ schemaVersion: 1, allowedDevices: ["phone-b"] });
    fs.writeFileSync(m.at.configFile, before);
    const ctx = ctxOf(m, { only: ["devices"], yes });
    assert.deepEqual(outcomes(await runSetup([...STEPS], ctx)), { devices: "ok" });
    assert.equal(fs.readFileSync(m.at.configFile, "utf8"), before);
    assert.deepEqual(ctx.ask.offered, []);
  }
});

test("--dry-run says which phone --yes would add, or that it would add none", async () => {
  const m = machine(readyWorld());
  m.world.peers = [mine("phone"), theirs("phone-b")];
  const one = ctxOf(m, { only: ["devices"], yes: true, dryRun: true });
  await runSetup([...STEPS], one);
  assert.match(one.lines.join("\n"), /- add phone to allowedDevices: the only iOS or Android machine of your Tailscale user \(user@example\.com\) in the tailnet$/m);
  m.world.peers.push(mine("tablet"));
  const two = ctxOf(m, { only: ["devices"], yes: true, dryRun: true });
  await runSetup([...STEPS], two);
  assert.match(two.lines.join("\n"), /- add none: --yes adds a phone only when your Tailscale user \(user@example\.com\) has exactly one in the tailnet, and it has 2 \(phone, tablet\); setup says how to add yours$/m);
  const asked = ctxOf(m, { only: ["devices"], dryRun: true });
  await runSetup([...STEPS], asked);
  assert.match(asked.lines.join("\n"), /- you choose from phone, tablet, the iOS and Android machines of your Tailscale user \(user@example\.com\); the choice goes into allowedDevices$/m);
  assert.ok(!fs.existsSync(m.at.configFile));

  const fresh = ctxOf(machine(freshWorld()), { yes: true, dryRun: true });
  await runSetup([...STEPS], fresh);
  assert.match(fresh.lines.join("\n"), /- add your phone to allowedDevices if it is the only iOS or Android machine of your Tailscale user in the tailnet; otherwise add none and say how to add yours$/m);
});

test("serve will not take an HTTPS port that passes on elsewhere", async () => {
  const m = machine({ ...readyWorld(), served: { 8443: "http://127.0.0.1:3000" } });
  const ctx = ctxOf(m, { only: ["serve"] });
  const r = await runSetup([...STEPS], ctx);
  assert.deepEqual(outcomes(r), { serve: "failed" });
  assert.match(ctx.lines.join("\n"), /HTTPS port 8443 already passes on to http:\/\/127\.0\.0\.1:3000; choose another with --https-port/);
  const r2 = await runSetup([...STEPS], ctxOf(m, { only: ["serve"], httpsPort: 10443 }));
  assert.deepEqual(outcomes(r2), { serve: "done" });
  assert.equal(m.world.served[10443], "http://127.0.0.1:8737");
});

test("Tailscale comes from pacman on Arch", async () => {
  const m = machine(freshWorld());
  m.at.distro = "arch";
  const r = await runSetup([...STEPS], ctxOf(m, { only: ["tailscale-install"] }));
  assert.deepEqual(outcomes(r), { "tailscale-install": "done" });
  assert.deepEqual(
    m.calls.filter((c) => c.startsWith("attached")),
    ["attached sudo pacman -S --needed tailscale", "attached sudo systemctl enable --now tailscaled"],
  );
});

test("claude: with VS Code's code command the extension is installed, then setup waits for the login", async () => {
  const m = machine(readyWorld(), { extension: false });
  m.world.loggedIn = false;
  const ctx = ctxOf(m, { only: ["claude"] }, { wait: (n) => ((m.world.loggedIn = n >= 2), undefined) });
  const r = await runSetup([...STEPS], ctx);
  assert.deepEqual(outcomes(r), { claude: "done" });
  assert.ok(m.calls.includes("attached /usr/bin/code --install-extension anthropic.claude-code"));

  const m2 = machine(readyWorld(), { extension: false });
  m2.world.code = false;
  const ctx2 = ctxOf(m2, { only: ["claude"] }, { wait: () => "skip" });
  const r2 = await runSetup([...STEPS], ctx2);
  assert.deepEqual(outcomes(r2), { claude: "left" });
  assert.match(ctx2.lines.join("\n"), /curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/);
});

test("ssh-keygen: a missing one is shown with why and how to install it, without sudo; a checkout skips it", async () => {
  const m = machine({ ...readyWorld(), sshKeygen: false });
  const dry = ctxOf(m, { only: ["ssh-keygen"], dryRun: true });
  await runSetup([...STEPS], dry);
  assert.match(dry.lines.join("\n"), /\[todo\] ssh-keygen .*\(not on PATH\)/);
  assert.match(dry.lines.join("\n"), /you install it with: sudo apt-get install openssh-client/);

  const ctx = ctxOf(m, { only: ["ssh-keygen"], yes: true });
  const r = await runSetup([...STEPS], ctx);
  assert.deepEqual(outcomes(r), { "ssh-keygen": "left" });
  const text = ctx.lines.join("\n");
  assert.match(text, /ccrc update checks that a release tag is signed .* needs ssh-keygen/);
  assert.match(text, /^Install it with: sudo apt-get install openssh-client$/m);
  assert.match(text, /Still to do: ssh-keygen \(left\)/);
  assert.deepEqual(m.calls, []);

  m.world.sshKeygen = true;
  assert.deepEqual(outcomes(await runSetup([...STEPS], ctxOf(m, { only: ["ssh-keygen"] }))), { "ssh-keygen": "ok" });
  const checkout = machine({ ...readyWorld(), sshKeygen: false });
  checkout.at.installed = false;
  assert.deepEqual(outcomes(await runSetup([...STEPS], ctxOf(checkout, { only: ["ssh-keygen"] }))), { "ssh-keygen": "skipped" });
});

test("ssh-keygen: one older than OpenSSH 8.2 is shown with why and how to fix it, and setup goes on", async () => {
  const m = machine({ ...readyWorld(), oldOpenSsh: true });
  const dry = ctxOf(m, { only: ["ssh-keygen"], dryRun: true });
  await runSetup([...STEPS], dry);
  assert.match(dry.lines.join("\n"), /\[todo\] ssh-keygen +ssh-keygen from OpenSSH 8\.2 or newer, which ccrc update checks release signatures with \(\/usr\/bin\/ssh-keygen is older than OpenSSH 8\.2\)/);
  assert.match(dry.lines.join("\n"), /- you install OpenSSH 8\.2 or newer and make its ssh-keygen the first on PATH \(RHEL 8 and its rebuilds ship 8\.0\)$/m);

  const ctx = ctxOf(m, { only: ["ssh-keygen", "vscode"], yes: true });
  const r = await runSetup([...STEPS], ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(outcomes(r), { "ssh-keygen": "left", vscode: "done" });
  const text = ctx.lines.join("\n");
  assert.match(text, /^ccrc update checks that a release tag is signed by a key in \.ccrc-allowed-signers \(git verify-tag\), which needs ssh-keygen from OpenSSH 8\.2 or newer; \/usr\/bin\/ssh-keygen is older, so updates stop\.$/m);
  assert.match(text, /^Install OpenSSH 8\.2 or newer and make its ssh-keygen the first on PATH \(RHEL 8 and its rebuilds ship 8\.0\)$/m);
  assert.match(text, /Still to do: ssh-keygen \(left\)/);
  assert.ok(m.calls.every((c) => !c.startsWith("attached")), m.calls.join("\n"));

  m.world.oldOpenSsh = false;
  assert.deepEqual(outcomes(await runSetup([...STEPS], ctxOf(m, { only: ["ssh-keygen"] }))), { "ssh-keygen": "ok" });
});

test("ssh-keygen problems as git reports them, and as ssh-keygen answers what git asks it", async (t) => {
  assert.equal(gitSshKeygenProblem("error: cannot run ssh-keygen: No such file or directory\n"), "missing");
  assert.equal(gitSshKeygenProblem("error: ssh-keygen -Y find-principals/verify is needed for ssh signature verification (available in openssh version 8.2p1+)\n"), "old");
  assert.equal(gitSshKeygenProblem("error: no signature found\n"), undefined);
  const answers = (stderr: string) => async () => ({ stderr });
  assert.equal(await sshKeygenTooOld(answers("unknown option -- Y\nusage: ssh-keygen [-q] [-b bits]\n")), true);
  assert.equal(await sshKeygenTooOld(answers("Couldn't parse signature: missing header\n")), false);
  assert.equal(sshKeygenFix("missing", (cmd) => (cmd === "dnf" ? "/usr/bin/dnf" : undefined)), "install it with: sudo dnf install openssh-clients");
  assert.equal(sshKeygenFix("old", () => "/usr/bin/apt-get"), "install OpenSSH 8.2 or newer and make its ssh-keygen the first on PATH (RHEL 8 and its rebuilds ship 8.0)");

  const old = path.join(tempDir(), "ssh-keygen");
  fs.writeFileSync(old, "#!/bin/sh\necho 'unknown option -- Y' >&2\necho 'usage: ssh-keygen [-q] [-b bits]' >&2\nexit 1\n", { mode: 0o755 });
  assert.equal(await sshKeygenTooOld((_cmd, args) => realRunner.run(old, args)), true);
  if (spawnSync("ssh-keygen", ["-?"]).error) return t.skip("no ssh-keygen");
  assert.equal(await sshKeygenTooOld((cmd, args) => realRunner.run(cmd, args)), false, "this machine's ssh-keygen");
});

test("the ssh-keygen package is named for the package manager found", () => {
  const on = (...found: string[]) => (cmd: string) => (found.includes(cmd) ? `/usr/bin/${cmd}` : undefined);
  assert.equal(sshKeygenInstall(on("apt-get")), "install it with: sudo apt-get install openssh-client");
  assert.equal(sshKeygenInstall(on("dnf")), "install it with: sudo dnf install openssh-clients");
  assert.equal(sshKeygenInstall(on("pacman")), "install it with: sudo pacman -S --needed openssh");
  assert.equal(sshKeygenInstall(on("zypper")), "install it with: sudo zypper install openssh-clients");
  assert.match(sshKeygenInstall(on()), /openssh-client on Debian and Ubuntu, openssh-clients on Fedora, RHEL and openSUSE, openssh on Arch/);
});

test("vscode: asks, keeps the file's comments, and copies it first; --no-vscode and no VS Code skip it", async () => {
  const m = machine(readyWorld());
  const file = path.join(m.at.vscodeUserDir, "User", "settings.json");
  const before = `// my settings\n{\n\t"editor.fontSize": 14, // big\n\t"claudeCode.claudeProcessWrapper": "/home/user/ccrc/bin/ccrc-wrapper",\n}\n`;
  fs.writeFileSync(file, before, { mode: 0o644 });
  const declined = await runSetup([...STEPS], ctxOf(m, { only: ["vscode"] }, { confirm: [true, false] }));
  assert.deepEqual(outcomes(declined), { vscode: "declined" });
  assert.equal(fs.readFileSync(file, "utf8"), before);

  const ctx = ctxOf(m, { only: ["vscode"] });
  const r = await runSetup([...STEPS], ctx);
  assert.deepEqual(outcomes(r), { vscode: "done" });
  const after = fs.readFileSync(file, "utf8");
  assert.equal(after, before.replace("/home/user/ccrc/bin/ccrc-wrapper", m.at.wrapper));
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  const backups = fs.readdirSync(path.join(m.at.stateDir, "backup"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(m.at.stateDir, "backup", backups[0]), "utf8"), before);
  assert.match(ctx.lines.join("\n"), /close and open them again/);

  assert.deepEqual(outcomes(await runSetup([...STEPS], ctxOf(m, { only: ["vscode"], noVscode: true }))), { vscode: "skipped" });
  const bare = machine(readyWorld(), { vscode: false });
  const r3 = await runSetup([...STEPS], ctxOf(bare, { only: ["vscode"] }));
  assert.equal(r3.reports[0].outcome, "skipped");
  assert.match(r3.reports[0].detail ?? "", /no VS Code settings folder/);
});

test("settings.json edits change only the member and the comma next to it", () => {
  const text = '{\n  // keep me\n  "one": 1, /* and me */\n  "two": [1, 2,],\n}\n';
  const added = editSettingsText(text, WRAPPER_SETTING, "/w");
  assert.equal(added, '{\n  // keep me\n  "one": 1, /* and me */\n  "two": [1, 2,],\n  "claudeCode.claudeProcessWrapper": "/w",\n}\n');
  assert.equal(editSettingsText(added, WRAPPER_SETTING, undefined), text);
  assert.equal(editSettingsText(added, WRAPPER_SETTING, "/x"), added.replace('"/w"', '"/x"'));
  assert.equal(editSettingsText('{\n\t"x": 1 // note\n}', "k", "v"), '{\n\t"x": 1, // note\n\t"k": "v"\n}');
  assert.equal(editSettingsText('{\r\n  "a": 1\r\n}\r\n', "k", "v"), '{\r\n  "a": 1,\r\n  "k": "v"\r\n}\r\n');
  assert.equal(editSettingsText('{"a":1}', "k", "v"), '{"a":1, "k": "v"}');
  assert.equal(editSettingsText("", "k", "v"), '{\n    "k": "v"\n}\n');
  assert.equal(editSettingsText("{}", "k", "v"), '{\n    "k": "v"\n}');
  assert.equal(editSettingsText("// only a comment\n", "k", "v"), '// only a comment\n{\n    "k": "v"\n}\n');
  assert.equal(editSettingsText('{\n  "k": "a",\n  "b": 2,\n  "k": "c"\n}', "k", undefined), '{\n  "b": 2\n}');
  assert.equal(editSettingsText(text, "missing", undefined), text);
  assert.throws(() => editSettingsText('{"a": }', "b", "c"), /line 1, column 7/);
  assert.throws(() => parseSettingsText("[1]"), /JSON object/);
  // A block comment that runs on past the last member's line is not where the new member goes.
  const multi = editSettingsText('{\n  "a": 1 /* one\n  two */\n}\n', "k", "v");
  assert.deepEqual(parseSettingsText(multi), { a: 1, k: "v" });
  assert.match(multi, /one\n  two \*\//);
});

test("an unchanged settings.json is neither copied nor written", () => {
  const dir = tempDir();
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, '{ "a": 1 }\n');
  fs.chmodSync(file, 0o600);
  const before = fs.statSync(file).mtimeMs;
  const r = changeSetting(file, "missing", undefined, path.join(dir, "backup"));
  assert.equal(r.backup, undefined);
  assert.ok(!fs.existsSync(path.join(dir, "backup")));
  assert.equal(fs.statSync(file).mtimeMs, before);
  changeSetting(file, "b", "x", path.join(dir, "backup"));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("a settings.json that is a link is changed where it points", () => {
  const dir = tempDir();
  const real = path.join(dir, "dotfiles", "settings.json");
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, '{ "a": 1 }\n');
  const link = path.join(dir, "Code", "User", "settings.json");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(real, link);
  const r = changeSetting(link, "b", "x", path.join(dir, "backup"));
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.deepEqual(parseSettingsText(fs.readFileSync(real, "utf8")), { a: 1, b: "x" });
  assert.equal(fs.readFileSync(r.backup!, "utf8"), '{ "a": 1 }\n');
});

test("tailnet phones are told apart by the Tailscale user this machine belongs to", () => {
  const p = phones({
    Self: { DNSName: "laptop.example.ts.net.", OS: "linux", UserID: 1 },
    Peer: {
      a: { DNSName: "tablet.example.ts.net.", OS: "iOS", Online: false, UserID: 1 },
      b: { DNSName: "phone.example.ts.net.", OS: "android", Online: true, UserID: 1 },
      c: { DNSName: "other-host.example.ts.net.", OS: "linux", Online: true, UserID: 1 },
      d: { DNSName: "phone-b.example.ts.net.", OS: "iOS", Online: true, UserID: 2 },
      e: { DNSName: "kiosk.example.ts.net.", OS: "android", Online: true, UserID: 1, Tags: ["tag:kiosk"] },
      f: { DNSName: "phone-c.example.ts.net.", OS: "iOS", Online: false },
      g: { DNSName: "phone.other.example.ts.net.", OS: "iOS", Online: true, UserID: 1 },
      h: { DNSName: "shared.example.ts.net.", OS: "iOS", Online: true, UserID: 1, ShareeNode: true },
    },
    User: { "1": { LoginName: "user@example.com" } },
  });
  assert.deepEqual(
    p.mine.map((x) => x.name),
    ["phone", "tablet"],
  );
  assert.deepEqual(p.mine[1], { name: "tablet", os: "iOS", online: false });
  assert.deepEqual(
    p.others.map((x) => x.name),
    ["kiosk", "phone-b", "phone-c"],
    "a tagged machine belongs to its tags; one without a user is no one's",
  );
  assert.equal(p.user, "user@example.com");
  assert.equal(p.unknown, undefined);

  const phone = { DNSName: "phone.example.ts.net.", OS: "iOS", Online: true, UserID: 1 };
  for (const self of [{ DNSName: "laptop.example.ts.net." }, { DNSName: "laptop.example.ts.net.", UserID: 0 }]) {
    const old = phones({ Self: self, Peer: { a: { DNSName: "phone.example.ts.net.", OS: "iOS", Online: true } } });
    assert.deepEqual(old.mine, []);
    assert.deepEqual(
      old.others.map((x) => x.name),
      ["phone"],
    );
    assert.equal(old.unknown, "Tailscale here does not say which user each machine belongs to");
    assert.deepEqual(phones({ Self: self, Peer: { a: phone } }).mine, [], "nor does a peer with a user make it so");
  }
  const tagged = phones({ Self: { DNSName: "laptop.example.ts.net.", UserID: 9, Tags: ["tag:server"] }, Peer: { a: { ...phone, UserID: 9, Tags: ["tag:phone"] } } });
  assert.deepEqual(tagged.mine, []);
  assert.equal(tagged.unknown, "this machine is tagged (tag:server), so it belongs to no Tailscale user");
  assert.deepEqual(phones(undefined), { mine: [], others: [] });
});

test("serve targets that reach the broker", () => {
  assert.equal(reachesBroker("http://127.0.0.1:8737", 8737), true);
  assert.equal(reachesBroker("http://localhost:8737/", 8737), true);
  assert.equal(reachesBroker("127.0.0.1:8737", 8737), true);
  assert.equal(reachesBroker("http://127.0.0.1:3000", 8737), false);
  assert.equal(reachesBroker("http://100.64.0.3:8737", 8737), false);
});

test("setup flags", () => {
  assert.deepEqual(parseSetupArgs(["--yes", "--only", "service, serve", "--https-port", "10443", "--no-vscode"]), {
    yes: true,
    allowSudo: false,
    dryRun: false,
    noSystem: false,
    noVscode: true,
    noServe: false,
    httpsPort: 10443,
    only: ["service", "serve"],
    skip: [],
  });
  assert.equal(parseSetupArgs(["--allow-sudo"]).allowSudo, true);
  assert.throws(() => parseSetupArgs(["--https-port", "x"]), /port number/);
  assert.throws(() => parseSetupArgs(["--bogus"]), /Unknown option/);
});

function installed(m: Machine): void {
  const { at } = m;
  fs.mkdirSync(path.join(at.dataDir, "versions", VERSION, "bin"), { recursive: true });
  fs.symlinkSync(path.join("versions", VERSION), path.join(at.dataDir, "current"));
  fs.mkdirSync(path.join(at.home, ".local", "bin"), { recursive: true });
  fs.symlinkSync(at.ccrc, path.join(at.home, ".local", "bin", "ccrc"));
  fs.writeFileSync(path.join(at.vscodeUserDir, "User", "settings.json"), `{\n  // mine\n  "a": 1,\n  "${WRAPPER_SETTING}": "${at.wrapper}"\n}\n`);
  const unitFile = path.join(at.xdgConfigHome, "systemd", "user", "ccrc.service");
  fs.mkdirSync(path.dirname(unitFile), { recursive: true });
  fs.writeFileSync(unitFile, unitText({ ccrc: at.ccrc, node: at.node, path: "/usr/bin", env: {} }));
  fs.mkdirSync(at.configDir, { recursive: true });
  fs.writeFileSync(at.configFile, "{}");
  fs.mkdirSync(at.stateDir, { recursive: true });
}

function uninstallCtx(m: Machine, o: { purge?: boolean; dryRun?: boolean; noSystem?: boolean; yes?: boolean } = {}, answers?: Answers) {
  const lines: string[] = [];
  return {
    lines,
    ctx: {
      o: { purge: false, dryRun: false, noSystem: false, yes: true, ...o },
      at: m.at,
      run: m.runner,
      ask: fakePrompt(answers),
      out: (l: string) => lines.push(l),
      now: () => new Date("2026-10-17T00:00:00Z"),
      inService: () => false,
    },
  };
}

test("uninstall takes VS Code's setting out first, then the service, serve and the install", async () => {
  const m = machine(readyWorld());
  installed(m);
  m.world.served[9443] = "http://127.0.0.1:3000";
  const order: string[] = [];
  const settings = path.join(m.at.vscodeUserDir, "User", "settings.json");
  const run = m.runner.run.bind(m.runner);
  m.runner.run = async (cmd, args) => {
    if (cmd === "systemctl" && args.includes("disable")) order.push(`service; wrapper setting there: ${fs.readFileSync(settings, "utf8").includes(WRAPPER_SETTING)}`);
    return run(cmd, args);
  };

  const dry = uninstallCtx(m, { dryRun: true });
  assert.equal(await runUninstall(dry.ctx), true);
  assert.ok(fs.existsSync(m.at.dataDir));
  assert.match(dry.lines.join("\n"), /--dry-run/);

  const { ctx, lines } = uninstallCtx(m);
  assert.equal(await runUninstall(ctx), true, lines.join("\n"));
  assert.deepEqual(order, ["service; wrapper setting there: false"]);
  assert.equal(fs.readFileSync(settings, "utf8"), `{\n  // mine\n  "a": 1\n}\n`);
  assert.ok(!fs.existsSync(path.join(m.at.xdgConfigHome, "systemd", "user", "ccrc.service")));
  assert.deepEqual(m.world.served, { 9443: "http://127.0.0.1:3000" });
  assert.ok(!fs.existsSync(m.at.dataDir));
  assert.ok(!fs.existsSync(path.join(m.at.home, ".local", "bin", "ccrc")));
  assert.ok(fs.existsSync(m.at.configFile), "settings stay without --purge");
  assert.ok(fs.readdirSync(path.join(m.at.stateDir, "backup")).length === 1);
});

test("uninstall --purge removes settings and state; it leaves a service and setting of another copy", async () => {
  const m = machine(readyWorld());
  installed(m);
  const settings = path.join(m.at.vscodeUserDir, "User", "settings.json");
  fs.writeFileSync(settings, `{ "${WRAPPER_SETTING}": "/home/user/ccrc/bin/ccrc-wrapper" }`);
  const unitFile = path.join(m.at.xdgConfigHome, "systemd", "user", "ccrc.service");
  fs.writeFileSync(unitFile, unitText({ ccrc: "/home/user/ccrc/bin/ccrc", node: "/usr/bin/node", path: "/usr/bin", env: {} }));
  const { ctx, lines } = uninstallCtx(m, { purge: true });
  assert.equal(await runUninstall(ctx), true);
  const text = lines.join("\n");
  assert.match(text, /left: it points at \/home\/user\/ccrc\/bin\/ccrc-wrapper/);
  assert.match(text, /ccrc\.service is left: it runs \/home\/user\/ccrc\/bin\/ccrc/);
  assert.ok(fs.existsSync(unitFile));
  assert.deepEqual(m.world.served, { 8443: "http://127.0.0.1:8737" }, "serve stays with the service that uses it");
  assert.ok(!fs.existsSync(m.at.configDir) && !fs.existsSync(m.at.stateDir) && !fs.existsSync(m.at.dataDir));
  assert.ok(!m.calls.some((c) => c.includes("disable")));
});

test("uninstall asks first, and --no-system leaves the service and serve", async () => {
  const m = machine(readyWorld());
  installed(m);
  const no = uninstallCtx(m, { yes: false }, { confirm: [false] });
  assert.equal(await runUninstall(no.ctx), false);
  assert.ok(fs.existsSync(m.at.dataDir));

  m.calls.length = 0;
  const { ctx, lines } = uninstallCtx(m, { noSystem: true });
  assert.equal(await runUninstall(ctx), true);
  assert.match(lines.join("\n"), /ccrc\.service is left \(--no-system\)/);
  assert.ok(!m.calls.some((c) => /systemctl|tailscale/.test(c)));
  assert.ok(!fs.existsSync(m.at.dataDir));
});

test("uninstall leaves a folder it must not remove whole, such as the home folder", async () => {
  assert.equal(safeToRemove("/home/user/.local/share/ccrc", "/home/user"), true);
  for (const d of ["/", "/home", "/home/user", "/home/user/", "relative/ccrc"]) assert.equal(safeToRemove(d, "/home/user"), false, d);
  const m = machine(readyWorld());
  installed(m);
  m.at = { ...m.at, configDir: m.at.home };
  const { ctx, lines } = uninstallCtx(m, { purge: true, noSystem: true });
  assert.equal(await runUninstall(ctx), true, lines.join("\n"));
  assert.ok(fs.existsSync(m.at.home) && fs.existsSync(path.join(m.at.home, ".config")));
  assert.match(lines.join("\n"), /is left: it is your home folder or a folder other programs share/);
  assert.ok(!fs.existsSync(m.at.dataDir) && !fs.existsSync(m.at.stateDir));
});

test("setup and uninstall refuse root", () => {
  assert.match(rootRefusal("setup", 0)!, /do not run this as root/);
  assert.equal(rootRefusal("setup", 1000), undefined);
});

test("linger is optional: --yes leaves it off and asks nothing, and a second run passes without it", async () => {
  const m = machine(readyWorld());
  Object.assign(m.world, { enabled: false, active: false, linger: false });
  const ctx = ctxOf(m, { only: ["service"], yes: true });
  const r = await runSetup([...STEPS], ctx);
  assert.deepEqual(outcomes(r), { service: "done" }, ctx.lines.join("\n"));
  assert.ok(!m.calls.some((c) => c.includes("enable-linger")), m.calls.join("\n"));
  assert.match(ctx.lines.join("\n"), /Linger stays off/);
  const again = ctxOf(m, { only: ["service"] });
  assert.ok((await runSetup([...STEPS], again)).reports.every((x) => x.outcome === "ok"));
  assert.equal(again.ask.asked.length, 0);
});

test("the service step keeps the Environment lines it does not write, and writes the unit whole", async () => {
  const m = machine(readyWorld());
  const unitFile = path.join(m.at.xdgConfigHome, "systemd", "user", "ccrc.service");
  const old = unitText({ ccrc: "/home/user/ccrc/bin/ccrc", node: "/usr/bin/node", path: "/usr/bin", env: {} }).replace(
    "Restart=on-failure",
    'Environment=HTTPS_PROXY=http://proxy.example.com:3128 "NO_PROXY=localhost,127.0.0.1"\nEnvironment=ANTHROPIC_BASE_URL=https://api.example.com\nEnvironment=CCRC_NODE=/old/node PATH=/old\nEnvironmentFile=-/home/user/.config/ccrc.env\nRestart=on-failure',
  );
  fs.mkdirSync(path.dirname(unitFile), { recursive: true });
  fs.writeFileSync(unitFile, old);
  const ctx = ctxOf(m, { only: ["service"] });
  assert.deepEqual(outcomes(await runSetup([...STEPS], ctx)), { service: "done" }, ctx.lines.join("\n"));
  const unit = fs.readFileSync(unitFile, "utf8");
  assert.match(unit, /^Environment=HTTPS_PROXY=http:\/\/proxy\.example\.com:3128 "NO_PROXY=localhost,127\.0\.0\.1"$/m);
  assert.match(unit, /^Environment=ANTHROPIC_BASE_URL=https:\/\/api\.example\.com$/m);
  assert.match(unit, /^EnvironmentFile=-\/home\/user\/\.config\/ccrc\.env$/m);
  assert.ok(!unit.includes("/old/node"), "setup's own variables are its own");
  assert.equal((unit.match(/^Environment=CCRC_NODE=/gm) ?? []).length, 1);
  assert.match(ctx.lines.join("\n"), /kept from it: Environment=ANTHROPIC_BASE_URL/);
  assert.deepEqual(fs.readdirSync(path.dirname(unitFile)), ["ccrc.service"]);
});

test("setup's service step and uninstall refuse to run inside ccrc.service", async () => {
  const m = machine(readyWorld());
  Object.assign(m.world, { active: false });
  const ctx = { ...ctxOf(m, { only: ["service"] }), inService: () => true };
  const r = await runSetup([...STEPS], ctx);
  assert.deepEqual(outcomes(r), { service: "failed" });
  assert.match(ctx.lines.join("\n"), /ccrc setup restarts or stops ccrc\.service, and this runs inside it/);
  assert.ok(!m.calls.some((c) => /restart|daemon-reload/.test(c)));

  installed(m);
  const u = uninstallCtx(m);
  u.ctx.inService = () => true;
  assert.equal(await runUninstall(u.ctx), false);
  assert.match(u.lines.join("\n"), /ccrc uninstall restarts or stops ccrc\.service/);
  assert.ok(fs.existsSync(m.at.dataDir));
});

test("tailscale-login runs a bare `tailscale up`, which keeps the machine's other Tailscale settings", async () => {
  const m = machine({ ...readyWorld(), backend: "NeedsLogin" });
  const ctx = ctxOf(m, { only: ["tailscale-login"] });
  assert.deepEqual(outcomes(await runSetup([...STEPS], ctx)), { "tailscale-login": "done" });
  assert.deepEqual(
    m.calls.filter((c) => c.startsWith("attached")),
    ["attached sudo tailscale up"],
  );
});

test("config keeps an empty roots list, and a 0.6 config without one; \"none\" chooses it", async () => {
  const m = machine(readyWorld());
  fs.mkdirSync(m.at.configDir, { recursive: true });
  fs.writeFileSync(m.at.configFile, JSON.stringify({ schemaVersion: 1, roots: [], brokerSessions: "subscription", claudePath: "vscode" }));
  const ctx = ctxOf(m, { only: ["config"], yes: true });
  const r = await runSetup([...STEPS], ctx);
  assert.deepEqual(outcomes(r), { config: "ok" }, ctx.lines.join("\n"));
  assert.match(ctx.lines.join("\n"), /roots none/);
  assert.deepEqual(readJson(m.at.configFile).roots, []);

  fs.writeFileSync(m.at.configFile, JSON.stringify({ allowedDevices: ["phone"] }));
  assert.deepEqual(outcomes(await runSetup([...STEPS], ctxOf(m, { only: ["config"], yes: true }))), { config: "ok" });

  fs.writeFileSync(m.at.configFile, JSON.stringify({ schemaVersion: 1, allowedDevices: ["phone"] }));
  const asked = ctxOf(m, { only: ["config"] }, { text: ["None"] });
  assert.deepEqual(outcomes(await runSetup([...STEPS], asked)), { config: "done" });
  assert.deepEqual(readJson(m.at.configFile).roots, []);
});

test("uninstall touches no shared folder, and outside a folder of its own removes only what ccrc made", async () => {
  for (const d of ["/home/user/.local/share", "/home/user/.config", "/home/user/.local/state", "/home/user/.local", "/home/user/.cache"]) {
    assert.equal(safeToRemove(d, "/home/user", ["/home/user/.config", "/home/user/.local", "/home/user/.local/share", "/home/user/.local/state", "/home/user/.cache"]), false, d);
  }
  const m = machine(readyWorld());
  installed(m);
  const share = path.join(m.at.home, ".local", "share");
  fs.mkdirSync(path.join(share, "otherapp"), { recursive: true });
  fs.mkdirSync(path.join(m.at.home, ".config", "otherapp"), { recursive: true });
  fs.writeFileSync(path.join(m.at.home, ".config", "otherapp", "c"), "x");
  m.at = { ...m.at, dataDir: share, configDir: path.join(m.at.home, ".config") };
  const { ctx, lines } = uninstallCtx(m, { purge: true, noSystem: true });
  assert.equal(await runUninstall(ctx), true, lines.join("\n"));
  assert.ok(fs.existsSync(path.join(share, "otherapp")) && fs.existsSync(path.join(m.at.home, ".config", "otherapp", "c")), lines.join("\n"));
  assert.match(lines.join("\n"), /\.local\/share is left: it is your home folder or a folder other programs share/);

  // A folder of another name: only ccrc's own entries go.
  const m2 = machine(readyWorld());
  installed(m2);
  const mine = path.join(m2.at.home, "apps");
  fs.mkdirSync(path.join(mine, "versions"), { recursive: true });
  fs.writeFileSync(path.join(mine, "history.json"), "[]");
  fs.writeFileSync(path.join(mine, "notes.txt"), "mine");
  m2.at = { ...m2.at, dataDir: mine };
  const u = uninstallCtx(m2, { noSystem: true });
  assert.equal(await runUninstall(u.ctx), true, u.lines.join("\n"));
  assert.deepEqual(fs.readdirSync(mine), ["notes.txt"]);
  assert.match(u.lines.join("\n"), /keeps what ccrc did not make there: notes\.txt/);
});

test("uninstall leaves <dataDir>/node while a checkout the service or VS Code runs needs it, and --purge keeps the VS Code backup", async () => {
  const m = machine(readyWorld());
  fs.mkdirSync(path.join(m.at.dataDir, "node-v22.20.0-linux-x64", "bin"), { recursive: true });
  fs.symlinkSync("node-v22.20.0-linux-x64", path.join(m.at.dataDir, "node"));
  const unitFile = path.join(m.at.xdgConfigHome, "systemd", "user", "ccrc.service");
  fs.mkdirSync(path.dirname(unitFile), { recursive: true });
  fs.writeFileSync(unitFile, unitText({ ccrc: "/home/user/ccrc/bin/ccrc", node: path.join(m.at.dataDir, "node", "bin", "node"), path: "/usr/bin", env: {} }));
  const { ctx, lines } = uninstallCtx(m, { dryRun: true });
  assert.equal(await runUninstall(ctx), true);
  assert.match(lines.join("\n"), /node is left: the ccrc that the service or VS Code still runs finds Node\.js there/);
  assert.ok(!lines.some((l) => l.includes(`remove ${m.at.dataDir}`)), lines.join("\n"));

  const p = machine(readyWorld());
  installed(p);
  const purge = uninstallCtx(p, { purge: true });
  assert.equal(await runUninstall(purge.ctx), true, purge.lines.join("\n"));
  const userDir = path.join(p.at.vscodeUserDir, "User");
  const copies = fs.readdirSync(userDir).filter((n) => n !== "settings.json");
  assert.equal(copies.length, 1, "the copy of settings.json outlives the state folder");
  assert.match(fs.readFileSync(path.join(userDir, copies[0]), "utf8"), /claudeProcessWrapper/);
  assert.ok(!fs.existsSync(p.at.stateDir));
});

// As cli.ts builds it: --yes answers questions with their defaults, while sudo is asked of the terminal, if there is one.
function yesCtx(m: Machine, o: Partial<SetupOptions>, terminal: boolean, sudoAnswers: boolean[] = [], answers: Answers = {}) {
  const base = ctxOf(m, { yes: true, ...o }, { ...answers, interactive: terminal, confirm: sudoAnswers });
  const term = base.ask;
  const ctx: Ctx = { ...base, ask: withDefaults(term), sudoAsk: term };
  return { ctx, term, lines: base.lines };
}

const SUDO_STEPS = ["tailscale-install", "tailscale-login", "tailscale-operator"];

test("--yes without a terminal runs no sudo: those steps are left as needing consent, with how to give it", async () => {
  const m = machine({ ...freshWorld(), loggedIn: true });
  const { ctx, lines } = yesCtx(m, { only: [...SUDO_STEPS, "https"] }, false);
  const r = await runSetup([...STEPS], ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(outcomes(r), { "tailscale-install": "needs-sudo", "tailscale-login": "blocked", "tailscale-operator": "blocked", https: "blocked" });
  assert.ok(!m.calls.some((c) => c.startsWith("attached")), m.calls.join("\n"));
  const text = lines.join("\n");
  assert.match(text, /This uses sudo: install Tailscale's system package/);
  assert.match(text, /Left for later: sudo consent needed; run `ccrc setup` in a terminal to be asked, or again with --allow-sudo\./);
  assert.match(text, /it needs tailscale-install, which is sudo consent needed/);
  assert.match(text, /Still to do: tailscale-install \(sudo consent needed\), tailscale-login \(blocked\)/);
  assert.match(text, /For the steps that need sudo, run `ccrc setup` in a terminal to be asked, or again with --allow-sudo\./);
});

test("--allow-sudo without a terminal lets the sudo steps run", async () => {
  const m = machine({ ...freshWorld(), loggedIn: true });
  const { ctx, lines } = yesCtx(m, { only: SUDO_STEPS, allowSudo: true }, false);
  const r = await runSetup([...STEPS], ctx);
  assert.deepEqual(outcomes(r), { "tailscale-install": "done", "tailscale-login": "done", "tailscale-operator": "done" });
  assert.deepEqual(
    m.calls.filter((c) => c.startsWith("attached")),
    ["attached sh -c curl -fsSL https://tailscale.com/install.sh | sh", "attached sudo tailscale up", "attached sudo tailscale set --operator=user"],
  );
  assert.equal(lines.filter((l) => l === "No terminal to ask on; --allow-sudo lets it run.").length, 3);
});

test("with a terminal, sudo is asked even with --yes (and with --allow-sudo), and a no is kept", async () => {
  const m = machine({ ...readyWorld(), backend: "NeedsLogin", operator: false });
  for (const allowSudo of [false, true]) {
    m.calls.length = 0;
    const { ctx, term, lines } = yesCtx(m, { only: ["tailscale-login", "tailscale-operator"], allowSudo }, true, [false]);
    const r = await runSetup([...STEPS], ctx);
    assert.deepEqual(outcomes(r), { "tailscale-login": "declined", "tailscale-operator": "blocked" });
    assert.deepEqual(term.asked, ["Run this with sudo?"], "only the sudo question reaches the person");
    assert.ok(!m.calls.some((c) => c.startsWith("attached")));
    assert.match(lines.join("\n"), /This uses sudo: sign this machine in to your tailnet/);
  }
  const { ctx, term } = yesCtx(m, { only: ["tailscale-login", "tailscale-operator"] }, true, [true, true]);
  assert.deepEqual(outcomes(await runSetup([...STEPS], ctx)), { "tailscale-login": "done", "tailscale-operator": "done" });
  assert.equal(term.asked.length, 2);
});

test("--dry-run says which steps use sudo and why", async () => {
  const m = machine(freshWorld());
  const ctx = ctxOf(m, { dryRun: true, only: ["tailscale-operator"] });
  await runSetup([...STEPS], ctx);
  assert.match(ctx.lines.join("\n"), /sudo, to let your user run `tailscale serve`.*asked first, --yes or not; without a terminal only with --allow-sudo/);
});

test("the sudo fallback for linger needs consent like any sudo", async () => {
  const m = machine(readyWorld());
  Object.assign(m.world, { linger: false, lingerNeedsSudo: true });
  const unitFile = path.join(m.at.xdgConfigHome, "systemd", "user", "ccrc.service");
  fs.mkdirSync(path.dirname(unitFile), { recursive: true });
  fs.writeFileSync(unitFile, unitText({ ccrc: m.at.ccrc, node: m.at.node, path: "/usr/bin", env: {} }));
  Object.assign(m.world, { active: false });
  const ctx = ctxOf(m, { only: ["service"] });
  ctx.sudoAsk = fakePrompt({ interactive: false });
  const r = await runSetup([...STEPS], ctx);
  assert.deepEqual(outcomes(r), { service: "done" });
  assert.ok(!m.calls.includes("attached sudo loginctl enable-linger user"));
  assert.match(ctx.lines.join("\n"), /Linger stays off \(sudo consent needed\): run `ccrc setup` in a terminal to be asked, or again with --allow-sudo, or run sudo loginctl enable-linger user yourself\./);

  // Stopped again, so the step has something to do and comes to linger.
  m.world.active = false;
  const allowed = ctxOf(m, { only: ["service"], allowSudo: true });
  allowed.sudoAsk = fakePrompt({ interactive: false });
  await runSetup([...STEPS], allowed);
  assert.ok(m.calls.includes("attached sudo loginctl enable-linger user"));
  assert.equal(m.world.linger, true);
});
