import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { UnreadStore } from "../src/sessions/unread-store.ts";
import { tempDir } from "./helpers.ts";

const A = "3b9e2f10-4c5d-4e6f-8a7b-9c0d1e2f3a4b";
const B = "4c0f3a21-5d6e-4f70-9b8c-0d1e2f3a4b5c";
const DAY = 24 * 3600_000;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("unread sessions are read back by the next broker, private to the user, and leave once seen", () => {
  const file = path.join(tempDir(), "state", "unread.json");
  let now = 1000;
  const store = new UnreadStore(file, () => now);
  assert.equal(store.mark(A), true);
  now = 2000;
  assert.equal(store.mark(A), false, "already unread; the time moves on");
  store.mark(B);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { [A]: 2000, [B]: 2000 });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["unread.json"], "no temporary file is left");
  const again = new UnreadStore(file, () => now);
  assert.deepEqual(again.ids().sort(), [A, B].sort());
  assert.equal(again.seen(A), true);
  assert.equal(again.seen(A), false);
  assert.deepEqual(new UnreadStore(file, () => now).ids(), [B]);
});

test("a sight from before a session became unread reads nothing", () => {
  let now = 5000;
  const store = new UnreadStore(undefined, () => now);
  store.mark(A);
  assert.equal(store.seen(A, 4999), false, "VS Code's message from before the turn ended");
  assert.ok(store.has(A));
  assert.equal(store.seen(A, 5000), true);
  now = 6000;
  assert.equal(store.seen(B), false, "a read session stays read");
});

test("a damaged or foreign file reads as nothing unread, odd entries are skipped, and a file that cannot be written is logged", () => {
  const dir = tempDir();
  const file = path.join(dir, "unread.json");
  fs.writeFileSync(file, "not json");
  assert.deepEqual(new UnreadStore(file).ids(), []);
  fs.writeFileSync(file, JSON.stringify([A]));
  assert.deepEqual(new UnreadStore(file).ids(), []);
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify({ [A]: now, "../escape": now, [B]: "today", other: now }));
  const store = new UnreadStore(file, () => now);
  assert.deepEqual(store.ids(), [A]);
  store.seen(A);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {}, "odd entries are not written back");

  fs.writeFileSync(path.join(dir, "blocker"), "");
  const logs: string[] = [];
  const stuck = new UnreadStore(path.join(dir, "blocker", "unread.json"), () => now, (line) => logs.push(line));
  stuck.mark(A);
  assert.ok(stuck.has(A), "kept in memory");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^unread: cannot save /);
});

test("only the latest 500 sessions and the last month are kept; sessions whose transcript is gone leave", () => {
  const file = path.join(tempDir(), "unread.json");
  const now = 100 * DAY;
  fs.writeFileSync(file, JSON.stringify(Object.fromEntries(Array.from({ length: 500 }, (_, n) => [id(n + 1), now - n]))));
  const store = new UnreadStore(file, () => now);
  store.mark(A);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))).length, 500);
  assert.ok(store.has(A) && store.has(id(1)) && !store.has(id(500)), "the oldest one went");

  let later = now;
  const month = new UnreadStore(undefined, () => later);
  month.mark(B);
  later = now + 30 * DAY;
  assert.ok(month.has(B));
  later += 1;
  assert.deepEqual(month.ids(), [], "older than a month");

  const pruned = new UnreadStore(undefined, () => now);
  pruned.mark(A);
  pruned.mark(B);
  pruned.prune((s) => s === A);
  assert.deepEqual(pruned.ids(), [A]);
});
