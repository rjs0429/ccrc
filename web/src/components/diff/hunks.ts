import type { Hunk } from "../../../../broker/src/protocol.ts";

const MAX_CELLS = 250_000;

export interface DiffLine {
  kind: "context" | "removed" | "added" | "note";
  text: string;
  oldNo?: number;
  newNo?: number;
}

export function numbered(h: Hunk): DiffLine[] {
  let oldNo = h.oldStart;
  let newNo = h.newStart;
  return h.lines.map((line): DiffLine => {
    const text = line.slice(1);
    if (line[0] === "-") return { kind: "removed", text, oldNo: oldNo++ };
    if (line[0] === "+") return { kind: "added", text, newNo: newNo++ };
    if (line[0] === "\\") return { kind: "note", text: text.trim() };
    return { kind: "context", text, oldNo: oldNo++, newNo: newNo++ };
  });
}

// Added and removed line counts. They come from the hunk headers, which keep their full counts when
// the broker leaves lines out of a long patch.
export function patchStats(hunks: Hunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    const context = h.lines.filter((l) => l[0] !== "+" && l[0] !== "-" && l[0] !== "\\").length;
    added += Math.max(h.newLines - context, 0);
    removed += Math.max(h.oldLines - context, 0);
  }
  return { added, removed };
}

// A line diff of the text an edit replaces and its replacement, for edits without a reported patch.
// Where they sit in the file is unknown, so both sides count from 1.
export function snippetHunk(before: string, after: string): Hunk {
  const a = before ? before.split("\n") : [];
  const b = after ? after.split("\n") : [];
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const lines = [
    ...a.slice(0, head).map((l) => ` ${l}`),
    ...changed(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
    ...a.slice(a.length - tail).map((l) => ` ${l}`),
  ];
  return { oldStart: 1, oldLines: a.length, newStart: 1, newLines: b.length, lines };
}

// Removed and added lines around the longest common subsequence of the two sides; very large inputs
// are shown as all removed then all added.
function changed(a: string[], b: string[]): string[] {
  if (a.length * b.length > MAX_CELLS) return [...a.map((l) => `-${l}`), ...b.map((l) => `+${l}`)];
  const w = b.length + 1;
  const common = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i * w + j] = a[i] === b[j] ? common[(i + 1) * w + j + 1] + 1 : Math.max(common[(i + 1) * w + j], common[i * w + j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i++;
      j++;
    } else if (j === b.length || (i < a.length && common[(i + 1) * w + j] >= common[i * w + j + 1])) {
      out.push(`-${a[i++]}`);
    } else {
      out.push(`+${b[j++]}`);
    }
  }
  return out;
}
