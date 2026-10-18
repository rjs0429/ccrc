import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { CliChoice } from "../src/claude-cli.ts";
import { Doctor, type DoctorOptions } from "../src/doctor.ts";
import { tempDir } from "./helpers.ts";

const FAKE = new URL("./fixtures/fake-claude.mjs", import.meta.url).pathname;
const WRAPPER = new URL("../../bin/ccrc-wrapper", import.meta.url).pathname;

// Adds Claude Code extension folders whose bundled Claude Code is the fake.
function addExtensions(dir: string, versions: string[], platform = "linux-x64"): string {
  for (const v of versions) {
    const bin = path.join(dir, `anthropic.claude-code-${v}-${platform}`, "resources", "native-binary");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  }
  return dir;
}

function setup(o: Partial<DoctorOptions> = {}) {
  const stateDir = tempDir();
  const extensionsDir = addExtensions(tempDir(), ["2.1.9", "2.1.296", "2.1.30"]);
  const doctor = new Doctor({ stateDir, extensionsDir, vscodeDir: tempDir(), platform: "linux-x64", stepTimeoutMs: 10_000, ...o });
  return { doctor, stateDir, extensionsDir };
}

test("picks the newest extension for this platform that VS Code keeps", () => {
  const { doctor, extensionsDir } = setup();
  addExtensions(extensionsDir, ["3.0.0"], "darwin-arm64");
  fs.mkdirSync(path.join(extensionsDir, "anthropic.claude-code-9.9.9-linux-x64.backup"));
  assert.equal(doctor.extension()?.version, "2.1.296");
  fs.writeFileSync(path.join(extensionsDir, ".obsolete"), JSON.stringify({ "anthropic.claude-code-2.1.296-linux-x64": true }));
  assert.equal(doctor.extension()?.version, "2.1.30");
  assert.equal(new Doctor({ extensionsDir: path.join(tempDir(), "none") }).extension(), undefined);
});

test("passes when Claude Code answers through the wrapper and exits cleanly", async () => {
  const { doctor, stateDir } = setup();
  const result = await doctor.run();
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.deepEqual(
    result.checks.map((c) => [c.name, c.ok]),
    [
      ["extension", true],
      ["cli", true],
      ["initialize", true],
      ["context", true],
      ["exit", true],
    ],
  );
  assert.equal(result.checks[2].detail, "1 models, 8 commands");
  assert.equal(result.extensionVersion, "2.1.296");
  assert.equal(result.cliVersion, "2.1.296");
  // git describe of a checkout (a release tag and what came after it, or the commit before any tag), else package.json's.
  assert.match(result.brokerVersion ?? "", /^(?:v?\d+\.\d+\.\d+\S*|[0-9a-f]{7,}(?:-dirty)?)$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, "doctor.json"), "utf8")), result);
  assert.match(fs.readFileSync(path.join(stateDir, "doctor", "wrapper.log"), "utf8"), /not connecting/);
  const info = await doctor.info();
  assert.deepEqual(info.last, result);
  assert.equal(info.cliVersion, "2.1.296");
  assert.equal(info.running, false);
  assert.deepEqual(new Doctor({ stateDir }).last(), result, "the result outlives the broker");
});

test("fails when initialize gets no answer", async () => {
  const { doctor } = setup({ env: { FAKE_NO_INIT: "1" }, stepTimeoutMs: 1500 });
  const result = await doctor.run();
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.checks.slice(2).map((c) => [c.name, c.ok, c.detail]),
    [
      ["initialize", false, "no answer"],
      ["exit", true, undefined],
    ],
  );
});

test("fails without starting anything when no extension is installed", async () => {
  const doctor = new Doctor({ stateDir: tempDir(), extensionsDir: tempDir(), wrapper: "/nonexistent" });
  const result = await doctor.run();
  assert.deepEqual(result.checks, [{ name: "extension", ok: false, detail: "not found" }]);
  assert.equal(result.ok, false);
});

test("a wrapper that cannot start fails the check", async () => {
  const { doctor } = setup({ wrapper: path.join(tempDir(), "missing-wrapper") });
  const result = await doctor.run();
  assert.equal(result.ok, false);
  assert.deepEqual(result.checks.find((c) => c.name === "initialize"), { name: "initialize", ok: false, detail: "no answer" });
  assert.match(result.checks.find((c) => c.name === "exit")?.detail ?? "", /^cannot start: /);
});

test("checks again only when the extension or the broker changed, or the last check failed", async () => {
  const { doctor, extensionsDir, stateDir } = setup();
  assert.equal((await doctor.checkIfDue())?.ok, true);
  assert.equal(await doctor.checkIfDue(), undefined);
  addExtensions(extensionsDir, ["2.1.300"]);
  assert.equal((await doctor.checkIfDue())?.extensionVersion, "2.1.300");
  assert.equal(await doctor.checkIfDue(), undefined);

  const stale = JSON.parse(fs.readFileSync(path.join(stateDir, "doctor.json"), "utf8"));
  fs.writeFileSync(path.join(stateDir, "doctor.json"), JSON.stringify({ ...stale, brokerVersion: "0000000" }));
  assert.ok(await new Doctor({ stateDir, extensionsDir, stepTimeoutMs: 10_000 }).checkIfDue(), "after a broker update");
  fs.writeFileSync(path.join(stateDir, "doctor.json"), JSON.stringify({ ...stale, extensionVersion: "2.1.300", ok: false }));
  assert.ok(await new Doctor({ stateDir, extensionsDir, stepTimeoutMs: 10_000 }).checkIfDue(), "after a failed check");
});

test("names the Claude Code broker sessions run, and warns without failing when it is too old to send files", async () => {
  let cli: CliChoice = { source: "vscode", path: FAKE, version: "2.1.300" };
  const { doctor, extensionsDir } = setup({ brokerCli: () => cli });
  const ok = await doctor.run();
  assert.deepEqual(ok.checks.at(-1), { name: "broker_cli", ok: true, detail: "2.1.300 vscode" });
  assert.equal(ok.brokerCli, "2.1.300 vscode");
  assert.deepEqual((await doctor.info()).brokerCli, { source: "vscode", version: "2.1.300", path: FAKE });
  assert.equal(await doctor.checkIfDue(), undefined);
  cli = { source: "global", path: FAKE, version: "2.1.296" };
  const old = await doctor.checkIfDue();
  assert.ok(old, "checked again once broker sessions run another Claude Code");
  assert.deepEqual(old.checks.at(-1), { name: "broker_cli", ok: true, warn: true, detail: "2.1.296 global" });
  assert.equal(old.ok, true);
  cli = { source: "config", path: path.join(extensionsDir, "anthropic.claude-code-2.1.296-linux-x64", "resources", "native-binary", "claude") };
  assert.equal((await doctor.run()).checks.at(-1)?.detail, "2.1.296 config", "the version Claude Code gives when its path does not say");
  cli = { source: "config", path: path.join(extensionsDir, "missing", "claude") };
  const gone = await doctor.run();
  assert.deepEqual(gone.checks.at(-1), { name: "broker_cli", ok: false, detail: "missing config" });
  assert.equal(gone.ok, false);
  assert.deepEqual((await new Doctor({ extensionsDir: tempDir() }).info()).brokerCli, undefined);
});

test("runs one check at a time", async () => {
  const { doctor } = setup();
  const [a, b] = [doctor.run(), doctor.run()];
  assert.equal(a, b);
  assert.equal((await doctor.info()).running, true);
  await a;
  assert.equal((await doctor.info()).running, false);
});

test("reads VS Code's wrapper setting without changing it", () => {
  const vscodeDir = tempDir();
  const file = path.join(vscodeDir, "User", "settings.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const doctor = new Doctor({ vscodeDir, wrapper: WRAPPER });
  assert.deepEqual(doctor.wrapperSetting(), { path: undefined, on: false, thisBroker: false });

  const write = (s: Record<string, unknown>) => fs.writeFileSync(file, `{\n  // VS Code settings\n${JSON.stringify(s).slice(1, -1)},\n}\n`);
  write({ "claudeCode.claudeProcessWrapper": WRAPPER });
  assert.deepEqual(doctor.wrapperSetting(), { path: WRAPPER, on: true, thisBroker: true });
  write({ "claudeCode.claudeProcessWrapper": "/opt/other/ccrc-wrapper", "claudeCode.environmentVariables": [{ name: "CCRC_WRAPPER", value: "off" }] });
  assert.deepEqual(doctor.wrapperSetting(), { path: "/opt/other/ccrc-wrapper", on: false, thisBroker: false });
  const before = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, "{ not json");
  assert.deepEqual(doctor.wrapperSetting(), { on: false, thisBroker: false, unreadable: true });
  fs.writeFileSync(file, before);
  doctor.wrapperSetting();
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("start checks after its delay and close stops it", async () => {
  const { doctor, stateDir } = setup({ startDelayMs: 0 });
  doctor.start();
  for (let i = 0; i < 100 && !fs.existsSync(path.join(stateDir, "doctor.json")); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(doctor.last()?.ok, true);
  doctor.close();
});
