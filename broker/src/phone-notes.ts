// What a page reports of its own screen goes to the log as one line of short words and numbers, at most once every
// NOTE_EVERY_MS; a report with anything else in it is dropped.
const NOTE_EVERY_MS = 10_000;
const WORD = /^[a-z][a-z-]{0,23}$/;
const FLAGS = /^[a-z ]{0,80}$/;
const TRAIL_MAX = 20;
const SESSION_SHOWN = 8;

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined);
const pair = (v: unknown): [number, number] | undefined => {
  if (!Array.isArray(v) || v.length !== 2) return undefined;
  const [a, b] = v.map(num);
  return a === undefined || b === undefined ? undefined : [a, b];
};

function step(e: unknown): string | undefined {
  if (!Array.isArray(e) || (e.length !== 3 && e.length !== 4) || typeof e[0] !== "string" || !WORD.test(e[0])) return undefined;
  const ago = num(e[1]);
  const times = num(e[2]);
  const value = e.length === 4 ? num(e[3]) : undefined;
  if (ago === undefined || times === undefined || (e.length === 4 && value === undefined)) return undefined;
  return `${e[0]}${times > 1 ? ` x${times}` : ""} ${ago}ms${value === undefined ? "" : ` (${value})`}`;
}

const tail = (m: Record<string, unknown>) => {
  const flags = typeof m.flags === "string" && FLAGS.test(m.flags) ? m.flags.trim() : "";
  const trail = Array.isArray(m.trail) ? m.trail.slice(-TRAIL_MAX).map(step).filter((s) => s !== undefined) : [];
  return `${flags ? `, ${flags}` : ""}; before: ${trail.length ? trail.join(", ") : "nothing"}`;
};

// The line for a page's report that its conversation list moved more than a screen by itself, or (from older pages)
// went to its bottom so; undefined for any other report.
export function phoneNoteLine(m: Record<string, unknown>): string | undefined {
  if (typeof m.why !== "string" || !WORD.test(m.why)) return undefined;
  const view = num(m.view);
  const height = pair(m.height);
  const items = pair(m.items);
  if (view === undefined || !height || !items) return undefined;
  if (m.what === "list_moved") {
    const moved = num(m.moved);
    const top = pair(m.top);
    if (moved === undefined || !top) return undefined;
    return (
      `ccrc: the phone's conversation moved by itself (${m.why}): ${Math.abs(moved)}px toward its ${moved < 0 ? "start" : "end"}, ` +
      `top ${top[0]}->${top[1]}px, height ${height[0]}->${height[1]}px, items ${items[0]}->${items[1]}, view ${view}px${tail(m)}`
    );
  }
  const gap = num(m.gap);
  if (m.what !== "list_bottom" || gap === undefined) return undefined;
  return (
    `ccrc: the phone's conversation went to its bottom by itself (${m.why}): from ${gap}px above it, ` +
    `height ${height[0]}->${height[1]}px, items ${items[0]}->${items[1]}, view ${view}px${tail(m)}`
  );
}

// A logger of page reports for one broker.
export function phoneNotes(log: (line: string) => void = (line) => console.error(line), every = NOTE_EVERY_MS): (m: unknown, now?: number) => boolean {
  let at = -Infinity;
  return (m, now = Date.now()) => {
    if (now - at < every || m === null || typeof m !== "object") return false;
    const line = phoneNoteLine(m as Record<string, unknown>);
    if (!line) return false;
    at = now;
    log(line);
    return true;
  };
}

// A logger of the pages the conversation could not give a part to (history_changed): the start of the session's id and
// how many items it has, at most once every NOTE_EVERY_MS.
export function missedNotes(log: (line: string) => void = (line) => console.error(line), every = NOTE_EVERY_MS): (sessionId: string, items: number, now?: number) => boolean {
  let at = -Infinity;
  return (sessionId, items, now = Date.now()) => {
    if (now - at < every) return false;
    at = now;
    log(`ccrc: a phone asked for a part the conversation no longer has (history_changed): session ${sessionId.slice(0, SESSION_SHOWN)}, ${items} items`);
    return true;
  };
}
