import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccrc-home-"));
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
process.env.CCRC_STATE_DIR = path.join(home, "state");
fs.mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });

const { SessionManager } = await import("../src/sessions/manager.ts");
const { rememberCommands } = await import("../src/sessions/commands.ts");
const { heldListings, searchFiles } = await import("../src/sessions/files.ts");
const { Hub } = await import("../src/hub.ts");
const { Uploads } = await import("../src/uploads.ts");
type Audit = import("../src/audit.ts").Audit;
type Leases = import("../src/lease.ts").Leases;
type ServerMsg = import("../src/protocol.ts").ServerMsg;

const root = path.join(home, "projects");
const work = path.join(root, "app");
const outside = path.join(home, "private");
const FILES = ["src/main.ts", "README.md", ".env", ".env.local", "config/credentials.json", "certs/server.pem", "id_ed25519", ".ssh/config", "envelope.ts"];
for (const f of FILES) {
  fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true });
  fs.writeFileSync(path.join(work, f), f);
}
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(outside, "notes.md"), "x");
fs.symlinkSync(outside, path.join(root, "link"));
const config = { host: "127.0.0.1", port: 0, allowedDevices: [], allowLocal: true, roots: [root], leaseIdleMinutes: 1, sessionIdleMinutes: 1 };

after(() => fs.rmSync(home, { recursive: true, force: true }));

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: ServerMsg[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMsg);
  }
  ping(): void {}
  close(): void {
    this.readyState = 3;
  }
  terminate(): void {}
}

function setup(t: { after: (fn: () => unknown) => void }) {
  const logged: [string, Record<string, unknown>][] = [];
  const audit = { log: (event: string, detail: Record<string, unknown>) => logged.push([event, detail]) } as unknown as Audit;
  const manager = new SessionManager(config, audit);
  const leases = Object.assign(new EventEmitter(), { validate: () => true }) as unknown as Leases;
  const hub = new Hub(manager, leases, audit, new Uploads(fs.mkdtempSync(path.join(home, "up-"))));
  const ws = new FakeSocket();
  hub.attach(ws as never, "phone", "token");
  let id = 0;
  const call = async (cwd: string, op: string, args: Record<string, unknown> = {}) => {
    const n = ++id;
    ws.emit("message", JSON.stringify({ t: "call", id: n, cwd, op, args }));
    for (let i = 0; i < 250; i++) {
      const r = ws.sent.find((m): m is Extract<ServerMsg, { t: "call_result" }> => m.t === "call_result" && m.id === n);
      if (r) return r;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw Error("no answer");
  };
  t.after(async () => {
    hub.close();
    await manager.closeAll();
  });
  return { manager, call, logged };
}

test("a folder a new session may start in answers files, commands and usage without a session", async (t) => {
  const { manager, call, logged } = setup(t);
  let probes = 0;
  manager.usageProbe = async () => (probes++, { limits: [{ kind: "session", percent: 12 }] });
  rememberCommands(work, [{ name: "review", description: "Review" }]);

  const files = await call(work, "files", { query: "" });
  assert.equal(files.ok, true);
  assert.deepEqual((files.data as string[]).sort(), ["README.md", "envelope.ts", "src/main.ts"], "names of key and token files are not offered");
  const found = await call(work, "files", { query: "main" });
  assert.deepEqual(found.data, ["src/main.ts"]);
  const env = await call(work, "files", { query: ".env" });
  assert.deepEqual(env.data, [], "not even when asked for by name");
  assert.deepEqual(
    logged.filter(([e]) => e === "folder_index"),
    [["folder_index", { device: "phone", cwd: fs.realpathSync(work), files: FILES.length }]],
    "the listing is recorded once and the queries are not",
  );

  assert.deepEqual((await call(work, "commands")).data, [{ name: "review", description: "Review" }]);
  const usage = await call(work, "usage");
  assert.deepEqual(usage.data, { limits: [{ kind: "session", percent: 12 }] });
  await call(work, "usage");
  assert.equal(probes, 1, "the account's usage is kept a while");
  assert.ok(!logged.some(([e]) => e === "call" || e === "folder_denied"));
});

test("a folder outside the allowed ones, a link out of them or a missing folder is refused and recorded once a minute", async (t) => {
  const { call, logged } = setup(t);
  for (const [dir, error] of [
    [outside, "folder is not allowed for new sessions"],
    [path.join(root, "link"), "folder is not allowed for new sessions"],
    [path.join(root, "gone"), "folder does not exist"],
    [path.join(work, "README.md"), "not a folder"],
  ]) {
    const r = await call(dir, "files", { query: "" });
    assert.deepEqual([r.ok, r.error], [false, error], dir);
  }
  await call(outside, "files", { query: "notes" });
  await call(outside, "commands");
  assert.deepEqual(
    logged.filter(([e]) => e === "folder_denied").map(([, d]) => d.cwd),
    [outside, path.join(root, "link"), path.join(root, "gone"), path.join(work, "README.md")],
  );
  assert.ok(!logged.some(([e]) => e === "folder_index"));
});

test("only the folder calls are taken with a folder", async (t) => {
  const { call } = setup(t);
  for (const op of ["rewind", "resume", "mcp_toggle", "unqueue", "context", "nope"]) {
    const r = await call(work, op, { userMessageId: "x", dryRun: false });
    assert.deepEqual([r.ok, r.error], [false, "unknown request"], op);
  }
  const long = await call("/".repeat(5000), "files", { query: "" });
  assert.deepEqual([long.ok, long.error], [false, "invalid request"]);
  const query = await call(work, "files", { query: "x".repeat(300) });
  assert.deepEqual([query.ok, query.error], [false, "invalid request"]);
});

test("at most eight folder listings are held at once, and session searches hide secret names too", async () => {
  const dirs = Array.from({ length: 10 }, (_, i) => {
    const d = path.join(home, "many", String(i));
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "a.txt"), "a");
    fs.writeFileSync(path.join(d, ".env.production"), "SECRET=1");
    return d;
  });
  const made: number[] = [];
  for (const d of dirs) assert.deepEqual(await searchFiles(d, "", (n) => made.push(n)), ["a.txt"]);
  assert.ok(heldListings() <= 8, String(heldListings()));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(made, new Array(10).fill(2));
  await searchFiles(dirs[0], "a", (n) => made.push(n));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(made.length, 11, "a dropped listing is made again");
});
