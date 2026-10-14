import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { commandName, dialogResult, isDialogCommand, parseCommand } from "../../../broker/src/dialog-commands.ts";
import type { DisplayItem, ModelOption } from "../../../broker/src/protocol.ts";
import { ItemView, StreamPreview, shownItems } from "../components/Items.tsx";
import { Composer } from "../components/Composer.tsx";
import { commandSheet } from "../components/commandSheets.ts";
import { PendingCard } from "../components/Pending.tsx";
import { TodoPanel } from "../components/TodoPanel.tsx";
import { ChangesSheet } from "../components/sheets/Changes.tsx";
import { CommandResultSheet, StoppedSheet } from "../components/sheets/Command.tsx";
import { ContextSheet } from "../components/sheets/Context.tsx";
import { ContextUsageSheet } from "../components/sheets/ContextUsage.tsx";
import { McpSheet } from "../components/sheets/Mcp.tsx";
import { OutputStyleSheet, outputStyleLabel } from "../components/sheets/OutputStyle.tsx";
import { RewindSheet } from "../components/sheets/Rewind.tsx";
import { TasksSheet } from "../components/sheets/Tasks.tsx";
import { UsageSheet } from "../components/sheets/Usage.tsx";
import { Choice, Icon, Sheet, Spinner } from "../components/ui.tsx";
import { FileLinks } from "../components/fileLinks.ts";
import type { FileTarget } from "../components/viewer/FileViewer.tsx";
import { baseName, closedText, errorText, hostLabel, sessionTitle, shortPath } from "../labels.ts";
import { call, focusDone, navigate, openSettingsFrom, send, toast, useApp } from "../state.ts";

const FileViewer = lazy(() => import("../components/viewer/FileViewer.tsx"));

const NEAR_BOTTOM_PX = 160;
const FLASH_MS = 2500;
const NO_MODELS: ModelOption[] = [];
// How long a command sent from here may take before its sheet says it gave no result, once the session is idle.
const RESULT_LATE_MS = 15_000;
const RESUME_WAIT_MS = 60_000;
type SheetName = "changes" | "context" | "contextUsage" | "mcp" | "outputStyle" | "rewind" | "tasks" | "usage";
type CommandItem = Extract<DisplayItem, { kind: "command" }>;
// A dialog command sent from here: its result shows in a sheet once a new result of that command arrives.
interface Awaited {
  title: string;
  name: string;
  before: Set<string>;
  late: boolean;
}

export function Chat({ sessionId }: { sessionId: string }) {
  const chat = useApp((s) => (s.chat?.sessionId === sessionId ? s.chat : undefined));
  const summary = useApp((s) => s.sessions?.find((x) => x.id === sessionId));
  const models = useApp((s) => s.options?.models ?? NO_MODELS);
  const othersWaiting = useApp((s) => (s.sessions ?? []).some((x) => x.id !== sessionId && x.pendingCount));
  const [menu, setMenu] = useState(false);
  const [sheet, setSheet] = useState<SheetName | null>(null);
  const [usageCommand, setUsageCommand] = useState("usage");
  const [stopped, setStopped] = useState<string | null>(null);
  const [composerSheet, setComposerSheet] = useState<{ name: "model" | "effort"; at: number }>();
  const [awaited, setAwaited] = useState<Awaited>();
  const [file, setFile] = useState<FileTarget | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [sentStart, setSentStart] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const st = chat?.state;
  const kind = st?.state ?? summary?.state ?? "inactive";
  const controllable = kind === "owned" || kind === "attached";
  const deferred = kind === "inactive";
  const folderMissing = deferred && Boolean(st ? st.folderMissing : summary?.folderMissing);
  const host = hostLabel(st?.host ?? summary?.host);
  const busy = Boolean(st?.busy);
  const cwd = st?.cwd ?? summary?.cwd ?? "";
  const cannotStart = folderMissing ? `작업 폴더가 없어 이 세션을 시작할 수 없습니다: ${shortPath(cwd)}` : undefined;
  const title = sessionTitle({ title: st?.title || summary?.title || "" });
  const items = useMemo(() => shownItems(chat?.items ?? []), [chat?.items]);

  const sendText = (text: string, attachments: string[] = []) => {
    stick.current = true;
    const c = attachments.length ? undefined : parseCommand(text);
    const before = new Set((chat?.items ?? []).filter((i) => i.kind === "command").map((i) => i.id));
    const ok = send({ t: "send", sessionId, text, ...(attachments.length ? { attachments } : {}) });
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

  const openFile = useCallback((href: string) => {
    if (!href.startsWith("#")) setFile({ href });
  }, []);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat?.items, chat?.stream?.text, chat?.pending.length, chat?.loaded]);

  const focus = chat?.loaded ? chat.focus : undefined;
  useLayoutEffect(() => {
    if (!focus) return;
    focusDone(sessionId);
    const el = listRef.current?.querySelector(`[data-item="${CSS.escape(focus)}"]`);
    if (!el) {
      toast("찾은 메시지가 지금 대화에 없습니다");
      return;
    }
    stick.current = false;
    el.scrollIntoView({ block: "center" });
    setFlash(focus);
  }, [focus, sessionId]);

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
          <button onClick={() => navigate({ name: "home" })} aria-label="뒤로" className="relative rounded-lg p-2">
            <Icon.back />
            {othersWaiting && <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-warn" title="다른 세션에서 입력이 필요합니다" />}
          </button>
          <div className="min-w-0 flex-1 short:flex short:items-baseline short:gap-2">
            <div className="truncate text-[15px] font-semibold short:max-w-[60%] short:shrink-0">{title}</div>
            <div className="truncate text-xs text-muted short:min-w-0">
              {baseName(cwd)}
              {summary?.branch && summary.branch !== "HEAD" ? ` · ${summary.branch}` : ""} · {status}
            </div>
          </div>
          <button onClick={() => setMenu(true)} aria-label="메뉴" className="rounded-lg p-2 text-muted">
            <Icon.dots />
          </button>
        </div>
      </header>

      <div
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
        }}
        className="flex-1 overflow-y-auto overscroll-contain px-safe-0"
      >
        <FileLinks.Provider value={openFile}>
          <div className="mx-auto max-w-3xl space-y-4 px-4 py-4 short:py-3">
            {!chat?.loaded && (
              <div className="flex justify-center py-10 text-muted">
                <Spinner className="size-6" />
              </div>
            )}
            {chat?.hasMore && <div className="text-center text-xs text-muted">이전 대화는 생략했습니다</div>}
            {items.map((item) => (
              <div
                key={item.id}
                data-item={item.id}
                className={`rounded-xl transition-shadow duration-700 ${flash === item.id ? "ring-2 ring-accent/70 ring-offset-4 ring-offset-bg" : ""}`}
              >
                <ItemView item={item} running={busy} />
              </div>
            ))}
            {chat?.stream && <StreamPreview text={chat.stream.text} thinking={chat.stream.thinking} />}
            {busy && !chat?.stream && !chat?.pending.length && (
              <div className="flex items-center gap-2 text-sm text-muted">
                <Spinner className="size-3.5" /> 작업 중…
              </div>
            )}
            {chat?.pending.map((p) => (
              <PendingCard
                key={p.id}
                request={p}
                reply={(answer) => {
                  if (!send({ t: "answer", sessionId, requestId: p.id, answer })) toast("연결되어 있지 않습니다. 다시 연결된 뒤 답하세요");
                }}
              />
            ))}
            {chat?.loaded && kind === "inactive" && (
              <div className="flex items-center gap-3 rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-muted" data-stopped-note={folderMissing ? "folder-missing" : ""}>
                {folderMissing ? (
                  <p className="min-w-0 flex-1 break-keep">
                    작업 폴더가 없어 이 세션을 시작할 수 없습니다.
                    <span className="mt-0.5 block text-xs break-all">{shortPath(cwd)}</span>
                  </p>
                ) : (
                  <>
                    <p className="min-w-0 flex-1 break-keep text-balance">{closedText(st?.closedReason) || "꺼져 있는 세션입니다. "}메시지를 보내면 이어서 실행합니다.</p>
                    <button onClick={startNow} disabled={starting} className="min-h-11 shrink-0 rounded-lg bg-surface px-4 font-medium text-accent disabled:opacity-50">
                      {starting ? "시작하는 중…" : "지금 시작"}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </FileLinks.Provider>
      </div>

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
        onStop={() => send({ t: "interrupt", sessionId })}
        onMode={(mode) => send({ t: "set_mode", sessionId, mode })}
        onModel={(model) => send({ t: "set_model", sessionId, model })}
        onEffort={(effort) => send({ t: "set_effort", sessionId, effort })}
        onUltracode={(on) => send({ t: "set_ultracode", sessionId, on })}
        onContext={() => setSheet("contextUsage")}
      />

      {menu && (
        <Sheet title={title} onClose={() => setMenu(false)}>
          <div className="mb-2 px-3 text-xs break-all text-muted">{cwd}</div>
          <Choice label="새로고침" onClick={() => (send({ t: "view", sessionId }), setMenu(false))} />
          <Choice label="변경 사항" hint="이 세션에서 바뀐 파일" onClick={() => (setSheet("changes"), setMenu(false))} />
          <Choice label="Context와 사용량" hint="Context, 요금제 사용량, Compact" onClick={() => (setSheet("contextUsage"), setMenu(false))} />
          {controllable && (
            <>
              <Choice label="백그라운드 작업" hint="서브에이전트·백그라운드 명령" onClick={() => (setSheet("tasks"), setMenu(false))} />
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
              hint="이 세션의 Claude Code 프로세스를 닫습니다. 대화 기록은 남습니다."
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
      {sheet === "changes" && <ChangesSheet sessionId={sessionId} onClose={() => setSheet(null)} />}
      {sheet === "tasks" && <TasksSheet sessionId={sessionId} onClose={() => setSheet(null)} />}
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
