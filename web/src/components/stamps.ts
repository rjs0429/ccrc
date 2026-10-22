import type { DisplayItem } from "../../../broker/src/protocol.ts";
import { dayLabel } from "../i18n/format.ts";

export { dayLabel, fullTime } from "../i18n/format.ts";

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

// The date line over a reply still streaming after a list with these date lines: the one it takes if it lands now,
// as Claude Code stamps a reply when its text ends. None while Claude thinks or before the reply has text.
export function streamLine(lines: Map<string, Day>, stream: { text: string; thinking: boolean }, now = new Date()): Day | undefined {
  if (stream.thinking || !stream.text.trim()) return undefined;
  const date = localDate(now);
  return [...lines.values()].at(-1)?.date === date ? undefined : { date, label: dayLabel(now, now) };
}
