// What a page reports of its own screen goes to the log as one line of short words and numbers, at most once every
// NOTE_EVERY_MS; a report with anything else in it is dropped.
const NOTE_EVERY_MS = 10_000;
const WORD = /^[a-z][a-z-]{0,23}$/;
const FLAGS = /^[a-z ]{0,80}$/;
const TRAIL_MAX = 12;

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined);
const pair = (v: unknown): [number, number] | undefined => {
  if (!Array.isArray(v) || v.length !== 2) return undefined;
  const [a, b] = v.map(num);
  return a === undefined || b === undefined ? undefined : [a, b];
};

function step(e: unknown): string | undefined {
  if (!Array.isArray(e) || e.length !== 3 || typeof e[0] !== "string" || !WORD.test(e[0])) return undefined;
  const ago = num(e[1]);
  const times = num(e[2]);
  return ago === undefined || times === undefined ? undefined : `${e[0]}${times > 1 ? ` x${times}` : ""} ${ago}ms`;
}

// The line for a page's report that its conversation list went to its bottom by itself; undefined for any other report.
export function phoneNoteLine(m: Record<string, unknown>): string | undefined {
  if (m.what !== "list_bottom" || typeof m.why !== "string" || !WORD.test(m.why)) return undefined;
  const gap = num(m.gap);
  const view = num(m.view);
  const height = pair(m.height);
  const items = pair(m.items);
  if (gap === undefined || view === undefined || !height || !items) return undefined;
  const flags = typeof m.flags === "string" && FLAGS.test(m.flags) ? m.flags.trim() : "";
  const trail = Array.isArray(m.trail) ? m.trail.slice(-TRAIL_MAX).map(step).filter((s) => s !== undefined) : [];
  return (
    `ccrc: the phone's conversation went to its bottom by itself (${m.why}): from ${gap}px above it, ` +
    `height ${height[0]}->${height[1]}px, items ${items[0]}->${items[1]}, view ${view}px${flags ? `, ${flags}` : ""}; ` +
    `before: ${trail.length ? trail.join(", ") : "nothing"}`
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
