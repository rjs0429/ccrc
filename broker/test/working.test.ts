import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { tempDir } from "./helpers.ts";

// The manager reads ~/.claude and starts the fake CLI.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccrc-home-"));
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
process.env.CCRC_STATE_DIR = path.join(home, "state");
process.env.CCRC_CONFIG_DIR = path.join(home, "config");
process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-from-the-service";
fs.mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });

const { SessionManager } = await import("../src/sessions/manager.ts");
const { LinkServer } = await import("../src/link/server.ts");
const { askWorking, workingLines } = await import("../src/link/working.ts");

const cwd = path.join(home, "work");
fs.mkdirSync(cwd, { recursive: true });
const FAKE = new URL("./fixtures/fake-claude.mjs", import.meta.url).pathname;
const config = { host: "127.0.0.1", port: 0, allowedDevices: [], allowLocal: true, claudePath: FAKE, roots: [cwd], leaseIdleMinutes: 1, sessionIdleMinutes: 1, brokerSessions: "subscription" as const };

const servers: InstanceType<typeof LinkServer>[] = [];
const managers: InstanceType<typeof SessionManager>[] = [];
after(async () => {
  for (const m of managers) await m.closeAll();
  for (const s of servers) await s.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const until = async (fn: () => boolean, label: string) => {
  for (let i = 0; i < 250 && !fn(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(fn(), label);
};

async function broker() {
  const m = new SessionManager(config);
  m.modelProbe = async () => [];
  m.windowProbe = async () => undefined;
  managers.push(m);
  const server = new LinkServer(path.join(tempDir("ccrc-link-"), "link.sock"));
  servers.push(server);
  server.on("link", (link) => m.attachLink(link));
  await server.listen();
  return { m, socket: server.socketPath };
}

test("a command on this machine learns which broker sessions are at work: answering, waiting for an answer, or running a task", async () => {
  const { m, socket } = await broker();
  assert.deepEqual(await askWorking(socket), []);

  const resting = await m.create(cwd, {});
  resting.send("hello");
  await until(() => resting.builder.items.some((i) => i.kind === "assistant"), "the first turn ends");
  await until(() => !resting.busy, "it rests");
  const holding = await m.create(cwd, {});
  holding.send("HOLD");
  await until(() => holding.busy, "a turn under way");
  const asking = await m.create(cwd, {});
  asking.send("ASK");
  await until(() => asking.pending.size === 1, "a permission request");
  const background = await m.create(cwd, {});
  background.send("BGIDLE");
  await until(() => !background.busy && background.tasks.running(), "a task left running in the background");

  const working = await askWorking(socket);
  assert.ok(working);
  const byId = new Map(working.map((s) => [s.id, s]));
  assert.equal(byId.has(resting.id), false, "a resting session is not at work");
  assert.deepEqual(byId.get(holding.id), { id: holding.id, ...(holding.title ? { title: holding.title } : {}), cwd, busy: true, requests: 0, tasks: 0 });
  assert.equal(byId.get(asking.id)?.requests, 1);
  assert.equal(byId.get(background.id)?.tasks, 1);
  assert.equal(working.length, 3);
});

test("a broker that does not know the question, or a socket nobody listens on, gives no answer", async () => {
  const silent = new LinkServer(path.join(tempDir("ccrc-link-"), "link.sock"));
  servers.push(silent);
  await silent.listen();
  const started = Date.now();
  assert.equal(await askWorking(silent.socketPath, 200), undefined);
  assert.ok(Date.now() - started < 2000);
  assert.equal(await askWorking(path.join(tempDir(), "none.sock")), undefined);
});

test("a wrapper's link does not answer the question once it has said hello", async () => {
  const { socket } = await broker();
  const sock = net.createConnection(socket);
  await new Promise((r) => sock.once("connect", r));
  let data = "";
  sock.on("data", (c: Buffer) => (data += c.toString("utf8")));
  sock.write(JSON.stringify({ t: "hello", v: 1, wpid: 990003, cwd, args: [] }) + "\n");
  sock.write(JSON.stringify({ t: "ask_working" }) + "\n");
  await new Promise((r) => setTimeout(r, 200));
  assert.doesNotMatch(data, /"working"/);
  sock.destroy();
});

test("each session at work reads as one line: its name or the start of its id, its folder, and what it is doing", () => {
  assert.deepEqual(
    workingLines([
      { id: "0b7cf2a4-2f5e-4c39-9a51-3f1c2a9d8e11", title: "Release notes", cwd: "/home/user/app", busy: true, requests: 2, tasks: 1 },
      { id: "5f0e8a43-6a8b-4a0f-9f6e-2b7d7c1e9a10", cwd: "/home/user/api", busy: false, requests: 0, tasks: 3 },
    ]),
    ["  - Release notes (/home/user/app): answering, waiting for 2 answers, 1 task running", "  - 5f0e8a43 (/home/user/api): 3 tasks running"],
  );
});
