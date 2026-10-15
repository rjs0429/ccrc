// The composer's width from which the chips stand on one line: the sm breakpoint.
const WIDE_PX = 640;

// Widths of the composer's chip rows with every name in full.
export interface ChipWidths {
  composer: number;
  row: number;
  gap: number;
  left: number;
  right: number;
  // The agent chip with its word and, where its dot or count still shows without the word, without it.
  agent?: { word: number; icon?: number };
}

export interface ChipLayout {
  // wide: one line with the agent chip between the groups; one: both groups on one line; two: the right group
  // on a line under the left one.
  lines: "wide" | "one" | "two";
  // above: the agent chip on a line of its own over the chips; inline: on the line of the right group, before it.
  agent: "above" | "inline";
  word: boolean;
}

export function chipLayout(w: ChipWidths): ChipLayout {
  if (w.composer >= WIDE_PX) return { lines: "wide", agent: "inline", word: true };
  if (w.left + w.gap + w.right <= w.row) return { lines: "one", agent: "above", word: true };
  const room = w.row - w.gap - w.right;
  if (w.agent && w.agent.word <= room) return { lines: "two", agent: "inline", word: true };
  if (w.agent?.icon !== undefined && w.agent.icon <= room) return { lines: "two", agent: "inline", word: false };
  return { lines: "two", agent: "above", word: true };
}

export function sameLayout(a: ChipLayout, b: ChipLayout): boolean {
  return a.lines === b.lines && a.agent === b.agent && a.word === b.word;
}
