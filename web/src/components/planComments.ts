import { t } from "../i18n/index.ts";

export interface PlanComment {
  line: number;
  end: number;
  quote: string;
  text: string;
}

export const QUOTE_MAX = 80;
// Comments on a plan stay while the app is open, so a card drawn again keeps them.
export const planComments = new Map<string, PlanComment[]>();

export const lineSpan = (c: Pick<PlanComment, "line" | "end">) =>
  c.end > c.line ? t("줄 {start}–{end}", { start: c.line, end: c.end }) : t("줄 {line}", { line: c.line });

const FENCE = /^(`{3,}|~{3,})/;

// The text a comment quotes: the first line of its block that says which block it is, so a code block quotes its code
// rather than its fence and a quote's empty line is passed over.
export function planQuote(lines: readonly string[], line: number, end = line): string {
  for (let n = line; n <= Math.max(line, end); n++) {
    const q = (lines[n - 1] ?? "").trim();
    const bare = q.replace(/^(>\s*)+/, "");
    if (!bare || FENCE.test(bare)) continue;
    return q.length > QUOTE_MAX ? `${q.slice(0, QUOTE_MAX)}…` : q;
  }
  return "";
}

// The keep-planning feedback: what the user wrote, then each comment by the plan's line it is on and that line's text.
export function planFeedback(text: string, comments: PlanComment[]): string {
  const own = text.trim();
  if (!comments.length) return own;
  const list = comments.map((c) => `${lineSpan(c)}${c.quote ? ` "${c.quote}"` : ""}: ${c.text}`).join("\n");
  return `${own ? `${own}\n\n` : ""}${t("계획에 단 코멘트:")}\n${list}`;
}
