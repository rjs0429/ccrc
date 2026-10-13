import { useLayoutEffect, useRef, useState } from "react";
import { ItemView, StreamPreview } from "../components/Items.tsx";
import { Composer } from "../components/Composer.tsx";
import { PendingCard } from "../components/Pending.tsx";
import { Choice, Icon, Sheet, Spinner } from "../components/ui.tsx";
import { baseName, hostLabel, sessionTitle } from "../labels.ts";
import { navigate, send, useApp } from "../state.ts";

const NEAR_BOTTOM_PX = 160;

export function Chat({ sessionId }: { sessionId: string }) {
  const chat = useApp((s) => (s.chat?.sessionId === sessionId ? s.chat : undefined));
  const summary = useApp((s) => s.sessions?.find((x) => x.id === sessionId));
  const models = useApp((s) => s.options?.models ?? []);
  const [menu, setMenu] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const st = chat?.state;
  const owned = Boolean(st?.owned);
  const liveHost = st?.liveHost ?? (summary?.state === "live" ? summary.liveHost : undefined);
  const busy = Boolean(st?.busy);
  const cwd = st?.cwd ?? summary?.cwd ?? "";
  const title = sessionTitle({ title: st?.title || summary?.title || "" });

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat?.items, chat?.stream?.text, chat?.pending.length, chat?.loaded]);

  const status = owned ? (busy ? "작업 중" : "원격 실행 중") : liveHost ? `${hostLabel(liveHost)}에서 열림` : "꺼져 있음";
  const disabledReason = !owned && liveHost ? `${hostLabel(liveHost)}에서 열려 있어 지금은 보기만 할 수 있습니다.` : undefined;

  return (
    <div className="flex h-dvh flex-col">
      <header className="pt-safe border-b border-line bg-bg">
        <div className="flex items-center gap-1 px-2 py-2">
          <button onClick={() => navigate({ name: "home" })} aria-label="뒤로" className="rounded-lg p-2">
            <Icon.back />
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
        <div className="mx-auto max-w-3xl space-y-4 px-4 py-4">
          {!chat?.loaded && (
            <div className="flex justify-center py-10 text-muted">
              <Spinner className="size-6" />
            </div>
          )}
          {chat?.hasMore && <div className="text-center text-xs text-muted">이전 대화는 생략했습니다</div>}
          {chat?.items.map((item) => <ItemView key={item.id} item={item} running={busy} />)}
          {chat?.stream && <StreamPreview text={chat.stream.text} thinking={chat.stream.thinking} />}
          {busy && !chat?.stream && !chat?.pending.length && (
            <div className="flex items-center gap-2 text-sm text-muted">
              <Spinner className="size-3.5" /> 작업 중…
            </div>
          )}
          {chat?.pending.map((p) => (
            <PendingCard key={p.id} request={p} reply={(answer) => send({ t: "answer", sessionId, requestId: p.id, answer })} />
          ))}
          {chat?.loaded && !owned && !liveHost && (
            <div className="rounded-xl bg-surface-2 px-3 py-2.5 text-center text-sm text-muted">메시지를 보내면 이 세션을 원격에서 이어서 실행합니다.</div>
          )}
        </div>
      </div>

      <Composer
        state={st}
        models={models}
        controllable={owned}
        disabledReason={disabledReason}
        placeholder="Claude에게 메시지"
        onSend={(text) => {
          stick.current = true;
          send({ t: "send", sessionId, text });
        }}
        onStop={() => send({ t: "interrupt", sessionId })}
        onMode={(mode) => send({ t: "set_mode", sessionId, mode })}
        onModel={(model) => send({ t: "set_model", sessionId, model })}
        onEffort={(effort) => send({ t: "set_effort", sessionId, effort })}
      />

      {menu && (
        <Sheet title={title} onClose={() => setMenu(false)}>
          <div className="mb-2 px-3 text-xs break-all text-muted">{cwd}</div>
          <Choice label="새로고침" onClick={() => (send({ t: "view", sessionId }), setMenu(false))} />
          {owned && (
            <Choice
              label="원격 실행 끝내기"
              hint="이 세션의 Claude Code 프로세스를 닫습니다. 대화 기록은 남습니다."
              onClick={() => (send({ t: "release", sessionId }), setMenu(false))}
            />
          )}
        </Sheet>
      )}
    </div>
  );
}
