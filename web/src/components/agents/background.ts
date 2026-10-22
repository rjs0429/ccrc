import { useEffect, useState } from "react";
import type { TaskInfo } from "../../../../broker/src/protocol.ts";
import { k, t } from "../../i18n/index.ts";
import { errorText } from "../../labels.ts";
import { call, toast, useApp } from "../../state.ts";

// Claude Code lists a Bash command the turn waits on once it has run this long, and a subagent as it starts, which is
// offered to move once it has run as long.
const FOREGROUND_MS = 2000;
export const OLD_WRAPPER_NOTE = k("VS Code에서 Claude Code를 다시 띄우면 백그라운드로 보낼 수 있습니다.");
const MOVED_KEEP = 200;
// A call's result when it went on in the background without being started there.
const MOVED_RESULT = /^Command (?:was manually backgrounded|did not complete within)|moved to the background/;

// Calls moved to the background from here, by session and call.
const moved = new Set<string>();
const movedKey = (sessionId: string | undefined, toolUseId: string) => `${sessionId ?? ""}|${toolUseId}`;

// Whether a call runs in the background now, moved there after it started.
export function movedOut(sessionId: string | undefined, toolUseId: string, task: TaskInfo | undefined, result?: string): boolean {
  if (task?.status !== "running") return false;
  return moved.has(movedKey(sessionId, toolUseId)) || (task.background === true && MOVED_RESULT.test(result ?? ""));
}

// What can move a call the turn waits on to the background, here: a session this phone drives, its wrapper new enough,
// and the call listed as running in the foreground for a while.
export function useMovable(task: TaskInfo | undefined): { movable: boolean; old: boolean } {
  const sessionId = useApp((s) => s.chat?.sessionId);
  const kind = useApp((s) => s.chat?.state?.state);
  const old = useApp((s) => s.chat?.state?.backgroundUnknown === true);
  const stateAt = useApp((s) => s.chat?.stateAt);
  const foreground = task?.status === "running" && task.background === false && Boolean(task.toolUseId) && !moved.has(movedKey(sessionId, task.toolUseId!));
  const due = foreground ? (stateAt ?? Date.now()) - (task!.ms ?? 0) + (task!.kind === "local_bash" ? 0 : FOREGROUND_MS) : undefined;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (due === undefined || due <= Date.now()) return;
    const t = setTimeout(() => setNow(Date.now()), due - Date.now());
    return () => clearTimeout(t);
  }, [due]);
  const ready = foreground && (kind === "owned" || kind === "attached") && due !== undefined && due <= Math.max(now, Date.now());
  return { movable: ready && !old, old: ready && old };
}

// Moves a call to the background; the turn goes on, and its card says where it runs.
export function useMove(sessionId: string | undefined): { moving: boolean; move: (toolUseId: string) => void } {
  const [moving, setMoving] = useState(false);
  const move = (toolUseId: string) => {
    if (!sessionId || moving) return;
    setMoving(true);
    call(sessionId, "background", { toolUseId })
      .then(
        (r) => {
          if (!r.backgrounded) return toast(t("이미 끝났거나 백그라운드에서 실행 중입니다"));
          moved.add(movedKey(sessionId, toolUseId));
          for (const old of [...moved].slice(0, -MOVED_KEEP)) moved.delete(old);
        },
        (e: Error) => toast(errorText(e.message)),
      )
      .finally(() => setMoving(false));
  };
  return { moving, move };
}
