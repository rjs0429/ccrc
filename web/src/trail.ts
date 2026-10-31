// What happened lately to the conversation on screen and to the connection, for the record of the list moving by itself:
// the last TRAIL_MAX happenings, each a short word with when it last came, how many times in a row, and a number for it.
const TRAIL_MAX = 20;

interface Step {
  k: string;
  at: number;
  n: number;
  v?: number;
}

const steps: Step[] = [];

export function note(k: string, v?: number): void {
  const at = performance.now();
  const last = steps.at(-1);
  if (last?.k === k && last.v === v) {
    last.at = at;
    last.n++;
    return;
  }
  steps.push(v === undefined ? { k, at, n: 1 } : { k, at, n: 1, v });
  if (steps.length > TRAIL_MAX) steps.shift();
}

// The happenings, the oldest first, as [what, ms before, times] or [what, ms before, times, number].
export function trail(): [string, number, number, number?][] {
  const now = performance.now();
  return steps.map((s) => (s.v === undefined ? [s.k, Math.round(now - s.at), s.n] : [s.k, Math.round(now - s.at), s.n, Math.round(s.v)]));
}
