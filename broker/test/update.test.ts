import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { brokerVersion, readInstallInfo, writeInstallInfo } from "../src/install.ts";
import { changelogSections, compareVersions, isNewer, latestTag, parseLsRemote, parseVersion, releaseUrl, updateSource } from "../src/releases.ts";
import { run, type Runner } from "../src/run.ts";
import { readUpdateCheck } from "../src/update-check.ts";
import { EXIT_BROKEN, EXIT_ROLLED_BACK, parseFrom, rollback, runsCurrent, update, wrapperChange, type HistoryEntry, type UpdateDeps } from "../src/update.ts";
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
// sign: SSH-signs the tags with a key file, or OpenPGP-signs them with GnuPG in gnupgHome.
function makeRepo(sign?: { key: string } | { gnupgHome: string }): Repo {
  const work = tempDir("ccrc-update-work-");
  git(work, "init", "-q", "-b", "main");
  const put = (rel: string, text: string, mode = 0o644) => {
    fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), text, { mode });
  };
  const tag = (name: string) => {
    if (sign && "key" in sign) git(work, "-c", "gpg.format=ssh", "-c", `user.signingkey=${sign.key}`, "tag", "-s", "-m", name, name);
    else if (sign) execFileSync("git", ["tag", "-s", "-u", "test@example.com", "-m", name, name], { cwd: work, env: { ...GIT_ENV, GNUPGHOME: sign.gnupgHome }, stdio: "ignore" });
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
    inService: () => false,
  };
  return w;
}

// A test SSH signing key and the signers file line that lists it.
function signingKey(): { keys: string; key: string; signers: string } {
  const keys = tempDir();
  const key = path.join(keys, "id");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "test@example.com", "-f", key]);
  return { keys, key, signers: `test@example.com namespaces="git" ${fs.readFileSync(`${key}.pub`, "utf8").trim()}\n` };
}

// A copy of a tag as install.sh leaves it in versions/: cloned from `from`, built, recorded with `source`, unchecked.
function leaveCopy(w: World, from: string, version: string, source: string): string {
  const dir = path.join(w.dataDir, "versions", version);
  git(w.dataDir, "-c", "advice.detachedHead=false", "clone", "-q", "--branch", version, from, dir);
  fs.mkdirSync(path.join(dir, "node_modules"));
  writeInstallInfo(dir, { version, commit: git(dir, "rev-parse", "HEAD"), source, node: process.execPath, installedAt: "2026-10-18T00:00:00Z" });
  return dir;
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
  // install.sh's download: kept while that process runs, removed once it is gone.
  fs.mkdirSync(path.join(w.dataDir, "versions", `.tmp-${process.pid}`));
  const gone = spawnSync(process.execPath, ["-e", ""]).pid!;
  fs.mkdirSync(path.join(w.dataDir, "versions", `.tmp-${gone}`));
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
  assert.deepEqual(versions(w), [`.tmp-${process.pid}`, "v0.7.0", "v0.7.1"], "the version before stays; older ones and left-over downloads go");

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

test("open Claude tabs are told to reload when the wrapper protocol changes or the new wrapper has new features", () => {
  const version = (files: Record<string, string>) => {
    const dir = tempDir();
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    return dir;
  };
  const link = (v: number) => ({ "broker/src/link/protocol.ts": `export const LINK_VERSION = ${v};\n` });
  const caps = (list: string) => ({ "broker/src/wrapper/relay.ts": `// Told to the broker in the hello.\nconst CAPS = ${list};\nexport const PUSH_HOOK = "x";\n` });
  const v07 = version({ ...link(1), ...caps('["fast_mode", "thinking"]') });
  const v08 = version({ ...link(1), ...caps('["fast_mode", "thinking", "claude_push", "side_question"]') });
  assert.equal(wrapperChange(v07, v08), "The VS Code wrapper has new features (claude_push, side_question)");
  assert.equal(wrapperChange(v08, v07), undefined, "going back: open tabs keep the newer wrapper, which the older broker works with");
  assert.equal(wrapperChange(v08, version({ ...link(1), ...caps('[\n  "side_question",\n  "claude_push",\n  "thinking",\n  "fast_mode",\n]') })), undefined, "the same features, one a line");
  assert.equal(wrapperChange(v07, version({ ...link(2), ...caps('["fast_mode", "thinking"]') })), "The wrapper protocol changed");
  assert.equal(wrapperChange(v07, version(link(1))), "The VS Code wrapper changed", "a wrapper whose features cannot be read");
  assert.equal(wrapperChange(version(link(1)), version(link(1))), undefined);
});

test("an update whose wrapper has new features says to reload VS Code windows; going back from it does not", async () => {
  const repo = makeRepo();
  const w = installed(repo, "v0.7.1");
  const relay = (dir: string, caps: string[]) => {
    fs.mkdirSync(path.join(dir, "broker", "src", "wrapper"), { recursive: true });
    fs.writeFileSync(path.join(dir, "broker", "src", "wrapper", "relay.ts"), `const CAPS = [${caps.map((c) => `"${c}"`).join(", ")}];\n`);
  };
  relay(w.root, ["fast_mode", "thinking"]);
  relay(repo.work, ["fast_mode", "thinking", "side_question"]);
  git(repo.work, "add", "-A");
  git(repo.work, "commit", "-q", "-m", "A wrapper feature");
  assert.equal(await update({ yes: true, from: repo.work }, w.deps), 0, output(w));
  assert.match(output(w), /^- The VS Code wrapper has new features \(side_question\): reload VS Code windows \(Developer: Reload Window\)/m);
  w.lines.length = 0;
  assert.equal(await rollback({ yes: true }, w.deps), 0, output(w));
  assert.doesNotMatch(output(w), /reload VS Code windows/);
  assert.match(output(w), /close the home screen app/);
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
  assert.equal(readInstallInfo(path.join(w.dataDir, "versions", described))!.updateSource, repo.bare, "releases are still looked for where they were");
  assert.equal(w.running, described);
  w.lines.length = 0;
  assert.equal(await update({ check: true }, w.deps), 0);
  assert.match(output(w), new RegExp(`from ${repo.bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));

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

test("with allowed signers but no ssh-keygen, or one too old, the update stops and says what to install", async (t) => {
  if (spawnSync("ssh-keygen", ["-?"]).error) return t.skip("no ssh-keygen");
  const keys = tempDir();
  const key = path.join(keys, "id");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "test@example.com", "-f", key]);
  const repo = makeRepo({ key });
  const w = installed(repo);
  fs.writeFileSync(path.join(w.root, ".ccrc-allowed-signers"), `test@example.com namespaces="git" ${fs.readFileSync(`${key}.pub`, "utf8").trim()}\n`);
  // PATH with git and a package manager, without ssh-keygen.
  const bin = tempDir();
  for (const cmd of ["git", "apt-get"]) fs.symlinkSync(execFileSync("sh", ["-c", `command -v ${cmd} || echo /bin/true`], { encoding: "utf8" }).trim(), path.join(bin, cmd));
  w.deps = { ...w.deps, env: { ...GIT_ENV, PATH: bin } };
  assert.equal(await update({ yes: true }, w.deps), 1, output(w));
  assert.match(output(w), /could not check the signature of v0\.7\.1: git checks it with ssh-keygen, which it could not run \(error: cannot run ssh-keygen/);
  assert.match(output(w), /Run ccrc update again once it is installed; install it with: sudo apt-get install openssh-client$/m);
  assert.equal(current(w), path.join("versions", "v0.7.0"));
  assert.deepEqual(versions(w), ["v0.7.0"]);

  // A copy already in versions/ is neither used nor fetched over while it cannot be checked.
  leaveCopy(w, repo.bare, "v0.7.1", repo.bare);
  w.lines.length = 0;
  w.calls.length = 0;
  assert.equal(await update({ yes: true }, w.deps), 1, output(w));
  assert.match(output(w), /could not check the signature of v0\.7\.1: git checks it with ssh-keygen, which it could not run/);
  assert.ok(!w.calls.some((c) => c.includes(" clone ")), w.calls.join("\n"));
  assert.equal(current(w), path.join("versions", "v0.7.0"));
  assert.ok(readInstallInfo(path.join(w.dataDir, "versions", "v0.7.1")));

  // An unsigned tag is reported as such, ssh-keygen or not: git does not get as far as running it.
  const unsigned = installed(makeRepo());
  fs.writeFileSync(path.join(unsigned.root, ".ccrc-allowed-signers"), fs.readFileSync(path.join(w.root, ".ccrc-allowed-signers")));
  unsigned.deps = { ...unsigned.deps, env: { ...GIT_ENV, PATH: bin } };
  assert.equal(await update({ yes: true }, unsigned.deps), 1);
  assert.match(output(unsigned), /the signature of v0\.7\.1 does not check out .*no signature found/);
  assert.doesNotMatch(output(unsigned), /install it with/);

  // OpenSSH before 8.2 (RHEL 8) has an ssh-keygen without -Y find-principals.
  const old = installed(makeRepo({ key }));
  fs.writeFileSync(path.join(old.root, ".ccrc-allowed-signers"), fs.readFileSync(path.join(w.root, ".ccrc-allowed-signers")));
  const oldBin = tempDir();
  fs.symlinkSync(path.join(bin, "git"), path.join(oldBin, "git"));
  fs.writeFileSync(path.join(oldBin, "ssh-keygen"), "#!/bin/sh\necho 'usage: ssh-keygen [-q] [-a rounds]' >&2\nexit 1\n", { mode: 0o755 });
  old.deps = { ...old.deps, env: { ...GIT_ENV, PATH: oldBin } };
  assert.equal(await update({ yes: true }, old.deps), 1);
  assert.match(output(old), /could not check the signature of v0\.7\.1: git needs ssh-keygen from OpenSSH 8\.2 or newer/);
  assert.match(output(old), /Run ccrc update again on a newer one; install OpenSSH 8\.2 or newer and make its ssh-keygen the first on PATH \(RHEL 8 and its rebuilds ship 8\.0\)$/m);
  assert.equal(current(old), path.join("versions", "v0.7.0"));
});

test("with allowed signers in the install, an OpenPGP signature does not pass even from a key GnuPG trusts", async (t) => {
  if (spawnSync("ssh-keygen", ["-?"]).error || spawnSync("gpg", ["--version"]).error) return t.skip("no ssh-keygen or gpg");
  const gnupgHome = tempDir();
  fs.chmodSync(gnupgHome, 0o700);
  const gpgEnv = { ...process.env, GNUPGHOME: gnupgHome };
  t.after(() => spawnSync("gpgconf", ["--kill", "gpg-agent"], { env: gpgEnv }));
  const made = spawnSync("gpg", ["--batch", "--passphrase", "", "--quick-gen-key", "Test <test@example.com>", "ed25519", "sign", "never"], { env: gpgEnv, encoding: "utf8" });
  if (made.status !== 0) return t.skip(`gpg could not make a key: ${made.stderr.trim().split("\n").at(-1)}`);
  const keys = tempDir();
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "test@example.com", "-f", path.join(keys, "id")]);
  const signers = `test@example.com namespaces="git" ${fs.readFileSync(path.join(keys, "id.pub"), "utf8").trim()}\n`;

  const repo = makeRepo({ gnupgHome });
  const env = { ...GIT_ENV, GNUPGHOME: gnupgHome };
  execFileSync("git", ["-C", repo.work, "verify-tag", "v0.7.1"], { env, stdio: "ignore" });
  const w = installed(repo);
  w.deps = { ...w.deps, env };
  fs.writeFileSync(path.join(w.root, ".ccrc-allowed-signers"), signers);
  assert.equal(await update({ yes: true }, w.deps), 1, output(w));
  assert.match(output(w), /the signature of v0\.7\.1 does not check out/);
  assert.equal(current(w), path.join("versions", "v0.7.0"));
});

test("a tag is checked by the ssh-keygen on PATH and the signers file alone, whatever the user's git config sets", async (t) => {
  if (spawnSync("ssh-keygen", ["-?"]).error) return t.skip("no ssh-keygen");
  const { keys, key, signers } = signingKey();
  const repo = makeRepo({ key });
  // A program that only signs and answers anything else with its usage, one that is not there, and a GnuPG trust level
  // above the one git gives an SSH signature.
  const signOnly = path.join(keys, "sign-only");
  fs.writeFileSync(signOnly, '#!/bin/sh\necho "usage: sign-only -Y sign -n namespace -f key_file" >&2\nexit 1\n', { mode: 0o755 });
  const configs = [`[gpg "ssh"]\n\tprogram = ${signOnly}\n`, `[gpg "ssh"]\n\tprogram = ${path.join(keys, "missing")}\n`, "[gpg]\n\tminTrustLevel = ultimate\n"];
  for (const [i, text] of configs.entries()) {
    const file = path.join(keys, `user-${i}.gitconfig`);
    fs.writeFileSync(file, text);
    const w = installed(repo);
    w.deps = { ...w.deps, env: { ...GIT_ENV, GIT_CONFIG_GLOBAL: file } };
    fs.writeFileSync(path.join(w.root, ".ccrc-allowed-signers"), signers);
    assert.equal(await update({ yes: true }, w.deps), 0, `${text}${output(w)}`);
    assert.match(output(w), /The tag v0\.7\.1 is signed/);
    assert.ok(w.calls.some((c) => c.includes(" -c gpg.ssh.program=ssh-keygen -c gpg.minTrustLevel=undefined ") && c.endsWith(" verify-tag refs/tags/v0.7.1")));
  }
});

test("a copy of the version already in versions/ is used once it passes the check, and fetched again when it does not", async (t) => {
  if (spawnSync("ssh-keygen", ["-?"]).error) return t.skip("no ssh-keygen");
  const { key, signers } = signingKey();
  const repo = makeRepo({ key });
  const tagged = git(repo.work, "rev-parse", "v0.7.1^{commit}");

  const good = installed(repo);
  fs.writeFileSync(path.join(good.root, ".ccrc-allowed-signers"), signers);
  const copy = leaveCopy(good, repo.bare, "v0.7.1", repo.bare);
  assert.equal(await update({ yes: true }, good.deps), 0, output(good));
  assert.match(output(good), /Using the copy already in versions\/v0\.7\.1\.\nThe tag v0\.7\.1 is signed by a key in \.ccrc-allowed-signers\./);
  assert.ok(good.calls.some((c) => c.startsWith(`git -C ${copy} `) && c.endsWith(" verify-tag refs/tags/v0.7.1")));
  assert.ok(!good.calls.some((c) => c.includes(" clone ") || c.startsWith("npm")), good.calls.join("\n"));
  assert.equal(current(good), path.join("versions", "v0.7.1"));

  // One install.sh made of an unsigned tag, and one moved off its tag's commit.
  const unsigned = makeRepo();
  const spoiled: [string, (w: World) => void][] = [
    ["the signature of v0\\.7\\.1 does not check out against .*no signature found", (w) => leaveCopy(w, unsigned.bare, "v0.7.1", repo.bare)],
    ["versions/v0\\.7\\.1 is at [0-9a-f]{12}, not at [0-9a-f]{12}, the commit v0\\.7\\.1 names", (w) => git(leaveCopy(w, repo.bare, "v0.7.1", repo.bare), "commit", "-q", "--allow-empty", "-m", "Local change")],
  ];
  for (const [why, spoil] of spoiled) {
    const w = installed(repo);
    fs.writeFileSync(path.join(w.root, ".ccrc-allowed-signers"), signers);
    spoil(w);
    assert.equal(await update({ yes: true }, w.deps), 0, output(w));
    assert.match(output(w), new RegExp(`Not using the copy already in versions/v0\\.7\\.1: ${why}\\.\\nFetching v0\\.7\\.1 from `));
    assert.match(output(w), /The tag v0\.7\.1 is signed/);
    assert.equal(current(w), path.join("versions", "v0.7.1"));
    assert.equal(readInstallInfo(path.join(w.dataDir, "versions", "v0.7.1"))!.commit, tagged);
  }

  // When the fetched tag does not pass either, nothing switches.
  const bad = installed(unsigned);
  fs.writeFileSync(path.join(bad.root, ".ccrc-allowed-signers"), signers);
  leaveCopy(bad, unsigned.bare, "v0.7.1", unsigned.bare);
  assert.equal(await update({ yes: true }, bad.deps), 1);
  assert.match(output(bad), /Not using the copy already in versions\/v0\.7\.1: the signature of v0\.7\.1 does not check out/);
  assert.match(output(bad), /ccrc update: the signature of v0\.7\.1 does not check out .*no signature found/);
  assert.equal(current(bad), path.join("versions", "v0.7.0"));
  assert.ok(!fs.existsSync(path.join(bad.dataDir, "versions", "v0.7.1.tmp")));
});

test("a signed tag of an older release offered under a newer name does not pass", async (t) => {
  if (spawnSync("ssh-keygen", ["-?"]).error) return t.skip("no ssh-keygen");
  const { key, signers } = signingKey();
  const repo = makeRepo({ key });
  git(repo.bare, "update-ref", "refs/tags/v0.9.0", git(repo.bare, "rev-parse", "refs/tags/v0.7.0"));
  const w = installed(repo);
  fs.writeFileSync(path.join(w.root, ".ccrc-allowed-signers"), signers);
  assert.equal(await update({ yes: true }, w.deps), 1, output(w));
  assert.match(output(w), /ccrc update: the tag v0\.9\.0 is the signed tag of v0\.7\.0, not of v0\.9\.0$/m);
  assert.equal(current(w), path.join("versions", "v0.7.0"));
  assert.deepEqual(versions(w), ["v0.7.0"]);
});

test("the repository's .ccrc-allowed-signers lists SSH keys for git signatures", (t) => {
  const file = path.join(import.meta.dirname, "..", "..", ".ccrc-allowed-signers");
  const lines = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"));
  assert.ok(lines.length > 0);
  for (const line of lines) assert.match(line, /^\S+@\S+ namespaces="git" ssh-ed25519 [A-Za-z0-9+/]+=*$/);
  if (spawnSync("ssh-keygen", ["-?"]).error) return t.skip("no ssh-keygen");
  for (const line of lines) {
    const r = spawnSync("ssh-keygen", ["-l", "-f", "-"], { input: line.split(" ").slice(2).join(" "), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
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
  // This checkout's own version (git describe) decides whether v0.7.1 is news to it.
  const mine = brokerVersion({ root: path.join(import.meta.dirname, "..", "..") });
  if (isNewer("v0.7.1", mine)) assert.match(ccrc("status").stdout, /^update: {6}v0\.7\.1 available \(seen .*\); run: ccrc update$/m, `${mine} is behind v0.7.1`);
  else assert.match(ccrc("status").stdout, /^update: {6}none \(latest v0\.7\.1, seen /m, `${mine} is not behind v0.7.1`);
  fs.writeFileSync(path.join(env.CCRC_CONFIG_DIR, "config.json"), JSON.stringify({ schemaVersion: 1, brokerSessions: "off", updateCheck: false }));
  assert.match(ccrc("status").stdout, /^update: {6}not looked for \(updateCheck is false\)$/m);
});

test("a command past its time limit is given up on even when a helper it started holds its output open", async () => {
  const started = Date.now();
  const r = await run("bash", ["-c", "sleep 5 & exec sleep 5"], { timeoutMs: 200 });
  assert.equal(r.code, 124);
  assert.match(r.stderr, /timed out after 200 ms/);
  assert.ok(Date.now() - started < 4000, `took ${Date.now() - started} ms`);
});

test("history is written before the restart, and a failed switch also removes files the migrate step made", async () => {
  const repo = makeRepo();
  const w = installed(repo);
  w.broken = "v0.7.1";
  const runner = w.deps.runner!;
  let seenAtRestart: HistoryEntry[] | undefined;
  w.deps.runner = async (cmd, args, o) => {
    if (cmd === "systemctl" && args.includes("restart") && !seenAtRestart) seenAtRestart = history(w);
    const r = await runner(cmd, args, o);
    if (args[0] === "migrate") fs.writeFileSync(path.join(w.configDir, "made-by-migrate.json"), "{}\n");
    return r;
  };
  assert.equal(await update({ yes: true }, w.deps), EXIT_ROLLED_BACK, output(w));
  assert.deepEqual(
    seenAtRestart?.map((h) => [h.from, h.to, h.failed]),
    [["v0.7.0", "v0.7.1", undefined]],
    "a run that dies during the restart still leaves the way back",
  );
  assert.equal(history(w).length, 1, "the same entry is marked failed");
  assert.match(history(w)[0].failed!, /did not answer/);
  assert.equal(fs.existsSync(path.join(w.configDir, "made-by-migrate.json")), false);
  assert.equal(current(w), path.join("versions", "v0.7.0"));
});

test("a migrate step that fails after making files leaves none of them", async () => {
  const repo = makeRepo();
  const w = installed(repo);
  const before = fs.readFileSync(path.join(w.configDir, "config.json"), "utf8");
  const runner = w.deps.runner!;
  w.deps.runner = async (cmd, args, o) => {
    if (args[0] === "migrate") {
      fs.writeFileSync(path.join(w.configDir, "config.json"), "{}\n");
      fs.writeFileSync(path.join(w.stateDir, "half.json"), "{}\n");
      return { code: 1, stdout: "", stderr: "disk full" };
    }
    return runner(cmd, args, o);
  };
  assert.equal(await update({ yes: true }, w.deps), 1);
  assert.match(output(w), /could not migrate the config: disk full\. Nothing was switched/);
  assert.equal(fs.readFileSync(path.join(w.configDir, "config.json"), "utf8"), before);
  assert.equal(fs.existsSync(path.join(w.stateDir, "half.json")), false);
  assert.equal(current(w), path.join("versions", "v0.7.0"));
});

test("a rollback whose restart fails says the service is broken, not that nothing switched", async () => {
  const repo = makeRepo();
  const w = installed(repo);
  assert.equal(await update({ yes: true }, w.deps), 0);
  const runner = w.deps.runner!;
  w.deps.runner = async (cmd, args, o) =>
    cmd === "systemctl" && args.includes("restart") ? { code: 1, stdout: "", stderr: "Failed to restart ccrc.service" } : runner(cmd, args, o);
  w.lines.length = 0;
  assert.equal(await rollback({ yes: true }, w.deps), EXIT_BROKEN, output(w));
  assert.equal(current(w), path.join("versions", "v0.7.0"));
  assert.match(output(w), /Failed to restart ccrc\.service/);
});

test("an install whose folder is not named as its version is linked back to and kept", async () => {
  const repo = makeRepo();
  const w = installed(repo);
  fs.renameSync(w.root, path.join(w.dataDir, "versions", "first"));
  fs.rmSync(path.join(w.dataDir, "current"));
  fs.symlinkSync(path.join("versions", "first"), path.join(w.dataDir, "current"));
  w.deps.codeRoot = path.join(w.dataDir, "versions", "first");
  w.broken = "v0.7.1";
  assert.equal(await update({ yes: true }, w.deps), EXIT_ROLLED_BACK, output(w));
  assert.equal(current(w), path.join("versions", "first"));
  assert.equal(w.running, "v0.7.0");

  w.broken = undefined;
  assert.equal(await update({ yes: true }, w.deps), 0, output(w));
  assert.deepEqual(versions(w), ["first", "v0.7.1"], "the version before stays under its own name");
  assert.equal(await rollback({ yes: true }, w.deps), 0, output(w));
  assert.equal(current(w), path.join("versions", "first"));
});

test("a copy made with --from is not taken for the release of the same name", async () => {
  const repo = makeRepo();
  const w = installed(repo);
  assert.equal(await update({ yes: true, from: `${repo.work}@v0.7.1` }, w.deps), 0, output(w));
  assert.equal(readInstallInfo(path.join(w.dataDir, "versions", "v0.7.1"))!.source, repo.work);
  assert.equal(await rollback({ yes: true }, w.deps), 0, output(w));
  w.calls.length = 0;
  assert.equal(await update({ yes: true }, w.deps), 0, output(w));
  assert.ok(w.calls.some((c) => c.startsWith("git -c advice.detachedHead=false clone")), "fetched again from the install's source");
  assert.equal(readInstallInfo(path.join(w.dataDir, "versions", "v0.7.1"))!.source, repo.bare);
});

test("a wrapped breaking item is one line", () => {
  const text = `## [0.9.0] - 2026-11-01

### Breaking

- The wrapper now needs Node.js 22.18.
  Without one it runs Claude Code directly.
- Another change.

### Added

- Not breaking.
  Still not.
`;
  assert.deepEqual(changelogSections(text, "v0.9.0", "v0.8.0")[0].breaking, ["- The wrapper now needs Node.js 22.18. Without one it runs Claude Code directly.", "- Another change."]);
});

test("update, rollback and update --from refuse to run inside ccrc.service, which their restart would stop", async () => {
  const repo = makeRepo();
  const w = installed(repo);
  const deps = { ...w.deps, inService: () => true };
  assert.equal(await update({ yes: true }, deps), 1);
  assert.equal(await update({ yes: true, from: repo.work }, deps), 1);
  assert.equal(await rollback({ yes: true }, deps), 1);
  assert.match(output(w), /ccrc update restarts or stops ccrc\.service, and this runs inside it/);
  assert.match(output(w), /ccrc rollback restarts or stops ccrc\.service/);
  assert.equal(w.restarts, 0);
  assert.equal(current(w), path.join("versions", "v0.7.0"));
  w.lines.length = 0;
  assert.equal(await update({ check: true }, deps), 0, "--check only looks");
});

test("rollback restores only what the migrate step reports, not state the running broker wrote meanwhile", async () => {
  const repo = makeRepo();
  const w = installed(repo);
  fs.writeFileSync(path.join(w.configDir, "state.json"), '{"lease":"old"}\n');
  const runner = w.deps.runner!;
  w.deps.runner = async (cmd, args, o) => {
    if (args[0] === "migrate") {
      assert.deepEqual(args, ["migrate", "--json"]);
      // The broker renews its login lease while the new version migrates.
      fs.writeFileSync(path.join(w.configDir, "state.json"), '{"lease":"renewed"}\n');
      const r = await runner(cmd, ["migrate"], o);
      return { ...r, stdout: JSON.stringify({ changed: ["config/config.json"], message: "Config moved from format 1 to 1" }) + "\n" };
    }
    return runner(cmd, args, o);
  };
  assert.equal(await update({ yes: true }, w.deps), 0, output(w));
  assert.match(output(w), /Config moved from format 1 to 1/);
  const manifest = JSON.parse(fs.readFileSync(path.join(history(w).at(-1)!.backupDir!, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.migrated, ["config/config.json"]);
  fs.writeFileSync(path.join(w.configDir, "state.json"), '{"lease":"later"}\n');
  assert.equal(await rollback({ yes: true }, w.deps), 0, output(w));
  assert.equal(fs.readFileSync(path.join(w.configDir, "state.json"), "utf8"), '{"lease":"later"}\n', "the password and login state stay as they are now");
  assert.equal(config(w).migratedTo, undefined);
});

test("old update and rollback backups go, those the last history entries name stay", async () => {
  const repo = makeRepo();
  const w = installed(repo);
  const backups = path.join(w.stateDir, "backup");
  fs.mkdirSync(backups, { recursive: true });
  for (const name of ["update-v0.5.0-v0.6.0-20260101T000000Z", "rollback-v0.6.0-v0.5.0-20260102T000000Z", "update-v0.5.0-v0.6.0-20260103T000000Z", "migrate-0-1-20260101T000000Z"]) {
    fs.mkdirSync(path.join(backups, name));
  }
  assert.equal(await update({ yes: true, to: "v0.7.1" }, w.deps), 0, output(w));
  assert.equal(await rollback({ yes: true }, w.deps), 0, output(w));
  assert.equal(await update({ yes: true, to: "v0.7.1" }, w.deps), 0, output(w));
  const left = fs.readdirSync(backups).sort();
  assert.ok(left.includes("migrate-0-1-20260101T000000Z"), "other backups are left");
  assert.ok(!left.includes("update-v0.5.0-v0.6.0-20260101T000000Z"));
  assert.ok(!left.includes("rollback-v0.6.0-v0.5.0-20260102T000000Z"));
  for (const h of history(w)) assert.ok(fs.existsSync(h.backupDir!), h.backupDir);
});
