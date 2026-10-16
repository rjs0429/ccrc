import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentTranscript, DisplayItem } from "../src/protocol.ts";
import { cleanOutput } from "../../web/src/components/agents/output.ts";
import { afterOf, followed, held, prepended } from "../../web/src/components/agents/transcript.ts";

test("a shell's output reads as a terminal leaves it", () => {
  assert.equal(cleanOutput("\u001b[32mok\u001b[0m line\n\u001b]0;title\u0007next\n", false), "ok line\nnext\n");
  assert.equal(cleanOutput("Downloading  10%\rDownloading  55%\rDownloading 100%\ndone\r\n", false), "Downloading 100%\ndone\n", "a redrawn line keeps its last state; CRLF ends a line");
  assert.equal(cleanOutput("art of a line\nline 2\nline 3", true), "line 2\nline 3", "the end of a longer output drops the line it starts inside");
  assert.equal(cleanOutput("��one long line", true), "one long line", "a cut inside a character leaves no stray marks");
  assert.equal(cleanOutput("only\n", true), "only\n");
  assert.equal(cleanOutput("a‮b\tc\u0007d\u001b", false), "a\\u202Eb\tcd", "reordering marks show by their code and other controls go");
  assert.equal(cleanOutput("", false), "");
});

const user = (id: string): DisplayItem => ({ kind: "user", id, text: id });
const tool = (id: string, done = false): DisplayItem => ({ kind: "tool", id, name: "Bash", summary: id, input: {}, ...(done ? { result: { text: "ok", isError: false, truncated: false } } : {}) });
const answer = (a: Partial<AgentTranscript>): AgentTranscript => ({ agentId: "a1", items: [], from: 0, total: 0, ...a });

test("a followed transcript adds what came after, updates results in place and starts over when told", () => {
  const h = held(answer({ items: [user("p"), tool("t1"), tool("t2", true)], from: 10, total: 13, promptId: "p0", agentType: "Explore" }));
  assert.deepEqual(afterOf(h), { count: 13, lastId: "t2", open: ["t1"] });
  assert.deepEqual(afterOf(held(answer({ missing: true }))), { count: 0, lastId: "" });
  const next = followed(h, answer({ items: [tool("t3")], from: 13, total: 14, changed: [tool("t1", true)], promptId: "p0", agentType: "Explore" }));
  assert.deepEqual(
    next.items.map((i) => [i.id, i.kind === "tool" && Boolean(i.result)]),
    [
      ["p", false],
      ["t1", true],
      ["t2", true],
      ["t3", false],
    ],
  );
  assert.equal(next.from, 10);
  assert.equal(next.total, 14);
  assert.equal(next.agentType, "Explore");
  const again = followed(next, answer({ items: [tool("t3"), user("u4")], from: 13, total: 15 }));
  assert.deepEqual(
    again.items.map((i) => i.id),
    ["p", "t1", "t2", "t3", "u4"],
    "items another answer already brought are not added twice",
  );
  const reset = followed(again, answer({ items: [user("x")], from: 40, total: 41, reset: true }));
  assert.deepEqual([reset.from, reset.items.map((i) => i.id)], [40, ["x"]]);
  const earlier = prepended(h, answer({ items: [user("e1"), user("e2")], from: 8, total: 13 }));
  assert.deepEqual([earlier.from, earlier.items.map((i) => i.id)], [8, ["e1", "e2", "p", "t1", "t2"]]);
  assert.equal(prepended(h, answer({ items: [user("e1")], from: 2, total: 13 })), h, "a page that does not end where the held items start is left out");
});
