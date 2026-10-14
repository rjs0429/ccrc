import { useState } from "react";
import type { DisplayItem } from "../../../../broker/src/protocol.ts";
import { errorText } from "../../labels.ts";
import { call } from "../../state.ts";
import { CommandBody } from "../Items.tsx";
import { Button, Sheet } from "../ui.tsx";
import { Failed, Waiting } from "./parts.tsx";

const RESUME_WAIT_MS = 60_000;

// A sheet that needs the session's process, while none runs: the user starts it here or leaves it be.
export function StoppedSheet({ sessionId, title, onClose }: { sessionId: string; title: string; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const resume = () => {
    setBusy(true);
    setError(undefined);
    call(sessionId, "resume", {}, RESUME_WAIT_MS)
      .catch((e: Error) => setError(errorText(e.message)))
      .finally(() => setBusy(false));
  };
  return (
    <Sheet title={title} onClose={onClose}>
      <p className="px-1 text-sm text-muted">이 세션은 지금 실행 중이 아닙니다. 보려면 이 세션을 원격에서 이어서 실행해야 합니다. 대화에는 아무것도 보내지 않습니다.</p>
      {error && (
        <div className="mt-3">
          <Failed text={error} />
        </div>
      )}
      <Button kind="primary" className="mt-4 w-full" disabled={busy} onClick={resume}>
        {busy ? "세션을 여는 중…" : "이어서 실행하고 보기"}
      </Button>
    </Sheet>
  );
}

// The result of a command sent from here that the conversation does not show.
export function CommandResultSheet({ title, item, late, onClose }: { title: string; item?: Extract<DisplayItem, { kind: "command" }>; late: boolean; onClose: () => void }) {
  const [more, setMore] = useState(false);
  return (
    <Sheet title={title} onClose={onClose}>
      {item ? (
        <div data-command-result={item.name ?? ""}>
          <CommandBody item={item} more={more || Boolean(item.context)} />
          {item.usage && item.text && (
            <div className="mt-3 flex justify-end">
              <button onClick={() => setMore(!more)} className="text-xs font-medium text-accent">
                {more ? "접기" : "원문"}
              </button>
            </div>
          )}
        </div>
      ) : late ? (
        <div className="px-1 py-3 text-sm text-muted">표시할 결과가 없습니다</div>
      ) : (
        <Waiting text="실행하는 중입니다" />
      )}
    </Sheet>
  );
}
