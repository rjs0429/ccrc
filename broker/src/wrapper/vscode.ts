import fs from "node:fs";
import path from "node:path";
import { argValue } from "./relay.ts";

const EXTENSION_STATE_KEY = "Anthropic.claude-code";
const SESSION_ID = /^[0-9a-zA-Z-]{1,64}$/;

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

// VS Code hands its extension host's environment on to Claude Code, including the code cache folder
// <user data>/CachedData/<commit>; the user data folder holds the settings and the extensions' state.
export function userDataDir(env: NodeJS.ProcessEnv): string | undefined {
  const cache = env.VSCODE_CODE_CACHE_PATH;
  if (!cache || path.basename(path.dirname(cache)) !== "CachedData") return undefined;
  return path.dirname(path.dirname(cache));
}

function stringEnd(text: string, i: number): number {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === '"') return j + 1;
  }
  return text.length;
}

// JSON with comments and trailing commas, the format of VS Code's settings.json.
export function parseJsonc(text: string): unknown {
  let bare = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      const end = stringEnd(text, i);
      bare += text.slice(i, end);
      i = end - 1;
    } else if (text.startsWith("//", i)) {
      const nl = text.indexOf("\n", i);
      i = (nl < 0 ? text.length : nl) - 1;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else bare += text[i];
  }
  let out = "";
  for (let i = 0; i < bare.length; i++) {
    if (bare[i] === '"') {
      const end = stringEnd(bare, i);
      out += bare.slice(i, end);
      i = end - 1;
      continue;
    }
    if (bare[i] === ",") {
      let j = i + 1;
      while (j < bare.length && /\s/.test(bare[j])) j++;
      if (bare[j] === "}" || bare[j] === "]") continue;
    }
    out += bare[i];
  }
  return JSON.parse(out);
}

export function readSettings(dataDir: string): Obj {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dataDir, "User", "settings.json"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  const v = text.trim() ? parseJsonc(text) : {};
  return isObject(v) ? v : {};
}

function sessionMode(dataDir: string, sessionId: string): unknown {
  const file = path.join(dataDir, "User", "globalStorage", "anthropic.claude-code", "session-permission-modes", `${sessionId}.json`);
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return isObject(v) ? v.mode : undefined;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

async function extensionState(dataDir: string): Promise<Obj> {
  const file = path.join(dataDir, "User", "globalStorage", "state.vscdb");
  if (!fs.existsSync(file)) return {};
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true, timeout: 1000 });
  try {
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(EXTENSION_STATE_KEY) as { value?: unknown } | undefined;
    const raw = row?.value instanceof Uint8Array ? Buffer.from(row.value).toString("utf8") : row?.value;
    const v = typeof raw === "string" ? JSON.parse(raw) : undefined;
    return isObject(v) ? v : {};
  } finally {
    db.close();
  }
}

const named = (v: unknown) => typeof v === "string" && v !== "";

// Whether the Claude Code extension had a permission mode of its own for a launch: its initialPermissionMode
// setting, the mode it remembers for the resumed session, or the mode last picked in its menu. Undefined
// when that cannot be read.
export async function extensionHasMode(dataDir: string, resumedSession?: string): Promise<boolean | undefined> {
  try {
    if (named(readSettings(dataDir)["claudeCode.initialPermissionMode"])) return true;
    if (resumedSession !== undefined) {
      if (!SESSION_ID.test(resumedSession)) return undefined;
      if (named(sessionMode(dataDir, resumedSession))) return true;
    }
    return named((await extensionState(dataDir)).defaultPermissionMode);
  } catch {
    return undefined;
  }
}

export function withoutOption(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) i++;
    else if (!args[i].startsWith(name + "=")) out.push(args[i]);
  }
  return out;
}

// Without a mode of its own the extension names "default" for a launch through a wrapper and none otherwise,
// which leaves the choice to Claude Code's settings. Dropping that "default" makes both start alike.
export async function permissionArgs(args: string[], dataDir: string | undefined): Promise<string[]> {
  if (!dataDir || argValue(args, "--permission-mode") !== "default") return args;
  return (await extensionHasMode(dataDir, argValue(args, "--resume"))) === false ? withoutOption(args, "--permission-mode") : args;
}

// The extension's claudeCode.continueAfterReload setting, on unless turned off.
export function continuesAfterReload(dataDir: string | undefined): boolean {
  if (!dataDir) return true;
  try {
    return readSettings(dataDir)["claudeCode.continueAfterReload"] !== false;
  } catch {
    return true;
  }
}
