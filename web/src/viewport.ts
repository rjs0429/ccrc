// Mirrors the visual viewport into CSS variables; on iOS the keyboard shrinks only the visual viewport.
const KEYBOARD_MIN_PX = 120;
// The tiny variant's 15rem, for a visible area the keyboard leaves that short.
const TINY_PX = 240;

export function trackViewport(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  let last = "";
  const update = () => {
    const height = `${Math.round(vv.height)}px`;
    const top = `${Math.max(0, Math.round(vv.offsetTop))}px`;
    const keyboard = root.clientHeight - vv.height * vv.scale > KEYBOARD_MIN_PX;
    const tiny = keyboard && vv.height * vv.scale < TINY_PX;
    const key = `${height} ${top} ${keyboard} ${tiny}`;
    if (key === last) return;
    last = key;
    root.style.setProperty("--vv-height", height);
    root.style.setProperty("--vv-top", top);
    root.toggleAttribute("data-keyboard", keyboard);
    root.toggleAttribute("data-tiny", tiny);
  };
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  update();
}
