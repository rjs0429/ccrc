import { useEffect, useRef, useState } from "react";
import { brokerSessionsBlocked, clock, hostLabel } from "../../labels.ts";
import { askInstead, askSide, cancelSide, clearSide, useSideThread, type SideEntry, type SidePending } from "../../sideQuestions.ts";
import { useApp } from "../../state.ts";
import { Markdown } from "../Markdown.tsx";
import { Button, Sheet, Spinner } from "../ui.tsx";
import { SmallButton } from "./parts.tsx";
import type { SheetProps } from "./types.ts";

const OLD_WRAPPER = "VS Code 쪽 래퍼가 곁질문을 넘기지 못합니다. VS Code에서 Claude Code를 다시 띄우면 쓸 수 있습니다.";

function Question({ text, at }: { text: string; at?: number }) {
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="max-w-[88%] rounded-2xl rounded-br-md bg-surface-2 px-3.5 py-2.5 text-[15px] leading-relaxed break-words whitespace-pre-wrap">{text}</div>
      {at !== undefined && <span className="text-[11px] text-muted">{clock(new Date(at))}</span>}
    </div>
  );
}

// onInstead: gives up the earlier question that kept this one from being asked, and asks this one.
function Entry({ e, onInstead }: { e: SideEntry; onInstead?: () => void }) {
  return (
    <div className="space-y-2" data-side-entry={e.kind}>
      <Question text={e.question} at={e.at} />
      {e.kind === "answer" && (
        <div>
          <Markdown text={e.text} className="text-[15px]" />
          {e.notice && <p className="mt-1 text-xs text-muted">다른 모델이 대신 답했습니다. {e.notice}</p>}
        </div>
      )}
      {e.kind === "notice" && <p className="text-sm text-muted">{e.text}</p>}
      {e.kind === "none" && <p className="text-sm text-muted">답이 없습니다. 다시 묻거나 대화에서 물어보세요.</p>}
      {e.kind === "error" && <p className="text-sm text-danger">{e.text}</p>}
      {onInstead && (
        <SmallButton tall onClick={onInstead}>
          앞선 곁질문 취소하고 다시 묻기
        </SmallButton>
      )}
      {e.kind === "cancelled" && <p className="text-sm text-muted">물음을 취소했습니다.</p>}
    </div>
  );
}

function waitingText(p: SidePending): string {
  if (p.status === "starting") return "세션을 이어서 실행하는 중…";
  if (p.status === "offline") return "연결이 끊겨 다시 연결되기를 기다리는 중…";
  if (p.status === "sent") return "보내는 중…";
  if (p.status === "retry") return `API 오류로 다시 시도하는 중${p.attempt && p.maxRetries ? ` (${p.attempt}/${p.maxRetries})` : ""}…`;
  return "답을 쓰는 중…";
}

function Waiting({ pending, onCancel }: { pending: SidePending; onCancel: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const seconds = Math.max(0, Math.floor((Date.now() - pending.since) / 1000));
  return (
    <div className="space-y-2" data-side-pending={pending.status}>
      <Question text={pending.question} />
      <div className="flex items-center gap-2 text-sm text-muted">
        <Spinner className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          {waitingText(pending)} {seconds}초
        </span>
        <SmallButton tall onClick={onCancel}>
          취소
        </SmallButton>
      </div>
    </div>
  );
}

// Questions beside the conversation (/btw): Claude Code answers from the conversation without interrupting a turn, and
// neither the question nor the answer enters it. A session without a process is started first, at the user's word.
// question: one typed after /btw, asked at once (ask) where nothing needs starting.
export function SideQuestionSheet({ sessionId, question, ask, onAsked, onClose }: SheetProps & { question?: string; ask?: boolean; onAsked?: () => void }) {
  const st = useApp((s) => (s.chat?.sessionId === sessionId ? s.chat.state : undefined));
  const summary = useApp((s) => s.sessions?.find((x) => x.id === sessionId));
  const brokerOff = brokerSessionsBlocked(useApp((s) => s.options?.brokerSessions));
  const { entries, pending } = useSideThread(sessionId);
  const [text, setText] = useState(question ?? "");
  const endRef = useRef<HTMLDivElement>(null);
  const kind = st?.state ?? summary?.state ?? "inactive";
  const start = kind === "inactive";
  const folderMissing = start && Boolean(st ? st.folderMissing : summary?.folderMissing);
  const blocked =
    kind === "live"
      ? `${hostLabel(st?.host ?? summary?.host)}에서 열려 있어 여기서는 곁질문을 할 수 없습니다.`
      : folderMissing
        ? "작업 폴더가 없어 곁질문을 할 수 없습니다."
        : start && brokerOff
          ? brokerOff
          : kind === "attached" && st?.sideUnknown
            ? OLD_WRAPPER
            : undefined;
  const q = text.trim();

  const submit = () => {
    if (!q || pending || blocked) return;
    setText("");
    onAsked?.();
    void askSide(sessionId, q, start);
  };

  useEffect(() => {
    if (ask && question?.trim() && !start && !blocked && !pending) submit();
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [entries.length, Boolean(pending)]);

  return (
    <Sheet title="곁질문" onClose={onClose}>
      <p className="px-1 text-xs text-muted" data-side-about>
        <span className="block">진행 중인 작업을 끊지 않고 묻습니다. 질문과 답은 대화에 남지 않고 이 화면에만 최근 20개까지 남습니다.</span>
        <span className="block">곁질문도 모델을 불러 사용량이 듭니다.</span>
      </p>
      {(entries.length > 0 || pending) && (
        <div className="mt-3 space-y-4" data-side-thread>
          {entries.map((e, i) => (
            <Entry
              key={`${e.at}-${i}`}
              e={e}
              onInstead={e.kind === "error" && e.busy && i === entries.length - 1 && !pending && !blocked ? () => void askInstead(sessionId, e, start) : undefined}
            />
          ))}
          {pending && <Waiting pending={pending} onCancel={() => cancelSide(sessionId)} />}
        </div>
      )}
      {blocked ? (
        <p className="mt-3 rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-muted" data-side-blocked>
          {blocked}
        </p>
      ) : (
        <div className="sticky bottom-0 -mx-4 mt-3 border-t border-line bg-surface px-4 pt-2.5">
          {start && (
            <p className="mb-2 px-1 text-xs text-muted" data-side-start>
              꺼진 세션이라 이 노트북에서 세션을 이어서 실행한 뒤 묻습니다. 대화에는 아무것도 보내지 않습니다. 대화가 길면 첫 질문에 사용량이 더 듭니다.
            </p>
          )}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            maxLength={10_000}
            aria-label="곁질문"
            placeholder="무엇이 궁금한가요?"
            className="block max-h-[30vh] w-full resize-none rounded-xl border border-line bg-bg px-3 py-2 text-[16px] leading-snug outline-none placeholder:text-muted focus:border-accent"
            data-side-input
          />
          <div className="mt-2 flex items-center gap-2">
            {entries.length > 0 && !pending && (
              <Button kind="ghost" onClick={() => clearSide(sessionId)}>
                기록 지우기
              </Button>
            )}
            <Button kind="primary" className="flex-1" disabled={!q || Boolean(pending)} onClick={submit}>
              {start ? "이어서 실행하고 묻기" : "묻기"}
            </Button>
          </div>
        </div>
      )}
      <div ref={endRef} />
    </Sheet>
  );
}
