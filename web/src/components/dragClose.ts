// A drag down closes a layer the same way in the photo viewer and in the sheets: what is dragged follows the finger down
// and RUBBER of the way up, the dimmed parts clear as it goes, and let go it closes past a distance or at a flick, else
// springs back in SETTLE_MS. A finger that moves less than SLOP_PX is still on a tap.
export const SLOP_PX = 8;
// iOS takes a swipe from the screen's left edge for its back; a gesture that starts there is left to it.
export const EDGE_PX = 20;
export const RUBBER = 0.3;
// Shares of the height the layer is shown in: past CLOSE_SHARE a drag closes, at FADE_SHARE the dimmed parts are clear.
// A flick moves down at FLICK px/ms over the finger's last SPEED_MS.
export const CLOSE_SHARE = 0.15;
export const FADE_SHARE = 0.4;
export const FLICK = 0.4;
export const SPEED_MS = 100;
export const SETTLE_MS = 200;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
// Where what is dragged stands for a finger moved dy down from where the drag took hold.
export const follow = (dy: number): number => (dy > 0 ? dy : dy * RUBBER);
// How far the dimmed parts have cleared, 0 to 1, with what is dragged y down and clear at reach.
export const cleared = (y: number, reach: number): number => (reach > 0 ? clamp(y / reach, 0, 1) : 0);
// Whether a drag let go y down, its finger moving down at speed px/ms, closes: past far, or at a flick.
export const closes = (y: number, speed: number, far: number): boolean => y > far || (speed > FLICK && y > SLOP_PX);

export interface Mark {
  t: number;
  x: number;
  y: number;
}

// A finger's speed in px/ms over its last SPEED_MS.
export function speedOf(trail: readonly Mark[]): { x: number; y: number } {
  const end = trail.at(-1);
  const recent = trail.filter((p) => end && end.t - p.t <= SPEED_MS);
  const a = recent[0];
  const dt = end && a ? end.t - a.t : 0;
  return end && a && dt > 0 ? { x: (end.x - a.x) / dt, y: (end.y - a.y) / dt } : { x: 0, y: 0 };
}
