import { useRef, useState } from "react";
import { PERMISSION_MODES, type LiveState, type PermissionModeName, type StartSettings } from "../../../../broker/src/protocol.ts";
import { errorText, shortPath } from "../../labels.ts";
import { rememberSent } from "../../sentPreviews.ts";
import { call, navigate, toast, useApp } from "../../state.ts";
import { openNewSession } from "../../screens/NewSession.tsx";
import { saveDraft } from "../Composer.tsx";
import { AttachmentChips } from "../composer/AttachmentChips.tsx";
import { ATTACH_ACCEPT, NEW_SESSION_SCOPE, addFiles, moveAttachments, takeAttachments, useAttachments } from "../composer/attachments.ts";
import { afterKeyboard } from "../composer/picker.ts";
import type { UserMessage } from "../messageActions.ts";
import { Button, Icon, Sheet, Spinner } from "../ui.tsx";
import { Failed } from "./parts.tsx";

// Claude Code starts the copy and names it before the fork is there.
const FORK_WAIT_MS = 100_000;

// A new session's id, which the phone chooses so that asking again gives the same fork.
export function newId(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// What a session the copy stands in for starts with: the session's own choices, never Fast mode.
export function startOf(st?: LiveState): StartSettings {
  if (!st) return {};
  if (st.state === "inactive") {
    const { fast: _fast, ...rest } = st.start ?? {};
    return rest;
  }
  return {
    ...(st.model ? { model: st.model } : {}),
    ...(PERMISSION_MODES.includes(st.permissionMode as PermissionModeName) ? { mode: st.permissionMode as PermissionModeName } : {}),
    ...(st.effort ? { effort: st.effort as StartSettings["effort"] } : {}),
    ...(st.ultracode ? { ultracode: true } : {}),
    ...(st.thinking === false ? { thinking: false } : {}),
  };
}

// Copies the conversation into a new session ccrc runs, up to a message or as it stands, and either starts it with a
// message while the phone stays here or opens it with the message waiting in its composer.
export function ForkSheet({ sessionId, before, text: given, onClose }: { sessionId: string; before?: UserMessage; text?: string; onClose: () => void }) {
  const chat = useApp((s) => (s.chat?.sessionId === sessionId ? s.chat : undefined));
  const summary = useApp((s) => s.sessions?.find((x) => x.id === sessionId));
  const st = chat?.state;
  const kind = st?.state ?? summary?.state ?? "inactive";
  const busy = Boolean(st ? st.busy : summary?.busy);
  const cwd = st?.cwd ?? summary?.cwd ?? "";
  const folderMissing = kind === "inactive" && Boolean(st ? st.folderMissing : summary?.folderMissing);
  const fast = st?.fastMode === "on" || st?.fastMode === "cooldown" || st?.fastWanted === true || (kind === "inactive" && st?.start?.fast === true);
  const scope = `fork:${sessionId}`;
  const [id] = useState(newId);
  const [text, setText] = useState(given ?? before?.text ?? "");
  const [going, setGoing] = useState<"open" | "start" | null>(null);
  const [error, setError] = useState<string>();
  const attachments = useAttachments(scope);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const uploading = attachments.some((a) => !a.uploaded);
  const filled = text.trim() !== "" || attachments.length > 0;
  const blocked = folderMissing || uploading || Boolean(going);

  const attach = () => {
    const input = fileRef.current;
    if (!input || going) return;
    const keyboard = document.documentElement.hasAttribute("data-keyboard");
    inputRef.current?.blur();
    if (keyboard) afterKeyboard(() => input.click());
    else input.click();
  };

  const go = (start: boolean) => {
    if (blocked || (start && !filled)) return;
    setGoing(start ? "start" : "open");
    setError(undefined);
    const message = text.trim();
    const ids = start ? attachments.map((a) => a.uploaded!.id) : [];
    const args = { id, ...(before ? { before: before.id } : {}), ...(start && message ? { text: message } : {}), ...(ids.length ? { attachments: ids } : {}) };
    call(sessionId, "fork", args, FORK_WAIT_MS).then(
      (r) => {
        onClose();
        if ("draft" in r) {
          moveAttachments(scope, NEW_SESSION_SCOPE);
          openNewSession(r.draft.cwd, text, startOf(st));
          toast("첫 메시지라 같은 폴더의 새 세션으로 엽니다");
        } else if (start) {
          rememberSent(r.sessionId, message, takeAttachments(scope));
          toast("갈래를 시작했습니다", { label: "열기", run: () => navigate({ name: "chat", sessionId: r.sessionId }) });
        } else {
          saveDraft(r.sessionId, text);
          moveAttachments(scope, r.sessionId);
          navigate({ name: "chat", sessionId: r.sessionId });
        }
      },
      (e: Error) => {
        setError(errorText(e.message));
        setGoing(null);
      },
    );
  };

  return (
    <Sheet title="갈래 만들기" onClose={onClose}>
      <p className="px-1 text-sm text-muted" data-fork-about>
        <span className="block">
          {before ? "이 메시지 앞까지의 대화를 새 세션으로 복사합니다." : "지금까지의 대화를 새 세션으로 복사합니다."}
          {!before && busy && " 지금 돌고 있는 턴은 빼고 복사합니다."}
        </span>
        <span className="block">원래 세션은 그대로입니다.</span>
      </p>
      <p className="mt-1 px-1 text-xs text-muted">
        갈래는 원격 세션으로 돌며 권한 모드, 모델, Effort를 이어받습니다.{fast && " Fast 모드는 끄고 시작합니다."}
      </p>
      {folderMissing ? (
        <div className="mt-3">
          <Failed text={`작업 폴더가 없어 갈래를 만들 수 없습니다: ${shortPath(cwd)}`} />
        </div>
      ) : (
        <div className="mt-3 rounded-2xl border border-line bg-bg px-3 pt-2.5 pb-1 focus-within:border-accent">
          <AttachmentChips scope={scope} items={attachments} locked={Boolean(going)} />
          <textarea
            ref={inputRef}
            value={text}
            rows={3}
            readOnly={Boolean(going)}
            onChange={(e) => setText(e.target.value)}
            aria-label="갈래에서 할 일"
            placeholder="갈래에서 할 일 (비우면 기다립니다)"
            className="block max-h-[30vh] w-full resize-none bg-transparent text-[16px] leading-relaxed outline-none placeholder:text-muted"
            data-fork-text
          />
          <span className="relative -ml-1.5 inline-flex">
            <button
              aria-label="파일 첨부"
              onClick={attach}
              disabled={Boolean(going)}
              className="flex size-11 items-center justify-center rounded-lg text-muted hover:bg-surface-2 disabled:opacity-50"
            >
              <Icon.paperclip className="size-[18px]" />
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept={ATTACH_ACCEPT}
              tabIndex={-1}
              aria-hidden
              onChange={(e) => {
                const picked = [...(e.target.files ?? [])];
                e.target.value = "";
                if (picked.length) addFiles(scope, picked);
              }}
              className="pointer-events-none absolute inset-0 size-full opacity-0"
            />
          </span>
        </div>
      )}
      {error && (
        <div className="mt-3">
          <Failed text={error} />
        </div>
      )}
      <div className="mt-3 grid grid-cols-2 gap-x-2 gap-y-1 text-center text-xs text-muted">
        <Button disabled={blocked} onClick={() => go(false)}>
          {going === "open" ? <Spinner className="mx-auto size-5" /> : "갈래 열기"}
        </Button>
        <Button kind="primary" disabled={blocked || !filled} onClick={() => go(true)}>
          {going === "start" ? <Spinner className="mx-auto size-5" /> : "백그라운드로 시작"}
        </Button>
        <span>보내지 않고 갈래로 갑니다</span>
        <span>보내고 이 화면에 남습니다</span>
      </div>
    </Sheet>
  );
}
