import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  CLAUDE_SETTING_FIELDS,
  MAX_DIRS,
  MAX_RULES,
  isAbsoluteDir,
  isPermissionRule,
  type ClaudeSettingsView,
  type SettingField,
  type SettingNoteReason,
} from "./admin-protocol.ts";
import { paths } from "./paths.ts";

const KEEP_BACKUPS = 10;
const HIDDEN = "••••";
const FIELDS = new Map(CLAUDE_SETTING_FIELDS.map((f) => [f.key, f]));
const BACKUP_STAMP = /\.ccrc-\d{8}T\d{9}Z\.bak$/;

// Keys whose values are commands Claude Code runs, and keys that decide what it may do or load unasked.
const COMMAND_KEYS = new Set([
  "hooks",
  "statusLine",
  "subagentStatusLine",
  "apiKeyHelper",
  "proxyAuthHelper",
  "awsCredentialExport",
  "awsAuthRefresh",
  "gcpAuthRefresh",
  "otelHeadersHelper",
  "fileSuggestion",
  "processWrapper",
  "policyHelper",
]);
const SECURITY_KEYS = new Set([
  "env",
  "sandbox",
  "skipDangerousModePermissionPrompt",
  "disableAllHooks",
  "enableAllProjectMcpServers",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
  "allowedMcpServers",
  "deniedMcpServers",
  "enabledPlugins",
  "extraKnownMarketplaces",
  "additionalMarketplaces",
  "pluginConfigs",
  "disableAutoMode",
  "remoteControlAtStartup",
]);

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

export class SettingsError extends Error {
  readonly status: number;
  readonly key?: string;

  constructor(status: number, code: string, key?: string) {
    super(code);
    this.status = status;
    this.key = key;
  }
}

interface Loaded {
  raw: string;
  exists: boolean;
  mode: number;
  hash: string;
  data?: Obj;
  problem?: "not_json" | "not_object";
}

export function claudeSettingsFile(): string {
  return path.join(paths.claudeConfigDir, "settings.json");
}

function getKey(data: Obj, key: string): unknown {
  const [outer, inner] = key.split(".");
  if (inner === undefined) return data[outer];
  const obj = data[outer];
  return isObject(obj) ? obj[inner] : undefined;
}

// Sets or, for undefined, removes a key; an object this empties goes too.
function setKey(data: Obj, key: string, value: unknown): void {
  const [outer, inner] = key.split(".");
  if (inner === undefined) {
    if (value === undefined) delete data[outer];
    else data[outer] = value;
    return;
  }
  const obj = data[outer];
  if (obj !== undefined && !isObject(obj)) throw new SettingsError(422, "not_object", outer);
  if (value === undefined) {
    if (!obj) return;
    delete obj[inner];
    if (!Object.keys(obj).length) delete data[outer];
  } else if (obj) obj[inner] = value;
  else data[outer] = { [inner]: value };
}

function fits(f: SettingField, v: unknown): boolean {
  switch (f.kind) {
    case "bool":
      return typeof v === "boolean";
    case "choice":
      return typeof v === "string" && f.values.includes(v);
    case "text":
      return typeof v === "string" && f.pattern.test(v);
    case "rules":
      return Array.isArray(v) && v.length <= MAX_RULES && v.every((r) => typeof r === "string" && isPermissionRule(r));
    case "dirs":
      return Array.isArray(v) && v.length <= MAX_DIRS && v.every((d) => typeof d === "string" && isAbsoluteDir(d));
  }
}

// The value to write for a change, undefined to remove the key. Items a list already has may stay
// as they are; only new ones must have the right form.
function checkValue(f: SettingField, v: unknown, current: unknown): unknown {
  if (v === null) return undefined;
  if (f.kind === "rules" || f.kind === "dirs") {
    const max = f.kind === "rules" ? MAX_RULES : MAX_DIRS;
    const valid = f.kind === "rules" ? isPermissionRule : isAbsoluteDir;
    const kept = new Set(Array.isArray(current) ? current : []);
    if (!Array.isArray(v) || v.length > max) throw new SettingsError(400, "invalid", f.key);
    for (const item of v) {
      if (typeof item !== "string" || !(kept.has(item) || valid(item))) throw new SettingsError(400, "invalid", f.key);
    }
    return [...new Set(v as string[])];
  }
  if (!fits(f, v)) throw new SettingsError(400, "invalid", f.key);
  return v;
}

function indentOf(raw: string): string | number | undefined {
  if (!raw.trim()) return 2;
  const m = /\n([ \t]+)\S/.exec(raw);
  return m ? m[1] : raw.trim().includes("\n") ? 2 : undefined;
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:.]/g, "");
}

// Claude Code's user settings file, edited key by key from the web client. Only the keys in
// CLAUDE_SETTING_FIELDS change; the rest of the file, its layout and its mode stay. A file that is not
// strict JSON is never rewritten, so comments in it survive.
export class ClaudeSettings {
  readonly file: string;

  constructor(file = claudeSettingsFile()) {
    this.file = file;
  }

  read(): ClaudeSettingsView {
    return this.view(this.load());
  }

  // Applies the changes ({key: value, or null to remove}) when the file still has the hash they were
  // made against, and returns the keys that changed.
  update(changes: unknown, baseHash: unknown, now = Date.now()): { view: ClaudeSettingsView; changed: string[] } {
    if (!isObject(changes) || typeof baseHash !== "string") throw new SettingsError(400, "invalid");
    const keys = Object.keys(changes);
    if (!keys.length) throw new SettingsError(400, "invalid");
    for (const key of keys) if (!FIELDS.has(key)) throw new SettingsError(403, "not_allowed", key);
    const cur = this.load();
    if (cur.hash !== baseHash) throw new SettingsError(409, "changed");
    if (!cur.data) throw new SettingsError(422, cur.problem ?? "not_json");
    const next = structuredClone(cur.data);
    const changed: string[] = [];
    for (const key of keys) {
      const before = getKey(cur.data, key);
      const value = checkValue(FIELDS.get(key)!, changes[key], before);
      if (JSON.stringify(value) === JSON.stringify(before)) continue;
      setKey(next, key, value);
      changed.push(key);
    }
    if (!changed.length) return { view: this.view(cur), changed };
    this.write(cur, next, now);
    return { view: this.read(), changed };
  }

  private load(): Loaded {
    let raw = "";
    let exists = true;
    let mode = 0o600;
    try {
      const fd = fs.openSync(this.file, "r");
      try {
        mode = fs.fstatSync(fd).mode & 0o777;
        raw = fs.readFileSync(fd, "utf8");
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      exists = false;
    }
    const hash = createHash("sha256").update(raw).digest("hex");
    if (!raw.trim()) return { raw, exists, mode, hash, data: {} };
    try {
      const v: unknown = JSON.parse(raw);
      return isObject(v) ? { raw, exists, mode, hash, data: v } : { raw, exists, mode, hash, problem: "not_object" };
    } catch {
      return { raw, exists, mode, hash, problem: "not_json" };
    }
  }

  private view(l: Loaded): ClaudeSettingsView {
    const base = { path: this.file, exists: l.exists, hash: l.hash };
    if (!l.data) return { ...base, problem: l.problem, values: {}, rest: {}, notes: [] };
    const values: Obj = {};
    const notes: { key: string; reason: SettingNoteReason }[] = [];
    const rest = structuredClone(l.data);
    for (const f of CLAUDE_SETTING_FIELDS) {
      const v = getKey(l.data, f.key);
      if (v === undefined) continue;
      values[f.key] = v;
      if (f.kind !== "rules" && f.kind !== "dirs" && !fits(f, v)) notes.push({ key: f.key, reason: "value" });
      setKey(rest, f.key, undefined);
    }
    for (const key of Object.keys(rest)) {
      if (COMMAND_KEYS.has(key)) notes.push({ key, reason: "command" });
      else if (SECURITY_KEYS.has(key)) notes.push({ key, reason: "security" });
    }
    if (isObject(rest.permissions)) for (const key of Object.keys(rest.permissions)) notes.push({ key: `permissions.${key}`, reason: "security" });
    if (isObject(rest.env)) rest.env = Object.fromEntries(Object.keys(rest.env).map((k) => [k, HIDDEN]));
    for (const key of [...COMMAND_KEYS, "pluginConfigs"]) if (key in rest) rest[key] = HIDDEN;
    return { ...base, values, rest, notes };
  }

  // Backs the old file up beside it, then replaces the file the path leads to (through a symlink too)
  // with a single rename.
  private write(cur: Loaded, data: Obj, now: number): void {
    const text = JSON.stringify(data, null, indentOf(cur.raw)) + (cur.raw && !cur.raw.endsWith("\n") ? "" : "\n");
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    if (cur.exists) this.backup(cur.raw, now);
    const target = cur.exists ? fs.realpathSync(this.file) : this.file;
    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      const fd = fs.openSync(tmp, "wx", cur.mode);
      try {
        fs.writeSync(fd, text);
        fs.fchmodSync(fd, cur.mode);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, target);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
  }

  // settings.json.ccrc-<UTC time>.bak; names sort by time, and only the newest KEEP_BACKUPS stay.
  private backup(raw: string, now: number): void {
    const dir = path.dirname(this.file);
    const prefix = `${path.basename(this.file)}.ccrc-`;
    let t = now;
    while (fs.existsSync(path.join(dir, `${prefix}${stamp(t)}.bak`))) t++;
    fs.writeFileSync(path.join(dir, `${prefix}${stamp(t)}.bak`), raw, { mode: 0o600, flag: "wx" });
    const backups = fs
      .readdirSync(dir)
      .filter((n) => n.startsWith(prefix) && BACKUP_STAMP.test(n))
      .sort();
    for (const name of backups.slice(0, -KEEP_BACKUPS)) fs.rmSync(path.join(dir, name), { force: true });
  }
}
