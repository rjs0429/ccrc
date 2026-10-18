// The composer's width from which the chips stand on one line: the sm breakpoint.
const WIDE_PX = 640;

// Widths of the composer's chips with every name in full.
export interface ChipWidths {
  composer: number;
  row: number;
  gap: number;
  // The paperclip, the Context ring, the model chip and the Effort chip.
  left: number;
  // The mode chip.
  right: number;
  // The round send or stop button with its margin.
  round: number;
  // The agent chip with its word, as wide whatever its agents do.
  agent?: number;
}

export interface ChipLayout {
  // wide: one line whose left group gives way when it must; one: everything on one line in full; two: the agent chip
  // and the right group on line 1, the left group and the round button on line 2.
  lines: "wide" | "one" | "two";
  word: boolean;
}

// One line in the order left group, agent chip, right group, round button when it all fits, else two lines. Agents
// starting, ending or leaving the list never change the lines, since the agent chip keeps its width; on line 2 it
// leaves its word out only where line 1 has no room for it beside the mode chip.
export function chipLayout(w: ChipWidths): ChipLayout {
  if (w.composer >= WIDE_PX) return { lines: "wide", word: true };
  const line = w.left + w.gap + w.right + w.gap + w.round + (w.agent === undefined ? 0 : w.gap + w.agent);
  if (line <= w.row) return { lines: "one", word: true };
  return { lines: "two", word: w.agent === undefined || w.agent + w.gap + w.right <= w.row };
}

export function sameLayout(a: ChipLayout, b: ChipLayout): boolean {
  return a.lines === b.lines && a.word === b.word;
}
