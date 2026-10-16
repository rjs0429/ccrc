import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The manager reads ~/.claude and ~/.vscode and starts the fake CLI, which records what it was asked.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccrc-home-"));
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
process.env.CCRC_STATE_DIR = path.join(home, "state");
const requests = path.join(home, "requests.jsonl");
process.env.FAKE_REQUESTS = requests;
fs.mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });
after(() => fs.rmSync(home, { recursive: true, force: true }));

const { ClaudeCli, extensionFolders, versionBelow } = await import("../src/claude-cli.ts");
const { SessionManager } = await import("../src/sessions/manager.ts");

const FAKE = new URL("./fixtures/fake-claude.mjs", import.meta.url).pathname;
const PLATFORM = `${process.platform}-${process.arch}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A Claude Code that answers --version with its version and otherwise runs the fake.
function claude(file: string, version: string, mode = 0o755): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n[ "$1" = "--version" ] && { echo "${version} (Claude Code)"; exit 0; }\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode });
  return file;
}

function extension(dir: string, version: string, platform = PLATFORM, mode = 0o755): string {
  return claude(path.join(dir, `anthropic.claude-code-${version}-${platform}`, "resources", "native-binary", "claude"), version, mode);
}

function setup() {
  const root = fs.mkdtempSync(path.join(home, "cli-"));
  const o = { extensionsDir: path.join(root, "extensions"), platform: PLATFORM, global: path.join(root, "bin", "claude"), linkDir: path.join(root, "links") };
  return { root, ...o, cli: (setting?: string) => new ClaudeCli({ ...o, setting }) };
}

test("follows the newest VS Code extension whose Claude Code can run, else the global install, else the SDK's", () => {
  const { root, extensionsDir, global, cli } = setup();
  const sdk = cli().peek();
  assert.equal(sdk.source, "sdk");
  assert.equal(sdk.path, undefined);
  assert.match(sdk.version ?? "", /^\d+\.\d+\.\d+$/, "the version the SDK bundles");
  fs.mkdirSync(path.dirname(global), { recursive: true });
  fs.symlinkSync(claude(path.join(root, "versions", "2.1.296"), "2.1.296"), global);
  assert.deepEqual(cli().peek(), { source: "global", path: global, version: "2.1.296" });
  extension(extensionsDir, "2.1.9");
  const newest = extension(extensionsDir, "2.1.300");
  extension(extensionsDir, "2.1.30");
  extension(extensionsDir, "9.9.9", "darwin-arm64");
  extension(extensionsDir, "2.1.301", PLATFORM, 0o644);
  fs.mkdirSync(path.join(extensionsDir, `anthropic.claude-code-2.1.400-${PLATFORM}`));
  assert.deepEqual(cli().peek(), { source: "vscode", path: newest, version: "2.1.300" });
  assert.deepEqual(cli("vscode").peek(), cli().peek());
  assert.deepEqual(cli("  ").peek(), cli().peek());
  fs.writeFileSync(path.join(extensionsDir, ".obsolete"), JSON.stringify({ [`anthropic.claude-code-2.1.300-${PLATFORM}`]: true }));
  assert.equal(cli().peek().version, "2.1.30", "not a version VS Code is about to remove");
  assert.deepEqual(
    extensionFolders(extensionsDir, PLATFORM).map((f) => f.version),
    ["2.1.400", "2.1.301", "2.1.30", "2.1.9"],
  );
  const set = cli("/opt/claude/bin/claude").peek();
  assert.equal(set.source, "config", "an explicit path wins");
  assert.equal(set.path, "/opt/claude/bin/claude");
});

test("versions compare by number, and an unknown one counts as older", () => {
  assert.equal(versionBelow("2.1.296", "2.1.300"), true);
  assert.equal(versionBelow("2.1.300", "2.1.300"), false);
  assert.equal(versionBelow("2.1.300-beta.1", "2.1.300"), false);
  assert.equal(versionBelow("2.2.0", "2.1.300"), false);
  assert.equal(versionBelow("10.0.0", "2.1.300"), false);
  assert.equal(versionBelow(undefined, "2.1.300"), true);
  assert.equal(versionBelow("next", "2.1.300"), true);
});

test("a session runs VS Code's Claude Code from a link that outlives the extension folder", async () => {
  const { extensionsDir, linkDir, cli } = setup();
  const original = extension(extensionsDir, "2.1.300");
  const c = cli();
  const first = await c.choose();
  assert.deepEqual(first, { source: "vscode", path: path.join(linkDir, "2.1.300", "claude"), from: original, version: "2.1.300" });
  assert.equal(fs.statSync(first.path!).ino, fs.statSync(original).ino, "a hard link while VS Code keeps its file");
  assert.deepEqual(await Promise.all([c.choose(), c.choose()]), [first, first], "the same link for every session of that version");
  fs.rmSync(path.dirname(path.dirname(path.dirname(original))), { recursive: true });
  assert.equal(execFileSync(first.path!, ["--version"], { encoding: "utf8" }).trim(), "2.1.300 (Claude Code)", "still runs once VS Code removed it");
  extension(extensionsDir, "2.1.301");
  fs.writeFileSync(path.join(linkDir, "notes.txt"), "not ours to remove");
  const second = await c.choose();
  assert.equal(second.version, "2.1.301");
  assert.ok(fs.existsSync(first.path!), "a link handed out moments ago stays, its session may be starting");
  const later = cli();
  await later.choose([first.path]);
  assert.ok(fs.existsSync(first.path!), "a link a running session uses stays");
  await later.choose([]);
  assert.ok(!fs.existsSync(path.join(linkDir, "2.1.300")), "a link nothing uses goes");
  assert.ok(fs.existsSync(second.path!) && fs.existsSync(path.join(linkDir, "notes.txt")));
});

test("across file systems the link is a copy", async (t) => {
  const shm = "/dev/shm";
  if (!fs.existsSync(shm) || fs.statSync(shm).dev === fs.statSync(home).dev) return t.skip("no second file system");
  const { extensionsDir, global } = setup();
  const original = extension(extensionsDir, "2.1.300");
  const linkDir = fs.mkdtempSync(path.join(shm, "ccrc-test-"));
  t.after(() => fs.rmSync(linkDir, { recursive: true, force: true }));
  const got = await new ClaudeCli({ extensionsDir, platform: PLATFORM, global, linkDir }).choose();
  assert.equal(got.path, path.join(linkDir, "2.1.300", "claude"));
  assert.notEqual(fs.statSync(got.path!).ino, fs.statSync(original).ino);
  assert.equal(execFileSync(got.path!, ["--version"], { encoding: "utf8" }).trim(), "2.1.300 (Claude Code)");
});

test("broker sessions start the Claude Code VS Code bundles, say which, and keep it when VS Code removes it", async (t) => {
  const cwd = path.join(home, "work");
  fs.mkdirSync(cwd, { recursive: true });
  const original = extension(path.join(home, ".vscode", "extensions"), "2.1.300");
  const manager = new SessionManager({ host: "127.0.0.1", port: 0, allowedDevices: [], allowLocal: true, claudePath: "vscode", roots: [cwd], leaseIdleMinutes: 1, sessionIdleMinutes: 1 });
  t.after(() => manager.closeAll());
  manager.windowProbe = async () => undefined;
  const told: string[] = [];
  manager.cliLog = (line) => told.push(line);
  const said = (text: string) => fs.existsSync(requests) && fs.readFileSync(requests, "utf8").includes(`"user":"${text}"`);
  const s = await manager.create(cwd, {});
  const link = path.join(home, "state", "cli", "2.1.300", "claude");
  assert.equal(s.claudePath, link);
  assert.deepEqual(told, [`ccrc: session ${s.id} starts Claude Code 2.1.300 (vscode) ${link} from ${original}`]);
  s.send("before");
  for (let i = 0; i < 100 && !said("before"); i++) await sleep(20);
  fs.rmSync(path.join(home, ".vscode"), { recursive: true });
  s.send("after");
  for (let i = 0; i < 100 && !said("after"); i++) await sleep(20);
  assert.ok(said("after"), "the running session goes on");
  assert.equal(manager.cli.peek().source, "sdk", "the next start finds nothing of VS Code's");
});
