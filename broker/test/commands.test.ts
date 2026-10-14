import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CommandMemory } from "../src/sessions/commands.ts";
import { tempDir } from "./helpers.ts";

const A = [{ name: "context", description: "Show current context usage" }];
const B = [{ name: "compact", description: "Free up context", argumentHint: "<instructions>" }];

test("the last command list is kept per folder and overall, across restarts", () => {
  const file = path.join(tempDir(), "commands.json");
  const m = new CommandMemory(file);
  assert.deepEqual(m.last("/p/a"), []);
  m.remember("/p/a", A);
  m.remember("/p/b", B);
  assert.deepEqual(m.last("/p/a"), A);
  assert.deepEqual(m.last("/p/unknown"), B, "a folder never seen gets the latest list");
  const again = new CommandMemory(file);
  assert.deepEqual(again.last("/p/a"), A);
  assert.deepEqual(again.last("/p/b"), B);
  assert.deepEqual(again.last("/p/c"), B);
  again.remember("/p/a", []);
  assert.deepEqual(again.last("/p/a"), A, "an empty list does not replace a known one");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("an unchanged list is not written again, and old folders are dropped", () => {
  const file = path.join(tempDir(), "commands.json");
  const m = new CommandMemory(file);
  m.remember("/p/a", A);
  const before = fs.statSync(file).mtimeMs;
  fs.utimesSync(file, new Date(0), new Date(0));
  m.remember("/p/a", A);
  assert.equal(fs.statSync(file).mtimeMs, 0);
  assert.ok(before > 0);
  for (let i = 0; i < 40; i++) m.remember(`/p/${i}`, i % 2 ? A : B);
  const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { folders: [string, unknown][] };
  assert.equal(saved.folders.length, 30);
  assert.equal(saved.folders.at(-1)?.[0], "/p/39");
});

test("a damaged file starts empty", () => {
  const file = path.join(tempDir(), "commands.json");
  fs.writeFileSync(file, "{not json");
  assert.deepEqual(new CommandMemory(file).last("/p/a"), []);
  fs.writeFileSync(file, JSON.stringify({ last: [{ name: 3 }, { name: "ok", description: 5 }], folders: [["/p/a", "nope"], [7, []]] }));
  const m = new CommandMemory(file);
  assert.deepEqual(m.last("/p/b"), [{ name: "ok", description: "" }]);
  assert.deepEqual(m.last("/p/a"), [{ name: "ok", description: "" }]);
});
