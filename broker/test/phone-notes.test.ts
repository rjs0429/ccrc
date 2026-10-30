import assert from "node:assert/strict";
import { test } from "node:test";
import { phoneNoteLine, phoneNotes } from "../src/phone-notes.ts";

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
