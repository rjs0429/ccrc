// A line from a wrapper that the broker fails on is dropped, and the lines after it go on. The log says what kind of
// line it was and the error's first line, never the line itself, once a minute for each kind.

const LOG_EVERY_MS = 60_000;
const KINDS_MAX = 100;
const WORD = /^[A-Za-z0-9_.-]{1,40}$/;

const logged = new Map<string, { at: number; more: number }>();

const word = (v: unknown) => (typeof v === "string" && WORD.test(v) ? v : "?");

// The frame, and the type and subtype of the message it carries.
export function lineKind(frame: unknown, m?: unknown): string {
  const r = m !== null && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : undefined;
  if (!r) return word(frame);
  return `${word(frame)}:${word(r.type)}${r.subtype === undefined ? "" : `/${word(r.subtype)}`}`;
}

function firstLine(e: unknown): string {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  const at = e instanceof Error ? /\n\s+at .*?([^/\s()]+:\d+:\d+)\)?$/m.exec(e.stack ?? "")?.[1] : undefined;
  return `${text.split("\n")[0].slice(0, 200)}${at ? ` at ${at}` : ""}`;
}

// Runs the handling of one line; false when it threw.
export function guarded(kind: string, handle: () => void, log: (line: string) => void = (line) => console.error(line), now = Date.now()): boolean {
  try {
    handle();
    return true;
  } catch (e) {
    const last = logged.get(kind);
    if (last && now - last.at < LOG_EVERY_MS) {
      last.more++;
      return false;
    }
    logged.delete(kind);
    logged.set(kind, { at: now, more: 0 });
    for (const old of [...logged.keys()].slice(0, -KINDS_MAX)) logged.delete(old);
    const more = last?.more ? `; ${last.more} more since` : "";
    log(`ccrc: dropped a line from a wrapper (${kind}): ${firstLine(e)}${more}`);
    return false;
  }
}
