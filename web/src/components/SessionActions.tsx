import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { SessionSummary } from "../../../broker/src/protocol.ts";
import { TITLE_MAX, cleanTitle } from "../../../broker/src/titles.ts";
import { worktreeOf } from "../../../broker/src/worktree-names.ts";
import { k, t } from "../i18n/index.ts";
import { errorText, hostLabel, sessionTitle } from "../labels.ts";
import { call, patchSession, toast } from "../state.ts";
import { ArchiveWorktree } from "./sheets/Worktree.tsx";
import { Button, Choice, Sheet, Spinner } from "./ui.tsx";

type Target = Pick<SessionSummary, "id" | "title" | "state" | "host" | "archived" | "vscodeArchived" | "unread"> & { cwd?: string };

const RENAME_HOW: Partial<Record<SessionSummary["state"], string>> = {
  owned: k("Claude Code가 이름을 저장합니다."),
  attached: k("VS Code 탭과 목록 이름도 바로 바뀝니다."),
  inactive: k("세션을 실행하지 않고 이름만 바꿉니다."),
};

// Archives a session in ccrc or brings it back; the list follows at once. vscode: VS Code archived it, and keeps it so.
export function setArchived(sessionId: string, on: boolean, vscode = false): void {
  call(sessionId, "archive", { archived: on }).then(
    () => {
      patchSession(sessionId, { archived: on || undefined });
      toast(on ? t("보관했습니다") : vscode ? t("보관을 풀었습니다 · VS Code에서는 그대로 보관됩니다") : t("보관을 풀었습니다"));
    },
    (e: Error) => toast(e.message),
  );
}

// Marks a session unread until it is opened again, or read; the list follows at once. Resolves to whether it took.
export function setUnread(sessionId: string, on: boolean): Promise<boolean> {
  return call(sessionId, "mark_unread", { unread: on }).then(
    () => {
      patchSession(sessionId, { unread: on || undefined });
      toast(on ? t("읽지 않음으로 표시했습니다") : t("읽음으로 표시했습니다"));
      return true;
    },
    (e: Error) => {
      toast(errorText(e.message));
      return false;
    },
  );
}

// Sits in a line of small text without making the line taller.
export function ArchivedBadge({ vscode = false }: { vscode?: boolean }) {
  return <span className="-my-px shrink-0 rounded border border-line px-1 text-[11px] leading-4">{vscode ? t("VS Code 보관") : t("보관됨")}</span>;
}

// Why the session cannot be renamed from here: a program ccrc cannot drive has it open.
export function renameBlocked(s: Pick<SessionSummary, "state" | "host">): string | undefined {
  return s.state === "live" ? t("{host}에서 열려 있어 여기서는 바꿀 수 없습니다", { host: hostLabel(s.host) }) : undefined;
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
        <Choice label={t("이름 바꾸기")} hint={blocked ?? t("VS Code 목록과 claude --resume에도 보입니다")} disabled={Boolean(blocked)} onClick={() => flushSync(() => setStep("rename"))} />
        <Choice
          label={session.archived ? t("보관 해제") : t("보관하기")}
          hint={
            session.archived ? (
              session.vscodeArchived ? (
                <>
                  <span className="block">{t("목록에 다시 보입니다.")}</span>
                  <span className="block">{t("VS Code에서는 그대로 보관됩니다.")}</span>
                </>
              ) : (
                t("목록에 다시 보입니다")
              )
            ) : (
              <>
                <span className="block">{t("ccrc 목록에서만 숨깁니다.")}</span>
                <span className="block">{t("VS Code와 claude --resume에는 그대로 보입니다.")}</span>
              </>
            )
          }
          onClick={() => {
            if (!session.archived && session.cwd && worktreeOf(session.cwd)) return setStep("archive");
            setArchived(session.id, !session.archived, session.vscodeArchived);
            onClose();
          }}
        />
        <Choice
          label={session.unread ? t("읽음으로 표시") : t("읽지 않음으로 표시")}
          hint={session.unread ? t("목록의 점을 지웁니다") : t("다시 열 때까지 목록에 점이 남습니다")}
          onClick={() => {
            void setUnread(session.id, !session.unread);
            onClose();
          }}
        />
      </Sheet>
    );
  }
  if (step === "archive") return <ArchiveWorktree sessionId={session.id} onClose={onClose} />;
  const how = RENAME_HOW[session.state];
  return (
    <Sheet title={t("이름 바꾸기")} onClose={onClose}>
      <input
        ref={input}
        value={value}
        onChange={(e) => setValue([...e.target.value].slice(0, TITLE_MAX).join(""))}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) save();
        }}
        aria-label={t("세션 이름")}
        placeholder={t("세션 이름")}
        enterKeyHint="done"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        className="w-full rounded-xl border border-line bg-bg px-3 py-2.5 text-[16px] outline-none focus:border-accent"
        data-rename-input
      />
      <div className={`mt-2 px-1 text-xs ${error ? "text-danger" : "text-muted"}`} data-rename-note>
        {error ?? (how && t(how))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button onClick={onClose}>{t("취소")}</Button>
        <Button kind="primary" disabled={!ready} onClick={save}>
          {saving ? <Spinner className="mx-auto size-5" /> : t("저장")}
        </Button>
      </div>
    </Sheet>
  );
}
