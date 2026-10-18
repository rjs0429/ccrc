import type { DisplayItem, HistoryPage, SnapshotGap } from "../../broker/src/protocol.ts";

// The part of a conversation a chat holds: its items from the first loaded on (or a far-back part, a gap and the latest
// part), whether more comes before them, and the agent and to-do calls of the parts not loaded, in order, the last
// `earlierInGap` of them from the gap.
export interface Held {
  items: DisplayItem[];
  hasMore: boolean;
  gap?: SnapshotGap;
  earlier?: DisplayItem[];
  earlierInGap?: number;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function replaced(list: DisplayItem[], at: number, item: DisplayItem): DisplayItem[] {
  const next = list.slice();
  next[at] = item;
  return next;
}

// An item that changed or came: in its place among the items or the earlier calls, after the item before it, or at the
// end from a broker that does not name that item. One that changed in a part not loaded and one that changes nothing
// give no change.
export function placed(c: Held, item: DisplayItem, prev: string | null | undefined): Partial<Held> | undefined {
  const at = c.items.findIndex((i) => i.id === item.id);
  if (at >= 0) return same(c.items[at], item) ? undefined : { items: replaced(c.items, at, item) };
  const aside = c.earlier?.findIndex((i) => i.id === item.id) ?? -1;
  if (aside >= 0) return same(c.earlier![aside], item) ? undefined : { earlier: replaced(c.earlier!, aside, item) };
  if (prev === undefined) return { items: [...c.items, item] };
  const after = prev === null ? (c.hasMore ? -2 : -1) : c.items.findIndex((i) => i.id === prev);
  if (after < -1 || (prev !== null && after < 0)) return undefined;
  return { items: [...c.items.slice(0, after + 1), item, ...c.items.slice(after + 1)] };
}

// The items with the earlier agent and to-do calls in their places: those before the loaded items first, those of the
// gap where it is.
export function withEarlier(c: Held): DisplayItem[] {
  const earlier = c.earlier ?? [];
  if (!earlier.length) return c.items;
  const inGap = Math.min(c.earlierInGap ?? 0, earlier.length);
  const before = earlier.slice(0, earlier.length - inGap);
  const gapAt = inGap && c.gap ? c.items.findIndex((i) => i.id === c.gap!.before) : -1;
  if (gapAt < 0) return [...before, ...c.items, ...earlier.slice(earlier.length - inGap)];
  return [...before, ...c.items.slice(0, gapAt), ...earlier.slice(earlier.length - inGap), ...c.items.slice(gapAt)];
}

// What a page loaded before the first item or into the gap makes of the held part.
export function joined(c: Held, part: "earlier" | "gap", page: HistoryPage): Partial<Held> {
  const held = new Set(c.items.map((i) => i.id));
  const fresh = page.items.filter((i) => !held.has(i.id));
  const ids = new Set(fresh.map((i) => i.id));
  const earlier = c.earlier?.filter((i) => !ids.has(i.id));
  const inGap = c.earlierInGap && c.earlier ? c.earlier.slice(c.earlier.length - c.earlierInGap).filter((i) => !ids.has(i.id)).length : undefined;
  const aside = { earlier: earlier?.length ? earlier : undefined, earlierInGap: inGap || undefined };
  if (part === "earlier") return { items: [...fresh, ...c.items], hasMore: page.more, ...aside };
  const at = c.gap ? c.items.findIndex((i) => i.id === c.gap!.before) : -1;
  if (at < 0) return {};
  const gap = page.more && c.gap ? { ...c.gap, skipped: Math.max(1, c.gap.skipped - fresh.length) } : undefined;
  return { items: [...c.items.slice(0, at), ...fresh, ...c.items.slice(at)], gap, ...aside };
}
