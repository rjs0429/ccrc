import { useEffect, useState } from "react";
import type { UsageCauses, UsageInfo, UsageLimit, UsageShare, UsageWindowCauses } from "../../../../broker/src/protocol.ts";
import { USAGE_GROUP, USAGE_TRAIT, duration, errorText, usageLimitLabel, usageResetText, type UsageGroup } from "../../labels.ts";
import { Segmented } from "../../screens/settings/common.tsx";
import { call, callFolder, toast } from "../../state.ts";
import { Sheet } from "../ui.tsx";
import { Failed, SmallButton, Waiting } from "./parts.tsx";

// Without a running session the broker starts a short-lived Claude Code process to ask.
const WAIT_MS = 60_000;
// The causes take a read of a week of transcripts, by a process that may have to start first.
const CAUSES_WAIT_MS = 180_000;
// As VS Code: a cause is told with its advice from this share of the usage, and each table lists this many.
const TOLD_PCT = 10;
const TABLE_ROWS = 8;
// VS Code tells the top subagent first, and lists the skills first.
const TOP_GROUPS: UsageGroup[] = ["agents", "skills", "plugins", "mcpServers"];
const GROUPS: UsageGroup[] = ["skills", "agents", "plugins", "mcpServers"];
// The agent type of a workflow's agents, which the workflow trait already tells of.
const WORKFLOW_AGENT = "workflow-subagent";

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

function CauseRow({ name, pct, advice, ...rest }: { name: string; pct: number; advice?: string; "data-cause"?: string }) {
  return (
    <div className="px-1" {...rest}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 text-[14px] break-words">{name}</span>
        <span className="shrink-0 text-[14px] font-semibold tabular-nums">{Math.round(pct)}%</span>
      </div>
      {advice && <div className="mt-0.5 text-xs text-muted">{advice}</div>}
    </div>
  );
}

function ShareTable({ title, items, label }: { title: string; items: UsageShare[]; label?: (name: string) => string }) {
  if (!items.length) return null;
  const shown = items.slice(0, TABLE_ROWS);
  return (
    <div className="px-1" data-usage-table={title}>
      <div className="flex justify-between text-xs text-muted">
        <span className="font-semibold">{title}</span>
        <span>사용량 비율</span>
      </div>
      <div className="mt-1 overflow-hidden rounded-xl border border-line">
        {shown.map((x) => (
          <div key={x.name} className="flex items-center gap-3 border-b border-line px-3 py-1.5 text-[13px] last:border-0">
            <span className="min-w-0 flex-1 truncate">{label ? label(x.name) : x.name}</span>
            <span className="shrink-0 tabular-nums text-muted">{Math.round(x.pct)}%</span>
          </div>
        ))}
      </div>
      {items.length > shown.length && <div className="mt-0.5 text-xs text-muted">… {items.length - shown.length}개 더</div>}
    </div>
  );
}

function WindowCauses({ w }: { w: UsageWindowCauses }) {
  const traits = w.traits.filter((t) => t.pct >= TOLD_PCT);
  const workflow = traits.some((t) => t.key === "workflow");
  const tops = TOP_GROUPS.flatMap((g) => {
    const top = [...w[g]].sort((a, b) => b.pct - a.pct).find((x) => !(workflow && g === "agents" && x.name === WORKFLOW_AGENT));
    return top && top.pct >= TOLD_PCT ? [{ g, top }] : [];
  });
  const attributed = GROUPS.some((g) => w[g].length > 0);
  if (!traits.length && !attributed) return <div className="px-1 text-sm text-muted">이 기간에는 {TOLD_PCT}%를 넘는 원인이 없습니다. 다른 기간을 보세요.</div>;
  return (
    <div className="space-y-3">
      {traits.map((t) => (
        <CauseRow key={t.key} data-cause={t.key} name={USAGE_TRAIT[t.key]?.name ?? t.key} pct={t.pct} advice={USAGE_TRAIT[t.key]?.advice} />
      ))}
      {tops.map(({ g, top }) => (
        <CauseRow key={g} data-cause={g} name={`${USAGE_GROUP[g].title} ${USAGE_GROUP[g].label?.(top.name) ?? top.name}`} pct={top.pct} advice={USAGE_GROUP[g].advice} />
      ))}
      {attributed ? (
        GROUPS.map((g) => <ShareTable key={g} title={USAGE_GROUP[g].title} items={w[g]} label={USAGE_GROUP[g].label} />)
      ) : (
        <div className="px-1 text-xs text-muted">스킬·서브에이전트·플러그인·MCP 서버별 기록은 아직 없습니다. 쓰는 동안 쌓입니다.</div>
      )}
    </div>
  );
}

// What the usage of the last day or week went to: the traits over a tenth of it with what to do about them, then the
// skills, subagents, plugins and MCP servers it came from. Claude Code may name traits this does not know.
export function UsageCausesView({ causes }: { causes: UsageCauses }) {
  const [span, setSpan] = useState<"day" | "week">(causes.day ? "day" : "week");
  const w = causes[span];
  if (causes.none || (!causes.day && !causes.week)) {
    return <div className="px-1 text-sm text-muted">원인을 받지 못했습니다. claude.ai 구독으로 로그인한 계정만 볼 수 있고, 기록을 읽지 못한 때도 비어 있습니다.</div>;
  }
  return (
    <div className="space-y-3" data-usage-span={span}>
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="min-w-0 text-xs text-muted">{w ? `요청 ${w.requests.toLocaleString()}개 · 세션 ${w.sessions.toLocaleString()}개` : ""}</span>
        <Segmented value={span} options={[["day", "24시간"], ["week", "7일"]]} onChange={setSpan} />
      </div>
      {w ? <WindowCauses w={w} /> : <div className="px-1 text-sm text-muted">이 기간의 기록이 없습니다</div>}
      <p className="px-1 text-xs text-muted">이 컴퓨터의 세션 기록으로 어림한 값이라 다른 기기와 claude.ai 사용은 빠집니다. 서로 겹치는 특징이라 더해도 100%가 되지 않습니다.</p>
    </div>
  );
}

// Asks for the causes once `start` is set; a sheet sets it after the limits, which come quickly, are in.
export function UsageCausesSection({ sessionId, cwd, start }: { sessionId?: string; cwd?: string; start: boolean }) {
  const [causes, setCauses] = useState<UsageCauses>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!start) return;
    let live = true;
    setLoading(true);
    setError(undefined);
    (sessionId ? call(sessionId, "usage_causes", {}, CAUSES_WAIT_MS) : callFolder(cwd ?? "", "usage_causes", {}, CAUSES_WAIT_MS))
      .then(
        (c) => live && setCauses(c),
        (e: Error) => live && setError(errorText(e.message)),
      )
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [sessionId, cwd, start, round]);
  if (!start) return null;
  return (
    <section className="mt-5 border-t border-line pt-4" data-usage-causes={causes ? (causes.none ? "none" : "ok") : loading ? "loading" : "failed"}>
      <div className="mb-2 px-1 text-xs font-semibold text-muted">사용량 원인</div>
      {causes && !loading && <UsageCausesView causes={causes} />}
      {loading && <Waiting text="원인을 찾는 중입니다. 이 컴퓨터의 최근 7일 기록을 읽어 1분 넘게 걸릴 수 있습니다" />}
      {error && !loading && <Failed text={error} onRetry={() => setRound((r) => r + 1)} />}
    </section>
  );
}

// Fills from get_usage, which the broker answers for the account even without a running session, or before one
// starts in `cwd`. When nothing answers the first time, `onFail` takes over if given (the command goes as text).
export function UsageSheet({ sessionId, cwd, onClose, onFail }: { sessionId?: string; cwd?: string; onClose: () => void; onFail?: () => void }) {
  const [usage, setUsage] = useState<UsageInfo>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(undefined);
    (sessionId ? call(sessionId, "usage", {}, WAIT_MS) : callFolder(cwd ?? "", "usage", {}, WAIT_MS))
      .then(
        (u) => live && setUsage(u),
        (e: Error) => live && (usage ? toast("사용량을 새로 불러오지 못했습니다") : onFail ? onFail() : setError(errorText(e.message))),
      )
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [sessionId, cwd, round]);

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
      <UsageCausesSection sessionId={sessionId} cwd={cwd} start={Boolean(usage || error)} />
    </Sheet>
  );
}
