import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { brokerVersion, installKind, isInstalled, readInstallInfo, writeInstallInfo } from "../src/install.ts";
import { paths } from "../src/paths.ts";
import { tempDir } from "./helpers.ts";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const INFO = { version: "v0.7.0", commit: "0123456789abcdef", source: "https://example.com/ccrc.git", node: "/home/user/.local/share/ccrc/node/bin/node", installedAt: "2026-10-17T00:00:00Z" };

// A version folder of an install under a data folder of its own.
function install(version = "v0.7.0"): { dataDir: string; root: string } {
  const dataDir = tempDir();
  const root = path.join(dataDir, "versions", version);
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "ccrc", version: "0.7.0" }));
  writeInstallInfo(root, { ...INFO, version });
  fs.symlinkSync(path.join("versions", version), path.join(dataDir, "current"));
  return { dataDir, root };
}

test("every folder comes from the environment, read when asked", () => {
  const saved = { ...process.env };
  try {
    process.env.HOME = "/home/user";
    for (const k of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "CCRC_CONFIG_DIR", "CCRC_STATE_DIR", "CCRC_DATA_DIR", "CLAUDE_CONFIG_DIR", "CCRC_VSCODE_EXTENSIONS_DIR"]) delete process.env[k];
    assert.deepEqual(
      [paths.configDir, paths.stateDir, paths.dataDir, paths.claudeConfigDir, paths.claudeProjectsDir, paths.vscodeUserDir, paths.vscodeExtensionsDir, paths.apiKeyFile],
      [
        "/home/user/.config/ccrc",
        "/home/user/.local/state/ccrc",
        "/home/user/.local/share/ccrc",
        "/home/user/.claude",
        "/home/user/.claude/projects",
        "/home/user/.config/Code",
        "/home/user/.vscode/extensions",
        "/home/user/.config/ccrc/anthropic-api-key",
      ],
    );
    Object.assign(process.env, { XDG_DATA_HOME: "/data", XDG_CONFIG_HOME: "/cfg", CLAUDE_CONFIG_DIR: "/claude", CCRC_VSCODE_EXTENSIONS_DIR: "/ext" });
    assert.deepEqual([paths.dataDir, paths.configDir, paths.claudeSessionsDir, paths.vscodeUserDir, paths.vscodeExtensionsDir], ["/data/ccrc", "/cfg/ccrc", "/claude/sessions", "/cfg/Code", "/ext"]);
    process.env.CCRC_DATA_DIR = "/opt/ccrc";
    assert.equal(paths.dataDir, "/opt/ccrc");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("a version folder of an install is told apart from a checkout and a plain copy", () => {
  const { dataDir, root } = install();
  assert.equal(isInstalled(root, dataDir), true);
  assert.equal(isInstalled(path.join(dataDir, "current"), dataDir), true, "through the current link too");
  assert.deepEqual(readInstallInfo(root), INFO);
  assert.equal(installKind(root, dataDir), "installed");
  assert.equal(installKind(root, tempDir()), "git", "a version folder of another data folder is a checkout");
  fs.rmSync(path.join(root, ".ccrc-install.json"));
  assert.equal(isInstalled(root, dataDir), false, "no install info, no install");
  const plain = tempDir();
  assert.equal(installKind(plain, dataDir), "plain");
  fs.writeFileSync(path.join(plain, ".ccrc-install.json"), "{not json");
  assert.equal(readInstallInfo(plain), undefined);
  fs.writeFileSync(path.join(plain, ".ccrc-install.json"), JSON.stringify({ commit: "x" }));
  assert.equal(readInstallInfo(plain), undefined, "an install info without a version");
});

test("the version is the install's, else what git says, else package.json's", () => {
  const { dataDir, root } = install("v0.7.1");
  const git = () => "v0.7.0-3-g0123456";
  assert.equal(brokerVersion({ root, dataDir, git }), "v0.7.1");
  assert.equal(brokerVersion({ root, dataDir: tempDir(), git }), "v0.7.0-3-g0123456");
  assert.equal(brokerVersion({ root, dataDir: tempDir(), git: () => undefined }), "0.7.0", "git without an answer");
  fs.rmSync(path.join(root, ".git"), { recursive: true });
  assert.equal(brokerVersion({ root, dataDir: tempDir(), git }), "0.7.0");
  assert.match(brokerVersion() ?? "", /^(?:v?\d+\.\d+\.\d+\S*|[0-9a-f]{7,}(?:-dirty)?)$/, "this copy");
});

// bin/ccrc run with a PATH of its own.
function runCcrc(env: Record<string, string>, args: string[]) {
  return spawnSync(path.join(REPO, "bin", "ccrc"), args, { env: { PATH: "/usr/bin:/bin", HOME: tempDir(), ...env }, encoding: "utf8" });
}

// A Node that logs how it was called; a too old one fails the version check bin/ccrc runs with -e.
function fakeNode(dir: string, name: string, log: string, tooOld = false): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\necho "$0" >> "${log}"\n${tooOld ? '[ "$1" = -e ] && exit 1\n' : ""}exec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  return file;
}

test("bin/ccrc takes the first Node 22.18 or newer of CCRC_NODE, the install's own, the install info's and PATH's", () => {
  const dir = tempDir();
  const log = path.join(dir, "used");
  const old = fakeNode(dir, "node-22.17", log, true);
  const good = fakeNode(dir, "node-22.18", log);
  const dataDir = tempDir();
  fs.mkdirSync(path.join(dataDir, "node", "bin"), { recursive: true });
  fs.symlinkSync(good, path.join(dataDir, "node", "bin", "node"));
  const r = runCcrc({ CCRC_NODE: old, CCRC_DATA_DIR: dataDir }, ["version"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ccrc \S+ \((?:development checkout|unpacked copy)\)\n$/);
  assert.equal(fs.readFileSync(log, "utf8").split("\n").filter(Boolean).at(-1), path.join(dataDir, "node", "bin", "node"), "the old CCRC_NODE is passed over");
  const none = runCcrc({ CCRC_NODE: old, CCRC_DATA_DIR: tempDir() }, ["version"]);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /needs Node\.js 22\.18 or newer/);
});

test("an install's bin/ccrc falls back on the Node its install info names; the wrapper without a Node runs Claude Code directly", () => {
  const dir = tempDir();
  const log = path.join(dir, "used");
  const old = fakeNode(dir, "node-22.17", log, true);
  const good = fakeNode(dir, "node-22.18", log);
  const root = tempDir();
  fs.mkdirSync(path.join(root, "bin"));
  for (const f of ["ccrc", "ccrc-wrapper"]) fs.copyFileSync(path.join(REPO, "bin", f), path.join(root, "bin", f));
  fs.symlinkSync(path.join(REPO, "broker"), path.join(root, "broker"));
  writeInstallInfo(root, { ...INFO, node: good });
  const env = { PATH: "/usr/bin:/bin", HOME: tempDir(), CCRC_NODE: old, CCRC_DATA_DIR: tempDir() };
  const r = spawnSync(path.join(root, "bin", "ccrc"), ["version"], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(log, "utf8").split("\n").filter(Boolean).at(-1), good);
  fs.rmSync(path.join(root, ".ccrc-install.json"));
  const direct = spawnSync(path.join(root, "bin", "ccrc-wrapper"), ["/bin/echo", "--input-format", "stream-json", "hi"], { env, encoding: "utf8" });
  assert.equal(direct.stdout, "--input-format stream-json hi\n");
});

test("ccrc config sets keys as the broker reads them, refuses wrong types, and keeps the API key out of sight", () => {
  const home = tempDir();
  const env = { CCRC_NODE: process.execPath, CCRC_CONFIG_DIR: path.join(home, "config"), CCRC_STATE_DIR: path.join(home, "state") };
  const file = path.join(home, "config", "config.json");
  assert.equal(runCcrc(env, ["config", "path"]).stdout, `${file}\n`);
  assert.equal(JSON.parse(runCcrc(env, ["config", "get"]).stdout).brokerSessions, "off", "a new install's defaults");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ port: 8737, allowedDevices: [] }));
  assert.equal(runCcrc(env, ["config", "get", "brokerSessions"]).stdout, '"subscription"\n', "a 0.6 file");
  const set = runCcrc(env, ["config", "set", "allowedDevices", '["phone"]']);
  assert.equal(set.status, 0, set.stderr);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(saved, { port: 8737, allowedDevices: ["phone"], brokerSessions: "subscription", schemaVersion: 1 }, "migrated first, then set");
  assert.equal(fs.readdirSync(path.join(home, "state", "backup")).length, 1);
  assert.equal(runCcrc(env, ["config", "set", "claudePath", "/opt/claude/bin/claude"]).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).claudePath, "/opt/claude/bin/claude", "a value that is not JSON is a string");
  const wrong = runCcrc(env, ["config", "set", "port", "high"]);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /"port" must be a whole number from 0 \(any free port\) to 65535, not "high"/);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).port, 8737);
  assert.match(runCcrc(env, ["config", "set", "allowedDevice", "[]"]).stderr, /unknown key "allowedDevice"/);
  const key = spawnSync(path.join(REPO, "bin", "ccrc"), ["config", "set-api-key"], { env: { PATH: "/usr/bin:/bin", HOME: home, ...env }, input: "sk-ant-secret\n", encoding: "utf8" });
  assert.equal(key.status, 0, key.stderr);
  assert.doesNotMatch(key.stdout + key.stderr, /sk-ant-secret/);
  const keyFile = path.join(home, "config", "anthropic-api-key");
  assert.equal(fs.readFileSync(keyFile, "utf8"), "sk-ant-secret\n");
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.equal(runCcrc(env, ["config", "set", "brokerSessions", "apiKey"]).status, 0);
  const status = runCcrc(env, ["status"]).stdout;
  assert.match(status, /broker sessions: apiKey \(key set\)/);
  assert.doesNotMatch(status, /sk-ant-secret/);
});

test("ccrc migrate brings an old config to this format once", () => {
  const home = tempDir();
  const env = { CCRC_NODE: process.execPath, CCRC_CONFIG_DIR: path.join(home, "config"), CCRC_STATE_DIR: path.join(home, "state") };
  assert.match(runCcrc(env, ["migrate"]).stdout, /No config yet/);
  fs.mkdirSync(path.join(home, "config"));
  fs.writeFileSync(path.join(home, "config", "config.json"), "{}");
  assert.match(runCcrc(env, ["migrate"]).stdout, /from format 0 to 1/);
  assert.match(runCcrc(env, ["migrate"]).stdout, /already of format 1/);
  fs.writeFileSync(path.join(home, "config", "config.json"), JSON.stringify({ schemaVersion: 99 }));
  const newer = runCcrc(env, ["serve"]);
  assert.equal(newer.status, 1);
  assert.match(newer.stderr, /newer than this ccrc knows.*ccrc update.*ccrc rollback/s);
  assert.equal(execFileSync("cat", [path.join(home, "config", "config.json")], { encoding: "utf8" }), JSON.stringify({ schemaVersion: 99 }));
});
