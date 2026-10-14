import type { ContextDetail, UsageInfo, UsageLimit } from "../protocol.ts";

const NAME_MAX = 200;
const PATH_MAX = 4096;
const WORD_MAX = 40;
const LIST_MAX = 50;
const CONTEXT_KINDS = new Set<unknown>(["used", "free", "buffer", "deferred"]);
// get_usage's windows, as the kinds and scopes /usage reports its limits with.
const WINDOWS: [key: string, kind: string, scope?: string][] = [
  ["five_hour", "session"],
  ["seven_day", "weekly_all"],
  ["seven_day_opus", "weekly_scoped", "Opus"],
  ["seven_day_sonnet", "weekly_scoped", "Sonnet"],
  ["seven_day_oauth_apps", "weekly_scoped", "OAuth apps"],
];

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const clipped = (v: unknown, max: number): string | undefined => (typeof v === "string" && v ? v.slice(0, max) : undefined);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

// Named token counts, largest first.
function counts(v: unknown, name: (o: Obj) => unknown, max: number): { name: string; tokens: number }[] {
  return (Array.isArray(v) ? v.filter(isObj) : [])
    .flatMap((o) => {
      const n = clipped(name(o), max);
      return n ? [{ name: n, tokens: count(o.tokens) }] : [];
    })
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, LIST_MAX);
}

// Claude Code's context count by category, as the web client shows it: the get_context_usage answer
// (camelCase) or the data beside a /context result (snake_case), which has no auto-compact point.
export function contextDetail(r: unknown): ContextDetail {
  const o = isObj(r) ? r : {};
  const model = clipped(o.model, NAME_MAX);
  const autoCompactAt = o.isAutoCompactEnabled === false ? undefined : num(o.autoCompactThreshold);
  const memoryFiles = counts(o.memoryFiles ?? o.memory_files, (f) => f.path, PATH_MAX).map((f) => ({ path: f.name, tokens: f.tokens }));
  const agents = counts(o.agents, (a) => a.agentType ?? a.agent_type, NAME_MAX);
  return {
    percentage: count(o.percentage),
    totalTokens: count(o.totalTokens ?? o.total_tokens),
    maxTokens: count(o.maxTokens ?? o.raw_max_tokens),
    ...(autoCompactAt !== undefined && autoCompactAt > 0 ? { autoCompactAt } : {}),
    ...(model ? { model } : {}),
    categories: (Array.isArray(o.categories) ? o.categories.filter(isObj) : []).map((c) => ({
      name: clipped(c.name, NAME_MAX) ?? "",
      tokens: count(c.tokens),
      kind: CONTEXT_KINDS.has(c.kind) ? (c.kind as string) : c.isDeferred === true ? "deferred" : "used",
    })),
    ...(memoryFiles.length ? { memoryFiles } : {}),
    ...(agents.length ? { agents } : {}),
  };
}

function sessionTotals(v: unknown): UsageInfo["session"] {
  if (!isObj(v)) return undefined;
  return {
    costUsd: count(v.total_cost_usd),
    durationMs: count(v.total_duration_ms),
    apiDurationMs: count(v.total_api_duration_ms),
    linesAdded: count(v.total_lines_added),
    linesRemoved: count(v.total_lines_removed),
  };
}

function limit(kind: unknown, percent: unknown, resetsAt: unknown, more: Partial<UsageLimit> = {}): UsageLimit[] {
  const p = num(percent);
  const k = clipped(kind, WORD_MAX);
  if (p === undefined || !k) return [];
  const at = clipped(resetsAt, WORD_MAX);
  return [{ kind: k, percent: p, ...(at ? { resetsAt: at } : {}), ...more }];
}

// The limits and session totals of a /usage result's data.
export function usageReport(r: unknown): UsageInfo | undefined {
  if (!isObj(r)) return undefined;
  const rows = isObj(r.rate_limits) && Array.isArray(r.rate_limits.limits) ? r.rate_limits.limits.filter(isObj) : [];
  const limits = rows.flatMap((l) => {
    const scope = isObj(l.scope) ? clipped(obj(l.scope.model).display_name ?? obj(l.scope.surface).display_name, NAME_MAX) : undefined;
    const severity = clipped(l.severity, WORD_MAX);
    return limit(l.kind, l.percent, l.resets_at, { ...(scope ? { scope } : {}), ...(severity ? { severity } : {}), ...(l.is_active === true ? { active: true } : {}) });
  });
  const session = sessionTotals(r.session);
  return { limits, ...(session ? { session } : {}) };
}

// The same from a get_usage answer, which has a field per window and no severity.
export function usageAnswer(r: unknown): UsageInfo {
  const o = isObj(r) ? r : {};
  const rl = isObj(o.rate_limits) ? o.rate_limits : {};
  const limits = WINDOWS.flatMap(([key, kind, scope]) => {
    const w = obj(rl[key]);
    return limit(kind, w.utilization, w.resets_at, scope ? { scope } : {});
  });
  for (const m of Array.isArray(rl.model_scoped) ? rl.model_scoped.filter(isObj) : []) {
    const scope = clipped(m.display_name, NAME_MAX);
    limits.push(...limit("weekly_scoped", m.utilization, m.resets_at, scope ? { scope } : {}));
  }
  const session = sessionTotals(o.session);
  return { limits, ...(session ? { session } : {}) };
}
