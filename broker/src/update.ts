import fs from "node:fs";
import path from "node:path";
import { newConfig, readConfig, writeFileAtomic, type Config } from "./config.ts";
import { installKind, readInstallInfo, versionsDir, writeInstallInfo, type InstallInfo } from "./install.ts";
import { paths } from "./paths.ts";
import { changelogSections, isNewer, latestTag, listTags, quietGitEnv, releaseUrl, updateSource, type UpdateChannel } from "./releases.ts";
import { run, type Runner } from "./run.ts";
import { inBrokerService, inServiceRefusal } from "./service-cgroup.ts";
import { whichOn } from "./setup/io.ts";
import { NEEDED_SSH_KEYGEN, gitSshKeygenProblem, sshKeygenFix } from "./ssh-keygen.ts";
import { readUpdateCheck, updateCheckFile, writeUpdateCheck } from "./update-check.ts";

// `ccrc update` and `ccrc rollback` on an install: <dataDir>/versions/<version>/ folders and the <dataDir>/current link.
// A new version is fetched and built beside the running one, config and state are backed up and migrated by the new
// version's own code, then the link moves and the service restarts; when the service does not come back as the new
// version within PING_WAIT_MS, the link and the backup go back.

export const SIGNERS_FILE = ".ccrc-allowed-signers";
// git picks the verifier from the kind of signature, not from gpg.format: with the OpenPGP and X.509 programs `false`,
// only an SSH signature passes, and the ssh-keygen on PATH (the one setup checks) and the signers file alone decide it,
// whatever gpg.ssh.program or gpg.minTrustLevel the user's git config sets.
const SSH_ONLY_VERIFY = [
  "gpg.format=ssh",
  "gpg.program=false",
  "gpg.openpgp.program=false",
  "gpg.x509.program=false",
  "gpg.ssh.program=ssh-keygen",
  "gpg.minTrustLevel=undefined",
].flatMap((setting) => ["-c", setting]);
export const HISTORY_FILE = "history.json";
const SERVICE = "ccrc.service";
const PING_WAIT_MS = 30_000;
const PING_EVERY_MS = 1000;
const STEP_TIMEOUT_MS = 15 * 60_000;
// Update and rollback backups kept besides those of the last few history entries; they hold copies of the API key,
// the password hash and the push keys, so old ones go.
const KEEP_BACKUPS = 3;

// Exit codes beyond 0 (done, or nothing to do) and 1 (stopped before anything switched).
export const EXIT_ROLLED_BACK = 3;
export const EXIT_BROKEN = 4;

export interface HistoryEntry {
  from?: string;
  to: string;
  backupDir?: string;
  at: string;
  rollback?: boolean;
  // Why the switch was undone at once.
  failed?: string;
}

export interface UpdateDeps {
  dataDir: string;
  configDir: string;
  stateDir: string;
  // The ccrc running this command.
  codeRoot: string;
  // The Node new versions run their migrate step with and record in their install info.
  node: string;
  env: NodeJS.ProcessEnv;
  runner: Runner;
  // The version the broker on this machine answers on /api/ping, if it answers.
  ping: (host: string, port: number) => Promise<string | undefined>;
  ask: (question: string) => Promise<boolean>;
  log: (line: string) => void;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  pingWaitMs: number;
  pingEveryMs: number;
  // Whether this runs inside ccrc.service, which a restart would stop.
  inService: () => boolean;
}

export interface UpdateOptions {
  check?: boolean;
  to?: string;
  channel?: UpdateChannel;
  yes?: boolean;
  // A local repository and a ref in it ("<path>[@<ref>]"), installed as `git describe` names it.
  from?: string;
}

async function pingOnce(host: string, port: number): Promise<string | undefined> {
  try {
    const r = await fetch(`http://${host.includes(":") ? `[${host}]` : host}:${port}/api/ping`, { signal: AbortSignal.timeout(2000) });
    const v = (await r.json()) as { version?: unknown };
    return typeof v.version === "string" ? v.version : undefined;
  } catch {
    return undefined;
  }
}

export function defaultDeps(): UpdateDeps {
  return {
    dataDir: paths.dataDir,
    configDir: paths.configDir,
    stateDir: paths.stateDir,
    codeRoot: paths.codeRoot,
    node: process.env.CCRC_NODE || process.execPath,
    env: process.env,
    runner: run,
    ping: pingOnce,
    ask: async () => false,
    log: (line) => console.log(line),
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    pingWaitMs: PING_WAIT_MS,
    pingEveryMs: PING_EVERY_MS,
    inService: () => inBrokerService(),
  };
}

class UpdateError extends Error {}
// A copy that is not the signed release it is named for, unlike a machine that cannot check it.
class BadTag extends UpdateError {}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const lastLine = (text: string) => [...new Set(text.trim().split("\n").filter(Boolean))].slice(-3).join(" / ").slice(0, 500);

class Updater {
  private d: UpdateDeps;

  constructor(d: UpdateDeps) {
    this.d = d;
  }

  get currentLink(): string {
    return path.join(this.d.dataDir, "current");
  }

  dirOf(version: string): string {
    return path.join(versionsDir(this.d.dataDir), version);
  }

  // The version `current` points at, with its folder name and install info.
  current(): { version: string; name: string; dir: string; info?: InstallInfo } | undefined {
    let target: string;
    try {
      target = fs.readlinkSync(this.currentLink);
    } catch {
      return undefined;
    }
    const dir = path.resolve(this.d.dataDir, target);
    const info = readInstallInfo(dir);
    return { version: info?.version ?? path.basename(dir), name: path.basename(dir), dir, ...(info ? { info } : {}) };
  }

  // The folder under versions/ that holds `version`: versions/<version>, else one whose install info names it (an
  // install made by another tool may name its folder otherwise).
  nameOf(version: string): string {
    if (readInstallInfo(this.dirOf(version))) return version;
    return safeList(versionsDir(this.d.dataDir)).find((n) => !n.endsWith(".tmp") && readInstallInfo(this.dirOf(n))?.version === version) ?? version;
  }

  config(): Config {
    const file = path.join(this.d.configDir, "config.json");
    return fs.existsSync(file) ? readConfig(file).config : newConfig();
  }

  pingHost(c: Config): string {
    return c.host === "0.0.0.0" || c.host === "::" ? "127.0.0.1" : c.host;
  }

  async git(args: string[], cwd?: string): Promise<string> {
    const r = await this.d.runner("git", args, { cwd, env: quietGitEnv(this.d.env), timeoutMs: STEP_TIMEOUT_MS });
    if (r.code !== 0) throw new UpdateError(`git ${args[0] === "-C" ? args[2] : args[0]} failed: ${lastLine(r.stderr) || `exit code ${r.code}`}`);
    return r.stdout.trim();
  }

  historyFile(): string {
    return path.join(this.d.dataDir, HISTORY_FILE);
  }

  history(): HistoryEntry[] {
    try {
      const v: unknown = JSON.parse(fs.readFileSync(this.historyFile(), "utf8"));
      return Array.isArray(v) ? (v as HistoryEntry[]) : [];
    } catch {
      return [];
    }
  }

  record(entry: HistoryEntry): void {
    this.writeHistory([...this.history(), entry]);
  }

  writeHistory(entries: HistoryEntry[]): void {
    writeFileAtomic(this.historyFile(), JSON.stringify(entries.slice(-50), null, 2) + "\n");
  }

  // History is what `ccrc rollback` goes by; failing to write it does not undo a switch already made.
  tryRecord(write: () => void): void {
    try {
      write();
    } catch (e) {
      this.d.log(`Could not write ${this.historyFile()}: ${message(e)}`);
    }
  }

  lock(): () => void {
    fs.mkdirSync(this.d.dataDir, { recursive: true });
    const file = path.join(this.d.dataDir, "update.lock");
    for (let i = 0; i < 2; i++) {
      try {
        fs.writeFileSync(file, String(process.pid), { flag: "wx" });
        return () => fs.rmSync(file, { force: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const pid = Number(fs.readFileSync(file, "utf8"));
        if (pid && pid !== process.pid && alive(pid)) throw new UpdateError(`another ccrc update is running (process ${pid})`);
        fs.rmSync(file, { force: true });
      }
    }
    throw new UpdateError(`cannot take ${file}`);
  }

  // Copies the config folder and the state folder's top-level JSON files to a new backup folder.
  backup(name: string): string {
    const dir = path.join(this.d.stateDir, "backup", `${name}-${stamp(this.d.now())}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    copyTree(this.d.configDir, path.join(dir, "config"), () => true);
    copyTree(this.d.stateDir, path.join(dir, "state"), (rel, isDir) => !isDir && !rel.includes("/") && rel.endsWith(".json"));
    return dir;
  }

  // Files the migrate step changed or made since the backup, as "config/<path>" and "state/<path>".
  changedSince(backupDir: string): string[] {
    const changed: string[] = [];
    for (const [part, live, keep] of this.parts()) {
      for (const rel of listFiles(live, keep)) {
        const saved = path.join(backupDir, part, rel);
        if (!fs.existsSync(saved) || !fs.readFileSync(saved).equals(fs.readFileSync(path.join(live, rel)))) changed.push(`${part}/${rel}`);
      }
    }
    return changed;
  }

  parts(): [string, string, (rel: string, isDir: boolean) => boolean][] {
    return [
      ["config", this.d.configDir, () => true],
      ["state", this.d.stateDir, (rel, isDir) => !isDir && !rel.includes("/") && rel.endsWith(".json")],
    ];
  }

  // Puts the backup back as it was: its files, and files made since then removed.
  restoreAll(backupDir: string): string[] {
    const saved = this.parts().flatMap(([part]) => listFiles(path.join(backupDir, part), () => true).map((rel) => `${part}/${rel}`));
    return this.restore(backupDir, [...new Set([...saved, ...this.changedSince(backupDir)])]);
  }

  // Puts the backed-up files back. `only` limits it to those files, and removes the ones of them the backup lacks.
  restore(backupDir: string, only?: string[]): string[] {
    const restored: string[] = [];
    for (const [part, live] of this.parts()) {
      const saved = path.join(backupDir, part);
      const files = only ? only.filter((f) => f.startsWith(`${part}/`)).map((f) => f.slice(part.length + 1)) : listFiles(saved, () => true);
      for (const rel of files) {
        const from = path.join(saved, rel);
        const to = path.join(live, rel);
        if (fs.existsSync(from)) {
          fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
          fs.copyFileSync(from, to);
        } else fs.rmSync(to, { force: true });
        restored.push(`${part}/${rel}`);
      }
    }
    return restored;
  }

  // Whether the user service exists, and whether it runs <dataDir>/current/bin/ccrc.
  async service(): Promise<{ state: "none" } | { state: "current" | "other"; exec: string }> {
    const r = await this.d.runner("systemctl", ["--user", "show", "-p", "LoadState", "-p", "ExecStart", SERVICE], { env: this.d.env, timeoutMs: 10_000 });
    if (r.code !== 0 || !/^LoadState=loaded$/m.test(r.stdout)) return { state: "none" };
    const exec = /^ExecStart=.*?\bpath=(\S+)/m.exec(r.stdout)?.[1] ?? "";
    return { state: runsCurrent(exec, this.d.dataDir) ? "current" : "other", exec };
  }

  async restart(): Promise<void> {
    const r = await this.d.runner("systemctl", ["--user", "restart", SERVICE], { env: this.d.env, timeoutMs: 60_000 });
    if (r.code !== 0) throw new UpdateError(`systemctl --user restart ${SERVICE} failed: ${lastLine(r.stderr) || `exit code ${r.code}`}`);
  }

  // Waits for the broker to answer /api/ping with `version`; the last answer when it does not.
  async waitFor(version: string, c: Config): Promise<{ ok: boolean; seen?: string }> {
    const until = Date.now() + this.d.pingWaitMs;
    let seen: string | undefined;
    for (;;) {
      seen = await this.d.ping(this.pingHost(c), c.port);
      if (seen === version) return { ok: true, seen };
      if (Date.now() >= until) return { ok: false, seen };
      await this.d.sleep(this.d.pingEveryMs);
    }
  }

  link(version: string | undefined): void {
    if (!version) return void fs.rmSync(this.currentLink, { force: true });
    const tmp = `${this.currentLink}.${process.pid}.tmp`;
    fs.rmSync(tmp, { force: true });
    fs.symlinkSync(path.join("versions", version), tmp);
    fs.renameSync(tmp, this.currentLink);
  }

  async build(dir: string): Promise<void> {
    const env = { ...this.d.env, PATH: `${path.dirname(this.d.node)}${path.delimiter}${this.d.env.PATH ?? ""}` };
    for (const args of [["ci", "--no-audit", "--no-fund"], ["run", "build"]]) {
      this.d.log(`  npm ${args.join(" ")}`);
      const r = await this.d.runner("npm", args, { cwd: dir, env, timeoutMs: STEP_TIMEOUT_MS });
      if (r.code !== 0) throw new UpdateError(`npm ${args[0] === "ci" ? "ci" : "run build"} failed: ${lastLine(r.stderr || r.stdout) || `exit code ${r.code}`}`);
    }
  }

  // Builds a fetched copy in <version>.tmp, writes its install info and moves it to versions/<version>. A copy of local
  // work (--from) keeps looking for releases where the version before it did.
  async finish(tmp: string, version: string, source: string, local = false): Promise<string> {
    await this.build(tmp);
    const commit = await this.git(["-C", tmp, "rev-parse", "HEAD"]);
    const before = this.current()?.info;
    const node = before?.node ?? this.d.node;
    const releases = local && before ? before.updateSource || before.source : undefined;
    writeInstallInfo(tmp, { version, commit, source, ...(releases ? { updateSource: releases } : {}), node, installedAt: this.d.now().toISOString() });
    const dir = this.dirOf(version);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
    return dir;
  }

  // dir holds the release `tag` when the tag carries an SSH signature from a key in the signers file, was made under
  // that name, and names the commit checked out.
  async verifyTag(dir: string, tag: string, signers: string): Promise<void> {
    const r = await this.d.runner("git", ["-C", dir, ...SSH_ONLY_VERIFY, "-c", `gpg.ssh.allowedSignersFile=${signers}`, "verify-tag", `refs/tags/${tag}`], {
      env: quietGitEnv(this.d.env),
      timeoutMs: 60_000,
    });
    if (r.code === 0) return this.taggedCheckout(dir, tag);
    const why = lastLine(r.stderr) || `exit code ${r.code}`;
    // git runs ssh-keygen only for an SSH signature: a tag with none, or not a tag, fails the same without it.
    const problem = gitSshKeygenProblem(r.stderr);
    if (problem) {
      const dirs = this.d.env.PATH ?? "";
      const fix = sshKeygenFix(problem, (cmd) => whichOn(cmd, dirs));
      throw new UpdateError(
        problem === "missing"
          ? `could not check the signature of ${tag}: git checks it with ssh-keygen, which it could not run (${why}). Run ccrc update again once it is installed; ${fix}`
          : `could not check the signature of ${tag}: git needs ${NEEDED_SSH_KEYGEN} to check it (${why}). Run ccrc update again on a newer one; ${fix}`,
      );
    }
    throw new BadTag(`the signature of ${tag} does not check out against ${signers}: ${why}`);
  }

  // verify-tag passes a signed tag of another release under any name, and does not look at what is checked out.
  async taggedCheckout(dir: string, tag: string): Promise<void> {
    const [named, commit] = (await this.git(["-C", dir, "for-each-ref", "--format=%(tag) %(*objectname)", `refs/tags/${tag}`])).split(" ");
    if (named !== tag) throw new BadTag(`the tag ${tag} is the signed tag of ${named || "no release"}, not of ${tag}`);
    const head = await this.git(["-C", dir, "rev-parse", "HEAD"]);
    if (head !== commit) throw new BadTag(`${path.relative(this.d.dataDir, dir)} is at ${head.slice(0, 12)}, not at ${commit.slice(0, 12)}, the commit ${tag} names`);
  }

  // Backs up, migrates with the new version's code, moves the link and restarts. Returns the exit code.
  async switchTo(from: string | undefined, to: string): Promise<number> {
    const c = this.config();
    const svc = await this.service();
    const fromName = from ? this.nameOf(from) : undefined;
    const fromAnswered = svc.state === "current" && from ? (await this.d.ping(this.pingHost(c), c.port)) === from : false;
    const backupDir = this.backup(`update-${from ?? "none"}-${to}`);
    this.d.log(`Config and state backed up to ${backupDir}`);
    const release = holdSignals(this.d.log);
    try {
      try {
        const migrate = await this.d.runner(path.join(this.dirOf(to), "bin", "ccrc"), ["migrate", "--json"], {
          env: { ...this.d.env, CCRC_NODE: this.d.node, CCRC_CONFIG_DIR: this.d.configDir, CCRC_STATE_DIR: this.d.stateDir, CCRC_DATA_DIR: this.d.dataDir },
          timeoutMs: 60_000,
        });
        if (migrate.code !== 0) throw new UpdateError(`${to} could not migrate the config: ${lastLine(migrate.stderr || migrate.stdout) || `exit code ${migrate.code}`}`);
        const reported = migrateReport(migrate.stdout);
        if (reported?.message) this.d.log(`  ${reported.message}`);
        else if (!reported && migrate.stdout.trim()) this.d.log(`  ${migrate.stdout.trim().split("\n").join("\n  ")}`);
        // What rollback puts back. The running broker keeps writing state meanwhile, so the files the migrate step
        // names are taken over what changed since the backup.
        const migrated = reported?.changed ?? this.changedSince(backupDir);
        fs.writeFileSync(path.join(backupDir, "manifest.json"), JSON.stringify({ from, to, migrated }, null, 2) + "\n");
        this.link(to);
      } catch (e) {
        this.restoreAll(backupDir);
        throw new UpdateError(`${message(e)}. Nothing was switched; config and state are as they were.`);
      }
      this.d.log(`current -> versions/${to}`);
      // Recorded before the restart, so `ccrc rollback` still knows the way back if this run dies from here on.
      const entry: HistoryEntry = { ...(from ? { from } : {}), to, backupDir, at: this.d.now().toISOString() };
      this.tryRecord(() => this.record(entry));
      if (svc.state === "current") {
        this.d.log(`Restarting ${SERVICE}...`);
        let failed: string | undefined;
        try {
          await this.restart();
          const r = await this.waitFor(to, c);
          if (!r.ok) failed = r.seen ? `the broker still answers as ${r.seen}` : `the broker did not answer on port ${c.port} within ${Math.round(this.d.pingWaitMs / 1000)} s`;
        } catch (e) {
          failed = message(e);
        }
        if (failed) return await this.undo(from, fromName, to, backupDir, failed, fromAnswered, c);
      } else if (svc.state === "other") {
        this.d.log(`${SERVICE} runs ${svc.exec}, not ${path.join(this.d.dataDir, "current", "bin", "ccrc")}, so it was not restarted.`);
        this.d.log(`Point the service at the install to run ${to}: ccrc setup --only service`);
      } else {
        this.d.log(`No ${SERVICE}: start \`${path.join(this.d.dataDir, "current", "bin", "ccrc")} serve\` again to run ${to}.`);
      }
      try {
        this.prune([to, ...(fromName ? [fromName] : [])]);
        this.pruneBackups();
      } catch (e) {
        this.d.log(`Could not remove old versions: ${message(e)}`);
      }
      this.afterwards(fromName, to);
      return 0;
    } finally {
      release();
    }
  }

  async undo(from: string | undefined, fromName: string | undefined, to: string, backupDir: string, failed: string, fromAnswered: boolean, c: Config): Promise<number> {
    this.d.log(`Update to ${to} failed: ${failed}`);
    this.d.log(`Going back to ${from ?? "no install"}...`);
    let putBack = true;
    try {
      this.link(fromName);
      this.restoreAll(backupDir);
    } catch (e) {
      this.d.log(`Could not put ${from ?? "the previous setup"} back: ${message(e)}`);
      putBack = false;
    }
    this.tryRecord(() => {
      const h = this.history();
      const i = h.findLastIndex((e) => e.backupDir === backupDir && e.to === to);
      if (i >= 0) h[i] = { ...h[i], failed };
      else h.push({ ...(from ? { from } : {}), to, backupDir, at: this.d.now().toISOString(), failed });
      this.writeHistory(h);
    });
    // Whether the old version answers again; when it did not answer before the update either, nothing says it should.
    let back = !fromAnswered;
    try {
      await this.restart();
      if (fromAnswered && from) back = (await this.waitFor(from, c)).ok;
    } catch (e) {
      this.d.log(message(e));
      back = false;
    }
    if (!putBack || !back) {
      this.d.log(`The broker does not answer as ${from} either. Check: systemctl --user status ${SERVICE}; journalctl --user -u ${SERVICE}`);
      this.d.log(`Config and state as they were before the update are in ${backupDir}`);
      return EXIT_BROKEN;
    }
    this.d.log(`Back on ${from ?? "the previous setup"}; config and state restored from ${backupDir}.`);
    return EXIT_ROLLED_BACK;
  }

  // Keeps the versions named and the one current points at; removes other versions and left-over downloads, but not
  // one install.sh is still building (versions/.tmp-<its pid>).
  prune(keep: string[]): void {
    const dir = versionsDir(this.d.dataDir);
    const cur = this.current()?.dir;
    for (const name of safeList(dir)) {
      const full = path.join(dir, name);
      const installing = /^\.tmp-(\d+)$/.exec(name);
      if (keep.includes(name) || full === cur || (installing && alive(Number(installing[1])))) continue;
      fs.rmSync(full, { recursive: true, force: true });
      this.d.log(`Removed ${name.endsWith(".tmp") ? "the unfinished download" : "old version"} ${name}`);
    }
  }

  // Removes update and rollback backups but the newest few and those of the last few history entries.
  pruneBackups(): void {
    const dir = path.join(this.d.stateDir, "backup");
    const keep = new Set(
      this.history()
        .slice(-KEEP_BACKUPS)
        .flatMap((h) => (h.backupDir ? [path.resolve(h.backupDir)] : [])),
    );
    const ours = safeList(dir)
      .filter((n) => /^(update|rollback)-.+-\d{8}T\d{6}Z$/.test(n))
      .sort((a, b) => a.slice(-16).localeCompare(b.slice(-16)));
    for (const name of ours.slice(0, -KEEP_BACKUPS)) {
      const full = path.join(dir, name);
      if (!keep.has(path.resolve(full))) fs.rmSync(full, { recursive: true, force: true });
    }
  }

  // fromName and to are folder names under versions/.
  afterwards(fromName: string | undefined, to: string): void {
    this.d.log(`ccrc is now ${readInstallInfo(this.dirOf(to))?.version ?? to}.`);
    const wrapper = fromName && wrapperChange(this.dirOf(fromName), this.dirOf(to));
    if (wrapper) this.d.log(`- ${wrapper}: reload VS Code windows (Developer: Reload Window) so Claude tabs use the new wrapper.`);
    this.d.log("- On the phone, close the home screen app fully and open it again.");
  }
}

// Keeps Ctrl-C and a terminal closing from stopping ccrc between moving the link and confirming or undoing it.
function holdSignals(log: (line: string) => void): () => void {
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  let told = false;
  const hold = (signal: string) => {
    if (!told) log(`(${signal}: finishing the switch first, or undoing it; this takes up to a minute)`);
    told = true;
  };
  for (const s of signals) process.on(s, hold);
  return () => {
    for (const s of signals) process.off(s, hold);
  };
}

// What `ccrc migrate --json` reports: the files it changed ("config/<path>", "state/<path>") and a line to show.
function migrateReport(stdout: string): { changed: string[]; message?: string } | undefined {
  try {
    const v = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as { changed?: unknown; message?: unknown };
    if (!Array.isArray(v.changed) || !v.changed.every((f) => typeof f === "string")) return undefined;
    return { changed: v.changed as string[], ...(typeof v.message === "string" && v.message ? { message: v.message } : {}) };
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function safeList(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

// Regular files under dir, relative to it, that `keep` lets in.
function listFiles(dir: string, keep: (rel: string, isDir: boolean) => boolean, prefix = ""): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(dir, prefix), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (keep(rel, true)) out.push(...listFiles(dir, keep, rel));
    } else if (e.isFile() && keep(rel, false)) out.push(rel);
  }
  return out;
}

function copyTree(from: string, to: string, keep: (rel: string, isDir: boolean) => boolean): void {
  for (const rel of listFiles(from, keep)) {
    fs.mkdirSync(path.dirname(path.join(to, rel)), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(from, rel), path.join(to, rel));
  }
}

// Whether a service's program is <dataDir>/current/bin/ccrc, itself or through links such as ~/.local/bin/ccrc.
export function runsCurrent(exec: string, dataDir: string): boolean {
  if (!exec) return false;
  const targets = new Set([path.join(dataDir, "current", "bin", "ccrc")]);
  try {
    targets.add(path.join(fs.realpathSync(dataDir), "current", "bin", "ccrc"));
  } catch {}
  let p = path.resolve(exec);
  for (let hop = 0; hop < 8; hop++) {
    if (targets.has(p)) return true;
    let next: string;
    try {
      next = fs.readlinkSync(p);
    } catch {
      return false;
    }
    p = path.resolve(path.dirname(p), next);
  }
  return false;
}

export function linkVersion(dir: string): number | undefined {
  try {
    const m = /export const LINK_VERSION = (\d+)/.exec(fs.readFileSync(path.join(dir, "broker", "src", "link", "protocol.ts"), "utf8"));
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

// The features a version's wrapper names in its hello (CAPS in its relay.ts).
export function wrapperCaps(dir: string): string[] | undefined {
  try {
    const m = /\bconst CAPS = \[([^\]]*)\]/.exec(fs.readFileSync(path.join(dir, "broker", "src", "wrapper", "relay.ts"), "utf8"));
    return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((c) => c[1]) : undefined;
  } catch {
    return undefined;
  }
}

// Why Claude tabs VS Code opened before a switch between two versions' folders should be opened again, if they should:
// each keeps the wrapper it started with.
export function wrapperChange(from: string, to: string): string | undefined {
  if (linkVersion(from) !== linkVersion(to)) return "The wrapper protocol changed";
  const before = wrapperCaps(from);
  const after = wrapperCaps(to);
  if (!before || !after) return before === after ? undefined : "The VS Code wrapper changed";
  const added = after.filter((c) => !before.includes(c));
  return added.length ? `The VS Code wrapper has new features (${added.join(", ")})` : undefined;
}

// "<path>[@<ref>]": the whole text when it names a folder, else split at the last "@".
export function parseFrom(text: string): { repo: string; ref: string } {
  if (fs.existsSync(text) || !text.includes("@")) return { repo: path.resolve(text), ref: "HEAD" };
  const at = text.lastIndexOf("@");
  return { repo: path.resolve(text.slice(0, at)), ref: text.slice(at + 1) || "HEAD" };
}

function tagName(text: string): string {
  return /^\d/.test(text) ? `v${text}` : text;
}

function showChangelog(log: (line: string) => void, dir: string, from: string | undefined, to: string): void {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8");
  } catch {
    return log("(no CHANGELOG.md in this version)");
  }
  const sections = changelogSections(text, to, from);
  if (!sections.length) return log(`(CHANGELOG.md has no section for ${to})`);
  for (const s of sections) {
    log(`\n## ${s.version}`);
    if (s.text) log(s.text);
  }
  const breaking = sections.flatMap((s) => s.breaking.map((line) => `${s.version}: ${line}`));
  if (breaking.length) {
    log("\nBreaking changes:");
    for (const line of breaking) log(`  ${line}`);
  }
  log("");
}

async function confirm(d: UpdateDeps, yes: boolean | undefined, question: string): Promise<boolean> {
  if (yes) return true;
  return d.ask(question);
}

async function updateFrom(u: Updater, d: UpdateDeps, o: UpdateOptions): Promise<number> {
  const { repo, ref } = parseFrom(o.from!);
  const sha = await u.git(["-C", repo, "rev-parse", "--verify", `${ref}^{commit}`]);
  const version = await u.git(["-C", repo, "describe", "--always", "--match", "v[0-9]*", sha]);
  const current = u.current();
  if (current?.version === version) {
    d.log(`ccrc is already ${version}.`);
    return 0;
  }
  if (!(await confirm(d, o.yes, `Switch ccrc from ${current?.version ?? "no install"} to ${version} (${repo} ${ref})?`))) return 0;
  if (readInstallInfo(u.dirOf(version))?.commit === sha) d.log(`Using the copy already in versions/${version}.`);
  else {
    const tmp = `${u.dirOf(version)}.tmp`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(versionsDir(d.dataDir), { recursive: true });
    d.log(`Copying ${repo} at ${sha.slice(0, 12)}...`);
    try {
      await u.git(["clone", "--quiet", "--no-checkout", repo, tmp]);
      await u.git(["-C", tmp, "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", sha]);
      await u.finish(tmp, version, repo, true);
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
  }
  return u.switchTo(current?.version, version);
}

export async function update(o: UpdateOptions, deps: Partial<UpdateDeps> = {}): Promise<number> {
  const d = { ...defaultDeps(), ...deps };
  const u = new Updater(d);
  try {
    if (!o.check && d.inService()) throw new UpdateError(inServiceRefusal("update"));
    const kind = installKind(d.codeRoot, d.dataDir);
    if (o.from) {
      const unlock = u.lock();
      try {
        return await updateFrom(u, d, o);
      } finally {
        unlock();
      }
    }
    const config = u.config();
    const current = u.current();
    const channel = o.channel ?? config.updateChannel ?? "stable";
    if (kind !== "installed" && !o.check) {
      d.log(`This ccrc is a ${kind === "git" ? "development checkout" : "copy that was not installed"} (${d.codeRoot}); \`ccrc update\` updates installs only.`);
      if (current) d.log(`To update the install, run: ${path.join(d.dataDir, "current", "bin", "ccrc")} update`);
      else d.log("Update a checkout with git pull, npm ci and npm run build, or install a release with install.sh.");
      d.log("To install this checkout's commit as a version: ccrc update --from <repository path>[@<ref>]");
      return 1;
    }
    const version = kind === "installed" ? current?.version ?? readInstallInfo(d.codeRoot)?.version : undefined;
    const source = updateSource(current?.info ?? readInstallInfo(d.codeRoot), config.updateRepo);
    const tags = await listTags(d.runner, source, d.env);
    let target: string | undefined;
    if (o.to) {
      target = tagName(o.to);
      if (!tags.includes(target)) throw new UpdateError(`${source} has no tag ${target}`);
    } else target = latestTag(tags, channel);

    if (o.check) {
      const latest = latestTag(tags, channel);
      const shown = version ?? `${kind === "git" ? "development checkout" : "not installed"}`;
      d.log(`ccrc:   ${shown}`);
      d.log(`latest: ${latest ?? "(no release)"} on ${channel} from ${source}`);
      if (latest && isNewer(latest, version)) {
        const url = releaseUrl(source, latest);
        d.log(`${latest} is available: ccrc update${url ? `\n  ${url}` : ""}`);
      } else if (latest) d.log("Up to date.");
      if (!o.to) {
        const before = readUpdateCheck(updateCheckFile(d.stateDir));
        writeUpdateCheck(
          { checkedAt: d.now().toISOString(), source, channel, ...(latest ? { latest } : {}), ...(before.notified ? { notified: before.notified } : {}) },
          updateCheckFile(d.stateDir),
        );
      }
      return 0;
    }
    if (!target) {
      d.log(`No ${channel} release found at ${source}.`);
      return 0;
    }
    if (target === version) {
      d.log(`ccrc is already ${target}.`);
      return 0;
    }
    if (!o.to && !isNewer(target, version)) {
      d.log(`ccrc ${version} is up to date (latest on ${channel}: ${target}).`);
      return 0;
    }

    const unlock = u.lock();
    try {
      const dir = u.dirOf(target);
      const tmp = `${dir}.tmp`;
      const signers = path.join(current?.dir ?? d.codeRoot, SIGNERS_FILE);
      const check = fs.existsSync(signers);
      // A copy of that tag left by install.sh or an earlier update is used when it passes the check a download gets, and
      // fetched over otherwise; one made with --from is local work and is fetched over.
      let reuse = readInstallInfo(dir)?.source === source;
      if (reuse && check) {
        try {
          await u.verifyTag(dir, target, signers);
        } catch (e) {
          if (!(e instanceof BadTag)) throw e;
          d.log(`Not using the copy already in versions/${target}: ${e.message}.`);
          reuse = false;
        }
      }
      const fetched = reuse ? dir : tmp;
      if (reuse) d.log(`Using the copy already in versions/${target}.`);
      else {
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.mkdirSync(versionsDir(d.dataDir), { recursive: true });
        d.log(`Fetching ${target} from ${source}...`);
        await u.git(["-c", "advice.detachedHead=false", "clone", "--quiet", "--depth", "1", "--branch", target, source, tmp]);
      }
      try {
        if (check) {
          if (!reuse) await u.verifyTag(tmp, target, signers);
          d.log(`The tag ${target} is signed by a key in ${SIGNERS_FILE}.`);
        }
        showChangelog(d.log, fetched, version, target);
        if (!(await confirm(d, o.yes, `Update ccrc from ${version} to ${target}?`))) {
          if (!reuse) fs.rmSync(tmp, { recursive: true, force: true });
          return 0;
        }
        if (!reuse) {
          d.log(`Building ${target}...`);
          await u.finish(tmp, target, source);
        }
      } catch (e) {
        fs.rmSync(tmp, { recursive: true, force: true });
        throw e;
      }
      return await u.switchTo(version, target);
    } finally {
      unlock();
    }
  } catch (e) {
    d.log(`ccrc update: ${message(e)}`);
    return 1;
  }
}

// Goes back to the version before the last update, with the config and state files that update's migrate step
// changed as they were before it.
export async function rollback(o: { yes?: boolean }, deps: Partial<UpdateDeps> = {}): Promise<number> {
  const d = { ...defaultDeps(), ...deps };
  const u = new Updater(d);
  try {
    if (d.inService()) throw new UpdateError(inServiceRefusal("rollback"));
    const last = u
      .history()
      .filter((h) => !h.failed)
      .at(-1);
    if (!last) throw new UpdateError("there is no update to roll back");
    if (last.rollback) throw new UpdateError(`the last change already went back from ${last.from} to ${last.to}; to go forward again: ccrc update --to ${last.from}`);
    if (!last.from) throw new UpdateError(`${last.to} was the first version installed; there is nothing before it`);
    const current = u.current();
    if (current?.version !== last.to) throw new UpdateError(`current is ${current?.version ?? "not set"}, not ${last.to} from the last update`);
    const from = last.from;
    const fromName = u.nameOf(from);
    if (!readInstallInfo(u.dirOf(fromName))) throw new UpdateError(`versions/${last.from} is gone; install it with: ccrc update --to ${last.from}`);
    if (!(await confirm(d, o.yes, `Go back from ${last.to} to ${last.from}?`))) return 0;
    const unlock = u.lock();
    const release = holdSignals(d.log);
    try {
      const c = u.config();
      const svc = await u.service();
      const ownBackup = u.backup(`rollback-${last.to}-${last.from}`);
      d.log(`Config and state as they are now backed up to ${ownBackup}`);
      let migrated: string[] | undefined;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(last.backupDir ?? "", "manifest.json"), "utf8")) as { migrated?: unknown };
        if (Array.isArray(m.migrated)) migrated = m.migrated.filter((f): f is string => typeof f === "string");
      } catch {}
      try {
        if (last.backupDir && fs.existsSync(last.backupDir)) {
          const restored = u.restore(last.backupDir, migrated);
          d.log(restored.length ? `Restored from ${last.backupDir}: ${restored.join(", ")}` : "The update changed no config or state file; nothing to restore.");
        } else d.log(`The backup of that update (${last.backupDir ?? "none"}) is gone; config and state stay as they are.`);
        u.link(fromName);
      } catch (e) {
        u.restoreAll(ownBackup);
        throw new UpdateError(`${message(e)}. Nothing was switched; config and state are as they were.`);
      }
      d.log(`current -> versions/${fromName}`);
      u.tryRecord(() => u.record({ from: last.to, to: from, backupDir: ownBackup, at: d.now().toISOString(), rollback: true }));
      if (svc.state === "current") {
        d.log(`Restarting ${SERVICE}...`);
        let r: { ok: boolean; seen?: string };
        try {
          await u.restart();
          r = await u.waitFor(last.from, c);
        } catch (e) {
          d.log(message(e));
          r = { ok: false };
        }
        if (!r.ok) {
          d.log(`The broker does not answer as ${last.from}${r.seen ? ` (it answers as ${r.seen})` : ""}. Check: systemctl --user status ${SERVICE}`);
          d.log(`Config and state from before the rollback are in ${ownBackup}`);
          return EXIT_BROKEN;
        }
      } else if (svc.state === "other") d.log(`${SERVICE} runs ${svc.exec}, not the install, so it was not restarted.`);
      else d.log(`No ${SERVICE}: start \`${path.join(d.dataDir, "current", "bin", "ccrc")} serve\` again to run ${last.from}.`);
      try {
        u.pruneBackups();
      } catch {}
      u.afterwards(u.nameOf(last.to), fromName);
      return 0;
    } finally {
      release();
      unlock();
    }
  } catch (e) {
    d.log(`ccrc rollback: ${message(e)}`);
    return 1;
  }
}

// What `ccrc status` shows of updates: the newest release the broker last saw, without looking now.
export function updateStatus(version: string | undefined, stateDir = paths.stateDir): string {
  const s = readUpdateCheck(updateCheckFile(stateDir));
  if (!s.checkedAt) return "not looked for yet";
  const when = new Date(s.checkedAt).toLocaleString();
  if (s.error && !s.latest) return `could not look (${when}): ${s.error}`;
  if (s.latest && isNewer(s.latest, version)) return `${s.latest} available (seen ${when}); run: ccrc update`;
  return `none (latest ${s.latest ?? "-"}, seen ${when})`;
}
