import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { claudeSettingsFile } from "../claude-settings.ts";
import type { GitFolderInfo, WorktreeRemoved, WorktreeStatus } from "../protocol.ts";
import { suggestWorktreeName, worktreeBranch, worktreeFolder, worktreeOf } from "../worktree-names.ts";
import { startTime } from "./live.ts";

const INFO_MS = 2000;
const STATUS_MS = 10_000;
const REMOVE_MS = 60_000;
const NAMES_MAX = 200;
// Repositories here are not vouched for: git runs without their hooks or fsmonitor command, and never prompts.
const SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor="];
// The lock Claude Code puts on a worktree one of its sessions or agents works in.
const CLAUDE_LOCK = /^claude (?:agent|session) .{1,255} \(pid (\d{1,10})(?: start (.{1,255}))?\)$/;

export interface Run {
  code: number;
  out: string;
  err: string;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  return { ...env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}

export function git(dir: string, args: string[], ms = INFO_MS): Promise<Run> {
  return new Promise((resolve) => {
    execFile("git", [...SAFE, "-C", dir, ...args], { timeout: ms, maxBuffer: 16 << 20, env: gitEnv() }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : -1) : 0;
      resolve({ code, out: String(stdout), err: String(stderr) });
    });
  });
}

// The last line git wrote to stderr, for an error.
function gitError(r: Run, what: string): Error {
  const line = r.err.trim().split("\n").pop()?.replace(/^(fatal|error): /, "");
  return Error(`${what}: ${line || (r.code === -1 ? "git did not finish" : `exit ${r.code}`)}`);
}

const isFolder = (dir: string) => fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true;

// The checkout worktrees belong to: the main working tree, also from inside a linked worktree.
function mainRoot(toplevel: string, common: string): string {
  return common.endsWith("/.git") ? path.dirname(common) : toplevel;
}

// Claude Code makes worktrees through a WorktreeCreate hook, when the user's or the project's settings name one.
export function worktreeHook(dirs: string[]): boolean {
  const files = [claudeSettingsFile(), ...[...new Set(dirs)].flatMap((d) => [path.join(d, ".claude", "settings.json"), path.join(d, ".claude", "settings.local.json")])];
  return files.some((f) => {
    try {
      const hooks = (JSON.parse(fs.readFileSync(f, "utf8")) as { hooks?: { WorktreeCreate?: unknown } }).hooks?.WorktreeCreate;
      return Array.isArray(hooks) && hooks.length > 0;
    } catch {
      return false;
    }
  });
}

// What starting a new session in a worktree of the folder needs: whether git or a hook can make one, where, from what,
// and the names already taken. existing: worktree folders Claude Code opens again; blocked: names whose branch is left
// without its folder, which Claude Code would move to the new base.
export async function gitFolderInfo(dir: string, now = new Date()): Promise<GitFolderInfo> {
  const top = await git(dir, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]);
  if (top.code !== 0) return { repo: false, hook: worktreeHook([dir]), suggested: suggestWorktreeName(now), existing: [], blocked: [] };
  const [toplevel, common] = top.out.trim().split("\n");
  const root = mainRoot(toplevel, common ?? "");
  const [branch, head, origin, remotes, refs] = await Promise.all([
    git(dir, ["symbolic-ref", "--short", "-q", "HEAD"]),
    git(dir, ["rev-parse", "--short", "-q", "--verify", "HEAD"]),
    git(root, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]),
    git(root, ["remote"]),
    git(root, ["for-each-ref", `--count=${NAMES_MAX}`, "--format=%(refname:short)", "refs/heads/worktree-*"]),
  ]);
  const folders = (() => {
    try {
      return fs.readdirSync(path.join(root, ".claude", "worktrees"), { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      return [];
    }
  })().map((e) => e.name);
  const existing = folders.slice(0, NAMES_MAX).map((f) => f.replaceAll("+", "/"));
  const blocked = refs.out
    .split("\n")
    .filter((b) => b.startsWith("worktree-") && !folders.includes(b.slice("worktree-".length)))
    .map((b) => b.slice("worktree-".length).replaceAll("+", "/"));
  let suggested = suggestWorktreeName(now);
  for (let i = 0; i < 20 && (existing.includes(suggested) || blocked.includes(suggested)); i++) suggested = suggestWorktreeName(now);
  const hasOrigin = remotes.out.split("\n").includes("origin");
  return {
    repo: true,
    root,
    ...(branch.code === 0 && branch.out.trim() ? { branch: branch.out.trim() } : {}),
    ...(head.code === 0 && head.out.trim() ? { head: head.out.trim() } : {}),
    ...(hasOrigin ? { origin: origin.code === 0 && origin.out.trim() ? origin.out.trim() : "origin" } : {}),
    hook: worktreeHook([dir, root]),
    suggested,
    existing,
    blocked,
  };
}

// The worktree a session works in as Claude Code recorded it.
export interface WorktreeState {
  worktreePath?: string;
  worktreeName?: string;
  worktreeBranch?: string;
  originalCwd?: string;
}

// The last worktree-state row of a transcript: null once the session left its worktree.
export async function worktreeState(file: string): Promise<WorktreeState | null | undefined> {
  let found: WorktreeState | null | undefined;
  try {
    const lines = readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.includes('"worktree-state"')) continue;
      try {
        const row = JSON.parse(line) as { type?: string; worktreeSession?: unknown };
        if (row.type !== "worktree-state") continue;
        const w = row.worktreeSession;
        found = w && typeof w === "object" ? (w as WorktreeState) : null;
      } catch {}
    }
  } catch {}
  return found;
}

// A worktree ccrc can look after: one Claude Code made under <root>/.claude/worktrees.
export interface WorktreeTarget {
  path: string;
  root: string;
  name: string;
  branch: string;
}

export function worktreeTarget(cwd: string, state?: WorktreeState | null): WorktreeTarget | undefined {
  const at = (state?.worktreePath && worktreeOf(state.worktreePath)) || worktreeOf(cwd);
  if (!at) return undefined;
  const branch = state?.worktreePath === at.path && state.worktreeBranch ? state.worktreeBranch : worktreeBranch(at.name);
  return { path: at.path, root: at.root, name: at.name, branch };
}

// Whether the process a lock names still runs: the same pid started at the same time.
export function lockOf(reason: string): NonNullable<WorktreeStatus["lock"]> {
  const m = CLAUDE_LOCK.exec(reason);
  if (!m) return { claude: false, alive: false, ...(reason ? { reason } : {}) };
  const started = startTime(Number(m[1]));
  return { claude: true, alive: started !== undefined && (m[2] === undefined || started === m[2]), reason };
}

interface Registered {
  head?: string;
  branch?: string;
  locked?: string;
}

async function registered(t: WorktreeTarget): Promise<Registered | undefined> {
  const r = await git(t.root, ["worktree", "list", "--porcelain"], STATUS_MS);
  if (r.code !== 0) throw gitError(r, "git worktree list failed");
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  const want = new Set([t.path, real(t.path)]);
  for (const entry of r.out.split("\n\n")) {
    const lines = entry.split("\n");
    const at = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
    if (!at || !(want.has(at) || want.has(real(at)))) continue;
    const head = lines.find((l) => l.startsWith("HEAD "))?.slice(5);
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "");
    const locked = lines.find((l) => l === "locked" || l.startsWith("locked "));
    return { ...(head ? { head } : {}), ...(branch ? { branch } : {}), ...(locked !== undefined ? { locked: locked.slice(6).trim() } : {}) };
  }
  return undefined;
}

async function count(root: string, revs: string[]): Promise<number> {
  const r = await git(root, ["rev-list", "--count", ...revs], STATUS_MS);
  if (r.code !== 0) throw gitError(r, "git rev-list failed");
  return Number(r.out.trim()) || 0;
}

// Commits of `ref` that no other branch and no remote has, `own` left out of the others.
const onlyHere = (root: string, ref: string, own: string) => count(root, [ref, "--not", `--exclude=${own}`, "--branches", "--remotes"]);

async function branchExists(root: string, branch: string): Promise<boolean> {
  return (await git(root, ["rev-parse", "-q", "--verify", `refs/heads/${branch}`])).code === 0;
}

// The status, and the detached HEAD the worktree's own branch is set to before removal so that commits no branch has
// stay on it. That is done only when the branch holds nothing the HEAD lacks and no other branch or remote has.
async function inspect(t: WorktreeTarget): Promise<{ st: WorktreeStatus; keep?: string }> {
  const exists = isFolder(t.path);
  const reg = await registered(t);
  const own = await branchExists(t.root, t.branch);
  let changed = 0;
  if (exists && reg) {
    const r = await git(t.path, ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=dirty"], STATUS_MS);
    if (r.code !== 0) throw gitError(r, "git status failed");
    changed = r.out.split("\n").filter(Boolean).length;
  }
  const detached = reg?.head && !reg.branch ? reg.head : undefined;
  const loose = detached ? await count(t.root, [detached, "--not", "--branches", "--remotes"]) : 0;
  const movable = loose > 0 && (!own || (await count(t.root, [`refs/heads/${t.branch}`, "--not", detached!, `--exclude=${t.branch}`, "--branches", "--remotes"])) === 0);
  const keep = movable ? detached : undefined;
  const commits = keep ? await onlyHere(t.root, keep, t.branch) : own ? await onlyHere(t.root, `refs/heads/${t.branch}`, t.branch) : 0;
  const ignored = (await git(t.root, ["check-ignore", "-q", `.claude/worktrees/${worktreeFolder(t.name)}`])).code === 0;
  const st: WorktreeStatus = {
    path: t.path,
    name: t.name,
    root: t.root,
    ...(own || keep ? { branch: t.branch } : {}),
    ...(reg?.branch && reg.branch !== t.branch ? { checkedOut: reg.branch } : {}),
    exists,
    registered: Boolean(reg),
    changed,
    commits,
    ...(loose && !keep ? { stranded: loose } : {}),
    ...(reg?.locked !== undefined ? { lock: lockOf(reg.locked) } : {}),
    ignored,
  };
  return { st, ...(keep ? { keep } : {}) };
}

// The worktree as it is now; `running` is the caller's to fill in.
export async function worktreeStatus(t: WorktreeTarget): Promise<WorktreeStatus> {
  return (await inspect(t)).st;
}

// Removes the worktree, unlocking Claude Code's lock when its process has ended; a lock someone else put stays and
// so does the worktree. Changed files go only with `discard`, which commits only the worktree's own branch holds also
// need; that branch is kept when it holds such commits and deleted otherwise. No other branch is touched.
export async function removeWorktree(t: WorktreeTarget, discard: boolean): Promise<WorktreeRemoved> {
  const { st, keep } = await inspect(t);
  if (st.exists && !st.registered) throw Error(`not a registered worktree: ${t.path}`);
  if (st.lock && !st.lock.claude) throw Error(st.lock.reason ? `worktree is locked: ${st.lock.reason}` : "worktree is locked");
  if (st.lock?.alive) throw Error("worktree is in use");
  if (st.stranded) throw Error("worktree has commits on no branch");
  if ((st.changed || st.commits) && !discard) throw Error("worktree has work to keep");
  if (keep) {
    const r = await git(t.root, ["branch", "-f", t.branch, keep], STATUS_MS);
    if (r.code !== 0) throw gitError(r, "git branch failed");
  }
  if (st.lock) {
    const r = await git(t.root, ["worktree", "unlock", t.path], STATUS_MS);
    if (r.code !== 0) throw gitError(r, "git worktree unlock failed");
  }
  if (st.registered) {
    const r = await git(t.root, ["worktree", "remove", ...(st.changed ? ["--force"] : []), t.path], REMOVE_MS);
    if (r.code !== 0) throw gitError(r, "git worktree remove failed");
  }
  const own = await branchExists(t.root, t.branch);
  let kept = false;
  let commits = 0;
  if (own) {
    commits = await onlyHere(t.root, `refs/heads/${t.branch}`, t.branch);
    kept = commits > 0 || (await git(t.root, ["branch", "-D", t.branch], STATUS_MS)).code !== 0;
  }
  return { path: t.path, ...(own ? { branch: t.branch } : {}), branchKept: kept, commits, discarded: st.changed, ...(st.checkedOut ? { checkedOut: st.checkedOut } : {}) };
}
