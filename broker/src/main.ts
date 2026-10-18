import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { readApiKey, writeApiKey } from "./api-key.ts";
import { Audit } from "./audit.ts";
import { setCredentials } from "./auth.ts";
import { watchConfig } from "./config-watch.ts";
import {
  BROKER_SESSIONS,
  CONFIG_KEYS,
  ConfigError,
  applyMigrations,
  brokerSessionsOf,
  checkConfig,
  loadConfig,
  newConfig,
  paths,
  readConfig,
  writeConfig,
} from "./config.ts";
import { DeviceGate } from "./devices.ts";
import { Doctor } from "./doctor.ts";
import { Hub } from "./hub.ts";
import { brokerVersion, installKind } from "./install.ts";
import { Leases } from "./lease.ts";
import { linkSocketPath } from "./link/protocol.ts";
import { LinkServer } from "./link/server.ts";
import { migrateConfigFile } from "./migrate.ts";
import { Push } from "./push/index.ts";
import { PUSH_TEXT } from "./push/text.ts";
import { RemoteActivity } from "./remote-activity.ts";
import { buildServer } from "./server.ts";
import { retagTranscripts } from "./sessions/entrypoint.ts";
import { SessionManager } from "./sessions/manager.ts";
import { SessionSearch } from "./sessions/search.ts";
import { Store } from "./store.ts";
import { Uploads } from "./uploads.ts";
import { UPDATE_CHANNELS, type UpdateChannel } from "./releases.ts";
import { UpdateCheck } from "./update-check.ts";
import { rollback, update, updateStatus, type UpdateOptions } from "./update.ts";

const WARM_DELAY_MS = 5000;

const USAGE = `usage: ccrc <command>
  serve                       run the broker
  passwd                      set the login ID and password
  status                      show configuration and login state
  logout                      end the current remote login
  version                     show the version (also --version)
  config path                 show where config.json is
  config get [key]            show the config, or one key of it
  config set <key> <value>    change a key; a value that is not JSON is taken as a string
  config set-api-key          store the Anthropic API key for brokerSessions "apiKey" (typed hidden, or from stdin)
  migrate [--json]            bring config.json to this version's format (serve does this too)
  update [--check] [--to <version>] [--channel stable|rc] [--yes] [--from <repository>[@<ref>]]
                              install a newer release beside this one and switch to it, or go back on failure
  rollback [--yes]            go back to the version before the last update
  setup [options]             check each part of the setup and do what is missing (setup --help)
  uninstall [--purge]         remove the install, VS Code's setting first (uninstall --help)`;

// With --json, one line for `ccrc update`: the files changed, as "config/<path>", and the message.
function migrate(): void {
  const json = process.argv.slice(3).includes("--json");
  const r = migrateConfigFile();
  const message = !r
    ? `No config yet at ${paths.configFile}; the broker makes one when it starts.`
    : !r.backupDir
      ? `Config is already of format ${r.to}.`
      : `Config moved from format ${r.from} to ${r.to}; the earlier file is in ${r.backupDir}`;
  if (!json) return console.log(message);
  const changed = r?.backupDir ? [`config/${path.relative(paths.configDir, paths.configFile)}`] : [];
  console.log(JSON.stringify({ changed, message }));
}

async function serve(): Promise<void> {
  const migrated = migrateConfigFile();
  if (migrated?.backupDir) console.log(`ccrc: config moved from format ${migrated.from} to ${migrated.to} (earlier file in ${migrated.backupDir})`);
  const config = loadConfig();
  const store = new Store();
  const leases = new Leases(store, config.leaseIdleMinutes);
  const audit = new Audit();
  for (const r of retagTranscripts()) console.log(`ccrc: ${r.file} now lists in VS Code (original in ${r.backup})`);
  const manager = new SessionManager(config, audit);
  manager.pruneArchived();
  const uploads = new Uploads(path.join(paths.stateDir, "uploads"));
  const hub = new Hub(manager, leases, audit, uploads, new RemoteActivity(path.join(paths.stateDir, "remote-activity.json")));
  const push = new Push(paths.configDir);
  push.watch(manager, hub);
  manager.remoteReachable = () => hub.connected || push.reaches(leases.current()?.device);
  manager.remoteWatching = () => hub.connected;
  const doctor = new Doctor({ brokerCli: () => manager.cli.peek() });
  doctor.start();
  const updates = new UpdateCheck({
    config,
    version: () => doctor.brokerVersion(),
    notify: (tag) => push.announce((lang) => ({ title: "ccrc", body: PUSH_TEXT[lang].update(tag), tag: "ccrc-update", data: { url: "/#/settings/status" } })),
  });
  updates.start();
  const links = new LinkServer(linkSocketPath());
  links.on("link", (link) => manager.attachLink(link));
  await links.listen();
  const gate = new DeviceGate(config.allowedDevices, config.allowLocal);
  leases.on("revoked", (reason: string) => audit.log("lease_revoked", { reason }));
  watchConfig(paths.configFile, config, {
    apply: (c, changed) => {
      gate.update(c.allowedDevices, c.allowLocal);
      leases.setIdleMinutes(c.leaseIdleMinutes);
      if (changed.includes("brokerSessions") || changed.includes("roots") || changed.includes("vscodeArchive")) manager.emit("options_changed");
      if (changed.includes("vscodeArchive")) manager.emit("changed");
      updates.configChanged(changed);
    },
    log: (line) => console.log(line),
  });
  // `ccrc config set-api-key` while the broker runs: an open phone learns that broker sessions can start now.
  fs.watchFile(paths.apiKeyFile, { interval: 2000 }, () => manager.emit("options_changed"));

  // `ccrc passwd` and `ccrc logout` edit the credentials file while the broker runs.
  fs.watchFile(paths.credentialsFile, { interval: 2000 }, () => {
    const hadLease = Boolean(store.state.lease);
    store.reload();
    if (hadLease && !store.state.lease) leases.emit("revoked", "logout");
  });

  const search = new SessionSearch();
  const app = await buildServer({ store, leases, gate, audit, manager, hub, uploads, push, doctor, updates, search, webDir: paths.webDir, logLevel: process.env.CCRC_LOG_LEVEL });
  await app.listen({ host: config.host, port: config.port });
  // The first search after a start finds the transcripts already read.
  const warm = async () => search.prewarm(await manager.list());
  setTimeout(() => void warm().catch(() => undefined), WARM_DELAY_MS).unref();

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    hub.close();
    push.close();
    doctor.close();
    updates.close();
    await links.close();
    await manager.closeAll();
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let value = "";
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n") {
          cleanup();
          return resolve(value);
        }
        if (c === "\u0003") {
          cleanup();
          return reject(Error("cancelled"));
        }
        if (c === "\u007f" || c === "\b") value = Array.from(value).slice(0, -1).join("");
        else if (c >= " ") value += c;
      }
    };
    process.stdout.write(prompt);
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function passwd(): Promise<void> {
  if (!process.stdin.isTTY) throw Error("run this command in a terminal");
  const store = new Store();
  const current = store.state.user?.id;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const id = (await rl.question(current ? `ID [${current}]: ` : "ID: ")).trim() || current || "";
  rl.close();
  const password = await askHidden("Password: ");
  if ((await askHidden("Password again: ")) !== password) throw Error("the passwords do not match");
  await setCredentials(store, id, password);
  console.log(`Saved login for ${id}.`);
}

function brokerSessionsText(mode: string): string {
  if (mode !== "apiKey") return mode;
  return readApiKey() ? "apiKey (key set)" : `apiKey (no key; run: ccrc config set-api-key)`;
}

function status(): void {
  const config = loadConfig();
  const { user, lease, lockout } = new Store().state;
  console.log(`version:     ${brokerVersion() ?? "unknown"} (${KIND_TEXT[installKind()]})`);
  console.log(`config:      ${paths.configFile}`);
  console.log(`listen:      http://${config.host}:${config.port}`);
  console.log(`wrappers:    ${linkSocketPath()}${fs.existsSync(linkSocketPath()) ? "" : " (not listening)"}`);
  console.log(`devices:     ${config.allowedDevices.join(", ") || "(none; local access only)"}`);
  console.log(`update:      ${config.updateCheck !== false ? updateStatus(brokerVersion()) : "not looked for (updateCheck is false)"}`);
  console.log(`broker sessions: ${brokerSessionsText(brokerSessionsOf(config))}`);
  console.log(`login:       ${user ? `${user.id} (set ${user.changedAt})` : "not set; run: ccrc passwd"}`);
  console.log(`remote use:  ${lease ? `${lease.device}, last active ${new Date(lease.lastSeen).toLocaleString()}` : "none"}`);
  if (lockout.lockedUntil > Date.now()) console.log(`locked until ${new Date(lockout.lockedUntil).toLocaleString()}`);
}

function logout(): void {
  const store = new Store();
  if (!store.state.lease) return console.log("No remote login.");
  delete store.state.lease;
  store.save();
  console.log("Remote login ended.");
}

const KIND_TEXT = { installed: "installed", git: "development checkout", plain: "unpacked copy" } as const;

function version(): void {
  console.log(`ccrc ${brokerVersion() ?? "unknown"} (${KIND_TEXT[installKind()]})`);
}

// A value as JSON when it reads as JSON, else the text itself.
function configValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function readSecret(prompt: string): Promise<string> {
  if (process.stdin.isTTY) return askHidden(prompt);
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
}

async function config(): Promise<void> {
  const [sub, key, ...rest] = process.argv.slice(3);
  const file = paths.configFile;
  switch (sub) {
    case "path":
      return console.log(file);
    case "get": {
      const c = fs.existsSync(file) ? readConfig(file).config : newConfig();
      if (key === undefined) return console.log(JSON.stringify(c, null, 2));
      if (!CONFIG_KEYS.includes(key)) throw new ConfigError(`unknown key "${key}"`);
      return console.log(JSON.stringify(c[key as keyof typeof c] ?? null));
    }
    case "set": {
      if (!key || rest.length !== 1) throw Error("usage: ccrc config set <key> <value>");
      if (!CONFIG_KEYS.includes(key) || key === "schemaVersion") throw new ConfigError(`unknown key "${key}"; keys: ${CONFIG_KEYS.filter((k) => k !== "schemaVersion").join(", ")}`);
      migrateConfigFile();
      const raw = fs.existsSync(file) ? readConfig(file).raw : (newConfig() as unknown as Record<string, unknown>);
      const next = { ...raw, [key]: configValue(rest[0]) };
      // Checked as the broker will read it, so a value of the wrong type is never written.
      checkConfig(applyMigrations(next, file).config, file);
      writeConfig(next, file);
      console.log(`${key} = ${JSON.stringify(next[key])}`);
      if (key === "brokerSessions" && next[key] === "apiKey" && !readApiKey()) console.log("No API key is stored yet: run ccrc config set-api-key");
      return;
    }
    case "set-api-key": {
      writeApiKey(await readSecret("Anthropic API key: "));
      console.log(`Saved the API key to ${paths.apiKeyFile}.`);
      const c = fs.existsSync(file) ? readConfig(file).config : undefined;
      if (c && brokerSessionsOf(c) !== "apiKey") console.log("Broker sessions use it once brokerSessions is apiKey: ccrc config set brokerSessions apiKey");
      return;
    }
    default:
      throw Error(`usage: ccrc config path | get [key] | set <key> <value> | set-api-key\n  brokerSessions takes ${BROKER_SESSIONS.join(", ")}`);
  }
}

async function ask(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) throw Error("no terminal to ask in: pass --yes");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === "y" || answer === "yes";
}

function updateArgs(args: string[]): UpdateOptions {
  const o: UpdateOptions = {};
  const value = (flag: string, i: number) => {
    if (args[i + 1] === undefined) throw Error(`${flag} needs a value`);
    return args[i + 1];
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--check") o.check = true;
    else if (a === "--yes" || a === "-y") o.yes = true;
    else if (a === "--to") o.to = value(a, i++);
    else if (a === "--from") o.from = value(a, i++);
    else if (a === "--channel") {
      const c = value(a, i++);
      if (!UPDATE_CHANNELS.includes(c as UpdateChannel)) throw Error(`--channel takes ${UPDATE_CHANNELS.join(" or ")}`);
      o.channel = c as UpdateChannel;
    } else throw Error(`unknown option ${a}\n${USAGE}`);
  }
  return o;
}

async function updateCommand(): Promise<void> {
  process.exitCode = await update(updateArgs(process.argv.slice(3)), { ask });
}

async function rollbackCommand(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.some((a) => a !== "--yes" && a !== "-y")) throw Error("usage: ccrc rollback [--yes]");
  process.exitCode = await rollback({ yes: args.length > 0 }, { ask });
}

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`ccrc needs Node.js 22.18 or newer (found ${process.versions.node})`);
  process.exit(1);
}

const command = process.argv[2] ?? "serve";
const commands: Record<string, () => unknown> = { serve, passwd, status, logout, version, "--version": version, config, migrate, update: updateCommand, rollback: rollbackCommand };
commands.setup = async () => (await import("./setup/cli.ts")).setup(process.argv.slice(3));
commands.uninstall = async () => (await import("./setup/cli.ts")).uninstall(process.argv.slice(3));
const run = commands[command];
if (!run) {
  console.error(USAGE);
  process.exit(2);
}
try {
  await run();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
