import type { DisplayItem } from "./protocol.ts";

// Commands VS Code answers in a window of its own instead of the conversation: the ones its "/" menu opens
// as dialogs, the ones it takes over when typed, and /effort. Their results stay out of the conversation.
const DIALOG = new Set([
  "context",
  "usage",
  "effort",
  "status",
  "mcp",
  "config",
  "hooks",
  "memory",
  "permissions",
  "plugin",
  "rewind",
  "resume",
  "help",
  "bookmarks",
  "model",
  "copy",
  "remote-control",
  "skills",
  "login",
  "logout",
  "tasks",
  "chrome",
  "sandbox",
  "btw",
  "export",
  "plan",
  "bug",
  "output-style",
]);

const ALIASES: Record<string, string> = {
  cost: "usage",
  stats: "usage",
  settings: "config",
  "allowed-tools": "permissions",
  plugins: "plugin",
  marketplace: "plugin",
  checkpoint: "rewind",
  undo: "rewind",
  continue: "resume",
  rc: "remote-control",
  bashes: "tasks",
  feedback: "bug",
};

// A command's name without "/" and with aliases folded into the name they stand for.
export function commandName(name: string): string {
  const n = name.replace(/^\//, "").toLowerCase();
  return ALIASES[n] ?? n;
}

export function isDialogCommand(name: string | undefined): boolean {
  return name !== undefined && DIALOG.has(commandName(name));
}

// "/name args" as a message gives it.
export function parseCommand(text: string): { name: string; args: string } | undefined {
  const m = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { name: m[1], args: (m[2] ?? "").trim() } : undefined;
}

const lineOf = (item: DisplayItem | undefined): string | undefined =>
  item?.kind === "note" && item.code === "command" ? item.text : item?.kind === "user" && !item.images && !item.files ? item.text : undefined;

// The dialog command a result belongs to. Older transcripts keep no name with a result; the "/name" line
// just before it names it then.
function dialogResult(items: DisplayItem[], i: number): string | undefined {
  const item = items[i];
  if (item?.kind !== "command") return undefined;
  const name = item.name ?? parseCommand(lineOf(items[i - 1]) ?? "")?.name;
  return isDialogCommand(name) ? commandName(name!) : undefined;
}

// The items without dialog commands: their results, the bare "/name" lines that ran them, and a "/name args"
// line next to its hidden result.
export function hideDialogCommands(items: DisplayItem[]): DisplayItem[] {
  return items.filter((item, i) => {
    if (item.kind === "command") return !dialogResult(items, i);
    const line = lineOf(item);
    const c = line === undefined ? undefined : parseCommand(line);
    if (!c || !isDialogCommand(c.name)) return true;
    if (!c.args) return false;
    const name = commandName(c.name);
    return dialogResult(items, i - 1) !== name && dialogResult(items, i + 1) !== name;
  });
}
