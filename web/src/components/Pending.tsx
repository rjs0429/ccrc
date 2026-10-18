import { useEffect, useRef, useState } from "react";
import { fieldProblem, type FieldProblem } from "../../../broker/src/elicit.ts";
import type { Answer, DialogInfo, ElicitField, ElicitInfo, ElicitValue, PendingRequest } from "../../../broker/src/protocol.ts";
import { allowAlwaysLabel, creditsText, dialogLabel, modelLabel, refusalText } from "../labels.ts";
import { useApp } from "../state.ts";
import { Switch } from "../screens/settings/common.tsx";
import { Markdown } from "./Markdown.tsx";
import { ToolInput } from "./ToolInput.tsx";
import { Button, Icon } from "./ui.tsx";

type Reply = (answer: Answer) => void;

interface QuestionInput {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: { label: string; description?: string }[];
}

function Card({ title, sub, children, ...rest }: { title: string; sub?: string; children: React.ReactNode; "data-elicitation"?: string; "data-dialog"?: string }) {
  return (
    <div className="rounded-2xl border border-accent/40 bg-surface p-3.5 shadow-sm" {...rest}>
      <div className="text-xs font-semibold tracking-wide text-accent">{title}</div>
      {sub && <div className="mt-0.5 text-[15px] font-medium">{sub}</div>}
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
        className="min-w-0 flex-1 rounded-xl border border-line bg-bg px-3 py-2.5 text-[16px] outline-none focus:border-accent"
      />
      <Button kind="danger" onClick={() => onSend(text)}>
        {label}
      </Button>
    </div>
  );
}

// A request that must not be approved by a stray tap puts deny first and offers allow without emphasis.
function PermissionCard({ request, reply, agent }: { request: PendingRequest; reply: Reply; agent?: string }) {
  const deny = <DenyBox placeholder="Claude에게 대신 할 일 (선택)" label="거부" onSend={(message) => reply({ kind: "permission", decision: "deny", message })} />;
  return (
    <Card title="권한 요청" sub={`${agent ? `${agent} · ` : ""}${request.toolName}${request.description ? ` · ${request.description}` : ""}`}>
      {request.title && <div className="text-sm">{request.title}</div>}
      {request.decisionReason && <div className="text-xs text-muted">{request.decisionReason}</div>}
      <ToolInput name={request.toolName} input={request.input} />
      {request.personOnly && <div className="rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-muted">자동 모드가 막은 동작입니다. 직접 정하세요.</div>}
      {request.localOnly ? (
        <div className="rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-muted">이 요청은 VS Code에서만 응답할 수 있습니다.</div>
      ) : (
        <div className="grid gap-2">
          {request.defaultToNo && deny}
          <Button kind={request.defaultToNo ? undefined : "primary"} onClick={() => reply({ kind: "permission", decision: "allow" })}>
            허용
          </Button>
          {request.allowAlways && (
            <Button onClick={() => reply({ kind: "permission", decision: "allow_always" })}>{allowAlwaysLabel(request.suggestions)}</Button>
          )}
          {!request.defaultToNo && deny}
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
            className="w-full rounded-xl border border-line bg-bg px-3 py-2 text-[16px] outline-none focus:border-accent"
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

// A tap that lands as the card appears is not taken for an answer.
const SETTLE_MS = 500;

function useSettled(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setReady(true), SETTLE_MS);
    return () => clearTimeout(t);
  }, []);
  return ready;
}

type Dialog<K extends DialogInfo["kind"]> = Extract<DialogInfo, { kind: K }>;

function RefusalCard({ info, reply }: { info: Dialog<"refusal_fallback_prompt">; reply: Reply }) {
  const models = useApp((s) => s.options?.models) ?? [];
  const ready = useSettled();
  const model = modelLabel(models, info.model);
  const fallback = modelLabel(models, info.fallback);
  const choose = (choice: string) => reply({ kind: "dialog", choice });
  return (
    <Card title="확인 요청" sub="답변이 멈췄습니다" data-dialog={info.kind}>
      <div className="text-[15px]">{refusalText(model, fallback, info.category)}</div>
      <div className="grid gap-2">
        <Button kind="primary" disabled={!ready} onClick={() => choose("retry_fallback")}>
          {fallback}로 계속
        </Button>
        <Button disabled={!ready} onClick={() => choose("edit_prompt")}>
          메시지 고쳐 {model}로 다시
        </Button>
        <Button kind="ghost" disabled={!ready} onClick={() => choose("cancel")}>
          닫기
        </Button>
      </div>
    </Card>
  );
}

function AutoFallbackCard({ info, reply }: { info: Dialog<"auto_mode_server_fallback">; reply: Reply }) {
  const ready = useSettled();
  const choose = (choice: string) => reply({ kind: "dialog", choice });
  return (
    <Card title="확인 요청" sub="Auto 모드 분류기 과금" data-dialog={info.kind}>
      <div className="text-[15px]">이 세션의 Auto 모드가 Claude Code에 들어 있는 분류기를 쓰고, 그 분류기 요청은 과금됩니다. 계속하면 Auto 모드로 이어 가고, 중지하면 이번 턴을 끝냅니다.</div>
      {(info.title || info.paragraphs.length > 0) && (
        <div className="space-y-1 rounded-xl bg-surface-2 px-3 py-2.5 text-xs text-muted" data-dialog-text>
          {info.title && <div className="font-medium">{info.title}</div>}
          {info.paragraphs.map((p, i) => (
            <p key={i} className="whitespace-pre-wrap">
              {p}
            </p>
          ))}
        </div>
      )}
      {info.helpUrl && (
        <a href={info.helpUrl} target="_blank" rel="noopener noreferrer" className="block text-sm font-medium text-accent">
          자세히 보기
        </a>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Button kind="primary" disabled={!ready} onClick={() => choose("continue")}>
          계속
        </Button>
        <Button disabled={!ready} onClick={() => choose("interrupt")}>
          중지
        </Button>
      </div>
    </Card>
  );
}

// Dialogs the phone does not answer: the usage credits consent, and any dialog of a VS Code session whose wrapper is too
// old to pass an answer on, or of a kind the phone does not know.
function DialogCard({ request, reply }: { request: PendingRequest; reply: Reply }) {
  const info = request.dialog;
  if (!request.localOnly && info?.kind === "refusal_fallback_prompt") return <RefusalCard info={info} reply={reply} />;
  if (!request.localOnly && info?.kind === "auto_mode_server_fallback") return <AutoFallbackCard info={info} reply={reply} />;
  return (
    <Card title="확인 요청" sub={dialogLabel(request.toolName)} data-dialog={request.toolName}>
      {info?.kind === "fable_overage_consent_prompt" && <div className="text-[15px]">{creditsText(info)}</div>}
      <div className="rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-muted">VS Code에 확인 창이 열려 있습니다. VS Code에서 답하세요.</div>
      {info?.kind === "fable_overage_consent_prompt" && <div className="text-xs text-muted">답하지 않으면 정해진 시간이 지나 취소되고 이번 턴은 끝납니다.</div>}
    </Card>
  );
}

const PROBLEM: Record<FieldProblem, string> = {
  required: "필수 항목입니다",
  type: "값의 형식이 맞지 않습니다",
  short: "너무 짧습니다",
  long: "너무 깁니다",
  format: "형식이 맞지 않습니다",
  small: "허용 범위보다 작습니다",
  large: "허용 범위보다 큽니다",
  choice: "목록에 있는 값을 고르세요",
  few: "더 골라야 합니다",
  many: "너무 많이 골랐습니다",
};

const FORMAT_HINT = { email: "이메일 주소", uri: "URL", date: "날짜", "date-time": "날짜와 시각" };

const INPUT = "w-full rounded-xl border border-line bg-bg px-3 py-2 text-[16px] outline-none focus:border-accent";

// Form inputs hold text; numbers and date-times become what the schema asks for when the form is sent.
type Draft = Record<string, string | boolean | string[]>;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function localDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function draftOf(fields: ElicitField[]): Draft {
  const d: Draft = {};
  for (const f of fields) {
    if (f.type === "boolean") d[f.key] = f.default ?? false;
    else if (f.type === "multi") d[f.key] = f.default ?? [];
    else if (f.type === "string" && f.format === "date-time" && f.default) d[f.key] = localDateTime(f.default);
    else if (f.default !== undefined) d[f.key] = String(f.default);
  }
  return d;
}

function valueOf(f: ElicitField, v: string | boolean | string[] | undefined): ElicitValue | undefined {
  if (Array.isArray(v) && !v.length) return undefined;
  if (typeof v !== "string") return v;
  if (v.trim() === "") return undefined;
  if (f.type === "number" || f.type === "integer") return Number(v);
  if (f.type === "string" && f.format === "date-time") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d.toISOString().replace(/\.000Z$/, "Z");
  }
  return v;
}

function bounds(f: ElicitField): string | undefined {
  const range = (lo?: number, hi?: number, unit = "") =>
    lo !== undefined && hi !== undefined ? `${lo}–${hi}${unit}` : lo !== undefined ? `${lo}${unit} 이상` : hi !== undefined ? `${hi}${unit} 이하` : undefined;
  if (f.type === "number" || f.type === "integer") return [f.type === "integer" ? "정수" : undefined, range(f.minimum, f.maximum)].filter(Boolean).join(", ") || undefined;
  if (f.type === "string") return [f.format ? FORMAT_HINT[f.format] : undefined, range(f.minLength, f.maxLength, "자")].filter(Boolean).join(", ") || undefined;
  if (f.type === "multi") return range(f.minItems, f.maxItems, "개");
  return undefined;
}

function FieldInput({ field: f, value, onChange }: { field: ElicitField; value: Draft[string] | undefined; onChange: (v: Draft[string]) => void }) {
  if (f.type === "boolean") {
    return (
      <button role="switch" aria-checked={value === true} aria-label={f.title ?? f.key} onClick={() => onChange(value !== true)} className="flex">
        <Switch on={value === true} />
      </button>
    );
  }
  if (f.type === "choice" || f.type === "multi") {
    const picked = f.type === "multi" ? (Array.isArray(value) ? value : []) : typeof value === "string" ? [value] : [];
    const pick = (v: string) => {
      if (f.type === "multi") onChange(picked.includes(v) ? picked.filter((x) => x !== v) : [...picked, v]);
      else onChange(picked.includes(v) && !f.required ? "" : v);
    };
    return (
      <div className="space-y-1.5">
        {f.options.map((o) => {
          const on = picked.includes(o.value);
          return (
            <button
              key={o.value}
              role={f.type === "multi" ? "checkbox" : "radio"}
              aria-checked={on}
              onClick={() => pick(o.value)}
              className={`flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left text-[15px] ${on ? "border-accent bg-accent-soft" : "border-line"}`}
            >
              <span className="min-w-0">{o.title}</span>
              {on && <Icon.check className="size-4 shrink-0 text-accent" />}
            </button>
          );
        })}
      </div>
    );
  }
  const text = typeof value === "string" ? value : "";
  if (f.type === "number" || f.type === "integer") {
    return (
      // iOS number pads have no minus key, so a field that allows negatives keeps the full keyboard.
      <input
        type="number"
        inputMode={(f.minimum ?? -1) < 0 ? undefined : f.type === "integer" ? "numeric" : "decimal"}
        step={f.type === "integer" ? 1 : "any"}
        min={f.minimum}
        max={f.maximum}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        className={INPUT}
      />
    );
  }
  if (f.type !== "string") return null;
  const type = f.format ? { email: "email", uri: "url", date: "date", "date-time": "datetime-local" }[f.format] : "text";
  if (type === "text" && (f.maxLength ?? Infinity) > 200) {
    return <textarea value={text} rows={2} maxLength={f.maxLength} onChange={(e) => onChange(e.target.value)} className={`${INPUT} resize-y`} />;
  }
  return (
    <input
      type={type}
      inputMode={type === "email" ? "email" : type === "url" ? "url" : undefined}
      autoCapitalize={type === "text" ? undefined : "off"}
      autoCorrect={type === "text" ? undefined : "off"}
      maxLength={f.maxLength}
      value={text}
      onChange={(e) => onChange(e.target.value)}
      className={INPUT}
    />
  );
}

function ElicitHead({ info }: { info: ElicitInfo }) {
  return (
    <>
      {info.title && <div className="text-sm font-medium">{info.title}</div>}
      {info.description && <div className="text-xs text-muted">{info.description}</div>}
      {info.message && <div className="text-[15px] whitespace-pre-wrap">{info.message}</div>}
    </>
  );
}

function ElicitationCard({ info, reply }: { info: ElicitInfo; reply: Reply }) {
  const fields = info.fields ?? [];
  const [draft, setDraft] = useState<Draft>(() => draftOf(fields));
  const [errors, setErrors] = useState<Record<string, FieldProblem>>({});
  const answer = (action: "accept" | "decline" | "cancel", content?: Record<string, ElicitValue>) =>
    reply({ kind: "elicitation", action, ...(content ? { content } : {}) });
  const buttons = useRef<HTMLDivElement>(null);
  const submit = () => {
    const content: Record<string, ElicitValue> = {};
    const found: Record<string, FieldProblem> = {};
    for (const f of fields) {
      const v = valueOf(f, Object.hasOwn(draft, f.key) ? draft[f.key] : undefined);
      const problem = fieldProblem(f, v);
      if (problem) found[f.key] = problem;
      else if (v !== undefined) content[f.key] = v;
    }
    setErrors(found);
    const first = Object.keys(found)[0];
    if (first === undefined) return answer("accept", content);
    // The first field to fix may be screens above the button.
    const field = buttons.current?.closest("[data-elicitation]")?.querySelector(`[data-field="${CSS.escape(first)}"]`);
    field?.scrollIntoView({ block: "center" });
    field?.querySelector<HTMLElement>("input, textarea, select, button")?.focus({ preventScroll: true });
  };
  const web = info.mode === "url" && info.url && /^https?:\/\//i.test(info.url) ? info.url : undefined;
  return (
    <Card title="입력 요청" sub={`MCP · ${info.server}`} data-elicitation={info.mode}>
      <ElicitHead info={info} />
      {info.mode === "url" ? (
        <>
          {info.url && <div className="rounded-xl bg-surface-2 px-3 py-2 font-mono text-xs break-all">{info.url}</div>}
          {web ? (
            <a href={web} target="_blank" rel="noopener noreferrer" className="block rounded-xl bg-accent px-3.5 py-2.5 text-center text-[15px] font-medium text-white">
              열기
            </a>
          ) : (
            <div className="rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-muted">이 주소는 휴대폰에서 열 수 없습니다.</div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Button disabled={!web} onClick={() => answer("accept")}>
              완료
            </Button>
            <Button kind="danger" onClick={() => answer("cancel")}>
              취소
            </Button>
          </div>
        </>
      ) : (
        <>
          {info.unsupported ? (
            <div className="rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-muted">이 입력 양식은 휴대폰에서 채울 수 없습니다. 거절하거나 취소하세요.</div>
          ) : (
            fields.map((f) => {
              const hint = bounds(f);
              return (
                <div key={f.key} data-field={f.key} className="space-y-1.5">
                  <div className={f.type === "boolean" ? "flex items-center justify-between gap-3" : "space-y-1.5"}>
                    <div className="min-w-0">
                      <div className="text-[15px] font-medium">
                        {f.title ?? f.key}
                        {f.required && <span className="ml-1 text-xs font-normal text-danger">필수</span>}
                      </div>
                      {f.description && <div className="text-xs text-muted">{f.description}</div>}
                      {hint && <div className="text-xs text-muted">{hint}</div>}
                    </div>
                    <FieldInput
                      field={f}
                      value={Object.hasOwn(draft, f.key) ? draft[f.key] : undefined}
                      onChange={(v) => {
                        setDraft((d) => ({ ...d, [f.key]: v }));
                        setErrors(({ [f.key]: _, ...rest }) => rest);
                      }}
                    />
                  </div>
                  {Object.hasOwn(errors, f.key) && <div className="text-xs text-danger">{PROBLEM[errors[f.key]]}</div>}
                </div>
              );
            })
          )}
          <div ref={buttons} className="grid grid-cols-3 gap-2">
            <Button kind="primary" disabled={info.unsupported} onClick={submit}>
              보내기
            </Button>
            <Button onClick={() => answer("decline")}>거절</Button>
            <Button kind="danger" onClick={() => answer("cancel")}>
              취소
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

// agent: names the subagent that asks, when one does.
export function PendingCard({ request, reply, agent }: { request: PendingRequest; reply: Reply; agent?: string }) {
  if (request.kind === "question") return <QuestionCard request={request} reply={reply} />;
  if (request.kind === "plan") return <PlanCard request={request} reply={reply} />;
  if (request.kind === "dialog") return <DialogCard request={request} reply={reply} />;
  if (request.kind === "elicitation" && request.elicitation) return <ElicitationCard info={request.elicitation} reply={reply} />;
  return <PermissionCard request={request} reply={reply} agent={agent} />;
}
