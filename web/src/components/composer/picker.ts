const STEP_MS = 50;
// The keyboard has gone down once the visual viewport has not changed for this long.
const QUIET_MS = 150;
// How long to wait for the first change before taking a still viewport as settled.
const FIRST_CHANGE_MS = 350;
// iOS carries a tap over to a timer for under a second.
const MAX_MS = 700;

// Calls open once, after the visual viewport settles from the keyboard going down or at MAX_MS. Every check is
// a timer set during the tap itself, the kind iOS carries the tap over to.
export function afterKeyboard(open: () => void): void {
  const vv = window.visualViewport;
  const start = performance.now();
  let changed = start;
  let moved = false;
  const onChange = () => {
    changed = performance.now();
    moved = true;
  };
  vv?.addEventListener("resize", onChange);
  vv?.addEventListener("scroll", onChange);
  const timers: number[] = [];
  const fire = () => {
    timers.forEach(clearTimeout);
    vv?.removeEventListener("resize", onChange);
    vv?.removeEventListener("scroll", onChange);
    open();
  };
  for (let at = STEP_MS * 2; at <= MAX_MS; at += STEP_MS) {
    timers.push(
      window.setTimeout(() => {
        const now = performance.now();
        if (at >= MAX_MS || (now - changed >= QUIET_MS && (moved || now - start >= FIRST_CHANGE_MS))) fire();
      }, at),
    );
  }
}
