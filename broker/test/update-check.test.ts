import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { applyConfig, LIVE_KEYS } from "../src/config-watch.ts";
import { ConfigError, checkConfig, newConfig, readConfig, type Config } from "../src/config.ts";
import type { Runner } from "../src/run.ts";
import { UpdateCheck, readUpdateCheck } from "../src/update-check.ts";
import { updateStatus } from "../src/update.ts";
import { tempDir } from "./helpers.ts";

const SHA = "0".repeat(40);
const lsRemote = (...tags: string[]) => tags.map((t) => `${SHA}\trefs/tags/${t}`).join("\n") + "\n";

function setup(o: { tags?: string[]; version?: string; source?: string; kind?: "installed" | "git" } = {}) {
  const stateDir = tempDir();
  const file = path.join(stateDir, "update-check.json");
  const config: Pick<Config, "updateCheck" | "updateChannel" | "updateRepo" | "updateNotify"> = { updateCheck: true, updateChannel: "stable", updateNotify: true };
  const asked: string[][] = [];
  let tags = o.tags ?? ["v0.7.0", "v0.7.1", "v0.8.0-rc.1"];
  let fail: string | undefined;
  const runner: Runner = async (cmd, args) => {
    asked.push([cmd, ...args]);
    return fail ? { code: 128, stdout: "", stderr: `fatal: ${fail}\n` } : { code: 0, stdout: lsRemote(...tags), stderr: "" };
  };
  const notified: string[] = [];
  let reach = true;
  const lines: string[] = [];
  const check = new UpdateCheck({
    config,
    version: () => o.version ?? "v0.7.0",
    kind: () => o.kind ?? "installed",
    installSource: () => o.source,
    file,
    runner,
    now: () => new Date("2026-10-18T03:00:00Z"),
    notify: (tag, url) => {
      notified.push(`${tag} ${url ?? "-"}`);
      return reach;
    },
    log: (line) => lines.push(line),
  });
  return {
    check,
    config,
    file,
    stateDir,
    asked,
    notified,
    lines,
    setTags: (t: string[]) => (tags = t),
    setFail: (f: string | undefined) => (fail = f),
    setReach: (r: boolean) => (reach = r),
  };
}

test("the broker records the newest release and reports it for the settings screen", async () => {
  const s = setup();
  assert.deepEqual(s.check.info(), { version: "v0.7.0", kind: "installed", enabled: true, channel: "stable", available: false }, "nothing looked at yet");
  await s.check.check();
  assert.deepEqual(s.asked[0].slice(-4), ["ls-remote", "--tags", "--refs", "https://github.com/rjs0429/ccrc.git"]);
  assert.deepEqual(readUpdateCheck(s.file), {
    checkedAt: "2026-10-18T03:00:00.000Z",
    source: "https://github.com/rjs0429/ccrc.git",
    channel: "stable",
    latest: "v0.7.1",
    notified: ["v0.7.1"],
  });
  assert.deepEqual(s.check.info(), {
    version: "v0.7.0",
    kind: "installed",
    enabled: true,
    channel: "stable",
    latest: "v0.7.1",
    available: true,
    url: "https://github.com/rjs0429/ccrc/releases/tag/v0.7.1",
    checkedAt: "2026-10-18T03:00:00.000Z",
  });
  assert.match(updateStatus("v0.7.0", s.stateDir), /^v0\.7\.1 available/);
  assert.match(updateStatus("v0.7.1", s.stateDir), /^none \(latest v0\.7\.1/);

  // Another channel's look says nothing about this one until it is looked at again.
  s.config.updateChannel = "rc";
  assert.equal(s.check.info().latest, undefined);
  await s.check.check();
  assert.equal(s.check.info().latest, "v0.8.0-rc.1");
});

test("a new version is announced once, and only when updateNotify is on and a device hears it", async () => {
  const s = setup();
  s.setReach(false);
  await s.check.check();
  assert.deepEqual(s.notified, ["v0.7.1 https://github.com/rjs0429/ccrc/releases/tag/v0.7.1"]);
  assert.equal(readUpdateCheck(s.file).notified, undefined, "no device subscribed: told again later");
  s.setReach(true);
  await s.check.check();
  await s.check.check();
  assert.equal(s.notified.length, 2);
  s.setTags(["v0.7.1", "v0.7.2"]);
  s.config.updateNotify = false;
  await s.check.check();
  assert.equal(s.notified.length, 2);
  s.config.updateNotify = true;
  await s.check.check();
  assert.deepEqual(s.notified.at(-1), "v0.7.2 https://github.com/rjs0429/ccrc/releases/tag/v0.7.2");
  assert.deepEqual(readUpdateCheck(s.file).notified, ["v0.7.1", "v0.7.2"]);

  const current = setup({ version: "v0.7.1" });
  await current.check.check();
  assert.deepEqual(current.notified, [], "up to date");

  const checkout = setup({ version: "v0.6.0-12-gabc1234", kind: "git" });
  await checkout.check.check();
  assert.deepEqual(checkout.notified, [], "a development checkout is updated with git, not told to run ccrc update");
  assert.equal(checkout.check.info().available, true, "the settings screen still names the release");
});

test("a failed look is recorded, keeps the release seen before, and updateCheck off skips looking", async () => {
  const s = setup({ source: "/home/user/ccrc" });
  await s.check.check();
  assert.equal(s.asked[0].at(-1), "/home/user/ccrc", "the install's own source comes first");
  assert.equal(s.check.info().url, undefined, "no release page outside GitHub");
  s.setFail("could not read from remote repository");
  await s.check.check();
  const info = s.check.info();
  assert.equal(info.latest, "v0.7.1");
  assert.match(info.error!, /git ls-remote \/home\/user\/ccrc failed: fatal: could not read/);
  assert.match(s.lines.join("\n"), /looking for a new version failed/);

  s.config.updateCheck = false;
  const asked = s.asked.length;
  assert.equal(await s.check.checkIfOn(), undefined);
  assert.equal(s.asked.length, asked);
  assert.equal(s.check.info().enabled, false);

  const repo = setup();
  repo.config.updateRepo = "https://example.com/fork.git";
  await repo.check.check();
  assert.equal(repo.asked[0].at(-1), "https://example.com/fork.git", "updateRepo when the install names no source");
});

test("the update keys are checked, reloaded live, and default for a new config", () => {
  const file = path.join(tempDir(), "config.json");
  assert.deepEqual(
    [newConfig().updateCheck, newConfig().updateChannel, newConfig().updateNotify, newConfig().updateRepo],
    [true, "stable", true, undefined],
  );
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, brokerSessions: "off" }));
  const c = readConfig(file).config;
  assert.deepEqual([c.updateCheck, c.updateChannel, c.updateNotify], [true, "stable", true], "an older file gets the defaults");
  assert.throws(() => checkConfig({ updateChannel: "beta" }, file), (e: Error) => e instanceof ConfigError && /"updateChannel" must be "stable", "rc"/.test(e.message));
  assert.throws(() => checkConfig({ updateCheck: "yes" }, file), /"updateCheck" must be true or false/);
  assert.throws(() => checkConfig({ updateRepo: "" }, file), /"updateRepo" must be a git URL or path/);
  assert.throws(() => checkConfig({ updateNotify: 1 }, file), /"updateNotify" must be true or false/);
  assert.deepEqual(checkConfig({ updateCheck: false, updateChannel: "rc", updateRepo: "/home/user/ccrc", updateNotify: false }, file), []);
  for (const k of ["updateCheck", "updateChannel", "updateRepo", "updateNotify"]) assert.ok((LIVE_KEYS as readonly string[]).includes(k), k);
  const live = { ...c };
  const { applied, restart } = applyConfig(live, { ...c, updateChannel: "rc", updateRepo: "https://example.com/fork.git" });
  assert.deepEqual([applied, restart, live.updateChannel], [["updateChannel", "updateRepo"], [], "rc"]);
});

test("a token in the repository URL stays out of the recorded error", async () => {
  const s = setup({ source: "https://user:secret-token@example.com/ccrc.git" });
  s.setFail("unable to access 'https://user:secret-token@example.com/ccrc.git/': Could not resolve host");
  await s.check.check();
  const error = s.check.info().error ?? "";
  assert.match(error, /https:\/\/\*\*\*@example\.com\/ccrc\.git/);
  assert.doesNotMatch(error + s.lines.join("\n"), /secret-token/);
});
