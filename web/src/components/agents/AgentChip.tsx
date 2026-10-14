import { Icon } from "../ui.tsx";
import type { AgentMap, ChipDot } from "./tree.ts";

const DOT: Record<ChipDot, string> = {
  waiting: "bg-warn",
  running: "bg-accent animate-pulse",
  failed: "bg-danger",
  done: "bg-ok",
};

function label(chip: NonNullable<AgentMap["chip"]>): string {
  if (chip.dot === "waiting") return "권한을 기다리는 에이전트가 있습니다. 에이전트 지도 열기";
  if (chip.running) return `에이전트 ${chip.running}개 실행 중. 에이전트 지도 열기`;
  if (chip.dot === "failed") return "실패한 에이전트가 있습니다. 에이전트 지도 열기";
  return "에이전트가 모두 끝났습니다. 에이전트 지도 열기";
}

// Shows while subagents or workflows are listed; the word joins the icon where the chip row has room.
export function AgentChip({ chip, onClick }: { chip: NonNullable<AgentMap["chip"]>; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      data-chip="agents"
      data-dot={chip.dot}
      aria-label={label(chip)}
      className="flex min-h-8 min-w-11 shrink-0 items-center justify-center gap-1 rounded-lg px-1.5 py-1 text-[13px] text-muted hover:bg-surface-2 sm:ml-1"
    >
      <span className="relative flex">
        <Icon.agents className="size-[18px]" />
        <span className={`absolute -top-0.5 -right-0.5 size-1.5 rounded-full ring-2 ring-surface ${DOT[chip.dot]}`} />
      </span>
      <span className="hidden min-[420px]:inline">에이전트</span>
      {chip.running > 0 && <span className="font-medium text-fg tabular-nums">{chip.running}</span>}
    </button>
  );
}
