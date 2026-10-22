import { commandName, parseCommand } from "../../../broker/src/dialog-commands.ts";
import type { CommandInfo } from "../../../broker/src/protocol.ts";
import { k, kc, t, type Placed } from "../i18n/index.ts";

export type CommandSheet = "context" | "usage" | "mcp" | "agents" | "rewind" | "model" | "effort" | "config" | "permissions" | "outputStyle" | "fork" | "btw" | "export" | "copy";

// Bare "/" commands the phone answers with a sheet or page of its own instead of sending them, the way VS Code
// opens a dialog. live: the sheet needs the session's Claude Code process. Aliases resolve through commandName. The
// title is handed to t() where it is shown.
export const COMMAND_SHEETS: Record<string, { sheet: CommandSheet; title: string | Placed; live?: boolean }> = {
  context: { sheet: "context", title: "Context" },
  usage: { sheet: "usage", title: k("사용량") },
  mcp: { sheet: "mcp", title: kc("server list", "MCP 서버"), live: true },
  model: { sheet: "model", title: k("모델") },
  effort: { sheet: "effort", title: "Effort" },
  tasks: { sheet: "agents", title: k("에이전트 지도") },
  rewind: { sheet: "rewind", title: k("되돌리기") },
  fork: { sheet: "fork", title: k("갈래 만들기") },
  branch: { sheet: "fork", title: k("갈래 만들기") },
  btw: { sheet: "btw", title: k("곁질문") },
  "output-style": { sheet: "outputStyle", title: k("출력 스타일"), live: true },
  export: { sheet: "export", title: k("대화 내보내기") },
  copy: { sheet: "copy", title: k("답 복사") },
  config: { sheet: "config", title: k("Claude Code 설정") },
  permissions: { sheet: "permissions", title: k("권한 규칙") },
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
export const PHONE_COMMANDS: CommandInfo[] = [
  { name: "btw", description: k("진행 중인 작업을 끊지 않고 곁질문합니다"), argumentHint: k("<질문>") },
  { name: "copy", description: k("Claude의 마지막 답을 Markdown 원문으로 복사합니다") },
  { name: "export", description: k("대화를 Markdown 파일로 내보냅니다") },
];

// The "/" commands to offer for a session: Claude Code's, then the phone's own it does not list.
export function withPhoneCommands(listed: CommandInfo[] | undefined): CommandInfo[] {
  const names = new Set((listed ?? []).map((c) => c.name));
  const own = PHONE_COMMANDS.filter((c) => !names.has(c.name)).map((c) => ({
    ...c,
    description: t(c.description),
    ...(c.argumentHint ? { argumentHint: t(c.argumentHint) } : {}),
  }));
  return [...(listed ?? []), ...own];
}
