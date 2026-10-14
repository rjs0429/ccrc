import { useState } from "react";
import type { TaskInfo } from "../../../../broker/src/protocol.ts";
import { errorText } from "../../labels.ts";
import { call, useApp } from "../../state.ts";
import { Sheet } from "../ui.tsx";
import { SmallButton } from "./parts.tsx";
import type { SheetProps } from "./types.ts";

const TYPE_LABEL: Record<string, string> = {
  local_agent: "서브에이전트",
  local_bash: "셸 (Bash)",
  local_workflow: "워크플로",
  remote_agent: "원격 에이전트",
  monitor_mcp: "모니터",
  mcp_task: "MCP 작업",
  in_process_teammate: "팀원",
};

const STATUS: Record<TaskInfo["status"], [label: string, dot: string]> = {
  running: ["실행 중", "bg-accent animate-pulse"],
  completed: ["완료", "bg-ok"],
  failed: ["실패", "bg-danger"],
  stopped: ["중지됨", "border border-muted"],
};

function TaskRow({ task, stopping, error, onStop }: { task: TaskInfo; stopping: boolean; error?: string; onStop: () => void }) {
  const [label, dot] = STATUS[task.status] ?? [task.status, "border border-muted"];
  const meta = [task.type ? (TYPE_LABEL[task.type] ?? task.type) : "", label].filter(Boolean).join(" · ");
  return (
    <div className="flex items-start gap-3 border-b border-line px-3 py-2.5 last:border-0">
      <span className={`mt-1.5 size-2.5 shrink-0 rounded-full ${dot}`} />
      <div className="min-w-0 flex-1">
        <div className="line-clamp-3 text-[15px]">{task.description || "(설명 없음)"}</div>
        <div className="mt-0.5 text-xs text-muted">{meta}</div>
        {error && <div className="mt-1 text-xs text-danger">{error}</div>}
      </div>
      {task.status === "running" && (
        <SmallButton onClick={onStop} disabled={stopping} tone="text-danger">
          {stopping ? "중지 중…" : "중지"}
        </SmallButton>
      )}
    </div>
  );
}

export function TasksSheet({ sessionId, onClose }: SheetProps) {
  const tasks = useApp((s) => (s.chat?.sessionId === sessionId ? s.chat.state?.tasks : undefined)) ?? [];
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState<{ id: string; text: string }>();
  const running = tasks.filter((t) => t.status === "running");
  const ended = tasks.filter((t) => t.status !== "running");

  const stop = (id: string) => {
    setStopping((s) => new Set(s).add(id));
    setFailed(undefined);
    call(sessionId, "stop_task", { taskId: id }).catch((e: Error) => {
      setStopping((s) => new Set([...s].filter((x) => x !== id)));
      setFailed({ id, text: errorText(e.message) });
    });
  };

  const rows = (list: TaskInfo[]) => (
    <div className="overflow-hidden rounded-xl border border-line">
      {list.map((t) => (
        <TaskRow key={t.id} task={t} stopping={stopping.has(t.id)} error={failed?.id === t.id ? failed.text : undefined} onStop={() => stop(t.id)} />
      ))}
    </div>
  );

  return (
    <Sheet title="백그라운드 작업" onClose={onClose}>
      {running.length ? rows(running) : <div className="px-1 py-3 text-sm text-muted">실행 중인 작업이 없습니다</div>}
      {ended.length > 0 && (
        <section className="mt-4">
          <div className="mb-1.5 px-1 text-xs font-semibold text-muted">최근에 끝난 작업</div>
          {rows(ended)}
        </section>
      )}
    </Sheet>
  );
}
