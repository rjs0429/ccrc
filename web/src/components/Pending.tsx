import { useState } from "react";
import type { Answer, PendingRequest } from "../../../broker/src/protocol.ts";
import { allowAlwaysLabel, dialogLabel } from "../labels.ts";
import { Markdown } from "./Markdown.tsx";
import { ToolInput } from "./ToolInput.tsx";
import { Button } from "./ui.tsx";

type Reply = (answer: Answer) => void;

interface QuestionInput {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: { label: string; description?: string }[];
}

function Card({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-accent/40 bg-surface p-3.5 shadow-sm">
      <div className="text-xs font-semibold tracking-wide text-accent">{title}</div>
      {sub && <div className="mt-0.5 text-[15px] font-medium break-all">{sub}</div>}
      <div className="mt-2.5 space-y-3">{children}</div>
    </div>
  );
}

function DenyBox({ placeholder, label, onSend }: { placeholder: string; label: string; onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  return (
    <div className="flex gap-2">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 rounded-xl border border-line bg-bg px-3 py-2.5 text-[15px] outline-none focus:border-accent"
      />
      <Button kind="danger" onClick={() => onSend(text)}>
        {label}
      </Button>
    </div>
  );
}

function PermissionCard({ request, reply }: { request: PendingRequest; reply: Reply }) {
  return (
    <Card title="권한 요청" sub={`${request.toolName}${request.description ? ` · ${request.description}` : ""}`}>
      {request.title && <div className="text-sm">{request.title}</div>}
      {request.decisionReason && <div className="text-xs text-muted">{request.decisionReason}</div>}
      <ToolInput name={request.toolName} input={request.input} />
      {request.localOnly ? (
        <div className="rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-muted">이 요청은 VS Code에서만 응답할 수 있습니다.</div>
      ) : (
        <div className="grid gap-2">
          <Button kind="primary" onClick={() => reply({ kind: "permission", decision: "allow" })}>
            허용
          </Button>
          {request.allowAlways && (
            <Button onClick={() => reply({ kind: "permission", decision: "allow_always" })}>{allowAlwaysLabel(request.suggestions)}</Button>
          )}
          <DenyBox placeholder="대신 할 일 (선택)" label="거부" onSend={(message) => reply({ kind: "permission", decision: "deny", message })} />
        </div>
      )}
    </Card>
  );
}

function QuestionCard({ request, reply }: { request: PendingRequest; reply: Reply }) {
  const questions = (Array.isArray(request.input.questions) ? request.input.questions : []) as QuestionInput[];
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const answerOf = (q: QuestionInput) => [...(picked[q.question] ?? []), ...(other[q.question]?.trim() ? [other[q.question].trim()] : [])].join(", ");
  const complete = questions.every((q) => answerOf(q));
  const toggle = (q: QuestionInput, label: string) =>
    setPicked((p) => {
      const cur = p[q.question] ?? [];
      const next = q.multiSelect ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label];
      return { ...p, [q.question]: next };
    });
  return (
    <Card title="질문">
      {questions.map((q) => (
        <div key={q.question} className="space-y-1.5">
          {q.header && <div className="inline-block rounded-md bg-surface-2 px-1.5 py-0.5 text-xs text-muted">{q.header}</div>}
          <div className="text-[15px] font-medium">{q.question}</div>
          {(q.options ?? []).map((o) => {
            const on = picked[q.question]?.includes(o.label);
            return (
              <button
                key={o.label}
                onClick={() => toggle(q, o.label)}
                className={`block w-full rounded-xl border px-3 py-2 text-left ${on ? "border-accent bg-accent-soft" : "border-line"}`}
              >
                <span className="block text-[15px]">{o.label}</span>
                {o.description && <span className="block text-xs text-muted">{o.description}</span>}
              </button>
            );
          })}
          <input
            value={other[q.question] ?? ""}
            onChange={(e) => setOther((s) => ({ ...s, [q.question]: e.target.value }))}
            placeholder="직접 입력"
            className="w-full rounded-xl border border-line bg-bg px-3 py-2 text-[15px] outline-none focus:border-accent"
          />
        </div>
      ))}
      <Button
        kind="primary"
        disabled={!complete}
        className="w-full"
        onClick={() => reply({ kind: "question", answers: Object.fromEntries(questions.map((q) => [q.question, answerOf(q)])) })}
      >
        답변 보내기
      </Button>
    </Card>
  );
}

function PlanCard({ request, reply }: { request: PendingRequest; reply: Reply }) {
  const plan = typeof request.input.plan === "string" ? request.input.plan : "";
  return (
    <Card title="계획 승인">
      <div className="max-h-[45dvh] overflow-y-auto rounded-xl border border-line bg-bg p-3">
        <Markdown text={plan} className="text-[14px]" />
      </div>
      <div className="grid gap-2">
        <Button kind="primary" onClick={() => reply({ kind: "plan", decision: "auto" })}>
          예, Auto 모드로 진행
        </Button>
        <Button onClick={() => reply({ kind: "plan", decision: "acceptEdits" })}>예, 편집은 자동 허용</Button>
        <Button onClick={() => reply({ kind: "plan", decision: "default" })}>예, 편집마다 직접 승인</Button>
        <DenyBox placeholder="고칠 점 (선택)" label="아니요, 계속 계획하기" onSend={(feedback) => reply({ kind: "plan", decision: "keep_planning", feedback })} />
      </div>
    </Card>
  );
}

function DialogCard({ request }: { request: PendingRequest }) {
  return (
    <Card title="확인 요청" sub={dialogLabel(request.toolName)}>
      <div className="rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-muted">VS Code에 확인 창이 열려 있습니다. VS Code에서만 응답할 수 있습니다.</div>
    </Card>
  );
}

export function PendingCard({ request, reply }: { request: PendingRequest; reply: Reply }) {
  if (request.kind === "question") return <QuestionCard request={request} reply={reply} />;
  if (request.kind === "plan") return <PlanCard request={request} reply={reply} />;
  if (request.kind === "dialog") return <DialogCard request={request} />;
  return <PermissionCard request={request} reply={reply} />;
}
