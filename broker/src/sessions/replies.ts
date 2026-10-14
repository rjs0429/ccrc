import type { ToolReply } from "../protocol.ts";

const QUESTION_LIMIT = 2000;
const ANSWER_LIMIT = 2000;
const PREVIEW_LIMIT = 4000;
const MAX_ANSWERS = 8;
export const PLAN_LIMIT = 20000;

// Result texts Claude Code gives the model for these tools.
const NOTES_ONLY = "(notes only)";
const NOT_SELECTED = "(no option selected)";
const UNANSWERED = "The user did not answer the questions.";
const RESPONDED = "The user responded: ";
const ANSWERED = ["Your questions have been answered: ", "The user answered: "];
const ANSWERED_END = [
  ". You can now continue with these answers in mind.",
  ". Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.",
];
const PREVIEW_MARK = " selected preview:\n";
const NOTES_MARK = " notes: ";
const REJECTED = "The user doesn't want to proceed with this tool use.";
const REASON = /(?:The user provided the following reason for the rejection:|To tell you how to proceed, the user said:)\s*([\s\S]*)$/;
const INTERRUPTED = /^\[(Request interrupted by user[^\]]*|Tool call interrupted:[^\]]*)\]$/;
const APPROVED = "User has approved";
const EDITED_PLAN = "## Approved Plan (edited by user):\n";
const KEEP_PLANNING = "The user wants to keep planning.";

type Rec = Record<string, unknown>;

const record = (v: unknown): Rec | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined);

const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit)}…` : text);

function questionsOf(input: unknown): string[] {
  const qs = record(input)?.questions;
  return Array.isArray(qs) ? qs.flatMap((q) => (typeof record(q)?.question === "string" ? [record(q)!.question as string] : [])) : [];
}

function answerText(v: unknown): string | undefined {
  if (Array.isArray(v)) return v.every((x) => typeof x === "string") && v.length ? v.join(", ") : undefined;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return typeof v === "string" && v !== "" && v !== NOTES_ONLY ? v : undefined;
}

function trimmed(v: unknown, limit: number): string | undefined {
  return typeof v === "string" && v.trim() ? clip(v, limit) : undefined;
}

// Only the answers, notes, previews and response of AskUserQuestion's structured output, shortened.
function fromOutput(r: Rec): ToolReply {
  const answers: Record<string, string> = {};
  const notes: Record<string, string> = {};
  const previews: Record<string, string> = {};
  for (const [q, v] of Object.entries(record(r.answers) ?? {}).slice(0, MAX_ANSWERS)) {
    const a = answerText(v);
    if (a !== undefined) answers[clip(q, QUESTION_LIMIT)] = clip(a, ANSWER_LIMIT);
  }
  for (const [q, v] of Object.entries(record(r.annotations) ?? {}).slice(0, MAX_ANSWERS)) {
    const note = trimmed(record(v)?.notes, ANSWER_LIMIT);
    const preview = trimmed(record(v)?.preview, PREVIEW_LIMIT);
    if (note) notes[clip(q, QUESTION_LIMIT)] = note;
    if (preview) previews[clip(q, QUESTION_LIMIT)] = preview;
  }
  const response = trimmed(r.response, ANSWER_LIMIT);
  const followUp = r.followUp === true;
  const timedOut = typeof r.afkTimeoutMs === "number" && r.afkTimeoutMs > 0;
  if (!Object.keys(answers).length && !Object.keys(notes).length && !response && !followUp && !timedOut) return { kind: "unanswered" };
  return {
    kind: "answered",
    answers,
    ...(Object.keys(notes).length ? { notes } : {}),
    ...(Object.keys(previews).length ? { previews } : {}),
    ...(response ? { response } : {}),
    ...(followUp ? { followUp } : {}),
    ...(timedOut ? { timedOut } : {}),
  };
}

// One question's part of the answer list: "Q"="A" or "Q"=(no option selected), then optionally
// " selected preview:\n..." and " notes: ...".
function answerPart(seg: string): { answer?: string; preview?: string; note?: string } | undefined {
  let rest: string;
  let answer: string | undefined;
  if (seg.startsWith(NOT_SELECTED)) rest = seg.slice(NOT_SELECTED.length);
  else if (seg.startsWith('"')) {
    const marks = [seg.indexOf(`"${PREVIEW_MARK}`), seg.indexOf(`"${NOTES_MARK}`)].filter((i) => i > 0);
    const end = marks.length ? Math.min(...marks) : seg.lastIndexOf('"');
    if (end < 1) return undefined;
    answer = seg.slice(1, end);
    rest = seg.slice(end + 1);
  } else return undefined;
  let preview: string | undefined;
  let note: string | undefined;
  if (rest.startsWith(PREVIEW_MARK)) {
    const at = rest.lastIndexOf(NOTES_MARK);
    preview = rest.slice(PREVIEW_MARK.length, at > 0 ? at : undefined);
    rest = at > 0 ? rest.slice(at) : "";
  }
  if (rest.startsWith(NOTES_MARK)) note = rest.slice(NOTES_MARK.length);
  else if (rest) return undefined;
  return { answer, preview, note };
}

// The answers in a result text, for transcripts that keep no structured output.
function fromText(questions: string[], text: string): ToolReply | undefined {
  if (text === UNANSWERED) return { kind: "unanswered" };
  if (text.startsWith(RESPONDED)) return { kind: "answered", answers: {}, response: clip(text.slice(RESPONDED.length), ANSWER_LIMIT) };
  const head = ANSWERED.find((h) => text.startsWith(h));
  const tail = ANSWERED_END.find((t) => text.endsWith(t));
  if (head === undefined || tail === undefined) return undefined;
  const list = text.slice(head.length, text.length - tail.length);
  const out: Rec = { answers: {}, annotations: {} };
  let at = 0;
  questions.forEach((q, i) => {
    const mark = `"${q}"=`;
    if (!list.startsWith(mark, at)) return;
    const from = at + mark.length;
    let end = list.length;
    for (const later of questions.slice(i + 1)) {
      const next = list.indexOf(`, "${later}"=`, from);
      if (next !== -1 && next < end) end = next;
    }
    const part = answerPart(list.slice(from, end));
    if (part?.answer !== undefined) (out.answers as Rec)[q] = part.answer;
    if (part?.preview || part?.note) (out.annotations as Rec)[q] = { preview: part.preview, notes: part.note };
    at = end + 2;
  });
  const reply = fromOutput(out);
  return reply.kind === "answered" ? reply : undefined;
}

function declined(text: string): ToolReply | undefined {
  if (!text.startsWith(REJECTED)) return undefined;
  const reason = REASON.exec(text)?.[1].trim();
  return reason ? { kind: "declined", reason: clip(reason, ANSWER_LIMIT) } : { kind: "declined" };
}

function plan(text: string, isError: boolean, output: Rec | undefined): ToolReply | undefined {
  if (isError) {
    const feedback = (REASON.exec(text)?.[1] ?? (text.startsWith(REJECTED) || text === KEEP_PLANNING || text.startsWith("<tool_use_error>") ? "" : text)).trim();
    return feedback ? { kind: "kept_planning", feedback: clip(feedback, ANSWER_LIMIT) } : { kind: "kept_planning" };
  }
  if (!text.startsWith(APPROVED)) return undefined;
  const at = text.indexOf(EDITED_PLAN);
  const edited = output?.planWasEdited === true && typeof output.plan === "string" ? output.plan : at !== -1 ? text.slice(at + EDITED_PLAN.length) : undefined;
  return edited?.trim() ? { kind: "approved", plan: clip(edited, PLAN_LIMIT) } : { kind: "approved" };
}

// The user's reply to an AskUserQuestion or ExitPlanMode call: from the call's structured output when there
// is one, otherwise from the result text (the full text, before it is shortened for display).
export function toolReply(name: string, input: unknown, text: string, isError: boolean, output: unknown): ToolReply | undefined {
  if (name !== "AskUserQuestion" && name !== "ExitPlanMode") return undefined;
  const trimmedText = text.trim();
  if (INTERRUPTED.test(trimmedText)) return { kind: "interrupted" };
  const r = record(output);
  if (name === "ExitPlanMode") return plan(trimmedText, isError, r);
  if (isError) return declined(trimmedText);
  if (r && record(r.answers)) return fromOutput(r);
  return fromText(questionsOf(input), trimmedText);
}
