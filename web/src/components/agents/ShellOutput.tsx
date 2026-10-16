import { useLayoutEffect, useRef, useState } from "react";
import type { TaskInfo } from "../../../../broker/src/protocol.ts";
import { errorText, sizeText } from "../../labels.ts";
import { call } from "../../state.ts";
import { cleanOutput } from "./output.ts";
import { usePolling } from "./poll.ts";

const NEAR_BOTTOM_PX = 24;

interface Shown {
  text: string;
  bytes: number;
  totalBytes: number;
  truncated: boolean;
}

function Output({ sessionId, task }: { sessionId: string; task: TaskInfo }) {
  const running = task.status === "running";
  const [shown, setShown] = useState<Shown>();
  const [error, setError] = useState<string>();
  const pre = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  const read = async () => {
    try {
      const r = await call(sessionId, "task_output", { taskId: task.id });
      setShown({ text: cleanOutput(r.text, r.truncated), bytes: new TextEncoder().encode(r.text).length, totalBytes: r.totalBytes, truncated: r.truncated });
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  // A wrapper that refuses the request refuses it for as long as it runs.
  const refused = error !== undefined && /request not allowed/.test(error);
  usePolling(read, running, `${sessionId}|${task.id}`, !refused);
  useLayoutEffect(() => {
    if (pre.current && follow.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [shown?.text]);

  return (
    <div className="mt-4" data-shell-output>
      <div className="text-xs font-semibold text-muted">출력</div>
      {shown === undefined && !error && <div className="mt-1 text-sm text-muted">출력을 불러오는 중…</div>}
      {shown !== undefined && !shown.text && <div className="mt-1 text-sm text-muted">{running ? "아직 출력이 없습니다" : "출력이 없습니다"}</div>}
      {shown?.text && (
        <pre
          ref={pre}
          tabIndex={0}
          onScroll={(e) => {
            const el = e.currentTarget;
            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
          }}
          className="mt-1 max-h-[50vh] overflow-auto overscroll-contain rounded-lg bg-code p-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all"
        >
          {shown.text}
        </pre>
      )}
      {shown?.truncated && (
        <div className="mt-1 text-xs text-muted">
          끝부분 {sizeText(shown.bytes)}만 보입니다 (전체 {sizeText(shown.totalBytes)})
        </div>
      )}
      {error && (
        <div className="mt-1 text-sm break-keep text-muted" data-shell-output-error>
          {refused ? "VS Code에서 Claude Code를 다시 띄우면 출력을 볼 수 있습니다." : `출력을 볼 수 없습니다. ${errorText(error)}`}
        </div>
      )}
    </div>
  );
}

// A shell's or monitor's output under its card, read again while it runs. A foreground command's output is not kept
// apart; it shows up where the command was run from.
export function ShellOutput({ sessionId, task, onAgent }: { sessionId: string; task: TaskInfo; onAgent?: () => void }) {
  if (task.background !== false) return <Output sessionId={sessionId} task={task} />;
  return (
    <div className="mt-4 rounded-xl bg-surface-2 px-3 py-2.5 text-sm" data-shell-foreground>
      <p className="break-keep text-muted">포그라운드 명령입니다. 끝나면 결과가 대화나 띄운 에이전트의 기록에 나옵니다.</p>
      {onAgent && (
        <button onClick={onAgent} className="mt-1 min-h-11 font-medium text-accent">
          띄운 에이전트 기록 보기 ›
        </button>
      )}
    </div>
  );
}
