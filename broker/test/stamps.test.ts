import assert from "node:assert/strict";
import { test } from "node:test";
import type { DisplayItem } from "../src/protocol.ts";
import { dayLabel, dayLines, fullTime, stampTime } from "../../web/src/components/stamps.ts";
import { clock } from "../../web/src/labels.ts";

// Days are the phone's local days; this file reads times in a zone ahead of UTC.
process.env.TZ = "Asia/Seoul";

const at = (y: number, mo: number, d: number, h = 12, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s);
const iso = (y: number, mo: number, d: number, h = 12, mi = 0, s = 0) => at(y, mo, d, h, mi, s).toISOString();
const NOW = at(2026, 10, 15, 16, 7);
const user = (id: string, ts?: string): DisplayItem => ({ kind: "user", id, ts, text: "질문" });
const reply = (id: string, ts?: string, text = "답변"): DisplayItem => ({ kind: "assistant", id, ts, text });

test("user messages and Claude's text replies are stamped; other items, blank replies and unreadable times are not", () => {
  const ts = iso(2026, 10, 15, 9, 30);
  assert.equal(stampTime(user("u", ts))?.toISOString(), ts);
  assert.equal(stampTime({ kind: "user", id: "photo", ts, text: "", attachments: [{ kind: "image", mediaType: "image/png", size: 1 }] })?.toISOString(), ts);
  assert.equal(stampTime(reply("a", ts))?.toISOString(), ts);
  const others: DisplayItem[] = [
    reply("blank", ts, " \n "),
    { kind: "thinking", id: "thinking", ts, text: "생각" },
    { kind: "tool", id: "tool", ts, name: "Bash", summary: "ls", input: {} },
    { kind: "command", id: "command", ts, name: "status", text: "Version" },
    { kind: "message", id: "message", ts, from: "agent", text: "보고" },
    { kind: "task", id: "task", ts, status: "completed", summary: "끝" },
    { kind: "shell", id: "shell", ts, command: "ls" },
    { kind: "note", id: "note", ts, code: "interrupted" },
    user("no time"),
    user("bad time", "not a time"),
  ];
  for (const item of others) assert.equal(stampTime(item), undefined, item.id);
});

test("a date line goes before the first stamped item and wherever the local day changes", () => {
  const items: DisplayItem[] = [
    { kind: "tool", id: "t0", ts: iso(2026, 10, 14, 8), name: "Read", summary: "a.ts", input: {} },
    user("u1", iso(2026, 10, 14, 23, 50)),
    reply("a1", iso(2026, 10, 14, 23, 59, 59)),
    { kind: "thinking", id: "t1", ts: iso(2026, 10, 15, 0, 0, 30), text: "생각" },
    reply("a2", iso(2026, 10, 15, 0, 1)),
    user("u2", iso(2026, 10, 15, 9)),
    reply("a3", iso(2026, 10, 15, 9, 1)),
    reply("a4", iso(2026, 10, 17, 10)),
  ];
  assert.deepEqual(
    [...dayLines(items, NOW)],
    [
      ["u1", { date: "2026-10-14", label: "10월 14일 (수)" }],
      ["a2", { date: "2026-10-15", label: "10월 15일 (목)" }],
      ["a4", { date: "2026-10-17", label: "10월 17일 (토)" }],
    ],
  );
});

test("the day is the local one, not the UTC date", () => {
  const items = [reply("evening", "2026-10-15T14:30:00Z"), user("after midnight", "2026-10-15T15:30:00Z"), reply("morning", "2026-10-16T00:30:00Z")];
  assert.deepEqual(
    [...dayLines(items, NOW).values()],
    [
      { date: "2026-10-15", label: "10월 15일 (목)" },
      { date: "2026-10-16", label: "10월 16일 (금)" },
    ],
  );
  assert.deepEqual([...dayLines(items, NOW).keys()], ["evening", "after midnight"]);
});

test("items without a readable time draw no line and do not end the day before them", () => {
  const items: DisplayItem[] = [user("u1"), reply("a1", iso(2026, 10, 14, 22)), user("u2", "garbage"), reply("a2"), user("u3", iso(2026, 10, 14, 23)), user("u4", iso(2026, 10, 15, 7))];
  assert.deepEqual([...dayLines(items, NOW).keys()], ["a1", "u4"]);
  assert.equal(dayLines([user("x"), reply("y"), { kind: "note", id: "n", ts: iso(2026, 10, 15), code: "compacted" }], NOW).size, 0);
  assert.equal(dayLines([], NOW).size, 0);
});

test("a day of another year leads with its year, and the new year draws a line", () => {
  const items = [reply("old", iso(2025, 12, 31, 23, 58)), user("new", iso(2026, 1, 1, 0, 2))];
  assert.deepEqual(
    [...dayLines(items, NOW).values()].map((d) => d.label),
    ["2025년 12월 31일 (수)", "1월 1일 (목)"],
  );
  assert.equal(dayLabel(at(2026, 10, 5), NOW), "10월 5일 (월)");
  assert.equal(dayLabel(at(2026, 1, 1), at(2027, 3, 1)), "2026년 1월 1일 (목)");
});

test("a stamp reads as the local hour and minute, and its full time as the local date, weekday and time to the second", () => {
  assert.equal(clock(at(2026, 10, 15, 9, 5, 59)), "09:05");
  assert.equal(clock(new Date("2026-10-15T15:30:00Z")), "00:30");
  assert.equal(fullTime(at(2026, 10, 15, 16, 7, 5)), "2026년 10월 15일 (목) 16:07:05");
  assert.equal(fullTime(new Date("2025-01-01T15:00:00Z")), "2025년 1월 2일 (목) 00:00:00");
});
