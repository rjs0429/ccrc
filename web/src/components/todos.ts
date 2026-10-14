import type { DisplayItem } from "../../../broker/src/protocol.ts";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
  text: string;
  status: TodoStatus;
  activeForm?: string;
}

type Input = Record<string, unknown>;

const str = (v: unknown) => (typeof v === "string" ? v : "");
const status = (v: unknown): TodoStatus => (v === "in_progress" || v === "completed" ? v : "pending");
const CREATED = /^Task #(\S+) created/;
// TaskList answers with one "#<id> [<status>] <subject>" line per task.
const LISTED = /^#(\S+) \[(\w+)\] (.*?)(?: \[blocked by [^\]]*\])?$/;

// The latest to-do list in the conversation. Claude Code keeps it either with TodoWrite, which sends the
// whole list each time, or with TaskCreate/TaskUpdate, whose changes add up; whichever was used last counts.
export function currentTodos(items: DisplayItem[]): Todo[] {
  let written: Todo[] = [];
  let tasks = new Map<string, Todo>();
  let fromTasks = false;
  for (const item of items) {
    if (item.kind !== "tool" || item.result?.isError) continue;
    const i = (item.input && typeof item.input === "object" ? item.input : {}) as Input;
    if (item.name === "TodoWrite" && Array.isArray(i.todos)) {
      written = (i.todos as Input[]).map((t) => ({ text: str(t.content), status: status(t.status), activeForm: str(t.activeForm) || undefined }));
      fromTasks = false;
    } else if (item.name === "TaskCreate") {
      const id = item.result?.text.match(CREATED)?.[1];
      if (!id) continue;
      tasks.set(id, { text: str(i.subject), status: "pending", activeForm: str(i.activeForm) || undefined });
      fromTasks = true;
    } else if (item.name === "TaskUpdate") {
      const id = str(i.taskId);
      const task: Todo | undefined = tasks.get(id) ?? (str(i.subject) ? { text: str(i.subject), status: "pending" } : undefined);
      if (!task) continue;
      if (i.status === "deleted") tasks.delete(id);
      else {
        const next = i.status ? status(i.status) : task.status;
        tasks.set(id, { text: str(i.subject) || task.text, status: next, activeForm: str(i.activeForm) || task.activeForm });
      }
      fromTasks = true;
    } else if (item.name === "TaskList" && item.result) {
      const listed = new Map<string, Todo>();
      for (const line of item.result.text.split("\n")) {
        const m = line.match(LISTED);
        if (m) listed.set(m[1], { ...tasks.get(m[1]), text: tasks.get(m[1])?.text ?? m[3], status: status(m[2]) });
      }
      tasks = listed;
      fromTasks = true;
    }
  }
  return fromTasks ? [...tasks.values()] : written;
}
