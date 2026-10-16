import { useEffect, useRef } from "react";

const POLL_MS = 2000;

// Reads once, then again while `live` and the page is in front, each read starting once the last one is over; when
// `live` ends it reads once more. `key` starts the reads over. Nothing is read while `on` is false; once it is true
// again the reads start over.
export function usePolling(read: () => Promise<void>, live: boolean, key: string, on = true): void {
  const fn = useRef(read);
  fn.current = read;
  useEffect(() => {
    if (!on) return;
    let stopped = false;
    let busy = false;
    let timer: number | undefined;
    const tick = async () => {
      clearTimeout(timer);
      if (stopped || busy) return;
      busy = true;
      try {
        await fn.current();
      } finally {
        busy = false;
      }
      if (!stopped && live && document.visibilityState === "visible") timer = window.setTimeout(tick, POLL_MS);
    };
    const onVisible = () => {
      if (live && document.visibilityState === "visible") void tick();
    };
    void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [live, key, on]);
}
