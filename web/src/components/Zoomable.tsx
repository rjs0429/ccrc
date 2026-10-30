import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";
import { CLOSE_SHARE, EDGE_PX, FADE_SHARE, FLICK, RUBBER, SETTLE_MS, SLOP_PX, SPEED_MS, clamp, cleared, closes, follow, speedOf, type Mark } from "./dragClose.ts";

// A pinch zooms between 1x and MAX_SCALE, a long picture to half again its filling scale when that is more. A double tap
// goes to TAP_SCALE or to the filling scale, whichever is larger.
const MAX_SCALE = 5;
const TAP_SCALE = 2.5;
const TAP_MS = 300;
const TAP_PX = 20;
const GAP_PX = 16;
const COAST_MS = 300;
// A swipe turns past TURN_SHARE of the stage's width or at FLICK px/ms. Past its limits a picture follows the finger at
// RUBBER and springs back once let go; a drag down closes by the measures the sheets share (dragClose.ts).
const TURN_SHARE = 0.25;
const WHEEL_STEP = 0.5;

interface View {
  s: number;
  x: number;
  y: number;
}

// The stage's box, and the picture's centre and size at 1x; own: the scale at which it shows at its own pixels.
interface Geo {
  left: number;
  right: number;
  top: number;
  bottom: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
  w0: number;
  h0: number;
  own: number;
}

interface Live {
  count: number;
  index: number;
  onIndex?: (index: number) => void;
  onClose?: () => void;
  dim?: readonly RefObject<HTMLElement | null>[];
}

type Mode = "wait" | "pan" | "pinch" | "swipe" | "drop" | "off";

const ONE: View = { s: 1, x: 0, y: 0 };
const rubber = (v: number, lo: number, hi: number) => (v < lo ? lo - (lo - v) * RUBBER : v > hi ? hi + (v - hi) * RUBBER : v);

// The gestures on a stage. The picture shown is the img of the slide marked data-zoom-current; the track holds the slides.
function control(stage: HTMLElement, track: HTMLElement, live: () => Live) {
  let view: View = ONE;
  let shift = 0;
  let lift = { x: 0, y: 0 };
  // The offset a swipe left the row at, carried over to the picture it turned to.
  let carry: number | null = null;
  let mode: Mode | null = null;
  let moved = false;
  const pts = new Map<number, { x: number; y: number }>();
  let from = { x: 0, y: 0, view: ONE, shift: 0 };
  // q: the point of the picture, from its centre at 1x, under the fingers' centre c.
  let pinch = { d: 1, s: 1, qx: 0, qy: 0, cx: 0, cy: 0 };
  let geo: Geo = { left: 0, right: 0, top: 0, bottom: 0, w: 0, h: 0, cx: 0, cy: 0, w0: 0, h0: 0, own: 1 };
  let trail: Mark[] = [];
  let tap: { t: number; x: number; y: number } | null = null;
  let twice = false;
  let anim: { timer: number; track: boolean } | null = null;
  // The scale a Mac's gesture events had reached; 0 outside one.
  let gesture = 0;

  const picture = () => track.querySelector<HTMLElement>("[data-zoom-current] img");
  const dims = () => (live().dim ?? []).flatMap((r) => (r.current ? [r.current] : []));
  const moving = () => [picture(), track, ...dims()].filter((e): e is HTMLElement => Boolean(e));

  // The picture is drawn by object-fit: contain, so what shows is its own shape fitted into its box.
  function measure(): Geo {
    const r = stage.getBoundingClientRect();
    const img = picture();
    const b = img?.getBoundingClientRect();
    const nw = img instanceof HTMLImageElement ? img.naturalWidth : 0;
    const nh = img instanceof HTMLImageElement ? img.naturalHeight : 0;
    const fit = b && nw && nh ? Math.min(b.width / nw, b.height / nh) / view.s : 0;
    const w0 = fit ? nw * fit : b ? b.width / view.s : 0;
    const h0 = fit ? nh * fit : b ? b.height / view.s : 0;
    return {
      own: nw && w0 ? nw / w0 : 1,
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      w: r.width,
      h: r.height,
      cx: b ? (b.left + b.right) / 2 - view.x - shift : (r.left + r.right) / 2,
      cy: b ? (b.top + b.bottom) / 2 - view.y : (r.top + r.bottom) / 2,
      w0: w0 >= 1 && h0 >= 1 ? w0 : 0,
      h0: w0 >= 1 && h0 >= 1 ? h0 : 0,
    };
  }

  // How far the picture may move at scale s: it covers the stage where it is larger, and stays put where it is not.
  function limits(s: number) {
    const hw = (geo.w0 * s) / 2;
    const hh = (geo.h0 * s) / 2;
    return {
      x0: Math.min(0, geo.right - geo.cx - hw),
      x1: Math.max(0, geo.left - geo.cx + hw),
      y0: Math.min(0, geo.bottom - geo.cy - hh),
      y1: Math.max(0, geo.top - geo.cy + hh),
    };
  }

  // The filling scale: the picture covers the stage, as a long screenshot fills its width, short of showing it larger
  // than its own pixels.
  function fill(): number {
    const { w, h, w0, h0, own } = geo;
    return Math.min(Math.max(w / w0, h / h0), Math.max(own, TAP_SCALE));
  }
  const most = () => Math.max(MAX_SCALE, fill() * 1.5);

  function paint(): void {
    const img = picture();
    if (img) img.style.transform = view.s === 1 && !view.x && !view.y ? "" : `translate(${view.x}px, ${view.y}px) scale(${view.s})`;
    stage.dataset.scale = String(Math.round(view.s * 100) / 100);
  }
  function paintTrack(): void {
    track.style.transform = shift ? `translateX(${shift}px)` : "";
  }
  function paintLift(): void {
    const img = picture();
    const k = cleared(lift.y, geo.h * FADE_SHARE);
    if (img) img.style.transform = `translate(${lift.x}px, ${lift.y}px) scale(${1 - k / 4})`;
    for (const el of dims()) el.style.opacity = String(1 - k);
  }

  function animate(ms: number, ease: string, set: () => void, row = false): void {
    settleNow();
    const els = moving();
    for (const el of els) void getComputedStyle(el).transform;
    for (const el of els) el.style.transition = `transform ${ms}ms ${ease}, opacity ${ms}ms ${ease}`;
    set();
    anim = { timer: window.setTimeout(ended, ms + 50), track: row };
  }
  function ended(): void {
    anim = null;
    for (const el of moving()) el.style.transition = "";
  }
  // A finger that lands while the picture settles finds it settled; a row still moving is caught where it is.
  function settleNow(): void {
    if (!anim) return;
    window.clearTimeout(anim.timer);
    if (anim.track) {
      const { count, index } = live();
      const at = new DOMMatrixReadOnly(getComputedStyle(track).transform).m41;
      shift = (at > 0 && index === 0) || (at < 0 && index >= count - 1) ? 0 : at;
    }
    ended();
    paintTrack();
  }

  const speed = () => speedOf(trail);

  function pinchStart(): void {
    const [a, b] = [...pts.values()];
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    pinch = { d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), s: view.s, qx: (cx - geo.cx - view.x) / view.s, qy: (cy - geo.cy - view.y) / view.s, cx, cy };
  }

  function down(e: PointerEvent): void {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // A primary pointer starts a gesture afresh.
    if (e.isPrimary) {
      pts.clear();
      mode = null;
    }
    if (pts.size > 1) return;
    settleNow();
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      geo = measure();
      from = { x: e.clientX, y: e.clientY, view, shift };
      trail = [{ t: e.timeStamp, x: e.clientX, y: e.clientY }];
      twice = tap !== null && e.timeStamp - tap.t < TAP_MS && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < TAP_PX;
      moved = false;
      mode = e.pointerType !== "mouse" && e.clientX < EDGE_PX ? "off" : view.s > 1.001 ? "pan" : "wait";
    } else {
      twice = false;
      tap = null;
      moved = true;
      if (!geo.w0) {
        mode = "off";
        return;
      }
      for (const id of pts.keys()) capture(id);
      shift = 0;
      paintTrack();
      if (mode === "drop") {
        lift = { x: 0, y: 0 };
        for (const el of dims()) el.style.opacity = "";
        paint();
      }
      pinchStart();
      mode = "pinch";
    }
    const img = picture();
    if (img) img.style.willChange = "transform";
  }

  // Held from the moment a gesture moves, so it goes on outside the stage; a tap keeps its own target and click.
  function capture(id: number): void {
    try {
      stage.setPointerCapture(id);
    } catch {}
  }

  function move(e: PointerEvent): void {
    const p = pts.get(e.pointerId);
    if (!p || !mode) return;
    p.x = e.clientX;
    p.y = e.clientY;
    if (mode === "pinch") return pinchMove();
    if (pts.size > 1) return;
    trail.push({ t: e.timeStamp, x: p.x, y: p.y });
    while (trail.length > 2 && e.timeStamp - trail[0].t > SPEED_MS) trail.shift();
    const dx = p.x - from.x;
    const dy = p.y - from.y;
    if (!moved) {
      if (Math.hypot(dx, dy) < SLOP_PX) return;
      moved = true;
      twice = false;
      tap = null;
      capture(e.pointerId);
      if (mode === "wait") mode = Math.abs(dx) >= Math.abs(dy) ? "swipe" : dy > 0 && live().onClose ? "drop" : "off";
      from = { ...from, x: p.x, y: p.y };
      return;
    }
    if (mode === "pan") {
      const l = limits(view.s);
      view = { s: view.s, x: rubber(from.view.x + dx, l.x0, l.x1), y: rubber(from.view.y + dy, l.y0, l.y1) };
      paint();
    } else if (mode === "swipe") {
      const { count, index } = live();
      shift = rubber(from.shift + dx, index < count - 1 ? -Infinity : 0, index > 0 ? Infinity : 0);
      paintTrack();
    } else if (mode === "drop") {
      lift = { x: dx, y: follow(dy) };
      paintLift();
    }
  }

  function pinchMove(): void {
    const [a, b] = [...pts.values()];
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const raw = pinch.s * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d);
    const top = most();
    const s = raw > top ? top + (raw - top) * RUBBER : raw < 1 ? 1 - (1 - raw) * RUBBER : raw;
    view = { s, x: cx - geo.cx - s * pinch.qx, y: cy - geo.cy - s * pinch.qy };
    pinch.cx = cx;
    pinch.cy = cy;
    paint();
  }

  function up(e: PointerEvent, cancel = false): void {
    if (!pts.delete(e.pointerId)) return;
    if (pts.size === 1) {
      if (mode !== "pinch") return;
      // The finger left of a pinch pans what it left, from where it is.
      const [p] = [...pts.values()];
      from = { x: p.x, y: p.y, view, shift };
      trail = [{ t: e.timeStamp, x: p.x, y: p.y }];
      mode = view.s > 1.001 && !cancel ? "pan" : "off";
      return;
    }
    if (pts.size) return;
    const was = mode;
    mode = null;
    const img = picture();
    if (img) img.style.willChange = "";
    if (cancel) {
      tap = null;
      return settle();
    }
    trail.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
    if (!moved && (was === "wait" || was === "pan")) return tapped(e);
    if (was === "swipe") return turn();
    if (was === "drop") return drop();
    if (was === "pan") return coast();
    settle();
  }

  function tapped(e: PointerEvent): void {
    if (!twice) {
      tap = { t: e.timeStamp, x: e.clientX, y: e.clientY };
      return;
    }
    tap = null;
    twice = false;
    if (!geo.w0) return;
    if (view.s > 1.001) return animate(SETTLE_MS, "ease-out", () => ((view = ONE), paint()));
    const s = Math.min(most(), Math.max(TAP_SCALE, fill()));
    const qx = e.clientX - geo.cx;
    const qy = e.clientY - geo.cy;
    const l = limits(s);
    const next = { s, x: clamp(qx - s * qx, l.x0, l.x1), y: clamp(qy - s * qy, l.y0, l.y1) };
    animate(SETTLE_MS, "ease-out", () => ((view = next), paint()));
  }

  function turn(): void {
    const { count, index, onIndex } = live();
    const v = speed().x;
    const to = shift < 0 && (shift < -geo.w * TURN_SHARE || v < -FLICK) ? index + 1 : shift > 0 && (shift > geo.w * TURN_SHARE || v > FLICK) ? index - 1 : index;
    if (to !== index && to >= 0 && to < count && onIndex) {
      carry = shift + (to > index ? 1 : -1) * (geo.w + GAP_PX);
      flushSync(() => onIndex(to));
      if (carry === null) return;
      carry = null;
    }
    animate(SETTLE_MS, "ease-out", () => ((shift = 0), paintTrack()), true);
  }

  function drop(): void {
    if (closes(lift.y, speed().y, geo.h * CLOSE_SHARE)) return live().onClose?.();
    settle();
  }

  // A pan coasts on a little at the speed it was let go, and stops at the edges; one left of a pinch past the most or
  // under 1x settles instead.
  function coast(): void {
    if (view.s > most() || view.s < 1) return settle();
    const l = limits(view.s);
    const v = speed();
    const inside = view.x >= l.x0 && view.x <= l.x1 && view.y >= l.y0 && view.y <= l.y1;
    const go = inside ? COAST_MS / 2 : 0;
    const next = { s: view.s, x: clamp(view.x + v.x * go, l.x0, l.x1), y: clamp(view.y + v.y * go, l.y0, l.y1) };
    if (next.x === view.x && next.y === view.y) return;
    animate(COAST_MS, "cubic-bezier(0.2, 0.8, 0.3, 1)", () => ((view = next), paint()));
  }

  // Back within the limits: the scale between 1x and the most, about the fingers' last centre; the row and a lift at rest.
  function settle(): void {
    let { s, x, y } = view;
    const top = most();
    if (s > top) {
      const qx = (pinch.cx - geo.cx - x) / s;
      const qy = (pinch.cy - geo.cy - y) / s;
      s = top;
      x = pinch.cx - geo.cx - s * qx;
      y = pinch.cy - geo.cy - s * qy;
    } else if (s < 1.001) {
      s = 1;
      x = 0;
      y = 0;
    }
    const l = limits(s);
    const next = { s, x: clamp(x, l.x0, l.x1), y: clamp(y, l.y0, l.y1) };
    if (next.s === view.s && next.x === view.x && next.y === view.y && !shift && !lift.x && !lift.y) return;
    animate(SETTLE_MS, "ease-out", () => {
      view = next;
      shift = 0;
      lift = { x: 0, y: 0 };
      paint();
      paintTrack();
      for (const el of dims()) el.style.opacity = "";
    });
  }

  function zoomAt(x: number, y: number, to: number): void {
    const s = clamp(to, 1, most());
    const qx = (x - geo.cx - view.x) / view.s;
    const qy = (y - geo.cy - view.y) / view.s;
    const l = limits(s);
    view = s === 1 ? ONE : { s, x: clamp(x - geo.cx - s * qx, l.x0, l.x1), y: clamp(y - geo.cy - s * qy, l.y0, l.y1) };
    paint();
  }

  // A trackpad's pinch comes as the wheel with ctrl, as does ctrl with a mouse wheel, whose notch zooms by at most
  // WHEEL_STEP (an exponent); in Safari on a Mac it comes as gesture events, and the wheel waits while one lasts. The
  // wheel alone pans a picture zoomed in.
  function wheel(e: WheelEvent): void {
    if (pts.size) return;
    if (gesture) return e.preventDefault();
    settleNow();
    geo = measure();
    if (!geo.w0) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? geo.h : 1;
    if (e.ctrlKey) {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, view.s * Math.exp(clamp(-e.deltaY * unit * 0.01, -WHEEL_STEP, WHEEL_STEP)));
    } else if (view.s > 1.001) {
      e.preventDefault();
      const l = limits(view.s);
      view = { s: view.s, x: clamp(view.x - e.deltaX * unit, l.x0, l.x1), y: clamp(view.y - e.deltaY * unit, l.y0, l.y1) };
      paint();
    }
  }

  // The picture shown changed: it starts at 1x, and the row a swipe left on its way settles from there.
  function turned(): void {
    settleNow();
    for (const img of track.querySelectorAll<HTMLElement>("img")) {
      img.style.transform = "";
      img.style.willChange = "";
      img.style.transition = "";
    }
    view = ONE;
    lift = { x: 0, y: 0 };
    for (const el of dims()) el.style.opacity = "";
    if (pts.size) mode = "off";
    stage.dataset.scale = "1";
    const c = carry;
    carry = null;
    shift = c ?? 0;
    paintTrack();
    if (c !== null) animate(SETTLE_MS, "ease-out", () => ((shift = 0), paintTrack()), true);
  }

  // A stage that changes size, as the phone turns, shows its picture whole again.
  const resized = new ResizeObserver(() => {
    if (pts.size || (view === ONE && !shift)) return;
    settleNow();
    view = ONE;
    shift = 0;
    paint();
    paintTrack();
  });
  // Safari zooms the page on its gesture events unless they are held back. On a Mac they carry a trackpad's pinch, with
  // no finger on the stage, and zoom the picture as the wheel with ctrl does.
  function gestureStart(e: Event): void {
    e.preventDefault();
    if (pts.size) return;
    settleNow();
    geo = measure();
    gesture = geo.w0 ? 1 : 0;
  }
  function gestureChange(e: Event): void {
    e.preventDefault();
    const g = e as Event & { scale?: number; clientX?: number; clientY?: number };
    if (pts.size || !gesture || !g.scale || g.clientX === undefined || g.clientY === undefined) return;
    zoomAt(g.clientX, g.clientY, (view.s * g.scale) / gesture);
    gesture = g.scale;
  }
  const gestureEnd = () => (gesture = 0);

  const cancel = (e: PointerEvent) => up(e, true);
  const lifted = (e: PointerEvent) => up(e);
  stage.addEventListener("pointerdown", down);
  stage.addEventListener("pointermove", move);
  stage.addEventListener("pointerup", lifted);
  stage.addEventListener("pointercancel", cancel);
  stage.addEventListener("wheel", wheel, { passive: false });
  stage.addEventListener("gesturestart", gestureStart, { passive: false });
  stage.addEventListener("gesturechange", gestureChange, { passive: false });
  stage.addEventListener("gestureend", gestureEnd);
  resized.observe(stage);
  return {
    turned,
    stop() {
      if (anim) window.clearTimeout(anim.timer);
      resized.disconnect();
      stage.removeEventListener("pointerdown", down);
      stage.removeEventListener("pointermove", move);
      stage.removeEventListener("pointerup", lifted);
      stage.removeEventListener("pointercancel", cancel);
      stage.removeEventListener("wheel", wheel);
      stage.removeEventListener("gesturestart", gestureStart);
      stage.removeEventListener("gesturechange", gestureChange);
      stage.removeEventListener("gestureend", gestureEnd);
    },
  };
}

export interface ZoomableProps {
  // The pictures in the row, and the one shown; at 1x a swipe turns to the next or the one before.
  count?: number;
  index?: number;
  onIndex?: (index: number) => void;
  // At 1x a drag down closes: the picture follows the finger and what dim holds fades as it goes.
  onClose?: () => void;
  dim?: readonly RefObject<HTMLElement | null>[];
  // A slide's content: the picture as an img with object-fit: contain, which the stage moves, and whatever shows over it.
  render: (index: number) => ReactNode;
  // Places the stage, which is positioned (relative by default) for its slides.
  className?: string;
  // The space each slide keeps clear around its picture at 1x.
  pad?: string;
}

// A stage for pictures to look at closely: two fingers zoom about their centre, a double tap zooms in or back out, one
// finger pans a picture zoomed in, swipes between pictures and drags down to close at 1x. Pinch zoom is the stage's alone
// (data-zoom-stage): the page itself does not zoom.
export function Zoomable({ count = 1, index = 0, onIndex, onClose, dim, render, className = "relative", pad = "" }: ZoomableProps) {
  const stage = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const live = useRef<Live>({ count, index, onIndex, onClose, dim });
  const ctl = useRef<ReturnType<typeof control>>(undefined);
  useLayoutEffect(() => {
    live.current = { count, index, onIndex, onClose, dim };
  });
  useLayoutEffect(() => {
    const c = control(stage.current!, track.current!, () => live.current);
    ctl.current = c;
    return c.stop;
  }, []);
  useLayoutEffect(() => ctl.current?.turned(), [index]);
  // The picture shown comes first in the document, so the viewer's first img is the one in view.
  const slides = [index, index - 1, index + 1].filter((i) => i >= 0 && i < count);
  return (
    <div ref={stage} data-zoom-stage data-scale="1" className={`touch-none overflow-hidden select-none ${className}`}>
      <div ref={track} className="absolute inset-0">
        {slides.map((i) => (
          <div
            key={i}
            data-zoom-current={i === index ? "" : undefined}
            aria-hidden={i === index ? undefined : true}
            inert={i !== index}
            className={`absolute inset-0 flex items-center justify-center ${pad}`}
            style={i === index ? undefined : { transform: `translateX(calc(${i - index} * (100% + ${GAP_PX}px)))` }}
          >
            {render(i)}
          </div>
        ))}
      </div>
    </div>
  );
}
