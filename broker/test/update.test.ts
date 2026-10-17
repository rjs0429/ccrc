import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readInstallInfo, writeInstallInfo } from "../src/install.ts";
import { changelogSections, compareVersions, isNewer, latestTag, parseLsRemote, parseVersion, releaseUrl, updateSource } from "../src/releases.ts";
import { run, type Runner } from "../src/run.ts";
import { readUpdateCheck } from "../src/update-check.ts";
import { EXIT_BROKEN, EXIT_ROLLED_BACK, parseFrom, rollback, runsCurrent, update, type HistoryEntry, type UpdateDeps } from "../src/update.ts";
import { tempDir } from "./helpers.ts";

// git without the user's own config, hooks or signing.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// A stand-in bin/ccrc whose migrate step marks config.json with its version, or fails when FAIL_MIGRATE is set.
const fakeCcrc = (version: string) => `#!/usr/bin/env bash
set -e
if [ "$1" = migrate ]; then
  [ -z "\${FAIL_MIGRATE:-}" ] || { echo "cannot read the config" >&2; exit 1; }
  f="$CCRC_CONFIG_DIR/config.json"
  [ -f "$f" ] || exit 0
  exec "$CCRC_NODE" -e 'const fs=require("fs");const f=process.argv[1];const c=JSON.parse(fs.readFileSync(f,"utf8"));if(c.migratedTo!==process.argv[2]){c.migratedTo=process.argv[2];fs.writeFileSync(f,JSON.stringify(c));console.log("Config migrated")}' "$f" ${version}
fi
`;

const CHANGELOG = `# Changelog

## [Unreleased]

## [0.8.0-rc.1] - 2026-10-20

### Added
- Release candidate.

## [0.7.1] - 2026-10-19

### Breaking
- The wrapper link changed: reload VS Code windows.

### Fixed
- A fix.

## [0.7.0] - 2026-10-18

### Added
- First public release.
`;

interface Repo {
  work: string;
  bare: string;
}

// A repository with the tags v0.7.0, v0.7.1 (a new LINK_VERSION and migrate step) and v0.8.0-rc.1, and a bare copy.
function makeRepo(sign?: { key: string }): Repo {
  const work = tempDir("ccrc-update-work-");
  git(work, "init", "-q", "-b", "main");
  const put = (rel: string, text: string, mode = 0o644) => {
    fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), text, { mode });
  };
  const tag = (name: string) => {
    if (sign) git(work, "-c", "gpg.format=ssh", "-c", `user.signingkey=${sign.key}`, "tag", "-s", "-m", name, name);
    else git(work, "tag", "-a", "-m", name, name);
  };
  const release = (version: string, link: number) => {
    put("package.json", JSON.stringify({ name: "ccrc", version: version.slice(1) }) + "\n");
    put("CHANGELOG.md", CHANGELOG);
    put("bin/ccrc", fakeCcrc(version), 0o755);
    put("broker/src/link/protocol.ts", `export const LINK_VERSION = ${link};\n`);
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", `Release ${version}`);
    tag(version);
  };
  release("v0.7.0", 1);
  release("v0.7.1", 2);
  release("v0.8.0-rc.1", 2);
  const bare = path.join(tempDir("ccrc-update-bare-"), "ccrc.git");
  git(work, "clone", "-q", "--bare", work, bare);
  return { work, bare };
}

interface World {
  dataDir: string;
  configDir: string;
  stateDir: string;
  root: string;
  calls: string[];
  restarts: number;
  // What the broker answers on /api/ping.
  running?: string;
  // A version that does not come up after a restart.
  broken?: string;
  failBuild?: boolean;
  service: "current" | "other" | "none";
  lines: string[];
  deps: Partial<UpdateDeps>;
}

// An install of `version` from the repository, as install.sh leaves it, with a running service.
function installed(repo: Repo, version = "v0.7.0"): World {
  const dataDir = tempDir("ccrc-update-data-");
  const configDir = tempDir("ccrc-update-config-");
  const stateDir = tempDir("ccrc-update-state-");
  const root = path.join(dataDir, "versions", version);
  git(dataDir, "clone", "-q", "--depth", "1", "--branch", version, repo.bare, root);
  writeInstallInfo(root, { version, commit: git(root, "rev-parse", "HEAD"), source: repo.bare, node: process.execPath, installedAt: "2026-10-18T00:00:00Z" });
  fs.symlinkSync(path.join("versions", version), path.join(dataDir, "current"));
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ schemaVersion: 1, port: 18999, brokerSessions: "off" }, null, 2) + "\n");
  fs.writeFileSync(path.join(stateDir, "archived.json"), "[]\n");
  const w: World = { dataDir, configDir, stateDir, root, calls: [], restarts: 0, running: version, service: "current", lines: [], deps: {} };
  const currentVersion = () => readInstallInfo(fs.realpathSync(path.join(dataDir, "current")))?.version;
  const runner: Runner = async (cmd, args, o) => {
    w.calls.push([path.basename(cmd), ...args].join(" "));
    const ok = { code: 0, stdout: "", stderr: "" };
    if (cmd === "npm") {
      if (w.failBuild && args[0] === "run") return { code: 2, stdout: "", stderr: "src/main.ts(1,1): error TS1005" };
      if (args[0] === "ci") fs.mkdirSync(path.join(o!.cwd!, "node_modules"), { recursive: true });
      return ok;
    }
    if (cmd === "systemctl") {
      if (args.includes("show")) {
        if (w.service === "none") return { code: 0, stdout: "LoadState=not-found\nExecStart=\n", stderr: "" };
        const exec = w.service === "current" ? path.join(dataDir, "current", "bin", "ccrc") : "/home/user/ccrc/bin/ccrc";
        return { code: 0, stdout: `LoadState=loaded\nExecStart={ path=${exec} ; argv[]=${exec} serve ; ignore_errors=no ; start_time=[n/a] }\n`, stderr: "" };
      }
      if (args.includes("restart")) {
        w.restarts++;
        const v = currentVersion();
        w.running = v === w.broken ? undefined : v;
        return ok;
      }
    }
    return run(cmd, args, o);
  };
  w.deps = {
    dataDir,
    configDir,
    stateDir,
    codeRoot: root,
    node: process.execPath,
    env: GIT_ENV,
    runner,
    ping: async () => w.running,
    ask: async () => true,
    log: (line) => w.lines.push(line),
    pingWaitMs: 100,
    pingEveryMs: 10,
  };
  return w;
}

const current = (w: World) => fs.readlinkSync(path.join(w.dataDir, "current"));
const config = (w: World) => JSON.parse(fs.readFileSync(path.join(w.configDir, "config.json"), "utf8"));
const history = (w: World): HistoryEntry[] => JSON.parse(fs.readFileSync(path.join(w.dataDir, "history.json"), "utf8"));
const versions = (w: World) => fs.readdirSync(path.join(w.dataDir, "versions")).sort();
const output = (w: World) => w.lines.join("\n");

test("versions order as SemVer, candidates before their release and commits past a tag after it", () => {
  const order = ["v0.6.0", "v0.7.0-rc.1", "v0.7.0-rc.2", "v0.7.0", "v0.7.0-3-gabc1234", "v0.7.1", "v0.10.0"];
  const shuffled = [...order].reverse();
  assert.deepEqual(
    shuffled.sort((a, b) => compareVersions(parseVersion(a)!, parseVersion(b)!)),
    order,
  );
  assert.equal(parseVersion("0123abc"), undefined);
  assert.equal(isNewer("v0.7.1", "v0.7.0-3-gabc1234"), true);
  assert.equal(isNewer("v0.7.0", "v0.7.0-3-gabc1234"), false, "a checkout past the tag is not behind it");
  assert.equal(isNewer("v0.7.1", "0123abc"), false, "a bare commit hash says nothing");
  assert.equal(isNewer("v0.7.1", "0.7.0"), true, "package.json's version");
  const tags = parseLsRemote(["v0.7.0", "v0.8.0-rc.1", "v0.7.1", "nightly", "v0.9.0-beta"].map((t) => `${"a".repeat(40)}\trefs/tags/${t}`).join("\n"));
  assert.equal(latestTag(tags), "v0.7.1");
  assert.equal(latestTag(tags, "rc"), "v0.8.0-rc.1");
  assert.equal(latestTag(["nightly"]), undefined);
});

test("updates come from the install's source, else updateRepo, else the project", () => {
  assert.equal(updateSource({ source: "/home/user/ccrc" }, "https://example.com/fork.git"), "/home/user/ccrc");
  assert.equal(updateSource(undefined, "https://example.com/fork.git"), "https://example.com/fork.git");
  assert.equal(updateSource({ source: "" }, undefined), "https://github.com/rjs0429/ccrc.git");
  assert.equal(releaseUrl("https://github.com/rjs0429/ccrc.git", "v0.7.1"), "https://github.com/rjs0429/ccrc/releases/tag/v0.7.1");
  assert.equal(releaseUrl("git@github.com:someone/ccrc.git", "v1.0.0"), "https://github.com/someone/ccrc/releases/tag/v1.0.0");
  assert.equal(releaseUrl("/home/user/ccrc", "v1.0.0"), undefined);
});

test("the changelog shows every version past the running one, and its breaking changes apart", () => {
  const two = changelogSections(CHANGELOG, "v0.8.0-rc.1", "v0.7.0");
  assert.deepEqual(
    two.map((s) => s.version),
    ["0.8.0-rc.1", "0.7.1"],
  );
  assert.deepEqual(two[1].breaking, ["- The wrapper link changed: reload VS Code windows."]);
  assert.deepEqual(two[0].breaking, []);
  assert.deepEqual(
    changelogSections(CHANGELOG, "v0.7.1", "0123abc").map((s) => s.version),
    ["0.7.1"],
    "only the target's when the running version is no release",
  );
});

test("a service program is told to run the install through links", () => {
  const dataDir = tempDir();
  const bin = tempDir();
  fs.symlinkSync(path.join(dataDir, "current", "bin", "ccrc"), path.join(bin, "ccrc"));
  assert.equal(runsCurrent(path.join(dataDir, "current", "bin", "ccrc"), dataDir), true);
  assert.equal(runsCurrent(path.join(bin, "ccrc"), dataDir), true, "~/.local/bin/ccrc");
  assert.equal(runsCurrent("/home/user/ccrc/bin/ccrc", dataDir), false);
  assert.equal(runsCurrent("", dataDir), false);
  assert.deepEqual(parseFrom("/home/user/no-such-repo@dev"), { repo: "/home/user/no-such-repo", ref: "dev" });
  assert.deepEqual(parseFrom(bin), { repo: bin, ref: "HEAD" });
});

test("--check names the newest release of the channel and records it", async () => {
  const repo = makeRepo();
  const w = installed(repo);
  assert.equal(await update({ check: true }, w.deps), 0);
  assert.match(output(w), /latest: v0\.7\.1 on stable/);
  assert.match(output(w), /v0\.7\.1 is available/);
  assert.equal(readUpdateCheck(path.join(w.stateDir, "update-check.json")).latest, "v0.7.1");
  w.lines.length = 0;
  assert.equal(await update({ check: true, channel: "rc" }, w.deps), 0);
  assert.match(output(w), /latest: v0\.8\.0-rc\.1 on rc/);
  assert.equal(current(w), path.join("versions", "v0.7.0"), "a check changes nothing");
  assert.equal(w.restarts, 0);
});

test("an update builds beside the running version, migrates, switches, restarts and keeps the one before", async () => {
  const repo = makeRepo();
  const w = installed(repo);
  fs.mkdirSync(path.join(w.dataDir, "versions", "v0.6.0"));
  fs.mkdirSync(path.join(w.dataDir, "versions", "v0.9.9.tmp"));
  const before = fs.readFileSync(path.join(w.configDir, "config.json"), "utf8");

  assert.equal(await update({ yes: true }, w.deps), 0, output(w));
  assert.equal(current(w), path.join("versions", "v0.7.1"));
  const info = readInstallInfo(path.join(w.dataDir, "versions", "v0.7.1"))!;
  assert.equal(info.version, "v0.7.1");
  assert.equal(info.source, repo.bare);
  assert.equal(info.node, process.execPath);
  assert.equal(info.commit, git(repo.work, "rev-parse", "v0.7.1^{commit}"));
  assert.equal(config(w).migratedTo, "v0.7.1", "the new version's migrate step ran");
  assert.deepEqual(
    w.calls.filter((c) => c.startsWith("npm")),
    ["npm ci --no-audit --no-fund", "npm run build"],
  );
  assert.equal(w.restarts, 1);
  assert.equal(w.running, "v0.7.1");

  const [entry] = history(w);
  assert.deepEqual({ from: entry.from, to: entry.to }, { from: "v0.7.0", to: "v0.7.1" });
  assert.equal(fs.readFileSync(path.join(entry.backupDir!, "config", "config.json"), "utf8"), before, "the config as it was");
  assert.ok(fs.existsSync(path.join(entry.backupDir!, "state", "archived.json")));
  assert.ok(entry.backupDir!.startsWith(path.join(w.stateDir, "backup", "update-v0.7.0-v0.7.1-")));
  assert.deepEqual(versions(w), ["v0.7.0", "v0.7.1"], "the version before stays; older ones and left-over downloads go");

  assert.match(output(w), /## 0\.7\.1/);
  assert.match(output(w), /Breaking changes:\n {2}0\.7\.1: - The wrapper link changed/);
  assert.match(output(w), /reload VS Code windows/, "LINK_VERSION changed");
  assert.match(output(w), /close the home screen app/);

  w.lines.length = 0;
  assert.equal(await update({ yes: true }, w.deps), 0);
  assert.match(output(w), /ccrc is already v0\.7\.1/);
  assert.equal(w.restarts, 1);
});

test("an update that does not come up goes back to the version before with the config as it was", async () => {
  const repo = makeRepo();
  const w = installed(repo);
  w.broken = "v0.7.1";
  const before = fs.readFileSync(path.join(w.configDir, "config.json"), "utf8");

  const code = await update({ yes: true }, w.deps);
  assert.equal(code, EXIT_ROLLED_BACK, output(w));
  assert.notEqual(code, 1);
  assert.equal(current(w), path.join("versions", "v0.7.0"));
  assert.equal(fs.readFileSync(path.join(w.configDir, "config.json"), "utf8"), before);
  assert.equal(w.restarts, 2, "once into the new version, once back");
  assert.equal(w.running, "v0.7.0");
  assert.match(output(w), /Update to v0\.7\.1 failed: the broker did not answer/);
  const last = history(w).at(-1)!;
  assert.equal(last.to, "v0.7.1");
  assert.match(last.failed!, /did not answer/);

  // The old version does not come back either.
  w.broken = "v0.7.1";
  const stuck = installed(repo);
  stuck.broken = "v0.7.1";
  const deps = stuck.deps;
  let restarts = 0;
  const runner = deps.runner!;
  deps.runner = async (cmd, args, o) => {
    if (cmd === "systemctl" && args.includes("restart") && ++restarts === 2) stuck.broken = "v0.7.0";
    return runner(cmd, args, o);
  };
  assert.equal(await update({ yes: true }, deps), EXIT_BROKEN);
  assert.match(stuck.lines.join("\n"), /does not answer as v0\.7\.0 either/);
  assert.equal(current(stuck), path.join("versions", "v0.7.0"));
});

test("rollback goes back to the version before the last update and undoes what its migrate step changed", async () => {
  const repo = makeRepo();
  const w = installed(repo);
  assert.equal(await update({ yes: true }, w.deps), 0);
  // Made after the update; the rollback leaves it.
  fs.writeFileSync(path.join(w.configDir, "push.json"), "{}\n");

  w.lines.length = 0;
  assert.equal(await rollback({ yes: true }, w.deps), 0, output(w));
  assert.equal(current(w), path.join("versions", "v0.7.0"));
  assert.equal(config(w).migratedTo, undefined);
  assert.ok(fs.existsSync(path.join(w.configDir, "push.json")));
  assert.equal(w.running, "v0.7.0");
  assert.equal(w.restarts, 2);
  assert.match(output(w), /Restored from .*: config\/config\.json/);
  const last = history(w).at(-1)!;
  assert.deepEqual({ from: last.from, to: last.to, rollback: last.rollback }, { from: "v0.7.1", to: "v0.7.0", rollback: true });
  const saved = JSON.parse(fs.readFileSync(path.join(last.backupDir!, "config", "config.json"), "utf8"));
  assert.equal(saved.migratedTo, "v0.7.1", "the config as it was before the rollback is kept");

  w.lines.length = 0;
  assert.equal(await rollback({ yes: true }, w.deps), 1);
  assert.match(output(w), /already went back from v0\.7\.1 to v0\.7\.0; to go forward again: ccrc update --to v0\.7\.1/);

  // Forward again with --to: the kept copy is used without fetching.
  w.calls.length = 0;
  assert.equal(await update({ yes: true, to: "0.7.1" }, w.deps), 0, output(w));
  assert.equal(current(w), path.join("versions", "v0.7.1"));
  assert.ok(!w.calls.some((c) => c.startsWith("git -c advice.detachedHead=false clone") || c.startsWith("npm")));
});

test("nothing switches when the build or the migrate step fails", async () => {
  const repo = makeRepo();
  const w = installed(repo);
  const before = fs.readFileSync(path.join(w.configDir, "config.json"), "utf8");
  w.failBuild = true;
  assert.equal(await update({ yes: true }, w.deps), 1);
  assert.match(output(w), /npm run build failed: src\/main\.ts/);
  assert.deepEqual(versions(w), ["v0.7.0"]);
  w.failBuild = false;

  w.lines.length = 0;
  w.deps.env = { ...GIT_ENV, FAIL_MIGRATE: "1" };
  assert.equal(await update({ yes: true }, w.deps), 1);
  assert.match(output(w), /v0\.7\.1 could not migrate the config: cannot read the config\. Nothing was switched/);
  assert.equal(current(w), path.join("versions", "v0.7.0"));
  assert.equal(fs.readFileSync(path.join(w.configDir, "config.json"), "utf8"), before);
  assert.equal(w.restarts, 0);
  assert.equal(fs.existsSync(path.join(w.dataDir, "update.lock")), false);

  w.lines.length = 0;
  w.deps.env = GIT_ENV;
  w.deps.ask = async () => false;
  assert.equal(await update({}, w.deps), 0);
  assert.equal(current(w), path.join("versions", "v0.7.0"), "declined");
  assert.ok(!fs.existsSync(path.join(w.dataDir, "versions", "v0.7.1.tmp")));
});

test("a development checkout is told how to update; --from installs a commit of a local repository", async () => {
  const repo = makeRepo();
  const w = installed(repo);
  const checkout = tempDir();
  fs.mkdirSync(path.join(checkout, ".git"));
  assert.equal(await update({ yes: true }, { ...w.deps, codeRoot: checkout }), 1);
  assert.match(output(w), /development checkout .*updates installs only/);
  assert.match(output(w), /current\/bin\/ccrc update/);
  assert.equal(w.restarts, 0);

  fs.writeFileSync(path.join(repo.work, "extra.txt"), "x\n");
  git(repo.work, "add", "-A");
  git(repo.work, "commit", "-q", "-m", "Work after the candidate");
  const described = git(repo.work, "describe", "--always", "--match", "v[0-9]*", "HEAD");
  assert.match(described, /^v0\.8\.0-rc\.1-1-g[0-9a-f]+$/);
  w.lines.length = 0;
  assert.equal(await update({ yes: true, from: repo.work }, { ...w.deps, codeRoot: checkout }), 0, output(w));
  assert.equal(current(w), path.join("versions", described));
  assert.equal(readInstallInfo(path.join(w.dataDir, "versions", described))!.source, repo.work);
  assert.equal(w.running, described);

  w.lines.length = 0;
  assert.equal(await update({ yes: true, from: `${repo.work}@v0.7.1` }, w.deps), 0, output(w));
  assert.equal(current(w), path.join("versions", "v0.7.1"));
  assert.deepEqual(versions(w), ["v0.7.1", described]);
});

test("a service that runs something else, or none, is not restarted", async () => {
  const repo = makeRepo();
  const other = installed(repo);
  other.service = "other";
  assert.equal(await update({ yes: true }, other.deps), 0);
  assert.equal(current(other), path.join("versions", "v0.7.1"));
  assert.equal(other.restarts, 0);
  assert.match(output(other), /runs \/home\/user\/ccrc\/bin\/ccrc, not .*so it was not restarted/);

  const none = installed(repo);
  none.service = "none";
  assert.equal(await update({ yes: true }, none.deps), 0);
  assert.match(output(none), /No ccrc\.service: start `.*current\/bin\/ccrc serve` again/);
});

test("with allowed signers in the install, a tag must carry a signature from one of them", async (t) => {
  if (spawnSync("ssh-keygen", ["-?"]).error) return t.skip("no ssh-keygen");
  const keys = tempDir();
  const key = path.join(keys, "id");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "test@example.com", "-f", key]);
  const signers = `test@example.com namespaces="git" ${fs.readFileSync(`${key}.pub`, "utf8").trim()}\n`;

  const signed = installed(makeRepo({ key }));
  fs.writeFileSync(path.join(signed.root, ".ccrc-allowed-signers"), signers);
  assert.equal(await update({ yes: true }, signed.deps), 0, output(signed));
  assert.match(output(signed), /The tag v0\.7\.1 is signed/);

  const unsigned = installed(makeRepo());
  fs.writeFileSync(path.join(unsigned.root, ".ccrc-allowed-signers"), signers);
  assert.equal(await update({ yes: true }, unsigned.deps), 1);
  assert.match(output(unsigned), /the signature of v0\.7\.1 does not check out/);
  assert.equal(current(unsigned), path.join("versions", "v0.7.0"));
  assert.deepEqual(versions(unsigned), ["v0.7.0"]);
});

test("bin/ccrc update and rollback: options, a development checkout, and the status line", () => {
  const repo = makeRepo();
  const home = tempDir();
  const env = {
    ...GIT_ENV,
    PATH: "/usr/bin:/bin",
    HOME: home,
    CCRC_NODE: process.execPath,
    CCRC_CONFIG_DIR: path.join(home, "config"),
    CCRC_STATE_DIR: path.join(home, "state"),
    CCRC_DATA_DIR: path.join(home, "data"),
  };
  const ccrc = (...args: string[]) => spawnSync(path.join(import.meta.dirname, "..", "..", "bin", "ccrc"), args, { env, encoding: "utf8" });
  assert.match(ccrc("update", "--nope").stderr, /unknown option --nope/);
  assert.match(ccrc("update", "--channel", "beta").stderr, /--channel takes stable or rc/);
  const dev = ccrc("update", "--yes");
  assert.equal(dev.status, 1);
  assert.match(dev.stdout, /development checkout .*updates installs only/);
  const back = ccrc("rollback", "--yes");
  assert.equal(back.status, 1);
  assert.match(back.stdout, /there is no update to roll back/);

  assert.match(ccrc("status").stdout, /^update: {6}not looked for yet$/m);
  fs.mkdirSync(env.CCRC_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(env.CCRC_CONFIG_DIR, "config.json"), JSON.stringify({ schemaVersion: 1, brokerSessions: "off", updateRepo: repo.bare }));
  const check = ccrc("update", "--check");
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /latest: v0\.7\.1 on stable/);
  assert.match(ccrc("status").stdout, /^update: {6}none \(latest v0\.7\.1, seen /m, "a checkout past no tag is not behind");
  fs.writeFileSync(path.join(env.CCRC_CONFIG_DIR, "config.json"), JSON.stringify({ schemaVersion: 1, brokerSessions: "off", updateCheck: false }));
  assert.match(ccrc("status").stdout, /^update: {6}not looked for \(updateCheck is false\)$/m);
});
