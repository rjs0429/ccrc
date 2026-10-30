import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { t } from "../i18n/index.ts";

// A list pulled down from its top past READY_PX refreshes as the finger lets go; BUSY_PX is the row it shows above the
// list meanwhile, for at least BUSY_MIN_MS and at most BUSY_MAX_MS.
export const READY_PX = 64;
const BUSY_PX = 44;
const BUSY_MIN_MS = 500;
const BUSY_MAX_MS = 8000;
const BACK_MS = 200;
// iOS's rubber band: the list follows the finger less the further it is pulled.
const STIFF = 0.55;
// A touch this close to the left edge belongs to the back swipe.
const EDGE_PX = 24;

type Phase = "idle" | "pull" | "ready" | "busy";

// How far the list is drawn down for a finger moved down by dy over a list of the given height.
export function pulled(dy: number, height: number): number {
  return dy <= 0 || height <= 0 ? 0 : (1 - 1 / ((dy * STIFF) / height + 1)) * height;
}

// A field in use or a sheet or viewer over the list takes the touch.
const elsewhere = () => {
  const el = document.activeElement;
  if (document.documentElement.hasAttribute("data-keyboard") || document.querySelector('[role="dialog"]')) return true;
  return el instanceof HTMLElement && (el.isContentEditable || el.matches("input, textarea, select"));
};

// A box inside the list that scrolls up from where the finger is takes the drag itself.
function innerScrolled(from: EventTarget | null, box: HTMLElement): boolean {
  for (let el = from instanceof Element ? from : null; el && el !== box; el = el.parentElement) {
    if (el.scrollTop > 0 && el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY)) return true;
  }
  return false;
}

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// The frame of a scrolling list, its child, that refreshes when pulled down from its top. The finger is followed on the
// page's own thread: a list that is busy while it is read (a conversation) takes the pull only at its top (atTop), and
// none of it while `on` is false. A list taking pulls neither stretches past its ends nor hands its scroll on.
export function Pull({ box, refresh, on = true, atTop = false, children }: { box: RefObject<HTMLElement | null>; refresh?: () => unknown; on?: boolean; atTop?: boolean; children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  const mark = useRef<HTMLDivElement>(null);
  const ring = useRef<HTMLSpanElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const latest = useRef(refresh);
  latest.current = refresh;
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const armed = on && Boolean(refresh);

  useEffect(() => {
    const el = box.current;
    const fr = frame.current;
    const mk = mark.current;
    if (!el || !fr || !mk || !armed) return;
    let shown: Phase = "idle";
    const show = (p: Phase) => {
      if (p !== shown) setPhase((shown = p));
    };
    const draw = (px: number) => {
      el.style.transform = px ? `translateY(${px}px)` : "";
      mk.style.height = `${px}px`;
      if (ring.current) {
        ring.current.style.opacity = String(Math.min(1, px / READY_PX));
        ring.current.style.transform = `rotate(${Math.round((px / READY_PX) * 270)}deg)`;
      }
    };
    const slide = (from: number) => {
      if (!reduced() && from) el.animate([{ transform: `translateY(${from}px)` }, { transform: "none" }], { duration: BACK_MS, easing: "ease-out" });
    };

    const run = async (from: number) => {
      busy.current = true;
      show("busy");
      fr.style.paddingTop = `${BUSY_PX}px`;
      el.style.transform = "";
      mk.style.height = `${BUSY_PX}px`;
      if (ring.current) ring.current.style.transform = "";
      slide(from - BUSY_PX);
      const began = performance.now();
      let timer: number | undefined;
      await Promise.race([Promise.resolve().then(() => latest.current?.()).catch(() => {}), new Promise((r) => (timer = window.setTimeout(r, BUSY_MAX_MS)))]);
      clearTimeout(timer);
      await new Promise((r) => setTimeout(r, Math.max(0, BUSY_MIN_MS - (performance.now() - began))));
      busy.current = false;
      if (!alive.current) return;
      fr.style.paddingTop = "";
      mk.style.height = "0px";
      slide(BUSY_PX);
      show("idle");
    };

    let start: { id: number; x: number; y: number } | null = null;
    let pulling = false;
    let px = 0;
    const end = (go: boolean) => {
      const from = px;
      start = null;
      pulling = false;
      px = 0;
      if (!from) return;
      if (go) return void run(from);
      draw(0);
      slide(from);
      show("idle");
    };
    // Another finger coming down ends a pull under way.
    const down = (e: TouchEvent) => {
      if (start || pulling) end(false);
      if (busy.current || e.touches.length !== 1 || el.scrollTop >= 1 || elsewhere() || innerScrolled(e.target, el)) return;
      const f = e.touches[0];
      if (f.clientX < EDGE_PX) return;
      start = { id: f.identifier, x: f.clientX, y: f.clientY };
    };
    const move = (e: TouchEvent) => {
      if (!start) return;
      const f = [...e.touches].find((x) => x.identifier === start!.id);
      if (!f || e.touches.length > 1) return end(false);
      const dx = f.clientX - start.x;
      const dy = f.clientY - start.y;
      if (!pulling) {
        if (!dx && !dy) return;
        if (dy <= 0 || Math.abs(dx) > dy || el.scrollTop >= 1) return void (start = null);
        pulling = true;
      }
      if (e.cancelable) e.preventDefault();
      px = pulled(dy, el.clientHeight);
      draw(px);
      show(px >= READY_PX ? "ready" : "pull");
    };
    const up = (e: TouchEvent) => {
      if (start && [...e.changedTouches].some((x) => x.identifier === start!.id)) end(e.type === "touchend" && px >= READY_PX);
    };

    // The finger is waited for only where a pull can start: always, or at the list's top.
    let taking = false;
    const take = (yes: boolean) => {
      if (yes === taking) return;
      taking = yes;
      if (yes) el.addEventListener("touchmove", move, { passive: false });
      else el.removeEventListener("touchmove", move);
      el.style.overscrollBehaviorY = yes ? "none" : "";
    };
    const scrolled = () => take(!atTop || el.scrollTop < 1 || pulling);
    scrolled();
    el.addEventListener("touchstart", down, { passive: true });
    el.addEventListener("touchend", up, { passive: true });
    el.addEventListener("touchcancel", up, { passive: true });
    if (atTop) el.addEventListener("scroll", scrolled, { passive: true });
    return () => {
      take(false);
      el.removeEventListener("touchstart", down);
      el.removeEventListener("touchend", up);
      el.removeEventListener("touchcancel", up);
      el.removeEventListener("scroll", scrolled);
      if (pulling) {
        draw(0);
        show("idle");
      }
    };
  }, [armed, atTop]);

  // The mark hangs from a line of no height above the frame, which stays unpositioned: the header, and a 44px button
  // reaching out of it, paint over the list.
  return (
    <>
      <div className="relative h-0" aria-hidden>
        <div ref={mark} className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-center gap-2 overflow-hidden text-[13px] text-muted" style={{ height: 0 }} data-pull-mark>
          {phase !== "idle" && (
            <>
              <span ref={ring} className="flex size-5 shrink-0" style={{ opacity: 0 }}>
                <svg viewBox="0 0 24 24" className={`size-5 ${phase === "busy" ? "animate-spin" : ""}`}>
                  <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth={3} opacity={0.2} />
                  <path d="M21 12a9 9 0 00-9-9" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" />
                </svg>
              </span>
              {phase === "ready" && <span>{t("놓으면 새로고침")}</span>}
              {phase === "busy" && <span>{t("새로고침 중…")}</span>}
            </>
          )}
        </div>
      </div>
      <div ref={frame} className="flex min-h-0 flex-1 flex-col overflow-hidden" data-pull-frame={phase}>
        {children}
      </div>
    </>
  );
}
