import { useState } from "react";
import type { ToolReply } from "../../../../broker/src/protocol.ts";
import { Icon } from "../ui.tsx";
import { Chip, Code, Folded, record, str, type Input } from "./parts.tsx";

interface Option {
  label: string;
  description: string;
  preview: string;
}

interface Question {
  question: string;
  header: string;
  multiSelect: boolean;
  options: Option[];
}

function questionsOf(input: Input): Question[] {
  const list = Array.isArray(input.questions) ? input.questions : [];
  return list.flatMap((q) => {
    const r = record(q);
    if (!r || typeof r.question !== "string") return [];
    const options = (Array.isArray(r.options) ? r.options : []).flatMap((o) => {
      const or = record(o);
      return or && typeof or.label === "string" ? [{ label: or.label, description: str(or.description), preview: str(or.preview) }] : [];
    });
    return [{ question: r.question, header: str(r.header), multiSelect: r.multiSelect === true, options }];
  });
}

// The options an answer names and any typed text. Choices and typed text, even after a single choice, come joined
// with ", ", and a label may hold ", " itself, so the longest label that fits is taken first.
function picks(q: Question, answer: string): { picked: string[]; other?: string } {
  const labels = q.options.map((o) => o.label);
  if (labels.includes(answer)) return { picked: [answer] };
  const picked: string[] = [];
  let rest = answer;
  while (q.multiSelect || !picked.length) {
    const label = labels.filter((l) => rest === l || rest.startsWith(`${l}, `)).sort((a, b) => b.length - a.length)[0];
    if (label === undefined) break;
    picked.push(label);
    rest = rest.slice(label.length);
    if (!rest) return { picked };
    rest = rest.slice(2);
  }
  return { picked, other: rest };
}

function Preview({ text, open: initial = false }: { text: string; open?: boolean }) {
  const [open, setOpen] = useState(initial);
  return (
    <div className="mt-1.5">
      <button onClick={() => setOpen(!open)} className="-my-1.5 -ml-2 flex items-center gap-0.5 px-2 py-1.5 text-xs font-medium text-accent">
        미리보기
        <Icon.chevronDown className={`size-3.5 transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && (
        <div className="mt-1">
          <Code text={text} />
        </div>
      )}
    </div>
  );
}

function OptionRow({ q, option, on, dimmed }: { q: Question; option: Option; on: boolean; dimmed: boolean }) {
  return (
    <div
      role={q.multiSelect ? "checkbox" : "radio"}
      aria-checked={on}
      className={`rounded-xl border px-3 py-2 ${on ? "border-accent bg-accent-soft" : "border-line"} ${dimmed ? "opacity-55" : ""}`}
    >
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          <span className="block text-[15px]">{option.label}</span>
          {option.description && <span className="block text-xs text-muted">{option.description}</span>}
        </span>
        {on && <Icon.check className="mt-0.5 size-4 shrink-0 text-accent" />}
      </div>
      {option.preview && <Preview text={option.preview} />}
    </div>
  );
}

function QuestionBlock({ q, answer, note, preview, answered }: { q: Question; answer?: string; note?: string; preview?: string; answered: boolean }) {
  const { picked, other } = answer === undefined ? { picked: [] as string[] } : picks(q, answer);
  const chosen = picked.length > 0 || other !== undefined;
  const shownPreview = preview && !q.options.some((o) => o.preview && o.preview.trim() === preview.trim()) ? preview : undefined;
  return (
    <div className="space-y-1.5" data-question={q.question}>
      {(q.header || q.multiSelect) && (
        <div className="flex items-center gap-2">
          {q.header && <Chip>{q.header}</Chip>}
          {q.multiSelect && <span className="text-xs text-muted">여러 개 선택</span>}
        </div>
      )}
      <div className="text-[15px] font-medium">{q.question}</div>
      {q.options.map((o) => (
        <OptionRow key={o.label} q={q} option={o} on={picked.includes(o.label)} dimmed={chosen && !picked.includes(o.label)} />
      ))}
      {other !== undefined && (
        <div role={q.multiSelect ? "checkbox" : "radio"} aria-checked className="flex items-start gap-2 rounded-xl border border-accent bg-accent-soft px-3 py-2" data-other>
          <span className="min-w-0 flex-1">
            <span className="block text-xs text-muted">직접 입력</span>
            <span className="block text-[15px] whitespace-pre-wrap">{other}</span>
          </span>
          <Icon.check className="mt-0.5 size-4 shrink-0 text-accent" />
        </div>
      )}
      {shownPreview && (
        <div>
          <div className="text-xs text-muted">고른 미리보기</div>
          <div className="mt-1">
            <Code text={shownPreview} />
          </div>
        </div>
      )}
      {note && (
        <div className="rounded-lg bg-surface-2 px-2.5 py-1.5 text-sm" data-note>
          <span className="mr-1.5 text-xs text-muted">메모</span>
          <span className="whitespace-pre-wrap">{note}</span>
        </div>
      )}
      {answered && !chosen && !note && <div className="text-sm text-muted">답하지 않음</div>}
    </div>
  );
}

function status(reply?: ToolReply): string | undefined {
  switch (reply?.kind) {
    case "unanswered":
      return "답하지 않았습니다";
    case "declined":
      return "질문을 거절했습니다";
    case "interrupted":
      return "중단되었습니다";
    case "answered":
      return reply.timedOut ? "자리를 비운 사이 시간이 지났습니다" : reply.followUp ? "질문을 더 해 달라고 했습니다" : undefined;
  }
  return undefined;
}

// An AskUserQuestion call drawn as its questions, with the chosen options marked once it is answered.
export function QuestionView({ input, reply }: { input: Input; reply?: ToolReply }) {
  const questions = questionsOf(input);
  const answered = reply?.kind === "answered" ? reply : undefined;
  const line = status(reply);
  return (
    <div className="space-y-3.5" data-question-view={reply?.kind ?? "none"}>
      {line && (
        <div className="rounded-lg bg-surface-2 px-2.5 py-1.5 text-sm text-muted" data-status>
          {line}
          {reply?.kind === "declined" && reply.reason && <div className="mt-0.5 whitespace-pre-wrap text-fg">이유: {reply.reason}</div>}
        </div>
      )}
      {questions.map((q) => (
        <QuestionBlock
          key={q.question}
          q={q}
          answer={answered?.answers[q.question]}
          note={answered?.notes?.[q.question]}
          preview={answered?.previews?.[q.question]}
          answered={Boolean(answered) && !answered?.response}
        />
      ))}
      {answered?.response && (
        <div className="rounded-xl border border-accent bg-accent-soft px-3 py-2" data-response>
          <div className="text-xs text-muted">답 대신 남긴 말</div>
          <Folded text={answered.response} plain />
        </div>
      )}
    </div>
  );
}
