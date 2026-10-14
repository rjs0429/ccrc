import assert from "node:assert/strict";
import { test } from "node:test";
import { looksLikeFile } from "../../web/src/components/filePaths.ts";

const roots = ["/home/u/proj"];

test("tool input values become file links only when they read as files", () => {
  const files = [
    "/home/u/other/notes.md",
    "/etc/nginx/nginx.conf",
    "src/main.ts",
    "web/src/components/tools/parts.tsx",
    "./build",
    "../README",
    "~/.bashrc",
    "~/bin/tool",
    "/home/u/proj/Makefile",
    "/home/u/proj/bin/ccrc-wrapper",
    "/srv/app/.env",
    "/tmp/archive.tar.gz",
  ];
  for (const v of files) assert.equal(looksLikeFile(v, roots), true, v);
  const text = [
    "/api/v1/x",
    "/api/v1/users/42",
    "/usr/local/bin",
    "https://example.com/a.html",
    "file:///etc/passwd",
    "mailto:a@b.c",
    "input/output",
    "v1.2/v1.3",
    "README.md",
    "Node.js",
    "hello",
    "and/or then this.txt",
    "src/**/*.ts",
    "/home/u/proj/",
    "/home/u/project/x",
    ".",
    "..",
    "line one\nline two.md",
    " /home/u/proj/a.ts",
    "",
  ];
  for (const v of text) assert.equal(looksLikeFile(v, roots), false, JSON.stringify(v));
});

test("a value under a path key may be a bare file name or contain spaces", () => {
  assert.equal(looksLikeFile("README.md", roots, true), true);
  assert.equal(looksLikeFile("/home/u/My Notes/plan.md", roots, true), true);
  assert.equal(looksLikeFile("/home/u/My Notes/plan.md", roots), false);
  assert.equal(looksLikeFile("dist", roots, true), false);
  assert.equal(looksLikeFile("/api/v1/x", roots, true), false);
  assert.equal(looksLikeFile("/home/u/proj", roots, true), false, "the session folder itself is a folder");
  assert.equal(looksLikeFile("/home/u/proj/src", [], true), false);
});
