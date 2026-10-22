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
  a.liveThought("Let me look", false);
  a.liveThought("Let me look at the config", false);
  assert.equal(a.thoughtChoice(undefined, "Let me look at the config files"), false);
  assert.equal(a.thoughtChoice(undefined, "Another thought"), undefined);
  assert.equal(a.thoughtChoice("other:0", "Something else"), undefined);
  assert.equal(a.thoughtChoice("t1:0", "Let me look at the config and the tests."), false);
  assert.equal(a.thoughtChoice("t2:0", "Let me look at the config again."), undefined);
  a.liveThought("Next thought", true);
  a.liveThought("Next thought", undefined);
  assert.equal(a.thoughtChoice("t3:0", "Next thought, then more."), undefined);
  a.liveThought("", true);
  assert.equal(a.thoughtChoice("t4:0", "Anything"), undefined);
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
