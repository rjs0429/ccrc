import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ArchiveStore, transcriptIds } from "../src/sessions/archive-store.ts";
import { tempDir } from "./helpers.ts";

const A = "3b9e2f10-4c5d-4e6f-8a7b-9c0d1e2f3a4b";
const B = "4c0f3a21-5d6e-4f70-9b8c-0d1e2f3a4b5c";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("archived sessions are read back by the next broker and leave once restored", () => {
  const file = path.join(tempDir(), "archived.json");
  let now = 1000;
  const clock = () => now;
  const store = new ArchiveStore(file, clock);
  assert.equal(store.set(A, true), true);
  assert.equal(store.set(A, true), false, "archiving again changes nothing");
  now = 2000;
  store.set(B, true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { [A]: 1000, [B]: 2000 });
  const again = new ArchiveStore(file, clock);
  assert.ok(again.has(A) && again.has(B));
  assert.equal(again.set(A, false), true);
  assert.equal(again.set(A, false), false);
  assert.ok(!new ArchiveStore(file, clock).has(A));
});

test("a damaged or foreign archive file reads as an empty list, and odd entries are skipped", () => {
  const file = path.join(tempDir(), "archived.json");
  fs.writeFileSync(file, "not json");
  assert.ok(!new ArchiveStore(file).has(A));
  fs.writeFileSync(file, JSON.stringify([A]));
  assert.ok(!new ArchiveStore(file).has(A));
  fs.writeFileSync(file, JSON.stringify({ [A]: 5, "../escape": 6, [B]: "yesterday", other: 7 }));
  const store = new ArchiveStore(file, () => 9);
  assert.ok(store.has(A) && !store.has(B) && !store.has("../escape"));
  store.set(A, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {}, "odd entries are not written back");
});

test("the archive keeps the newest 5000 sessions", () => {
  const file = path.join(tempDir(), "archived.json");
  const saved = Object.fromEntries(Array.from({ length: 5000 }, (_, n) => [id(n + 1), 5000 - n]));
  fs.writeFileSync(file, JSON.stringify(saved));
  const store = new ArchiveStore(file, () => 10_000);
  store.set(A, true);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))).length, 5000);
  assert.ok(store.has(A));
  assert.ok(!store.has(id(5000)), "the oldest one went");
  assert.ok(store.has(id(1)));
});

test("sessions whose transcript is gone leave the archive; an unreadable projects folder prunes nothing", () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, "-home-u-a"));
  fs.mkdirSync(path.join(root, "-home-u-b"));
  fs.writeFileSync(path.join(root, "-home-u-a", `${A}.jsonl`), "{}\n");
  fs.writeFileSync(path.join(root, "-home-u-b", `${id(9)}.jsonl`), "{}\n");
  fs.mkdirSync(path.join(root, "-home-u-b", B));
  fs.writeFileSync(path.join(root, "loose.jsonl"), "");
  const ids = transcriptIds(root);
  assert.deepEqual([...(ids ?? [])].sort(), [A, id(9)].sort());
  assert.equal(transcriptIds(path.join(root, "missing")), undefined);

  const store = new ArchiveStore(path.join(tempDir(), "archived.json"));
  for (const s of [A, B, id(9)]) store.set(s, true);
  store.prune((s) => ids!.has(s));
  assert.deepEqual([A, B, id(9)].map((s) => store.has(s)), [true, false, true]);
});
