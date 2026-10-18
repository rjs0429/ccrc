import { commandName, parseCommand } from "../../../broker/src/dialog-commands.ts";
import type { CommandInfo } from "../../../broker/src/protocol.ts";

export type CommandSheet = "context" | "usage" | "mcp" | "agents" | "rewind" | "model" | "effort" | "config" | "permissions" | "outputStyle" | "fork" | "btw";

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
  btw: { sheet: "btw", title: "곁질문" },
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

// Commands the phone answers itself that Claude Code does not list for a session it runs headless.
export const PHONE_COMMANDS: CommandInfo[] = [{ name: "btw", description: "진행 중인 작업을 끊지 않고 곁질문합니다", argumentHint: "<질문>" }];

// The "/" commands to offer for a session: Claude Code's, then the phone's own it does not list.
export function withPhoneCommands(listed: CommandInfo[] | undefined): CommandInfo[] {
  const names = new Set((listed ?? []).map((c) => c.name));
  return [...(listed ?? []), ...PHONE_COMMANDS.filter((c) => !names.has(c.name))];
}
