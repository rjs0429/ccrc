import { useMemo, useState } from "react";
import type { DisplayItem } from "../../../broker/src/protocol.ts";
import { currentTodos, type TodoStatus } from "./todos.ts";
import { Icon } from "./ui.tsx";

const MARK: Record<TodoStatus, string> = { completed: "✓", in_progress: "▸", pending: "○" };

// The session's current to-do list, pinned above the composer until every item is done; a very short screen
// (landscape with the keyboard up) leaves it out to keep room for the conversation.
export function TodoPanel({ items }: { items: DisplayItem[] }) {
  const todos = useMemo(() => currentTodos(items), [items]);
  const [open, setOpen] = useState(false);
  const done = todos.filter((t) => t.status === "completed").length;
  if (done === todos.length) return null;
  const current = todos.find((t) => t.status === "in_progress");
  return (
    <div className="border-t border-line bg-bg px-safe-3 tiny:hidden">
      <div className="mx-auto max-w-3xl">
        <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2 py-2 text-left text-[13px] short:py-1.5">
          <span className="shrink-0 font-medium">
            할 일 {done}/{todos.length}
          </span>
          <span className="min-w-0 flex-1 truncate text-muted">{current ? current.activeForm || current.text : ""}</span>
          <Icon.chevronDown className={`size-4 shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        {open && (
          <ul className="max-h-[40dvh] space-y-1 overflow-y-auto pb-2 text-sm">
            {todos.map((t, n) => (
              <li key={n} className={`flex gap-1.5 ${t.status === "completed" ? "text-muted" : t.status === "in_progress" ? "font-medium" : ""}`}>
                <span className={`w-3 shrink-0 text-center ${t.status === "in_progress" ? "text-accent" : ""}`}>{MARK[t.status]}</span>
                <span className={`min-w-0 ${t.status === "completed" ? "line-through" : ""}`}>{t.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
