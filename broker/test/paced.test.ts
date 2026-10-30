import assert from "node:assert/strict";
import { test } from "node:test";
import { paced } from "../src/sessions/paced.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a job is run again no sooner than three times its last run's length after it ended, once for the calls meanwhile", async () => {
  const runs: { start: number; end: number }[] = [];
  const p = paced(async () => {
    const start = Date.now();
    await sleep(40);
    runs.push({ start, end: Date.now() });
  }, 3);
  p.run();
  await sleep(10);
  p.run();
  p.run();
  await sleep(60);
  p.run();
  await sleep(400);
  p.stop();
  assert.equal(runs.length, 2, "the calls while it ran and after it made one more run");
  const gap = runs[1].start - runs[0].end;
  const took = runs[0].end - runs[0].start;
  assert.ok(gap >= 3 * took - 5, `waited ${gap} ms after a run of ${took} ms`);
});

test("a quick job runs at each call, and a stopped one never again", async () => {
  let n = 0;
  const p = paced(() => {
    n++;
  }, 3);
  p.run();
  await sleep(5);
  p.run();
  await sleep(5);
  assert.equal(n, 2);
  let slow = 0;
  const q = paced(async () => {
    slow++;
    await sleep(30);
  }, 3);
  q.run();
  await sleep(40);
  q.run();
  q.stop();
  await sleep(150);
  assert.equal(slow, 1, "the run that waited was dropped");
});

test("a job that fails is paced like one that worked", async () => {
  let n = 0;
  const p = paced(async () => {
    n++;
    throw Error("transcript gone");
  }, 3);
  p.run();
  await sleep(5);
  p.run();
  await sleep(20);
  p.stop();
  assert.equal(n, 2);
});
