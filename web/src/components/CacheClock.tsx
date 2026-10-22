import { useEffect, useState } from "react";
import type { PromptCache } from "../../../broker/src/protocol.ts";
import { t, tc } from "../i18n/index.ts";
import { cacheLabel, cacheNow, type CacheNow } from "./promptCache.ts";

// Draws again as the minutes left change, when the cache runs out, and when the app comes back to the front.
export function useCacheNow(c: PromptCache | undefined): CacheNow | undefined {
  const [, redraw] = useState(0);
  const s = cacheNow(c, Date.now());
  const wait = s?.kind === "warm" ? (s.msLeft % 60_000 || 60_000) + 50 : undefined;
  useEffect(() => {
    if (wait === undefined) return;
    const t = setTimeout(() => redraw((n) => n + 1), wait);
    return () => clearTimeout(t);
  });
  useEffect(() => {
    const back = () => document.visibilityState === "visible" && redraw((n) => n + 1);
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, []);
  return s;
}

function ClockIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

// Beside the Context ring as in VS Code's prompt box: the minutes the cache has left, or that it ran out. One width either
// way, so the chips around it never move.
export function CacheClock({ cache, onClick }: { cache?: PromptCache; onClick: () => void }) {
  const s = useCacheNow(cache);
  if (!s) return null;
  return (
    <button
      onClick={onClick}
      aria-label={cacheLabel(s)}
      data-cache={s.kind === "warm" ? "warm" : s.reason}
      className={`flex h-8 w-12 shrink-0 items-center justify-center gap-0.5 rounded-lg text-[12px] tabular-nums hover:bg-surface-2 ${s.kind === "warm" ? "text-fg" : "text-muted/70"}`}
    >
      <ClockIcon />
      <span>{s.kind === "warm" ? t("{m}분", { m: s.minutes }) : tc("cache chip", "만료")}</span>
    </button>
  );
}
