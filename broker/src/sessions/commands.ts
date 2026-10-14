import fs from "node:fs";
import path from "node:path";
import { paths, writeFileAtomic } from "../config.ts";
import type { CommandInfo } from "../protocol.ts";
import { commandInfo } from "./core.ts";

const KEEP_FOLDERS = 30;

interface Saved {
  last: CommandInfo[];
  folders: [string, CommandInfo[]][];
}

// The "/" command lists Claude Code last reported, per folder and overall, kept across broker restarts.
export class CommandMemory {
  private file: string;
  private loaded?: { last: CommandInfo[]; folders: Map<string, CommandInfo[]> };

  constructor(file: string) {
    this.file = file;
  }

  // An empty list says nothing about the folder, so it does not replace a known one.
  remember(cwd: string, commands: CommandInfo[]): void {
    if (!commands.length) return;
    const m = this.load();
    const json = JSON.stringify(commands);
    if (JSON.stringify(m.folders.get(cwd)) === json && JSON.stringify(m.last) === json) return;
    m.folders.delete(cwd);
    m.folders.set(cwd, commands);
    for (const old of [...m.folders.keys()].slice(0, -KEEP_FOLDERS)) m.folders.delete(old);
    m.last = commands;
    const saved: Saved = { last: m.last, folders: [...m.folders] };
    try {
      writeFileAtomic(this.file, JSON.stringify(saved) + "\n");
    } catch {}
  }

  last(cwd: string): CommandInfo[] {
    const m = this.load();
    const own = m.folders.get(cwd);
    return own?.length ? own : m.last;
  }

  private load() {
    if (this.loaded) return this.loaded;
    this.loaded = { last: [], folders: new Map() };
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<Saved>;
      this.loaded.last = commandInfo(saved.last);
      for (const entry of Array.isArray(saved.folders) ? saved.folders : []) {
        if (Array.isArray(entry) && typeof entry[0] === "string") this.loaded.folders.set(entry[0], commandInfo(entry[1]));
      }
    } catch {}
    return this.loaded;
  }
}

let shared: CommandMemory | undefined;

function memory(): CommandMemory {
  return (shared ??= new CommandMemory(path.join(paths.stateDir, "commands.json")));
}

// The "/" command list last seen for a folder, for sessions without a running process.
export function rememberCommands(cwd: string, commands: CommandInfo[]): void {
  memory().remember(cwd, commands);
}

export function lastCommands(cwd: string): CommandInfo[] {
  return memory().last(cwd);
}
