export interface PlanComment {
  line: number;
  end: number;
  quote: string;
  text: string;
}

export const QUOTE_MAX = 80;
// Comments on a plan stay while the app is open, so a card drawn again keeps them.
export const planComments = new Map<string, PlanComment[]>();

export const lineSpan = (c: Pick<PlanComment, "line" | "end">) => (c.end > c.line ? `줄 ${c.line}–${c.end}` : `줄 ${c.line}`);

// The keep-planning feedback: what the user wrote, then each comment by the plan's line it is on and that line's text.
export function planFeedback(text: string, comments: PlanComment[]): string {
  const t = text.trim();
  if (!comments.length) return t;
  const list = comments.map((c) => `${lineSpan(c)}${c.quote ? ` "${c.quote}"` : ""}: ${c.text}`).join("\n");
  return `${t ? `${t}\n\n` : ""}계획에 단 코멘트:\n${list}`;
}
