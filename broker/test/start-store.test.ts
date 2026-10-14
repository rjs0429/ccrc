import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { StartStore } from "../src/sessions/start-store.ts";
import { tempDir } from "./helpers.ts";

const A = "3b9e2f10-4c5d-4e6f-8a7b-9c0d1e2f3a4b";
const B = "4c0f3a21-5d6e-4f70-9b8c-0d1e2f3a4b5c";
const DAY = 24 * 60 * 60 * 1000;

test("start settings are read back by the next broker, expire after a few days and go once cleared", () => {
  const file = path.join(tempDir(), "start-settings.json");
  let now = 1_000_000;
  const clock = () => now;
  new StartStore(file, clock).set(A, { model: "sonnet", mode: "plan", effort: "high", ultracode: true });
  new StartStore(file, clock).set(B, { effort: "low" });
  const again = new StartStore(file, clock);
  assert.deepEqual(again.get(A), { model: "sonnet", mode: "plan", effort: "high", ultracode: true });
  assert.deepEqual(again.get(B), { effort: "low" });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  again.delete(B);
  assert.equal(new StartStore(file, clock).get(B), undefined);

  now += 2 * DAY;
  assert.deepEqual(new StartStore(file, clock).get(A), { model: "sonnet", mode: "plan", effort: "high", ultracode: true });
  now += 2 * DAY;
  const late = new StartStore(file, clock);
  assert.equal(late.get(A), undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {});
});

test("saved start settings that do not validate are ignored", () => {
  const file = path.join(tempDir(), "start-settings.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      [A]: { at: 5, start: { model: "--dangerously-skip-permissions", mode: "bypassPermissions", effort: "huge", ultracode: "yes" } },
      [B]: { at: 5, start: { mode: "acceptEdits", env: { X: "1" } } },
      "../escape": { at: 5, start: { model: "sonnet" } },
    }),
  );
  const store = new StartStore(file, () => 10);
  assert.equal(store.get(A), undefined);
  assert.deepEqual(store.get(B), { mode: "acceptEdits" });
  assert.equal(store.get("../escape"), undefined);
  fs.writeFileSync(file, "not json");
  assert.equal(new StartStore(file, () => 10).get(B), undefined);
});
