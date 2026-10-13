type Input = Record<string, unknown>;

const str = (v: unknown) => (typeof v === "string" ? v : "");

function Pre({ children, tone }: { children: string; tone?: "del" | "add" }) {
  const toneClass = tone === "del" ? "bg-danger/10" : tone === "add" ? "bg-ok/10" : "bg-code";
  return <pre className={`max-h-72 overflow-auto rounded-lg p-2.5 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap break-all ${toneClass}`}>{children}</pre>;
}

function Path({ value }: { value: string }) {
  return <div className="font-mono text-[12.5px] break-all text-muted">{value}</div>;
}

const TODO_MARK: Record<string, string> = { completed: "✓", in_progress: "▸", pending: "○" };

export function ToolInput({ name, input }: { name: string; input: unknown }) {
  const i = (input && typeof input === "object" ? input : {}) as Input;
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
          <Path value={str(i.file_path)} />
          <Pre tone="del">{str(i.old_string)}</Pre>
          <Pre tone="add">{str(i.new_string)}</Pre>
        </div>
      );
    case "MultiEdit":
      return (
        <div className="space-y-1.5">
          <Path value={str(i.file_path)} />
          {(Array.isArray(i.edits) ? (i.edits as Input[]) : []).map((e, n) => (
            <div key={n} className="space-y-1">
              <Pre tone="del">{str(e.old_string)}</Pre>
              <Pre tone="add">{str(e.new_string)}</Pre>
            </div>
          ))}
        </div>
      );
    case "Write":
      return (
        <div className="space-y-1.5">
          <Path value={str(i.file_path)} />
          <Pre>{str(i.content)}</Pre>
        </div>
      );
    case "Read":
      return <Path value={str(i.file_path)} />;
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
    default:
      return <Pre>{JSON.stringify(input, null, 2)}</Pre>;
  }
}

export function ToolOutput({ text, isError }: { text: string; isError: boolean }) {
  if (!text.trim()) return null;
  return <pre className={`max-h-72 overflow-auto rounded-lg bg-code p-2.5 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap break-all ${isError ? "text-danger" : "text-muted"}`}>{text}</pre>;
}
