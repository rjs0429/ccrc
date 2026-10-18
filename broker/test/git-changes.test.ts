import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { GitChanges, GitFileChange } from "../src/protocol.ts";
import { brokerChanges, claudeChanges, parseHunks } from "../src/sessions/git-changes.ts";
import { tempDir } from "./helpers.ts";

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8" });
const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join("\n") + "\n";
const write = (file: string, text: string | Buffer) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const byPath = (g: GitChanges) => new Map(g.files.map((f) => [f.newPath ?? f.path, f]));

function repo(): string {
  const dir = fs.realpathSync(tempDir("ccrc-git-"));
  sh(dir, "init", "-q", "-b", "main");
  write(`${dir}/a.txt`, lines(30, "a"));
  write(`${dir}/gone.txt`, lines(3, "gone"));
  write(`${dir}/old.txt`, lines(20, "moved"));
  write(`${dir}/.env`, "TOKEN=old\n");
  write(`${dir}/big.txt`, "small\n");
  write(`${dir}/img.bin`, Buffer.from([0, 1, 2, 0, 255]));
  write(`${dir}/src/c.ts`, "export const c = 1;\n");
  write(`${dir}/twin.txt`, "one\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "base");
  return dir;
}

test("outside a repository there is nothing; mid-merge the changes wait", async () => {
  const plain = tempDir("ccrc-plain-");
  assert.deepEqual(await brokerChanges(plain, [plain]), { state: "none", files: [], via: "broker" });
  const dir = repo();
  write(`${dir}/.git/MERGE_HEAD`, "0".repeat(40) + "\n");
  const g = await brokerChanges(dir, [dir]);
  assert.equal(g.state, "busy");
  assert.equal(g.root, dir);
});

test("ccrc lists every kind of uncommitted change and shows the lines only of files it may show", async () => {
  const dir = repo();
  write(`${dir}/old-untracked.txt`, "made before the session\n");
  await new Promise((r) => setTimeout(r, 30));
  const since = Date.now();
  write(`${dir}/a.txt`, lines(30, "a").replace("a 3\n", "a 3 changed\n"));
  fs.rmSync(`${dir}/gone.txt`);
  sh(dir, "mv", "old.txt", "new.txt");
  write(`${dir}/.env`, "TOKEN=new-secret\n");
  write(`${dir}/big.txt`, lines(25_000, "big"));
  write(`${dir}/img.bin`, Buffer.from([0, 9, 9, 0, 255, 7]));
  write(`${dir}/src/c.ts`, "export const c = 2;\n");
  write(`${dir}/twin.txt`, "two\n");
  fs.linkSync(`${dir}/twin.txt`, `${dir}/twin-link.txt`);
  write(`${dir}/fresh.txt`, "made by the session\n");
  const g = await brokerChanges(dir, [dir], since);
  assert.equal(g.state, "ok");
  assert.equal(g.via, "broker");
  assert.equal(g.base, undefined, "on the default branch the changes are since HEAD");
  const f = byPath(g);
  assert.deepEqual(f.get("a.txt")?.hunks?.[0].lines.filter((l) => l[0] !== " "), ["-a 3", "+a 3 changed"]);
  assert.equal(f.get("gone.txt")?.status, "removed");
  assert.deepEqual(f.get("gone.txt")?.hunks?.[0].lines, ["-gone 1", "-gone 2", "-gone 3"]);
  const moved = f.get("new.txt") as GitFileChange;
  assert.equal(moved.status, "renamed");
  assert.equal(moved.path, "old.txt => new.txt");
  assert.equal(moved.previousPath, "old.txt");
  assert.equal(f.get(".env")?.hidden, true, "a key file's lines stay hidden");
  assert.equal(f.get(".env")?.hunks, undefined);
  assert.equal(f.get("big.txt")?.large, true);
  assert.equal(f.get("img.bin")?.binary, true);
  assert.equal(f.get("twin.txt")?.hidden, true, "a file with another name on disk stays hidden");
  assert.equal(f.get("fresh.txt")?.untracked, true);
  assert.ok(!f.has("old-untracked.txt"), "untracked files from before the session are left out");
  assert.ok(!f.has("twin-link.txt") || f.get("twin-link.txt")?.untracked);
  assert.equal(g.stats?.files, g.files.length);
  assert.ok(g.files.findIndex((x) => x.untracked) > g.files.findIndex((x) => x.path === "src/c.ts"), "untracked files come after the tracked ones");
});

test("from a folder inside the repository the other files show no lines, and without a start time no untracked file shows", async () => {
  const dir = repo();
  write(`${dir}/a.txt`, "changed\n");
  write(`${dir}/src/c.ts`, "export const c = 3;\n");
  write(`${dir}/src/new.ts`, "new\n");
  const g = await brokerChanges(path.join(dir, "src"), [path.join(dir, "src")]);
  const f = byPath(g);
  assert.equal(g.root, dir);
  assert.equal(f.get("a.txt")?.hidden, true);
  assert.ok(f.get("src/c.ts")?.hunks?.length);
  assert.ok(!f.has("src/new.ts"));
});

test("a branch ahead of its base shows what it committed and what is not committed yet, the latter first", async () => {
  const dir = repo();
  sh(dir, "checkout", "-q", "-b", "feature");
  write(`${dir}/src/c.ts`, "export const c = 10;\n");
  sh(dir, "commit", "-q", "-am", "feature work");
  sh(dir, "checkout", "-q", "main");
  write(`${dir}/main-only.txt`, "later on main\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "main moves on");
  sh(dir, "checkout", "-q", "feature");
  write(`${dir}/a.txt`, lines(30, "a").replace("a 1\n", "a 1 uncommitted\n"));
  const point = sh(dir, "merge-base", "HEAD", "main").trim();
  const g = await brokerChanges(dir, [dir]);
  assert.deepEqual(g.base, { branch: "main", ref: point });
  assert.deepEqual(
    g.files.map((x) => x.path),
    ["a.txt", "src/c.ts"],
  );
  assert.ok(!byPath(g).has("main-only.txt"), "what the base branch did since is not the branch's change");
  assert.deepEqual(byPath(g).get("src/c.ts")?.hunks?.[0].lines, ["-export const c = 1;", "+export const c = 10;"]);
});

test("a folder with many changed files lists the first ones, and one with very many gives its counts only", async () => {
  const dir = repo();
  for (let i = 0; i < 60; i++) write(`${dir}/many/f${String(i).padStart(2, "0")}.txt`, `${i}\n`);
  sh(dir, "add", "-A");
  let g = await brokerChanges(dir, [dir]);
  assert.equal(g.files.length, 50);
  assert.equal(g.more, 10);
  assert.equal(g.stats?.files, 60);
  for (let i = 0; i < 450; i++) write(`${dir}/more/g${i}.txt`, `${i}\n`);
  sh(dir, "add", "-A");
  g = await brokerChanges(dir, [dir]);
  assert.deepEqual(g.files, []);
  assert.equal(g.more, 510);
});

test("a long change keeps its first lines and counts the rest", () => {
  const body = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1,2 +1,500 @@", ...Array.from({ length: 500 }, (_, i) => `+${i}`), "\\ No newline at end of file"].join("\n");
  const { hunks, cut } = parseHunks(body);
  assert.equal(hunks[0].lines.length, 400);
  assert.equal(cut, 101);
  assert.deepEqual(hunks[0], { ...hunks[0], oldStart: 1, oldLines: 2, newStart: 1, newLines: 500 });
  assert.equal(parseHunks(`@@ -1 +1 @@\n-${"x".repeat(900)}`).hunks[0].lines[0].length, 501);
});

test("a name with glob characters shows its own lines only, never a key file's that it would match", async () => {
  const dir = repo();
  write(`${dir}/.en?`, "note old\n");
  write(`${dir}/app/[id]/page.tsx`, "export const page = 1;\n");
  write(`${dir}/app/d/page.tsx`, "export const d = 1;\n");
  write(`${dir}/star*.txt`, "star old\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "glob names");
  write(`${dir}/.env`, "TOKEN=glob-secret\n");
  write(`${dir}/.en?`, "note new\n");
  write(`${dir}/app/[id]/page.tsx`, "export const page = 2;\n");
  write(`${dir}/app/d/page.tsx`, "export const d = 2;\n");
  write(`${dir}/star*.txt`, "star new\n");
  write(`${dir}/twin.txt`, "two\n");
  const g = await brokerChanges(dir, [dir]);
  const f = byPath(g);
  assert.deepEqual(f.get(".en?")?.hunks?.flatMap((h) => h.lines), ["-note old", "+note new"]);
  assert.deepEqual(f.get("app/[id]/page.tsx")?.hunks?.flatMap((h) => h.lines), ["-export const page = 1;", "+export const page = 2;"]);
  assert.deepEqual(f.get("star*.txt")?.hunks?.flatMap((h) => h.lines), ["-star old", "+star new"]);
  assert.deepEqual(f.get("twin.txt")?.hunks?.flatMap((h) => h.lines), ["-one", "+two"]);
  assert.equal(f.get(".env")?.hidden, true);
  assert.ok(!JSON.stringify(g).includes("glob-secret"), "the key file's value is nowhere in the answer");
});

test("a path that changed its type shows both of its parts", async () => {
  const dir = repo();
  fs.symlinkSync("a.txt", `${dir}/link`);
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "a link");
  fs.rmSync(`${dir}/link`);
  write(`${dir}/link`, "now a file\n");
  const f = byPath(await brokerChanges(dir, [dir])).get("link");
  assert.deepEqual(f?.hunks?.map((h) => h.lines), [["-a.txt", "\\ No newline at end of file"], ["+now a file"]]);
  assert.equal(f?.large, undefined);
});

test("a hunk takes only the lines its header counts, and a second file in the text is counted", () => {
  const body = [
    "diff --git a/x.sql b/x.sql",
    "index 1111111..2222222 100644",
    "--- a/x.sql",
    "+++ b/x.sql",
    "@@ -1,2 +1,2 @@",
    "--- a comment",
    "+++ a heading",
    " select 1;",
    "diff --git a/y b/y",
    "--- a/y",
    "+++ b/y",
    "@@ -1 +1 @@",
    "-y old",
    "+y new",
    "",
  ].join("\n");
  const { hunks, files } = parseHunks(body);
  assert.equal(files, 2);
  assert.deepEqual(
    hunks.map((h) => h.lines),
    [["--- a comment", "+++ a heading", " select 1;"], ["-y old", "+y new"]],
  );
});

// The answer Claude Code 2.1.301 gave for a repository with these changes, trimmed.
const ANSWER = {
  diff: {
    stats: { filesCount: 60, linesAdded: 20005, linesRemoved: 8 },
    perFileStats: [
      { path: ".env", added: 1, removed: 1, isBinary: false, isUntracked: false, status: "modified" },
      { path: "a.txt", added: 1, removed: 1, isBinary: false, isUntracked: false, status: "modified" },
      { path: "big.txt", added: 20001, removed: 1, isBinary: false, isUntracked: false, status: "modified" },
      { path: "img.bin", added: 0, removed: 0, isBinary: true, isUntracked: false, status: "modified" },
      { path: "old.txt => new.txt", added: 0, removed: 0, isBinary: false, isUntracked: false, status: "renamed", previousPath: "old.txt", newPath: "new.txt" },
      { path: "elsewhere.txt", added: 1, removed: 0, isBinary: false, isUntracked: false, status: "weird" },
      { path: "fresh.txt", added: 0, removed: 0, isBinary: false, isUntracked: true, status: "added" },
    ],
    hunks: [
      { path: ".env", hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-TOKEN=old", "+TOKEN=new-secret"] }] },
      { path: "a.txt", hunks: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ["-a 3", "+a 3 changed", 7] }] },
    ],
    skippedLarge: ["big.txt"],
    restricted: ["elsewhere.txt"],
    source: { kind: "branch", baseBranch: "main", baseRef: "0123456789abcdef0123456789abcdef01234567" },
  },
};

test("Claude Code's answer comes through with its read rules and ccrc's key-file rule both applied", async () => {
  const dir = repo();
  const g = (await claudeChanges(ANSWER, dir, [dir])) as GitChanges;
  assert.equal(g.via, "claude");
  assert.equal(g.root, dir);
  assert.deepEqual(g.base, { branch: "main", ref: "0123456789abcdef0123456789abcdef01234567" });
  assert.deepEqual(g.stats, { files: 60, added: 20005, removed: 8 });
  assert.equal(g.more, 53);
  const f = new Map(g.files.map((x) => [x.path, x]));
  assert.equal(f.get(".env")?.hidden, true);
  assert.equal(f.get(".env")?.hunks, undefined, "Claude Code served the key file; ccrc does not");
  assert.deepEqual(f.get("a.txt")?.hunks?.[0].lines, ["-a 3", "+a 3 changed"]);
  assert.equal(f.get("big.txt")?.large, true);
  assert.equal(f.get("img.bin")?.binary, true);
  assert.equal(f.get("old.txt => new.txt")?.newPath, "new.txt");
  assert.equal(f.get("elsewhere.txt")?.hidden, true);
  assert.equal(f.get("elsewhere.txt")?.status, "modified", "an unknown status reads as modified");
  assert.equal(f.get("fresh.txt")?.untracked, true);
  assert.equal(f.get("fresh.txt")?.hidden, undefined);
});

test("no diff from Claude Code leaves it to ccrc", async () => {
  assert.equal(await claudeChanges({ diff: null }, "/", ["/"]), undefined);
  assert.equal(await claudeChanges({}, "/", ["/"]), undefined);
  assert.equal(await claudeChanges("nonsense", "/", ["/"]), undefined);
});
