import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DateLine, ItemView, shownItems } from "../components/Items.tsx";
import { FileLinks, FileRoots } from "../components/fileLinks.ts";
import { LAPTOP_ONLY, OfflineView } from "../components/offlineView.ts";
import { ReplySheet, type Reply } from "../components/sheets/Reply.tsx";
import { dayLines } from "../components/stamps.ts";
import { TitleText } from "../components/TitleText.tsx";
import { Button, Icon, Spinner } from "../components/ui.tsx";
import { dayClock, relTime, sessionTitle } from "../labels.ts";
import { copyEnd, forgetCopies, savedCopies, savedCopy } from "../offline.ts";
import type { SavedChat } from "../offlineCopy.ts";
import { getPrefs } from "../prefs.ts";
import { navigate, reconnect, toast, useApp } from "../state.ts";
import { placeLabel } from "../worktree.ts";

const openNothing = () => toast(LAPTOP_ONLY);

// Asks the broker again at once, also while an attempt that may hang is under way.
function Retry() {
  const reaching = useApp((s) => s.reaching || s.conn === "connecting");
  return (
    <button onClick={reconnect} aria-busy={reaching} className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg bg-surface px-4 font-medium text-accent" data-retry>
      {reaching && <Spinner className="size-3.5" />}
      다시 연결
    </button>
  );
}

// While the broker cannot be reached, or does not let this device in: why, and the conversations the phone kept, to read.
export function OfflineHome({ reason }: { reason: "unreachable" | "denied" }) {
  const [chats, setChats] = useState<SavedChat[]>();
  useEffect(() => {
    void savedCopies().then(setChats);
  }, [reason]);
  const end = chats?.length ? copyEnd() : undefined;
  const forget = () =>
    void forgetCopies().then(() => {
      setChats([]);
      toast("휴대폰에 저장한 대화를 지웠습니다");
    });

  return (
    <div className="flex h-dvh flex-col">
      <header className="pt-safe border-b border-line bg-bg">
        <div className="flex items-center px-safe-3 pt-2.5 pb-2">
          <h1 className="flex-1 pl-1 text-xl font-semibold">
            ccrc
            <span className="ml-2 inline-block size-2 rounded-full bg-warn align-middle" />
          </h1>
        </div>
      </header>
      <main className="pb-safe flex-1 overflow-y-auto px-safe-0">
        <div className="mx-auto max-w-3xl space-y-4 px-4 py-4">
          <div className="flex items-start gap-3 rounded-xl bg-surface-2 p-3.5 text-sm" data-offline={reason}>
            <p className="min-w-0 flex-1 break-keep text-pretty">
              <span className="block font-semibold">{reason === "denied" ? "이 기기는 노트북에 접속할 수 없습니다" : "노트북에 연결할 수 없습니다"}</span>
              <span className="mt-1 block text-muted">
                {reason === "denied"
                  ? "노트북의 ccrc가 이 기기를 허용하지 않습니다(allowedDevices). 휴대폰에 저장한 대화는 지웠습니다."
                  : "노트북이 꺼져 있거나 잠자기 중이거나, 휴대폰의 Tailscale 연결이 끊겼을 수 있습니다. 연결되면 바로 돌아갑니다."}
              </span>
            </p>
            <Retry />
          </div>
          {reason === "unreachable" && (
            <section className="space-y-2">
              <div className="px-1 text-sm font-semibold text-muted">휴대폰에 저장한 대화 · 읽기 전용</div>
              {!chats && (
                <div className="flex justify-center py-8 text-muted">
                  <Spinner className="size-5" />
                </div>
              )}
              {chats?.length === 0 && (
                <p className="px-1 py-4 text-sm break-keep text-muted" data-copy-empty>
                  {getPrefs().keepCopies
                    ? "저장한 대화가 없습니다. 노트북에 연결되어 있을 때 연 대화가 여기에 남습니다."
                    : "대화를 휴대폰에 저장하지 않게 설정되어 있습니다."}
                </p>
              )}
              {chats && chats.length > 0 && (
                <div className="overflow-hidden rounded-xl border border-line bg-surface">
                  {chats.map((c) => (
                    <button
                      key={c.sessionId}
                      onClick={() => navigate({ name: "chat", sessionId: c.sessionId })}
                      className="flex w-full items-start gap-3 border-b border-line px-4 py-3 text-left last:border-b-0 active:bg-surface-2"
                      data-copy-row={c.sessionId}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] font-medium">
                          <TitleText text={sessionTitle(c)} />
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-muted">
                          {[placeLabel(c.cwd), `${relTime(c.savedAt)} 저장`].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                      <Icon.chevronRight className="mt-1 size-4 shrink-0 text-muted" />
                    </button>
                  ))}
                </div>
              )}
              {end && <p className="px-1 text-xs text-muted">{dayClock(end)}까지 볼 수 있습니다. 그때 로그인이 끝나 휴대폰에서도 지웁니다.</p>}
              {chats && chats.length > 0 && (
                <Button kind="ghost" className="w-full" onClick={forget}>
                  저장한 대화 지우기
                </Button>
              )}
            </section>
          )}
        </div>
      </main>
    </div>
  );
}

// One conversation from the phone's copy, read only, where the chat would be.
export function OfflineChat({ sessionId }: { sessionId: string }) {
  const [chat, setChat] = useState<SavedChat | null>();
  const [reply, setReply] = useState<Reply | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void savedCopy(sessionId).then((c) => setChat(c ?? null));
  }, [sessionId]);
  const items = useMemo(() => shownItems(chat?.items ?? []), [chat]);
  const days = useMemo(() => dayLines(items), [items]);
  const roots = useMemo(() => (chat?.cwd ? [chat.cwd] : []), [chat?.cwd]);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && chat) el.scrollTop = el.scrollHeight;
  }, [chat]);

  return (
    <div className="flex h-dvh flex-col">
      <header className="pt-safe border-b border-line bg-bg">
        <div className="flex items-center gap-1 px-safe-2 py-2 short:py-0.5">
          <button onClick={() => navigate({ name: "home" })} aria-label="뒤로" className="-m-1 rounded-lg p-3">
            <Icon.back />
          </button>
          <div className="min-w-0 flex-1 py-2">
            <span className="block truncate text-[15px] font-semibold" data-chat-title>
              <TitleText text={chat ? sessionTitle(chat) : ""} />
            </span>
            <span className="block truncate text-xs text-muted">{chat ? `${placeLabel(chat.cwd)} · 휴대폰에 저장한 사본` : "휴대폰에 저장한 사본"}</span>
          </div>
        </div>
      </header>
      <div ref={listRef} className="flex-1 overflow-y-auto overscroll-contain px-safe-0" data-scroll-root data-offline-chat>
        <OfflineView.Provider value>
          <FileLinks.Provider value={openNothing}>
            <FileRoots.Provider value={roots}>
              <div className="mx-auto max-w-3xl space-y-4 px-4 py-4 short:pt-3">
                {chat === undefined && (
                  <div className="flex justify-center py-10 text-muted">
                    <Spinner className="size-6" />
                  </div>
                )}
                {chat === null && (
                  <p className="py-10 text-center text-sm break-keep text-muted" data-copy-missing>
                    이 대화는 휴대폰에 저장하지 않았습니다. 노트북에 연결되면 볼 수 있습니다.
                  </p>
                )}
                {chat?.cut && (
                  <div className="flex items-center gap-3 text-xs text-muted" data-copy-cut>
                    <span className="h-px flex-1 bg-line" />
                    이전 대화는 휴대폰에 저장하지 않았습니다
                    <span className="h-px flex-1 bg-line" />
                  </div>
                )}
                {items.map((item) => (
                  <Fragment key={item.id}>
                    <DateLine day={days.get(item.id)} />
                    <div data-item={item.id}>
                      <ItemView item={item} running={false} onReply={setReply} />
                    </div>
                  </Fragment>
                ))}
              </div>
            </FileRoots.Provider>
          </FileLinks.Provider>
        </OfflineView.Provider>
      </div>
      <div className="pb-safe flex items-center gap-3 border-t border-line bg-bg px-safe-4 pt-2.5 short:pt-1.5" data-read-only>
        <p className="min-w-0 flex-1 text-sm break-keep text-muted">
          <span className="block font-medium text-fg">읽기 전용</span>
          <span className="block text-xs">{chat ? `노트북에 연결할 수 없어 ${relTime(chat.savedAt)} 저장한 사본을 보여 줍니다.` : "노트북에 연결할 수 없습니다."}</span>
        </p>
        <Retry />
      </div>
      {reply && <ReplySheet reply={reply} onClose={() => setReply(null)} />}
    </div>
  );
}
