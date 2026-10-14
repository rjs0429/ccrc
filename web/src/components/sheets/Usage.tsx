import { useEffect, useState } from "react";
import type { UsageInfo, UsageLimit } from "../../../../broker/src/protocol.ts";
import { errorText, usageLimitLabel, usageResetText } from "../../labels.ts";
import { call, toast } from "../../state.ts";
import { Sheet } from "../ui.tsx";
import { Failed, SmallButton, Waiting } from "./parts.tsx";
import type { SheetProps } from "./types.ts";

// Without a running session the broker starts a short-lived Claude Code process to ask.
const WAIT_MS = 60_000;

const SEVERITY_BAR: Record<string, string> = {
  normal: "bg-ok",
  warning: "bg-warn",
  critical: "bg-danger",
};

// Claude Code grades the rows of a /usage result; a get_usage answer comes without grades.
function barColour(l: UsageLimit): string {
  if (l.severity) return SEVERITY_BAR[l.severity] ?? SEVERITY_BAR.normal;
  return l.percent >= 90 ? SEVERITY_BAR.critical : l.percent >= 75 ? SEVERITY_BAR.warning : SEVERITY_BAR.normal;
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}분 ${s % 60}초` : `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

function SessionLine({ session }: { session: NonNullable<UsageInfo["session"]> }) {
  const parts = [
    session.costUsd > 0 ? `$${session.costUsd.toFixed(2)}` : "",
    session.durationMs > 0 ? duration(session.durationMs) : "",
    session.linesAdded || session.linesRemoved ? `+${session.linesAdded} −${session.linesRemoved}줄` : "",
  ].filter(Boolean);
  if (!parts.length) return null;
  return <div className="px-1 text-xs text-muted">이 세션 · {parts.join(" · ")}</div>;
}

// One bar per plan limit, in the order Claude Code gives them.
export function UsageView({ usage }: { usage: UsageInfo }) {
  return (
    <div className="space-y-3">
      {!usage.limits.length && <div className="px-1 text-sm text-muted">요금제 사용 한도 정보가 없습니다</div>}
      {usage.limits.map((l, i) => (
        <div key={`${l.kind}-${l.scope ?? ""}-${i}`} className="px-1" data-usage-limit={l.kind}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-[14px]">
              {usageLimitLabel(l.kind, l.scope)}
              {l.active && <span className="ml-1.5 rounded bg-accent-soft px-1 text-[11px] font-medium text-accent">현재 기준</span>}
            </span>
            <span className="shrink-0 text-[14px] font-semibold tabular-nums">{Math.round(l.percent)}%</span>
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-surface-2">
            <div className={`h-full ${barColour(l)}`} style={{ width: `${Math.min(100, Math.max(0, l.percent))}%` }} />
          </div>
          {l.resetsAt && <div className="mt-1 text-xs text-muted">{usageResetText(l.resetsAt)}</div>}
        </div>
      ))}
      {usage.session && <SessionLine session={usage.session} />}
    </div>
  );
}

// Fills from get_usage, which the broker answers for the account even without a running session. When
// nothing answers the first time, `onFail` takes over if given (the command goes as text).
export function UsageSheet({ sessionId, onClose, onFail }: SheetProps & { onFail?: () => void }) {
  const [usage, setUsage] = useState<UsageInfo>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(undefined);
    call(sessionId, "usage", {}, WAIT_MS)
      .then(
        (u) => live && setUsage(u),
        (e: Error) => live && (usage ? toast("사용량을 새로 불러오지 못했습니다") : onFail ? onFail() : setError(errorText(e.message))),
      )
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [sessionId, round]);

  return (
    <Sheet title="사용량" onClose={onClose}>
      {usage && <UsageView usage={usage} />}
      {loading && <Waiting text="사용량을 불러오는 중입니다" />}
      {error && !loading && <Failed text={error} onRetry={() => setRound((r) => r + 1)} />}
      {usage && !loading && (
        <div className="mt-4 flex justify-end">
          <SmallButton onClick={() => setRound((r) => r + 1)}>새로 고침</SmallButton>
        </div>
      )}
    </Sheet>
  );
}
