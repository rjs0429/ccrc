import { useLayoutEffect, useRef, type RefObject } from "react";
import { CLOSE_SHARE, EDGE_PX, FADE_SHARE, RUBBER, SETTLE_MS, SLOP_PX, SPEED_MS, cleared, closes, follow, speedOf, type Mark } from "./dragClose.ts";

// A short sheet closes past this share of its own height, and its dim is clear once it is all the way down.
const SHEET_SHARE = 0.5;
// A sheet sent away comes back if its layer has not closed in this long.
const GONE_MS = 2500;
// A click this soon after a drag that moved the sheet belongs to the drag.
const CLICK_MS = 400;

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const typing = (el: Element) => Boolean(el.closest("input, textarea, select")) || (el instanceof HTMLElement && el.isContentEditable);

// A box between the finger and the panel that scrolls up from where it stands takes the drag itself.
function innerScrolled(from: Element, panel: HTMLElement): boolean {
  for (let el: Element | null = from; el && el !== panel; el = el.parentElement) {
    if (el.scrollTop > 0 && el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY)) return true;
  }
  return false;
}

function selectedIn(panel: HTMLElement): boolean {
  const s = getSelection();
  return Boolean(s && !s.isCollapsed && s.rangeCount && panel.contains(s.getRangeAt(0).commonAncestorContainer));
}

// A sheet's drag down to close: its grab parts (handle, title) take one any time, its content one that starts down at its
// top. iOS lets the page stop a scroll only on a touch's first touchmove, decided there by listeners that are not passive:
// the grab parts' always, the panel's only at its top (where it does not stretch), so a scroll lower down never waits.
export function useDragClose(ref: RefObject<HTMLElement | null>, grabRefs: readonly RefObject<HTMLElement | null>[], dimRefs: readonly RefObject<HTMLElement | null>[], close: () => void, grabsKey?: unknown): void {
  const latest = useRef(close);
  useLayoutEffect(() => {
    latest.current = close;
  });
  useLayoutEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    const grabs = grabRefs.flatMap((r) => (r.current ? [r.current] : []));
    const dims = () => dimRefs.flatMap((r) => (r.current ? [r.current] : []));
    const shadow = getComputedStyle(panel).boxShadow;
    let finger: { id: number; x: number; y: number; grab: boolean } | null = null;
    // Whether the touch drags the sheet, once its first move has decided.
    let owned: boolean | undefined;
    // The finger's height where the drag took hold, and how far the sheet had been dragged then.
    let hold: number | null = null;
    let raw = 0;
    let y = 0;
    let trail: Mark[] = [];
    let geo = { far: 0, reach: 0, away: 0, tail: false };
    let timer: number | undefined;
    let gone: number | undefined;
    let closing = false;
    let last: Event | null = null;
    let taking = false;
    let tailed = false;

    // A sheet on the bottom of its frame dragged up keeps its colour under it, a shadow as long as the gap.
    const paint = () => {
      panel.style.transform = y ? `translateY(${y}px)` : "";
      if (geo.tail && (y < 0 || tailed)) {
        tailed = true;
        panel.style.boxShadow = `0 ${Math.max(0, -y)}px 0 var(--surface)${shadow && shadow !== "none" ? `, ${shadow}` : ""}`;
      }
      const k = cleared(y, geo.reach);
      for (const d of dims()) d.style.opacity = k ? String(1 - k) : "";
    };
    const measure = () => {
      const frame = (panel.parentElement ?? panel).getBoundingClientRect();
      const box = panel.getBoundingClientRect();
      const top = box.top - y;
      geo = {
        far: Math.min(frame.height * CLOSE_SHARE, box.height * SHEET_SHARE),
        reach: Math.min(frame.height * FADE_SHARE, box.height),
        away: Math.max(0, frame.bottom - top),
        tail: Math.abs(top + box.height - frame.bottom) < 2,
      };
    };
    // Catches the sheet where an animation has it.
    const halt = () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      y = new DOMMatrixReadOnly(getComputedStyle(panel).transform).m42;
      for (const e of [panel, ...dims()]) e.style.transition = "";
      paint();
    };
    const animate = (to: number, then: () => void) => {
      halt();
      const ms = reduced() ? 0 : SETTLE_MS;
      const els = [panel, ...dims()];
      for (const e of els) void getComputedStyle(e).opacity;
      for (const e of els) e.style.transition = ms ? `transform ${ms}ms ease-out, opacity ${ms}ms ease-out, box-shadow ${ms}ms ease-out` : "";
      y = to;
      paint();
      timer = window.setTimeout(() => {
        timer = undefined;
        for (const e of els) e.style.transition = "";
        then();
      }, ms + 50);
    };
    const settle = () =>
      animate(0, () => {
        tailed = false;
        Object.assign(panel.style, { willChange: "", boxShadow: "" });
      });
    const leave = () => {
      closing = true;
      animate(geo.away, () => {
        latest.current();
        gone = window.setTimeout(() => {
          closing = false;
          settle();
        }, GONE_MS);
      });
    };
    // The click of the touch that dragged; the next touch is a tap of its own.
    let unswallow = () => {};
    const swallow = () => {
      const stop = (e: Event) => {
        e.stopPropagation();
        e.preventDefault();
      };
      panel.addEventListener("click", stop, { capture: true, once: true });
      const t = window.setTimeout(() => unswallow(), CLICK_MS);
      unswallow = () => {
        clearTimeout(t);
        panel.removeEventListener("click", stop, { capture: true });
        unswallow = () => {};
      };
    };
    // A touch's events go to the node it began on even once that node has left the panel, so they are taken there too.
    let bound: Element | null = null;
    const bind = (el: Element | null) => {
      const [onMove, onUp] = [move as EventListener, up as EventListener];
      bound?.removeEventListener("touchmove", onMove);
      bound?.removeEventListener("touchend", onUp);
      bound?.removeEventListener("touchcancel", onUp);
      bound = el;
      el?.addEventListener("touchmove", onMove, { passive: false });
      el?.addEventListener("touchend", onUp, { passive: true });
      el?.addEventListener("touchcancel", onUp, { passive: true });
    };
    const letGo = () => {
      bind(null);
      finger = null;
      owned = undefined;
      hold = null;
      if (y) settle();
      else panel.style.willChange = "";
    };

    const down = (e: TouchEvent) => {
      unswallow();
      if (closing) return;
      if (finger) letGo();
      if (e.touches.length > 1) return;
      const f = e.changedTouches[0];
      const at = e.target instanceof Element ? e.target : null;
      if (!f || !at || f.clientX < EDGE_PX) return;
      const grab = grabs.some((g) => g.contains(at));
      if (!grab && (!taking || panel.scrollTop >= 1 || typing(at) || at.closest("[data-zoom-stage]") || innerScrolled(at, panel) || selectedIn(panel))) return;
      halt();
      finger = { id: f.identifier, x: f.clientX, y: f.clientY, grab };
      bind(at);
    };
    const move = (e: TouchEvent) => {
      if (e === last) return;
      last = e;
      if (!finger || closing) return;
      if (e.touches.length > 1) return letGo();
      const id = finger.id;
      const f = [...e.touches].find((t) => t.identifier === id);
      if (!f) return;
      const dx = f.clientX - finger.x;
      const dy = f.clientY - finger.y;
      if (owned === undefined) {
        if (!dx && !dy) return;
        owned = e.cancelable && (finger.grab || (dy > 0 && dy >= Math.abs(dx)));
        if (!owned) return letGo();
        measure();
        panel.style.willChange = "transform";
      }
      // A long press that began a selection in the content keeps its finger.
      if (hold === null && !finger.grab && selectedIn(panel)) return letGo();
      if (e.cancelable) e.preventDefault();
      if (hold === null) {
        if (Math.hypot(dx, dy) < SLOP_PX) return;
        hold = f.clientY;
        raw = y >= 0 ? y : y / RUBBER;
        trail = [];
      }
      trail.push({ t: e.timeStamp, x: f.clientX, y: f.clientY });
      while (trail.length > 2 && e.timeStamp - trail[0].t > SPEED_MS) trail.shift();
      y = follow(raw + f.clientY - hold);
      paint();
    };
    const up = (e: TouchEvent) => {
      const id = finger?.id;
      const f = [...e.changedTouches].find((t) => t.identifier === id);
      if (!finger || !f) return;
      const dragged = hold !== null;
      if (!dragged) return letGo();
      bind(null);
      finger = null;
      owned = undefined;
      hold = null;
      trail.push({ t: e.timeStamp, x: f.clientX, y: f.clientY });
      swallow();
      if (e.type === "touchend" && closes(y, speedOf(trail).y, geo.far)) leave();
      else settle();
    };

    const take = (yes: boolean) => {
      if (yes === taking) return;
      taking = yes;
      if (yes) panel.addEventListener("touchmove", move, { passive: false });
      else panel.removeEventListener("touchmove", move);
      panel.style.overscrollBehaviorY = yes ? "none" : "";
    };
    const scrolled = () => take(panel.scrollTop < 1 || hold !== null);
    scrolled();
    for (const g of grabs) g.addEventListener("touchmove", move, { passive: false });
    panel.addEventListener("touchstart", down, { passive: true });
    panel.addEventListener("touchend", up, { passive: true });
    panel.addEventListener("touchcancel", up, { passive: true });
    panel.addEventListener("scroll", scrolled, { passive: true });
    return () => {
      clearTimeout(timer);
      clearTimeout(gone);
      take(false);
      for (const g of grabs) g.removeEventListener("touchmove", move);
      bind(null);
      unswallow();
      panel.removeEventListener("touchstart", down);
      panel.removeEventListener("touchend", up);
      panel.removeEventListener("touchcancel", up);
      panel.removeEventListener("scroll", scrolled);
      Object.assign(panel.style, { transform: "", transition: "", willChange: "", boxShadow: "" });
      for (const d of dims()) Object.assign(d.style, { opacity: "", transition: "" });
    };
  }, [grabsKey]);
}
