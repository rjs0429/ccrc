import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { Pull } from "../components/Pull.tsx";
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
import { CopyButton } from "../components/CopyButton.tsx";
import type { UserMessage } from "../components/messageActions.ts";
import { AgentMapSheet } from "../components/sheets/AgentMap.tsx";
import { agentMap } from "../components/agents/tree.ts";
import { ThreadSheet, type ShownThread } from "../components/sheets/Thread.tsx";
import { UsageSheet } from "../components/sheets/Usage.tsx";
import { WorktreeSheet } from "../components/sheets/Worktree.tsx";
import { Choice, Icon, Sheet, Spinner, Tile, Tiles } from "../components/ui.tsx";
import { FileLinks, FileRoots } from "../components/fileLinks.ts";
import { dayLines, streamLine } from "../components/stamps.ts";
import { selectedIn } from "../components/streamSelection.ts";
import type { FileTarget } from "../components/viewer/FileViewer.tsx";
import { brokerSessionsBlocked, closedText, errorText, hostLabel, inboxNotes, sessionTitle, shortPath } from "../labels.ts";
import { api } from "../api.ts";
import { nav, useLayerState } from "../nav.ts";
import { call, composerInsert, dropParked, focusDone, getState, joinParked, listMoved, loadMore, onReading, openAt, openSettingsFrom, refreshChat, requestShown, send, sendMessage, toast, useApp } from "../state.ts";
import { withEarlier } from "../chatItems.ts";
import { markShown, newest, type PeerSent } from "../peerSent.ts";
import { takeSent } from "../sentPreviews.ts";
import { glideTo, glideTop, useToTop } from "../topTap.ts";
import { note, trail } from "../trail.ts";
import { worktreeOf } from "../../../broker/src/worktree-names.ts";
import { placeLabel, shownBranch } from "../worktree.ts";
import { FileViewer } from "../components/viewer/lazy.ts";

// Within PIN_PX of the bottom the list stays at the bottom through any change, and a list scrolled down there follows
// new messages again; one that follows them goes on while it rests within NEAR_BOTTOM_PX of the bottom.
const PIN_PX = 2;
const NEAR_BOTTOM_PX = 160;
// A finger that stays on the list HOLD_MS holds it, as a selection in it does: nothing moves the list, what comes
// meanwhile is not followed and the jump button shows it with its chip. After a shorter touch, or a fling, that began or
// ended at the bottom, what came is followed smoothly while the way down is shorter than FOLLOW_SHARE of the list.
const HOLD_MS = 300;
const FOLLOW_SHARE = 1;
// The jump button takes no press while the user's scroll (a drag or its fling) moves the list faster than FLING_PX_MS,
// as measured over at least SPEED_MS of whole pixels, nor for JUMP_GUARD_MS after: a tap meant to stop a fling can land
// on it.
const FLING_PX_MS = 0.1;
const SPEED_MS = 50;
const JUMP_GUARD_MS = 300;
// A smooth scroll to the bottom or the top has ended once the list stays still for GLIDE_REST_MS after it moved, or for
// GLIDE_START_MS when it has not moved yet (looked at every GLIDE_CHECK_MS).
const GLIDE_CHECK_MS = 80;
const GLIDE_REST_MS = 160;
const GLIDE_START_MS = 1000;
// A move of more than a screen by nothing the user did or asked for in the ASKED_MS before is recorded with what led
// there.
const ASKED_MS = 4000;
// How many items in view, and above them, a change of the conversation tries to keep in place, the first still there.
const ANCHORS_IN_VIEW = 4;
const ANCHORS_ABOVE = 4;
// A change of the list's width (a rotation) keeps the text read at the list's top there: the character found
// MARK_X_PX in from the content's left edge (past its padding) and MARK_Y_PX below the list's top, when its line is
// within MARK_NEAR_PX of that point, else the block there. The width has settled once it stays for TURN_MS.
const MARK_X_PX = 24;
const MARK_Y_PX = 8;
const MARK_NEAR_PX = 40;
const BLOCKS = "p, li, pre, tr, h1, h2, h3, h4, h5, h6, blockquote, [data-item]";
const TURN_MS = 300;
// Earlier items load while the top of the list is less than this many screens away, and so does a gap's next part.
const LOAD_SCREENS = 1.5;
// A change of size this soon after a touch on the list comes from the touch: the touched item keeps its place.
const TOUCH_MS = 600;
// The user's scroll ends once no finger is on the list and it has not scrolled for this long.
const REST_MS = 150;
const gapBelow = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const fingersOn = (el: Element | null, touches: TouchList) => [...touches].filter((t) => el?.contains(t.target as Node)).length;
// A viewer an item opens over the page through a portal (a photo, a sent file) hands its React events up through the
// item; its touches, wheel and keys are not the list's.
const inList = (e: React.SyntheticEvent) => e.currentTarget.contains(e.target as Node);
// An ended session's conversation ends with the notes of messages Claude Code never took in; what its transcript gains
// later comes in before them.
const lastSaid = (items: DisplayItem[]) => items.findLast((i) => i.kind !== "note" || i.code !== "unsent")?.id;

function caretAt(x: number, y: number): { node: Node; offset: number } | undefined {
  const r = document.caretRangeFromPoint?.(x, y);
  if (r) return { node: r.startContainer, offset: r.startOffset };
  const p = document.caretPositionFromPoint?.(x, y);
  return p ? { node: p.offsetNode, offset: p.offset } : undefined;
}

// The top of a text node's character at offset, or of the first one after it that is not a space, whose box keeps to
// its line where the line wraps; undefined for a node that is not text.
function charTop(node: Node, offset: number): number | undefined {
  const text = node.nodeType === Node.TEXT_NODE ? (node.textContent ?? "") : "";
  if (!text) return undefined;
  let at = Math.max(0, Math.min(offset, text.length - 1));
  while (at < text.length - 1 && /\s/.test(text[at])) at++;
  const r = document.createRange();
  r.setStart(node, at);
  r.setEnd(node, at + 1);
  const box = r.getBoundingClientRect();
  return box.height ? box.top : undefined;
}
const FLASH_MS = 2500;
const NO_MODELS: ModelOption[] = [];
// How long a command sent from here may take before its sheet says it gave no result, once the session is idle.
const RESULT_LATE_MS = 15_000;
const RESUME_WAIT_MS = 60_000;
type SheetName = "agents" | "changes" | "context" | "contextUsage" | "export" | "mcp" | "outputStyle" | "rewind" | "usage";
// A smooth scroll of the list under way: where it last stood, since when, and whether it has moved yet.
interface Motion {
  at: number;
  top: number;
  moved: boolean;
}
// Whether a smooth scroll looked at now has ended, taking in where the list stands.
function motionEnded(m: Motion, top: number, now: number): boolean {
  if (Math.abs(top - m.top) > 0.5) {
    Object.assign(m, { top, at: now, moved: true });
    return false;
  }
  return now - m.at >= (m.moved ? GLIDE_REST_MS : GLIDE_START_MS);
}
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
        data-jump
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
  const [sheet, setSheet] = useLayerState<SheetName>("chat");
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
  // A smooth scroll to the bottom (the jump button, a tap's way down) until it lands or a touch stops it where it is. One
  // under way (gliding) is never started again, and nothing else writes the list's position on the way, which would stop
  // it: no part goes in, and what came on the way is taken once it has ended.
  const glide = useRef(false);
  const gliding = useRef<Motion | null>(null);
  const glideTimer = useRef<number | undefined>(undefined);
  // The way up to the top of what the list holds, for a tap on the status bar, in the same way: a part that loads on the
  // way waits until the list has stopped at the top; a touch stops it as it does a glide.
  const rising = useRef<Motion | null>(null);
  const riseTimer = useRef<number | undefined>(undefined);
  // The distance from the end a part put in before the list keeps, taken as it goes in.
  const joining = useRef<number | null>(null);
  // The items in view and those above them, the top one first, each with how far its top is below the list's top: any
  // other change keeps the first of them still in the list where it was.
  const anchors = useRef<{ id: string; top: number }[]>([]);
  // A character of the text at the list's top (offset -1: the block there) and how far it is below the list's top. A
  // change of the list's width keeps it there; until the width settles (turning) it is not taken again.
  const mark = useRef<{ node: Node; offset: number; top: number } | null>(null);
  const width = useRef(0);
  const turning = useRef(false);
  const turnTimer = useRef<number | undefined>(undefined);
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
  const movedAt = useRef(0);
  // When the touch on the list began and ended, where the list stood as it began (a finger that has not moved it since
  // is resting on it), the moment it has held the list (HOLD_MS), and the list's position when its speed was last
  // looked at. fresh: no finger is on the list, so the next touch begins anew, also one that stops a fling.
  const fresh = useRef(true);
  const touchAt = useRef(0);
  const touchTop = useRef(0);
  const liftAt = useRef(0);
  const holdTimer = useRef<number | undefined>(undefined);
  const seenAt = useRef({ at: 0, top: 0 });
  // Whether the list was at its bottom when a finger or a selection began to hold it, or the user's scroll took it there.
  const paused = useRef(false);
  const frame = useRef(0);
  // While text in the list is selected the list follows nothing and keeps what is in view in place, as for a scroll.
  const reading = useRef(false);
  const [away, setAway] = useState(false);
  const [unseen, setUnseen] = useState(false);
  // The gap below the list as last seen; what last moved it other than the user, and when the user last asked it to move.
  const seenGap = useRef(0);
  const shownCount = useRef(0);
  const movedBy = useRef<{ why: string; at: number } | null>(null);
  const askedAt = useRef(0);
  // Where the list stood at the last frame looked at, for the record of a move it made by itself.
  const placed = useRef<{ id?: string; top: number; scroll: number; height: number; gap: number; items: number; flags: string } | null>(null);
  const look = useRef(0);

  const movedFor = (why: string) => {
    movedBy.current = { why, at: performance.now() };
  };
  // Keeping to the bottom and following what comes hold only for a list last seen near its bottom, or just asked to go
  // there (a message sent, the jump button).
  const nearEnd = () => seenGap.current < NEAR_BOTTOM_PX || performance.now() - askedAt.current < ASKED_MS;

  const firstRow = (): HTMLElement | undefined => {
    const el = listRef.current;
    const rows = [...(contentRef.current?.children ?? [])].filter((r): r is HTMLElement => r instanceof HTMLElement && r.dataset.item !== undefined);
    if (!el) return undefined;
    const top = el.getBoundingClientRect().top;
    let lo = 0;
    let hi = rows.length - 1;
    let found: HTMLElement | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].getBoundingClientRect().bottom > top) {
        found = rows[mid];
        hi = mid - 1;
      } else lo = mid + 1;
    }
    return found;
  };

  // What is in view moving more than a screen from one frame to the next by nothing the user did or asked for (their
  // scroll, the jump button, a tap on the status bar, a message sent) goes to the broker's log, with what moved it, its
  // place and size before and after and what happened lately. Following what comes at the end is no such move.
  const watchMove = () => {
    const el = listRef.current;
    if (!el?.clientHeight) return;
    const box = el.getBoundingClientRect();
    const row = firstRow();
    const flag = (k: string, on: boolean) => (on ? k : "");
    const flags = [flag("pinned", pinned.current), flag("stick", stick.current), flag("glide", glide.current), flag("rise", Boolean(rising.current)), flag("scroll", scrolling.current), flag("finger", fingers.current > 0), flag("select", reading.current)];
    const was = placed.current;
    const now = { id: row?.dataset.item, top: row ? row.getBoundingClientRect().top - box.top : 0, scroll: el.scrollTop, height: el.scrollHeight, gap: gapBelow(el), items: shownCount.current, flags: flags.filter(Boolean).join(" ") };
    placed.current = now;
    const at = performance.now();
    const by = movedBy.current && at - movedBy.current.at < 1000 ? movedBy.current.why : undefined;
    if (!was || turning.current || rising.current || glide.current || at - askedAt.current < ASKED_MS || (scrolling.current && scrolled.current)) return;
    if (was.gap < NEAR_BOTTOM_PX && now.gap < NEAR_BOTTOM_PX) return;
    const same = was.id ? el.querySelector<HTMLElement>(`[data-item="${CSS.escape(was.id)}"]`) : null;
    const toEnd = same ? was.top - (same.getBoundingClientRect().top - box.top) : was.gap - now.gap;
    if (Math.abs(toEnd) <= el.clientHeight) return;
    listMoved({
      why: by ?? (now.height < was.height - el.clientHeight ? "shrink" : "browser"),
      moved: Math.round(toEnd),
      top: [Math.round(was.scroll), Math.round(now.scroll)],
      height: [Math.round(was.height), Math.round(now.height)],
      items: [was.items, now.items],
      view: Math.round(el.clientHeight),
      flags: was.flags,
      trail: trail(),
    });
  };
  const lookSoon = () => {
    look.current ||= requestAnimationFrame(() => {
      look.current = 0;
      watchMove();
    });
  };

  // The list follows new content while it sticks to the bottom; the jump button shows while it does not.
  const follow = (on: boolean) => {
    stick.current = on;
    setAway(!on);
    if (on) setUnseen(false);
  };

  // New content the list does not follow shows on the jump button, what comes while text is selected too.
  const unfollowed = () => {
    setUnseen(true);
    if (!stick.current) return;
    owed.current.follow = true;
    setAway(true);
  };

  const holding = () => fingers.current > 0 && performance.now() - touchAt.current >= HOLD_MS;
  const shownHeld = () => {
    setAway(true);
    setUnseen(true);
  };

  // Once a finger or a selection lets go of the list: at its bottom it follows again, and unless it was held (free) it
  // glides down to what came meanwhile while the way is short; else it stays, follows no more, and the jump button marks
  // what came. held: a change of size waited too.
  const resume = (held = false, free = false) => {
    const el = listRef.current;
    if (!el) return;
    const gap = gapBelow(el);
    if (glide.current || gap < PIN_PX || (free && paused.current && gap < el.clientHeight * FOLLOW_SHARE)) {
      glide.current = gap >= PIN_PX && !reduced();
      follow(true);
      toBottom("resume");
      return;
    }
    pinned.current = false;
    follow(false);
    setUnseen(true);
    if (held) hold();
  };

  // A new snapshot holds none of the items read: the list keeps the distance from its end it had before (before), at
  // most up to the top of what it holds now, and says so.
  const lost = (before: number) => {
    const el = listRef.current;
    if (!el) return;
    const top = Math.max(0, el.scrollHeight - el.clientHeight - before);
    if (Math.abs(el.scrollTop - top) > 0.5) {
      movedFor("lost");
      el.scrollTop = top;
    }
    note("lost");
    lastTop.current = el.scrollTop;
    pinned.current = gapBelow(el) < PIN_PX;
    follow(pinned.current);
    takeAnchor();
    toast(t("대화가 바뀌었습니다"));
  };

  const browserAnchors = () => {
    const el = listRef.current;
    if (anchoring.current === undefined && el) anchoring.current = CSS.supports("overflow-anchor", "auto") && getComputedStyle(el).overflowAnchor !== "none";
    return Boolean(anchoring.current);
  };

  // A touched row alone, else the rows in view and above them.
  const takeAnchor = (row?: HTMLElement | null) => {
    const el = listRef.current;
    if (!el?.clientHeight) return;
    const box = el.getBoundingClientRect();
    const at = (r: HTMLElement) => ({ id: r.dataset.item!, top: r.getBoundingClientRect().top - box.top });
    if (row?.dataset.item) {
      anchors.current = [at(row)];
      return;
    }
    const rows = [...(contentRef.current?.children ?? [])].filter((r): r is HTMLElement => r instanceof HTMLElement && r.dataset.item !== undefined);
    let first = rows.length;
    let lo = 0;
    let hi = rows.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].getBoundingClientRect().bottom > box.top) {
        first = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    const shown = rows.slice(first, first + ANCHORS_IN_VIEW).filter((r, n) => n === 0 || r.getBoundingClientRect().top < box.bottom);
    anchors.current = [...shown, ...rows.slice(Math.max(0, first - ANCHORS_ABOVE), first).reverse()].map(at);
    if (!turning.current) takeMark();
  };

  // False when none of the anchored items is in the list. Where the browser keeps the view in place itself, only a part
  // put in before the item in view, a new snapshot or what a touch opened (force) is set right here. During the user's
  // scroll nothing is, but for a finger resting on the list (still), whose scroll view goes on from where it holds it.
  // Else the place is written as a position: iOS adds a scroll by to wherever its own scroll view stands then.
  const keepAnchor = (force = false, still = false): boolean => {
    const el = listRef.current;
    const top = anchorTop();
    if (!el || top === undefined) return false;
    if ((scrolling.current && !still) || (!force && browserAnchors())) return true;
    const moved = top - el.scrollTop;
    if (Math.abs(moved) > 0.5) {
      movedFor("keep");
      note("keep", moved);
      if (still) el.scrollBy(0, moved);
      else el.scrollTop = top;
    }
    lastTop.current = el.scrollTop;
    return true;
  };

  // Where the list stands with the first anchored item still in it where it was; undefined when none is.
  const anchorTop = (): number | undefined => {
    const el = listRef.current;
    if (!el) return undefined;
    for (const a of anchors.current) {
      const row = el.querySelector<HTMLElement>(`[data-item="${CSS.escape(a.id)}"]`);
      if (row) return el.scrollTop + row.getBoundingClientRect().top - el.getBoundingClientRect().top - a.top;
    }
    return undefined;
  };

  // The character marked stays while its line is near the list's top, so a width that changes and comes back keeps the
  // same text there.
  const takeMark = () => {
    const el = listRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const box = el.getBoundingClientRect();
    const x = content.getBoundingClientRect().left + MARK_X_PX;
    const y = box.top + MARK_Y_PX;
    const m = mark.current;
    const still = m && m.offset >= 0 && m.node.isConnected && content.contains(m.node) ? charTop(m.node, m.offset) : undefined;
    if (m && still !== undefined && Math.abs(still - y) < MARK_NEAR_PX) {
      mark.current = { ...m, top: still - box.top };
      return;
    }
    const caret = caretAt(x, y);
    if (caret && content.contains(caret.node)) {
      const top = charTop(caret.node, caret.offset);
      if (top !== undefined && Math.abs(top - y) < MARK_NEAR_PX) {
        mark.current = { ...caret, top: top - box.top };
        return;
      }
    }
    const block = document.elementFromPoint(x, y)?.closest(BLOCKS);
    mark.current = block && content.contains(block) ? { node: block, offset: -1, top: block.getBoundingClientRect().top - box.top } : null;
  };

  // Puts the text read at the list's top back where it was; false when it has left the list.
  const keepMark = (): boolean => {
    const el = listRef.current;
    const m = mark.current;
    if (!el || !m?.node.isConnected || !contentRef.current?.contains(m.node)) return false;
    const now = m.offset < 0 ? (m.node as Element).getBoundingClientRect().top : charTop(m.node, m.offset);
    if (now === undefined) return false;
    const moved = now - el.getBoundingClientRect().top - m.top;
    if (Math.abs(moved) > 0.5) {
      movedFor("mark");
      el.scrollTop = el.scrollTop + moved;
    }
    lastTop.current = el.scrollTop;
    return true;
  };

  // why: what moves the list there, for the record of the bottom reached unasked.
  const toBottom = (why: string) => {
    const el = listRef.current;
    if (!el) return;
    if (glide.current) return glideDown();
    if (gapBelow(el) > 0.5) {
      movedFor(why);
      el.scrollTop = el.scrollHeight;
    }
    lastTop.current = el.scrollTop;
    pinned.current = true;
  };

  // Starts the smooth scroll to the bottom unless one is under way.
  const glideDown = () => {
    const el = listRef.current;
    if (!el || gliding.current) return;
    if (gapBelow(el) < PIN_PX) return landed();
    gliding.current = { at: performance.now(), top: el.scrollTop, moved: false };
    movedFor("glide");
    note("glide");
    glideTo(el, el.scrollHeight);
    clearTimeout(glideTimer.current);
    glideTimer.current = window.setTimeout(glided, GLIDE_CHECK_MS);
  };

  // Once the smooth scroll has ended, a bottom that grew on the way is taken at once.
  const glided = () => {
    const el = listRef.current;
    const g = gliding.current;
    if (!el || !g || !glide.current) return;
    if (motionEnded(g, el.scrollTop, performance.now())) {
      gliding.current = null;
      glide.current = false;
      toBottom("glide");
      return landed();
    }
    glideTimer.current = window.setTimeout(glided, GLIDE_CHECK_MS);
  };

  // The way down has reached the bottom: the list follows from there, and a part that loaded on the way goes in.
  const landed = () => {
    glide.current = false;
    gliding.current = null;
    clearTimeout(glideTimer.current);
    pinned.current = true;
    follow(true);
    note("land");
    joinWaiting();
  };

  // After any change of size: the bottom while the list is pinned there, else the item in view where it was, or while
  // its width settles the text read at its top; a part put in before the item in view (force) keeps that item where it
  // was even at the bottom. A list with no height shows nothing to hold; one on its way up holds once it has stopped.
  const hold = (force = false) => {
    const el = listRef.current;
    if (!el?.clientHeight || turned()) return;
    catchUp();
    if (rising.current) {
      owed.current.hold = true;
      return;
    }
    if (scrolling.current) {
      owed.current.hold = true;
      if (fingers.current && Math.abs(el.scrollTop - touchTop.current) < 0.5 && keepAnchor(false, true)) touchTop.current = el.scrollTop;
      return;
    }
    const tapped = performance.now() - touched.current <= TOUCH_MS;
    if (!force && (glide.current || (pinned.current && nearEnd() && !tapped && !reading.current))) toBottom("hold");
    else {
      if (!(turning.current && keepMark())) keepAnchor(force || tapped);
      if (!reading.current) pinned.current = gapBelow(el) < PIN_PX;
    }
  };

  // A message the user sends unselects text in the list, so the list follows it.
  const unread = () => {
    if (selectedIn(contentRef.current)) document.getSelection()?.removeAllRanges();
    reading.current = false;
  };

  // What the user asks from elsewhere (the jump button, a search hit, the agent map) takes over from their scroll,
  // touch and selection on the list. A part loaded for that scroll is dropped; it loads again if the new place nears it.
  const stopScroll = () => {
    clearTimeout(restTimer.current);
    scrolling.current = false;
    owed.current = {};
    touched.current = 0;
    rising.current = null;
    clearTimeout(riseTimer.current);
    unread();
    dropParked(sessionId);
  };

  const jump = () => {
    if (!listRef.current || performance.now() - movedAt.current < JUMP_GUARD_MS) return;
    stopScroll();
    askedAt.current = performance.now();
    note("jump");
    glide.current = !reduced();
    follow(true);
    toBottom("jump");
  };

  const endGlide = () => {
    const el = listRef.current;
    if (!(glide.current || rising.current) || !el) return;
    glide.current = false;
    gliding.current = null;
    clearTimeout(glideTimer.current);
    rising.current = null;
    clearTimeout(riseTimer.current);
    el.scrollTo({ top: el.scrollTop });
  };

  // The way up has stopped, at the top or short of it (a bottom that moved): what waited goes in from there, and the
  // next part starts to load.
  const arrived = () => {
    rising.current = null;
    clearTimeout(riseTimer.current);
    note("arrive");
    if (owed.current.hold) {
      owed.current.hold = false;
      hold();
    }
    if (!joinWaiting()) loadParts(true);
  };

  const risen = () => {
    const el = listRef.current;
    const r = rising.current;
    if (!el || !r) return;
    if (motionEnded(r, el.scrollTop, performance.now())) return arrived();
    riseTimer.current = window.setTimeout(risen, GLIDE_CHECK_MS);
  };

  const rise = () => {
    const el = listRef.current;
    if (!el || el.scrollTop < 1 || scrolling.current || rising.current) return;
    glide.current = false;
    gliding.current = null;
    clearTimeout(glideTimer.current);
    rising.current = { at: performance.now(), top: el.scrollTop, moved: false };
    pinned.current = false;
    follow(false);
    note("rise");
    movedFor("rise");
    glideTop(el);
    clearTimeout(riseTimer.current);
    riseTimer.current = window.setTimeout(risen, GLIDE_CHECK_MS);
  };
  useToTop(rise);

  // A touch or key on an item keeps that item in place while what it opens changes the list.
  const touch = (e: React.SyntheticEvent) => {
    touched.current = performance.now();
    takeAnchor((e.target as HTMLElement).closest<HTMLElement>("[data-item]"));
  };

  // A loaded part goes in only while the list rests, from where the user is reading then, even at the bottom; not while
  // the user scrolls it or a smooth scroll of its own runs.
  const canJoin = () => {
    const el = listRef.current;
    if (!el || scrolling.current || rising.current || glide.current) return false;
    catchUp();
    takeAnchor();
    joining.current = gapBelow(el);
    note("join");
    return true;
  };

  // Puts in the part that loaded while the list could not take it, from where the user is reading now; false when none
  // waits.
  const joinWaiting = (): boolean => {
    const el = listRef.current;
    if (!el) return false;
    catchUp();
    takeAnchor();
    joining.current = gapBelow(el);
    if (joinParked(sessionId)) {
      note("join");
      return true;
    }
    joining.current = null;
    return false;
  };

  // A part put in before the list keeps the item read where it was, from where it was taken as the part went in. Nothing
  // after the part changes but a date line that moves up, so the distance from the end (gap) stays within a screen; a
  // place further off than that comes from items read elsewhere, and the distance from the end is kept instead.
  const keepJoin = (gap: number) => {
    const el = listRef.current;
    if (!el?.clientHeight) return;
    catchUp();
    const byEnd = Math.max(0, el.scrollHeight - el.clientHeight - gap);
    const byItem = anchorTop();
    const top = byItem !== undefined && Math.abs(byItem - byEnd) <= el.clientHeight ? byItem : byEnd;
    if (Math.abs(el.scrollTop - top) > 0.5) {
      movedFor("join");
      note(top === byEnd && byItem !== undefined && Math.abs(byItem - byEnd) > 0.5 ? "join-end" : "join-keep", top - el.scrollTop);
      el.scrollTop = top;
    }
    lastTop.current = el.scrollTop;
    if (!reading.current) pinned.current = gapBelow(el) < PIN_PX;
    takeAnchor();
  };

  // Loads the part before the list, or the next one of its gap, as it nears the view. retry: the part before the list
  // after it failed too.
  const loadParts = (retry: boolean) => {
    const el = listRef.current;
    const c = getState().chat;
    if (!el || glide.current || rising.current || c?.sessionId !== sessionId || !c.loaded || c.loading) return;
    if (c.hasMore && (retry || !c.failed) && el.scrollTop < el.clientHeight * LOAD_SCREENS) void loadMore(sessionId, "earlier", canJoin);
    else if (c.gap && !c.failed) nearGap(el);
  };

  // What a scroll changes: whether the list is at or near the bottom (not on a way up to the top, which has left it even in
  // its first frames there), the item in view, the parts to load. It is looked at once per frame of scrolling, after the
  // browser's scroll events.
  const seen = () => {
    const el = listRef.current;
    if (!el || turned()) return;
    const gap = gapBelow(el);
    const up = el.scrollTop < lastTop.current - 0.5;
    const now = performance.now();
    const dt = now - seenAt.current.at;
    if (dt >= SPEED_MS) {
      if (scrolling.current && Math.abs(el.scrollTop - seenAt.current.top) > FLING_PX_MS * dt) movedAt.current = now;
      seenAt.current = { at: now, top: el.scrollTop };
    }
    lastTop.current = el.scrollTop;
    if (!rising.current) {
      pinned.current = gap < PIN_PX || (pinned.current && !up);
      if (scrolling.current && pinned.current) paused.current = true;
      const near = gap < PIN_PX || (stick.current && (gap < NEAR_BOTTOM_PX || !up));
      if (near !== stick.current && (near || !glide.current)) follow(near);
      else if (reading.current && gap < PIN_PX) follow(true);
    }
    if (!scrolling.current && (!pinned.current || reading.current)) takeAnchor();
    loadParts(true);
    seenGap.current = gap;
  };

  // A scroll whose event is still to come is looked at before anything here acts, so nothing undoes it.
  const catchUp = () => {
    const el = listRef.current;
    if (el && Math.abs(el.scrollTop - lastTop.current) > 0.5) seen();
  };

  // The user's scroll has ended: what waited for it happens now, from where they stopped.
  const settle = () => {
    clearTimeout(restTimer.current);
    clearTimeout(holdTimer.current);
    if (!scrolling.current) return;
    scrolling.current = false;
    note("rest");
    if (scrolled.current) takeAnchor();
    const { follow: news, hold: held } = owed.current;
    owed.current = {};
    const grew = held && pinned.current && performance.now() - touched.current > TOUCH_MS;
    const free = liftAt.current - touchAt.current < HOLD_MS;
    if ((news || grew) && (glide.current || (stick.current && !reading.current))) resume(held, free);
    else {
      if (news) unfollowed();
      if (held) hold();
    }
    if (!joinWaiting()) loadParts(false);
  };

  // Text selected in the list holds it from where it is. Once nothing there is selected, the list follows again from
  // the bottom it was at, ahead of the tap that unselected it, and leaves what came meanwhile to the jump button
  // (resume); during the user's scroll, that waits for the rest.
  const selected = () => {
    const now = Boolean(selectedIn(contentRef.current));
    if (now === reading.current) return;
    reading.current = now;
    note(now ? "select" : "unselect");
    if (scrolling.current) return;
    if (now) {
      paused.current = pinned.current;
      return takeAnchor();
    }
    const news = owed.current.follow;
    owed.current = {};
    if (!stick.current || !(news || pinned.current)) return;
    touched.current = 0;
    resume();
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

  const startScroll = (touch = false) => {
    if (!scrolling.current) {
      scrolled.current = false;
      paused.current = pinned.current;
    }
    if (!scrolling.current || (touch && fresh.current)) {
      touchAt.current = performance.now();
      touchTop.current = listRef.current?.scrollTop ?? 0;
      note("touch");
      clearTimeout(holdTimer.current);
      holdTimer.current = window.setTimeout(() => holding() && owed.current.follow && shownHeld(), HOLD_MS);
    }
    if (touch) fresh.current = false;
    scrolling.current = true;
    restSoon();
  };

  // touchend reaches the element the touch began on even once it has left the list, so it is heard there.
  const lifted = useRef((e: Event) => {
    const el = listRef.current;
    fingers.current = fingersOn(el, (e as TouchEvent).touches);
    if (fingers.current) return;
    fresh.current = true;
    liftAt.current = performance.now();
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
    unread();
    askedAt.current = performance.now();
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
    const ok = sendMessage(sessionId, text, attachments);
    if (ok) {
      unread();
      askedAt.current = performance.now();
      follow(true);
    }
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
    askedAt.current = performance.now();
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

  // Only a message, request or reply added at the end is new: it scrolls into view near the bottom unless a finger holds
  // the list, and is marked away from it. Any other change keeps the list pinned at the bottom, else the item in view in
  // place. A new snapshot goes by where the list was before it, since the change of height it makes can move the list.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || !chat?.loaded) return;
    shownCount.current = items.length;
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
    const gap = joining.current;
    joining.current = null;
    if (chat.focus) return;
    lookSoon();
    if (was && was.snaps !== now.snaps) {
      const before = seenGap.current;
      // A snapshot places the list now: a way up stops where it is.
      if (rising.current) endGlide();
      if (scrolling.current) {
        if (keepAnchor(true)) owed.current.hold = true;
        else lost(before);
      } else if (glide.current || (pinned.current && nearEnd() && !reading.current)) {
        toBottom("snapshot");
        follow(true);
      } else if (!keepAnchor(true)) lost(before);
      loadParts(false);
      return;
    }
    catchUp();
    if (!was) {
      askedAt.current = performance.now();
      note("open");
      toBottom("open");
      follow(true);
    } else {
      const came = (id?: string, before?: string) => id !== before && (before === undefined || items.some((i) => i.id === before));
      const added =
        came(now.last, was.last) ||
        came(now.said, was.said) ||
        now.stream > was.stream ||
        now.pending > was.pending ||
        now.queued > was.queued;
      if (added) note("end");
      if (added && (glide.current || (stick.current && nearEnd() && !reading.current))) {
        if (!scrolling.current) toBottom("follow");
        else {
          owed.current.follow = true;
          if (holding()) shownHeld();
        }
      } else {
        if (added) unfollowed();
        if (now.first !== was.first && gap !== null && !added && !rising.current) keepJoin(gap);
        else hold(now.first !== was.first || now.gap !== was.gap);
      }
    }
    loadParts(false);
  });

  // The list's width changed, as on a rotation: the text read at its top stays there at each step and once more when the
  // width has settled; the item in view stands in for text that left the list.
  const reflowed = () => {
    const el = listRef.current;
    if (!el?.clientHeight) return;
    turning.current = true;
    clearTimeout(turnTimer.current);
    turnTimer.current = window.setTimeout(() => {
      turning.current = false;
      if (!scrolling.current && !glide.current && !pinned.current) keepMark();
      takeAnchor();
    }, TURN_MS);
    catchUp();
    if (scrolling.current) owed.current.hold = true;
    else if (glide.current || (pinned.current && nearEnd() && !reading.current)) toBottom("turn");
    else if (!keepMark()) keepAnchor(true);
  };

  // A new width is a turn whichever meets it first: the observer, or a render or scroll handled before the observer
  // reports it, while the places held are still the old width's. True when it was one.
  const turned = (): boolean => {
    const w = listRef.current?.clientWidth ?? 0;
    const was = width.current;
    width.current = w;
    if (!(was > 0 && w > 0 && w !== was)) return false;
    reflowed();
    return true;
  };

  // A change of the list's size (a taller composer or to-do panel) or of what it holds that no render made (an image
  // that loaded, an item opened) is held the same way.
  useEffect(() => {
    const resized = new ResizeObserver(() => {
      if (!turned()) hold();
      lookSoon();
    });
    resized.observe(listRef.current!);
    resized.observe(contentRef.current!);
    const hidden = () => {
      if (document.visibilityState !== "hidden") return;
      fingers.current = 0;
      settleNow.current();
    };
    document.addEventListener("visibilitychange", hidden);
    document.addEventListener("selectionchange", selected);
    // A snapshot sent again keeps what the list reads, unless it shows the end of the conversation.
    const unregister = onReading(() => {
      const el = listRef.current;
      if (!el?.clientHeight || glide.current || ((pinned.current || gapBelow(el) < PIN_PX) && !reading.current)) return undefined;
      takeAnchor();
      return anchors.current.map((a) => a.id);
    });
    return () => {
      resized.disconnect();
      unregister();
      document.removeEventListener("visibilitychange", hidden);
      document.removeEventListener("selectionchange", selected);
      cancelAnimationFrame(frame.current);
      cancelAnimationFrame(look.current);
      clearTimeout(restTimer.current);
      clearTimeout(turnTimer.current);
      clearTimeout(riseTimer.current);
      clearTimeout(glideTimer.current);
      clearTimeout(holdTimer.current);
    };
  }, []);

  const focus = chat?.loaded ? chat.focus : undefined;
  const focusEarlier = chat?.focusEarlier;
  useLayoutEffect(() => {
    if (!focus) return;
    focusDone(sessionId);
    const el = listRef.current?.querySelector(`[data-item="${CSS.escape(focus)}"]`);
    if (!el) {
      askedAt.current = performance.now();
      toBottom("focus");
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
          <button onClick={nav.back} aria-label={t("뒤로")} className="relative -m-1 rounded-lg p-3">
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

      {/* A pull from the top asks for the conversation again once all of it is here; until then the top loads the part before. */}
      <Pull box={listRef} refresh={refreshChat} on={Boolean(chat?.loaded && !chat.hasMore)} atTop>
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
              watchMove();
            });
          }}
          onPointerDown={(e) => {
            if (!inList(e)) return;
            endGlide();
            touch(e);
            if (e.pointerType === "touch") startScroll(true);
          }}
          onTouchStart={(e) => {
            if (!inList(e)) return;
            fingers.current = fingersOn(e.currentTarget, e.nativeEvent.touches);
            e.target.addEventListener("touchend", lifted);
            e.target.addEventListener("touchcancel", lifted);
            startScroll(true);
          }}
          onKeyDown={(e) => inList(e) && touch(e)}
          onWheel={(e) => {
            if (!inList(e)) return;
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
      </Pull>

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
                  void setUnread(sessionId, true).then((ok) => ok && nav.back());
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
              {cwd && (
                <div className="mb-1 flex min-h-11 items-center gap-1 pl-3" data-menu-cwd>
                  <span className="min-w-0 flex-1 text-xs break-all text-muted">{cwd}</span>
                  <CopyButton text={cwd} label={t("작업 폴더 경로 복사")} done={t("경로를 복사했습니다")} />
                </div>
              )}
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
      {file && <FileViewer sessionId={sessionId} cwd={cwd} target={file} onClose={() => setFile(null)} />}
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
