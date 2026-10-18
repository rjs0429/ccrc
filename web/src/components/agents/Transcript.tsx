import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentTranscript, DisplayItem } from "../../../../broker/src/protocol.ts";
import { errorText } from "../../labels.ts";
import { call, following, toast } from "../../state.ts";
import { ItemView, shownItems } from "../Items.tsx";
import { FileLinks, FileRoots, SentAgent } from "../fileLinks.ts";
import { Failed, Waiting } from "../sheets/parts.tsx";
import { Icon, Spinner } from "../ui.tsx";
import { AgentLinks, type TranscriptRef } from "./links.ts";
import { usePolling, type Follow } from "./poll.ts";
import { afterOf, followed, held, prepended, type Held } from "./transcript.ts";

const PAGE = 150;
const PROMPT_LINES = 12;
const PROMPT_CHARS = 1200;
const NEAR_BOTTOM_PX = 80;
const LOST = /^(not connected|no answer)$/;

// The box that scrolls the transcript: the sheet on a narrow screen, the right column on a wide one.
function scrollerOf(el: HTMLElement | null): HTMLElement | null {
  for (let e = el?.parentElement; e; e = e.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(e).overflowY)) return e;
  }
  return null;
}

// What the main agent told the subagent to do; a long one opens on a tap.
function Prompt({ text }: { text: string }) {
  const long = text.length > PROMPT_CHARS || text.split("\n").length > PROMPT_LINES;
  const [open, setOpen] = useState(!long);
  return (
    <div className="rounded-xl bg-surface-2 px-3 py-2.5" data-prompt>
      <div className="text-xs font-semibold text-muted">지시</div>
      <div className={`mt-1 text-[14px] leading-relaxed whitespace-pre-wrap ${open ? "" : "line-clamp-12"}`}>{text}</div>
      {long && (
        <button onClick={() => setOpen(!open)} className="mt-1 min-h-8 text-sm font-medium text-accent">
          {open ? "접기" : "더 보기"}
        </button>
      )}
    </div>
  );
}

function Entry({ item, promptId, running }: { item: DisplayItem; promptId?: string; running: boolean }) {
  if (item.kind !== "user") return <ItemView item={item} running={running} />;
  if (item.id === promptId) return <Prompt text={item.text} />;
  return (
    <div className="rounded-xl border border-line px-3 py-2.5" data-agent-message>
      <div className="text-xs font-semibold text-muted">메인 에이전트의 메시지</div>
      <div className="mt-1 text-[14px] leading-relaxed whitespace-pre-wrap">{item.text}</div>
    </div>
  );
}

// active: shown, on top of the transcripts opened; one under a nested transcript stays as it was, hidden and not read.
// startAt: where its scroller stood when the user left it for a nested transcript.
interface Props {
  sessionId: string;
  target: TranscriptRef;
  active: boolean;
  startAt?: number;
  running: boolean;
  roots: readonly string[];
  onFile: (href: string) => void;
  onBack: () => void;
  onOpen: (ref: TranscriptRef) => void;
}

// A subagent's own conversation, read from its transcript: the latest page first, earlier pages on request, and while
// it runs what it adds, following the end unless the user has scrolled up.
export function Transcript({ sessionId, target, active, startAt, running, roots, onFile, onBack, onOpen }: Props) {
  const [h, setH] = useState<Held>();
  const [error, setError] = useState<string>();
  const [earlier, setEarlier] = useState(false);
  const [unseen, setUnseen] = useState(false);
  const [away, setAway] = useState(false);
  const current = useRef<Held | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const seen = useRef(-1);
  const onTop = useRef(active);
  const wasActive = useRef(active);
  onTop.current = active;
  // Where the view stood from the bottom before an earlier page went in front.
  const anchor = useRef<number | undefined>(undefined);

  const apply = (fn: (cur: Held | undefined) => Held | undefined) => {
    current.current = fn(current.current);
    setH(current.current);
  };
  const ref = () => {
    const agentId = current.current?.agentId || target.agentId;
    return agentId ? { agentId } : { toolUseId: target.toolUseId };
  };

  const read = async (): Promise<boolean> => {
    const cur = current.current;
    try {
      const r = await call(sessionId, "agent_transcript", { ...ref(), ...(cur ? { after: afterOf(cur) } : {}) });
      apply((c) => (c ? followed(c, r) : held(r)));
      setError(undefined);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  };
  // The broker sends what changed since where its last word left the transcript; when that is not where it stands here,
  // the broker is told where it does and sends from there.
  const resync = async (id: string): Promise<boolean> => {
    const cur = current.current;
    const after = cur ? afterOf(cur) : { count: 0, lastId: "" };
    const r = await call(sessionId, "follow", { id, kind: "transcript", ...ref(), after });
    if (r.transcript) take(id, after, r.transcript);
    return r.live;
  };
  const take = (id: string, base: { count: number; lastId: string }, r: AgentTranscript) => {
    const cur = current.current;
    if ((cur ? cur.from + cur.items.length : 0) === base.count && (cur?.items.at(-1)?.id ?? "") === base.lastId) {
      apply((c) => (c ? followed(c, r) : held(r)));
      setError(undefined);
    } else if (following(id)) void resync(id).catch(() => {});
  };
  const watch: Follow = {
    start: resync,
    change: (m) => {
      if (m.transcript && m.base) take(m.id, m.base, m.transcript);
    },
  };
  const key = `${sessionId}|${target.agentId ?? ""}|${target.toolUseId ?? ""}`;
  usePolling(read, running, key, active, watch);

  const loadEarlier = async () => {
    const cur = current.current;
    if (!cur || cur.from === 0 || earlier) return;
    setEarlier(true);
    try {
      const r = await call(sessionId, "agent_transcript", { ...ref(), before: cur.from });
      const s = scrollerOf(rootRef.current);
      if (s) anchor.current = s.scrollHeight - s.scrollTop;
      apply((c) => (c ? prepended(c, r) : c));
    } catch (e) {
      toast(errorText(e instanceof Error ? e.message : String(e)));
    } finally {
      setEarlier(false);
    }
  };

  const gapBelow = (s: HTMLElement) => s.scrollHeight - s.scrollTop - s.clientHeight;
  const atEnd = (s: HTMLElement) => gapBelow(s) < NEAR_BOTTOM_PX;
  // A smooth scroll to the end from the jump button counts as at the end until it lands or the user touches the list.
  const glide = useRef(false);
  useEffect(() => {
    const onScroll = (e: Event) => {
      const s = scrollerOf(rootRef.current);
      if (!onTop.current || !s || e.target !== s) return;
      if (gapBelow(s) < 2) glide.current = false;
      if (glide.current) return;
      follow.current = atEnd(s);
      setAway(!follow.current);
      if (follow.current) setUnseen(false);
    };
    document.addEventListener("scroll", onScroll, true);
    return () => document.removeEventListener("scroll", onScroll, true);
  }, []);
  const endGlide = () => {
    const s = scrollerOf(rootRef.current);
    if (!glide.current || !s) return;
    glide.current = false;
    s.scrollTo({ top: s.scrollTop });
  };

  const count = h ? h.from + h.items.length : 0;
  // Back from a nested transcript the view stands where the user left it; with an earlier page in front, where it was;
  // while following, at the end.
  useLayoutEffect(() => {
    const back = active && !wasActive.current;
    wasActive.current = active;
    const s = scrollerOf(rootRef.current);
    if (!active || !s || !h) return;
    if (back && startAt !== undefined) s.scrollTop = startAt;
    else if (anchor.current !== undefined) s.scrollTop = s.scrollHeight - anchor.current;
    else if (follow.current) s.scrollTop = s.scrollHeight;
    else if (count > seen.current) setUnseen(true);
    anchor.current = undefined;
    follow.current = atEnd(s);
    setAway(!follow.current);
    seen.current = count;
  }, [h, count, active]);

  const toEnd = () => {
    const s = scrollerOf(rootRef.current);
    follow.current = true;
    glide.current = !matchMedia("(prefers-reduced-motion: reduce)").matches;
    setUnseen(false);
    setAway(false);
    s?.scrollTo({ top: s.scrollHeight, behavior: glide.current ? "smooth" : "auto" });
  };

  const items = useMemo(() => shownItems(h?.items ?? []), [h?.items]);
  const meta = [h?.agentType, h && !h.missing ? `기록 ${h.total}개` : ""].filter(Boolean).join(" · ");
  const lost = error !== undefined && LOST.test(error);

  return (
    <div ref={rootRef} hidden={!active} onPointerDown={endGlide} onWheel={endGlide} data-transcript={h?.agentId || target.agentId || target.toolUseId}>
      <div className="sticky -top-4 z-10 -mx-4 -mt-4 mb-3 border-b border-line bg-surface px-4 pt-2 pb-2 sm:top-0 sm:mx-0 sm:mt-0 sm:px-0 sm:pt-0" data-transcript-head>
        <div className="flex items-start gap-1">
          <button onClick={onBack} aria-label="뒤로" className="-ml-2 flex size-11 shrink-0 items-center justify-center rounded-lg text-accent" data-transcript-back>
            <Icon.back className="size-5" />
          </button>
          <div className="min-w-0 flex-1 pt-2">
            <div className="line-clamp-2 text-[16px] font-semibold break-words">{target.title || h?.description || "서브에이전트"}</div>
            {meta && <div className="mt-0.5 text-xs text-muted">{meta}</div>}
          </div>
          {running && (
            <span className="mt-3 flex shrink-0 items-center gap-1.5 text-xs font-medium text-accent" data-transcript-running>
              <span className="size-2 animate-pulse rounded-full bg-accent" />
              실행 중
            </span>
          )}
        </div>
      </div>
      <FileLinks.Provider value={onFile}>
        <FileRoots.Provider value={roots}>
          <AgentLinks.Provider value={onOpen}>
            {!h && !error && <Waiting text="기록을 불러오는 중…" />}
            {!h && error && <Failed text={lost ? "연결이 끊겨 기록을 받지 못했습니다" : errorText(error)} onRetry={/too large/.test(error) ? undefined : () => void read()} />}
            {h && (h.missing || !h.total) && (
              <div className="px-1 py-3 text-sm text-muted" data-transcript-empty>
                {running || !h.missing ? "아직 기록이 없습니다" : "에이전트 기록을 찾을 수 없습니다"}
              </div>
            )}
            {h && h.from > 0 && (
              <button onClick={() => void loadEarlier()} disabled={earlier} className="mb-3 flex min-h-11 w-full items-center justify-center rounded-xl bg-surface-2 text-sm font-medium text-accent disabled:opacity-50" data-transcript-earlier>
                {earlier ? "불러오는 중…" : `이전 기록 ${Math.min(PAGE, h.from)}개 더 보기`}
              </button>
            )}
            {h && (
              <SentAgent.Provider value={h.agentId || target.agentId}>
                <div className="space-y-4" data-transcript-items>
                  {items.map((item) => (
                    <div key={item.id} data-item={item.id}>
                      <Entry item={item} promptId={h.promptId} running={running} />
                    </div>
                  ))}
                </div>
              </SentAgent.Provider>
            )}
            {h && running && h.total > 0 && !error && (
              <div className="mt-4 flex items-center gap-2 text-sm text-muted" data-transcript-working>
                <Spinner className="size-3.5" /> 작업 중…
              </div>
            )}
            {h && error && <div className="mt-3 px-1 text-xs text-warn">{lost ? "연결이 끊겨 새 기록을 받지 못했습니다" : errorText(error)}</div>}
          </AgentLinks.Provider>
        </FileRoots.Provider>
      </FileLinks.Provider>
      {(away || unseen) && (
        <div className="pointer-events-none sticky bottom-2 z-10 h-0">
          <div className="absolute bottom-0 left-1/2 -translate-x-1/2">
            {unseen ? (
              <button onClick={toEnd} className="pointer-events-auto flex min-h-11 items-center gap-1.5 rounded-full bg-fg px-4 text-sm font-medium whitespace-nowrap text-bg shadow-lg" data-transcript-new>
                새 기록
                <Icon.arrowDown className="size-4" />
              </button>
            ) : (
              <button onClick={toEnd} aria-label="맨 아래로" className="group pointer-events-auto flex size-11 items-center justify-center" data-transcript-end>
                <span className="flex size-9 items-center justify-center rounded-full border border-line bg-surface text-fg shadow-md group-active:bg-surface-2">
                  <Icon.arrowDown className="size-[18px]" />
                </span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
