import type { ReactNode } from "react";
import type { ToolReply } from "../../../../broker/src/protocol.ts";
import { workflowMeta } from "../../../../broker/src/tools.ts";
import { Icon } from "../ui.tsx";
import { Chip, Code, Field, FileCard, FileLink, Fields, Folded, PathValue, Pre, Rest, record, str, Value, type Input } from "./parts.tsx";

function Mono({ children }: { children: string }) {
  return <span className="font-mono text-[13px] break-all">{children}</span>;
}

function WebLink({ url }: { url: string }) {
  return /^https?:\/\//i.test(url) ? (
    <a href={url} target="_blank" rel="noreferrer noopener" className="font-mono text-[12.5px] break-all text-accent">
      {url}
    </a>
  ) : (
    <Mono>{url}</Mono>
  );
}

function Title({ children }: { children: ReactNode }) {
  return <div className="text-[15px] font-medium">{children}</div>;
}

function Chips({ items }: { items: (string | false | undefined)[] }) {
  const shown = items.filter((x): x is string => Boolean(x));
  return shown.length ? (
    <div className="flex flex-wrap gap-1.5">
      {shown.map((c) => (
        <Chip key={c}>{c}</Chip>
      ))}
    </div>
  ) : null;
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}초`;
  if (s < 3600) return `${Math.round(s / 60)}분`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${h}시간 ${m}분` : `${h}시간`;
}

const TASK_STATUS: Record<string, string> = { pending: "대기", in_progress: "진행 중", completed: "완료", deleted: "삭제" };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function Plain({ label, text }: { label: string; text: string }) {
  return text ? (
    <Field label={label}>
      <Folded text={text} plain />
    </Field>
  ) : null;
}

// Light views for frequent tools: the fields that say what the call does, then any other keys as rows.
export function SpecificView({ name, i }: { name: string; i: Input }): ReactNode {
  switch (name) {
    case "Glob":
      return (
        <Fields>
          <Field label="패턴">
            <Mono>{str(i.pattern)}</Mono>
          </Field>
          {str(i.path) && (
            <Field label="위치">
              <PathValue path={str(i.path)} />
            </Field>
          )}
          <Rest input={i} skip={["pattern", "path"]} />
        </Fields>
      );
    case "Grep":
      return (
        <Fields>
          <Field label="패턴">
            <Mono>{str(i.pattern)}</Mono>
          </Field>
          {str(i.path) && (
            <Field label="위치">
              <PathValue path={str(i.path)} />
            </Field>
          )}
          {str(i.glob) && (
            <Field label="파일">
              <Mono>{str(i.glob)}</Mono>
            </Field>
          )}
          <Rest input={i} skip={["pattern", "path", "glob"]} />
        </Fields>
      );
    case "WebFetch":
      return (
        <Fields>
          <Field label="URL">
            <WebLink url={str(i.url)} />
          </Field>
          <Plain label="요청" text={str(i.prompt)} />
          <Rest input={i} skip={["url", "prompt"]} />
        </Fields>
      );
    case "WebSearch":
      return (
        <Fields>
          <Field label="검색어">{str(i.query)}</Field>
          {Array.isArray(i.allowed_domains) && i.allowed_domains.length > 0 && <Field label="이 사이트에서만">{i.allowed_domains.join(", ")}</Field>}
          {Array.isArray(i.blocked_domains) && i.blocked_domains.length > 0 && <Field label="뺄 사이트">{i.blocked_domains.join(", ")}</Field>}
          <Rest input={i} skip={["query", "allowed_domains", "blocked_domains"]} />
        </Fields>
      );
    case "Agent":
    case "Task":
      return (
        <Fields>
          {str(i.description) && <Title>{str(i.description)}</Title>}
          <Chips items={[str(i.subagent_type), str(i.model), i.run_in_background === true && "백그라운드", str(i.isolation) && `격리: ${str(i.isolation)}`]} />
          <Plain label="지시" text={str(i.prompt)} />
          <Rest input={i} skip={["description", "subagent_type", "model", "run_in_background", "isolation", "prompt"]} />
        </Fields>
      );
    case "Skill":
      return (
        <Fields>
          <Title>
            <Mono>{`/${str(i.skill)}`}</Mono>
          </Title>
          <Plain label="인자" text={str(i.args)} />
          <Rest input={i} skip={["skill", "args"]} />
        </Fields>
      );
    case "NotebookEdit":
      return (
        <Fields>
          <FileLink path={str(i.notebook_path)} />
          <Chips items={[str(i.edit_mode), str(i.cell_type), str(i.cell_id) && `셀 ${str(i.cell_id)}`]} />
          {str(i.new_source) && <Code text={str(i.new_source)} />}
          <Rest input={i} skip={["notebook_path", "edit_mode", "cell_type", "cell_id", "new_source"]} />
        </Fields>
      );
    case "ToolSearch":
      return (
        <Fields>
          <Field label="찾는 도구">
            <Mono>{str(i.query)}</Mono>
          </Field>
          {num(i.max_results) !== undefined && <Field label="최대 개수">{num(i.max_results)}</Field>}
          <Rest input={i} skip={["query", "max_results"]} />
        </Fields>
      );
    case "TaskCreate":
      return (
        <Fields>
          <Title>{str(i.subject)}</Title>
          <Plain label="설명" text={str(i.description)} />
          {str(i.activeForm) && <Field label="진행 중 표시">{str(i.activeForm)}</Field>}
          <Rest input={i} skip={["subject", "description", "activeForm"]} />
        </Fields>
      );
    case "TaskUpdate":
      return (
        <Fields>
          <Chips items={[str(i.taskId) && `#${str(i.taskId)}`, TASK_STATUS[str(i.status)] ?? str(i.status)]} />
          {str(i.subject) && <Title>{str(i.subject)}</Title>}
          <Plain label="설명" text={str(i.description)} />
          <Rest input={i} skip={["taskId", "status", "subject", "description"]} />
        </Fields>
      );
    case "TaskStop":
      return (
        <Fields>
          <Field label="멈출 작업">
            <Mono>{str(i.task_id) || str(i.shell_id)}</Mono>
          </Field>
          <Rest input={i} skip={["task_id", "shell_id"]} />
        </Fields>
      );
    case "Workflow": {
      const script = str(i.script);
      const title = workflowMeta(script, "name") || str(i.name);
      const description = workflowMeta(script, "description");
      return (
        <Fields>
          {title && <Title>{title}</Title>}
          {description && <div className="text-sm text-muted">{description}</div>}
          {str(i.scriptPath) && (
            <Field label="스크립트 파일">
              <FileLink path={str(i.scriptPath)} />
            </Field>
          )}
          {i.args !== undefined && (
            <Field label="인자">
              <Value name="args" value={i.args} />
            </Field>
          )}
          {script && (
            <Field label="스크립트">
              <Code text={script} />
            </Field>
          )}
          <Rest input={i} skip={["script", "name", "description", "title", "scriptPath", "args"]} />
        </Fields>
      );
    }
    case "PushNotification":
      return (
        <Fields>
          <div className="text-[14px] whitespace-pre-wrap">{str(i.message)}</div>
          <Rest input={i} skip={["message", "status"]} />
        </Fields>
      );
    case "SendUserFile": {
      const files = (Array.isArray(i.files) ? i.files : [i.file_path ?? i.path]).filter((f): f is string => typeof f === "string" && f !== "");
      return (
        <Fields>
          {files.map((f, n) => (
            <FileCard key={n} path={f} />
          ))}
          {str(i.caption) && <div className="text-[14px] whitespace-pre-wrap">{str(i.caption)}</div>}
          <Rest input={i} skip={["files", "file_path", "path", "caption", "status"]} />
        </Fields>
      );
    }
    case "ScheduleWakeup": {
      const delay = num(i.delaySeconds);
      return (
        <Fields>
          <Title>{i.stop === true ? "반복 멈춤" : delay !== undefined ? `${duration(delay * 1000)} 뒤 다시 실행` : "다시 실행"}</Title>
          {str(i.reason) && <div className="text-sm text-muted">{str(i.reason)}</div>}
          {str(i.prompt) && (
            <Field label="실행할 입력">
              <Code text={str(i.prompt)} />
            </Field>
          )}
          <Rest input={i} skip={["delaySeconds", "reason", "prompt", "stop"]} />
        </Fields>
      );
    }
    case "CronCreate":
      return (
        <Fields>
          <Field label="일정">
            <Mono>{str(i.cron)}</Mono>
          </Field>
          <Chips items={[i.recurring === false ? "한 번" : "반복", i.durable === true && "재시작 뒤에도 유지"]} />
          <Plain label="실행할 입력" text={str(i.prompt)} />
          <Rest input={i} skip={["cron", "prompt", "recurring", "durable"]} />
        </Fields>
      );
    case "Monitor": {
      const ws = record(i.ws);
      const timeout = num(i.timeout_ms);
      return (
        <Fields>
          {str(i.description) && <Title>{str(i.description)}</Title>}
          {str(i.command) && <Pre>{`$ ${str(i.command)}`}</Pre>}
          {ws && (
            <Field label="WebSocket">
              <WebLink url={str(ws.url)} />
            </Field>
          )}
          <Chips items={[timeout !== undefined && `제한 ${duration(timeout)}`, i.persistent === true && "계속 지켜봄"]} />
          <Rest input={i} skip={["description", "command", "ws", "timeout_ms", "persistent"]} />
        </Fields>
      );
    }
  }
  return undefined;
}

export function McpView({ name, i }: { name: { server: string; tool: string }; i: Input }) {
  return (
    <Fields>
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip>{name.server}</Chip>
        <Mono>{name.tool}</Mono>
      </div>
      {Object.keys(i).length ? <Rest input={i} /> : <div className="text-sm text-muted">인자 없음</div>}
    </Fields>
  );
}

function PlanOutcome({ reply }: { reply: ToolReply }) {
  if (reply.kind === "approved") {
    return (
      <div className="flex items-center gap-1.5 text-sm" data-status>
        <Icon.check className="size-4 text-ok" />
        승인됨{reply.plan ? " · 고친 계획으로" : ""}
      </div>
    );
  }
  if (reply.kind === "kept_planning") {
    return (
      <div className="rounded-lg bg-surface-2 px-2.5 py-1.5 text-sm" data-status>
        <div className="text-muted">계속 계획하기</div>
        {reply.feedback && <div className="mt-0.5 whitespace-pre-wrap">고칠 점: {reply.feedback}</div>}
      </div>
    );
  }
  return reply.kind === "interrupted" ? (
    <div className="rounded-lg bg-surface-2 px-2.5 py-1.5 text-sm text-muted" data-status>
      중단되었습니다
    </div>
  ) : null;
}

// ExitPlanMode: the plan (as the user edited it, when they did) and what became of it.
export function PlanView({ i, reply }: { i: Input; reply?: ToolReply }) {
  const plan = reply?.kind === "approved" && reply.plan ? reply.plan : str(i.plan);
  const prompts = (Array.isArray(i.allowedPrompts) ? i.allowedPrompts : []).flatMap((p) => {
    const r = record(p);
    return r && str(r.prompt) ? [`${str(r.tool)}${str(r.tool) ? ": " : ""}${str(r.prompt)}`] : [];
  });
  return (
    <div className="space-y-2" data-plan-view={reply?.kind ?? "none"}>
      {reply && <PlanOutcome reply={reply} />}
      {plan ? (
        <div className="rounded-xl border border-line bg-bg p-3">
          <Folded text={plan} />
        </div>
      ) : (
        <div className="text-sm text-muted">계획 내용 없음</div>
      )}
      {prompts.length > 0 && (
        <Field label="허용을 청한 명령">
          <ul className="space-y-0.5">
            {prompts.map((p, n) => (
              <li key={n} className="font-mono text-[12.5px]">
                {p}
              </li>
            ))}
          </ul>
        </Field>
      )}
      <Rest input={i} skip={["plan", "allowedPrompts"]} />
    </div>
  );
}
