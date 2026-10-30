import assert from "node:assert/strict";
import { test } from "node:test";

interface Moment {
  fingers: number;
  touchedAt: number;
  calmAt: number;
  typing: boolean;
  keyboard: boolean;
  layer: boolean;
}
interface TopTap {
  statusTap: (m: Moment, left: number) => boolean;
  QUIET_MS: number;
  CALM_MS: number;
}

// The web module, loaded by a path the broker's type check does not follow (it is checked with the web's DOM types).
const file = "../../web/src/topTap.ts";
const { statusTap, QUIET_MS, CALM_MS } = (await import(file)) as TopTap;

const LEFT = 10_000;
const still: Moment = { fingers: 0, touchedAt: LEFT - QUIET_MS, calmAt: LEFT - CALM_MS, typing: false, keyboard: false, layer: false };

test("the page leaving its rest with nothing else going on is a tap on the status bar", () => {
  assert.equal(statusTap(still, LEFT), true);
  assert.equal(statusTap({ ...still, touchedAt: -Infinity, calmAt: -Infinity }, LEFT), true);
});

test("a finger on the page, or one just lifted, moved it", () => {
  assert.equal(statusTap({ ...still, fingers: 1 }, LEFT), false);
  assert.equal(statusTap({ ...still, touchedAt: LEFT - QUIET_MS + 1 }, LEFT), false);
  assert.equal(statusTap({ ...still, touchedAt: LEFT + 5 }, LEFT), false);
});

test("a field in use, the keyboard or a sheet open takes no tap", () => {
  assert.equal(statusTap({ ...still, typing: true }, LEFT), false);
  assert.equal(statusTap({ ...still, keyboard: true }, LEFT), false);
  assert.equal(statusTap({ ...still, layer: true }, LEFT), false);
});

test("what else moves the page, shortly before or with it, is not a tap", () => {
  assert.equal(statusTap({ ...still, calmAt: LEFT - CALM_MS + 1 }, LEFT), false);
  assert.equal(statusTap({ ...still, calmAt: LEFT + 2 }, LEFT), false);
});
