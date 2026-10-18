import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { applyConfig, watchConfig } from "../src/config-watch.ts";
import { ConfigError, ConfigTooNewError, SCHEMA_VERSION, jsonErrorAt, loadConfig, readConfig, type Config } from "../src/config.ts";
import { migrateConfigFile } from "../src/migrate.ts";
import { tempDir } from "./helpers.ts";

function file(content: unknown): string {
  const f = path.join(tempDir(), "config.json");
  fs.writeFileSync(f, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  return f;
}

// What a 0.6 broker wrote: every key but the two this version adds.
const OLD = { host: "127.0.0.1", port: 8737, allowedDevices: ["phone"], allowLocal: true, claudePath: "vscode", roots: ["/home/user"], leaseIdleMinutes: 720, sessionIdleMinutes: 15 };

test("a new config file starts at the current format with broker sessions off", () => {
  const f = path.join(tempDir(), "config.json");
  const c = loadConfig(f);
  assert.equal(c.schemaVersion, SCHEMA_VERSION);
  assert.equal(c.brokerSessions, "off");
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), c);
});

test("a file without schemaVersion keeps broker sessions on the subscription, in memory and once migrated", () => {
  const f = file(OLD);
  assert.equal(readConfig(f).config.brokerSessions, "subscription");
  assert.equal(readConfig(f).from, 0);
  const stateDir = tempDir();
  const r = migrateConfigFile({ configFile: f, stateDir, now: new Date("2026-10-17T12:00:00Z") });
  assert.deepEqual(r, { from: 0, to: 1, backupDir: path.join(stateDir, "backup", "migrate-0-1-20261017T120000Z") });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { ...OLD, brokerSessions: "subscription", schemaVersion: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(r!.backupDir!, "config.json"), "utf8")), OLD, "the file as it was");
  assert.deepEqual(migrateConfigFile({ configFile: f, stateDir }), { from: 1, to: 1 }, "a second run changes nothing");
  assert.deepEqual(fs.readdirSync(path.join(stateDir, "backup")), ["migrate-0-1-20261017T120000Z"]);
});

test("an old file that already names brokerSessions keeps its choice", () => {
  const f = file({ ...OLD, brokerSessions: "apiKey" });
  migrateConfigFile({ configFile: f, stateDir: tempDir() });
  assert.equal(readConfig(f).config.brokerSessions, "apiKey");
});

test("a current file without brokerSessions has them off", () => {
  assert.equal(readConfig(file({ schemaVersion: 1 })).config.brokerSessions, "off");
});

test("a file of a newer format is refused with what to do, and left as it is", () => {
  const f = file({ ...OLD, schemaVersion: SCHEMA_VERSION + 1 });
  const before = fs.readFileSync(f, "utf8");
  assert.throws(() => readConfig(f), (e: Error) => e instanceof ConfigTooNewError && /ccrc update/.test(e.message) && /ccrc rollback/.test(e.message));
  assert.throws(() => migrateConfigFile({ configFile: f, stateDir: tempDir() }), ConfigTooNewError);
  assert.equal(fs.readFileSync(f, "utf8"), before);
});

test("a key of the wrong type stops the load with the key and what it takes", () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ port: "8737" }, /"port" must be a whole number from 0 \(any free port\) to 65535, not "8737"/],
    [{ allowedDevices: "phone" }, /"allowedDevices" must be a list of strings/],
    [{ allowLocal: "yes" }, /"allowLocal" must be true or false/],
    [{ brokerSessions: "on" }, /"brokerSessions" must be "off", "apiKey", "subscription", not "on"/],
    [{ sessionIdleMinutes: 0 }, /"sessionIdleMinutes" must be a number above 0/],
    [{ schemaVersion: "1" }, /"schemaVersion" must be a whole number/],
  ];
  for (const [patch, message] of cases) {
    const f = file({ ...OLD, ...patch });
    assert.throws(() => readConfig(f), (e: Error) => e instanceof ConfigError && e.message.startsWith(f) && message.test(e.message), JSON.stringify(patch));
  }
});

test("an unknown key is only warned about", () => {
  const r = readConfig(file({ ...OLD, allowedDevice: ["phone"] }));
  assert.deepEqual(r.warnings.map((w) => w.replace(/^.*: /, "")), ['unknown key "allowedDevice" is ignored']);
  assert.equal("allowedDevice" in r.config, false);
});

test("broken JSON is reported with its line and column", () => {
  const f = file('{\n  "port": 8737,\n  "roots": ["/a",]\n}\n');
  assert.throws(() => readConfig(f), { message: `${f}: not valid JSON at line 3, column 18` });
  assert.throws(() => readConfig(file("")), /line 1, column 1/);
  assert.throws(() => readConfig(file("[1]")), /must hold a JSON object/);
  for (const text of ['{"a": tru}', '{"a" 1}', '{"a": "x\\q"}', "[1, 2", '{"a": 1} x', '"\\u12"', '{"a": -}', "{,}"]) {
    let at = -1;
    try {
      JSON.parse(text);
    } catch {
      at = jsonErrorAt(text);
    }
    assert.ok(at >= 0 && at <= text.length, text);
  }
  assert.equal(jsonErrorAt('{"a": tru}'), 6);
  assert.equal(jsonErrorAt('{"a":1,}'), 7);
});

const base = (): Config => ({ ...OLD, schemaVersion: 1, brokerSessions: "subscription", updateCheck: true, updateChannel: "stable", updateNotify: true, passkeyHours: 18 });

test("live keys change in place and the ones that need a restart are named", () => {
  const current = base();
  const r = applyConfig(current, { ...base(), allowedDevices: ["phone", "tablet"], brokerSessions: "off", port: 9000, claudePath: "/bin/claude" });
  assert.deepEqual(r, { applied: ["allowedDevices", "brokerSessions"], restart: ["port", "claudePath"] });
  assert.deepEqual(current.allowedDevices, ["phone", "tablet"]);
  assert.equal(current.brokerSessions, "off");
  assert.equal(current.port, 8737, "the port stays until a restart");
});

test("a watched file is read again when it changes; a broken one changes nothing", async () => {
  const f = file(base());
  const current = base();
  const logs: string[] = [];
  const applied: string[][] = [];
  const stop = watchConfig(f, current, { apply: (_c, changed) => applied.push(changed), log: (l) => logs.push(l) }, 20);
  const until = async (what: () => boolean) => {
    for (let i = 0; i < 500 && !what(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(what());
  };
  // The watch takes its first look at the file before it changes.
  await new Promise((r) => setTimeout(r, 200));
  try {
    fs.writeFileSync(f, JSON.stringify({ ...base(), roots: ["/home/user/work"], leaseIdleMinutes: 30 }));
    await until(() => applied.length === 1);
    assert.deepEqual(applied[0], ["roots", "leaseIdleMinutes"]);
    assert.deepEqual(current.roots, ["/home/user/work"]);
    fs.writeFileSync(f, JSON.stringify({ ...base(), roots: "nope" }) + " ");
    await until(() => logs.some((l) => l.includes("config not applied")));
    assert.deepEqual(current.roots, ["/home/user/work"]);
    fs.writeFileSync(f, JSON.stringify({ ...base(), roots: ["/home/user/work"], leaseIdleMinutes: 30, host: "0.0.0.0" }));
    await until(() => logs.some((l) => l.includes("host takes effect after a restart")));
    assert.equal(current.host, "127.0.0.1");
  } finally {
    stop();
  }
});
