import { useEffect, useMemo, useRef, useState } from "react";
import type { DisplayItem, RewindResult } from "../../../../broker/src/protocol.ts";
import { clock, errorText, shortPath } from "../../labels.ts";
import { call, useApp } from "../../state.ts";
import { Sheet } from "../ui.tsx";
import { Failed, SmallButton, Waiting } from "./parts.tsx";
import type { SheetProps } from "./types.ts";

type UserItem = Extract<DisplayItem, { kind: "user" }>;
type Outcome = { result?: RewindResult; error?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXCERPT_MAX = 80;

function excerpt(m: UserItem): string {
  const line = m.text.split("\n").find((l) => l.trim())?.trim() || (m.images ? `이미지 ${m.images}개` : m.files?.join(", ")) || "(내용 없음)";
  return line.length > EXCERPT_MAX ? `${line.slice(0, EXCERPT_MAX)}…` : line;
}

function when(ts?: string): string {
  const d = ts ? new Date(ts) : undefined;
  if (!d || Number.isNaN(d.getTime())) return "";
  return d.toDateString() === new Date().toDateString() ? clock(ts) : `${d.getMonth() + 1}월 ${d.getDate()}일 ${clock(ts)}`;
}

function relative(file: string, cwd?: string): string {
  return cwd && file.startsWith(cwd + "/") ? file.slice(cwd.length + 1) : shortPath(file);
}

function Preview({ outcome, cwd }: { outcome: Outcome; cwd?: string }) {
  const r = outcome.result;
  if (outcome.error) return <Failed text={outcome.error} />;
  if (!r) return null;
  if (!r.canRewind) return <Failed text={errorText(r.error ?? "이 시점으로는 되돌릴 수 없습니다")} />;
  if (!r.filesChanged?.length) return <div className="px-1 text-sm text-muted">이 시점 이후 바뀐 파일이 없습니다</div>;
  return (
    <div>
      <div className="px-1 text-sm">
        파일 {r.filesChanged.length}개 <span className="text-ok">+{r.insertions ?? 0}</span> <span className="text-danger">−{r.deletions ?? 0}</span>
      </div>
      <div className="mt-1.5 max-h-40 overflow-y-auto rounded-lg bg-code px-2.5 py-2 font-mono text-[12.5px] leading-relaxed break-all text-muted">
        {r.filesChanged.map((f) => (
          <div key={f}>{relative(f, cwd)}</div>
        ))}
      </div>
    </div>
  );
}

export function RewindSheet({ sessionId, onClose }: SheetProps) {
  const chat = useApp((s) => (s.chat?.sessionId === sessionId ? s.chat : undefined));
  const [selected, setSelected] = useState<string>();
  const [preview, setPreview] = useState<Outcome>();
  const [confirm, setConfirm] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<Outcome>();
  const latest = useRef<string | undefined>(undefined);

  const items = chat?.items;
  const messages = useMemo(() => (items ?? []).filter((i): i is UserItem => i.kind === "user" && UUID.test(i.id)).reverse(), [items]);
  const busy = Boolean(chat?.state?.busy);
  const cwd = chat?.state?.cwd;

  const pick = (id: string) => {
    if (applying) return;
    latest.current = id;
    setSelected(id);
    setPreview(undefined);
    setConfirm(false);
    setApplied(undefined);
    call(sessionId, "rewind", { userMessageId: id, dryRun: true }).then(
      (result) => latest.current === id && setPreview({ result }),
      (e: Error) => latest.current === id && setPreview({ error: errorText(e.message) }),
    );
  };

  const apply = (id: string) => {
    if (!confirm) {
      setConfirm(true);
      return;
    }
    setApplying(true);
    call(sessionId, "rewind", { userMessageId: id, dryRun: false })
      .then(
        (result) => setApplied({ result }),
        (e: Error) => setApplied({ error: errorText(e.message) }),
      )
      .finally(() => {
        setApplying(false);
        setConfirm(false);
      });
  };

  // A turn can change more files, so the preview is taken again when one ends.
  useEffect(() => {
    if (!busy && selected && !applied && !applying) pick(selected);
  }, [busy]);

  const changed = preview?.result?.canRewind ? (preview.result.filesChanged?.length ?? 0) : 0;

  return (
    <Sheet title="파일 되돌리기" onClose={onClose}>
      <p className="px-1 text-sm text-muted">
        고른 메시지를 보내기 전으로 파일을 되돌립니다. 대화는 그대로 남습니다. Claude가 편집 도구로 바꾼 파일만 되돌리고, 명령으로 바뀐 파일은 그대로 둡니다.
      </p>
      {messages.length === 0 && <div className="px-1 py-3 text-sm text-muted">보낸 메시지가 없습니다</div>}
      <div className="mt-3 space-y-2">
        {messages.map((m) => (
          <div key={m.id} className={`rounded-xl border ${selected === m.id ? "border-accent" : "border-line"} bg-surface`}>
            <button onClick={() => pick(m.id)} className="flex w-full items-start gap-3 px-3 py-2.5 text-left">
              <span className="min-w-0 flex-1 text-[15px]">{excerpt(m)}</span>
              <span className="shrink-0 pt-0.5 text-xs text-muted">{when(m.ts)}</span>
            </button>
            {selected === m.id && (
              <div className="space-y-2.5 border-t border-line px-3 py-2.5">
                {!preview && <Waiting text="바뀔 파일을 확인하는 중입니다" />}
                {preview && !applied && <Preview outcome={preview} cwd={cwd} />}
                {applied?.result && <div className="px-1 text-sm text-ok">파일 {changed}개를 되돌렸습니다</div>}
                {applied?.error && <Failed text={applied.error} />}
                {changed > 0 && !applied && (
                  <div className="flex items-center gap-2">
                    <SmallButton onClick={() => apply(m.id)} disabled={applying || busy} tone={confirm ? "text-danger" : ""}>
                      {applying ? "되돌리는 중…" : confirm ? "한 번 더 누르면 되돌립니다" : "이 시점으로 되돌리기"}
                    </SmallButton>
                    {confirm && !applying && (
                      <SmallButton onClick={() => setConfirm(false)} tone="text-muted">
                        취소
                      </SmallButton>
                    )}
                  </div>
                )}
                {changed > 0 && !applied && busy && <div className="px-1 text-xs text-muted">Claude가 작업 중입니다. 작업이 끝난 뒤 되돌릴 수 있습니다</div>}
              </div>
            )}
          </div>
        ))}
      </div>
    </Sheet>
  );
}
