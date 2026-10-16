// Stands in for Claude Code in worktree tests. --worktree <name> makes or opens <root>/.claude/worktrees/<name> on branch
// worktree-<name> as Claude Code does (from HEAD, or origin/HEAD when the --settings worktree.baseRef is not "head"),
// locks it for this process and works in it; outside git it fails the way Claude Code does. FAKE_WT_HOOK_DIR stands for
// a WorktreeCreate hook that made that folder. A resume goes back into the session's worktree, or says it is gone and
// stays where it started. Each user message gets an init line naming the folder, is written to the transcript under
// CLAUDE_CONFIG_DIR and answered "echo: <text>". FAKE_WT_FAIL fails the start with that stderr line, FAKE_WT_SLOW_MS
// starts that much later. FAKE_REQUESTS=<file> gets a line with the arguments and the folders.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("2.1.300 (Claude Code)");
  process.exit(0);
}
const value = (name) => {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1];
    if (args[i].startsWith(name + "=")) return args[i].slice(name.length + 1);
  }
};
const settings = (() => {
  const v = value("--settings");
  try {
    return v ? JSON.parse(v.trim().startsWith("{") ? v : fs.readFileSync(v, "utf8")) : {};
  } catch {
    return {};
  }
})();
const config = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const record = (m) => process.env.FAKE_REQUESTS && fs.appendFileSync(process.env.FAKE_REQUESTS, JSON.stringify(m) + "\n");
const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const fail = (line) => {
  process.stderr.write(line + "\n");
  process.exit(1);
};
const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const launched = process.cwd();
const sid = value("--session-id") || value("--resume") || randomUUID();
let file;
let state;
let stateRow;

if (process.env.FAKE_WT_SLOW_MS) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_WT_SLOW_MS)));
if (process.env.FAKE_WT_FAIL) fail(process.env.FAKE_WT_FAIL);

const name = value("--worktree");
if (name) {
  if (process.env.FAKE_WT_HOOK_DIR) {
    fs.mkdirSync(process.env.FAKE_WT_HOOK_DIR, { recursive: true });
    state = { originalCwd: launched, worktreePath: process.env.FAKE_WT_HOOK_DIR, worktreeName: name, sessionId: sid, hookBased: true };
  } else {
    let common;
    try {
      common = git(launched, "rev-parse", "--path-format=absolute", "--git-common-dir");
    } catch {
      fail(`Error: Can only use --worktree in a git repository, but ${launched} is not a git repository. Configure a WorktreeCreate hook to use --worktree with other VCS systems.`);
    }
    const root = common.endsWith("/.git") ? path.dirname(common) : git(launched, "rev-parse", "--show-toplevel");
    const folder = name.replaceAll("/", "+");
    const at = path.join(root, ".claude", "worktrees", folder);
    const branch = `worktree-${folder}`;
    if (!fs.existsSync(at)) {
      let base = "HEAD";
      if (settings.worktree?.baseRef !== "head") {
        try {
          git(root, "rev-parse", "-q", "--verify", "refs/remotes/origin/HEAD");
          base = "origin/HEAD";
        } catch {}
      }
      try {
        git(root, "worktree", "add", "-q", "--no-track", "-B", branch, at, base);
      } catch (e) {
        fail(`Error creating worktree: ${String(e.stderr ?? e).trim().split("\n").pop()}`);
      }
    }
    const procStart = fs.readFileSync("/proc/self/stat", "utf8").split(") ")[1].split(" ")[19];
    try {
      git(root, "worktree", "lock", "--reason", `claude session ${name} (pid ${process.pid} start ${procStart})`, at);
    } catch {}
    state = { originalCwd: launched, worktreePath: at, worktreeName: name, worktreeBranch: branch, originalBranch: "main", sessionId: sid };
  }
  stateRow = { type: "worktree-state", sessionId: sid, worktreeSession: state };
  process.chdir(state.worktreePath);
}

if (value("--resume")) {
  const dirs = fs.existsSync(path.join(config, "projects")) ? fs.readdirSync(path.join(config, "projects")) : [];
  file = dirs.map((d) => path.join(config, "projects", d, `${sid}.jsonl`)).find((f) => fs.existsSync(f));
  const rows = file ? fs.readFileSync(file, "utf8").split("\n").filter((l) => l.includes('"worktree-state"')) : [];
  const last = rows.length ? JSON.parse(rows.at(-1)).worktreeSession : null;
  if (last && fs.existsSync(last.worktreePath)) process.chdir(last.worktreePath);
  else if (last) {
    process.stderr.write(`Notice: the worktree ${last.worktreePath} no longer exists; continuing in ${launched}\n`);
    stateRow = { type: "worktree-state", sessionId: sid, worktreeSession: null };
  }
}
const cwd = process.cwd();
file ??= path.join(config, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sid}.jsonl`);
record({ args, launched, cwd });
let parent = null;
try {
  parent = JSON.parse(fs.readFileSync(file, "utf8").trim().split("\n").at(-1)).uuid ?? null;
} catch {}

function write(row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (stateRow) fs.appendFileSync(file, JSON.stringify(stateRow) + "\n");
  stateRow = undefined;
  const full = { parentUuid: parent, isSidechain: false, userType: "external", cwd, sessionId: sid, version: "2.1.300", gitBranch: "main", timestamp: new Date().toISOString(), ...row };
  fs.appendFileSync(file, JSON.stringify(full) + "\n");
  parent = row.uuid;
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(m) {
  if (m.type === "user") {
    const content = typeof m.message.content === "string" ? [{ type: "text", text: m.message.content }] : m.message.content;
    const text = content.map((c) => c.text ?? "").join("");
    const uuid = m.uuid ?? randomUUID();
    out({ type: "system", subtype: "init", session_id: sid, cwd, model: "claude-haiku-5-5", permissionMode: "default", output_style: "default" });
    write({ type: "user", uuid, message: { role: "user", content } });
    out({ ...m, session_id: sid, uuid, isReplay: true });
    const reply = randomUUID();
    const message = { model: "claude-haiku-5-5", role: "assistant", content: [{ type: "text", text: `echo: ${text}` }] };
    write({ type: "assistant", uuid: reply, message });
    out({ type: "assistant", session_id: sid, uuid: reply, message });
    out({ type: "result", subtype: "success", session_id: sid, is_error: false, total_cost_usd: 0.001 });
    return;
  }
  if (m.type !== "control_request") return;
  const extra = m.request.subtype === "initialize" ? { models: [], commands: [], output_style: "default", available_output_styles: ["default"] } : {};
  out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { subtype: m.request.subtype, ...extra } } });
}
