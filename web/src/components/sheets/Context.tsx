import type { ContextDetail } from "../../../../broker/src/protocol.ts";
import { modelLabel } from "../../labels.ts";
import { useApp } from "../../state.ts";

type Category = ContextDetail["categories"][number];

const CATEGORY_LABEL: Record<string, string> = {
  "System prompt": "시스템 프롬프트",
  "System tools": "시스템 도구",
  "System tools (deferred)": "시스템 도구",
  "MCP tools": "MCP 도구",
  "MCP tools (deferred)": "MCP 도구",
  "MCP server instructions": "MCP 서버 안내",
  "Custom agents": "사용자 에이전트",
  "Memory files": "메모리 파일",
  Skills: "스킬",
  Messages: "대화",
  "Autocompact buffer": "Autocompact buffer",
  "Compact buffer": "요약 여유분",
  "Free space": "빈 공간",
};

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
            <span className="min-w-0 flex-1 truncate text-[14px]">{CATEGORY_LABEL[c.name] ?? c.name}</span>
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
            {detail.totalTokens.toLocaleString()} / {detail.maxTokens.toLocaleString()} 토큰
          </span>
        </div>
        <div className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-surface-2">
          <div className="bg-accent" style={{ width: `${Math.min(100, (detail.totalTokens / max) * 100)}%` }} />
          <div className="bg-muted/50" style={{ width: `${Math.min(100, (reserved / max) * 100)}%` }} />
        </div>
        {model && <div className="mt-2 text-xs text-muted">모델 {model}</div>}
      </div>
      {full && <ContextGroups detail={detail} />}
    </>
  );
}

// The categories of a context count in groups: in use, room left, loaded only when needed.
export function ContextGroups({ detail }: { detail: ContextDetail }) {
  const max = detail.maxTokens || 1;
  const byKind = (kind: string) => detail.categories.filter((c) => c.kind === kind);
  return (
    <>
      <Group title="사용 중" rows={byKind("used")} max={max} />
      <Group title="남은 공간" hint="Autocompact buffer는 Auto-compact가 대화를 요약할 때 쓰려고 남겨 둔 자리입니다" rows={[...byKind("buffer"), ...byKind("free")]} max={max} />
      <Group title="필요할 때만 불러옴" hint="쓸 때만 Context에 올라오는 도구라 지금은 자리를 차지하지 않습니다" rows={byKind("deferred")} />
    </>
  );
}
