import { Fragment, Suspense, lazy, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { commandName, dialogResult, isDialogCommand, parseCommand } from "../../../broker/src/dialog-commands.ts";
import type { DisplayItem, ModelOption, QueuedMessage } from "../../../broker/src/protocol.ts";
import { DateLine, ItemView, QueuedItem, StreamPreview, shownItems } from "../components/Items.tsx";
import { lang, t, tc } from "../i18n/index.ts";
import { Composer } from "../components/Composer.tsx";
import { reattach } from "../components/composer/attachments.ts";
import { afterKeyboard } from "../components/composer/picker.ts";
import { commandSheet } from "../components/commandSheets.ts";
import { PendingCard } from "../components/Pending.tsx";
import { ArchivedBadge, SessionActions, renameBlocked, setArchived, setUnread } from "../components/SessionActions.tsx";
import { TodoPanel } from "../components/TodoPanel.tsx";
import { TitleText } from "../components/TitleText.tsx";
import { ChangesSheet } from "../components/sheets/Changes.tsx";
import { CommandResultSheet, StoppedSheet } from "../components/sheets/Command.tsx";
import { ContextSheet } from "../components/sheets/Context.tsx";
import { ContextUsageSheet } from "../components/sheets/ContextUsage.tsx";
import { McpSheet } from "../components/sheets/Mcp.tsx";
import { OutputStyleSheet, outputStyleLabel } from "../components/sheets/OutputStyle.tsx";
import { RewindSheet } from "../components/sheets/Rewind.tsx";
import { SideQuestionSheet } from "../components/sheets/SideQuestion.tsx";
import { ForkSheet } from "../components/sheets/Fork.tsx";
import { MessageActionsSheet } from "../components/sheets/MessageActions.tsx";
import { ExportSheet } from "../components/sheets/Export.tsx";
import { ReplySheet, type Reply } from "../components/sheets/Reply.tsx";
import { copyText } from "../components/clipboard.ts";
import type { UserMessage } from "../components/messageActions.ts";
import { AgentMapSheet } from "../components/sheets/AgentMap.tsx";
import { agentMap } from "../components/agents/tree.ts";
import { ThreadSheet, type ShownThread } from "../components/sheets/Thread.tsx";
import { UsageSheet } from "../components/sheets/Usage.tsx";
import { WorktreeSheet } from "../components/sheets/Worktree.tsx";
import { Choice, Icon, Sheet, Spinner, Tile, Tiles } from "../components/ui.tsx";
import { FileLinks, FileRoots } from "../components/fileLinks.ts";
import { dayLines, streamLine } from "../components/stamps.ts";
import type { FileTarget } from "../components/viewer/FileViewer.tsx";
import { brokerSessionsBlocked, closedText, errorText, hostLabel, inboxNotes, sessionTitle, shortPath } from "../labels.ts";
import { api } from "../api.ts";
import { call, composerInsert, focusDone, getState, joinParked, loadMore, navigate, openAt, openSettingsFrom, refreshChat, requestShown, send, toast, useApp } from "../state.ts";
import { withEarlier } from "../chatItems.ts";
import { markShown, newest, type PeerSent } from "../peerSent.ts";
import { takeSent } from "../sentPreviews.ts";
import { worktreeOf } from "../../../broker/src/worktree-names.ts";
import { placeLabel, shownBranch } from "../worktree.ts";

const FileViewer = lazy(() => import("../components/viewer/FileViewer.tsx"));

// Within PIN_PX of the bottom the list stays at the bottom through any change; within NEAR_BOTTOM_PX new messages
// scroll into view.
const PIN_PX = 2;
const NEAR_BOTTOM_PX = 160;
// Earlier items load while the top of the list is less than this many screens away, and so does a gap's next part.
const LOAD_SCREENS = 1.5;
// A change of size this soon after a touch on the list comes from the touch: the touched item keeps its place.
const TOUCH_MS = 600;
// The user's scroll ends once no finger is on the list and it has not scrolled for this long.
const REST_MS = 150;
const gapBelow = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight;
const fingersOn = (el: Element | null, touches: TouchList) => [...touches].filter((t) => el?.contains(t.target as Node)).length;
// An ended session's conversation ends with the notes of messages Claude Code never took in; what its transcript gains
// later comes in before them.
const lastSaid = (items: DisplayItem[]) => items.findLast((i) => i.kind !== "note" || i.code !== "unsent")?.id;
const FLASH_MS = 2500;
const NO_MODELS: ModelOption[] = [];
// How long a command sent from here may take before its sheet says it gave no result, once the session is idle.
const RESULT_LATE_MS = 15_000;
const RESUME_WAIT_MS = 60_000;
type SheetName = "agents" | "changes" | "context" | "contextUsage" | "export" | "mcp" | "outputStyle" | "rewind" | "usage";
type CommandItem = Extract<DisplayItem, { kind: "command" }>;
// A dialog command sent from here: its result shows in a sheet once a new result of that command arrives.
interface Awaited {
  title: string;
  name: string;
  before: Set<string>;
  late: boolean;
}

// Where the list holds back part of the conversation: before its first item, or in a gap after a far-back item. The part
// loads as it nears the view; the button loads it too and tries again after a failure.
function PartLoader({ part, skipped, loading, failed, onLoad }: { part: "earlier" | "gap"; skipped?: number; loading: boolean; failed: boolean; onLoad: () => void }) {
  const earlier = part === "earlier";
  const text = loading
    ? earlier
      ? t("이전 대화를 불러오는 중…")
      : t("중간 대화를 불러오는 중…")
    : failed
      ? earlier
        ? t("이전 대화를 불러오지 못했습니다")
        : t("중간 대화를 불러오지 못했습니다")
      : earlier
        ? t("이전 대화는 생략했습니다")
        : t("중간 대화 {n}개 항목은 생략했습니다", { n: skipped ?? "" });
  return (
    <div className="flex items-center gap-3 text-xs text-muted" {...(part === "gap" ? { "data-gap": "" } : { "data-earlier": "" })}>
      <span className="h-px flex-1 bg-line" />
      <span className="flex min-h-11 items-center gap-1.5 text-center">
        {loading && <Spinner className="size-3.5 shrink-0" />}
        {text}
        {!loading && (
          <button onClick={onLoad} className="min-h-11 shrink-0 px-1 font-medium text-accent">
            {failed ? t("다시 시도") : t("불러오기")}
          </button>
        )}
      </span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

// Hangs from the top edge of the to-do panel and composer, so it floats just above them whatever their height.
function JumpButton({ unseen, onClick }: { unseen: boolean; onClick: () => void }) {
  return (
    <div className="relative h-0 tiny:hidden">
      <button
        onClick={onClick}
        onMouseDown={(e) => e.preventDefault()}
        aria-label={t("맨 아래로")}
        className="group absolute bottom-2 left-1/2 z-10 flex size-11 -translate-x-1/2 items-center justify-center"
      >
        <span className="relative flex size-9 items-center justify-center rounded-full border border-line bg-surface text-fg shadow-md group-active:bg-surface-2">
          <Icon.arrowDown className="size-[18px]" />
          {unseen && <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-accent ring-2 ring-bg" title={t("새 내용이 있습니다")} data-unseen />}
        </span>
      </button>
    </div>
  );
}

export function Chat({ sessionId }: { sessionId: string }) {
  const chat = useApp((s) => (s.chat?.sessionId === sessionId ? s.chat : undefined));
  const summary = useApp((s) => s.sessions?.find((x) => x.id === sessionId));
  const models = useApp((s) => s.options?.models ?? NO_MODELS);
  const brokerOff = brokerSessionsBlocked(useApp((s) => s.options?.brokerSessions));
  const othersWaiting = useApp((s) => (s.sessions ?? []).some((x) => x.id !== sessionId && x.pendingCount));
  // The ⋯ menu decides as it opens whether it offers 이번 턴 중지 and keeps that row while open, enabled while a turn
  // runs, so a turn starting or ending moves none of its rows.
  // more: it shows the rows used less often instead, in the same sheet, with a way back.
  const [menu, setMenu] = useState<false | { stop: boolean; more?: boolean }>(false);
  const menuBack = useRef<HTMLButtonElement>(null);
  const menuMore = useRef<HTMLButtonElement>(null);
  const menuTop = useRef(0);
  const [sheet, setSheet] = useState<SheetName | null>(null);
  const [usageCommand, setUsageCommand] = useState("usage");
  const [stopped, setStopped] = useState<string | null>(null);
  const [composerSheet, setComposerSheet] = useState<{ name: "model" | "effort"; at: number }>();
  const [awaited, setAwaited] = useState<Awaited>();
  const [file, setFile] = useState<FileTarget | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [thread, setThread] = useState<ShownThread | null>(null);
  const [starting, setStarting] = useState(false);
  const [sentStart, setSentStart] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [message, setMessage] = useState<UserMessage | null>(null);
  const [reply, setReply] = useState<Reply | null>(null);
  // typed: the "/fork" or "/branch" message that opened the sheet, back in the composer when the sheet goes without a fork.
  const [fork, setFork] = useState<{ before?: UserMessage; text?: string; name?: string; typed?: string } | null>(null);
  const [rewindAt, setRewindAt] = useState<string>();
  // A side question sheet; typed: the "/btw" message that opened it, back in the composer when the sheet goes unasked.
  const [side, setSide] = useState<{ question?: string; typed?: string } | null>(null);
  const sideAsked = useRef(false);
  const openSide = (question?: string, typed?: string) => {
    sideAsked.current = false;
    setSide({ question, typed });
  };
  const listRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const stick = useRef(true);
  // A smooth scroll to the bottom from the jump button, until it lands or the user touches the list; a touch
  // stops it where it is, since browsers do not all cancel a smooth scroll for one.
  const glide = useRef(false);
  // The first item in view and how far its top is below the list's top: any other change keeps it there.
  const anchor = useRef<{ id: string; top: number } | null>(null);
  const touched = useRef(0);
  // Where the list was last scrolled to; only a scroll up from there leaves the bottom.
  const lastTop = useRef(0);
  // How the list ended at the last render, to tell what came at its end from changes to what was there.
  const ends = useRef<{ snaps?: number; first?: string; gap?: string; last?: string; said?: string; stream: number; pending: number; queued: number } | null>(
    null,
  );
  // Whether the browser itself keeps what is in view in place through changes above it (CSS scroll anchoring).
  const anchoring = useRef<boolean>(undefined);
  // From a finger or wheel on the list until it rests, the user scrolls it, and nothing here moves it or puts in a
  // loaded part: on iOS a write to the position stops a fling, or from iOS 27 throws it back to where the page last
  // saw it. What would have been done waits for the rest (owed).
  const scrolling = useRef(false);
  const fingers = useRef(0);
  const scrolled = useRef(false);
  const scrolledAt = useRef(0);
  const owed = useRef<{ follow?: boolean; hold?: boolean }>({});
  const restTimer = useRef<number | undefined>(undefined);
  const frame = useRef(0);
  const [away, setAway] = useState(false);
  const [unseen, setUnseen] = useState(false);

  // The list follows new content while it sticks to the bottom; the jump button shows while it does not.
  const follow = (on: boolean) => {
    stick.current = on;
    setAway(!on);
    if (on) setUnseen(false);
  };

  const browserAnchors = () => {
    const el = listRef.current;
    if (anchoring.current === undefined && el) anchoring.current = CSS.supports("overflow-anchor", "auto") && getComputedStyle(el).overflowAnchor !== "none";
    return Boolean(anchoring.current);
  };

  const takeAnchor = (row?: HTMLElement | null) => {
    const el = listRef.current;
    if (!el?.clientHeight) return;
    const top = el.getBoundingClientRect().top;
    if (!row) {
      const rows = [...(contentRef.current?.children ?? [])].filter((r): r is HTMLElement => r instanceof HTMLElement && r.dataset.item !== undefined);
      let lo = 0;
      let hi = rows.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (rows[mid].getBoundingClientRect().bottom > top) {
          row = rows[mid];
          hi = mid - 1;
        } else lo = mid + 1;
      }
    }
    anchor.current = row?.dataset.item ? { id: row.dataset.item, top: row.getBoundingClientRect().top - top } : null;
  };

  // False when the anchored item is not in the list. Where the browser keeps the view in place itself, only a part put
  // in before the item in view or what a touch opened (force) is set right here.
  const keepAnchor = (force = false): boolean => {
    const el = listRef.current;
    const a = anchor.current;
    const row = a && el?.querySelector<HTMLElement>(`[data-item="${CSS.escape(a.id)}"]`);
    if (!el || !a || !row) return false;
    if (scrolling.current || (!force && browserAnchors())) return true;
    const moved = row.getBoundingClientRect().top - el.getBoundingClientRect().top - a.top;
    if (Math.abs(moved) > 0.5) el.scrollBy(0, moved);
    lastTop.current = el.scrollTop;
    return true;
  };

  const toBottom = () => {
    const el = listRef.current;
    if (!el) return;
    if (glide.current) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else {
      if (gapBelow(el) > 0.5) el.scrollTop = el.scrollHeight;
      lastTop.current = el.scrollTop;
      pinned.current = true;
    }
  };

  // After any change of size: the bottom while the list is pinned there, else the item in view where it was. A list
  // with no height shows nothing to hold.
  const hold = (force = false) => {
    const el = listRef.current;
    if (!el?.clientHeight) return;
    catchUp();
    if (scrolling.current) {
      owed.current.hold = true;
      return;
    }
    const tapped = performance.now() - touched.current <= TOUCH_MS;
    if ((pinned.current || glide.current) && !tapped) toBottom();
    else {
      keepAnchor(force || tapped);
      pinned.current = gapBelow(el) < PIN_PX;
    }
  };

  // What the user asks from elsewhere (the jump button, a search hit, the agent map) takes over from their scroll.
  const stopScroll = () => {
    clearTimeout(restTimer.current);
    scrolling.current = false;
    owed.current = {};
    joinParked(sessionId);
  };

  const jump = () => {
    if (!listRef.current) return;
    stopScroll();
    glide.current = !matchMedia("(prefers-reduced-motion: reduce)").matches;
    follow(true);
    toBottom();
  };

  const endGlide = () => {
    const el = listRef.current;
    if (!glide.current || !el) return;
    glide.current = false;
    el.scrollTo({ top: el.scrollTop });
  };

  // A touch or key on an item keeps that item in place while what it opens changes the list.
  const touch = (e: React.SyntheticEvent) => {
    touched.current = performance.now();
    takeAnchor((e.target as HTMLElement).closest<HTMLElement>("[data-item]"));
  };

  // A loaded part goes in only while the list rests, from where the user is reading then.
  const canJoin = () => {
    if (scrolling.current) return false;
    catchUp();
    if (!pinned.current) takeAnchor();
    return true;
  };

  // Loads the part before the list, or the next one of its gap, as it nears the view. retry: the part before the list
  // after it failed too.
  const loadParts = (retry: boolean) => {
    const el = listRef.current;
    const c = getState().chat;
    if (!el || c?.sessionId !== sessionId || !c.loaded || c.loading) return;
    if (c.hasMore && (retry || !c.failed) && el.scrollTop < el.clientHeight * LOAD_SCREENS) void loadMore(sessionId, "earlier", canJoin);
    else if (c.gap && !c.failed) nearGap(el);
  };

  // What a scroll changes: whether the list is at or near the bottom, the item in view, the parts to load. It is looked
  // at once per frame of scrolling, after the browser's scroll events.
  const seen = () => {
    const el = listRef.current;
    if (!el) return;
    const gap = gapBelow(el);
    const up = el.scrollTop < lastTop.current - 0.5;
    lastTop.current = el.scrollTop;
    if (gap < PIN_PX) glide.current = false;
    pinned.current = gap < PIN_PX || (pinned.current && !up);
    const near = gap < NEAR_BOTTOM_PX || (stick.current && !up);
    if (near !== stick.current && (near || !glide.current)) follow(near);
    if (!scrolling.current && !pinned.current) takeAnchor();
    loadParts(true);
  };

  // A scroll whose event is still to come is looked at before anything here acts, so nothing undoes it.
  const catchUp = () => {
    const el = listRef.current;
    if (el && Math.abs(el.scrollTop - lastTop.current) > 0.5) seen();
  };

  // The user's scroll has ended: what waited for it happens now, from where they stopped.
  const settle = () => {
    clearTimeout(restTimer.current);
    if (!scrolling.current) return;
    scrolling.current = false;
    if (scrolled.current) takeAnchor();
    const { follow: news, hold: held } = owed.current;
    owed.current = {};
    if (news && (stick.current || glide.current)) toBottom();
    else {
      if (news) setUnseen(true);
      if (held) hold();
    }
    if (!joinParked(sessionId)) loadParts(false);
  };

  const restSoon = (ms = REST_MS) => {
    clearTimeout(restTimer.current);
    const due = performance.now() + ms;
    restTimer.current = window.setTimeout(() => {
      const el = listRef.current;
      if (!el || !scrolling.current || fingers.current) return;
      const now = performance.now();
      const quiet = now - scrolledAt.current;
      // A late timer means a busy page whose scroll events may not have come yet; so does a position not yet seen.
      if (now - due > 50 || quiet < REST_MS || Math.abs(el.scrollTop - lastTop.current) > 0.5) restSoon(Math.max(REST_MS - quiet, 50));
      else settle();
    }, ms);
  };

  const startScroll = () => {
    if (!scrolling.current) scrolled.current = false;
    scrolling.current = true;
    restSoon();
  };

  // touchend reaches the element the touch began on even once it has left the list, so it is heard there.
  const lifted = useRef((e: Event) => {
    const el = listRef.current;
    fingers.current = fingersOn(el, (e as TouchEvent).touches);
    if (fingers.current) return;
    if (!scrolled.current && el && Math.abs(el.scrollTop - lastTop.current) < 0.5) settleNow.current();
    else restNow.current();
  }).current;
  const settleNow = useRef(settle);
  settleNow.current = settle;
  const restNow = useRef(restSoon);
  restNow.current = restSoon;

  const st = chat?.state;
  const kind = st?.state ?? summary?.state ?? "inactive";
  const controllable = kind === "owned" || kind === "attached";
  // Open in another program that takes text from here as a message from another session.
  const peer = kind === "live" && Boolean(st ? st.inbox : summary?.inbox);
  const conn = useApp((s) => s.conn);
  const deferred = kind === "inactive";
  const folderMissing = deferred && Boolean(st ? st.folderMissing : summary?.folderMissing);
  const host = hostLabel(st?.host ?? summary?.host);
  const busy = Boolean(st?.busy);
  const cwd = st?.cwd ?? summary?.cwd ?? "";
  const cannotStart = folderMissing ? t("작업 폴더가 없어 이 세션을 시작할 수 없습니다: {folder}", { folder: shortPath(cwd) }) : deferred ? brokerOff : undefined;
  // The list knows first of a name given anywhere: it reads the transcript.
  const named = summary?.title || st?.title || "";
  const title = sessionTitle({ title: named });
  const archived = Boolean(summary?.archived);
  const vscodeArchived = archived && Boolean(summary?.vscodeArchived);
  const renameTarget = { id: sessionId, title: named, state: kind, host: st?.host ?? summary?.host, archived, vscodeArchived, cwd };
  const worktree = worktreeOf(cwd);
  const renameRefused = renameBlocked(renameTarget);
  // Why the menu's greyed actions cannot be used; they point to this line.
  const unable = renameRefused
    ? t("{host}에서 열려 있어 여기서는 이름을 바꿀 수 없습니다", { host })
    : folderMissing
      ? t("작업 폴더가 없어 갈래를 만들거나 되돌릴 수 없습니다")
      : brokerOff
        ? t("원격 세션이 꺼져 있어 갈래를 만들 수 없습니다")
        : undefined;
  const unableId = useId();
  // The header's title and the line under it are one button to rename, its padding reaching over the header's height
  // as the back button's does. The sheet opens within the tap, so its field can take the keyboard on iOS.
  const rename = () => {
    if (renameRefused) return toast(renameRefused);
    flushSync(() => {
      setMenu(false);
      setRenaming(true);
    });
  };
  // A tap on a button leaves the iOS keyboard up; the menu needs none, so it opens once the keyboard has gone down.
  const openMenu = () => {
    const open = () => setMenu({ stop: busy && controllable });
    if (!document.documentElement.hasAttribute("data-keyboard")) return open();
    (document.activeElement as HTMLElement | null)?.blur();
    afterKeyboard(open);
  };
  // 더 보기 opens at its top with the focus on 메뉴; 메뉴 brings the menu back scrolled as it was, the focus and the
  // view on 더 보기.
  const showMore = (more: boolean) => {
    const sheet = (more ? menuMore : menuBack).current?.closest<HTMLElement>('[role="dialog"]');
    if (more) menuTop.current = sheet?.scrollTop ?? 0;
    flushSync(() => setMenu((m) => m && { ...m, more }));
    if (!sheet) return;
    sheet.scrollTop = more ? 0 : menuTop.current;
    const to = (more ? menuBack : menuMore).current;
    to?.focus({ preventScroll: true });
    if (!more) to?.scrollIntoView({ block: "nearest" });
  };
  const items = useMemo(() => shownItems(chat?.items ?? []), [chat?.items]);
  // The items with the agent and to-do calls of the parts not loaded, for what reads the whole conversation.
  const context = useMemo(() => (chat ? withEarlier(chat) : []), [chat?.items, chat?.earlier, chat?.earlierInGap, chat?.gap]);
  const days = useMemo(() => dayLines(items), [items]);
  // The first shown item of the latest part, when a far-back search hit left items out before it.
  const gapAt = useMemo(() => {
    const gap = chat?.gap;
    const all = chat?.items ?? [];
    const start = gap ? all.findIndex((i) => i.id === gap.before) : -1;
    if (start < 0) return undefined;
    const latest = new Set(all.slice(start).map((i) => i.id));
    return items.find((i) => latest.has(i.id))?.id;
  }, [chat?.gap, chat?.items, items]);
  // A message that has just been taken in may still be listed as queued for a moment.
  const queued = useMemo(() => {
    const shown = new Set((chat?.items ?? []).map((i) => i.id));
    return (st?.queued ?? []).filter((q) => !shown.has(q.id));
  }, [chat?.items, st?.queued]);
  // Text sent to a session open elsewhere waits here until its transcript shows it.
  const [peerSent, setPeerSent] = useState<PeerSent[]>([]);
  const peerMarked = useMemo(() => markShown(peerSent, chat?.items ?? []), [peerSent, chat?.items]);
  const peerWaiting = useMemo(() => peerMarked.filter((q) => !q.shown), [peerMarked]);
  useEffect(() => {
    if (peerMarked !== peerSent) setPeerSent((list) => markShown(list, chat?.items ?? []));
  }, [peerMarked, peerSent, chat?.items]);
  const [taking, setTaking] = useState<string | null>(null);
  // A message taken back returns to the composer with its text and the photos sent from this device.
  const takeBack = (q: QueuedMessage) => {
    if (taking) return;
    setTaking(q.id);
    call(sessionId, "unqueue", { messageId: q.id })
      .then(() => {
        if (q.text) composerInsert(q.text);
        const lost = reattach(sessionId, q.attachments ?? [], takeSent(q.id));
        if (lost) toast(t("첨부 {n}개는 다시 골라 주세요", { n: lost }));
      })
      .catch((e: Error) => toast(errorText(e.message)))
      .finally(() => setTaking(null));
  };

  const stop = () => send({ t: "interrupt", sessionId });

  const sendPeer = (text: string) => {
    if (conn !== "ready") return false;
    const id = `peer-${Date.now()}-${peerSent.length}`;
    setPeerSent((list) => [...list, { id, ts: new Date().toISOString(), text, from: "remote", since: newest(chat?.items ?? []) }]);
    follow(true);
    call(sessionId, "inbox_send", { text, lang: lang() }).then(
      ({ msgId }) => {
        setPeerSent((list) => list.map((q) => (q.id === id ? { ...q, msgId } : q)));
        toast(t("다른 세션 메시지로 보냈습니다"));
      },
      (e: Error) => {
        setPeerSent((list) => list.filter((q) => q.id !== id));
        composerInsert(text);
        toast(errorText(e.message));
        if (e.message === "session is not open elsewhere") send({ t: "view", sessionId });
      },
    );
    return true;
  };

  const sendText = (text: string, attachments: string[] = []) => {
    const c = attachments.length ? undefined : parseCommand(text);
    // "/fork" and "/branch" open the fork sheet with what follows them as the fork's task or, as Claude Code's /branch
    // takes it, its name; nothing is sent.
    if (c && commandSheet(c.name)?.sheet === "fork") {
      (document.activeElement as HTMLElement | null)?.blur();
      setFork({ ...(commandName(c.name) === "branch" ? { name: c.args } : { text: c.args }), typed: text });
      return true;
    }
    // "/btw" asks what follows it beside the conversation; nothing is sent.
    if (c && commandSheet(c.name)?.sheet === "btw") {
      (document.activeElement as HTMLElement | null)?.blur();
      openSide(c.args || undefined, text);
      return true;
    }
    const before = new Set((chat?.items ?? []).filter((i) => i.kind === "command").map((i) => i.id));
    const ok = send({ t: "send", sessionId, text, ...(attachments.length ? { attachments } : {}) });
    if (ok) follow(true);
    if (ok && c && isDialogCommand(c.name)) setAwaited({ title: text.trim(), name: commandName(c.name), before, late: false });
    if (ok && deferred) setSentStart(true);
    return ok;
  };

  // A message to a stopped session starts it; that lasts until the session runs or the wait runs out.
  useEffect(() => {
    if (!sentStart) return;
    if (!deferred) return setSentStart(false);
    const t = setTimeout(() => setSentStart(false), RESUME_WAIT_MS);
    return () => clearTimeout(t);
  }, [sentStart, deferred]);

  // Starts the session's Claude Code process here without sending anything.
  const startNow = () => {
    if (starting || folderMissing) return;
    setStarting(true);
    call(sessionId, "resume", {}, RESUME_WAIT_MS)
      .catch((e: Error) => toast(errorText(e.message)))
      .finally(() => setStarting(false));
  };

  const result = useMemo(() => {
    const all = chat?.items ?? [];
    return awaited && all.find((i, n): i is CommandItem => i.kind === "command" && !awaited.before.has(i.id) && dialogResult(all, n) === awaited.name);
  }, [awaited, chat?.items]);

  useEffect(() => {
    if (!awaited || result || awaited.late) return;
    const t = setTimeout(() => setAwaited((a) => a && { ...a, late: true }), RESULT_LATE_MS);
    return () => clearTimeout(t);
  }, [awaited, result]);

  const openTarget = (name: string) => {
    const target = commandSheet(name)?.sheet;
    if (target === "model" || target === "effort") setComposerSheet({ name: target, at: Date.now() });
    else if (target === "config") openSettingsFrom("claude");
    else if (target === "permissions") openSettingsFrom("claude", "permissions");
    else if (target === "fork") setFork({});
    else if (target === "btw") openSide();
    else if (target === "copy") copyLatest();
    else if (target === "usage") {
      setUsageCommand(name);
      setSheet("usage");
    } else if (target) setSheet(target);
  };

  // A bare dialog command opens its sheet and is never sent; one that needs Claude Code waits for the user
  // to start the session's process.
  const openCommand = (name: string) => {
    const target = commandSheet(name);
    if (!target || kind === "live") return false;
    if (target.live && !controllable) setStopped(name);
    else openTarget(name);
    return true;
  };

  useEffect(() => {
    if (!stopped || !controllable) return;
    setStopped(null);
    openTarget(stopped);
  }, [stopped, controllable]);

  const agentChip = useMemo(() => agentMap({ tasks: st?.tasks, items: context, pending: chat?.pending ?? [], busy }).chip, [st?.tasks, context, chat?.pending, busy]);

  // The subagent a permission request comes from, by its task or as an agent of a workflow.
  const askingAgent = (agentId?: string) => {
    if (!agentId) return undefined;
    const task = st?.tasks?.find((x) => x.id === agentId);
    if (task) return task.description || task.agentType ? `${t("서브에이전트")} · ${task.description || task.agentType}` : t("서브에이전트");
    const w = st?.tasks?.flatMap((x) => x.workflow?.agents ?? []).find((a) => a.id === agentId);
    return w ? `${t("워크플로 에이전트")} · ${w.label}` : t("서브에이전트");
  };

  // Shows an element of the list in its middle, which then holds its place.
  const reveal = (el: Element) => {
    const list = listRef.current!;
    stopScroll();
    el.scrollIntoView({ block: "center" });
    glide.current = false;
    pinned.current = gapBelow(list) < PIN_PX;
    follow(gapBelow(list) < NEAR_BOTTOM_PX);
    takeAnchor(el.closest<HTMLElement>("[data-item]"));
  };

  // Closes the map and shows a conversation item, fetching the part around it when it is not loaded.
  const jumpTo = (itemId: string) => {
    setSheet(null);
    const el = listRef.current?.querySelector(`[data-item="${CSS.escape(itemId)}"]`);
    if (!el) return openAt(sessionId, itemId);
    reveal(el);
    setFlash(itemId);
  };

  const jumpToRequest = (requestId: string) => {
    setSheet(null);
    const el = listRef.current?.querySelector(`[data-pending="${CSS.escape(requestId)}"]`);
    if (!el) return;
    reveal(el);
    setFlash(requestId);
  };

  const openFile = useCallback((href: string) => {
    if (!href.startsWith("#")) setFile({ href });
  }, []);
  const openMessage = useCallback((m: UserMessage) => setMessage(m), []);
  const openReply = useCallback((m: Reply) => setReply(m), []);
  // "/copy" copies Claude's latest reply as VS Code's does, within the tap that sent it.
  const copyLatest = () => {
    const last = (chat?.items ?? []).findLast((i): i is Reply => i.kind === "assistant");
    if (last) copyText(last.text, t("답을 복사했습니다"));
    else toast(t("복사할 답이 없습니다"));
  };
  const roots = useMemo(() => (cwd ? [cwd] : []), [cwd]);

  // Only a message, request or reply added at the end is new: it scrolls into view near the bottom and is marked
  // away from it. Any other change keeps the list at the bottom while it is pinned there, else the item in view in place.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || !chat?.loaded) return;
    const now = {
      snaps: chat.snaps,
      first: items[0]?.id,
      gap: chat.gap && `${chat.gap.before} ${chat.gap.skipped}`,
      last: items.at(-1)?.id,
      said: lastSaid(items),
      stream: chat.stream ? chat.stream.text.length : -1,
      pending: chat.pending.length,
      queued: queued.length + (peer ? peerWaiting.length : 0),
    };
    const was = ends.current;
    ends.current = now;
    if (chat.focus) return;
    catchUp();
    if (!was) {
      toBottom();
      follow(true);
    } else if (was.snaps !== now.snaps) {
      if (scrolling.current) owed.current.hold = true;
      else if (pinned.current || !keepAnchor(true)) {
        toBottom();
        follow(true);
      }
    } else {
      const came = (id?: string, before?: string) => id !== before && (before === undefined || items.some((i) => i.id === before));
      const added =
        came(now.last, was.last) ||
        came(now.said, was.said) ||
        now.stream > was.stream ||
        now.pending > was.pending ||
        now.queued > was.queued;
      if (added && (stick.current || glide.current)) {
        if (scrolling.current) owed.current.follow = true;
        else toBottom();
      } else {
        if (added) setUnseen(true);
        hold(now.first !== was.first || now.gap !== was.gap);
      }
    }
    loadParts(false);
  });

  // A change of the list's size (rotation, a taller composer or to-do panel) or of what it holds that no render made
  // (an image that loaded, an item opened) is held the same way.
  useEffect(() => {
    const resized = new ResizeObserver(() => hold());
    resized.observe(listRef.current!);
    resized.observe(contentRef.current!);
    const hidden = () => {
      if (document.visibilityState !== "hidden") return;
      fingers.current = 0;
      settleNow.current();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      resized.disconnect();
      document.removeEventListener("visibilitychange", hidden);
      cancelAnimationFrame(frame.current);
      clearTimeout(restTimer.current);
    };
  }, []);

  const focus = chat?.loaded ? chat.focus : undefined;
  const focusEarlier = chat?.focusEarlier;
  useLayoutEffect(() => {
    if (!focus) return;
    focusDone(sessionId);
    const el = listRef.current?.querySelector(`[data-item="${CSS.escape(focus)}"]`);
    if (!el) {
      toBottom();
      follow(true);
      api.thread(sessionId, focus).then(
        (t) => setThread({ ...t, ...(focusEarlier ? { earlier: true } : {}) }),
        () => toast(t("찾은 메시지가 지금 대화에 없습니다")),
      );
      return;
    }
    reveal(el);
    setFlash(focus);
  }, [focus, focusEarlier, sessionId]);

  // The next part of a gap loads as it nears the view.
  const nearGap = (el: HTMLElement) => {
    const marker = el.querySelector("[data-gap]");
    if (!marker) return;
    const top = marker.getBoundingClientRect().top - el.getBoundingClientRect().top;
    if (top > -el.clientHeight * LOAD_SCREENS && top < el.clientHeight * (1 + LOAD_SCREENS)) void loadMore(sessionId, "gap", canJoin);
  };

  const focusRequest = chat?.loaded ? chat.focusRequest : undefined;
  useLayoutEffect(() => {
    if (!focusRequest) return;
    requestShown(sessionId);
    jumpToRequest(focusRequest);
  }, [focusRequest, sessionId]);

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash]);

  const status =
    kind === "owned"
      ? busy
        ? t("작업 중")
        : t("원격 실행 중")
      : kind === "attached"
        ? busy
          ? t("{host}에서 작업 중", { host })
          : t("{host} 연결됨", { host })
        : kind === "live"
          ? t("{host}에서 열림", { host })
          : folderMissing
            ? t("폴더 없음")
            : t("꺼져 있음");
  const disabledReason =
    kind === "live" && !peer
      ? t("{host}에서 열려 있어 지금은 보기만 할 수 있습니다.", { host })
      : folderMissing
        ? t("작업 폴더가 없어 보기만 할 수 있습니다.")
        : deferred
          ? brokerOff
          : undefined;

  return (
    <div className="flex h-dvh flex-col">
      <header className="screen-header pt-safe border-b border-line bg-bg">
        <div className="flex items-center gap-1 px-safe-2 py-2 short:py-0.5">
          <button onClick={() => navigate({ name: "home" })} aria-label={t("뒤로")} className="relative -m-1 rounded-lg p-3">
            <Icon.back />
            {othersWaiting && <span className="absolute top-2.5 right-2.5 size-2 rounded-full bg-warn" title={t("다른 세션에서 입력이 필요합니다")} />}
          </button>
          <button
            onClick={rename}
            aria-haspopup="dialog"
            title={t("이름 바꾸기")}
            className="-my-2 flex min-w-0 flex-1 items-center self-stretch py-2 text-left short:-my-1 short:py-1"
          >
            <span className="min-w-0 flex-1 short:flex short:items-baseline short:gap-2">
              <span className="block truncate text-[15px] font-semibold short:max-w-[60%] short:shrink-0" data-chat-title>
                <TitleText text={title} />
              </span>
              <span className="flex min-w-0 items-baseline gap-1.5 text-xs text-muted">
                {archived && <ArchivedBadge vscode={vscodeArchived} />}
                <span className="truncate">
                  {placeLabel(cwd)}
                  {shownBranch(cwd, summary?.branch) ? ` · ${summary?.branch}` : ""} · {status}
                </span>
              </span>
            </span>
          </button>
          <button onClick={openMenu} aria-label={t("메뉴")} className="relative -m-1 rounded-lg p-3 text-muted">
            <Icon.dots />
          </button>
        </div>
      </header>

      <div
        ref={listRef}
        // Reads no layout here: WebKit does not anchor what changes in a layout made inside a scroll event.
        onScroll={() => {
          scrolledAt.current = performance.now();
          if (scrolling.current) {
            scrolled.current = true;
            if (!fingers.current) restSoon();
          }
          frame.current ||= requestAnimationFrame(() => {
            frame.current = 0;
            seen();
          });
        }}
        onPointerDown={(e) => {
          endGlide();
          touch(e);
          if (e.pointerType === "touch") startScroll();
        }}
        onTouchStart={(e) => {
          fingers.current = fingersOn(e.currentTarget, e.nativeEvent.touches);
          e.target.addEventListener("touchend", lifted);
          e.target.addEventListener("touchcancel", lifted);
          startScroll();
        }}
        onKeyDown={touch}
        onWheel={() => {
          endGlide();
          startScroll();
        }}
        className="flex-1 overflow-y-auto overscroll-contain px-safe-0"
        data-scroll-root
      >
        <FileLinks.Provider value={openFile}>
          <FileRoots.Provider value={roots}>
            {/* The bottom keeps 16px on short screens too: the tap target of the last message's or reply's ⋯ reaches that far. */}
            <div ref={contentRef} className="mx-auto max-w-3xl space-y-4 px-4 py-4 short:pt-3">
              {!chat?.loaded && (
                <div className="flex justify-center py-10 text-muted">
                  <Spinner className="size-6" />
                </div>
              )}
              {chat?.loaded && chat.hasMore && (
                <PartLoader part="earlier" loading={chat.loading === "earlier"} failed={chat.failed === "earlier"} onLoad={() => void loadMore(sessionId, "earlier", canJoin)} />
              )}
              {items.map((item) => (
                <Fragment key={item.id}>
                  {item.id === gapAt && (
                    <PartLoader part="gap" skipped={chat?.gap?.skipped} loading={chat?.loading === "gap"} failed={chat?.failed === "gap"} onLoad={() => void loadMore(sessionId, "gap", canJoin)} />
                  )}
                  <DateLine day={days.get(item.id)} />
                  <div
                    data-item={item.id}
                    className={`rounded-xl transition-shadow duration-700 ${flash === item.id ? "ring-2 ring-accent/70 ring-offset-4 ring-offset-bg" : ""}`}
                  >
                    <ItemView item={item} running={busy} onMessage={openMessage} onReply={openReply} />
                  </div>
                </Fragment>
              ))}
              {chat?.stream && (
                <>
                  <DateLine day={streamLine(days, chat.stream)} />
                  <StreamPreview text={chat.stream.text} thinking={chat.stream.thinking} />
                </>
              )}
              {busy && !chat?.stream && !chat?.pending.length && (
                <div className="flex items-center gap-2 text-sm text-muted">
                  <Spinner className="size-3.5" /> {t("작업 중…")}
                </div>
              )}
              {queued.map((q) => (
                <QueuedItem
                  key={q.id}
                  message={q}
                  host={host}
                  taking={taking === q.id}
                  onTakeBack={q.from === "remote" && controllable ? () => takeBack(q) : undefined}
                />
              ))}
              {peer && peerWaiting.map((q) => <QueuedItem key={q.id} message={q} host={host} note={t("다른 세션 메시지로 보냄 · 받으면 대화에 나타납니다")} />)}
              {chat?.pending.map((p) => (
                <div key={p.id} data-pending={p.id} className={`rounded-2xl transition-shadow duration-700 ${flash === p.id ? "ring-2 ring-accent/70 ring-offset-4 ring-offset-bg" : ""}`}>
                  <PendingCard
                    request={p}
                    agent={askingAgent(p.agentId)}
                    reply={(answer) => {
                      if (!send({ t: "answer", sessionId, requestId: p.id, answer })) return toast(t("연결되어 있지 않습니다. 다시 연결된 뒤 답하세요"));
                      // Editing the refused message starts from it, as VS Code puts it back in its input.
                      if (answer.kind === "dialog" && answer.choice === "edit_prompt") {
                        const last = chat?.items.findLast((i) => i.kind === "user");
                        if (last?.kind === "user" && last.text) composerInsert(last.text, true);
                      }
                    }}
                  />
                </div>
              ))}
              {chat?.loaded && archived && (
                <div className="flex items-center gap-3 rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-muted" data-archived-note>
                  <p className="min-w-0 flex-1 break-keep text-balance">
                    <span className="block">{vscodeArchived ? t("VS Code에서 보관한 세션입니다.") : t("보관된 세션입니다.")}</span>
                    {(kind !== "live" || peer) && !folderMissing && <span className="block">{t("메시지를 보내면 보관이 풀립니다.")}</span>}
                  </p>
                  <button onClick={() => setArchived(sessionId, false, vscodeArchived)} className="min-h-11 shrink-0 rounded-lg bg-surface px-4 font-medium text-accent">
                    {t("보관 해제")}
                  </button>
                </div>
              )}
              {chat?.loaded && kind === "inactive" && (
                <div className="flex items-center gap-3 rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-muted" data-stopped-note={folderMissing ? "folder-missing" : ""}>
                  {folderMissing ? (
                    <p className="min-w-0 flex-1 break-keep">
                      {t("작업 폴더가 없어 이 세션을 시작할 수 없습니다.")}
                      <span className="mt-0.5 block text-xs break-all">{shortPath(cwd)}</span>
                    </p>
                  ) : (
                    <>
                      {st?.resumeIn ? (
                        <p className="min-w-0 flex-1 break-keep text-balance" data-resume-in>
                          <span className="block">{t("worktree가 지워져 원래\u00a0폴더에서 이어서 실행합니다.")}</span>
                          <span className="mt-0.5 block text-xs break-all">{shortPath(st.resumeIn)}</span>
                        </p>
                      ) : (
                        <p className="min-w-0 flex-1 break-keep text-balance" data-broker-off={brokerOff ? "" : undefined}>
                          <span className="block">{closedText(st?.closedReason) || t("꺼져 있는 세션입니다.")}</span>
                          <span className="block">{brokerOff ? t("원격 세션이 꺼져 있어 기록만 볼 수 있습니다.") : t("메시지를 보내면 이어서 실행합니다.")}</span>
                        </p>
                      )}
                      {!brokerOff && (
                        <button onClick={startNow} disabled={starting} className="min-h-11 shrink-0 rounded-lg bg-surface px-4 font-medium text-accent disabled:opacity-50">
                          {starting ? t("시작하는 중…") : t("지금 시작")}
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </FileRoots.Provider>
        </FileLinks.Provider>
      </div>

      {away && <JumpButton unseen={unseen} onClick={jump} />}
      {chat?.loaded && <TodoPanel items={context} />}

      <Composer
        sessionId={sessionId}
        state={st}
        models={models}
        controllable={controllable}
        deferred={deferred}
        starting={starting || sentStart}
        disabledReason={disabledReason}
        placeholder={t("Claude에게 메시지")}
        onSend={peer ? sendPeer : sendText}
        onCommand={openCommand}
        openSheet={composerSheet}
        onStop={stop}
        onMode={(mode) => send({ t: "set_mode", sessionId, mode })}
        onModel={(model) => send({ t: "set_model", sessionId, model })}
        onEffort={(effort) => send({ t: "set_effort", sessionId, effort })}
        onUltracode={(on) => send({ t: "set_ultracode", sessionId, on })}
        onFast={(on) => send({ t: "set_fast", sessionId, on })}
        onThinking={(on) => send({ t: "set_thinking", sessionId, on })}
        inConversation={Boolean(chat?.hasMore) || items.some((i) => i.kind === "user" || i.kind === "assistant")}
        onContext={() => setSheet("contextUsage")}
        agents={agentChip}
        onAgents={() => setSheet("agents")}
        peer={peer ? { notes: inboxNotes(st?.host ?? summary?.host, st?.inbox) } : undefined}
      />

      {menu && (
        <Sheet title={title} onClose={() => setMenu(false)}>
          {menu.more ? (
            <Fragment key="more">
              <button ref={menuBack} onClick={() => showMore(false)} className="mb-1 flex min-h-11 items-center gap-1 px-2 text-sm font-medium text-accent" data-menu-back>
                <Icon.back className="size-4" /> {t("메뉴")}
              </button>
              {controllable && (
                <>
                  <Choice label={tc("server list", "MCP 서버")} onClick={() => (setSheet("mcp"), setMenu(false))} />
                  <Choice label={t("출력 스타일")} value={st?.outputStyle && outputStyleLabel(st.outputStyle)} onClick={() => (setSheet("outputStyle"), setMenu(false))} />
                </>
              )}
              <Choice label={t("대화 내보내기")} onClick={() => (setSheet("export"), setMenu(false))} />
              <Choice
                label={t("읽지 않음으로 표시")}
                onClick={() => {
                  setMenu(false);
                  void setUnread(sessionId, true).then((ok) => ok && navigate({ name: "home" }));
                }}
              />
              {(worktree || kind === "owned") && <div className="mx-3 my-1.5 h-px bg-line" />}
              {worktree && <Choice label={t("worktree 정리")} onClick={() => (setCleaning(true), setMenu(false))} />}
              {kind === "owned" && (
                <Choice
                  label={t("원격 실행 끝내기")}
                  hint={t("Claude Code 프로세스를 닫습니다. 대화 기록은 남습니다.")}
                  onClick={() => (send({ t: "release", sessionId }), setMenu(false))}
                />
              )}
            </Fragment>
          ) : (
            <Fragment key="menu">
              <div className="mb-2 px-3 text-xs break-all text-muted">{cwd}</div>
              {menu.stop && (
                <Choice
                  label={t("이번 턴 중지")}
                  hint={
                    <>
                      <span className="block">{t("입력창에 쓴 글은 그대로 둡니다.")}</span>
                      <span className="block">{t("백그라운드 에이전트는 에이전트 지도에서 멈춥니다.")}</span>
                    </>
                  }
                  disabled={!busy || !controllable}
                  onClick={() => (stop(), setMenu(false))}
                />
              )}
              <div className="mt-1 mb-2">
                <Tiles>
                  <Tile icon={<Icon.refresh />} label={t("새로고침")} onClick={() => (refreshChat(), setMenu(false))} />
                  <Tile icon={<Icon.pencil />} label={t("이름 바꾸기")} disabled={Boolean(renameRefused)} describedBy={renameRefused ? unableId : undefined} onClick={rename} />
                  <Tile
                    icon={archived ? <Icon.unarchive /> : <Icon.archive />}
                    label={archived ? t("보관 해제") : t("보관하기")}
                    onClick={() => (!archived && worktree ? setArchiving(true) : setArchived(sessionId, !archived, vscodeArchived), setMenu(false))}
                  />
                  <Tile
                    icon={<Icon.branch />}
                    label={t("갈래로 떼기")}
                    disabled={folderMissing || Boolean(brokerOff)}
                    describedBy={folderMissing || brokerOff ? unableId : undefined}
                    onClick={() => (setFork({}), setMenu(false))}
                  />
                </Tiles>
                {unable && (
                  <p id={unableId} className="mt-2 px-3 text-xs text-muted" data-menu-unable>
                    {unable}
                  </p>
                )}
              </div>
              <Choice label={t("곁질문")} onClick={() => (openSide(), setMenu(false))} />
              <Choice
                label={t("되돌리기")}
                disabled={folderMissing}
                describedBy={folderMissing ? unableId : undefined}
                onClick={() => (setRewindAt(undefined), setSheet("rewind"), setMenu(false))}
              />
              <Choice label={t("변경 사항")} onClick={() => (setSheet("changes"), setMenu(false))} />
              <Choice label={t("Context와 사용량")} onClick={() => (setSheet("contextUsage"), setMenu(false))} />
              <Choice label={t("에이전트 지도")} onClick={() => (setSheet("agents"), setMenu(false))} />
              <Choice ref={menuMore} label={tc("session menu", "더 보기")} next onClick={() => showMore(true)} />
            </Fragment>
          )}
        </Sheet>
      )}
      {file && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg text-muted">
              <Spinner className="size-6" />
            </div>
          }
        >
          <FileViewer sessionId={sessionId} cwd={cwd} target={file} onClose={() => setFile(null)} />
        </Suspense>
      )}
      {thread && <ThreadSheet thread={thread} onClose={() => setThread(null)} />}
      {renaming && <SessionActions session={renameTarget} step="rename" onClose={() => setRenaming(false)} />}
      {archiving && <SessionActions session={renameTarget} step="archive" onClose={() => setArchiving(false)} />}
      {cleaning && <WorktreeSheet sessionId={sessionId} onClose={() => setCleaning(false)} />}
      {sheet === "changes" && <ChangesSheet sessionId={sessionId} onClose={() => setSheet(null)} />}
      {side && (
        <SideQuestionSheet
          sessionId={sessionId}
          question={side.question}
          ask={Boolean(side.typed)}
          onAsked={() => (sideAsked.current = true)}
          onClose={() => {
            if (side.typed && !sideAsked.current) composerInsert(side.typed, true);
            setSide(null);
          }}
        />
      )}
      {sheet === "agents" && (
        <AgentMapSheet sessionId={sessionId} title={title} controllable={controllable} onClose={() => setSheet(null)} onJump={jumpTo} onPending={jumpToRequest} onFile={openFile} />
      )}
      {sheet === "context" && (
        <ContextSheet sessionId={sessionId} state={st} kind={kind} starting={starting} cannotStart={cannotStart} onClose={() => setSheet(null)} onStart={startNow} />
      )}
      {sheet === "contextUsage" && (
        <ContextUsageSheet
          sessionId={sessionId}
          state={st}
          kind={kind}
          starting={starting}
          cannotStart={cannotStart}
          onClose={() => setSheet(null)}
          onStart={startNow}
          onCompact={(text) => {
            if (sendText(text)) return true;
            toast("not connected");
            return false;
          }}
        />
      )}
      {sheet === "usage" && (
        <UsageSheet
          sessionId={sessionId}
          onClose={() => setSheet(null)}
          onFail={
            controllable
              ? () => {
                  setSheet(null);
                  if (!sendText(`/${usageCommand}`)) toast("not connected");
                }
              : undefined
          }
        />
      )}
      {stopped && <StoppedSheet sessionId={sessionId} title={t(commandSheet(stopped)?.title ?? `/${stopped}`)} onClose={() => setStopped(null)} />}
      {awaited && <CommandResultSheet title={awaited.title} item={result} late={awaited.late && !busy} onClose={() => setAwaited(undefined)} />}
      {sheet === "mcp" && <McpSheet sessionId={sessionId} onClose={() => setSheet(null)} />}
      {sheet === "outputStyle" && <OutputStyleSheet sessionId={sessionId} onClose={() => setSheet(null)} />}
      {sheet === "rewind" && <RewindSheet sessionId={sessionId} initial={rewindAt} onClose={() => (setSheet(null), setRewindAt(undefined))} />}
      {sheet === "export" && <ExportSheet sessionId={sessionId} onClose={() => setSheet(null)} />}
      {reply && (
        <ReplySheet
          reply={reply}
          onExport={() => {
            setReply(null);
            setSheet("export");
          }}
          onClose={() => setReply(null)}
        />
      )}
      {message && (
        <MessageActionsSheet
          message={message}
          kind={kind}
          busy={busy}
          host={st?.host ?? summary?.host}
          cannot={folderMissing ? t("작업 폴더가 없어 할 수 없습니다") : undefined}
          onFork={() => {
            setMessage(null);
            setFork({ before: message });
          }}
          onRedo={() => {
            setMessage(null);
            setRewindAt(message.id);
            setSheet("rewind");
          }}
          onClose={() => setMessage(null)}
        />
      )}
      {fork && (
        <ForkSheet
          sessionId={sessionId}
          before={fork.before}
          text={fork.text}
          name={fork.name}
          onDone={() => setFork(null)}
          onClose={() => {
            if (fork.typed) composerInsert(fork.typed, true);
            setFork(null);
          }}
        />
      )}
    </div>
  );
}
