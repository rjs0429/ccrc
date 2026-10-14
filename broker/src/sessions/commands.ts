import type { CommandInfo } from "../protocol.ts";

// The "/" command list last seen for a folder, for sessions without a running process.
export function rememberCommands(_cwd: string, _commands: CommandInfo[]): void {}

export function lastCommands(_cwd: string): CommandInfo[] {
  return [];
}
