import type { DisplayItem } from "../../../broker/src/protocol.ts";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const two = (n: number) => String(n).padStart(2, "0");

// A day a date line marks: its local date (YYYY-MM-DD) and how it reads.
export interface Day {
  date: string;
  label: string;
}

// When a stamped message was sent: a user message, or a Claude reply with text. None for any other item or a
// time that does not read.
export function stampTime(item: DisplayItem): Date | undefined {
  const stamped = item.kind === "user" || (item.kind === "assistant" && item.text.trim() !== "");
  const at = stamped && item.ts ? new Date(item.ts) : undefined;
  return at && !Number.isNaN(at.getTime()) ? at : undefined;
}

const localDate = (at: Date) => `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
const dayText = (at: Date) => `${at.getMonth() + 1}월 ${at.getDate()}일 (${WEEKDAYS[at.getDay()]})`;

// "10월 15일 (목)"; a day of another year than now's leads with its year.
export function dayLabel(at: Date, now = new Date()): string {
  return at.getFullYear() === now.getFullYear() ? dayText(at) : `${at.getFullYear()}년 ${dayText(at)}`;
}

// The full local date and time behind a stamp: "2026년 10월 15일 (목) 16:07:05".
export function fullTime(at: Date): string {
  return `${at.getFullYear()}년 ${dayText(at)} ${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
}

// The date lines of a list by the id of the item each goes before: the first stamped item, and every stamped item
// whose local day is not that of the stamped item before it. Items without a stamp are passed over.
export function dayLines(items: DisplayItem[], now = new Date()): Map<string, Day> {
  const lines = new Map<string, Day>();
  let last: string | undefined;
  for (const item of items) {
    const at = stampTime(item);
    if (!at) continue;
    const date = localDate(at);
    if (date !== last) lines.set(item.id, { date, label: dayLabel(at, now) });
    last = date;
  }
  return lines;
}
