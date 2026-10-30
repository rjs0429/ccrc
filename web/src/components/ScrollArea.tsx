import { useLayoutEffect, useRef, type ReactNode } from "react";
import { kept, useKeep } from "../nav.ts";
import { glideTop, useToTop } from "../topTap.ts";
import { Pull } from "./Pull.tsx";

// How long a screen coming back waits for its content to reach where it was scrolled to.
const RESTORE_MS = 1500;

// A screen's scrolling body. It does not hand its scroll on to the page, and a screen the back returns to comes back
// scrolled as it was left. A tap on the status bar takes it to its top, and pulled down from there it refreshes.
export function ScrollArea({ children, className = "", onRefresh }: { children: ReactNode; className?: string; onRefresh?: () => unknown }) {
  const ref = useRef<HTMLElement>(null);
  const restoring = useRef<() => void>(undefined);
  useKeep("scroll", () => ref.current?.scrollTop ?? 0);
  useToTop(() => {
    restoring.current?.();
    glideTop(ref.current);
  });
  useLayoutEffect(() => {
    const el = ref.current;
    const y = kept("scroll");
    if (!el || typeof y !== "number" || y <= 0) return;
    const reached = () => {
      el.scrollTop = y;
      return Math.abs(el.scrollTop - y) < 1;
    };
    if (reached()) return;
    // Content still loading: tried again as it comes in, until the user takes the list (or sends it to the top) or it
    // is late.
    const watch = new MutationObserver(() => reached() && stop());
    const timer = window.setTimeout(() => stop(), RESTORE_MS);
    const stop = () => {
      watch.disconnect();
      clearTimeout(timer);
      restoring.current = undefined;
      for (const type of ["pointerdown", "touchstart", "wheel", "keydown"]) el.removeEventListener(type, stop);
    };
    restoring.current = stop;
    watch.observe(el, { childList: true, subtree: true });
    for (const type of ["pointerdown", "touchstart", "wheel", "keydown"]) el.addEventListener(type, stop, { passive: true });
    return stop;
  }, []);
  return (
    <Pull box={ref} refresh={onRefresh}>
      <main ref={ref} className={`flex-1 overflow-y-auto overscroll-contain ${className}`}>
        {children}
      </main>
    </Pull>
  );
}
