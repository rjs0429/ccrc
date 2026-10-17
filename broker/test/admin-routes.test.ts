import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { AuditPage, ClaudeSettingsView, HealthInfo } from "../src/admin-protocol.ts";
import { Audit } from "../src/audit.ts";
import { setCredentials } from "../src/auth.ts";
import { ClaudeSettings } from "../src/claude-settings.ts";
import { DeviceGate } from "../src/devices.ts";
import { Doctor } from "../src/doctor.ts";
import type { Hub } from "../src/hub.ts";
import { Leases } from "../src/lease.ts";
import { Push } from "../src/push/index.ts";
import { buildServer } from "../src/server.ts";
import type { SessionManager } from "../src/sessions/manager.ts";
import { Uploads } from "../src/uploads.ts";
import { tempDir, tempStore } from "./helpers.ts";

const ORIGIN = { origin: "http://localhost:80" };
const FAKE = new URL("./fixtures/fake-claude.mjs", import.meta.url).pathname;

async function setup() {
  const dir = tempDir();
  const store = tempStore();
  const settingsFile = path.join(dir, "settings.json");
  fs.writeFileSync(settingsFile, JSON.stringify({ model: "opus", hooks: { Stop: [] } }, null, 2) + "\n");
  const extensionsDir = tempDir();
  const bin = path.join(extensionsDir, "anthropic.claude-code-2.1.296-linux-x64", "resources", "native-binary");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  const audit = new Audit(path.join(dir, "audit.jsonl"));
  const app = await buildServer({
    store,
    leases: new Leases(store, 60),
    gate: new DeviceGate([], true, async () => ({})),
    audit,
    manager: { list: async () => [], folders: async () => [], models: [], brokerSessions: () => ({ mode: "apiKey", ready: false }) } as unknown as SessionManager,
    hub: { attach() {} } as unknown as Hub,
    uploads: new Uploads(tempDir()),
    push: new Push(tempDir()),
    doctor: new Doctor({ stateDir: tempDir(), extensionsDir, vscodeDir: tempDir(), platform: "linux-x64", stepTimeoutMs: 10_000 }),
    claudeSettings: new ClaudeSettings(settingsFile),
    webDir: tempDir(),
    logLevel: "silent",
  });
  await setCredentials(store, "owner", "correct horse battery");
  const login = await app.inject({ method: "POST", url: "/api/login", headers: ORIGIN, payload: { id: "owner", password: "correct horse battery" } });
  const headers = { ...ORIGIN, cookie: String(login.headers["set-cookie"] ?? "").split(";")[0] };
  return { app, audit, headers, settingsFile };
}

// The audit log is appended in the background.
async function audited(audit: Audit, event: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 50; i++) {
    const lines = fs.existsSync(audit.file) ? fs.readFileSync(audit.file, "utf8").split("\n") : [];
    const hit = lines
      .filter((l) => l.endsWith("}"))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((e) => e.event === event);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error(`no ${event} in the audit log`);
}

test("the new endpoints need a login", async () => {
  const { app } = await setup();
  for (const url of ["/api/claude-settings", "/api/audit", "/api/health"]) {
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 401, url);
  }
  assert.equal((await app.inject({ method: "PUT", url: "/api/claude-settings", headers: ORIGIN, payload: {} })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/health/check", headers: ORIGIN, payload: {} })).statusCode, 401);
});

test("settings: changes allowed keys, refuses others and stale saves, and records each change", async () => {
  const { app, audit, headers, settingsFile } = await setup();
  const view = (await app.inject({ method: "GET", url: "/api/claude-settings", headers })).json() as ClaudeSettingsView;
  assert.deepEqual(view.values, { model: "opus" });
  assert.deepEqual(view.notes, [{ key: "hooks", reason: "command" }]);

  const put = (payload: unknown, h: Record<string, string> = headers) => app.inject({ method: "PUT", url: "/api/claude-settings", headers: h, payload: payload as object });
  const hooks = await put({ changes: { hooks: {} }, baseHash: view.hash });
  assert.deepEqual([hooks.statusCode, hooks.json()], [403, { error: "not_allowed", key: "hooks" }]);
  const bypass = await put({ changes: { "permissions.defaultMode": "bypassPermissions" }, baseHash: view.hash });
  assert.deepEqual([bypass.statusCode, bypass.json()], [400, { error: "invalid", key: "permissions.defaultMode" }]);
  assert.equal((await put({ changes: { model: "sonnet" }, baseHash: view.hash }, { cookie: headers.cookie })).statusCode, 403, "Origin is required");

  const ok = await put({ changes: { model: "sonnet", "permissions.ask": ["Bash(git push:*)"] }, baseHash: view.hash });
  assert.equal(ok.statusCode, 200);
  assert.equal((ok.json() as ClaudeSettingsView).values.model, "sonnet");
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf8")), { model: "sonnet", hooks: { Stop: [] }, permissions: { ask: ["Bash(git push:*)"] } });
  const entry = await audited(audit, "claude_settings");
  assert.deepEqual([entry.device, entry.keys], ["local", ["model", "permissions.ask"]]);

  const stale = await put({ changes: { model: "haiku" }, baseHash: view.hash });
  assert.deepEqual([stale.statusCode, stale.json()], [409, { error: "changed" }]);
});

test("audit: newest entries first, a page at a time", async () => {
  const { app, audit, headers } = await setup();
  await audited(audit, "login");
  for (let i = 0; i < 5; i++) fs.appendFileSync(audit.file, JSON.stringify({ ts: `2026-10-14T00:00:0${i}Z`, event: "send", device: "local", n: i }) + "\n");
  const get = (q: string) => app.inject({ method: "GET", url: `/api/audit${q}`, headers });
  const first = (await get("?limit=2")).json() as AuditPage;
  assert.deepEqual(first.entries.map((e) => e.n), [4, 3]);
  const second = (await get(`?limit=2&before=${first.next}`)).json() as AuditPage;
  assert.deepEqual(second.entries.map((e) => e.n), [2, 1]);
  const last = (await get(`?limit=2&before=${second.next}`)).json() as AuditPage;
  assert.deepEqual([last.entries.map((e) => e.n ?? e.event), last.next], [[0, "login"], undefined]);
  for (const q of ["?limit=0", "?limit=201", "?limit=x", "?before=-1", "?before=1e3", "?limit=1&limit=2"]) {
    assert.equal((await get(q)).statusCode, 400, q);
  }
});

test("health: reports versions and runs a check on request, recorded in the audit log", async () => {
  const { app, audit, headers } = await setup();
  const before = (await app.inject({ method: "GET", url: "/api/health", headers })).json() as HealthInfo;
  assert.deepEqual([before.extensionVersion, before.cliVersion, before.last, before.running], ["2.1.296", "2.1.296", undefined, false]);
  assert.deepEqual(before.wrapper, { on: false, thisBroker: false });
  assert.deepEqual(before.brokerSessions, { mode: "apiKey", ready: false }, "the setting, and only whether a key is there");
  const res = await app.inject({ method: "POST", url: "/api/health/check", headers, payload: {} });
  assert.equal(res.statusCode, 200);
  const after = res.json() as HealthInfo;
  assert.equal(after.last?.ok, true, JSON.stringify(after.last));
  assert.equal((await audited(audit, "doctor")).device, "local");
});
