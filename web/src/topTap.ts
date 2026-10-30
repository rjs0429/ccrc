import { useLayoutEffect, useRef } from "react";

// iOS takes a tap on the status bar to the page's own scroll only, and WebKit gives none of it to a scroll box, where
// every screen of the app scrolls. So in a Home Screen web app the page is 1px taller than the screen and rests 1px
// down: a tap scrolls it to 0, and the list of the screen on show goes to its top instead.
const REST_PX = 1;
// The page leaving its rest is a tap only with no finger on the page from QUIET_MS before, nothing else that moves it
// from CALM_MS before (the app's scrollIntoView or focus, the keyboard, a field's focus, a resize or turn, the app coming
// to the front), no field in use and no sheet or viewer open.
export const QUIET_MS = 300;
export const CALM_MS = 800;
// The decision waits for what else the frame that moved the page brings, such as a resize; the page goes back to its
// rest once iOS's own scroll of the tap has ended.
const DECIDE_MS = 60;
const BACK_MS = 400;
// A list going further than FAR_SCREENS jumps to NEAR_SCREENS from where it goes, and scrolls the rest smoothly.
const FAR_SCREENS = 2;
const NEAR_SCREENS = 1.5;

export interface Moment {
  fingers: number;
  touchedAt: number;
  calmAt: number;
  typing: boolean;
  keyboard: boolean;
  layer: boolean;
}

// Whether the page that left its rest at `left` was taken there by a tap on the status bar.
export function statusTap(m: Moment, left: number): boolean {
  return !m.fingers && !m.typing && !m.keyboard && !m.layer && left - m.touchedAt >= QUIET_MS && left - m.calmAt >= CALM_MS;
}

// Takes a list to a position (top, or where `top()` says then) with the browser's smooth scroll, or at once when motion
// is to be reduced. After a step the smooth part starts on the next frame, unless `on()` has turned false by then.
export function glideTo(el: HTMLElement, top: number | (() => number), on: () => boolean = () => true): void {
  const target = () => Math.max(0, Math.min(typeof top === "number" ? top : top(), el.scrollHeight - el.clientHeight));
  const to = target();
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    el.scrollTop = to;
    return;
  }
  if (Math.abs(to - el.scrollTop) <= el.clientHeight * FAR_SCREENS) {
    el.scrollTo({ top: to, behavior: "smooth" });
    return;
  }
  const near = el.clientHeight * NEAR_SCREENS;
  el.scrollTop = to + (el.scrollTop > to ? near : -near);
  requestAnimationFrame(() => on() && el.scrollTo({ top: target(), behavior: "smooth" }));
}

// A list's way up to its top; going: whether it is still under way.
export function glideTop(el: HTMLElement | null, going?: () => boolean): void {
  if (el && el.scrollTop >= 1) glideTo(el, 0, going);
}

// The screen on show, the last one to say how its list goes to the top.
const screens: { go: () => void }[] = [];

// Takes the screen's list to its top: the home title's tap, or the status bar's.
export function toTop(): void {
  screens.at(-1)?.go();
}

// How the screen's list goes to its top, while the screen is on show.
export function useToTop(go: () => void): void {
  const latest = useRef(go);
  useLayoutEffect(() => {
    latest.current = go;
  });
  useLayoutEffect(() => {
    watch();
    const screen = { go: () => latest.current() };
    screens.push(screen);
    return () => {
      const i = screens.indexOf(screen);
      if (i >= 0) screens.splice(i, 1);
    };
  }, []);
}

let watching = false;
let fingers = 0;
let touchedAt = -Infinity;
let calmAt = -Infinity;
let left = 0;
let deciding: number | undefined;
let backTimer: number | undefined;

const editable = (el: Element | null) => el instanceof HTMLElement && (el.isContentEditable || el.matches("input, textarea, select"));
const keyboardUp = () => document.documentElement.hasAttribute("data-keyboard");
const resting = () => window.scrollY >= REST_PX - 0.5;

function moment(): Moment {
  return {
    fingers,
    touchedAt,
    calmAt,
    typing: editable(document.activeElement),
    keyboard: keyboardUp(),
    layer: Boolean(document.querySelector('[role="dialog"]')),
  };
}

function back(): void {
  backTimer = undefined;
  if (resting() || fingers || editable(document.activeElement) || keyboardUp()) return;
  window.scrollTo(0, REST_PX);
}

function backSoon(ms: number): void {
  clearTimeout(backTimer);
  backTimer = window.setTimeout(back, ms);
}

function decide(): void {
  deciding = undefined;
  if (statusTap(moment(), left)) toTop();
  backSoon(BACK_MS);
}

function pageScrolled(): void {
  if (resting() || deciding !== undefined || backTimer !== undefined) return;
  left = performance.now();
  deciding = window.setTimeout(decide, DECIDE_MS);
}

function calm(): void {
  calmAt = performance.now();
  if (!resting() && deciding === undefined) backSoon(CALM_MS);
}

function touched(e: TouchEvent): void {
  fingers = e.touches.length;
  touchedAt = performance.now();
  if (!fingers && !resting() && deciding === undefined) backSoon(QUIET_MS);
}

// Only in an iOS Home Screen web app; elsewhere the page keeps its height and a scroll bar of 1px never shows.
function watch(): void {
  if (watching) return;
  watching = true;
  if ((navigator as Navigator & { standalone?: boolean }).standalone !== true) return;
  document.documentElement.setAttribute("data-top-tap", "");
  const passive = { capture: true, passive: true };
  window.addEventListener("touchstart", touched, passive);
  window.addEventListener("touchend", touched, passive);
  window.addEventListener("touchcancel", touched, passive);
  window.addEventListener("scroll", pageScrolled, { passive: true });
  window.visualViewport?.addEventListener("resize", calm);
  window.addEventListener("resize", calm);
  window.addEventListener("pageshow", calm);
  document.addEventListener("visibilitychange", calm);
  document.addEventListener("focusin", calm);
  document.addEventListener("focusout", calm);
  // What the app brings into view moves the page by its 1px too.
  const scrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element, arg?: boolean | ScrollIntoViewOptions) {
    calmAt = performance.now();
    scrollIntoView.call(this, arg);
  };
  const focus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
    if (!options?.preventScroll) calmAt = performance.now();
    focus.call(this, options);
  };
  requestAnimationFrame(() => window.scrollTo(0, REST_PX));
}
