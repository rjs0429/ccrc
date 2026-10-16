import { commandName, parseCommand } from "../../../broker/src/dialog-commands.ts";

export type CommandSheet = "context" | "usage" | "mcp" | "agents" | "rewind" | "model" | "effort" | "config" | "permissions" | "outputStyle" | "fork";

// Bare "/" commands the phone answers with a sheet or page of its own instead of sending them, the way VS Code
// opens a dialog. live: the sheet needs the session's Claude Code process. Aliases resolve through commandName.
export const COMMAND_SHEETS: Record<string, { sheet: CommandSheet; title: string; live?: boolean }> = {
  context: { sheet: "context", title: "Context" },
  usage: { sheet: "usage", title: "사용량" },
  mcp: { sheet: "mcp", title: "MCP 서버", live: true },
  model: { sheet: "model", title: "모델" },
  effort: { sheet: "effort", title: "Effort" },
  tasks: { sheet: "agents", title: "에이전트 지도" },
  rewind: { sheet: "rewind", title: "되돌리기" },
  fork: { sheet: "fork", title: "갈래 만들기" },
  branch: { sheet: "fork", title: "갈래 만들기" },
  "output-style": { sheet: "outputStyle", title: "출력 스타일", live: true },
  config: { sheet: "config", title: "Claude Code 설정" },
  permissions: { sheet: "permissions", title: "권한 규칙" },
};

export function commandSheet(name: string): (typeof COMMAND_SHEETS)[string] | undefined {
  return COMMAND_SHEETS[commandName(name)];
}

// The command a message consists of when it is a bare "/name" with a sheet here.
export function bareCommandSheet(text: string): string | undefined {
  const c = parseCommand(text);
  return c && !c.args && commandSheet(c.name) ? c.name : undefined;
}
