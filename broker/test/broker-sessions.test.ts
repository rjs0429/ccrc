import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The manager reads ~/.claude and starts the fake CLI, which records its sign-in variables.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccrc-home-"));
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
process.env.CCRC_STATE_DIR = path.join(home, "state");
process.env.CCRC_CONFIG_DIR = path.join(home, "config");
process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-from-the-service";
const requests = path.join(home, "requests.jsonl");
process.env.FAKE_REQUESTS = requests;
fs.mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });
after(() => fs.rmSync(home, { recursive: true, force: true }));

const { SessionManager, BROKER_SESSIONS_OFF } = await import("../src/sessions/manager.ts");
const { writeApiKey } = await import("../src/api-key.ts");
type Config = import("../src/config.ts").Config;

const cwd = path.join(home, "work");
fs.mkdirSync(cwd, { recursive: true });
const FAKE = new URL("./fixtures/fake-claude.mjs", import.meta.url).pathname;
const KEY_FILE = path.join(home, "config", "anthropic-api-key");

function config(brokerSessions: Config["brokerSessions"]): Config {
  return { host: "127.0.0.1", port: 0, allowedDevices: [], allowLocal: true, claudePath: FAKE, roots: [cwd], leaseIdleMinutes: 1, sessionIdleMinutes: 1, brokerSessions };
}

type Recorded = { args?: string[]; auth?: { apiKey: string | null; oauthToken: boolean } };
const recorded = (): Recorded[] =>
  fs.existsSync(requests)
    ? fs
        .readFileSync(requests, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Recorded)
    : [];

function manager(mode: Config["brokerSessions"]) {
  fs.rmSync(requests, { force: true });
  const m = new SessionManager(config(mode));
  const probes: { kind: string; env?: Record<string, string | undefined> }[] = [];
  m.modelProbe = async (_cwd, _cli, env) => (probes.push({ kind: "models", env }), []);
  m.windowProbe = async (_cwd, _model, _cli, env) => (probes.push({ kind: "window", env }), undefined);
  m.usageProbe = async (_cwd, _cli, env) => (probes.push({ kind: "usage", env }), { limits: [] });
  return { m, probes };
}

const offError = { message: BROKER_SESSIONS_OFF };

async function startedAuth(): Promise<Recorded["auth"]> {
  for (let i = 0; i < 250; i++) {
    const start = recorded().find((r) => r.args);
    if (start) return start.auth;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error("Claude Code did not start");
}

test('"off" refuses every way the broker would start Claude Code, and starts nothing', async () => {
  const { m, probes } = manager("off");
  try {
    assert.deepEqual(m.brokerSessions(), { mode: "off", ready: false });
    await assert.rejects(m.create(cwd, {}), offError, "new session");
    await assert.rejects(m.create(cwd, { worktree: { name: "x", base: "head" } }), offError, "new session in a worktree");
    await assert.rejects(m.send(randomUUID(), "hello"), offError, "a session without a process");
    await assert.rejects(m.call(randomUUID(), "resume", {}), offError, "resume");
    await assert.rejects(m.fork(randomUUID(), { id: randomUUID() }), offError, "fork");
    assert.deepEqual(await m.modelList(), []);
    assert.deepEqual(probes, [], "no probe either");
    assert.deepEqual(recorded(), []);
  } finally {
    await m.closeAll();
  }
});

test('"apiKey" without a key is refused like "off" and says why', async () => {
  fs.rmSync(KEY_FILE, { force: true });
  const { m } = manager("apiKey");
  try {
    assert.deepEqual(m.brokerSessions(), { mode: "apiKey", ready: false });
    await assert.rejects(m.create(cwd, {}), { message: `${BROKER_SESSIONS_OFF}: no API key` });
    assert.deepEqual(recorded(), []);
  } finally {
    await m.closeAll();
  }
});

test('"apiKey" gives the stored key to the processes it starts, in place of an inherited login token', async () => {
  writeApiKey("sk-ant-test-key\n", KEY_FILE);
  assert.equal(fs.statSync(KEY_FILE).mode & 0o777, 0o600);
  const { m, probes } = manager("apiKey");
  try {
    assert.deepEqual(m.brokerSessions(), { mode: "apiKey", ready: true });
    await m.modelList();
    assert.deepEqual(
      probes.map((p) => [p.kind, p.env?.ANTHROPIC_API_KEY]),
      [["models", "sk-ant-test-key"]],
    );
    await m.create(cwd, {});
    assert.deepEqual(await startedAuth(), { apiKey: "sk-ant-test-key", oauthToken: false });
  } finally {
    await m.closeAll();
    fs.rmSync(KEY_FILE, { force: true });
  }
});

test('"subscription" starts with the login the broker has, as before the setting; so does a config without it', async () => {
  for (const mode of ["subscription", undefined] as const) {
    const { m } = manager(mode);
    try {
      assert.deepEqual(m.brokerSessions(), { mode: "subscription", ready: true });
      await m.create(cwd, {});
      assert.deepEqual(await startedAuth(), { apiKey: null, oauthToken: true });
    } finally {
      await m.closeAll();
    }
  }
});

test("a mode changed in the running config holds for the next start", async () => {
  const cfg = config("subscription");
  const m = new SessionManager(cfg);
  m.windowProbe = async () => undefined;
  try {
    await m.create(cwd, {});
    cfg.brokerSessions = "off";
    await assert.rejects(m.create(cwd, {}), offError);
    assert.equal(m.brokerSessions().ready, false);
  } finally {
    await m.closeAll();
  }
});
