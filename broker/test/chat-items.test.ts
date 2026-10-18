import assert from "node:assert/strict";
import { test } from "node:test";
import { joined, placed, withEarlier, type Held } from "../../web/src/chatItems.ts";
import type { DisplayItem } from "../src/protocol.ts";

const user = (id: string, text = ""): DisplayItem => ({ kind: "user", id, text });
const agent = (id: string, tools = 0): DisplayItem => ({ kind: "tool", id, name: "Agent", summary: "", input: null, sub: { tools, recent: [] } });
const ids = (items?: DisplayItem[]) => items?.map((i) => i.id);

test("an item that changed takes its place; one that changes nothing gives no change", () => {
  const c: Held = { items: [user("a"), user("b")], hasMore: true };
  assert.deepEqual(ids(placed(c, user("b", "new"), "a")?.items), ["a", "b"]);
  assert.equal((placed(c, user("b", "new"), "a")?.items?.[1] as { text: string }).text, "new");
  assert.equal(placed(c, user("b"), "a"), undefined);
  const aside: Held = { ...c, earlier: [agent("x", 1)] };
  assert.deepEqual(placed(aside, agent("x", 2), "w"), { earlier: [agent("x", 2)] });
  assert.equal(placed(aside, agent("x", 1), "w"), undefined);
});

test("an item that came goes after the one before it; one from a part not loaded is left out", () => {
  const c: Held = { items: [user("a"), user("b")], hasMore: true };
  assert.deepEqual(ids(placed(c, user("c"), "b")?.items), ["a", "b", "c"]);
  assert.deepEqual(ids(placed(c, user("ab"), "a")?.items), ["a", "ab", "b"]);
  assert.equal(placed(c, user("old"), "older"), undefined);
  assert.equal(placed(c, user("first"), null), undefined);
  assert.deepEqual(ids(placed({ items: [], hasMore: false }, user("first"), null)?.items), ["first"]);
  assert.deepEqual(ids(placed(c, user("c"), undefined)?.items), ["a", "b", "c"]);
});

test("the earlier calls stand before the items, the gap's where the gap is", () => {
  const items = [user("f1"), user("f2"), user("l1"), user("l2")];
  assert.equal(withEarlier({ items, hasMore: true }), items);
  assert.deepEqual(ids(withEarlier({ items, hasMore: true, earlier: [agent("e1")] })), ["e1", "f1", "f2", "l1", "l2"]);
  const gapped: Held = { items, hasMore: true, gap: { before: "l1", skipped: 30 }, earlier: [agent("e1"), agent("g1"), agent("g2")], earlierInGap: 2 };
  assert.deepEqual(ids(withEarlier(gapped)), ["e1", "f1", "f2", "g1", "g2", "l1", "l2"]);
});

test("a page before the first item goes in front; one from the gap goes into it and closes it when nothing is left", () => {
  const c: Held = { items: [user("f1"), user("l1")], hasMore: true, gap: { before: "l1", skipped: 5 }, earlier: [agent("e1"), agent("g1")], earlierInGap: 1 };
  const before = joined(c, "earlier", { items: [user("e0"), agent("e1"), user("f1")], more: false });
  assert.deepEqual(ids(before.items), ["e0", "e1", "f1", "l1"]);
  assert.deepEqual([before.hasMore, ids(before.earlier), before.earlierInGap], [false, ["g1"], 1]);
  const some = joined(c, "gap", { items: [user("g0")], more: true });
  assert.deepEqual([ids(some.items), some.gap], [["f1", "g0", "l1"], { before: "l1", skipped: 4 }]);
  const rest = joined(c, "gap", { items: [agent("g1"), user("g2")], more: false });
  assert.deepEqual([ids(rest.items), rest.gap, ids(rest.earlier), rest.earlierInGap], [["f1", "g1", "g2", "l1"], undefined, ["e1"], undefined]);
  assert.deepEqual(joined({ items: [user("a")], hasMore: false }, "gap", { items: [user("b")], more: false }), {});
});
