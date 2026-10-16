import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Settings are read from CLAUDE_CONFIG_DIR, so the test runs against a home of its own; repositories are made in it.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccrc-home-"));
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
after(() => fs.rmSync(home, { recursive: true, force: true }));

const names = await import("../src/worktree-names.ts");
const { gitFolderInfo, lockOf, removeWorktree, worktreeState, worktreeStatus, worktreeTarget } = await import("../src/sessions/worktrees.ts");
const { startTime } = await import("../src/sessions/live.ts");

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

let repos = 0;
// A repository with one commit on main, and .claude/worktrees/ ignored unless asked otherwise.
function repo(opts: { ignore?: boolean } = {}): string {
  const dir = path.join(home, `repo${++repos}`);
  fs.mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  if (opts.ignore !== false) fs.writeFileSync(path.join(dir, ".gitignore"), ".claude/worktrees/\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  return dir;
}

// A worktree as Claude Code makes it: under .claude/worktrees on branch worktree-<name>, from HEAD.
function worktree(root: string, name: string, lock?: string): string {
  const at = names.worktreePath(root, name);
  git(root, "worktree", "add", "-q", "--no-track", "-B", names.worktreeBranch(name), at, "HEAD");
  if (lock !== undefined) git(root, "worktree", "lock", ...(lock ? ["--reason", lock] : []), at);
  return at;
}

const target = (root: string, name: string) => worktreeTarget(names.worktreePath(root, name))!;

test("worktree names follow Claude Code's rule and git's for the branch", () => {
  for (const ok of ["ccrc-1016-k3fz", "feature/login", "a.b_c-d", "x".repeat(64), "v1.2"]) assert.equal(names.worktreeNameProblem(ok), undefined, ok);
  assert.equal(names.worktreeNameProblem(""), "empty");
  assert.equal(names.worktreeNameProblem("x".repeat(65)), "long");
  for (const bad of ["has space", "한글", "a+b", "a:b", "a~b"]) assert.equal(names.worktreeNameProblem(bad), "chars", bad);
  for (const bad of ["a//b", "/a", "a/", ".", "a/..", ".git", ".GIT..", "x/.git"]) assert.equal(names.worktreeNameProblem(bad), "segment", bad);
  for (const bad of ["a..b", "a.", "a.lock", "x/y.lock"]) assert.equal(names.worktreeNameProblem(bad), "ref", bad);
  assert.equal(names.worktreeBranch("feature/login"), "worktree-feature+login");
  assert.equal(names.worktreePath("/r", "feature/login"), "/r/.claude/worktrees/feature+login");
});

test("a working folder in a worktree tells the repository and the name, from the worktree or below it", () => {
  assert.deepEqual(names.worktreeOf("/home/u/app/.claude/worktrees/feature+login"), { root: "/home/u/app", name: "feature/login", path: "/home/u/app/.claude/worktrees/feature+login" });
  assert.deepEqual(names.worktreeOf("/home/u/app/.claude/worktrees/x/src/lib"), { root: "/home/u/app", name: "x", path: "/home/u/app/.claude/worktrees/x" });
  assert.equal(names.worktreeOf("/home/u/app"), undefined);
  assert.equal(names.worktreeOf("/home/u/app/.claude/worktrees"), undefined);
});

test("the suggested name is ccrc-MMDD- and four letters or digits", () => {
  const seq = [0, 0.5, 0.99, 0.3];
  let i = 0;
  assert.equal(names.suggestWorktreeName(new Date(2026, 9, 6), () => seq[i++ % seq.length]), "ccrc-1006-as9k");
  assert.match(names.suggestWorktreeName(), /^ccrc-\d{4}-[a-z0-9]{4}$/);
});

test("a folder outside git offers no worktree unless a WorktreeCreate hook makes one", async () => {
  const plain = path.join(home, "plain");
  fs.mkdirSync(path.join(plain, ".claude"), { recursive: true });
  const info = await gitFolderInfo(plain);
  assert.equal(info.repo, false);
  assert.equal(info.hook, false);
  assert.match(info.suggested, /^ccrc-\d{4}-[a-z0-9]{4}$/);
  fs.writeFileSync(path.join(plain, ".claude", "settings.local.json"), JSON.stringify({ hooks: { WorktreeCreate: [{ hooks: [{ type: "command", command: "make-wt" }] }] } }));
  assert.equal((await gitFolderInfo(plain)).hook, true);
  fs.writeFileSync(path.join(plain, ".claude", "settings.local.json"), JSON.stringify({ hooks: { WorktreeCreate: [] } }));
  assert.equal((await gitFolderInfo(plain)).hook, false, "an empty hook list makes nothing");
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { WorktreeCreate: [{ hooks: [] }] } }));
  try {
    assert.equal((await gitFolderInfo(plain)).hook, true, "the user's settings count too");
  } finally {
    fs.rmSync(path.join(home, ".claude", "settings.json"));
  }
});

test("a repository's info names its root, branch, head and taken names, also from inside a worktree", async () => {
  const root = repo();
  const sub = path.join(root, "src");
  fs.mkdirSync(sub);
  const info = await gitFolderInfo(sub, new Date(2026, 9, 16));
  assert.equal(info.repo, true);
  assert.equal(info.root, root);
  assert.equal(info.branch, "main");
  assert.match(info.head ?? "", /^[0-9a-f]{7,}$/);
  assert.equal(info.origin, undefined);
  assert.equal(info.hook, false);
  assert.match(info.suggested, /^ccrc-1016-[a-z0-9]{4}$/);
  assert.deepEqual(info, { ...info, existing: [], blocked: [] });

  const wt = worktree(root, "feature/one");
  git(root, "branch", "worktree-left");
  const inside = await gitFolderInfo(wt);
  assert.equal(inside.root, root, "a worktree's own worktrees go under the main checkout");
  assert.equal(inside.branch, "worktree-feature+one");
  assert.deepEqual(inside.existing, ["feature/one"]);
  assert.deepEqual(inside.blocked, ["left"], "a branch left without its worktree blocks its name");

  const bare = path.join(home, "remote.git");
  git(home, "init", "-q", "--bare", bare);
  git(root, "remote", "add", "origin", bare);
  assert.equal((await gitFolderInfo(root)).origin, "origin", "a remote whose default branch is not known here");
  git(root, "push", "-q", "origin", "main");
  git(root, "remote", "set-head", "origin", "main");
  assert.equal((await gitFolderInfo(root)).origin, "origin/main");
});

test("a repository without commits has no head to start a worktree from", async () => {
  const dir = path.join(home, "empty-repo");
  fs.mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  const info = await gitFolderInfo(dir);
  assert.equal(info.repo, true);
  assert.equal(info.head, undefined);
});

test("status counts changed files and the commits only the worktree's branch has", async () => {
  const root = repo({ ignore: false });
  const wt = worktree(root, "w1");
  let st = await worktreeStatus(target(root, "w1"));
  assert.deepEqual(
    { exists: st.exists, registered: st.registered, branch: st.branch, changed: st.changed, commits: st.commits, lock: st.lock, ignored: st.ignored },
    { exists: true, registered: true, branch: "worktree-w1", changed: 0, commits: 0, lock: undefined, ignored: false },
  );
  fs.writeFileSync(path.join(wt, "a.txt"), "changed\n");
  fs.writeFileSync(path.join(wt, "new.txt"), "new\n");
  st = await worktreeStatus(target(root, "w1"));
  assert.equal(st.changed, 2);
  git(wt, "commit", "-qam", "change a");
  st = await worktreeStatus(target(root, "w1"));
  assert.deepEqual([st.changed, st.commits], [1, 1]);
  git(root, "branch", "keep", "worktree-w1");
  assert.equal((await worktreeStatus(target(root, "w1"))).commits, 0, "a commit another branch has is not only here");
  git(root, "branch", "-D", "keep");
  fs.writeFileSync(path.join(root, ".gitignore"), ".claude/worktrees/\n");
  assert.equal((await worktreeStatus(target(root, "w1"))).ignored, true);
});

test("Claude Code's lock is told apart from one a person put, and alive only while its process runs", async () => {
  const self = startTime(process.pid);
  assert.deepEqual(lockOf(`claude session x (pid ${process.pid} start ${self})`), { claude: true, alive: true, reason: `claude session x (pid ${process.pid} start ${self})` });
  assert.equal(lockOf(`claude session x (pid ${process.pid} start 1)`).alive, false, "the same pid started at another time is another process");
  assert.equal(lockOf(`claude agent agent-a1 (pid ${process.pid})`).alive, true);
  const child = spawn(process.execPath, ["-e", ""]);
  await new Promise((r) => child.on("exit", r));
  assert.deepEqual(lockOf(`claude session x (pid ${child.pid} start 123)`), { claude: true, alive: false, reason: `claude session x (pid ${child.pid} start 123)` });
  assert.deepEqual(lockOf("moving disks"), { claude: false, alive: false, reason: "moving disks" });
  assert.deepEqual(lockOf(""), { claude: false, alive: false });
});

test("removing a clean worktree deletes its branch too", async () => {
  const root = repo();
  const wt = worktree(root, "clean");
  const done = await removeWorktree(target(root, "clean"), false);
  assert.deepEqual(done, { path: wt, branch: "worktree-clean", branchKept: false, commits: 0, discarded: 0 });
  assert.equal(fs.existsSync(wt), false);
  assert.equal(git(root, "branch", "--list", "worktree-clean"), "");
});

test("changed files go only when the user agreed to drop them", async () => {
  const root = repo();
  const wt = worktree(root, "dirty");
  fs.writeFileSync(path.join(wt, "a.txt"), "edited\n");
  fs.writeFileSync(path.join(wt, "b.txt"), "new\n");
  await assert.rejects(removeWorktree(target(root, "dirty"), false), /worktree has work to keep/);
  assert.equal(fs.existsSync(path.join(wt, "b.txt")), true);
  const done = await removeWorktree(target(root, "dirty"), true);
  assert.deepEqual(done, { path: wt, branch: "worktree-dirty", branchKept: false, commits: 0, discarded: 2 });
  assert.equal(fs.existsSync(wt), false);
});

test("a branch with commits no other branch or remote has stays", async () => {
  const root = repo();
  const wt = worktree(root, "work");
  fs.writeFileSync(path.join(wt, "c.txt"), "c\n");
  git(wt, "add", "c.txt");
  git(wt, "commit", "-qm", "c");
  await assert.rejects(removeWorktree(target(root, "work"), false), /worktree has work to keep/);
  const done = await removeWorktree(target(root, "work"), true);
  assert.deepEqual(done, { path: wt, branch: "worktree-work", branchKept: true, commits: 1, discarded: 0 });
  assert.equal(fs.existsSync(wt), false);
  assert.match(git(root, "log", "--oneline", "-1", "worktree-work"), / c$/m);

  const pushed = worktree(root, "pushed");
  fs.writeFileSync(path.join(pushed, "d.txt"), "d\n");
  git(pushed, "add", "d.txt");
  git(pushed, "commit", "-qm", "d");
  const bare = path.join(home, `pushed${repos}.git`);
  git(home, "init", "-q", "--bare", bare);
  git(root, "remote", "add", "origin", bare);
  git(pushed, "push", "-q", "origin", "worktree-pushed");
  const gone = await removeWorktree(target(root, "pushed"), false);
  assert.deepEqual([gone.branchKept, gone.commits], [false, 0], "a pushed branch holds nothing only here");
});

test("each new file counts, also those in a new folder git lists as one", async () => {
  const root = repo();
  const wt = worktree(root, "newdir");
  fs.mkdirSync(path.join(wt, "src", "feature"), { recursive: true });
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(wt, "src", "feature", `f${i}.ts`), `export const f${i} = ${i};\n`);
  fs.writeFileSync(path.join(wt, "a.txt"), "edited\n");
  assert.equal((await worktreeStatus(target(root, "newdir"))).changed, 7);
  const done = await removeWorktree(target(root, "newdir"), true);
  assert.equal(done.discarded, 7);
});

test("a branch of the user's checked out in the worktree stays; only the worktree's own branch is judged", async () => {
  const root = repo();
  git(root, "branch", "release-1.2");
  const bare = path.join(home, `release${repos}.git`);
  git(home, "init", "-q", "--bare", bare);
  git(root, "remote", "add", "origin", bare);
  git(root, "push", "-q", "-u", "origin", "release-1.2");
  const wt = worktree(root, "fix");
  git(wt, "checkout", "-q", "release-1.2");
  const st = await worktreeStatus(target(root, "fix"));
  assert.deepEqual([st.branch, st.checkedOut, st.commits, st.changed], ["worktree-fix", "release-1.2", 0, 0]);
  const done = await removeWorktree(target(root, "fix"), false);
  assert.deepEqual(done, { path: wt, branch: "worktree-fix", branchKept: false, commits: 0, discarded: 0, checkedOut: "release-1.2" });
  assert.match(git(root, "branch", "--list", "release-1.2"), /release-1\.2/);
  assert.equal(git(root, "config", "branch.release-1.2.merge").trim(), "refs/heads/release-1.2", "its upstream stays too");
  assert.equal(git(root, "branch", "--list", "worktree-fix"), "");

  const wt2 = worktree(root, "fix2");
  fs.writeFileSync(path.join(wt2, "f.txt"), "f\n");
  git(wt2, "add", "f.txt");
  git(wt2, "commit", "-qm", "own work");
  git(wt2, "checkout", "-q", "release-1.2");
  const st2 = await worktreeStatus(target(root, "fix2"));
  assert.deepEqual([st2.branch, st2.checkedOut, st2.commits], ["worktree-fix2", "release-1.2", 1], "the own branch's commit counts though another branch is checked out");
  const kept = await removeWorktree(target(root, "fix2"), true);
  assert.deepEqual([kept.branch, kept.branchKept, kept.commits, kept.checkedOut], ["worktree-fix2", true, 1, "release-1.2"]);
});

test("commits made on a detached HEAD stay on the worktree's own branch, or keep the worktree when it cannot take them", async () => {
  const root = repo();
  const wt = worktree(root, "detached");
  git(wt, "checkout", "-q", "--detach");
  fs.writeFileSync(path.join(wt, "work.txt"), "an hour of work\n");
  git(wt, "add", "work.txt");
  git(wt, "commit", "-qm", "detached work");
  const sha = git(wt, "rev-parse", "HEAD").trim();
  const st = await worktreeStatus(target(root, "detached"));
  assert.deepEqual([st.branch, st.checkedOut, st.commits, st.stranded], ["worktree-detached", undefined, 1, undefined]);
  await assert.rejects(removeWorktree(target(root, "detached"), false), /worktree has work to keep/);
  const done = await removeWorktree(target(root, "detached"), true);
  assert.deepEqual(done, { path: wt, branch: "worktree-detached", branchKept: true, commits: 1, discarded: 0 });
  assert.equal(git(root, "rev-parse", "worktree-detached").trim(), sha);

  const wt2 = worktree(root, "gone-branch");
  git(wt2, "checkout", "-q", "--detach");
  git(root, "branch", "-D", "worktree-gone-branch");
  fs.writeFileSync(path.join(wt2, "w.txt"), "w\n");
  git(wt2, "add", "w.txt");
  git(wt2, "commit", "-qm", "work without a branch");
  assert.deepEqual((await worktreeStatus(target(root, "gone-branch"))).branch, "worktree-gone-branch", "the branch to be made is named");
  const made = await removeWorktree(target(root, "gone-branch"), true);
  assert.deepEqual([made.branch, made.branchKept, made.commits], ["worktree-gone-branch", true, 1]);
  assert.equal(git(root, "rev-parse", "worktree-gone-branch").trim(), git(root, "rev-list", "-1", "--all", "--grep=work without a branch").trim());

  const wt3 = worktree(root, "split");
  fs.writeFileSync(path.join(wt3, "b.txt"), "b\n");
  git(wt3, "add", "b.txt");
  git(wt3, "commit", "-qm", "on the branch");
  git(wt3, "checkout", "-q", "--detach", "main");
  fs.writeFileSync(path.join(wt3, "c.txt"), "c\n");
  git(wt3, "add", "c.txt");
  git(wt3, "commit", "-qm", "beside the branch");
  const split = await worktreeStatus(target(root, "split"));
  assert.deepEqual([split.branch, split.commits, split.stranded], ["worktree-split", 1, 1]);
  await assert.rejects(removeWorktree(target(root, "split"), true), /worktree has commits on no branch/);
  assert.equal(fs.existsSync(wt3), true);

  const wt4 = worktree(root, "looked");
  git(wt4, "checkout", "-q", "--detach");
  const clean = await worktreeStatus(target(root, "looked"));
  assert.deepEqual([clean.branch, clean.commits, clean.stranded], ["worktree-looked", 0, undefined], "a detached HEAD with nothing of its own is no work");
  assert.deepEqual(await removeWorktree(target(root, "looked"), false), { path: wt4, branch: "worktree-looked", branchKept: false, commits: 0, discarded: 0 });
});

test("a lock Claude Code left behind is lifted; a person's lock or a live process keeps the worktree", async () => {
  const root = repo();
  const child = spawn(process.execPath, ["-e", ""]);
  await new Promise((r) => child.on("exit", r));
  const stale = worktree(root, "stale", `claude session stale (pid ${child.pid} start 42)`);
  assert.deepEqual((await worktreeStatus(target(root, "stale"))).lock, { claude: true, alive: false, reason: `claude session stale (pid ${child.pid} start 42)` });
  await removeWorktree(target(root, "stale"), false);
  assert.equal(fs.existsSync(stale), false);

  const held = worktree(root, "held", "keep this");
  await assert.rejects(removeWorktree(target(root, "held"), true), /worktree is locked: keep this/);
  assert.equal(fs.existsSync(held), true);
  const plainLock = worktree(root, "plain-lock", "");
  await assert.rejects(removeWorktree(target(root, "plain-lock"), true), /worktree is locked/);
  assert.equal(fs.existsSync(plainLock), true);

  const live = worktree(root, "live", `claude session live (pid ${process.pid} start ${startTime(process.pid)})`);
  await assert.rejects(removeWorktree(target(root, "live"), true), /worktree is in use/);
  assert.equal(fs.existsSync(live), true);
});

test("a worktree folder git does not know is left alone; a registered one whose folder is gone is cleared", async () => {
  const root = repo();
  const stray = names.worktreePath(root, "stray");
  fs.mkdirSync(stray, { recursive: true });
  await assert.rejects(removeWorktree(target(root, "stray"), true), /not a registered worktree/);
  assert.equal(fs.existsSync(stray), true);

  const wt = worktree(root, "vanished");
  fs.rmSync(wt, { recursive: true });
  const st = await worktreeStatus(target(root, "vanished"));
  assert.deepEqual([st.exists, st.registered, st.changed], [false, true, 0]);
  await removeWorktree(target(root, "vanished"), false);
  assert.doesNotMatch(git(root, "worktree", "list", "--porcelain"), /vanished/);
  assert.equal(git(root, "branch", "--list", "worktree-vanished"), "");
});

test("the last worktree-state row of a transcript tells where a session works and was made from", async () => {
  const file = path.join(home, "t.jsonl");
  const state = { originalCwd: "/r", worktreePath: "/r/.claude/worktrees/x", worktreeName: "x", worktreeBranch: "worktree-x" };
  fs.writeFileSync(file, [{ type: "worktree-state", sessionId: "s", worktreeSession: state }, { type: "user", cwd: "/r/.claude/worktrees/x" }].map((r) => JSON.stringify(r)).join("\n") + "\n");
  assert.deepEqual(await worktreeState(file), state);
  fs.appendFileSync(file, JSON.stringify({ type: "worktree-state", sessionId: "s", worktreeSession: null }) + "\n");
  assert.equal(await worktreeState(file), null);
  assert.equal(await worktreeState(path.join(home, "none.jsonl")), undefined);
  assert.deepEqual(worktreeTarget("/r/.claude/worktrees/x", state), { path: "/r/.claude/worktrees/x", root: "/r", name: "x", branch: "worktree-x" });
  assert.deepEqual(worktreeTarget("/elsewhere", state), { path: "/r/.claude/worktrees/x", root: "/r", name: "x", branch: "worktree-x" });
  assert.equal(worktreeTarget("/r", null), undefined);
});
