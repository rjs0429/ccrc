import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { Audit } from "./audit.ts";
import { setCredentials } from "./auth.ts";
import { loadConfig, paths } from "./config.ts";
import { DeviceGate } from "./devices.ts";
import { Doctor } from "./doctor.ts";
import { Hub } from "./hub.ts";
import { Leases } from "./lease.ts";
import { linkSocketPath } from "./link/protocol.ts";
import { LinkServer } from "./link/server.ts";
import { Push } from "./push/index.ts";
import { RemoteActivity } from "./remote-activity.ts";
import { buildServer } from "./server.ts";
import { retagTranscripts } from "./sessions/entrypoint.ts";
import { SessionManager } from "./sessions/manager.ts";
import { SessionSearch } from "./sessions/search.ts";
import { Store } from "./store.ts";
import { Uploads } from "./uploads.ts";

const WARM_DELAY_MS = 5000;

const USAGE = `usage: ccrc <command>
  serve    run the broker
  passwd   set the login ID and password
  status   show configuration and login state
  logout   end the current remote login`;

async function serve(): Promise<void> {
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
  const doctor = new Doctor();
  doctor.start();
  const links = new LinkServer(linkSocketPath());
  links.on("link", (link) => manager.attachLink(link));
  await links.listen();
  const gate = new DeviceGate(config.allowedDevices, config.allowLocal);
  leases.on("revoked", (reason: string) => audit.log("lease_revoked", { reason }));

  // `ccrc passwd` and `ccrc logout` edit the credentials file while the broker runs.
  fs.watchFile(paths.credentialsFile, { interval: 2000 }, () => {
    const hadLease = Boolean(store.state.lease);
    store.reload();
    if (hadLease && !store.state.lease) leases.emit("revoked", "logout");
  });

  const search = new SessionSearch();
  const app = await buildServer({ store, leases, gate, audit, manager, hub, uploads, push, doctor, search, webDir: paths.webDir, logLevel: process.env.CCRC_LOG_LEVEL });
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

function status(): void {
  const config = loadConfig();
  const { user, lease, lockout } = new Store().state;
  console.log(`config:      ${paths.configFile}`);
  console.log(`listen:      http://${config.host}:${config.port}`);
  console.log(`wrappers:    ${linkSocketPath()}${fs.existsSync(linkSocketPath()) ? "" : " (not listening)"}`);
  console.log(`devices:     ${config.allowedDevices.join(", ") || "(none; local access only)"}`);
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

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`ccrc needs Node.js 22.18 or newer (found ${process.versions.node})`);
  process.exit(1);
}

const command = process.argv[2] ?? "serve";
const commands: Record<string, () => unknown> = { serve, passwd, status, logout };
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
