import { useEffect, useMemo, useRef, useState } from "react";
import type { RewindConversationResult, RewindResult } from "../../../../broker/src/protocol.ts";
import { clock, errorText, hostLabel, shortPath } from "../../labels.ts";
import { call, composerInsert, navigate, toast, useApp } from "../../state.ts";
import { openNewSession } from "../../screens/NewSession.tsx";
import { loadDraft, saveDraft } from "../Composer.tsx";
import { NEW_SESSION_SCOPE, reattachMessage, useAttachments } from "../composer/attachments.ts";
import { actionable, excerpt, filesBack, filesDone, filesError, lastSeen, reattachNote, type UserMessage } from "../messageActions.ts";
import { Button, Sheet } from "../ui.tsx";
import { newId, startOf } from "./Fork.tsx";
import { Failed, Waiting } from "./parts.tsx";
import type { SheetProps } from "./types.ts";

type Outcome = { result?: RewindResult; error?: string };
type Way = "both" | "conversation" | "code";

const RESUME_WAIT_MS = 60_000;
// A rewind that cannot happen in place starts a copy of the conversation first.
const REWIND_WAIT_MS = 100_000;
const FILES_NOTE = "Claude가 편집 도구로 바꾼 파일만 되돌립니다. 명령(Bash)이나 직접 고친 파일, 백그라운드 에이전트가 고친 파일은 그대로입니다.";

function when(ts?: string): string {
  const d = ts ? new Date(ts) : undefined;
  if (!d || Number.isNaN(d.getTime())) return "";
  return d.toDateString() === new Date().toDateString() ? clock(ts) : `${d.getMonth() + 1}월 ${d.getDate()}일 ${clock(ts)}`;
}

function relative(file: string, cwd?: string): string {
  return cwd && file.startsWith(cwd + "/") ? file.slice(cwd.length + 1) : shortPath(file);
}

const folderOf = (file: string) => file.slice(0, file.lastIndexOf("/")) || "/";

// A failure in a panel of choices, told apart from them.
function Trouble({ text }: { text: string }) {
  return (
    <p className="px-1 text-sm text-danger" role="alert">
      {text}
    </p>
  );
}

function Preview({ outcome, cwd, outside }: { outcome: Outcome; cwd?: string; outside: string[] }) {
  const r = outcome.result;
  if (outcome.error) return <Trouble text={outcome.error} />;
  if (!r) return null;
  if (!r.canRewind) return <div className="px-1 text-sm text-muted">{errorText(r.error ?? "이 시점으로는 코드를 되돌릴 수 없습니다")}</div>;
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
      {outside.length > 0 && (
        <p className="mt-1.5 px-1 text-xs text-warn" data-rewind-outside>
          다른 폴더의 파일도 되돌립니다: {[...new Set(outside.map(folderOf))].map(shortPath).join(", ")}
        </p>
      )}
      <p className="mt-1.5 px-1 text-xs text-muted">{FILES_NOTE}</p>
    </div>
  );
}

// One way to rewind. A tap arms it and the next one does it; one that touches files outside the session's folder asks once more.
function Option({ label, hint, armed, busy, disabled, onClick }: { label: string; hint: string; armed?: string; busy: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex min-h-11 w-full flex-col justify-center rounded-xl px-3 py-2 text-left disabled:opacity-40 ${armed ? "bg-danger/10" : "bg-surface-2 enabled:active:bg-line"}`}
      data-rewind-way={label}
    >
      <span className={`text-[15px] font-medium ${armed ? "text-danger" : ""}`}>{busy ? "되돌리는 중…" : (armed ?? label)}</span>
      <span className="text-xs text-muted">{hint}</span>
    </button>
  );
}

// Takes the conversation, the code or both back to before a message the user sent. Where ccrc runs the session this
// happens in place, a stopped one first being started here; a session VS Code or another program runs keeps its
// conversation, and the rewound one opens as a new session.
export function RewindSheet({ sessionId, initial, onClose }: SheetProps & { initial?: string }) {
  const chat = useApp((s) => (s.chat?.sessionId === sessionId ? s.chat : undefined));
  const [selected, setSelected] = useState<string>();
  const [preview, setPreview] = useState<Outcome>();
  const [armed, setArmed] = useState<{ way: Way; step: number }>();
  const [applying, setApplying] = useState<Way | null>(null);
  const [applied, setApplied] = useState<Outcome>();
  const [error, setError] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [forkId, setForkId] = useState(newId);
  const latest = useRef<string | undefined>(undefined);
  const chosen = useRef<HTMLDivElement>(null);

  const items = chat?.items;
  const messages = useMemo(() => (items ?? []).filter((i): i is UserMessage => i.kind === "user" && actionable(i)).reverse(), [items]);
  const st = chat?.state;
  const kind = st?.state ?? "inactive";
  const controllable = kind === "owned" || kind === "attached";
  const busy = Boolean(st?.busy);
  const cwd = st?.cwd;
  const folderMissing = kind === "inactive" && Boolean(st?.folderMissing);
  const files = preview?.result?.canRewind ? (preview.result.filesChanged ?? []) : [];
  const outside = cwd ? files.filter((f) => !f.startsWith(cwd + "/")) : [];

  const pick = (id: string) => {
    if (applying) return;
    latest.current = id;
    setSelected(id);
    setPreview(undefined);
    setArmed(undefined);
    setApplied(undefined);
    setError(undefined);
    setForkId(newId());
    if (kind !== "owned" && kind !== "attached") return;
    call(sessionId, "rewind", { userMessageId: id, dryRun: true }).then(
      (result) => latest.current === id && setPreview({ result }),
      (e: Error) => latest.current === id && setPreview({ error: errorText(e.message) }),
    );
  };

  // A turn can change more files, so the preview is taken again when one ends; a session started here gets its first.
  useEffect(() => {
    if (selected && controllable && !busy && !applied && !applying) pick(selected);
  }, [busy, controllable]);

  useEffect(() => {
    if (initial) pick(initial);
  }, []);

  useEffect(() => {
    if (selected && selected === initial) chosen.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const resume = () => {
    setStarting(true);
    setError(undefined);
    call(sessionId, "resume", {}, RESUME_WAIT_MS)
      .catch((e: Error) => setError(errorText(e.message)))
      .finally(() => setStarting(false));
  };

  // The composer that gets the message back holds its text and, uploaded again, its images and documents in place of what
  // it had; what could not be attached is told with the outcome.
  const done = (r: RewindConversationResult, message?: UserMessage) => {
    const filesFailed = r.files && !r.files.canRewind ? filesError(r.files) : undefined;
    onClose();
    let said: string;
    if (r.mode === "in_place") {
      if (r.prefill) composerInsert(r.prefill, true);
      said = filesFailed ? `대화는 되돌렸지만 파일은 되돌리지 못했습니다: ${filesFailed}` : `되돌렸습니다${r.files?.canRewind ? filesDone(r.files, files.length) : ""}`;
    } else {
      if (r.mode === "draft") openNewSession(r.cwd, r.prefill, startOf(st));
      else {
        saveDraft(r.sessionId, r.prefill);
        navigate({ name: "chat", sessionId: r.sessionId });
      }
      const opened =
        r.mode === "draft" ? "첫 메시지라 같은 폴더의 새 세션으로 엽니다" : r.fallback ? "이 Claude Code는 제자리 되돌리기를 지원하지 않아 새 세션으로 열었습니다" : "새 세션으로 열었습니다";
      said = filesFailed ? `${opened}. 파일은 되돌리지 못했습니다: ${filesFailed}` : r.files?.canRewind ? `${opened}. ${filesBack(r.files, files.length)}` : opened;
    }
    const list = message?.attachments ?? [];
    if (!message || (!list.length && !r.prefill)) return toast(said);
    const scope = r.mode === "in_place" ? sessionId : r.mode === "draft" ? NEW_SESSION_SCOPE : r.sessionId;
    void reattachMessage(scope, sessionId, message.id, list, true).then((failed) => {
      const note = reattachNote(failed);
      toast(note ? `${said}. ${note}` : said);
    });
  };

  const apply = (id: string, way: Way) => {
    const steps = way !== "conversation" && outside.length ? 3 : 2;
    const step = armed?.way === way ? armed.step + 1 : 1;
    if (step < steps) {
      setArmed({ way, step });
      return;
    }
    setArmed(undefined);
    setApplying(way);
    setError(undefined);
    if (way === "code") {
      call(sessionId, "rewind", { userMessageId: id, dryRun: false })
        .then(
          (result) => setApplied({ result }),
          (e: Error) => setApplied({ error: errorText(e.message) }),
        )
        .finally(() => setApplying(null));
      return;
    }
    const seen = lastSeen(items ?? []);
    const message = messages.find((m) => m.id === id);
    call(sessionId, "rewind_conversation", { userMessageId: id, choice: way, ...(seen ? { lastSeen: seen } : {}), forkId }, REWIND_WAIT_MS).then(
      (r) => done(r, message),
      (e: Error) => {
        setError(errorText(e.message));
        setApplying(null);
      },
    );
  };

  const inPlace = kind === "owned";
  const elsewhere = kind === "attached" ? "VS Code" : hostLabel(st?.host);
  const composerFiles = useAttachments(sessionId);
  const draft = inPlace && (Boolean(loadDraft(sessionId).trim()) || composerFiles.length > 0);
  const armedText = (way: Way) => (armed?.way !== way ? undefined : way !== "conversation" && outside.length && armed.step === 1 ? "다른 폴더의 파일도 되돌립니다 · 한 번 더 누르세요" : "한 번 더 누르면 되돌립니다");
  const ways: { way: Way; label: string; hint: string; disabled: boolean }[] =
    kind === "live"
      ? [{ way: "conversation", label: "대화만 되돌리기 (새 세션)", hint: `${elsewhere}의 대화와 파일은 그대로입니다`, disabled: false }]
      : [
          ...(files.length
            ? [
                {
                  way: "both" as const,
                  label: inPlace ? "대화와 코드 되돌리기" : "대화와 코드 되돌리기 (새 세션)",
                  hint: inPlace ? "대화와 그 뒤에 바뀐 파일을 이 메시지 앞으로 되돌립니다" : "새 세션으로 열고 그 뒤에 바뀐 파일도 되돌립니다",
                  disabled: busy,
                },
              ]
            : []),
          {
            way: "conversation",
            label: inPlace ? "대화만 되돌리기" : "대화만 되돌리기 (새 세션)",
            hint: inPlace ? "파일은 그대로 둡니다" : "새 세션으로 엽니다. 파일은 그대로 둡니다",
            disabled: inPlace && busy,
          },
          ...(files.length ? [{ way: "code" as const, label: "코드만 되돌리기", hint: "대화는 그대로 둡니다", disabled: busy }] : []),
        ];

  return (
    <Sheet title="되돌리기" onClose={onClose}>
      <p className="px-1 text-sm text-muted" data-rewind-about>
        {kind === "live"
          ? `${elsewhere}에서 열려 있어 대화만 새 세션으로 되돌릴 수 있습니다. 파일은 되돌릴 수 없습니다.`
          : kind === "attached"
            ? "VS Code 대화는 그대로 두고, 고른 메시지 앞까지를 새 세션으로 엽니다. 코드는 VS Code 세션에서 되돌립니다."
            : "고른 메시지를 보내기 전으로 대화와 코드를 되돌립니다."}
      </p>
      {folderMissing && (
        <div className="mt-3">
          <Failed text="작업 폴더가 없어 되돌릴 수 없습니다" />
        </div>
      )}
      {kind === "inactive" && !folderMissing && (
        <div className="mt-3 rounded-xl bg-surface-2 px-3 py-2.5" data-rewind-resume>
          <p className="text-sm text-muted">되돌리려면 이 세션을 원격에서 이어서 실행합니다. 대화에는 아무것도 보내지 않습니다.</p>
          <Button kind="primary" className="mt-2.5 w-full" disabled={starting} onClick={resume}>
            {starting ? "세션을 여는 중…" : "이어서 실행"}
          </Button>
        </div>
      )}
      {error && !selected && (
        <div className="mt-3">
          <Failed text={error} />
        </div>
      )}
      {messages.length === 0 && <div className="px-1 py-3 text-sm text-muted">보낸 메시지가 없습니다</div>}
      <div className="mt-3 space-y-2">
        {messages.map((m) => (
          <div key={m.id} ref={selected === m.id ? chosen : undefined} className={`rounded-xl border ${selected === m.id ? "border-accent" : "border-line"} bg-surface`} data-rewind-message={m.id}>
            <button onClick={() => pick(m.id)} className="flex w-full items-start gap-3 px-3 py-2.5 text-left">
              <span className="min-w-0 flex-1 text-[15px]">{excerpt(m)}</span>
              <span className="shrink-0 pt-0.5 text-xs text-muted">{when(m.ts)}</span>
            </button>
            {selected === m.id && (kind !== "inactive" || error) && (
              <div className="space-y-2.5 border-t border-line px-3 py-2.5">
                {controllable && !preview && <Waiting text="바뀔 파일을 확인하는 중입니다" />}
                {controllable && preview && !applied && <Preview outcome={preview} cwd={cwd} outside={outside} />}
                {applied?.result?.canRewind && <div className="px-1 text-sm text-ok">{filesBack(applied.result, files.length)}</div>}
                {applied?.result && !applied.result.canRewind && <Trouble text={`파일을 되돌리지 못했습니다: ${filesError(applied.result)}`} />}
                {applied?.error && <Trouble text={applied.error} />}
                {error && <Trouble text={error} />}
                {busy && !applied && kind !== "live" && <div className="px-1 text-xs text-muted">Claude가 작업 중입니다. {inPlace ? "작업이 끝난 뒤 되돌릴 수 있습니다" : "코드는 작업이 끝난 뒤 되돌릴 수 있습니다"}</div>}
                {draft && !applied && (
                  <div className="px-1 text-xs text-muted">
                    {composerFiles.length ? "대화를 되돌리면 입력창의 글과 첨부가 이 메시지 것으로 바뀝니다" : "대화를 되돌리면 입력창의 글이 이 메시지 글로 바뀝니다"}
                  </div>
                )}
                {!applied && (preview || !controllable) && kind !== "inactive" && (
                  <div className="space-y-1.5">
                    {ways.map((w) => (
                      <Option
                        key={w.way}
                        label={w.label}
                        hint={w.hint}
                        armed={armedText(w.way)}
                        busy={applying === w.way}
                        disabled={w.disabled || Boolean(applying)}
                        onClick={() => apply(m.id, w.way)}
                      />
                    ))}
                    {armed && !applying && (
                      <button onClick={() => setArmed(undefined)} className="min-h-11 w-full rounded-xl text-sm font-medium text-muted">
                        취소
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </Sheet>
  );
}
