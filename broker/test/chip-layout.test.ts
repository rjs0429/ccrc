import assert from "node:assert/strict";
import { test } from "node:test";
import { chipLayout, sameLayout } from "../../web/src/components/composer/chipLayout.ts";

// A phone's composer: the paperclip, the Context ring, Opus 5.5 and "Max U" on the left; Auto on the right; the one
// round button, as wide while a turn runs as when idle; the agent chip with its word and the count's place.
const base = { composer: 390, row: 340, gap: 4, left: 208, right: 56, round: 34 };
const agent = 105;

test("from the sm breakpoint the chips stand on one line, the agent chip with its word", () => {
  assert.deepEqual(chipLayout({ ...base, composer: 640, left: 400, right: 300, agent }), { lines: "wide", word: true });
  assert.equal(chipLayout({ ...base, composer: 639.5, left: 400, agent }).lines, "two");
});

test("narrow, without an agent chip everything shares one line when it fits", () => {
  assert.deepEqual(chipLayout(base), { lines: "one", word: true });
  assert.deepEqual(chipLayout({ ...base, left: 242 }), { lines: "one", word: true });
  assert.deepEqual(chipLayout({ ...base, left: 242.5 }), { lines: "two", word: true });
});

test("narrow, the agent chip takes the one line only where all of it fits there", () => {
  assert.deepEqual(chipLayout({ ...base, row: 415, agent }), { lines: "one", word: true });
  assert.deepEqual(chipLayout({ ...base, row: 414.5, agent }), { lines: "two", word: true });
  assert.deepEqual(chipLayout({ ...base, agent }), { lines: "two", word: true });
});

test("on two lines the agent chip shares line 1 with the mode chip, with its word where that fits", () => {
  const two = (row: number, right = 56) => chipLayout({ ...base, left: 400, row, right, agent });
  assert.deepEqual(two(165), { lines: "two", word: true });
  assert.deepEqual(two(164.5), { lines: "two", word: false });
  assert.deepEqual(two(320, 211), { lines: "two", word: true });
  assert.deepEqual(two(320, 211.5), { lines: "two", word: false });
});

test("layouts compare by their lines and the agent chip's word", () => {
  assert.ok(sameLayout({ lines: "two", word: false }, { lines: "two", word: false }));
  assert.ok(!sameLayout({ lines: "two", word: false }, { lines: "two", word: true }));
  assert.ok(!sameLayout({ lines: "one", word: true }, { lines: "wide", word: true }));
});
