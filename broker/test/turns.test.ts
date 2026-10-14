import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CONTINUE_ENV, TurnStore } from "../src/wrapper/turns.ts";
import { tempDir } from "./helpers.ts";

function store(alive: Set<number>, clock = { t: 1_000_000 }, dir = tempDir()) {
  return new TurnStore({ dir, now: () => clock.t, processStart: (pid) => (alive.has(pid) ? `start-${pid}` : undefined), hostExitWaitMs: 200 });
}

test("a cut-off turn continues once its VS Code process is gone, at most twice in a row", async () => {
  const alive = new Set([2]);
  const s = store(alive);
  s.cut("a", 1);
  assert.deepEqual(await s.continueEnv("a", 2), CONTINUE_ENV);
  assert.equal(await s.continueEnv("a", 2), undefined, "a note is used once");
  s.cut("a", 1);
  assert.deepEqual(await s.continueEnv("a", 2), CONTINUE_ENV);
  s.cut("a", 1);
  assert.equal(await s.continueEnv("a", 2), undefined, "third time in a row");
  s.completed("a");
  s.cut("a", 1);
  assert.deepEqual(await s.continueEnv("a", 2), CONTINUE_ENV, "a completed turn starts the count again");
});

test("a cut-off turn waits briefly for the old VS Code process to exit", async () => {
  const alive = new Set([1, 2]);
  const s = store(alive);
  s.cut("b", 1);
  setTimeout(() => alive.delete(1), 50);
  assert.deepEqual(await s.continueEnv("b", 2), CONTINUE_ENV);
  s.cut("c", 2);
  alive.add(3);
  assert.equal(await s.continueEnv("c", 3), undefined, "the old process is still there");
});

test("a cut-off turn is not continued by the same VS Code process or after an hour", async () => {
  const clock = { t: 1_000_000 };
  const s = store(new Set([1, 2]), clock);
  s.cut("d", 2);
  assert.equal(await s.continueEnv("d", 2), undefined);
  const late = store(new Set([2]), clock);
  late.cut("e", 1);
  clock.t += 60 * 60_000 + 1;
  assert.equal(await late.continueEnv("e", 2), undefined);
});

test("session ids that are not plain names are ignored", async () => {
  const s = store(new Set([2]));
  s.cut("../escape", 1);
  assert.equal(await s.continueEnv("../escape", 2), undefined);
});

test("notes older than a day are removed when a new one is written", () => {
  const dir = tempDir();
  const s = store(new Set([2]), undefined, dir);
  s.cut("old", 1);
  const day = 25 * 60 * 60;
  fs.utimesSync(path.join(dir, "old.json"), Date.now() / 1000 - day, Date.now() / 1000 - day);
  s.cut("new", 1);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["new.json"]);
});

test("a note folder that cannot be written continues nothing and stops nothing", async () => {
  const dir = tempDir();
  const s = store(new Set([2]), undefined, dir);
  s.cut("f", 1);
  fs.chmodSync(dir, 0o500);
  try {
    assert.equal(await s.continueEnv("f", 2), undefined);
    assert.doesNotThrow(() => s.completed("f"));
  } finally {
    fs.chmodSync(dir, 0o700);
  }
});
