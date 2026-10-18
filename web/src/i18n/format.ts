import { lang, locale } from "./index.ts";

// Dates, times and numbers as the current language writes them. Korean keeps its own forms; English takes the
// locale's (en-US: "Oct 15", "4:07 PM").
const two = (n: number) => String(n).padStart(2, "0");
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

const dates = new Map<string, Intl.DateTimeFormat>();
const numbers = new Map<string, Intl.NumberFormat>();

function dateFormat(o: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale()} ${JSON.stringify(o)}`;
  let f = dates.get(key);
  if (!f) dates.set(key, (f = new Intl.DateTimeFormat(locale(), o)));
  return f;
}

const valid = (d: Date) => !Number.isNaN(d.getTime());

export function num(n: number): string {
  let f = numbers.get(locale());
  if (!f) numbers.set(locale(), (f = new Intl.NumberFormat(locale())));
  return f.format(n);
}

// "16:07" / "4:07 PM"; nothing for a time that does not read.
export function clock(at?: Date | string | number): string {
  if (at === undefined || at === "") return "";
  const d = new Date(at);
  if (!valid(d)) return "";
  return lang() === "ko" ? `${two(d.getHours())}:${two(d.getMinutes())}` : dateFormat({ hour: "numeric", minute: "2-digit" }).format(d);
}

// "10월 18일" / "Oct 18".
export function monthDay(d: Date): string {
  return lang() === "ko" ? `${d.getMonth() + 1}월 ${d.getDate()}일` : dateFormat({ month: "short", day: "numeric" }).format(d);
}

// A date line: "10월 15일 (목)" / "Thu, Oct 15", with the year for another year than now's.
export function dayLabel(at: Date, now = new Date()): string {
  const year = at.getFullYear() !== now.getFullYear();
  if (lang() !== "ko") return dateFormat({ weekday: "short", month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}) }).format(at);
  const day = `${at.getMonth() + 1}월 ${at.getDate()}일 (${WEEKDAYS[at.getDay()]})`;
  return year ? `${at.getFullYear()}년 ${day}` : day;
}

// The full local date and time: "2026년 10월 15일 (목) 16:07:05" / "Thu, Oct 15, 2026, 4:07:05 PM".
export function fullTime(at: Date): string {
  if (lang() !== "ko") return dateFormat({ weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }).format(at);
  return `${at.getFullYear()}년 ${dayLabel(at, at)} ${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
}

// "10월 18일 16:07" / "Oct 18, 4:07 PM".
export function dateTime(at: Date): string {
  return lang() === "ko" ? `${monthDay(at)} ${clock(at)}` : dateFormat({ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(at);
}

// "10/18 16:07" / "10/18, 4:07 PM".
export function shortDateTime(at: Date): string {
  return lang() === "ko" ? `${at.getMonth() + 1}/${at.getDate()} ${clock(at)}` : dateFormat({ month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }).format(at);
}
