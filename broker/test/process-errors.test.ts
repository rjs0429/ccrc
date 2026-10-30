import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { watchProcessErrors } from "../src/process-errors.ts";

test("a promise that failed with nothing waiting is logged once a minute for each error, and the broker goes on", () => {
  const proc = new EventEmitter();
  const logs: string[] = [];
  const exits: number[] = [];
  let now = 1_000_000;
  watchProcessErrors(
    proc,
    (l) => logs.push(l),
    (c) => exits.push(c),
    () => now,
  );
  proc.emit("unhandledRejection", Error("transcript gone"));
  proc.emit("unhandledRejection", Error("transcript gone"));
  proc.emit("unhandledRejection", "a reason that is no error");
  now += 61_000;
  proc.emit("unhandledRejection", Error("transcript gone"));
  assert.equal(logs.length, 3);
  assert.match(logs[0], /^ccrc: a promise failed with nothing waiting for it: Error: transcript gone\n\s+at /);
  assert.equal(logs[1], "ccrc: a promise failed with nothing waiting for it: a reason that is no error");
  assert.deepEqual(exits, []);
});

test("an exception nothing caught is logged with its stack and ends the broker with code 1", () => {
  const proc = new EventEmitter();
  const logs: string[] = [];
  const exits: number[] = [];
  watchProcessErrors(
    proc,
    (l) => logs.push(l),
    (c) => exits.push(c),
  );
  proc.emit("uncaughtException", new TypeError("x is not a function"));
  assert.deepEqual(exits, [1]);
  assert.match(logs[0], /^ccrc: stopping on an exception nothing caught: TypeError: x is not a function\n\s+at /);
});
