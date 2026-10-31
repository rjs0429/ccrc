import assert from "node:assert/strict";
import { test } from "node:test";
import { missedNotes, phoneNoteLine, phoneNotes } from "../src/phone-notes.ts";

const report = {
  t: "diag",
  what: "list_bottom",
  why: "snapshot",
  gap: 22062.4,
  height: [28330, 6283],
  items: [199, 40],
  view: 656,
  flags: "stick finger",
  trail: [
    ["join", 900, 1],
    ["end", 40, 7],
    ["snap", 12, 1],
  ],
};

test("a page's report that its conversation went to its bottom is one line of words and numbers", () => {
  assert.equal(
    phoneNoteLine(report),
    "ccrc: the phone's conversation went to its bottom by itself (snapshot): from 22062px above it, height 28330->6283px, items 199->40, view 656px, stick finger; before: join 900ms, end x7 40ms, snap 12ms",
  );
  assert.match(phoneNoteLine({ ...report, flags: "", trail: [] })!, /view 656px; before: nothing$/);
});

test("a report carrying anything but short words and numbers is dropped, or loses that part", () => {
  assert.equal(phoneNoteLine({ ...report, what: "other" }), undefined);
  assert.equal(phoneNoteLine({ ...report, why: "a long sentence from the page" }), undefined);
  assert.equal(phoneNoteLine({ ...report, why: "/home/user/x" }), undefined);
  assert.equal(phoneNoteLine({ ...report, gap: "22062" }), undefined);
  assert.equal(phoneNoteLine({ ...report, height: [1] }), undefined);
  assert.equal(phoneNoteLine({ ...report, items: [1, Infinity] }), undefined);
  const line = phoneNoteLine({ ...report, flags: "x; rm -rf", trail: [["ok", 1, 1], ["Not ok", 2, 1], ["ok", "2", 1], "x"] })!;
  assert.match(line, /view 656px; before: ok 1ms$/);
});

test("the log takes a page's report at most once in a while", () => {
  const lines: string[] = [];
  const note = phoneNotes((l) => lines.push(l), 10_000);
  assert.equal(note(report, 1000), true);
  assert.equal(note(report, 5000), false);
  assert.equal(note({ what: "list_bottom" }, 20_000), false);
  assert.equal(note(null, 20_000), false);
  assert.equal(note(report, 20_000), true);
  assert.equal(lines.length, 2);
});

const moved = {
  t: "diag",
  what: "list_moved",
  why: "keep",
  moved: 6011.4,
  top: [0, 6011],
  height: [9649, 9649],
  items: [80, 80],
  view: 584,
  flags: "",
  trail: [
    ["rise", 482, 1],
    ["history", 140, 1],
    ["join", 74, 1],
    ["keep", 74, 1, 6011],
    ["snap", 3, 2, 40],
  ],
};

test("a page's report that its conversation moved by itself says how far, which way, and what came before with its numbers", () => {
  assert.equal(
    phoneNoteLine(moved),
    "ccrc: the phone's conversation moved by itself (keep): 6011px toward its end, top 0->6011px, height 9649->9649px, items 80->80, view 584px; before: rise 482ms, history 140ms, join 74ms, keep 74ms (6011), snap x2 3ms (40)",
  );
  assert.match(phoneNoteLine({ ...moved, moved: -3054, flags: "pinned stick" })!, /: 3054px toward its start, .*view 584px, pinned stick; before:/);
  assert.equal(phoneNoteLine({ ...moved, top: [1] }), undefined);
  assert.equal(phoneNoteLine({ ...moved, moved: "6011" }), undefined);
  assert.match(phoneNoteLine({ ...moved, trail: [["keep", 1, 1, "6011"], ["ok", 2, 1, 5, 6], ["ok", 3, 1, 7]] })!, /before: ok 3ms \(7\)$/);
});

test("a phone's request for a part the conversation no longer has is logged with the session's first characters only, once in a while", () => {
  const lines: string[] = [];
  const missed = missedNotes((l) => lines.push(l), 10_000);
  assert.equal(missed("5a10aaaa-0000-4000-8000-000000000001", 167, 1000), true);
  assert.equal(missed("5a10aaaa-0000-4000-8000-000000000001", 167, 5000), false);
  assert.equal(missed("5a10aaaa-0000-4000-8000-000000000002", 12, 12_000), true);
  assert.deepEqual(lines, [
    "ccrc: a phone asked for a part the conversation no longer has (history_changed): session 5a10aaaa, 167 items",
    "ccrc: a phone asked for a part the conversation no longer has (history_changed): session 5a10aaaa, 12 items",
  ]);
});
