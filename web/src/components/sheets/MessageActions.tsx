import type { SessionState } from "../../../../broker/src/protocol.ts";
import { hostLabel } from "../../labels.ts";
import { toast } from "../../state.ts";
import { excerpt, type UserMessage } from "../messageActions.ts";
import { Choice, Sheet } from "../ui.tsx";

// Where the session runs decides how a message's conversation is taken back: in place where ccrc runs it (after starting
// a stopped one), else in a new session that leaves the other program's conversation as it is.
function redoHint(kind: SessionState, busy: boolean, host?: string): string {
  if (kind === "owned") return busy ? "작업이 끝난 뒤 다시 할 수 있습니다" : "이 메시지 앞으로 대화를 되돌리고 글을 입력창에 넣습니다";
  if (kind === "inactive") return "세션을 이어서 실행한 뒤 이 메시지 앞으로 되돌립니다";
  return `${kind === "attached" ? "VS Code" : hostLabel(host)} 대화는 그대로 두고, 이 메시지 앞까지를 새 세션으로 엽니다`;
}

// What a message the user sent offers: a fork that ends before it, taking the conversation back to before it, its text.
export function MessageActionsSheet({
  message,
  kind,
  busy,
  host,
  cannot,
  onFork,
  onRedo,
  onClose,
}: {
  message: UserMessage;
  kind: SessionState;
  busy: boolean;
  host?: string;
  // Why nothing can start from this session, such as its folder being gone.
  cannot?: string;
  onFork: () => void;
  onRedo: () => void;
  onClose: () => void;
}) {
  const copy = () => {
    onClose();
    if (!navigator.clipboard) return toast("글을 복사하지 못했습니다");
    navigator.clipboard.writeText(message.text).then(
      () => toast("글을 복사했습니다"),
      () => toast("글을 복사하지 못했습니다"),
    );
  };
  return (
    <Sheet title="메시지" onClose={onClose}>
      <p className="mb-2 line-clamp-3 rounded-xl bg-surface-2 px-3 py-2 text-sm whitespace-pre-wrap" data-message-excerpt>
        {message.text || excerpt(message)}
      </p>
      <Choice label="여기서 갈래 만들기" hint={cannot ?? "이 메시지 앞까지의 대화를 새 세션으로 복사합니다"} disabled={Boolean(cannot)} onClick={onFork} />
      <Choice label="여기서 다시 하기" hint={cannot ?? redoHint(kind, busy, host)} disabled={Boolean(cannot) || (kind === "owned" && busy)} onClick={onRedo} />
      {message.text && <Choice label="글 복사" onClick={copy} />}
    </Sheet>
  );
}
