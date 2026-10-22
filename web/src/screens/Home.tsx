import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionSummary } from "../../../broker/src/protocol.ts";
import type { Mark, SearchResponse, SearchResult, SearchSnippet } from "../../../broker/src/search-protocol.ts";
import { ApiError, api } from "../api.ts";
import { ArchivedBadge, SessionActions, setArchived } from "../components/SessionActions.tsx";
import { Icon, Spinner } from "../components/ui.tsx";
import { UpdateBanner } from "../components/UpdateBanner.tsx";
import { TitleText } from "../components/TitleText.tsx";
import { useLongPress } from "../components/useLongPress.ts";
import { baseName, brokerSessionsBlocked, hostLabel, relTime, sessionTitle, shortPath } from "../labels.ts";
import { loggedOut, navigate, openAt, refreshSessions, useApp } from "../state.ts";
import { groupFolder, placeLabel, shownBranch } from "../worktree.ts";

// "all" leaves archived sessions out; what runs, waits for input or is unread shows archived or not.
type Filter = "all" | "running" | "waiting" | "unread" | "archived";
const PAGE = 80;
const REFRESH_MS = 10_000;
const SEARCH_DELAY_MS = 250;
const PENDING_RETRY_MS = 1500;
const QUERY_MAX = 200;
// A list in portrait; cards in columns once the screen is wide, as in landscape.
const CARDS = "sm:grid sm:grid-cols-2 sm:gap-2 sm:px-3 xl:grid-cols-3";
const CARD = "border-b border-line sm:rounded-xl sm:border sm:bg-surface";

// The last search stays when the user opens a result and comes back.
let lastSearch: { q: string; found?: SearchResponse } = { q: "" };

function Marked({ text, marks }: { text: string; marks: Mark[] }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const [s, e] of marks) {
    if (s < at || e > text.length) continue;
    if (s > at) parts.push(text.slice(at, s));
    parts.push(
      <mark key={s} className="rounded-[3px] bg-accent/20 font-semibold text-fg">
        {text.slice(s, e)}
      </mark>,
    );
    at = e;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

function openSnippet(sessionId: string, sn: SearchSnippet): void {
  openAt(sessionId, sn.itemId, sn.earlier);
}

function Meta({ text, archived, vscode }: { text: string; archived?: boolean; vscode?: boolean }) {
  if (!archived) return <span className="mt-0.5 block truncate text-xs text-muted">{text}</span>;
  return (
    <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
      <ArchivedBadge vscode={vscode} />
      <span className="truncate">{text}</span>
    </span>
  );
}

function SearchRow({ r }: { r: SearchResult }) {
  const meta = [placeLabel(r.cwd), relTime(r.lastModified), r.hits ? `메시지 ${r.hits}건` : ""].filter(Boolean).join(" · ");
  return (
    <div className="mx-auto max-w-3xl border-b border-line">
      <button onClick={() => openAt(r.id, r.snippets.find((sn) => !sn.earlier)?.itemId)} className="block w-full px-4 pt-3 pb-1 text-left active:bg-surface-2">
        <span className="block truncate text-[15px] font-medium">{r.title.trim() ? <Marked text={r.title} marks={r.titleMarks} /> : sessionTitle(r)}</span>
        <Meta text={meta} archived={r.archived} vscode={r.vscodeArchived} />
      </button>
      <div className="pb-2">
        {r.snippets.map((sn) => (
          <button key={sn.itemId} onClick={() => openSnippet(r.id, sn)} className="block w-full px-4 py-1 text-left active:bg-surface-2">
            <span className="line-clamp-2 text-[13px] leading-snug text-muted">
              <span className="mr-1 font-medium text-fg">{sn.role === "user" ? "나" : "Claude"}</span>
              {sn.earlier && <span className="mr-1 text-[11px]">(요약 전)</span>}
              {sn.cutStart && "…"}
              <Marked text={sn.text} marks={sn.marks} />
              {sn.cutEnd && "…"}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// Results stay on screen while a new query is typed; a failed request clears those of another query.
function useSearch(q: string): { found?: SearchResponse; busy: boolean; failed: boolean; retry: () => void } {
  const [found, setFound] = useState<{ q: string; r: SearchResponse } | undefined>(q === lastSearch.q && lastSearch.found ? { q, r: lastSearch.found } : undefined);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    const query = q.trim();
    const n = ++seq.current;
    setFailed(false);
    if (!query) {
      setFound(undefined);
      setBusy(false);
      lastSearch = { q };
      return;
    }
    let timer: number | undefined;
    const run = async (tries: number) => {
      setBusy(true);
      try {
        const r = await api.search(query);
        if (n !== seq.current) return;
        setFound({ q, r });
        lastSearch = { q, found: r };
        if (r.pending && tries > 0) timer = window.setTimeout(() => void run(tries - 1), PENDING_RETRY_MS);
      } catch (e) {
        if (n !== seq.current) return;
        if (e instanceof ApiError && e.status === 401) return loggedOut("expired");
        setFailed(true);
        setFound((f) => (f?.q === q ? f : undefined));
      } finally {
        if (n === seq.current) setBusy(false);
      }
    };
    timer = window.setTimeout(() => void run(20), lastSearch.q === q && lastSearch.found ? 0 : SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [q, attempt]);
  return { found: found?.r, busy, failed, retry: () => setAttempt((a) => a + 1) };
}

function status(s: SessionSummary): { text: string; dot: string } {
  const host = hostLabel(s.host);
  if (s.state === "owned" || s.state === "attached") {
    if (s.pendingCount) return { text: s.state === "attached" ? `입력 필요 · ${host}` : "입력 필요", dot: "bg-warn" };
    if (s.busy) return { text: s.state === "attached" ? `${host}에서 작업 중` : "작업 중", dot: "bg-accent animate-pulse" };
    return { text: s.state === "attached" ? `${host} 연결됨` : "원격 실행 중", dot: "bg-ok" };
  }
  if (s.state === "live") {
    const only = s.inbox ? "" : " · 보기만";
    return s.busy ? { text: `${host}에서 작업 중${only}`, dot: "bg-info animate-pulse" } : { text: `${host}에서 열림${only}`, dot: "bg-info" };
  }
  return { text: s.folderMissing ? "폴더 없음" : "", dot: "border border-line" };
}

// A long press or a right click opens the session's actions; in the archived view the row also offers to restore it.
function SessionRow({ s, view, onActions }: { s: SessionSummary; view: Filter; onActions: (s: SessionSummary) => void }) {
  const press = useLongPress(() => onActions(s));
  const st = status(s);
  const meta = [st.text, placeLabel(s.cwd), shownBranch(s.cwd, s.branch) ?? "", relTime(s.lastModified)].filter(Boolean).join(" · ");
  const restore = view === "archived" && s.archived;
  const row = (
    <button
      {...press}
      onClick={() => navigate({ name: "chat", sessionId: s.id })}
      className={`flex w-full items-start gap-3 px-4 py-3 text-left select-none [-webkit-touch-callout:none] active:bg-surface-2 ${restore ? "min-w-0 flex-1 sm:rounded-xl" : CARD}`}
    >
      <span className={`mt-1.5 size-2.5 shrink-0 rounded-full ${st.dot}`} />
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[15px] ${s.pendingCount || s.unread ? "font-semibold" : "font-medium"}`}>
          <TitleText text={sessionTitle(s)} />
          {s.unread && <span className="sr-only"> · 읽지 않음</span>}
        </span>
        <Meta text={meta} archived={s.archived && view !== "archived"} vscode={s.vscodeArchived} />
      </span>
      {s.unread && <span className="mt-1.5 size-2.5 shrink-0 rounded-full bg-accent" data-unread-dot />}
    </button>
  );
  if (!restore) return row;
  return (
    <div className={`flex items-center ${CARD}`}>
      {row}
      <button onClick={() => setArchived(s.id, false, s.vscodeArchived)} className="mr-2 min-h-11 shrink-0 rounded-lg px-3 text-sm font-medium text-accent active:bg-surface-2">
        보관 해제
      </button>
    </div>
  );
}

interface FolderGroup {
  cwd: string;
  count: number;
  archived: number;
  running: number;
  last: number;
}

function inView(s: SessionSummary, filter: Filter): boolean {
  if (filter === "running") return s.state !== "inactive";
  if (filter === "waiting") return Boolean(s.pendingCount);
  if (filter === "unread") return Boolean(s.unread);
  return filter === "archived" ? Boolean(s.archived) : !s.archived;
}

export function Home() {
  const sessions = useApp((s) => s.sessions);
  const conn = useApp((s) => s.conn);
  const brokerOff = brokerSessionsBlocked(useApp((s) => s.options?.brokerSessions));
  const [tab, setTab] = useState<"sessions" | "folders">("sessions");
  const [filter, setFilter] = useState<Filter>("all");
  const [folder, setFolder] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [q, setQ] = useState(lastSearch.q);
  const [actions, setActions] = useState<string | null>(null);
  const searching = Boolean(q.trim());
  const { found, busy, failed, retry } = useSearch(q);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refreshSessions();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const shown = useMemo(() => (sessions ?? []).filter((s) => (!folder || groupFolder(s.cwd) === folder) && inView(s, filter)), [sessions, folder, filter]);

  // A session in a worktree goes with its repository.
  const folders = useMemo(() => {
    const map = new Map<string, FolderGroup>();
    for (const s of sessions ?? []) {
      const cwd = groupFolder(s.cwd);
      const g = map.get(cwd) ?? { cwd, count: 0, archived: 0, running: 0, last: 0 };
      if (s.archived) g.archived++;
      else g.count++;
      if (s.state !== "inactive") g.running++;
      g.last = Math.max(g.last, s.lastModified);
      map.set(cwd, g);
    }
    return [...map.values()].sort((a, b) => b.last - a.last);
  }, [sessions]);

  const waiting = (sessions ?? []).filter((s) => s.pendingCount).length;
  const unread = (sessions ?? []).filter((s) => s.unread).length;
  const archived = (sessions ?? []).filter((s) => s.archived).length;
  const target = actions ? sessions?.find((s) => s.id === actions) : undefined;

  // The archived view closes with its last session.
  useEffect(() => {
    if (sessions && filter === "archived" && !archived) setFilter("all");
  }, [sessions, filter, archived]);

  return (
    <div className="flex h-dvh flex-col">
      <header className="screen-header pt-safe border-b border-line bg-bg">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2 px-safe-3 pt-2.5 pb-2 short:flex-nowrap short:py-1.5">
          <h1 className="order-1 flex-1 pl-1 text-xl font-semibold short:flex-none short:text-lg">
            ccrc
            <span className={`ml-2 inline-block size-2 rounded-full align-middle ${conn === "ready" ? "bg-ok" : "bg-warn"}`} title={conn} />
          </h1>
          <button
            onClick={() => navigate({ name: "new" })}
            title={brokerOff}
            data-broker-off={brokerOff ? "" : undefined}
            className={`order-2 flex shrink-0 items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium short:order-5 short:ml-auto ${brokerOff ? "bg-surface-2 text-muted" : "bg-accent text-white"}`}
          >
            <Icon.plus className="size-4" />새 세션
          </button>
          <button onClick={() => navigate({ name: "settings" })} aria-label="설정" className="order-3 mr-1 shrink-0 rounded-lg p-2 text-muted short:order-6">
            <Icon.gear />
          </button>
          <div className="order-4 flex basis-full items-center gap-2 rounded-xl border border-line bg-surface px-3 short:order-3 short:max-w-xl short:min-w-0 short:flex-1 short:basis-0">
            <Icon.search className="size-4 shrink-0 text-muted" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value.slice(0, QUERY_MAX))}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setQ("");
              }}
              placeholder="세션 제목·대화 내용 검색"
              aria-label="세션 검색"
              enterKeyHint="search"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent py-2 text-[16px] outline-none short:py-1.5"
            />
            {busy && <Spinner className="size-4 shrink-0 text-muted" />}
            {q && (
              <button onClick={() => setQ("")} aria-label="검색 지우기" className="-mr-1.5 shrink-0 rounded-full p-1.5 text-muted">
                <Icon.x className="size-4" />
              </button>
            )}
          </div>
          <div className={`order-5 flex basis-full gap-1 short:order-2 short:basis-auto ${searching ? "hidden" : ""}`}>
            {(["sessions", "folders"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`relative rounded-lg px-3 py-1.5 text-sm after:absolute after:inset-x-0 after:-inset-y-1.5 ${tab === t ? "bg-surface-2 font-semibold" : "text-muted"}`}
              >
                {t === "sessions" ? "세션" : "폴더"}
              </button>
            ))}
          </div>
        </div>
      </header>
      <UpdateBanner />

      <main className="pb-safe flex-1 overflow-y-auto px-safe-0">
        {!sessions && (
          <div className="flex justify-center py-12 text-muted">
            <Spinner className="size-6" />
          </div>
        )}

        {searching && (
          <>
            {found && found.pending > 0 && <div className="px-4 pt-2.5 text-xs text-muted">대화 기록을 읽는 중… 남은 세션 {found.pending}개</div>}
            {failed && (
              <div className="flex items-center justify-center gap-3 px-4 py-6 text-sm text-muted" data-search-failed>
                검색하지 못했습니다
                <button onClick={retry} className="min-h-11 rounded-lg bg-surface px-4 font-medium text-accent">
                  다시 시도
                </button>
              </div>
            )}
            {found?.results.map((r) => <SearchRow key={r.id} r={r} />)}
            {found && !found.results.length && !found.pending && <div className="px-4 py-10 text-center text-sm text-muted">일치하는 세션이 없습니다</div>}
            {found && found.total > found.results.length && (
              <div className="px-4 py-4 text-center text-xs text-muted">일치한 세션 {found.total}개 중 {found.results.length}개를 보여 줍니다. 검색어를 더 넣어 좁혀 보세요.</div>
            )}
          </>
        )}

        {sessions && !searching && tab === "sessions" && (
          <>
            <div className="flex gap-1.5 overflow-x-auto px-4 py-2.5 short:py-2">
              {(
                [
                  ["all", "전체"],
                  ["running", "실행 중"],
                  ["waiting", waiting ? `입력 필요 ${waiting}` : "입력 필요"],
                  ["unread", unread ? `읽지 않음 ${unread}` : "읽지 않음"],
                  ...(archived ? [["archived", `보관됨 ${archived}`]] : []),
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
            <div className={CARDS}>
              {shown.slice(0, limit).map((s) => (
                <SessionRow key={s.id} s={s} view={filter} onActions={(x) => setActions(x.id)} />
              ))}
            </div>
            {shown.length === 0 && (
              <div className="px-4 py-10 text-center text-sm text-muted">{filter === "archived" ? "보관한 세션이 없습니다" : filter === "unread" ? "읽지 않은 세션이 없습니다" : "세션이 없습니다"}</div>
            )}
            {shown.length > limit && (
              <button onClick={() => setLimit(limit + PAGE)} className="w-full py-4 text-sm text-muted">
                더 보기 ({shown.length - limit})
              </button>
            )}
          </>
        )}

        {sessions && !searching && tab === "folders" && (
          <div className={`py-1 sm:pt-3 ${CARDS}`}>
            {folders.map((g) => (
              <button
                key={g.cwd}
                onClick={() => {
                  setFolder(g.cwd);
                  if (!g.count && filter === "all") setFilter("archived");
                  else if (!g.archived && filter === "archived") setFilter("all");
                  setTab("sessions");
                }}
                className={`flex w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-2 ${CARD}`}
              >
                <Icon.folder className="size-5 shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-medium">{baseName(g.cwd)}</span>
                  <span className="block truncate text-xs text-muted">{shortPath(g.cwd)}</span>
                </span>
                <span className="shrink-0 text-right text-xs text-muted">
                  <span className="block">{g.count > 0 ? `세션 ${g.count}` : `보관 ${g.archived}`}</span>
                  {g.running > 0 && <span className="block text-info">실행 중 {g.running}</span>}
                </span>
              </button>
            ))}
          </div>
        )}
      </main>
      {target && <SessionActions session={target} step="menu" onClose={() => setActions(null)} />}
    </div>
  );
}
