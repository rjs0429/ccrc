import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { SessionSummary } from "../../../broker/src/protocol.ts";
import { TITLE_MAX, cleanTitle } from "../../../broker/src/titles.ts";
import { worktreeOf } from "../../../broker/src/worktree-names.ts";
import { errorText, hostLabel, sessionTitle } from "../labels.ts";
import { call, patchSession, toast } from "../state.ts";
import { ArchiveWorktree } from "./sheets/Worktree.tsx";
import { Button, Choice, Sheet, Spinner } from "./ui.tsx";

type Target = Pick<SessionSummary, "id" | "title" | "state" | "host" | "archived"> & { cwd?: string };

const RENAME_HOW: Partial<Record<SessionSummary["state"], string>> = {
  owned: "Claude Code가 이름을 저장합니다.",
  attached: "VS Code 탭과 목록 이름도 바로 바뀝니다.",
  inactive: "세션을 실행하지 않고 이름만 바꿉니다.",
};

// Archives a session in ccrc or brings it back; the list follows at once.
export function setArchived(sessionId: string, on: boolean): void {
  call(sessionId, "archive", { archived: on }).then(
    () => {
      patchSession(sessionId, { archived: on || undefined });
      toast(on ? "보관했습니다" : "보관을 풀었습니다");
    },
    (e: Error) => toast(e.message),
  );
}

// Sits in a line of small text without making the line taller.
export function ArchivedBadge() {
  return <span className="-my-px shrink-0 rounded border border-line px-1 text-[11px] leading-4">보관됨</span>;
}

// Why the session cannot be renamed from here: a program ccrc cannot drive has it open.
export function renameBlocked(s: Pick<SessionSummary, "state" | "host">): string | undefined {
  return s.state === "live" ? `${hostLabel(s.host)}에서 열려 있어 여기서는 바꿀 수 없습니다` : undefined;
}

// A session's actions: the menu a long press opens and the rename step, which a tap on the chat title opens directly.
// The step that shows the field commits within the tap, as iOS raises the keyboard only for a focus made there.
// Archiving a session in a worktree goes through a step that offers to remove the worktree too.
export function SessionActions({ session, step: first, onClose }: { session: Target; step: "menu" | "rename" | "archive"; onClose: () => void }) {
  const [step, setStep] = useState(first);
  // The field starts from, and Save compares with, the name as Claude Code would keep it; a title the list made from
  // the first prompt can run past the limit.
  const current = cleanTitle(session.title);
  const [value, setValue] = useState(current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const next = cleanTitle(value);
  const ready = Boolean(next) && next !== current && !saving;
  const blocked = renameBlocked(session);

  useLayoutEffect(() => {
    const el = input.current;
    if (step !== "rename" || !el) return;
    el.focus();
    el.setSelectionRange(0, el.value.length);
  }, [step]);

  const save = () => {
    if (!ready) return;
    setSaving(true);
    setError(undefined);
    call(session.id, "rename", { title: next }).then(
      (r) => {
        patchSession(session.id, { title: r.title });
        onClose();
      },
      (e: Error) => {
        setError(errorText(e.message));
        setSaving(false);
      },
    );
  };

  if (step === "menu") {
    return (
      <Sheet title={sessionTitle(session)} onClose={onClose}>
        <Choice label="이름 바꾸기" hint={blocked ?? "VS Code 목록과 claude --resume에도 보입니다"} disabled={Boolean(blocked)} onClick={() => flushSync(() => setStep("rename"))} />
        <Choice
          label={session.archived ? "보관 해제" : "보관하기"}
          hint={
            session.archived ? (
              "목록에 다시 보입니다"
            ) : (
              <>
                <span className="block">ccrc 목록에서만 숨깁니다.</span>
                <span className="block">VS Code와 claude --resume에는 그대로 보입니다.</span>
              </>
            )
          }
          onClick={() => {
            if (!session.archived && session.cwd && worktreeOf(session.cwd)) return setStep("archive");
            setArchived(session.id, !session.archived);
            onClose();
          }}
        />
      </Sheet>
    );
  }
  if (step === "archive") return <ArchiveWorktree sessionId={session.id} onClose={onClose} />;
  return (
    <Sheet title="이름 바꾸기" onClose={onClose}>
      <input
        ref={input}
        value={value}
        onChange={(e) => setValue([...e.target.value].slice(0, TITLE_MAX).join(""))}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) save();
        }}
        aria-label="세션 이름"
        placeholder="세션 이름"
        enterKeyHint="done"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        className="w-full rounded-xl border border-line bg-bg px-3 py-2.5 text-[16px] outline-none focus:border-accent"
        data-rename-input
      />
      <div className={`mt-2 px-1 text-xs ${error ? "text-danger" : "text-muted"}`} data-rename-note>
        {error ?? RENAME_HOW[session.state]}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button onClick={onClose}>취소</Button>
        <Button kind="primary" disabled={!ready} onClick={save}>
          {saving ? <Spinner className="mx-auto size-5" /> : "저장"}
        </Button>
      </div>
    </Sheet>
  );
}
