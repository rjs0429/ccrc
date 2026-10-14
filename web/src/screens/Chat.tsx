import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { commandName, isDialogCommand, parseCommand } from "../../../broker/src/dialog-commands.ts";
import type { DisplayItem, ModelOption } from "../../../broker/src/protocol.ts";
import { ItemView, StreamPreview, shownItems } from "../components/Items.tsx";
import { Composer } from "../components/Composer.tsx";
import { commandSheet } from "../components/commandSheets.ts";
import { PendingCard } from "../components/Pending.tsx";
import { TodoPanel } from "../components/TodoPanel.tsx";
import { ChangesSheet } from "../components/sheets/Changes.tsx";
import { CommandResultSheet, StoppedSheet } from "../components/sheets/Command.tsx";
import { ContextSheet } from "../components/sheets/Context.tsx";
import { McpSheet } from "../components/sheets/Mcp.tsx";
import { RewindSheet } from "../components/sheets/Rewind.tsx";
import { TasksSheet } from "../components/sheets/Tasks.tsx";
import { UsageSheet } from "../components/sheets/Usage.tsx";
import { Choice, Icon, Sheet, Spinner } from "../components/ui.tsx";
import { FileLinks } from "../components/fileLinks.ts";
import type { FileTarget } from "../components/viewer/FileViewer.tsx";
import { baseName, closedText, hostLabel, sessionTitle } from "../labels.ts";
import { navigate, openSettingsFrom, send, toast, useApp } from "../state.ts";

const FileViewer = lazy(() => import("../components/viewer/FileViewer.tsx"));

const NEAR_BOTTOM_PX = 160;
const NO_MODELS: ModelOption[] = [];
// How long a command sent from here may take before its sheet says it gave no result, once the session is idle.
const RESULT_LATE_MS = 15_000;
type SheetName = "changes" | "context" | "mcp" | "rewind" | "tasks" | "usage";
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
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const st = chat?.state;
  const kind = st?.state ?? summary?.state ?? "inactive";
  const controllable = kind === "owned" || kind === "attached";
  const host = hostLabel(st?.host ?? summary?.host);
  const busy = Boolean(st?.busy);
  const cwd = st?.cwd ?? summary?.cwd ?? "";
  const title = sessionTitle({ title: st?.title || summary?.title || "" });
  const items = useMemo(() => shownItems(chat?.items ?? []), [chat?.items]);

  const sendText = (text: string, attachments: string[] = []) => {
    stick.current = true;
    const c = attachments.length ? undefined : parseCommand(text);
    const before = new Set((chat?.items ?? []).filter((i) => i.kind === "command").map((i) => i.id));
    const ok = send({ t: "send", sessionId, text, ...(attachments.length ? { attachments } : {}) });
    if (ok && c && isDialogCommand(c.name)) setAwaited({ title: text.trim(), name: commandName(c.name), before, late: false });
    return ok;
  };

  const result = useMemo(
    () =>
      awaited &&
      (chat?.items ?? []).find((i): i is CommandItem => i.kind === "command" && !awaited.before.has(i.id) && commandName(i.name ?? "") === awaited.name),
    [awaited, chat?.items],
  );

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
          : "꺼져 있음";
  const disabledReason = kind === "live" ? `${host}에서 열려 있어 지금은 보기만 할 수 있습니다.` : undefined;

  return (
    <div className="flex h-dvh flex-col">
      <header className="pt-safe border-b border-line bg-bg">
        <div className="flex items-center gap-1 px-2 py-2">
          <button onClick={() => navigate({ name: "home" })} aria-label="뒤로" className="relative rounded-lg p-2">
            <Icon.back />
            {othersWaiting && <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-warn" title="다른 세션에서 입력이 필요합니다" />}
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold">{title}</div>
            <div className="truncate text-xs text-muted">
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
        className="flex-1 overflow-y-auto overscroll-contain"
      >
        <FileLinks.Provider value={openFile}>
          <div className="mx-auto max-w-3xl space-y-4 px-4 py-4">
            {!chat?.loaded && (
              <div className="flex justify-center py-10 text-muted">
                <Spinner className="size-6" />
              </div>
            )}
            {chat?.hasMore && <div className="text-center text-xs text-muted">이전 대화는 생략했습니다</div>}
            {items.map((item) => <ItemView key={item.id} item={item} running={busy} />)}
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
              <div className="rounded-xl bg-surface-2 px-3 py-2.5 text-center text-sm text-muted">
                {closedText(st?.closedReason)}메시지를 보내면 이 세션을 원격에서 이어서 실행합니다.
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
      />

      {menu && (
        <Sheet title={title} onClose={() => setMenu(false)}>
          <div className="mb-2 px-3 text-xs break-all text-muted">{cwd}</div>
          <Choice label="새로고침" onClick={() => (send({ t: "view", sessionId }), setMenu(false))} />
          <Choice label="변경 사항" hint="이 세션에서 바뀐 파일" onClick={() => (setSheet("changes"), setMenu(false))} />
          {controllable && (
            <>
              <Choice label="백그라운드 작업" hint="서브에이전트·백그라운드 명령" onClick={() => (setSheet("tasks"), setMenu(false))} />
              <Choice label="Context 사용량" onClick={() => (setSheet("context"), setMenu(false))} />
              <Choice label="MCP 서버" onClick={() => (setSheet("mcp"), setMenu(false))} />
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
      {sheet === "context" && <ContextSheet sessionId={sessionId} onClose={() => setSheet(null)} />}
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
      {sheet === "rewind" && <RewindSheet sessionId={sessionId} onClose={() => setSheet(null)} />}
    </div>
  );
}
