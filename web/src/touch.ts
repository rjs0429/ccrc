// Outside a zoom stage iOS's pinch gesture events are cancelled, so the page never zooms; touch-action and the
// viewport's maximum-scale say the same. A stage handles its own pinch.
export function blockPageZoom(): void {
  const block = (e: Event) => {
    const at = e.target instanceof Element ? e.target : e.target instanceof Node ? e.target.parentElement : null;
    if (!at?.closest("[data-zoom-stage]")) e.preventDefault();
  };
  for (const type of ["gesturestart", "gesturechange"]) document.addEventListener(type, block, { passive: false });
}
