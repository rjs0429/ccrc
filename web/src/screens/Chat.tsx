import { Fragment, Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { commandName, dialogResult, isDialogCommand, parseCommand } from "../../../broker/src/dialog-commands.ts";
import type { DisplayItem, ModelOption, QueuedMessage } from "../../../broker/src/protocol.ts";
import { DateLine, ItemView, QueuedItem, StreamPreview, shownItems } from "../components/Items.tsx";
import { Composer } from "../components/Composer.tsx";
import { reattach } from "../components/composer/attachments.ts";
import { commandSheet } from "../components/commandSheets.ts";
import { PendingCard } from "../components/Pending.tsx";
import { ArchivedBadge, SessionActions, renameBlocked, setArchived } from "../components/SessionActions.tsx";
import { TodoPanel } from "../components/TodoPanel.tsx";
import { ChangesSheet } from "../components/sheets/Changes.tsx";
import { CommandResultSheet, StoppedSheet } from "../components/sheets/Command.tsx";
import { ContextSheet } from "../components/sheets/Context.tsx";
import { ContextUsageSheet } from "../components/sheets/ContextUsage.tsx";
import { McpSheet } from "../components/sheets/Mcp.tsx";
import { OutputStyleSheet, outputStyleLabel } from "../components/sheets/OutputStyle.tsx";
import { RewindSheet } from "../components/sheets/Rewind.tsx";
import { AgentMapSheet } from "../components/sheets/AgentMap.tsx";
import { agentMap } from "../components/agents/tree.ts";
import { ThreadSheet, type ShownThread } from "../components/sheets/Thread.tsx";
import { UsageSheet } from "../components/sheets/Usage.tsx";
import { Choice, Icon, Sheet, Spinner } from "../components/ui.tsx";
import { FileLinks, FileRoots } from "../components/fileLinks.ts";
import { dayLines, streamLine } from "../components/stamps.ts";
import type { FileTarget } from "../components/viewer/FileViewer.tsx";
import { baseName, closedText, errorText, hostLabel, sessionTitle, shortPath } from "../labels.ts";
import { api } from "../api.ts";
import { call, composerInsert, focusDone, navigate, openAt, openSettingsFrom, send, toast, useApp } from "../state.ts";
import { takeSent } from "../sentPreviews.ts";

const FileViewer = lazy(() => import("../components/viewer/FileViewer.tsx"));

const NEAR_BOTTOM_PX = 160;
const gapBelow = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight;
const FLASH_MS = 2500;
const NO_MODELS: ModelOption[] = [];
// How long a command sent from here may take before its sheet says it gave no result, once the session is idle.
const RESULT_LATE_MS = 15_000;
const RESUME_WAIT_MS = 60_000;
type SheetName = "agents" | "changes" | "context" | "contextUsage" | "mcp" | "outputStyle" | "rewind" | "usage";
type CommandItem = Extract<DisplayItem, { kind: "command" }>;
// A dialog command sent from here: its result shows in a sheet once a new result of that command arrives.
interface Awaited {
  title: string;
  name: string;
  before: Set<string>;
  late: boolean;
}

// Hangs from the top edge of the to-do panel and composer, so it floats just above them whatever their height.
function JumpButton({ unseen, onClick }: { unseen: boolean; onClick: () => void }) {
  return (
    <div className="relative h-0 tiny:hidden">
      <button
        onClick={onClick}
        onMouseDown={(e) => e.preventDefault()}
        aria-label="맨 아래로"
        className="group absolute bottom-2 left-1/2 z-10 flex size-11 -translate-x-1/2 items-center justify-center"
      >
        <span className="relative flex size-9 items-center justify-center rounded-full border border-line bg-surface text-fg shadow-md group-active:bg-surface-2">
          <Icon.arrowDown className="size-[18px]" />
          {unseen && <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-accent ring-2 ring-bg" title="새 내용이 있습니다" data-unseen />}
        </span>
      </button>
    </div>
  );
}

export function Chat({ sessionId }: { sessionId: string }) {
  const chat = useApp((s) => (s.chat?.sessionId === sessionId ? s.chat : undefined));
  const summary = useApp((s) => s.sessions?.find((x) => x.id === sessionId));
  const models = useApp((s) => s.options?.models ?? NO_MODELS);
  const othersWaiting = useApp((s) => (s.sessions ?? []).some((x) => x.id !== sessionId && x.pendingCount));
  // The ⋯ menu decides as it opens whether it offers 이번 턴 중지 and keeps that row while open, enabled while a turn
  // runs, so a turn starting or ending moves none of its rows.
  const [menu, setMenu] = useState<false | { stop: boolean }>(false);
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
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // A smooth scroll to the bottom from the jump button, until it lands or the user touches the list; a touch
  // stops it where it is, since browsers do not all cancel a smooth scroll for one.
  const glide = useRef(false);
  // The list's height when the user left the bottom: anything taller has arrived since.
  const seen = useRef(0);
  const [away, setAway] = useState(false);
  const [unseen, setUnseen] = useState(false);

  // The list follows new content while it sticks to the bottom; the jump button shows while it does not.
  const follow = (on: boolean) => {
    stick.current = on;
    setAway(!on);
    if (on) setUnseen(false);
    else seen.current = listRef.current?.scrollHeight ?? 0;
  };

  const jump = () => {
    const el = listRef.current;
    if (!el) return;
    glide.current = !matchMedia("(prefers-reduced-motion: reduce)").matches;
    follow(true);
    el.scrollTo({ top: el.scrollHeight, behavior: glide.current ? "smooth" : "auto" });
  };

  const endGlide = () => {
    const el = listRef.current;
    if (!glide.current || !el) return;
    glide.current = false;
    el.scrollTo({ top: el.scrollTop });
  };

  const st = chat?.state;
  const kind = st?.state ?? summary?.state ?? "inactive";
  const controllable = kind === "owned" || kind === "attached";
  const deferred = kind === "inactive";
  const folderMissing = deferred && Boolean(st ? st.folderMissing : summary?.folderMissing);
  const host = hostLabel(st?.host ?? summary?.host);
  const busy = Boolean(st?.busy);
  const cwd = st?.cwd ?? summary?.cwd ?? "";
  const cannotStart = folderMissing ? `작업 폴더가 없어 이 세션을 시작할 수 없습니다: ${shortPath(cwd)}` : undefined;
  // The list knows first of a name given anywhere: it reads the transcript.
  const named = summary?.title || st?.title || "";
  const title = sessionTitle({ title: named });
  const archived = Boolean(summary?.archived);
  const renameTarget = { id: sessionId, title: named, state: kind, host: st?.host ?? summary?.host, archived };
  const renameRefused = renameBlocked(renameTarget);
  // The header's title and the line under it are one button to rename, its padding reaching over the header's height
  // as the back button's does. The sheet opens within the tap, so its field can take the keyboard on iOS.
  const rename = () => {
    if (renameRefused) return toast(renameRefused);
    flushSync(() => {
      setMenu(false);
      setRenaming(true);
    });
  };
  const items = useMemo(() => shownItems(chat?.items ?? []), [chat?.items]);
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
  const [taking, setTaking] = useState<string | null>(null);
  // A message taken back returns to the composer with its text and the photos sent from this device.
  const takeBack = (q: QueuedMessage) => {
    if (taking) return;
    setTaking(q.id);
    call(sessionId, "unqueue", { messageId: q.id })
      .then(() => {
        if (q.text) composerInsert(q.text);
        const lost = reattach(sessionId, q.attachments ?? [], takeSent(q.id));
        if (lost) toast(`첨부 ${lost}개는 다시 골라 주세요`);
      })
      .catch((e: Error) => toast(errorText(e.message)))
      .finally(() => setTaking(null));
  };

  const stop = () => send({ t: "interrupt", sessionId });

  const sendText = (text: string, attachments: string[] = []) => {
    const c = attachments.length ? undefined : parseCommand(text);
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

  const agentChip = useMemo(
    () => agentMap({ tasks: st?.tasks, items: chat?.items ?? [], pending: chat?.pending ?? [], busy }).chip,
    [st?.tasks, chat?.items, chat?.pending, busy],
  );

  // The subagent a permission request comes from, by its task or as an agent of a workflow.
  const askingAgent = (agentId?: string) => {
    if (!agentId) return undefined;
    const t = st?.tasks?.find((x) => x.id === agentId);
    if (t) return t.description || t.agentType ? `서브에이전트 · ${t.description || t.agentType}` : "서브에이전트";
    const w = st?.tasks?.flatMap((x) => x.workflow?.agents ?? []).find((a) => a.id === agentId);
    return w ? `워크플로 에이전트 · ${w.label}` : "서브에이전트";
  };

  // Closes the map and shows a conversation item, fetching the part around it when it is not loaded.
  const jumpTo = (itemId: string) => {
    setSheet(null);
    const el = listRef.current?.querySelector(`[data-item="${CSS.escape(itemId)}"]`);
    if (!el) return openAt(sessionId, itemId);
    el.scrollIntoView({ block: "center" });
    follow(gapBelow(listRef.current!) < NEAR_BOTTOM_PX);
    setFlash(itemId);
  };

  const jumpToRequest = (requestId: string) => {
    setSheet(null);
    const el = listRef.current?.querySelector(`[data-pending="${CSS.escape(requestId)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    follow(gapBelow(listRef.current!) < NEAR_BOTTOM_PX);
    setFlash(requestId);
  };

  const openFile = useCallback((href: string) => {
    if (!href.startsWith("#")) setFile({ href });
  }, []);
  const roots = useMemo(() => (cwd ? [cwd] : []), [cwd]);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (!stick.current) {
      if (el.scrollHeight > seen.current) setUnseen(true);
    } else if (glide.current) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
  }, [chat?.items, chat?.stream?.text, chat?.pending.length, chat?.loaded, queued.length]);

  // Resizing the list (rotation, a taller composer or to-do panel) keeps it at the bottom while it follows.
  useEffect(() => {
    const el = listRef.current!;
    const resized = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    resized.observe(el);
    return () => resized.disconnect();
  }, []);

  const focus = chat?.loaded ? chat.focus : undefined;
  const focusEarlier = chat?.focusEarlier;
  useLayoutEffect(() => {
    if (!focus) return;
    focusDone(sessionId);
    const el = listRef.current?.querySelector(`[data-item="${CSS.escape(focus)}"]`);
    if (!el) {
      api.thread(sessionId, focus).then(
        (t) => setThread({ ...t, ...(focusEarlier ? { earlier: true } : {}) }),
        () => toast("찾은 메시지가 지금 대화에 없습니다"),
      );
      return;
    }
    el.scrollIntoView({ block: "center" });
    follow(gapBelow(listRef.current!) < NEAR_BOTTOM_PX);
    setFlash(focus);
  }, [focus, focusEarlier, sessionId]);

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash]);

  const status =
    kind === "owned"
      ? busy
        ? "작업 중"
        : "원격 실행 중"
      : kind === "attached"
        ? busy
          ? `${host}에서 작업 중`
          : `${host} 연결됨`
        : kind === "live"
          ? `${host}에서 열림`
          : folderMissing
            ? "폴더 없음"
            : "꺼져 있음";
  const disabledReason =
    kind === "live" ? `${host}에서 열려 있어 지금은 보기만 할 수 있습니다.` : folderMissing ? "작업 폴더가 없어 보기만 할 수 있습니다." : undefined;

  return (
    <div className="flex h-dvh flex-col">
      <header className="pt-safe border-b border-line bg-bg">
        <div className="flex items-center gap-1 px-safe-2 py-2 short:py-0.5">
          <button onClick={() => navigate({ name: "home" })} aria-label="뒤로" className="relative -m-1 rounded-lg p-3">
            <Icon.back />
            {othersWaiting && <span className="absolute top-2.5 right-2.5 size-2 rounded-full bg-warn" title="다른 세션에서 입력이 필요합니다" />}
          </button>
          <button
            onClick={rename}
            aria-haspopup="dialog"
            title="이름 바꾸기"
            className="-my-2 flex min-w-0 flex-1 items-center self-stretch py-2 text-left short:-my-1 short:py-1"
          >
            <span className="min-w-0 flex-1 short:flex short:items-baseline short:gap-2">
              <span className="block truncate text-[15px] font-semibold short:max-w-[60%] short:shrink-0" data-chat-title>
                {title}
              </span>
              <span className="flex min-w-0 items-baseline gap-1.5 text-xs text-muted">
                {archived && <ArchivedBadge />}
                <span className="truncate">
                  {baseName(cwd)}
                  {summary?.branch && summary.branch !== "HEAD" ? ` · ${summary.branch}` : ""} · {status}
                </span>
              </span>
            </span>
          </button>
          <button onClick={() => setMenu({ stop: busy && controllable })} aria-label="메뉴" className="rounded-lg p-2 text-muted">
            <Icon.dots />
          </button>
        </div>
      </header>

      <div
        ref={listRef}
        onScroll={(e) => {
          const gap = gapBelow(e.currentTarget);
          if (gap < 2) glide.current = false;
          const near = gap < NEAR_BOTTOM_PX;
          if (near !== stick.current && (near || !glide.current)) follow(near);
        }}
        onPointerDown={endGlide}
        onWheel={endGlide}
        className="flex-1 overflow-y-auto overscroll-contain px-safe-0"
        data-scroll-root
      >
        <FileLinks.Provider value={openFile}>
          <FileRoots.Provider value={roots}>
            <div className="mx-auto max-w-3xl space-y-4 px-4 py-4 short:py-3">
              {!chat?.loaded && (
                <div className="flex justify-center py-10 text-muted">
                  <Spinner className="size-6" />
                </div>
              )}
              {chat?.hasMore && <div className="text-center text-xs text-muted">이전 대화는 생략했습니다</div>}
              {items.map((item) => (
                <Fragment key={item.id}>
                  {item.id === gapAt && (
                    <div className="flex items-center gap-3 text-xs text-muted" data-gap>
                      <span className="h-px flex-1 bg-line" />
                      중간 대화 {chat?.gap?.skipped}개 항목은 생략했습니다
                      <span className="h-px flex-1 bg-line" />
                    </div>
                  )}
                  <DateLine day={days.get(item.id)} />
                  <div
                    data-item={item.id}
                    className={`rounded-xl transition-shadow duration-700 ${flash === item.id ? "ring-2 ring-accent/70 ring-offset-4 ring-offset-bg" : ""}`}
                  >
                    <ItemView item={item} running={busy} />
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
                  <Spinner className="size-3.5" /> 작업 중…
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
              {chat?.pending.map((p) => (
                <div key={p.id} data-pending={p.id} className={`rounded-2xl transition-shadow duration-700 ${flash === p.id ? "ring-2 ring-accent/70 ring-offset-4 ring-offset-bg" : ""}`}>
                  <PendingCard
                    request={p}
                    agent={askingAgent(p.agentId)}
                    reply={(answer) => {
                      if (!send({ t: "answer", sessionId, requestId: p.id, answer })) toast("연결되어 있지 않습니다. 다시 연결된 뒤 답하세요");
                    }}
                  />
                </div>
              ))}
              {chat?.loaded && archived && (
                <div className="flex items-center gap-3 rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-muted" data-archived-note>
                  <p className="min-w-0 flex-1 break-keep text-balance">
                    <span className="block">보관된 세션입니다.</span>
                    {kind !== "live" && !folderMissing && <span className="block">메시지를 보내면 보관이 풀립니다.</span>}
                  </p>
                  <button onClick={() => setArchived(sessionId, false)} className="min-h-11 shrink-0 rounded-lg bg-surface px-4 font-medium text-accent">
                    보관 해제
                  </button>
                </div>
              )}
              {chat?.loaded && kind === "inactive" && (
                <div className="flex items-center gap-3 rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-muted" data-stopped-note={folderMissing ? "folder-missing" : ""}>
                  {folderMissing ? (
                    <p className="min-w-0 flex-1 break-keep">
                      작업 폴더가 없어 이 세션을 시작할 수 없습니다.
                      <span className="mt-0.5 block text-xs break-all">{shortPath(cwd)}</span>
                    </p>
                  ) : (
                    <>
                      <p className="min-w-0 flex-1 break-keep text-balance">
                        <span className="block">{closedText(st?.closedReason) || "꺼져 있는 세션입니다."}</span>
                        <span className="block">메시지를 보내면 이어서 실행합니다.</span>
                      </p>
                      <button onClick={startNow} disabled={starting} className="min-h-11 shrink-0 rounded-lg bg-surface px-4 font-medium text-accent disabled:opacity-50">
                        {starting ? "시작하는 중…" : "지금 시작"}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </FileRoots.Provider>
        </FileLinks.Provider>
      </div>

      {away && <JumpButton unseen={unseen} onClick={jump} />}
      {chat?.loaded && <TodoPanel items={chat.items} />}

      <Composer
        sessionId={sessionId}
        state={st}
        models={models}
        controllable={controllable}
        deferred={deferred}
        starting={starting || sentStart}
        disabledReason={disabledReason}
        placeholder="Claude에게 메시지"
        onSend={sendText}
        onCommand={openCommand}
        openSheet={composerSheet}
        onStop={stop}
        onMode={(mode) => send({ t: "set_mode", sessionId, mode })}
        onModel={(model) => send({ t: "set_model", sessionId, model })}
        onEffort={(effort) => send({ t: "set_effort", sessionId, effort })}
        onUltracode={(on) => send({ t: "set_ultracode", sessionId, on })}
        onFast={(on) => send({ t: "set_fast", sessionId, on })}
        onThinking={(on) => send({ t: "set_thinking", sessionId, on })}
        inConversation={items.some((i) => i.kind === "user" || i.kind === "assistant")}
        onContext={() => setSheet("contextUsage")}
        agents={agentChip}
        onAgents={() => setSheet("agents")}
      />

      {menu && (
        <Sheet title={title} onClose={() => setMenu(false)}>
          <div className="mb-2 px-3 text-xs break-all text-muted">{cwd}</div>
          {menu.stop && (
            <Choice
              label="이번 턴 중지"
              hint={
                <>
                  <span className="block">입력창에 쓴 글은 그대로 둡니다.</span>
                  <span className="block">백그라운드 에이전트는 에이전트 지도에서 멈춥니다.</span>
                </>
              }
              disabled={!busy || !controllable}
              onClick={() => (stop(), setMenu(false))}
            />
          )}
          <Choice label="새로고침" onClick={() => (send({ t: "view", sessionId }), setMenu(false))} />
          <Choice label="이름 바꾸기" hint={renameRefused} disabled={Boolean(renameRefused)} onClick={rename} />
          <Choice
            label={archived ? "보관 해제" : "보관하기"}
            hint={archived ? "목록에 다시 보입니다" : "ccrc 목록에서만 숨깁니다"}
            onClick={() => (setArchived(sessionId, !archived), setMenu(false))}
          />
          <Choice label="변경 사항" hint="이 세션에서 바뀐 파일" onClick={() => (setSheet("changes"), setMenu(false))} />
          <Choice label="Context와 사용량" hint="Context, 요금제 사용량, Compact" onClick={() => (setSheet("contextUsage"), setMenu(false))} />
          <Choice label="에이전트 지도" hint="에이전트와 백그라운드 작업 보기·중지" onClick={() => (setSheet("agents"), setMenu(false))} />
          {controllable && (
            <>
              <Choice label="MCP 서버" onClick={() => (setSheet("mcp"), setMenu(false))} />
              <Choice
                label="출력 스타일"
                hint={st?.outputStyle ? outputStyleLabel(st.outputStyle) : "응답 방식을 고릅니다"}
                onClick={() => (setSheet("outputStyle"), setMenu(false))}
              />
              <Choice label="파일 되돌리기" hint="보낸 메시지 시점으로 파일을 되돌립니다" onClick={() => (setSheet("rewind"), setMenu(false))} />
            </>
          )}
          {kind === "owned" && (
            <Choice
              label="원격 실행 끝내기"
              hint={
                <>
                  <span className="block">이 세션의 Claude Code 프로세스를 닫습니다.</span>
                  <span className="block">대화 기록은 남습니다.</span>
                </>
              }
              onClick={() => (send({ t: "release", sessionId }), setMenu(false))}
            />
          )}
        </Sheet>
      )}
      {file && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-40 flex items-center justify-center bg-bg text-muted">
              <Spinner className="size-6" />
            </div>
          }
        >
          <FileViewer sessionId={sessionId} cwd={cwd} target={file} onClose={() => setFile(null)} />
        </Suspense>
      )}
      {thread && <ThreadSheet thread={thread} onClose={() => setThread(null)} />}
      {renaming && <SessionActions session={renameTarget} step="rename" onClose={() => setRenaming(false)} />}
      {sheet === "changes" && <ChangesSheet sessionId={sessionId} onClose={() => setSheet(null)} />}
      {sheet === "agents" && (
        <AgentMapSheet sessionId={sessionId} title={title} controllable={controllable} onClose={() => setSheet(null)} onJump={jumpTo} onPending={jumpToRequest} />
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
      {stopped && <StoppedSheet sessionId={sessionId} title={commandSheet(stopped)?.title ?? `/${stopped}`} onClose={() => setStopped(null)} />}
      {awaited && <CommandResultSheet title={awaited.title} item={result} late={awaited.late && !busy} onClose={() => setAwaited(undefined)} />}
      {sheet === "mcp" && <McpSheet sessionId={sessionId} onClose={() => setSheet(null)} />}
      {sheet === "outputStyle" && <OutputStyleSheet sessionId={sessionId} onClose={() => setSheet(null)} />}
      {sheet === "rewind" && <RewindSheet sessionId={sessionId} onClose={() => setSheet(null)} />}
    </div>
  );
}
