import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { RemoteActivity } from "../src/remote-activity.ts";
import { tempDir } from "./helpers.ts";

const id = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DAY = 24 * 3600_000;

test("the remote user's last activity per session is kept in a private file a new broker reads", () => {
  const file = path.join(tempDir(), "state", "remote-activity.json");
  let now = 1_000_000;
  const a = new RemoteActivity(file, () => now);
  assert.equal(a.get(id(1)), undefined);
  a.note(id(1));
  now += 5000;
  a.note(id(2));
  assert.equal(a.get(id(1)), 1_000_000);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { [id(1)]: 1_000_000, [id(2)]: 1_005_000 });
  const next = new RemoteActivity(file, () => now);
  assert.equal(next.get(id(2)), 1_005_000);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["remote-activity.json"], "no temporary file is left");
});

test("activity is kept a day and for the latest 200 sessions", () => {
  const file = path.join(tempDir(), "remote-activity.json");
  let now = 10 * DAY;
  const a = new RemoteActivity(file, () => now);
  a.note(id(0));
  now += DAY + 1;
  assert.equal(a.get(id(0)), undefined, "a day old");
  for (let n = 1; n <= 201; n++) {
    now += 1;
    a.note(id(n));
  }
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(Object.keys(saved).length, 200);
  assert.equal(saved[id(0)], undefined);
  assert.equal(saved[id(1)], undefined, "the oldest of 201 goes");
  assert.ok(saved[id(201)]);
  a.note(id(2));
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))).at(-1), id(2), "noting a session again makes it the latest");
});

test("a broken file, keys that are not session ids and values that are not times are dropped", () => {
  const dir = tempDir();
  const file = path.join(dir, "remote-activity.json");
  fs.writeFileSync(file, "{not json");
  assert.equal(new RemoteActivity(file).get(id(1)), undefined);
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify({ [id(1)]: now, "../../etc": now, [id(2)]: "soon", [id(3)]: null, [id(4)]: now - 1 }));
  const a = new RemoteActivity(file);
  assert.equal(a.get(id(1)), now);
  assert.equal(a.get(id(4)), now - 1);
  assert.equal(a.get("../../etc"), undefined);
  assert.equal(a.get(id(2)), undefined);
  a.note(id(5));
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))), [id(4), id(1), id(5)], "oldest first");
});

test("a file that cannot be written leaves the activity in memory and says so once per write", () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "blocker"), "");
  const logs: string[] = [];
  const a = new RemoteActivity(path.join(dir, "blocker", "remote-activity.json"), Date.now, (line) => logs.push(line));
  a.note(id(1));
  assert.ok(a.get(id(1)));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^remote activity: cannot save /);
  const memory = new RemoteActivity();
  memory.note(id(1));
  assert.ok(memory.get(id(1)), "without a file it lives in memory");
});
