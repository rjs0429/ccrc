import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { DoctorResult } from "../src/admin-protocol.ts";
import { SetupUsageError, runSetup, type Ctx, type SetupOptions, type Where } from "../src/setup/engine.ts";
import type { Choice, Prompt, RunResult, Runner } from "../src/setup/io.ts";
import { parseSetupArgs } from "../src/setup/cli.ts";
import { unitMatches, unitProgram, unitText } from "../src/setup/service.ts";
import { STEPS } from "../src/setup/steps.ts";
import { phones, reachesBroker } from "../src/setup/tailscale.ts";
import { runUninstall } from "../src/setup/uninstall.ts";
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
  peers: { DNSName: string; OS: string; Online: boolean }[];
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
    peers: [{ DNSName: "phone.example.ts.net.", OS: "iOS", Online: true }],
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
    Self: { DNSName: "laptop.example.ts.net.", OS: "linux", Online: true },
    Peer: Object.fromEntries(world.peers.map((p, i) => [`k${i}`, p])),
    CurrentTailnet: { MagicDNSEnabled: world.magicDns },
    CertDomains: world.certs ? ["laptop.example.ts.net"] : null,
  });
  const serveJson = () => ({ Web: Object.fromEntries(Object.entries(world.served).map(([p, proxy]) => [`laptop.example.ts.net:${p}`, { Handlers: { "/": { Proxy: proxy } } }])) });
  const runner: Runner = {
    which(cmd) {
      if (cmd === "tailscale") return world.tailscale ? "/usr/bin/tailscale" : undefined;
      if (cmd === "code") return world.code ? "/usr/bin/code" : undefined;
      if (cmd === "qrencode") return world.qrencode ? "/usr/bin/qrencode" : undefined;
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
      return fail(`unexpected: ${line}`, 99);
    },
    async attached(cmd, args) {
      const line = [cmd, ...args].join(" ");
      calls.push(`attached ${line}`);
      if (line === "sh -c curl -fsSL https://tailscale.com/install.sh | sh") Object.assign(world, { tailscale: true, daemon: true, backend: "NeedsLogin" });
      else if (line === "sudo pacman -S --needed tailscale") world.tailscale = true;
      else if (line === "sudo systemctl enable --now tailscaled") Object.assign(world, { daemon: true, backend: "NeedsLogin" });
      else if (line === "sudo tailscale up --operator=user --qr") world.backend = "Running";
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

function fakePrompt(a: Answers = {}): Prompt & { asked: string[] } {
  const asked: string[] = [];
  let waits = 0;
  return {
    asked,
    interactive: a.interactive ?? true,
    confirm: async (q, def) => (asked.push(q), a.confirm?.length ? a.confirm.shift()! : def),
    choose: async <T extends string>(q: string, _c: Choice<T>[], def: T) => (asked.push(q), (a.choose?.shift() as T | undefined) ?? def),
    pick: async (q, _c, def) => (asked.push(q), a.pick?.shift() ?? def),
    text: async (q, def) => (asked.push(q), a.text?.shift() ?? def),
    secret: async (q) => (asked.push(q), a.secret?.shift() ?? ""),
    wait: async () => {
      waits++;
      if (waits > 50) throw Error("waited too long");
      return a.wait?.(waits);
    },
  };
}

const OPTIONS: SetupOptions = { yes: false, dryRun: false, noSystem: false, noVscode: false, noServe: false, httpsPort: 8443, skip: [] };

function ctxOf(m: Machine, o: Partial<SetupOptions> = {}, answers?: Answers): Ctx & { lines: string[]; ask: ReturnType<typeof fakePrompt> } {
  const lines: string[] = [];
  const ask = fakePrompt(answers);
  return {
    o: { ...OPTIONS, ...o },
    at: m.at,
    run: m.runner,
    ask,
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
    { DNSName: "phone.example.ts.net.", OS: "iOS", Online: true },
    { DNSName: "other-host.example.ts.net.", OS: "linux", Online: true },
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
    "attached sudo tailscale up --operator=user --qr",
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
  assert.match(ctx.lines.join("\n"), /stops at logout \(no linger\), runs v0\.6\.0/);
  assert.equal(first.ok, false, "a broker that keeps answering with the old version fails the step");
  assert.ok(m.calls.includes("run systemctl --user restart ccrc.service"));
  assert.ok(m.calls.includes("attached sudo loginctl enable-linger user"));
  assert.ok(!m.calls.includes("run systemctl --user daemon-reload"), "the unit already matched");
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
      if (n === 3) m.world.peers = [{ DNSName: "phone.example.ts.net.", OS: "android", Online: false }];
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

test("tailnet phones and serve targets", () => {
  const st = {
    Peer: {
      a: { DNSName: "tablet.example.ts.net.", OS: "iOS", Online: false },
      b: { DNSName: "phone.example.ts.net.", OS: "android", Online: true },
      c: { DNSName: "other-host.example.ts.net.", OS: "linux", Online: true },
    },
  };
  assert.deepEqual(
    phones(st).map((p) => p.name),
    ["phone", "tablet"],
  );
  assert.equal(reachesBroker("http://127.0.0.1:8737", 8737), true);
  assert.equal(reachesBroker("http://localhost:8737/", 8737), true);
  assert.equal(reachesBroker("127.0.0.1:8737", 8737), true);
  assert.equal(reachesBroker("http://127.0.0.1:3000", 8737), false);
  assert.equal(reachesBroker("http://100.64.0.3:8737", 8737), false);
});

test("setup flags", () => {
  assert.deepEqual(parseSetupArgs(["--yes", "--only", "service, serve", "--https-port", "10443", "--no-vscode"]), {
    yes: true,
    dryRun: false,
    noSystem: false,
    noVscode: true,
    noServe: false,
    httpsPort: 10443,
    only: ["service", "serve"],
    skip: [],
  });
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
