import { type RefObject, useLayoutEffect, useRef, useState } from "react";

// How long text still being written (a reply or a thought) stays as drawn after a finger or the mouse comes off it: the
// selection a long press makes can come after the page has lost the touch.
const LIFT_MS = 400;
// How soon the item it becomes must come to take over its selection.
const HANDOVER_MS = 5000;

let handover: { text: string; start: number; end: number; picked: string; at: number } | undefined;

// The selected range, when it lies in el or reaches into it.
export function selectedIn(el: Element | null): Range | undefined {
  const s = document.getSelection();
  if (!el || !s || s.isCollapsed || !s.rangeCount) return;
  const r = s.getRangeAt(0);
  return r.intersectsNode(el) ? r : undefined;
}

function charsBefore(el: Element, node: Node, offset: number): number {
  const r = document.createRange();
  r.setStart(el, 0);
  r.setEnd(node, offset);
  return r.toString().length;
}

function rangeOf(el: Element, start: number, end: number): Range | undefined {
  const r = document.createRange();
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let at = 0;
  let started = false;
  for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
    if (!started && start <= at + n.length) {
      r.setStart(n, start - at);
      started = true;
    }
    if (started && end <= at + n.length) {
      r.setEnd(n, end - at);
      return r;
    }
    at += n.length;
  }
}

// Text still being written (a reply or a thought) stays as drawn while a finger or the mouse is on it and while text in
// it is selected, since drawing more of it rewrites the text the selection is in and drops it; it catches up after.
// When it ends with text in it selected, the item it becomes selects the same text (takeOver).
export function useHeld(text: string): [RefObject<HTMLDivElement | null>, string] {
  const ref = useRef<HTMLDivElement>(null);
  const [held, setHeld] = useState<string>();
  const drawn = useRef(text);
  drawn.current = held ?? text;
  useLayoutEffect(() => {
    const el = ref.current;
    let pressed = false;
    let lift: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const now = drawn.current;
      setHeld(pressed || selectedIn(el) ? (h) => h ?? now : undefined);
    };
    const down = (e: PointerEvent) => {
      if (!(e.target instanceof Node && el?.contains(e.target))) return;
      clearTimeout(lift);
      pressed = true;
      update();
    };
    const up = () => {
      if (!pressed) return;
      clearTimeout(lift);
      lift = setTimeout(() => {
        pressed = false;
        update();
      }, LIFT_MS);
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
    document.addEventListener("selectionchange", update);
    return () => {
      clearTimeout(lift);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", up, true);
      document.removeEventListener("selectionchange", update);
      const r = selectedIn(el);
      const picked = r?.toString();
      handover =
        el && r && picked && el.contains(r.startContainer) && el.contains(r.endContainer)
          ? { text: drawn.current, start: charsBefore(el, r.startContainer, r.startOffset), end: charsBefore(el, r.endContainer, r.endOffset), picked, at: Date.now() }
          : undefined;
    };
  }, []);
  return [ref, held ?? text];
}

// Selects in el, just drawn from text, what was selected in the text still being written that it replaces.
export function takeOver(el: HTMLElement | null, text: string): void {
  const h = handover;
  if (!h || !el || !text.startsWith(h.text)) return;
  handover = undefined;
  const s = document.getSelection();
  if (!s?.isCollapsed || Date.now() - h.at > HANDOVER_MS) return;
  const r = rangeOf(el, h.start, h.end);
  if (!r || r.toString() !== h.picked) return;
  s.removeAllRanges();
  s.addRange(r);
}
