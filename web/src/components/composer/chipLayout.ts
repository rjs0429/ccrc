// The composer's width from which the chips stand on one line: the sm breakpoint.
const WIDE_PX = 640;

// Widths of the composer's chips with every name in full.
export interface ChipWidths {
  composer: number;
  row: number;
  gap: number;
  // The paperclip, the model chip and the Effort chip.
  left: number;
  // The Context ring and the mode chip.
  right: number;
  // The round send or stop button with its margin.
  round: number;
  // The agent chip with its word; without it, where its dot or count still shows; and with its word but no running
  // count, as it reads once no agent runs.
  agent?: { word: number; icon?: number; settled: number };
}

export interface ChipLayout {
  // wide: one line whose left group gives way when it must; one: everything on one line in full; two: the agent chip
  // and the right group on line 1, the left group and the round button on line 2.
  lines: "wide" | "one" | "two";
  word: boolean;
}

// One line in the order left group, agent chip, right group, round button when it all fits with the agent chip as it
// reads once no agent runs, so once the chip shows, agents starting, ending or leaving the list keep the lines; a
// running count with no room beside the word takes its place. Else two lines. An idle chip always keeps its word.
export function chipLayout(w: ChipWidths): ChipLayout {
  if (w.composer >= WIDE_PX) return { lines: "wide", word: true };
  const line = w.left + w.gap + w.right + w.gap + w.round;
  if (!w.agent) return { lines: line <= w.row ? "one" : "two", word: true };
  if (line + w.gap + w.agent.settled <= w.row) return { lines: "one", word: w.agent.icon === undefined || line + w.gap + w.agent.word <= w.row };
  return { lines: "two", word: w.agent.icon === undefined || w.agent.word + w.gap + w.right <= w.row };
}

export function sameLayout(a: ChipLayout, b: ChipLayout): boolean {
  return a.lines === b.lines && a.word === b.word;
}
