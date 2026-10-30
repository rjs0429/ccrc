import assert from "node:assert/strict";
import { test } from "node:test";
import { ReadQueue } from "../src/sessions/read-queue.ts";

type Job = { key: string; release: () => void };

// Jobs that end when the test releases them, with how many ran at once and in what order they started.
function jobs() {
  const started: Job[] = [];
  let running = 0;
  let most = 0;
  const job = (key: string) => () =>
    new Promise<string>((resolve) => {
      running++;
      most = Math.max(most, running);
      started.push({
        key,
        release: () => {
          running--;
          resolve(key);
        },
      });
    });
  return { started, job, most: () => most };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test("at most two jobs run at once, in the order they came", async () => {
  const q = new ReadQueue(2);
  const j = jobs();
  const done = ["a", "b", "c", "d", "e"].map((k) => q.run(k, j.job(k)));
  await tick();
  assert.deepEqual(
    j.started.map((s) => s.key),
    ["a", "b"],
  );
  for (let i = 0; i < 5; i++) {
    j.started[i].release();
    await tick();
  }
  assert.deepEqual(await Promise.all(done), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(
    j.started.map((s) => s.key),
    ["a", "b", "c", "d", "e"],
  );
  assert.equal(j.most(), 2);
});

test("a waiting job for the key asked for first goes ahead of the others", async () => {
  let first: string | null = null;
  const q = new ReadQueue(1, () => first);
  const j = jobs();
  for (const k of ["a", "b", "c", "d"]) void q.run(k, j.job(k));
  await tick();
  first = "d";
  j.started[0].release();
  await tick();
  first = null;
  j.started[1].release();
  await tick();
  assert.deepEqual(
    j.started.map((s) => s.key),
    ["a", "d", "b"],
  );
});

test("a job that fails or throws gives its error to its caller and lets the next one start", async () => {
  const q = new ReadQueue(1);
  const failing = q.run("x", async () => {
    throw Error("no transcript");
  });
  const throwing = q.run("y", () => {
    throw Error("at once");
  });
  const fine = q.run("z", async () => "read");
  await assert.rejects(failing, { message: "no transcript" });
  await assert.rejects(throwing, { message: "at once" });
  assert.equal(await fine, "read");
});
