import { useLayoutEffect, useRef, type ReactNode } from "react";
import { kept, useKeep } from "../nav.ts";

// How long a screen coming back waits for its content to reach where it was scrolled to.
const RESTORE_MS = 1500;

// A screen's scrolling body. It does not hand its scroll on to the page, and a screen the back returns to comes back
// scrolled as it was left.
export function ScrollArea({ children, className = "" }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLElement>(null);
  useKeep("scroll", () => ref.current?.scrollTop ?? 0);
  useLayoutEffect(() => {
    const el = ref.current;
    const y = kept("scroll");
    if (!el || typeof y !== "number" || y <= 0) return;
    const reached = () => {
      el.scrollTop = y;
      return Math.abs(el.scrollTop - y) < 1;
    };
    if (reached()) return;
    // Content still loading: tried again as it comes in, until the user takes the list or it is late.
    const watch = new MutationObserver(() => reached() && stop());
    const timer = window.setTimeout(() => stop(), RESTORE_MS);
    const stop = () => {
      watch.disconnect();
      clearTimeout(timer);
      for (const type of ["pointerdown", "touchstart", "wheel", "keydown"]) el.removeEventListener(type, stop);
    };
    watch.observe(el, { childList: true, subtree: true });
    for (const type of ["pointerdown", "touchstart", "wheel", "keydown"]) el.addEventListener(type, stop, { passive: true });
    return stop;
  }, []);
  return (
    <main ref={ref} className={`flex-1 overflow-y-auto overscroll-contain ${className}`}>
      {children}
    </main>
  );
}
