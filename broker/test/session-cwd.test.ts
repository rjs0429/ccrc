import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The manager and the SDK read ~/.claude, so they run against an empty home of their own.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccrc-home-"));
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
process.env.CCRC_STATE_DIR = path.join(home, "state");
fs.mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });
after(() => fs.rmSync(home, { recursive: true, force: true }));

const { listSessions } = await import("@anthropic-ai/claude-agent-sdk");
const { SessionManager } = await import("../src/sessions/manager.ts");
const { SessionCwds, firstCwd } = await import("../src/sessions/session-cwd.ts");
const { projectDirName } = await import("../src/sessions/history.ts");

const projects = path.join(home, ".claude", "projects");
const id = (n: number) => `${String(n).repeat(8)}-0000-4000-8000-${String(n).repeat(12)}`;
const config = { host: "127.0.0.1", port: 0, allowedDevices: [], allowLocal: true, roots: [], leaseIdleMinutes: 1, sessionIdleMinutes: 1 };

// A transcript that starts as one sent while Claude worked: queue rows, then a first message longer than the part
// of the file the SDK reads, its cwd after the text.
function longStart(sessionId: string, cwd: string | undefined, opts: { under?: string; text?: number; title?: string } = {}): string {
  const dir = path.join(projects, projectDirName(opts.under ?? cwd ?? "/none"));
  fs.mkdirSync(dir, { recursive: true });
  const at = "2026-10-01T00:00:00.000Z";
  const where = cwd ? { cwd } : {};
  const rows = [
    { type: "queue-operation", operation: "enqueue", timestamp: at, sessionId },
    { type: "queue-operation", operation: "dequeue", timestamp: at, sessionId },
    {
      parentUuid: null,
      isSidechain: false,
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "긴 글 ".repeat(opts.text ?? 40_000) }, { type: "tool_use", id: "t", name: "x", input: { cwd: "/elsewhere" } }] },
      uuid: `${sessionId.slice(0, 8)}-0000-4000-8000-000000000001`,
      timestamp: at,
      userType: "external",
      ...where,
      sessionId,
      version: "2.1.300",
      gitBranch: "main",
    },
    { parentUuid: `${sessionId.slice(0, 8)}-0000-4000-8000-000000000001`, isSidechain: false, type: "assistant", uuid: `${sessionId.slice(0, 8)}-0000-4000-8000-000000000002`, timestamp: at, ...where, sessionId, message: { role: "assistant", content: [{ type: "text", text: "네" }] } },
    { type: "custom-title", customTitle: opts.title ?? "긴 첫 메시지", sessionId },
  ];
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

function short(sessionId: string, cwd: string): void {
  const dir = path.join(projects, projectDirName(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const row = { parentUuid: null, isSidechain: false, type: "user", uuid: `${sessionId.slice(0, 8)}-0000-4000-8000-000000000001`, timestamp: "2026-10-02T00:00:00.000Z", userType: "external", cwd, sessionId, message: { role: "user", content: "안녕" } };
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), JSON.stringify(row) + "\n");
}

const proj = path.join(home, "proj");
const alone = path.join(home, "alone");
fs.mkdirSync(proj);
fs.mkdirSync(alone);

test("the first cwd of a transcript is found past a first line longer than the SDK reads, and only at the top", async () => {
  const file = longStart(id(1), proj, { text: 300_000 });
  assert.ok(fs.statSync(file).size > 1 << 20, "the first message runs past one read");
  assert.equal(await firstCwd(file), proj);
  const none = longStart(id(2), undefined, { under: proj });
  assert.equal(await firstCwd(none), undefined, "a cwd inside a tool input is not the session's");
  assert.equal(await firstCwd(file, 64 * 1024), undefined, "the scan stops at its limit");
  fs.rmSync(file);
  fs.rmSync(none);
});

test("the SDK lists such a session without a cwd; the manager fills it in from the transcript", async () => {
  longStart(id(3), proj);
  short(id(4), proj);
  const sdk = (await listSessions()).find((i) => i.sessionId === id(3));
  assert.ok(sdk, "listed by its title");
  assert.equal(sdk.cwd, undefined);
  assert.equal(sdk.firstPrompt, undefined);
  assert.equal(sdk.gitBranch, "main", "the branch comes from the end of the file");

  const manager = new SessionManager(config);
  manager.windowProbe = async () => undefined;
  const listed = (await manager.list()).find((s) => s.id === id(3));
  assert.equal(listed?.cwd, proj);
  assert.equal(listed?.title, "긴 첫 메시지");
  assert.equal(listed?.folderMissing, undefined);
  assert.deepEqual(await manager.folders(), [proj]);
  const snap = await manager.snapshot(id(3));
  assert.equal(snap.state.cwd, proj);
  assert.ok(snap.items.length > 0, "the session opens");
});

test("a session alone in its project folder, or among folders sharing the folder's name, takes its own first cwd", async () => {
  const found = new SessionCwds(() => projects);
  const lone = longStart(id(5), alone);
  const fixed = new Date("2026-10-01T00:00:00.000Z");
  fs.utimesSync(lone, fixed, fixed);
  const dashed = path.join(home, "a-b");
  const dotted = path.join(home, "a.b");
  assert.equal(projectDirName(dashed), projectDirName(dotted));
  short(id(6), dashed);
  short(id(7), dotted);
  longStart(id(8), dotted);
  const infos = [
    { sessionId: id(5), summary: "x", lastModified: 1 },
    { sessionId: id(6), summary: "x", lastModified: 1, cwd: dashed },
    { sessionId: id(7), summary: "x", lastModified: 1, cwd: dotted },
    { sessionId: id(8), summary: "x", lastModified: 1 },
  ];
  const filled = await found.fill(infos);
  assert.deepEqual(
    filled.map((i) => i.cwd),
    [alone, dashed, dotted, dotted],
  );
  assert.equal(filled[1], infos[1], "a listed cwd stays as it was");

  // Kept while the file keeps its size and time, or only grows; read again once it is rewritten.
  const text = fs.readFileSync(lone, "utf8");
  fs.writeFileSync(lone, text.replaceAll(JSON.stringify(alone), JSON.stringify(alone.replace("alone", "elsew"))));
  fs.utimesSync(lone, fixed, fixed);
  assert.equal((await found.fill([infos[0]]))[0].cwd, alone, "same size and time: not read again");
  fs.appendFileSync(lone, JSON.stringify({ type: "last-prompt", lastPrompt: "더", sessionId: id(5) }) + "\n");
  assert.equal((await found.fill([infos[0]]))[0].cwd, alone, "grown: the first cwd stays");
  fs.writeFileSync(lone, text.replaceAll(JSON.stringify(alone), JSON.stringify(dashed)));
  assert.equal((await found.fill([infos[0]]))[0].cwd, dashed, "rewritten shorter: read again");

  assert.deepEqual(await new SessionCwds(() => path.join(home, "nowhere")).fill([infos[0]]), [infos[0]], "no projects folder: left as it was");
});

test("the cwd a transcript records wins over the one other folder listed in its project folder, which may only encode alike", async () => {
  const hex = (c: string) => `${c.repeat(8)}-0000-4000-8000-${c.repeat(12)}`;
  const dashed = path.join(home, "c-d");
  const dotted = path.join(home, "c.d");
  short(hex("a"), dashed);
  longStart(hex("b"), dotted);
  longStart(hex("c"), undefined, { under: dashed });
  const filled = await new SessionCwds(() => projects).fill([
    { sessionId: hex("a"), summary: "x", lastModified: 1, cwd: dashed },
    { sessionId: hex("b"), summary: "x", lastModified: 1 },
    { sessionId: hex("c"), summary: "x", lastModified: 1 },
  ]);
  assert.deepEqual(
    filled.map((i) => i.cwd),
    [dashed, dotted, dashed],
    "a transcript that records no cwd takes the folder listed there",
  );
});
