import assert from "node:assert/strict";
import { test } from "node:test";
import { chipLayout, sameLayout } from "../../web/src/components/composer/chipLayout.ts";

// A phone's composer: the paperclip, Opus 5.5 and "Max U" on the left; the Context ring and Auto on the right; the one
// round button, as wide while a turn runs as when idle.
const base = { composer: 390, row: 340, gap: 4, left: 180, right: 84, round: 34 };

test("from the sm breakpoint the chips stand on one line, the agent chip with its word", () => {
  assert.deepEqual(chipLayout({ ...base, composer: 640, left: 400, right: 300, agent: { word: 90, icon: 44 } }), { lines: "wide", word: true });
  assert.equal(chipLayout({ ...base, composer: 639.5, left: 400 }).lines, "two");
});

test("narrow, everything shares one line when it fits", () => {
  assert.deepEqual(chipLayout(base), { lines: "one", word: true });
  assert.deepEqual(chipLayout({ ...base, left: 214 }), { lines: "one", word: true });
  assert.deepEqual(chipLayout({ ...base, left: 214.5 }), { lines: "two", word: true });
});

test("narrow, the agent chip joins the one line with its word, without it, or the chips take two lines", () => {
  const one = (agent: { word: number; icon?: number }) => chipLayout({ ...base, agent });
  assert.deepEqual(one({ word: 30, icon: 20 }), { lines: "one", word: true });
  assert.deepEqual(one({ word: 31, icon: 30 }), { lines: "one", word: false });
  assert.deepEqual(one({ word: 98, icon: 42 }), { lines: "two", word: true });
});

test("an idle chip, with nothing to show without its word, keeps it on one line or takes the chips to two", () => {
  assert.deepEqual(chipLayout({ ...base, agent: { word: 30 } }), { lines: "one", word: true });
  assert.deepEqual(chipLayout({ ...base, agent: { word: 31 } }), { lines: "two", word: true });
  assert.deepEqual(chipLayout({ ...base, right: 250, agent: { word: 200 } }), { lines: "two", word: true });
});

test("on two lines the agent chip shares line 1 with the right group, with its word where that fits", () => {
  const two = (agent: { word: number; icon?: number }) => chipLayout({ ...base, right: 175, agent });
  assert.deepEqual(two({ word: 161, icon: 42 }), { lines: "two", word: true });
  assert.deepEqual(two({ word: 161.5, icon: 42 }), { lines: "two", word: false });
  assert.deepEqual(two({ word: 200, icon: 170 }), { lines: "two", word: false });
});

test("layouts compare by their lines and the agent chip's word", () => {
  assert.ok(sameLayout({ lines: "two", word: false }, { lines: "two", word: false }));
  assert.ok(!sameLayout({ lines: "two", word: false }, { lines: "two", word: true }));
  assert.ok(!sameLayout({ lines: "one", word: true }, { lines: "wide", word: true }));
});
