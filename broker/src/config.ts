import fs from "node:fs";
import path from "node:path";
import { paths } from "./paths.ts";
import { UPDATE_CHANNELS, type UpdateChannel } from "./releases.ts";

export { paths };

// How broker sessions (the ones ccrc starts itself through the Agent SDK) sign in. off: none start, VS Code sessions are
// still driven; apiKey: with the key in <configDir>/anthropic-api-key; subscription: with Claude Code's own login.
export type BrokerSessions = "off" | "apiKey" | "subscription";
export const BROKER_SESSIONS: readonly BrokerSessions[] = ["off", "apiKey", "subscription"];

export interface Config {
  // The config format; see MIGRATIONS.
  schemaVersion?: number;
  host: string;
  port: number;
  // Tailnet machine names (first DNS label, e.g. "phone") allowed through `tailscale serve`.
  allowedDevices: string[];
  // Requests without X-Forwarded-For come from this machine itself.
  allowLocal: boolean;
  // Claude Code CLI for broker sessions: a path, or "vscode" (or unset) for the one bundled in the newest VS Code
  // extension, else ~/.local/bin/claude, else the one bundled with the Agent SDK.
  claudePath?: string;
  // New sessions may start in these folders and below, besides folders that already have sessions.
  roots: string[];
  leaseIdleMinutes: number;
  sessionIdleMinutes: number;
  // Unset only where a config is made in code; a config file always has it once migrated.
  brokerSessions?: BrokerSessions;
  // Look for new ccrc releases with git ls-remote a minute after start and daily, on the stable or rc channel, in
  // updateRepo when the install does not name its source; updateNotify pushes one notification per new version.
  // Unset only where a config is made in code, which means true, "stable" and true.
  updateCheck?: boolean;
  updateChannel?: UpdateChannel;
  updateRepo?: string;
  updateNotify?: boolean;
  // Sessions the Claude Code extension in VS Code archived, by hand or after its days without use, count as archived in
  // ccrc's list too. Read from VS Code's state database, never written. Unset means false.
  vscodeArchive?: boolean;
}

export const FOLLOW_VSCODE = "vscode";

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

function defaults(): Config {
  return {
    host: "127.0.0.1",
    port: 8737,
    allowedDevices: [],
    allowLocal: true,
    claudePath: FOLLOW_VSCODE,
    roots: [],
    leaseIdleMinutes: 720,
    sessionIdleMinutes: 15,
    updateCheck: true,
    updateChannel: "stable",
    updateNotify: true,
    vscodeArchive: false,
  };
}

// What a config file starts as when there is none.
export function newConfig(): Config {
  return { schemaVersion: SCHEMA_VERSION, ...defaults(), brokerSessions: "off" };
}

export function brokerSessionsOf(c: Pick<Config, "brokerSessions">): BrokerSessions {
  return c.brokerSessions ?? "subscription";
}

// A config.json that cannot be used; the message names the file, and the key and what it takes.
export class ConfigError extends Error {}

// A config.json written by a newer ccrc.
export class ConfigTooNewError extends ConfigError {}

// Each step brings a config of the version before it to `to`, in place. A file without schemaVersion is version 0.
interface Migration {
  to: number;
  run: (c: Obj) => void;
}

export const MIGRATIONS: readonly Migration[] = [
  // Files from before brokerSessions existed keep broker sessions on Claude Code's own login, as they ran then.
  {
    to: 1,
    run: (c) => {
      if (c.brokerSessions === undefined) c.brokerSessions = "subscription";
    },
  },
];

export const SCHEMA_VERSION = MIGRATIONS.at(-1)!.to;

const isText = (v: unknown) => typeof v === "string";
const isTexts = (v: unknown) => Array.isArray(v) && v.every(isText);
const isPositive = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;

// The keys a config file may hold: their check and what the error says they take.
const KEYS: Record<string, { ok: (v: unknown) => boolean; expected: string; restart?: boolean }> = {
  schemaVersion: { ok: (v) => Number.isInteger(v) && (v as number) >= 0, expected: "a whole number" },
  host: { ok: (v) => isText(v) && v !== "", expected: "a non-empty string", restart: true },
  port: { ok: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 65535, expected: "a whole number from 0 (any free port) to 65535", restart: true },
  allowedDevices: { ok: isTexts, expected: "a list of strings" },
  allowLocal: { ok: (v) => typeof v === "boolean", expected: "true or false" },
  claudePath: { ok: isText, expected: `a string: a path, or "${FOLLOW_VSCODE}"`, restart: true },
  roots: { ok: isTexts, expected: "a list of strings" },
  leaseIdleMinutes: { ok: isPositive, expected: "a number above 0" },
  sessionIdleMinutes: { ok: isPositive, expected: "a number above 0" },
  brokerSessions: { ok: (v) => BROKER_SESSIONS.includes(v as BrokerSessions), expected: BROKER_SESSIONS.map((m) => `"${m}"`).join(", ") },
  updateCheck: { ok: (v) => typeof v === "boolean", expected: "true or false" },
  updateChannel: { ok: (v) => UPDATE_CHANNELS.includes(v as UpdateChannel), expected: UPDATE_CHANNELS.map((m) => `"${m}"`).join(", ") },
  updateRepo: { ok: (v) => isText(v) && v !== "", expected: "a git URL or path" },
  updateNotify: { ok: (v) => typeof v === "boolean", expected: "true or false" },
  vscodeArchive: { ok: (v) => typeof v === "boolean", expected: "true or false" },
};

export const CONFIG_KEYS = Object.keys(KEYS);

// Keys a running broker only takes in when it starts again.
export const RESTART_KEYS = Object.keys(KEYS).filter((k) => KEYS[k].restart);

function shown(v: unknown): string {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

// Where in the text JSON.parse gave up, found by walking the text the way JSON reads.
export function jsonErrorAt(text: string): number {
  let i = 0;
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i])) i++;
  };
  const fail = (): never => {
    throw i;
  };
  const literal = (word: string) => {
    if (text.startsWith(word, i)) i += word.length;
    else fail();
  };
  const str = () => {
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text.charCodeAt(i) < 0x20) fail();
      if (text[i] === "\\") {
        i++;
        if (text[i] === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) fail();
          i += 4;
        } else if (!'"\\/bfnrt'.includes(text[i] ?? "x")) fail();
      }
      i++;
    }
    if (i >= text.length) fail();
    i++;
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === "{" || c === "[") {
      const close = c === "{" ? "}" : "]";
      i++;
      ws();
      if (text[i] === close) return void i++;
      for (;;) {
        if (c === "{") {
          ws();
          if (text[i] !== '"') fail();
          str();
          ws();
          if (text[i] !== ":") fail();
          i++;
        }
        value();
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === close) return void i++;
        else fail();
      }
    }
    if (c === '"') return str();
    if (c === "t") return literal("true");
    if (c === "f") return literal("false");
    if (c === "n") return literal("null");
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m) fail();
    i += m![0].length;
  };
  try {
    value();
    ws();
    if (i < text.length) fail();
  } catch (at) {
    if (typeof at === "number") return Math.min(at, text.length);
    throw at;
  }
  return text.length;
}

function lineColumn(text: string, at: number): { line: number; column: number } {
  const before = text.slice(0, at).split("\n");
  return { line: before.length, column: before.at(-1)!.length + 1 };
}

export function parseConfigText(text: string, file = paths.configFile): Obj {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    const { line, column } = lineColumn(text, jsonErrorAt(text));
    throw new ConfigError(`${file}: not valid JSON at line ${line}, column ${column}`);
  }
  if (!isObject(v)) throw new ConfigError(`${file}: must hold a JSON object`);
  return v;
}

// The config brought to SCHEMA_VERSION in memory, with the version it had.
export function applyMigrations(raw: Obj, file = paths.configFile): { config: Obj; from: number } {
  const from = raw.schemaVersion === undefined ? 0 : raw.schemaVersion;
  if (!KEYS.schemaVersion.ok(from)) throw new ConfigError(`${file}: "schemaVersion" must be ${KEYS.schemaVersion.expected}, not ${shown(from)}`);
  const v = from as number;
  if (v > SCHEMA_VERSION) {
    throw new ConfigTooNewError(
      `${file} is of format ${v}, newer than this ccrc knows (${SCHEMA_VERSION}). A newer ccrc wrote it: run \`ccrc update\` to that version, or \`ccrc rollback\`.`,
    );
  }
  const config = structuredClone(raw);
  for (const m of MIGRATIONS) if (m.to > v) m.run(config);
  config.schemaVersion = SCHEMA_VERSION;
  return { config, from: v };
}

// Checks every known key's type and returns warnings for the keys ccrc does not know.
export function checkConfig(raw: Obj, file = paths.configFile): string[] {
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const k = KEYS[key];
    if (!k) warnings.push(`${file}: unknown key "${key}" is ignored`);
    else if (!k.ok(value)) throw new ConfigError(`${file}: "${key}" must be ${k.expected}, not ${shown(value)}`);
  }
  return warnings;
}

export interface ReadConfig {
  config: Config;
  // As the file holds it.
  raw: Obj;
  // The format the file is of, before any migration.
  from: number;
  warnings: string[];
}

// The config a file holds, migrated in memory and checked, over the defaults. Throws ConfigError.
export function readConfig(file = paths.configFile): ReadConfig {
  const raw = parseConfigText(fs.readFileSync(file, "utf8"), file);
  const { config, from } = applyMigrations(raw, file);
  const warnings = checkConfig(config, file);
  const known = Object.fromEntries(Object.entries(config).filter(([k]) => k in KEYS));
  return { config: { ...defaults(), brokerSessions: "off", ...known } as Config, raw, from, warnings };
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// Replaces the file with a single rename: readers see either the old or the new content.
export function writeFileAtomic(file: string, data: string): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function writeConfig(raw: Obj, file = paths.configFile): void {
  writeFileAtomic(file, JSON.stringify(raw, null, 2) + "\n");
}

// Sets one key of the config file, the others left as the file has them, checked as the broker reads it.
export function setConfigKey(key: string, value: unknown, file = paths.configFile): void {
  const raw = fs.existsSync(file) ? readConfig(file).raw : (newConfig() as unknown as Obj);
  const next = { ...raw, [key]: value };
  checkConfig(applyMigrations(next, file).config, file);
  writeConfig(next, file);
}

// The config, made with the defaults of a new install when there is no file. Warnings go to stderr.
export function loadConfig(file = paths.configFile): Config {
  if (!fs.existsSync(file)) {
    const fresh = newConfig();
    writeConfig(fresh as unknown as Obj, file);
    return fresh;
  }
  const r = readConfig(file);
  for (const w of r.warnings) console.warn(`ccrc: ${w}`);
  return r.config;
}
