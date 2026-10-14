// Mirrors the visual viewport into CSS variables; on iOS the keyboard shrinks only the visual viewport.
export function trackViewport(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const style = document.documentElement.style;
  let last = "";
  const update = () => {
    const height = `${Math.round(vv.height)}px`;
    const top = `${Math.max(0, Math.round(vv.offsetTop))}px`;
    if (height + top === last) return;
    last = height + top;
    style.setProperty("--vv-height", height);
    style.setProperty("--vv-top", top);
  };
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  update();
}
