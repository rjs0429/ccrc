import { useEffect, useRef, useState } from "react";
import type { ExportInfo } from "../../../../broker/src/protocol.ts";
import { request } from "../../api.ts";
import { num } from "../../i18n/format.ts";
import { lang } from "../../i18n/index.ts";
import { errorText, sizeText } from "../../labels.ts";
import { Switch } from "../../screens/settings/common.tsx";
import { call, toast } from "../../state.ts";
import { copyText } from "../clipboard.ts";
import { Button, Sheet, Spinner } from "../ui.tsx";
import { Failed, Waiting } from "./parts.tsx";

// A long conversation is read from its transcript in full.
const WAIT_MS = 60_000;
// A ticket is asked for again this long before it runs out.
const RENEW_EARLY_MS = 3000;

function zone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

// The conversation as a Markdown file the broker makes from the transcript, so a stopped session exports too. It
// downloads through a ticket, as the home-screen app hands a download to a browser without its login, and copies whole.
export function ExportSheet({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [tools, setTools] = useState(true);
  const [info, setInfo] = useState<ExportInfo>();
  const [error, setError] = useState<string>();
  const [round, setRound] = useState(0);
  const [ticket, setTicket] = useState<{ url: string; until: number }>();
  const [asking, setAsking] = useState(false);
  const link = useRef<HTMLAnchorElement>(null);
  const go = useRef(false);
  // The file the sheet shows, counted up whenever it is made again: a ticket asked for an earlier file is dropped.
  const made = useRef(0);
  const tz = zone();
  const args = { tools, lang: lang(), ...(tz ? { tz } : {}) };

  useEffect(() => {
    let live = true;
    made.current++;
    go.current = false;
    setInfo(undefined);
    setError(undefined);
    setTicket(undefined);
    call(sessionId, "export", args, WAIT_MS).then(
      (x) => live && setInfo(x),
      (e: Error) => live && setError(errorText(e.message)),
    );
    return () => {
      live = false;
    };
  }, [sessionId, tools, round]);

  const issue = () => {
    const file = made.current;
    return request<{ url: string; expiresInMs: number }>("POST", `/api/sessions/${encodeURIComponent(sessionId)}/file/ticket`, { export: args }).then((t) => {
      if (file === made.current) setTicket({ url: t.url, until: Date.now() + t.expiresInMs });
    });
  };

  // The link is live once the file is made, so a tap downloads at once.
  useEffect(() => {
    if (info) issue().catch(() => {});
  }, [info]);

  useEffect(() => {
    if (!ticket || !go.current) return;
    go.current = false;
    link.current?.click();
  }, [ticket]);

  const download = (e: React.MouseEvent) => {
    if (ticket && Date.now() < ticket.until - RENEW_EARLY_MS) return;
    e.preventDefault();
    if (asking) return;
    setAsking(true);
    go.current = true;
    issue()
      .catch(() => {
        go.current = false;
        toast("내려받지 못했습니다. 다시 시도하세요");
      })
      .finally(() => setAsking(false));
  };

  return (
    <Sheet title="대화 내보내기" onClose={onClose}>
      <p className="px-1 text-sm text-muted">대화 기록을 Markdown 파일로 만듭니다. 꺼진 세션도 기록에서 만듭니다.</p>
      <button
        role="switch"
        aria-checked={tools}
        onClick={() => setTools(!tools)}
        data-switch="tools"
        className="mt-2 flex w-full items-center justify-between gap-3 rounded-xl px-1 py-2.5 text-left"
      >
        <span>
          <span className="block text-[15px]">도구 실행 포함</span>
          <span className="block text-xs text-muted">도구 호출과 백그라운드 작업을 한 줄씩 넣습니다</span>
        </span>
        <Switch on={tools} />
      </button>
      {!info && !error && <Waiting text="파일을 만드는 중입니다" />}
      {error && <Failed text={error} onRetry={() => setRound((r) => r + 1)} />}
      {info && (
        <div className="mt-1 rounded-xl bg-surface-2 px-3 py-2.5" data-export-summary>
          <div className="truncate text-[14px] font-medium">{info.name}</div>
          <div className="text-xs text-muted">
            메시지 {num(info.messages)}개 · {sizeText(new Blob([info.text]).size)}
          </div>
          {info.cut ? <div className="mt-0.5 text-xs text-warn">파일이 너무 커서 마지막 항목 {info.cut}개는 뺐습니다</div> : null}
        </div>
      )}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <a
          ref={link}
          href={ticket ? `${ticket.url}?download=1` : "#"}
          download={info?.name}
          onClick={info ? download : (e) => e.preventDefault()}
          aria-disabled={!info}
          className={`flex min-h-11 items-center justify-center gap-2 rounded-xl bg-accent px-3.5 py-2.5 text-[15px] font-medium text-white ${info ? "" : "pointer-events-none opacity-40"}`}
          data-export-download
        >
          {asking && <Spinner className="size-4" />}
          내려받기
        </a>
        <Button disabled={!info} onClick={() => info && copyText(info.text, "대화를 복사했습니다")}>
          전체 복사
        </Button>
      </div>
    </Sheet>
  );
}
