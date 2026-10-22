import { useMemo, useState } from "react";
import type { ToolReply } from "../../../broker/src/protocol.ts";
import { mcpName } from "../../../broker/src/tools.ts";
import { t } from "../i18n/index.ts";
import { DiffView } from "./diff/DiffView.tsx";
import { snippetHunk } from "./diff/hunks.ts";
import { FileLink, Pre, Rest, str, type Input } from "./tools/parts.tsx";
import { QuestionView } from "./tools/Question.tsx";
import { McpView, PlanView, SpecificView } from "./tools/views.tsx";

function EditDiff({ before, after }: { before: string; after: string }) {
  const hunks = useMemo(() => [snippetHunk(before, after)], [before, after]);
  return <DiffView hunks={hunks} numbers={false} />;
}

const TODO_MARK: Record<string, string> = { completed: "✓", in_progress: "▸", pending: "○" };

// Tools whose own view says all their input does, without a 원문 toggle.
function BasicView({ name, i }: { name: string; i: Input }) {
  switch (name) {
    case "Bash":
      return (
        <div className="space-y-1.5">
          {str(i.description) && <div className="text-sm text-muted">{str(i.description)}</div>}
          <Pre>{`$ ${str(i.command)}`}</Pre>
        </div>
      );
    case "Edit":
      return (
        <div className="space-y-1.5">
          <FileLink path={str(i.file_path)} />
          <EditDiff before={str(i.old_string)} after={str(i.new_string)} />
        </div>
      );
    case "MultiEdit":
      return (
        <div className="space-y-1.5">
          <FileLink path={str(i.file_path)} />
          {(Array.isArray(i.edits) ? (i.edits as Input[]) : []).map((e, n) => (
            <EditDiff key={n} before={str(e.old_string)} after={str(e.new_string)} />
          ))}
        </div>
      );
    case "Write":
      return (
        <div className="space-y-1.5">
          <FileLink path={str(i.file_path)} />
          <Pre>{str(i.content)}</Pre>
        </div>
      );
    case "Read":
      return <FileLink path={str(i.file_path)} line={typeof i.offset === "number" && i.offset > 0 ? i.offset : undefined} />;
    case "TodoWrite":
      return (
        <ul className="space-y-1 text-sm">
          {(Array.isArray(i.todos) ? (i.todos as Input[]) : []).map((t, n) => (
            <li key={n} className={t.status === "completed" ? "text-muted line-through" : ""}>
              <span className="mr-1.5 inline-block w-3 text-center">{TODO_MARK[str(t.status)] ?? "○"}</span>
              {str(t.content)}
            </li>
          ))}
        </ul>
      );
  }
  return null;
}

function ReadableView({ name, i, reply }: { name: string; i: Input; reply?: ToolReply }) {
  if (name === "AskUserQuestion") return <QuestionView input={i} reply={reply} />;
  if (name === "ExitPlanMode") return <PlanView i={i} reply={reply} />;
  const mcp = mcpName(name);
  if (mcp) return <McpView name={mcp} i={i} />;
  const specific = SpecificView({ name, i });
  if (specific) return specific;
  return Object.keys(i).length ? <Rest input={i} /> : <div className="text-sm text-muted">{t("입력 없음")}</div>;
}

export function ToolInput({ name, input, reply }: { name: string; input: unknown; reply?: ToolReply }) {
  const [raw, setRaw] = useState(false);
  const i = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Input;
  const basic = BasicView({ name, i });
  if (basic) return basic;
  return (
    <div className="space-y-1.5" data-tool-view={name}>
      <div className="flex justify-end">
        <button onClick={() => setRaw(!raw)} className="-my-1.5 -mr-2 px-2 py-1.5 text-xs font-medium text-accent" data-raw-toggle>
          {raw ? t("보기") : t("원문")}
        </button>
      </div>
      {raw ? <Pre>{JSON.stringify(input, null, 2)}</Pre> : <ReadableView name={name} i={i} reply={reply} />}
    </div>
  );
}

export function ToolOutput({ text, isError }: { text: string; isError: boolean }) {
  if (!text.trim()) return null;
  return <pre className={`max-h-72 overflow-auto rounded-lg bg-code p-2.5 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap break-all ${isError ? "text-danger" : "text-muted"}`}>{text}</pre>;
}
