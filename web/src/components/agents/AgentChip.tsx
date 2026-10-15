import type { Ref } from "react";
import { Icon } from "../ui.tsx";
import type { AgentMap, ChipDot } from "./tree.ts";

type Chip = NonNullable<AgentMap["chip"]>;

const DOT: Record<Exclude<ChipDot, "idle">, string> = {
  waiting: "bg-warn",
  running: "bg-accent animate-pulse",
  failed: "bg-danger",
  done: "bg-ok",
};

function label(chip: Chip): string {
  if (chip.dot === "waiting") return "권한을 기다리는 에이전트가 있습니다. 에이전트 지도 열기";
  if (chip.running) return `에이전트 ${chip.running}개 실행 중. 에이전트 지도 열기`;
  if (chip.dot === "failed") return "실패한 에이전트가 있습니다. 에이전트 지도 열기";
  if (chip.dot === "done") return "에이전트가 모두 끝났습니다. 에이전트 지도 열기";
  return `이 대화의 에이전트 ${chip.total}개. 에이전트 지도 열기`;
}

// The chip's width with its word and without, from its parts as laid out now: icon, word, then the count. An idle
// chip has no dot or count to show instead, so it always keeps its word.
export function agentChipWidths(el: HTMLElement): { word: number; icon?: number } {
  const s = getComputedStyle(el);
  const gap = parseFloat(s.columnGap) || 0;
  const [icon, word, ...rest] = [...el.children].map((e) => e.getBoundingClientRect().width);
  const bare = parseFloat(s.paddingLeft) + parseFloat(s.paddingRight) + icon + rest.reduce((sum, w) => sum + gap + w, 0);
  const min = parseFloat(s.minWidth) || 0;
  return { word: Math.max(min, bare + gap + word), icon: el.dataset.dot === "idle" ? undefined : Math.max(min, bare) };
}

// Shows while the conversation has subagents or workflows. Without `word` the word stays laid out, hidden and out
// of the row, so the chip's width with it can still be measured.
export function AgentChip({ chip, word, onClick, ref }: { chip: Chip; word: boolean; onClick: () => void; ref?: Ref<HTMLButtonElement> }) {
  return (
    <button
      ref={ref}
      onClick={onClick}
      data-chip="agents"
      data-dot={chip.dot}
      aria-label={label(chip)}
      className="relative flex min-h-8 min-w-11 shrink-0 items-center justify-center gap-1 rounded-lg px-1.5 py-1 text-[13px] text-muted hover:bg-surface-2"
    >
      <span className="relative flex">
        <Icon.agents className="size-[18px]" />
        {chip.dot !== "idle" && <span className={`absolute -top-0.5 -right-0.5 size-1.5 rounded-full ring-2 ring-surface ${DOT[chip.dot]}`} />}
      </span>
      <span className={`whitespace-nowrap ${word ? "" : "invisible absolute left-0"}`}>에이전트</span>
      {chip.running > 0 && <span className="font-medium text-fg tabular-nums">{chip.running}</span>}
    </button>
  );
}
