import assert from "node:assert/strict";
import { test } from "node:test";
import { streamed } from "../../web/src/chatItems.ts";

class Storage {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

const storage = new Storage();
Object.assign(globalThis, { sessionStorage: storage });
let loads = 0;
// The module as a page that loads it afresh sees it.
const fresh = () => import(`../../web/src/components/thoughts.ts?load=${++loads}`) as Promise<typeof import("../../web/src/components/thoughts.ts")>;

test("a box opened or closed by hand keeps that, after a reload too; the others have no choice", async () => {
  const a = await fresh();
  assert.equal(a.thoughtChoice("m1:0", "first"), undefined);
  a.chooseThought("m1:0", false);
  a.chooseThought("m2:0", true);
  assert.equal(a.thoughtChoice("m1:0", "first"), false);
  const b = await fresh();
  assert.equal(b.thoughtChoice("m1:0", "first"), false);
  assert.equal(b.thoughtChoice("m2:0", "second"), true);
  assert.equal(b.thoughtChoice("m3:0", "third"), undefined);
});

test("only the latest choices are kept", async () => {
  const a = await fresh();
  for (let i = 0; i < 310; i++) a.chooseThought(`k${i}:0`, true);
  a.chooseThought("k0:0", false);
  const b = await fresh();
  assert.equal(b.thoughtChoice("k0:0", ""), false);
  assert.equal(b.thoughtChoice("k1:0", ""), undefined);
  assert.equal(b.thoughtChoice("k309:0", ""), true);
});

test("the choice made while a thought streamed goes to its item, once", async () => {
  const a = await fresh();
  a.liveThought("s1", "Let me look", false);
  a.liveThought("s1", "Let me look at the config", false);
  assert.equal(a.thoughtChoice(undefined, "Let me look at the config files", "s1"), false);
  assert.equal(a.thoughtChoice(undefined, "Another thought", "s1"), undefined);
  assert.equal(a.thoughtChoice("other:0", "Something else", "s1"), undefined);
  assert.equal(a.thoughtChoice("t1:0", "Let me look at the config and the tests.", "s1"), false);
  assert.equal(a.thoughtChoice("t2:0", "Let me look at the config again.", "s1"), undefined);
  a.liveThought("s1", "Next thought", true);
  a.liveThought("s1", "Next thought", undefined);
  assert.equal(a.thoughtChoice("t3:0", "Next thought, then more.", "s1"), undefined);
  a.liveThought("s1", "", true);
  assert.equal(a.thoughtChoice("t4:0", "Anything", "s1"), undefined);
});

test("a streaming thought's choice is its session's: other sessions' thoughts leave it, and a reload keeps it", async () => {
  const a = await fresh();
  const x = "Session X thought: reading the config loader first.";
  assert.equal(a.thoughtChoice(undefined, x, "x"), undefined);
  a.liveThought("x", x, false);
  a.liveThought("y", "", undefined);
  a.liveThought("y", "Session Y thought", undefined);
  assert.equal(a.thoughtChoice(undefined, `${x} Then the tests.`, "x"), false);
  assert.equal(a.thoughtChoice(undefined, `${x} Then the tests.`, "y"), undefined);
  assert.equal(a.thoughtChoice("y1:0", `${x} Then the tests.`, "y"), undefined);
  const b = await fresh();
  assert.equal(b.thoughtChoice(undefined, `${x} Then the tests.`, "x"), false);
  b.liveThought("x", `${x} Then the tests.`, false);
  const c = await fresh();
  assert.equal(c.thoughtChoice("x1:0", `${x} Then the tests. All pass.`, "x"), false);
  assert.equal(c.thoughtChoice(undefined, `${x} Then the tests.`, "x"), undefined);
  const d = await fresh();
  assert.equal(d.thoughtChoice("x1:0", "", "x"), false);
});

test("a new thought in the session drops the choice made on the one before", async () => {
  const a = await fresh();
  a.liveThought("x", "The user wants", false);
  a.liveThought("x", "", undefined);
  assert.equal(a.thoughtChoice("n1:0", "The user wants a fix.", "x"), undefined);
  a.liveThought("x", "First thought", true);
  a.liveThought("x", "Second thought", undefined);
  assert.equal(a.thoughtChoice("n2:0", "First thought, all of it.", "x"), undefined);
});

test("what is kept of streaming thoughts stays small", async () => {
  const a = await fresh();
  const long = "A long thought that goes on. ".repeat(100);
  a.liveThought("x", long, true);
  const kept = JSON.parse(storage.getItem("ccrc.thoughts.live") ?? "[]") as [string, { text: string }][];
  assert.ok(kept.every(([, l]) => l.text.length <= 400));
  for (let i = 0; i < 40; i++) a.liveThought(`s${i}`, `Thought ${i}`, false);
  const b = await fresh();
  assert.equal(b.thoughtChoice("long:0", `${long}The end.`, "x"), undefined);
  assert.equal(b.thoughtChoice(undefined, "Thought 0, more", "s0"), undefined);
  assert.equal(b.thoughtChoice(undefined, "Thought 39, more", "s39"), false);
  a.liveThought("z", long, false);
  const c = await fresh();
  assert.equal(c.thoughtChoice("long:1", `${long}The end.`, "z"), false);
});

test("a thought that ends stays until what comes next takes its place", () => {
  const thought = streamed(undefined, "Let me", true);
  assert.deepEqual(thought, { text: "Let me", thinking: true });
  const ended = streamed(thought, "", false);
  assert.deepEqual(ended, { text: "Let me", thinking: true, ended: true });
  assert.equal(streamed(ended, "", false), ended);
  assert.deepEqual(streamed(ended, "The answer", false), { text: "The answer", thinking: false });
  assert.equal(streamed({ text: "The answer", thinking: false }, "", false), undefined);
  assert.equal(streamed({ text: "", thinking: true }, "", false), undefined);
  assert.equal(streamed(undefined, "", false), undefined);
});
