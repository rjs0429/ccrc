import assert from "node:assert/strict";
import { test } from "node:test";
import { chipLayout, sameLayout } from "../../web/src/components/composer/chipLayout.ts";

const base = { composer: 390, row: 340, gap: 4, left: 180, right: 190 };

test("from the sm breakpoint the chips stand on one line with the agent chip between the groups", () => {
  assert.deepEqual(chipLayout({ ...base, composer: 640, left: 400, right: 300, agent: { word: 90, icon: 44 } }), { lines: "wide", agent: "inline", word: true });
  assert.equal(chipLayout({ ...base, composer: 639.5 }).lines, "two");
});

test("narrow, both groups share a line when they fit, and the agent chip takes a line of its own above them", () => {
  assert.deepEqual(chipLayout({ ...base, left: 146, right: 190 }), { lines: "one", agent: "above", word: true });
  assert.deepEqual(chipLayout({ ...base, left: 146, right: 190, agent: { word: 90, icon: 44 } }), { lines: "one", agent: "above", word: true });
  assert.equal(chipLayout({ ...base, left: 146.5, right: 190 }).lines, "two");
});

test("narrow, on two lines the agent chip joins the right group's line with its word, without it, or goes above", () => {
  const two = (agent: { word: number; icon: number }) => chipLayout({ ...base, right: 250, agent });
  assert.deepEqual(two({ word: 86, icon: 44 }), { lines: "two", agent: "inline", word: true });
  assert.deepEqual(two({ word: 87, icon: 44 }), { lines: "two", agent: "inline", word: false });
  assert.deepEqual(two({ word: 100, icon: 87 }), { lines: "two", agent: "above", word: true });
  assert.deepEqual(chipLayout({ ...base, right: 250 }), { lines: "two", agent: "above", word: true });
});

test("layouts compare by their lines, the agent chip's place and its word", () => {
  assert.ok(sameLayout({ lines: "two", agent: "inline", word: false }, { lines: "two", agent: "inline", word: false }));
  assert.ok(!sameLayout({ lines: "two", agent: "inline", word: false }, { lines: "two", agent: "inline", word: true }));
});
