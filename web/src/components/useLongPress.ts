import { useEffect, useRef } from "react";

const PRESS_MS = 450;
const MOVE_PX = 10;
// A click that a finger's release brings follows it at once; a tap of the user's own comes later.
const RELEASE_CLICK_MS = 300;

// The click a held finger may make as it lifts lands on whatever the opened sheet put under it, so a click right
// after the release is dropped.
function dropReleaseClick(): void {
  let timer: number | undefined;
  const drop = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    done();
  };
  const released = () => {
    clearTimeout(timer);
    timer = window.setTimeout(done, RELEASE_CLICK_MS);
  };
  const done = () => {
    clearTimeout(timer);
    window.removeEventListener("click", drop, true);
    window.removeEventListener("pointerup", released, true);
    window.removeEventListener("pointercancel", done, true);
  };
  window.addEventListener("click", drop, true);
  window.addEventListener("pointerup", released, true);
  window.addEventListener("pointercancel", done, true);
}

// A touch held still for a moment, a right click or the context-menu key calls `open` in place of a click. A touch
// that moves, as a scroll does, stays an ordinary touch.
export function useLongPress(open: () => void) {
  const timer = useRef<number | undefined>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);
  const touching = useRef(false);
  // Set while the touch that opened the actions is still down: the context menu a browser raises for that same hold
  // opens nothing more.
  const held = useRef(false);
  const cancel = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
    start.current = null;
  };
  const end = () => {
    cancel();
    touching.current = false;
    held.current = false;
  };
  const fire = () => {
    cancel();
    held.current = touching.current;
    if (touching.current) dropReleaseClick();
    open();
  };
  useEffect(() => cancel, []);
  return {
    onPointerDown: (e: React.PointerEvent) => {
      end();
      touching.current = e.pointerType !== "mouse";
      if (!touching.current || !e.isPrimary) return;
      start.current = { x: e.clientX, y: e.clientY };
      timer.current = window.setTimeout(fire, PRESS_MS);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const s = start.current;
      if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > MOVE_PX) cancel();
    },
    onPointerUp: end,
    onPointerCancel: end,
    onPointerLeave: cancel,
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      if (!held.current) fire();
    },
  };
}
