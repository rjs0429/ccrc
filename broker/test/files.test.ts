import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { listFiles, rankFiles, searchFiles } from "../src/sessions/files.ts";
import { tempDir } from "./helpers.ts";

function tree(files: string[]): string {
  const dir = tempDir();
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), f);
  }
  return dir;
}

test("a git folder lists tracked and untracked files but not ignored ones", async () => {
  const dir = tree([".gitignore", "src/main.ts", "notes/회의 메모.md", "out/app.js", "secret.log"]);
  fs.writeFileSync(path.join(dir, ".gitignore"), "out/\n*.log\n");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "src/main.ts"], { cwd: dir });
  assert.deepEqual((await listFiles(dir)).sort(), [".gitignore", "notes/회의 메모.md", "src/main.ts"]);
  assert.deepEqual((await listFiles(path.join(dir, "src"))).sort(), ["main.ts"], "paths are relative to the session folder");
});

test("outside git the walk skips build and dependency folders and stops at depth 8", async () => {
  const deep = `${"d/".repeat(8)}too-deep.txt`;
  const dir = tree(["a.txt", "lib/b.ts", "node_modules/x/index.js", "dist/c.js", ".venv/bin/python", "__pycache__/m.pyc", `${"d/".repeat(7)}deep.txt`, deep]);
  fs.symlinkSync(path.join(dir, "lib"), path.join(dir, "link"));
  assert.deepEqual((await listFiles(dir)).sort(), ["a.txt", `${"d/".repeat(7)}deep.txt`, "lib/b.ts"]);
});

test("ranking favours file name hits, runs of characters and short paths", () => {
  const files = [
    "broker/test/relay.test.ts",
    "broker/src/wrapper/relay.ts",
    "web/src/labels.ts",
    "broker/src/sessions/core.ts",
    "core/index.ts",
    "a/b/c/deep/util.ts",
    "util.ts",
    "x/axbxc.txt",
    "x/abc.txt",
  ];
  assert.deepEqual(rankFiles(files, "relay").slice(0, 2), ["broker/src/wrapper/relay.ts", "broker/test/relay.test.ts"]);
  assert.equal(rankFiles(files, "core")[0], "broker/src/sessions/core.ts");
  assert.deepEqual(rankFiles(files, "util"), ["util.ts", "a/b/c/deep/util.ts"]);
  assert.equal(rankFiles(files, "abc")[0], "x/abc.txt");
  assert.equal(rankFiles(files, "bsw")[0], "broker/src/wrapper/relay.ts");
  assert.deepEqual(rankFiles(files, "zzz"), []);
});

test("an empty query lists the most recently changed files", async () => {
  const dir = tree(["old.txt", "mid/b.txt", "new.md"]);
  const at = (f: string, minutesAgo: number) => {
    const t = new Date(Date.now() - minutesAgo * 60_000);
    fs.utimesSync(path.join(dir, f), t, t);
  };
  at("old.txt", 30);
  at("mid/b.txt", 20);
  at("new.md", 10);
  assert.deepEqual(await searchFiles(dir, ""), ["new.md", "mid/b.txt", "old.txt"]);
  assert.deepEqual(await searchFiles(dir, "b"), ["mid/b.txt"]);
  await assert.rejects(searchFiles(dir, "x".repeat(300)), /invalid request/);
});

test("results are capped", async () => {
  const dir = tree(Array.from({ length: 40 }, (_, i) => `f${i}.txt`));
  assert.equal((await searchFiles(dir, "f")).length, 30);
  assert.equal((await searchFiles(dir, "")).length, 30);
});
