import { useEffect, useMemo, useState } from "react";
import type { SessionSummary } from "../../../broker/src/protocol.ts";
import { Icon, Spinner } from "../components/ui.tsx";
import { baseName, hostLabel, relTime, sessionTitle, shortPath } from "../labels.ts";
import { navigate, refreshSessions, useApp } from "../state.ts";

type Filter = "all" | "running" | "waiting";
const PAGE = 80;
const REFRESH_MS = 10_000;

function status(s: SessionSummary): { text: string; dot: string } {
  const host = hostLabel(s.host);
  if (s.state === "owned" || s.state === "attached") {
    if (s.pendingCount) return { text: s.state === "attached" ? `입력 필요 · ${host}` : "입력 필요", dot: "bg-warn" };
    if (s.busy) return { text: s.state === "attached" ? `${host}에서 작업 중` : "작업 중", dot: "bg-accent animate-pulse" };
    return { text: s.state === "attached" ? `${host} 연결됨` : "원격 실행 중", dot: "bg-ok" };
  }
  if (s.state === "live") {
    return s.busy ? { text: `${host}에서 작업 중 · 보기만`, dot: "bg-info animate-pulse" } : { text: `${host}에서 열림 · 보기만`, dot: "bg-info" };
  }
  return { text: "", dot: "border border-line" };
}

function SessionRow({ s }: { s: SessionSummary }) {
  const st = status(s);
  const meta = [st.text, baseName(s.cwd), s.branch && s.branch !== "HEAD" ? s.branch : "", relTime(s.lastModified)].filter(Boolean).join(" · ");
  return (
    <button onClick={() => navigate({ name: "chat", sessionId: s.id })} className="flex w-full items-start gap-3 border-b border-line px-4 py-3 text-left active:bg-surface-2">
      <span className={`mt-1.5 size-2.5 shrink-0 rounded-full ${st.dot}`} />
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[15px] ${s.pendingCount ? "font-semibold" : "font-medium"}`}>{sessionTitle(s)}</span>
        <span className="mt-0.5 block truncate text-xs text-muted">{meta}</span>
      </span>
    </button>
  );
}

interface FolderGroup {
  cwd: string;
  count: number;
  running: number;
  last: number;
}

export function Home() {
  const sessions = useApp((s) => s.sessions);
  const conn = useApp((s) => s.conn);
  const [tab, setTab] = useState<"sessions" | "folders">("sessions");
  const [filter, setFilter] = useState<Filter>("all");
  const [folder, setFolder] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refreshSessions();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const shown = useMemo(
    () =>
      (sessions ?? []).filter(
        (s) =>
          (!folder || s.cwd === folder) &&
          (filter === "all" || (filter === "running" ? s.state !== "inactive" : Boolean(s.pendingCount))),
      ),
    [sessions, folder, filter],
  );

  const folders = useMemo(() => {
    const map = new Map<string, FolderGroup>();
    for (const s of sessions ?? []) {
      const g = map.get(s.cwd) ?? { cwd: s.cwd, count: 0, running: 0, last: 0 };
      g.count++;
      if (s.state !== "inactive") g.running++;
      g.last = Math.max(g.last, s.lastModified);
      map.set(s.cwd, g);
    }
    return [...map.values()].sort((a, b) => b.last - a.last);
  }, [sessions]);

  const waiting = (sessions ?? []).filter((s) => s.pendingCount).length;

  return (
    <div className="flex h-dvh flex-col">
      <header className="pt-safe border-b border-line bg-bg">
        <div className="flex items-center gap-2 px-4 pt-2.5 pb-2">
          <h1 className="flex-1 text-xl font-semibold">
            ccrc
            <span className={`ml-2 inline-block size-2 rounded-full align-middle ${conn === "ready" ? "bg-ok" : "bg-warn"}`} title={conn} />
          </h1>
          <button onClick={() => navigate({ name: "new" })} className="flex items-center gap-1 rounded-xl bg-accent px-3 py-2 text-sm font-medium text-white">
            <Icon.plus className="size-4" />새 세션
          </button>
          <button onClick={() => navigate({ name: "settings" })} aria-label="설정" className="rounded-lg p-2 text-muted">
            <Icon.gear />
          </button>
        </div>
        <div className="flex gap-1 px-3 pb-2">
          {(["sessions", "folders"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`rounded-lg px-3 py-1.5 text-sm ${tab === t ? "bg-surface-2 font-semibold" : "text-muted"}`}>
              {t === "sessions" ? "세션" : "폴더"}
            </button>
          ))}
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        {!sessions && (
          <div className="flex justify-center py-12 text-muted">
            <Spinner className="size-6" />
          </div>
        )}

        {sessions && tab === "sessions" && (
          <>
            <div className="flex gap-1.5 overflow-x-auto px-4 py-2.5">
              {(
                [
                  ["all", "전체"],
                  ["running", "실행 중"],
                  ["waiting", waiting ? `입력 필요 ${waiting}` : "입력 필요"],
                ] as [Filter, string][]
              ).map(([f, label]) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`shrink-0 rounded-full border px-3 py-1 text-[13px] ${filter === f ? "border-accent bg-accent-soft" : "border-line text-muted"}`}
                >
                  {label}
                </button>
              ))}
              {folder && (
                <button onClick={() => setFolder(null)} className="flex shrink-0 items-center gap-1 rounded-full border border-accent bg-accent-soft px-3 py-1 text-[13px]">
                  {baseName(folder)}
                  <Icon.x className="size-3.5" />
                </button>
              )}
            </div>
            {shown.slice(0, limit).map((s) => (
              <SessionRow key={s.id} s={s} />
            ))}
            {shown.length === 0 && <div className="px-4 py-10 text-center text-sm text-muted">세션이 없습니다</div>}
            {shown.length > limit && (
              <button onClick={() => setLimit(limit + PAGE)} className="w-full py-4 text-sm text-muted">
                더 보기 ({shown.length - limit})
              </button>
            )}
          </>
        )}

        {sessions && tab === "folders" && (
          <div className="py-1">
            {folders.map((g) => (
              <button
                key={g.cwd}
                onClick={() => {
                  setFolder(g.cwd);
                  setTab("sessions");
                }}
                className="flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left active:bg-surface-2"
              >
                <Icon.folder className="size-5 shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-medium">{baseName(g.cwd)}</span>
                  <span className="block truncate text-xs text-muted">{shortPath(g.cwd)}</span>
                </span>
                <span className="shrink-0 text-right text-xs text-muted">
                  <span className="block">세션 {g.count}</span>
                  {g.running > 0 && <span className="block text-info">실행 중 {g.running}</span>}
                </span>
              </button>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
