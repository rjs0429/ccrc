import { useEffect, useState } from "react";
import type { ContextDetail, ContextGauge, LiveState, SessionState } from "../../../../broker/src/protocol.ts";
import { num } from "../../i18n/format.ts";
import { k, kc, t, type Placed } from "../../i18n/index.ts";
import { errorText, modelLabel, shortPath } from "../../labels.ts";
import { call, useApp } from "../../state.ts";
import { compactLeft } from "../ContextRing.tsx";
import { Sheet } from "../ui.tsx";
import { Failed, SmallButton, Waiting } from "./parts.tsx";

// The broker gives Claude Code up to a minute to count every category.
export const DETAIL_WAIT_MS = 75_000;

type Category = ContextDetail["categories"][number];

const CATEGORY_LABEL: Record<string, string | Placed> = {
  "System prompt": k("시스템 프롬프트"),
  "System tools": k("시스템 도구"),
  "System tools (deferred)": k("시스템 도구"),
  "MCP tools": k("MCP 도구"),
  "MCP tools (deferred)": k("MCP 도구"),
  "MCP server instructions": k("MCP 서버 안내"),
  "Custom agents": k("사용자 에이전트"),
  "Memory files": k("메모리 파일"),
  Skills: kc("context category", "스킬"),
  Messages: k("대화"),
  "Compact buffer": k("요약 여유분"),
  "Free space": k("빈 공간"),
};

const categoryLabel = (name: string) => (Object.hasOwn(CATEGORY_LABEL, name) ? t(CATEGORY_LABEL[name]) : name);

const DOT: Record<string, string> = {
  used: "bg-accent",
  buffer: "bg-muted/50",
  free: "border border-muted",
  deferred: "border border-dashed border-muted",
};

export function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${+(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${+(n / 1_000_000).toFixed(1)}M`;
}

function share(n: number, max: number): string {
  const p = (n / max) * 100;
  return `${p >= 10 ? Math.round(p) : +p.toFixed(1)}%`;
}

function Group({ title, hint, rows, max }: { title: string; hint?: string; rows: Category[]; max?: number }) {
  if (!rows.length) return null;
  return (
    <section className="mt-4">
      <div className="px-1 text-xs font-semibold text-muted">{title}</div>
      {hint && <div className="px-1 text-xs text-muted">{hint}</div>}
      <div className="mt-1.5 overflow-hidden rounded-xl border border-line">
        {rows.map((c, i) => (
          <div key={`${c.name}-${i}`} className="flex items-center gap-2.5 border-b border-line px-3 py-2 last:border-0">
            <span className={`size-2.5 shrink-0 rounded-full ${DOT[c.kind] ?? DOT.used}`} />
            <span className="min-w-0 flex-1 truncate text-[14px]">{categoryLabel(c.name)}</span>
            <span className="shrink-0 text-[13px] text-muted tabular-nums">
              {tokens(c.tokens)}
              {max ? ` · ${share(c.tokens, max)}` : ""}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

// The context count: the share in use and its bar, and with `full` the categories in groups.
export function ContextView({ detail, full }: { detail: ContextDetail; full?: boolean }) {
  const models = useApp((s) => s.options?.models);
  const max = detail.maxTokens || 1;
  const byKind = (kind: string) => detail.categories.filter((c) => c.kind === kind);
  const reserved = byKind("buffer").reduce((n, c) => n + c.tokens, 0);
  const model = detail.model ? modelLabel(models ?? [], detail.model) : undefined;
  return (
    <>
      <div className="px-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-2xl font-semibold tabular-nums">{Math.round(detail.percentage)}%</span>
          <span className="text-xs text-muted tabular-nums">
            {t("{used} / {max} 토큰", { used: num(detail.totalTokens), max: num(detail.maxTokens) })}
          </span>
        </div>
        <div className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-surface-2">
          <div className="bg-accent" style={{ width: `${Math.min(100, (detail.totalTokens / max) * 100)}%` }} />
          <div className="bg-muted/50" style={{ width: `${Math.min(100, (reserved / max) * 100)}%` }} />
        </div>
        {model && <div className="mt-2 text-xs text-muted">{t("모델 {model}", { model })}</div>}
      </div>
      {full && <ContextGroups detail={detail} />}
    </>
  );
}

function Named({ name, title, rows }: { name: string; title: string; rows?: { name: string; tokens: number }[] }) {
  if (!rows?.length) return null;
  return (
    <section className="mt-4" data-context-list={name}>
      <div className="px-1 text-xs font-semibold text-muted">{title}</div>
      <div className="mt-1.5 overflow-hidden rounded-xl border border-line">
        {rows.map((r, i) => (
          <div key={`${r.name}-${i}`} className="flex items-baseline gap-2.5 border-b border-line px-3 py-2 last:border-0">
            <span className="min-w-0 flex-1 text-[14px] break-all">{r.name}</span>
            <span className="shrink-0 text-[13px] text-muted tabular-nums">{tokens(r.tokens)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

// The categories of a context count in groups (in use, room left, loaded only when needed), then the memory
// files and agents in it.
export function ContextGroups({ detail }: { detail: ContextDetail }) {
  const max = detail.maxTokens || 1;
  const byKind = (kind: string) => detail.categories.filter((c) => c.kind === kind);
  return (
    <>
      <Group title={t("사용 중")} rows={byKind("used")} max={max} />
      <Group title={t("남은 공간")} hint={t("Autocompact buffer는 Auto-compact가 대화를 요약할 때 쓰려고 남겨 둔 자리입니다")} rows={[...byKind("buffer"), ...byKind("free")]} max={max} />
      <Group title={t("필요할 때만 불러옴")} hint={t("쓸 때만 Context에 올라오는 도구라 지금은 자리를 차지하지 않습니다")} rows={byKind("deferred")} />
      <Named name="memory" title={t("메모리 파일")} rows={detail.memoryFiles?.map((f) => ({ name: shortPath(f.path), tokens: f.tokens }))} />
      <Named name="agents" title={t("사용자 에이전트")} rows={detail.agents} />
    </>
  );
}

// How far auto-compact is, in words; undefined when the gauge cannot say.
export function compactLeftText(g?: ContextGauge): string | undefined {
  const left = g ? compactLeft(g) : undefined;
  return left !== undefined ? t("Auto-compact까지 {n}% 남음", { n: left }) : g && !g.last ? t("Auto-compact 꺼짐") : undefined;
}

interface SheetArgs {
  sessionId: string;
  state?: LiveState;
  kind: SessionState;
  starting: boolean;
  // Why the session cannot start here, when it cannot.
  cannotStart?: string;
  onClose: () => void;
  onStart: () => void;
}

// What /context opens: the whole count, categories, memory files and agents. A session without a process
// shows the share last recorded until it is started from here.
export function ContextSheet({ sessionId, state, kind, starting, cannotStart, onClose, onStart }: SheetArgs) {
  const controllable = kind === "owned" || kind === "attached";
  const [detail, setDetail] = useState<ContextDetail>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (!controllable) return;
    let live = true;
    setLoading(true);
    setError(undefined);
    call(sessionId, "context", {}, DETAIL_WAIT_MS)
      .then(
        (d) => live && setDetail(d),
        (e: Error) => live && setError(errorText(e.message)),
      )
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [sessionId, controllable, round]);

  const g: ContextGauge | undefined = detail
    ? { percent: Math.round(detail.percentage), tokens: detail.totalTokens, max: detail.maxTokens, ...(detail.autoCompactAt ? { autoCompactAt: detail.autoCompactAt } : {}) }
    : state?.context;
  const shown: ContextDetail | undefined = detail ?? (g && { percentage: g.percent, totalTokens: g.tokens, maxTokens: g.max, categories: [] });
  const leftText = compactLeftText(g);

  return (
    <Sheet title="Context" onClose={onClose}>
      <div data-context-sheet>
        {shown ? <ContextView detail={shown} /> : !loading && <div className="px-1 text-sm text-muted">{t("아직 Context 사용량을 알 수 없습니다")}</div>}
        {leftText && (
          <div className="mt-2 px-1 text-sm" data-compact-left>
            {leftText}
          </div>
        )}
        {!detail && g?.last && <div className="mt-1 px-1 text-xs text-muted">{t("마지막 기록 기준입니다")}</div>}
        {detail && (
          <div data-context-groups>
            <ContextGroups detail={detail} />
          </div>
        )}
        {loading && <Waiting text={t("분류별로 세는 중입니다. 1분까지 걸릴 수 있습니다")} />}
        {error && !loading && <Failed text={error} onRetry={() => setRound((r) => r + 1)} />}
        {detail && !loading && (
          <div className="mt-4 flex justify-end">
            <SmallButton onClick={() => setRound((r) => r + 1)}>{t("다시 계산")}</SmallButton>
          </div>
        )}
        {kind === "inactive" && (
          <div className="mt-3 px-1">
            {cannotStart ? (
              <div className="text-xs text-muted">{cannotStart}</div>
            ) : (
              <SmallButton tall disabled={starting} onClick={onStart}>
                {starting ? t("시작하는 중…") : t("세션을 시작하고 자세히 보기")}
              </SmallButton>
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}
