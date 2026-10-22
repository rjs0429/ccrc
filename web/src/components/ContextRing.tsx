import type { ContextGauge } from "../../../broker/src/protocol.ts";
import { t } from "../i18n/index.ts";

const R = 7;
const ROUND = 2 * Math.PI * R;
// Close to auto-compact: this many points of the window or fewer before it starts, or before the window is
// full while auto-compact is off.
const WARN_POINTS = 10;

// Points of the window left before auto-compact starts; undefined when its point is not known.
export function compactLeft(g: ContextGauge): number | undefined {
  return g.autoCompactAt ? Math.max(0, Math.round(((g.autoCompactAt - g.tokens) / g.max) * 100)) : undefined;
}

export function contextWarn(g?: ContextGauge): boolean {
  if (!g) return false;
  const left = compactLeft(g);
  return left !== undefined ? left <= WARN_POINTS : g.percent >= 100 - WARN_POINTS;
}

// A track and an arc that fills by whole percent.
export function Ring({ gauge, className = "size-5" }: { gauge?: ContextGauge; className?: string }) {
  const p = gauge ? Math.min(100, Math.max(0, gauge.percent)) : 0;
  return (
    <svg viewBox="0 0 20 20" className={`${className} -rotate-90`} aria-hidden>
      <circle cx="10" cy="10" r={R} fill="none" strokeWidth={3} className="stroke-line" />
      {p > 0 && (
        <circle
          cx="10"
          cy="10"
          r={R}
          fill="none"
          strokeWidth={3}
          strokeDasharray={`${(ROUND * p) / 100} ${ROUND}`}
          className={contextWarn(gauge) ? "stroke-warn" : "stroke-accent"}
          data-arc
        />
      )}
    </svg>
  );
}

export function ContextRing({ gauge, onClick, className = "" }: { gauge?: ContextGauge; onClick: () => void; className?: string }) {
  const label = gauge ? (gauge.last ? t("Context {percent}% (마지막 기록)", { percent: gauge.percent }) : `Context ${gauge.percent}%`) : t("Context 사용량");
  return (
    <button
      onClick={onClick}
      aria-label={label}
      data-context-ring={gauge ? Math.min(100, Math.max(0, gauge.percent)) : ""}
      data-warn={contextWarn(gauge) ? "" : undefined}
      className={`flex size-8 shrink-0 items-center justify-center rounded-lg hover:bg-surface-2 ${className}`}
    >
      <Ring gauge={gauge} />
    </button>
  );
}
