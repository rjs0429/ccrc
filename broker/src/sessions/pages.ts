import type { DisplayItem, HistoryPage, SnapshotPart } from "../protocol.ts";

// A page holds up to PAGE_ITEMS items, fewer once their JSON passes PAGE_CHARS, and always one.
const PAGE_ITEMS = 40;
const PAGE_CHARS = 96 * 1024;
const FOCUS_BEFORE = 10;
// A gap shorter than this is sent with the parts around it.
const GAP_MIN = 10;
// A snapshot keeps the part the phone holds while that part has at most this many items.
const HELD_MAX = 600;
// The calls the agent chip, the agent map and the to-do panel read from the whole conversation.
const CONTEXT_TOOLS = new Set(["Agent", "Task", "Workflow", "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList"]);
const FOUND_TEXT_MAX = 300;
// Answered when the phone names an item the conversation no longer has; it asks for a new snapshot.
export const HISTORY_CHANGED = "history_changed";

const chars = (i: DisplayItem) => JSON.stringify(i).length;

// Where the page that ends before `end` starts.
export function pageStart(items: DisplayItem[], end: number): number {
  let from = end;
  let size = 0;
  while (from > 0 && end - from < PAGE_ITEMS) {
    size += chars(items[from - 1]);
    if (size > PAGE_CHARS && from < end) break;
    from--;
  }
  return from;
}

// Where the page that starts at `start` ends, never past `stop`.
export function pageEnd(items: DisplayItem[], start: number, stop: number): number {
  let to = start;
  let size = 0;
  while (to < stop && to - start < PAGE_ITEMS) {
    size += chars(items[to]);
    if (size > PAGE_CHARS && to > start) break;
    to++;
  }
  return to;
}

function withEarlier(before: DisplayItem[], gap: DisplayItem[]): Pick<SnapshotPart, "earlier" | "earlierInGap"> {
  const pick = (part: DisplayItem[]) => part.filter((i) => i.kind === "tool" && CONTEXT_TOOLS.has(i.name));
  const a = pick(before);
  const b = pick(gap);
  return a.length || b.length ? { earlier: [...a, ...b], ...(b.length ? { earlierInGap: b.length } : {}) } : {};
}

// What a snapshot sends: everything from the phone's first item while that part is not too long; else the part around a
// focused item further back, from the phone's first item when that lies before it, with the latest page and the gap
// between them; else the latest page.
export function snapshotPart(items: DisplayItem[], opts: { focus?: string; from?: string } = {}): SnapshotPart {
  const latest = pageStart(items, items.length);
  const index = (id?: string) => (id ? items.findIndex((i) => i.id === id) : -1);
  const at = index(opts.focus);
  const held = index(opts.from);
  const whole = (from: number): SnapshotPart => ({ items: items.slice(from), hasMore: from > 0, ...withEarlier(items.slice(0, from), []) });
  if (held >= 0 && held < latest && items.length - held <= HELD_MAX) return whole(held);
  if (at >= 0 && at < latest && held <= at) {
    const near = Math.max(0, at - FOCUS_BEFORE);
    const to = Math.max(at + 1, pageEnd(items, near, latest));
    const from = held >= 0 && held < near && to - held <= HELD_MAX ? held : near;
    if (latest - to < GAP_MIN) return whole(from);
    return {
      items: [...items.slice(from, to), ...items.slice(latest)],
      hasMore: from > 0,
      gap: { before: items[latest].id, skipped: latest - to },
      ...withEarlier(items.slice(0, from), items.slice(to, latest)),
    };
  }
  return whole(latest);
}

// The page before item `before`, or the items after item `after` up to item `until` or the end.
export function historyPage(items: DisplayItem[], args: Record<string, unknown>): HistoryPage {
  const at = (id: unknown) => (typeof id === "string" ? items.findIndex((i) => i.id === id) : -1);
  if (args.before !== undefined) {
    const end = at(args.before);
    if (end < 0) throw Error(HISTORY_CHANGED);
    const from = pageStart(items, end);
    return { items: items.slice(from, end), more: from > 0 };
  }
  if (args.after !== undefined) {
    const start = at(args.after) + 1;
    const stop = args.until === undefined ? items.length : at(args.until);
    if (start < 1 || stop < start) throw Error(HISTORY_CHANGED);
    const to = pageEnd(items, start, stop);
    return { items: items.slice(start, to), more: to < stop };
  }
  throw Error("invalid request");
}

// The user's messages, their text cut to what a list shows, or the file changes, from the whole conversation.
export function historyFind(items: DisplayItem[], find: unknown): DisplayItem[] {
  if (find === "users") return items.flatMap((i) => (i.kind === "user" ? [i.text.length > FOUND_TEXT_MAX ? { ...i, text: i.text.slice(0, FOUND_TEXT_MAX) } : i] : []));
  if (find === "changes") return items.filter((i) => i.kind === "tool" && i.file !== undefined && i.patch !== undefined);
  throw Error("invalid request");
}
