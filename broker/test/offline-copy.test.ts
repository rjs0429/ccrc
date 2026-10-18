import assert from "node:assert/strict";
import { test } from "node:test";
import type { DisplayItem } from "../src/protocol.ts";
import { dayClock, minutesText } from "../../web/src/labels.ts";
import { COPY_CHARS, COPY_ITEMS, copied, keptItem, passwordChanged, untilAfter, usable } from "../../web/src/offlineCopy.ts";

const user = (id: string, text = "물음"): DisplayItem => ({ kind: "user", id, ts: "2026-10-18T01:00:00.000Z", text });
const reply = (id: string, text = "답"): DisplayItem => ({ kind: "assistant", id, text });
const ids = (items: DisplayItem[]) => items.map((i) => i.id);

test("the copy keeps what was said and leaves out tool input and output, diffs, command output and thinking", () => {
  assert.equal(keptItem({ kind: "thinking", id: "t", text: "생각" }), undefined);
  const bash: DisplayItem = {
    kind: "tool",
    id: "b",
    ts: "2026-10-18T01:00:01.000Z",
    name: "Bash",
    summary: "cat config.json",
    input: { command: "cat config.json" },
    result: { text: "token=secret", isError: false, truncated: false },
    sub: { tools: 3, recent: [{ name: "Read", summary: "a.ts" }], text: "보고", agentId: "a1" },
  };
  assert.deepEqual(keptItem(bash), {
    kind: "tool",
    id: "b",
    ts: "2026-10-18T01:00:01.000Z",
    name: "Bash",
    summary: "cat config.json",
    input: null,
    result: { text: "", isError: false, truncated: false },
    sub: { tools: 3, recent: [] },
  });
  const edit: DisplayItem = {
    kind: "tool",
    id: "e",
    name: "Edit",
    summary: "a.ts",
    input: { old_string: "x", new_string: "y" },
    file: "/home/user/app/a.ts",
    patch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-x", "+y"] }],
    result: { text: "failed", isError: true, truncated: false },
  };
  assert.deepEqual(keptItem(edit), { kind: "tool", id: "e", name: "Edit", summary: "a.ts", input: null, result: { text: "", isError: true, truncated: false }, file: "/home/user/app/a.ts" });
  for (const name of ["AskUserQuestion", "ExitPlanMode", "SendUserFile"]) {
    const said: DisplayItem = { kind: "tool", id: name, name, summary: "", input: { plan: "계획" }, reply: { kind: "approved" } };
    assert.deepEqual(keptItem(said), { kind: "tool", id: name, name, summary: "", input: { plan: "계획" }, reply: { kind: "approved" } }, name);
  }
  assert.deepEqual(keptItem({ kind: "command", id: "c", name: "status", args: "", text: "Email: someone@example.com", usage: { limits: [] } as never }), {
    kind: "command",
    id: "c",
    name: "status",
    text: "",
  });
  assert.deepEqual(keptItem({ kind: "shell", id: "s", command: "env", output: "API_KEY=x" }), { kind: "shell", id: "s", command: "env" });
  assert.deepEqual(keptItem({ kind: "task", id: "k", status: "completed", summary: "끝", text: "출력" }), { kind: "task", id: "k", status: "completed", summary: "끝" });
  const note: DisplayItem = { kind: "note", id: "n", code: "unsent", text: "보내지 못함", attachments: 1 };
  assert.deepEqual(keptItem(note), note);
  const photo: DisplayItem = { kind: "user", id: "p", text: "사진", attachments: [{ kind: "image", mediaType: "image/png", size: 10 }] };
  assert.deepEqual(keptItem(photo), photo);
});

test("long words are cut: messages and notes at 20,000 characters, reports at 4,000", () => {
  const long = "가".repeat(25_000);
  assert.equal((keptItem(user("u", long)) as { text: string }).text, `${"가".repeat(20_000)}…`);
  assert.equal((keptItem(reply("a", long)) as { text: string }).text, `${"가".repeat(20_000)}…`);
  assert.equal((keptItem({ kind: "message", id: "m", from: "agent", text: long }) as { text: string }).text, `${"가".repeat(4000)}…`);
  assert.equal((keptItem({ kind: "note", id: "n", code: "unsent", text: long }) as { text: string }).text, `${"가".repeat(20_000)}…`);
  assert.equal((keptItem(user("u", "짧음")) as { text: string }).text, "짧음");
});

test("the copy is the end of the conversation, at most COPY_ITEMS items and COPY_CHARS characters", () => {
  const many = Array.from({ length: COPY_ITEMS + 20 }, (_, i) => (i % 2 ? reply(`i${i}`) : user(`i${i}`)));
  const c = copied(many, { hasMore: false });
  assert.equal(c.items.length, COPY_ITEMS);
  assert.deepEqual(ids(c.items), ids(many.slice(-COPY_ITEMS)));
  assert.equal(c.cut, true);

  const big = Array.from({ length: 12 }, (_, i) => reply(`b${i}`, "가".repeat(19_000)));
  const b = copied(big, { hasMore: false });
  assert.equal(b.items.length, Math.floor(COPY_CHARS / JSON.stringify(big[11]).length));
  assert.deepEqual(ids(b.items), ids(big.slice(-b.items.length)));
  assert.equal(b.cut, true);
});

test("the copy says whether the conversation goes on before it", () => {
  const short = [user("a"), { kind: "thinking", id: "t", text: "생각" } as DisplayItem, reply("b")];
  assert.deepEqual(copied(short, { hasMore: false }), { items: [user("a"), reply("b")], cut: false });
  assert.equal(copied(short, { hasMore: true }).cut, true, "the phone did not hold the start");
  const thinkingFirst = [{ kind: "thinking", id: "t0", text: "생각" } as DisplayItem, ...Array.from({ length: COPY_ITEMS }, (_, i) => user(`u${i}`))];
  assert.equal(copied(thinkingFirst, { hasMore: false }).cut, false, "only thinking left out");
});

test("with a gap, the copy keeps only the part after it", () => {
  const items = [user("far"), reply("far2"), user("late"), reply("late2")];
  const c = copied(items, { hasMore: false, gapBefore: "late" });
  assert.deepEqual(ids(c.items), ["late", "late2"]);
  assert.equal(c.cut, true);
  assert.deepEqual(ids(copied(items, { hasMore: false, gapBefore: "gone" }).items), ids(items), "a gap whose item is not held changes nothing");
});

test("the copy shows until the login would end, and goes with a password set again", () => {
  const at = Date.UTC(2026, 9, 18, 3);
  assert.equal(untilAfter(at, 60), at + 3_600_000);
  assert.equal(untilAfter(at), at + 720 * 60_000, "the broker's default when it does not say");
  assert.equal(usable({ until: at + 1 }, at), true);
  assert.equal(usable({ until: at }, at), false);
  assert.equal(usable(undefined, at), false);
  assert.equal(passwordChanged({ until: 0, stamp: "2026-10-17T00:00:00.000Z" }, "2026-10-18T00:00:00.000Z"), true);
  assert.equal(passwordChanged({ until: 0, stamp: "2026-10-18T00:00:00.000Z" }, "2026-10-18T00:00:00.000Z"), false);
  assert.equal(passwordChanged({ until: 0 }, "2026-10-18T00:00:00.000Z"), false, "nothing to compare with");
  assert.equal(passwordChanged({ until: 0, stamp: "2026-10-18T00:00:00.000Z" }, undefined), false, "a broker that does not say");
});

test("how long and until when the copy shows read in Korean", () => {
  assert.equal(minutesText(720), "12시간");
  assert.equal(minutesText(90), "1시간 30분");
  assert.equal(minutesText(45), "45분");
  assert.equal(minutesText(0.2), "1분");
  const now = new Date(2026, 9, 18, 20, 0);
  assert.equal(dayClock(new Date(2026, 9, 18, 21, 30).getTime(), now), "오늘 21:30");
  assert.equal(dayClock(new Date(2026, 9, 19, 8, 5).getTime(), now), "내일 08:05");
  assert.equal(dayClock(new Date(2026, 9, 21, 8, 5).getTime(), now), "10월 21일 08:05");
});
