import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The manager reads ~/.claude and starts the fake CLI, which records its environment.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccrc-home-"));
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
process.env.CCRC_STATE_DIR = path.join(home, "state");
const requests = path.join(home, "requests.jsonl");
process.env.FAKE_REQUESTS = requests;
delete process.env.CLAUDE_CODE_ENTRYPOINT;
delete process.env.CLAUDE_CODE_ARTIFACT;
delete process.env.CLAUDE_CODE_SEND_FEEDBACK;
fs.mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });

const { SessionManager } = await import("../src/sessions/manager.ts");
const { projectDirName } = await import("../src/sessions/history.ts");
const { liveProcesses, startTime } = await import("../src/sessions/live.ts");
const { probeModels } = await import("../src/sessions/broker-session.ts");
const { ENTRYPOINT, retagLine, retagTranscripts, sessionEnv } = await import("../src/sessions/entrypoint.ts");

const cwd = path.join(home, "work");
const projectDir = path.join(home, ".claude", "projects", projectDirName(cwd));
const FAKE = new URL("./fixtures/fake-claude.mjs", import.meta.url).pathname;
const config = { host: "127.0.0.1", port: 0, allowedDevices: [], allowLocal: true, claudePath: FAKE, roots: [cwd], leaseIdleMinutes: 1, sessionIdleMinutes: 1 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(projectDir, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });

after(() => fs.rmSync(home, { recursive: true, force: true }));

// VS Code's session list (extension 2.1.296) drops a transcript when the first "entrypoint" in its first 64 KiB,
// or else the last one in its last 64 KiB, is an SDK one, or when its first row with a parentUuid is a daemon's.
const SDK = new Set(["sdk-cli", "sdk-ts", "sdk-py"]);
const WINDOW = 65536;
function fieldAt(text: string, key: string, last: boolean): string | undefined {
  let found: string | undefined;
  let foundAt = -1;
  for (const p of [`"${key}":"`, `"${key}": "`]) {
    for (let at = text.indexOf(p); at >= 0; at = last ? text.indexOf(p, at + 1) : -1) {
      let end = at + p.length;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      if (end >= text.length) break;
      if (!last) return text.slice(at + p.length, end);
      if (at > foundAt) (found = text.slice(at + p.length, end)), (foundAt = at);
    }
  }
  return found;
}
function listedInVsCode(file: string): boolean {
  const buf = fs.readFileSync(file);
  const head = buf.subarray(0, WINDOW).toString("utf8");
  const tail = buf.subarray(Math.max(0, buf.length - WINDOW)).toString("utf8");
  const entry = fieldAt(head, "entrypoint", false) ?? fieldAt(tail, "entrypoint", true);
  if (entry && SDK.has(entry)) return false;
  const first = head.split("\n").find((l) => l.includes('"parentUuid":')) ?? head;
  const kind = fieldAt(first, "sessionKind", false);
  return kind !== "daemon" && kind !== "daemon-worker";
}

const recorded = (): Record<string, unknown>[] =>
  fs.existsSync(requests)
    ? fs
        .readFileSync(requests, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];

async function startedEnv(flag: string, id: string): Promise<Record<string, unknown> | undefined> {
  const find = () => recorded().find((r) => Array.isArray(r.args) && (r.args as string[]).some((a, i, all) => a === `${flag}=${id}` || (a === flag && all[i + 1] === id)));
  for (let i = 0; i < 150 && !find(); i++) await sleep(20);
  return find()?.env as Record<string, unknown> | undefined;
}

function writeTranscript(sessionId: string, rows: Record<string, unknown>[]): string {
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
  return file;
}

function sdkRows(sessionId: string): Record<string, unknown>[] {
  const base = { sessionId, cwd, isSidechain: false, userType: "external", entrypoint: "sdk-ts", version: "2.1.296" };
  return [
    { type: "queue-operation", operation: "enqueue", timestamp: "2026-10-14T03:00:00.000Z", sessionId },
    { ...base, parentUuid: null, type: "user", uuid: "u1", timestamp: "2026-10-14T03:00:01.000Z", message: { role: "user", content: 'say "entrypoint":"sdk-ts"' } },
    {
      ...base,
      parentUuid: "u1",
      type: "user",
      uuid: "u2",
      timestamp: "2026-10-14T03:00:02.000Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      toolUseResult: { entrypoint: "sdk-ts", stdout: "ok" },
    },
    { ...base, parentUuid: "u2", type: "assistant", uuid: "a1", timestamp: "2026-10-14T03:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(70_000) }] } },
    { type: "ai-title", aiTitle: "a title", sessionId },
  ];
}

test("every broker start path runs Claude Code with the broker's entrypoint; a probe keeps the SDK's", async () => {
  const S = "7a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
  const U = "8b2c3d4e-5f6a-4b7c-9d8e-9f0a1b2c3d4e";
  writeTranscript(S, sdkRows(S));
  writeTranscript(U, sdkRows(U));
  const manager = new SessionManager(config);
  manager.windowProbe = async () => undefined;
  try {
    const own = { CLAUDE_CODE_ENTRYPOINT: ENTRYPOINT, CLAUDE_CODE_ARTIFACT: "0", CLAUDE_CODE_SEND_FEEDBACK: "0" };
    const created = await manager.create(cwd, {});
    assert.deepEqual(await startedEnv("--session-id", created.id), own, "new session");
    await manager.send(S, "hello");
    assert.deepEqual(await startedEnv("--resume", S), own, "resume");
    await manager.setEffort(U, "max");
    await manager.send(U, "hello");
    assert.deepEqual(await startedEnv("--resume", U), own, "start settings");
  } finally {
    await manager.closeAll();
  }
  fs.rmSync(requests, { force: true });
  const models = await probeModels(cwd, FAKE);
  assert.ok(models.length > 0);
  const probe = recorded().find((r) => r.args)?.env as Record<string, unknown>;
  assert.equal(probe.CLAUDE_CODE_ENTRYPOINT, "sdk-ts", "a probe writes no transcript");
});

test("the session environment replaces an inherited entrypoint and keeps an explicit artifact or feedback choice", () => {
  const env = sessionEnv({ PATH: "/bin", CLAUDE_CODE_ENTRYPOINT: "claude-vscode", CLAUDE_CODE_ARTIFACT: "1" });
  assert.deepEqual(env, { PATH: "/bin", CLAUDE_CODE_ENTRYPOINT: ENTRYPOINT, CLAUDE_CODE_ARTIFACT: "1", CLAUDE_CODE_SEND_FEEDBACK: "0" });
});

test("a row's own entrypoint is retagged, not one inside its content", () => {
  const row = { type: "user", toolUseResult: { entrypoint: "sdk-ts" }, entrypoint: "sdk-ts", message: { content: '"entrypoint":"sdk-ts"' } };
  const next = retagLine(JSON.stringify(row));
  assert.deepEqual(JSON.parse(next!), { ...row, entrypoint: ENTRYPOINT });
  assert.equal(retagLine(JSON.stringify({ type: "user", entrypoint: "claude-vscode" })), undefined);
  assert.equal(retagLine(JSON.stringify({ type: "ai-title", nested: { entrypoint: "sdk-ts" } })), undefined);
  assert.equal(retagLine('{"entrypoint":"sdk-ts",'), undefined);
});

test("transcripts of stopped sessions the broker created are retagged once, after a backup; others are left alone", () => {
  const A = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
  const B = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
  const C = "3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f";
  const D = "4d5e6f7a-8b9c-4d0e-9f2a-3b4c5d6e7f8a";
  const E = "5e6f7a8b-9c0d-4e1f-8a3b-4c5d6e7f8a9b";
  const auditFile = path.join(home, "state", "audit.jsonl");
  const backupDir = path.join(home, "state", "backup");
  fs.mkdirSync(path.dirname(auditFile), { recursive: true });
  const events = [
    { event: "login", device: "phone" },
    ...[A, B, D, E].map((sessionId) => ({ event: "new_session", device: "phone", sessionId, cwd })),
    { event: "send", sessionId: C, chars: 5 },
  ];
  fs.writeFileSync(auditFile, events.map((e) => JSON.stringify({ ts: "2026-10-14T03:00:00.000Z", ...e })).join("\n") + "\n");
  const files = Object.fromEntries([A, B, C, E].map((id) => [id, writeTranscript(id, sdkRows(id))]));
  const past = new Date("2026-10-10T00:00:00.000Z");
  for (const f of Object.values(files)) fs.utimesSync(f, past, past);
  const original = Object.fromEntries(Object.entries(files).map(([id, f]) => [id, fs.readFileSync(f)]));
  for (const f of Object.values(files)) assert.equal(listedInVsCode(f), false);
  // B is held by a running Claude Code process.
  fs.writeFileSync(path.join(home, ".claude", "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: B, cwd, procStart: startTime(process.pid), entrypoint: "claude-vscode" }));
  // E's transcript grows while it is being rewritten.
  let eChecks = 0;
  const running = (id: string) => {
    if (id === E && ++eChecks === 2) fs.appendFileSync(files[E], JSON.stringify({ type: "last-prompt", sessionId: E }) + "\n");
    return liveProcesses({ fresh: true }).some((l) => l.sessionId === id);
  };

  const done = retagTranscripts({ auditFile, backupDir, running });
  assert.deepEqual(
    done.map((r) => r.file),
    [files[A]],
  );
  assert.deepEqual(fs.readFileSync(done[0].backup), original[A], "the backup holds the original bytes");
  assert.equal(path.dirname(done[0].backup), backupDir);
  const before = original[A].toString("utf8").split("\n");
  const now = fs.readFileSync(files[A], "utf8").split("\n");
  assert.equal(now.length, before.length);
  for (let i = 0; i < now.length; i++) {
    if (!before[i]) continue;
    const was = JSON.parse(before[i]);
    assert.deepEqual(JSON.parse(now[i]), was.entrypoint === "sdk-ts" ? { ...was, entrypoint: ENTRYPOINT } : was);
  }
  assert.ok(now.join("\n").includes('"toolUseResult":{"entrypoint":"sdk-ts"'), "content keeps its own fields");
  assert.equal(listedInVsCode(files[A]), true);
  const stat = fs.statSync(files[A]);
  assert.equal(stat.mtimeMs, past.getTime(), "the session keeps its place in the list");
  assert.equal(stat.mode & 0o777, 0o600);

  assert.deepEqual(fs.readFileSync(files[B]), original[B], "a running session is left alone");
  assert.deepEqual(fs.readFileSync(files[C]), original[C], "a session the broker did not create is left alone");
  assert.equal(listedInVsCode(files[E]), false, "a transcript that changed meanwhile is left alone");
  assert.ok(fs.readFileSync(files[E], "utf8").startsWith(original[E].toString("utf8")));
  assert.deepEqual(fs.readdirSync(backupDir), [path.basename(done[0].backup)]);
  assert.deepEqual(
    fs.readdirSync(projectDir).filter((n) => n.includes(".tmp")),
    [],
  );

  const retagged = fs.readFileSync(files[A]);
  assert.deepEqual(
    retagTranscripts({ auditFile, backupDir, running }).map((r) => r.file),
    [files[E]],
    "the next start retags what was left because it changed",
  );
  assert.deepEqual(fs.readFileSync(files[A]), retagged, "a retagged transcript is not touched again");
  assert.equal(fs.readdirSync(backupDir).length, 2);
  assert.deepEqual(retagTranscripts({ auditFile, backupDir, running }), []);
  fs.rmSync(path.join(home, ".claude", "sessions", `${process.pid}.json`));
});
