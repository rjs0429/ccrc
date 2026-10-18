import assert from "node:assert/strict";
import { test } from "node:test";
import type { DisplayItem } from "../src/protocol.ts";
import { HISTORY_CHANGED, historyFind, historyPage, pageEnd, pageStart, snapshotPart } from "../src/sessions/pages.ts";

const user = (n: number, text = ""): DisplayItem => ({ kind: "user", id: `i${n}`, text });
const tool = (n: number, name: string): DisplayItem => ({ kind: "tool", id: `i${n}`, name, summary: "", input: null });
const list = (count: number) => Array.from({ length: count }, (_, n) => user(n));
const ids = (items: DisplayItem[]) => items.map((i) => i.id);
const span = (items: DisplayItem[]) => [items[0]?.id, items.at(-1)?.id, items.length];

test("a page holds up to 40 items, fewer once they pass 96 KiB of JSON, and always one", () => {
  const items = list(100);
  assert.equal(pageStart(items, 100), 60);
  assert.equal(pageStart(items, 30), 0);
  assert.equal(pageEnd(items, 10, 100), 50);
  assert.equal(pageEnd(items, 90, 100), 100);
  const big = Array.from({ length: 50 }, (_, n) => user(n, "x".repeat(30_000)));
  assert.equal(pageStart(big, 50), 47);
  assert.equal(pageEnd(big, 0, 50), 3);
  const huge = [user(0, "x".repeat(200_000)), user(1, "x".repeat(200_000))];
  assert.equal(pageStart(huge, 2), 1);
  assert.equal(pageEnd(huge, 0, 2), 1);
});

test("a snapshot sends the latest page, and the agent and to-do calls before it", () => {
  const items = list(200);
  items[3] = tool(3, "Agent");
  items[9] = tool(9, "TodoWrite");
  items[12] = tool(12, "Bash");
  items[170] = tool(170, "Task");
  const part = snapshotPart(items);
  assert.deepEqual(span(part.items), ["i160", "i199", 40]);
  assert.equal(part.hasMore, true);
  assert.equal(part.gap, undefined);
  assert.deepEqual(ids(part.earlier!), ["i3", "i9"]);
  assert.equal(part.earlierInGap, undefined);
  const short = snapshotPart(list(30));
  assert.deepEqual([span(short.items), short.hasMore, short.earlier], [["i0", "i29", 30], false, undefined]);
  assert.deepEqual(snapshotPart([]), { items: [], hasMore: false });
});

test("a snapshot keeps holding from the phone's first item while that part is not too long", () => {
  const items = list(1000);
  assert.deepEqual(span(snapshotPart(items, { from: "i700" }).items), ["i700", "i999", 300]);
  assert.deepEqual(span(snapshotPart(items, { from: "i300" }).items), ["i960", "i999", 40]);
  assert.deepEqual(span(snapshotPart(items, { from: "i980" }).items), ["i960", "i999", 40]);
  assert.deepEqual(span(snapshotPart(items, { from: "gone" }).items), ["i960", "i999", 40]);
});

test("a far-back focused item comes with the items around it, the latest page and the gap between", () => {
  const items = list(1000);
  items[50] = tool(50, "Agent");
  items[300] = tool(300, "TaskUpdate");
  items[500] = tool(500, "Workflow");
  const far = snapshotPart(items, { focus: "i400" });
  assert.deepEqual(ids(far.items).slice(0, 2), ["i390", "i391"]);
  assert.deepEqual([far.items[39].id, far.items[40].id, far.items.length], ["i429", "i960", 80]);
  assert.deepEqual(far.gap, { before: "i960", skipped: 960 - 430 });
  assert.equal(far.hasMore, true);
  assert.deepEqual(ids(far.earlier!), ["i50", "i300", "i500"]);
  assert.equal(far.earlierInGap, 1);
  const latest = snapshotPart(items, { focus: "i970" });
  assert.deepEqual([span(latest.items), latest.gap], [["i960", "i999", 40], undefined]);
  const close = snapshotPart(items, { focus: "i925" });
  assert.deepEqual([span(close.items), close.gap], [["i915", "i999", 85], undefined]);
  const first = snapshotPart(items, { focus: "i0" });
  assert.deepEqual([first.items[0].id, first.hasMore, first.gap?.before], ["i0", false, "i960"]);
  assert.deepEqual(span(snapshotPart(items, { focus: "missing" }).items), ["i960", "i999", 40]);
});

test("after a focused open the part the phone holds wins over the focused item", () => {
  const short = list(300);
  const loaded = snapshotPart(short, { focus: "i100", from: "i50" });
  assert.deepEqual([span(loaded.items), loaded.gap, loaded.hasMore], [["i50", "i299", 250], undefined, true]);
  assert.deepEqual(span(snapshotPart(short, { focus: "i100", from: "i90" }).items), ["i90", "i299", 210]);
  const items = list(1000);
  const back = snapshotPart(items, { focus: "i100", from: "i50" });
  assert.deepEqual([back.items[0].id, back.items[79].id, back.items[80].id, back.items.length], ["i50", "i129", "i960", 120]);
  assert.deepEqual(back.gap, { before: "i960", skipped: 960 - 130 });
  assert.deepEqual(snapshotPart(items, { focus: "i100", from: "i90" }), snapshotPart(items, { focus: "i100" }));
  assert.deepEqual(snapshotPart(items, { focus: "i700", from: "i0" }), snapshotPart(items, { focus: "i700" }));
  assert.deepEqual(span(snapshotPart(items, { focus: "i100", from: "i200" }).items), ["i960", "i999", 40]);
});

test("a page before an item, or after one up to another, comes with whether more lies that way", () => {
  const items = list(100);
  assert.deepEqual(historyPage(items, { before: "i60" }), { items: items.slice(20, 60), more: true });
  assert.deepEqual(historyPage(items, { before: "i20" }), { items: items.slice(0, 20), more: false });
  assert.deepEqual(historyPage(items, { before: "i0" }), { items: [], more: false });
  assert.deepEqual(historyPage(items, { after: "i9", until: "i90" }), { items: items.slice(10, 50), more: true });
  assert.deepEqual(historyPage(items, { after: "i49", until: "i60" }), { items: items.slice(50, 60), more: false });
  assert.deepEqual(historyPage(items, { after: "i59", until: "i60" }), { items: [], more: false });
  assert.deepEqual(historyPage(items, { after: "i89" }), { items: items.slice(90), more: false });
  assert.throws(() => historyPage(items, { before: "gone" }), { message: HISTORY_CHANGED });
  assert.throws(() => historyPage(items, { after: "gone", until: "i5" }), { message: HISTORY_CHANGED });
  assert.throws(() => historyPage(items, { after: "i50", until: "i10" }), { message: HISTORY_CHANGED });
  assert.throws(() => historyPage(items, { after: "i50", until: "gone" }), { message: HISTORY_CHANGED });
  assert.throws(() => historyPage(items, {}), { message: "invalid request" });
});

test("the sheets get the user's messages with their text cut, or the file changes, from all of it", () => {
  const change: DisplayItem = { kind: "tool", id: "e1", name: "Edit", summary: "a.ts", input: null, file: "/w/a.ts", patch: [] };
  const items: DisplayItem[] = [user(0, "짧은 글"), user(1, "긴 글 ".repeat(200)), change, tool(3, "Edit"), { kind: "assistant", id: "a", text: "답" }];
  const users = historyFind(items, "users");
  assert.deepEqual(ids(users), ["i0", "i1"]);
  assert.equal((users[1] as { text: string }).text.length, 300);
  assert.equal(users[0], items[0]);
  assert.deepEqual(historyFind(items, "changes"), [change]);
  assert.throws(() => historyFind(items, "all"), { message: "invalid request" });
});
