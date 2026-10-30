import assert from "node:assert/strict";
import { test } from "node:test";
import { CLOSE_SHARE, FLICK, RUBBER, SLOP_PX, SPEED_MS, cleared, closes, follow, speedOf } from "../../web/src/components/dragClose.ts";

test("what is dragged follows the finger down and a share of it up", () => {
  assert.equal(follow(120), 120);
  assert.equal(follow(0), 0);
  assert.equal(follow(-100), -100 * RUBBER);
});

test("the dimmed parts clear in step down to their reach and no further, and stay put dragged up", () => {
  assert.equal(cleared(0, 300), 0);
  assert.equal(cleared(150, 300), 0.5);
  assert.equal(cleared(450, 300), 1);
  assert.equal(cleared(-40, 300), 0);
  assert.equal(cleared(50, 0), 0);
});

test("let go, a drag closes past its distance or at a flick past the slop", () => {
  const far = 832 * CLOSE_SHARE;
  assert.equal(closes(far + 1, 0, far), true);
  assert.equal(closes(far - 1, 0, far), false);
  assert.equal(closes(SLOP_PX + 1, FLICK + 0.01, far), true);
  assert.equal(closes(SLOP_PX, FLICK + 1, far), false);
  assert.equal(closes(far - 1, FLICK, far), false);
  assert.equal(closes(far - 1, -2, far), false);
});

test("a finger's speed is taken over its last moments only", () => {
  assert.deepEqual(speedOf([]), { x: 0, y: 0 });
  assert.deepEqual(speedOf([{ t: 10, x: 0, y: 0 }]), { x: 0, y: 0 });
  assert.deepEqual(speedOf([{ t: 0, x: 0, y: 0 }, { t: 50, x: 10, y: 40 }]), { x: 0.2, y: 0.8 });
  // An early fast part is forgotten: the finger has held still for longer than SPEED_MS.
  const held = [
    { t: 0, x: 0, y: 0 },
    { t: 20, x: 0, y: 100 },
    { t: 20 + SPEED_MS + 1, x: 0, y: 100 },
  ];
  assert.equal(speedOf(held).y, 0);
});
