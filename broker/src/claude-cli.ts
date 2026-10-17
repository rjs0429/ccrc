import fs from "node:fs";
import path from "node:path";
import { FOLLOW_VSCODE } from "./config.ts";
import { paths } from "./paths.ts";

const EXTENSION = /^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)-(.+)$/;
const VERSION = /^\d+\.\d+\.\d+$/;
// A link handed out this recently may still be on its way to the process that starts with it.
const HANDED_KEEP_MS = 60_000;

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

// config: claudePath names it; vscode: bundled in VS Code's extension; global: ~/.local/bin/claude; sdk: the one the
// Agent SDK bundles.
export type CliSource = "config" | "vscode" | "global" | "sdk";

// The Claude Code a broker session runs. path: what the SDK starts, none for the SDK's own; from: the file a link was
// made from; version: as its folder names it, when it does.
export interface CliChoice {
  source: CliSource;
  path?: string;
  from?: string;
  version?: string;
}

export interface CliOptions {
  // The claudePath of the broker's config.
  setting?: string;
  extensionsDir: string;
  platform: string;
  global: string;
  // Where the broker keeps its links to VS Code's Claude Code.
  linkDir: string;
}

function defaults(): CliOptions {
  return {
    extensionsDir: paths.vscodeExtensionsDir,
    platform: `${process.platform}-${process.arch}`,
    global: path.join(paths.home, ".local", "bin", "claude"),
    linkDir: path.join(paths.stateDir, "cli"),
  };
}

function newer(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// Whether version a.b.c is older than min; an unknown version counts as older.
export function versionBelow(version: string | undefined, min: string): boolean {
  const v = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  return !v || newer(min.split(".").map(Number), v.slice(1, 4).map(Number));
}

// The Claude Code extension folders for this platform, newest first, leaving out versions VS Code marked for removal.
export function extensionFolders(dir: string, platform: string): { version: string; dir: string }[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  let obsolete: Obj = {};
  try {
    const v: unknown = JSON.parse(fs.readFileSync(path.join(dir, ".obsolete"), "utf8"));
    if (isObject(v)) obsolete = v;
  } catch {}
  const found: { v: number[]; name: string }[] = [];
  for (const name of names) {
    const m = EXTENSION.exec(name);
    if (m && m[4] === platform && !obsolete[name]) found.push({ v: m.slice(1, 4).map(Number), name });
  }
  return found.sort((a, b) => (newer(a.v, b.v) ? -1 : newer(b.v, a.v) ? 1 : 0)).map((f) => ({ version: f.v.join("."), dir: path.join(dir, f.name) }));
}

export function bundledClaude(extensionDir: string): string {
  return path.join(extensionDir, "resources", "native-binary", "claude");
}

function executable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// The version a native install names its file with (~/.local/bin/claude links to .../versions/2.1.296).
function versionOf(file: string): string | undefined {
  try {
    const name = path.basename(fs.realpathSync(file));
    return VERSION.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

function sdkVersion(): string | undefined {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(new URL("package.json", import.meta.resolve("@anthropic-ai/claude-agent-sdk")), "utf8"));
    return isObject(v) && typeof v.claudeCodeVersion === "string" ? v.claudeCodeVersion : undefined;
  } catch {
    return undefined;
  }
}

// Picks the Claude Code for each broker session as it starts: the configured path, else the newest VS Code extension's,
// else the global install, else the SDK's. VS Code's runs from a link in linkDir, as Claude Code starts its own file again
// (Grep, Glob, hooks) and VS Code removes old extension folders while broker sessions still run.
export class ClaudeCli {
  private o: CliOptions;
  private handed = new Map<string, number>();
  private linking = new Map<string, Promise<string | undefined>>();

  constructor(options: Partial<CliOptions> = {}) {
    this.o = { ...defaults(), ...options };
  }

  // The Claude Code a session starting now would run, without making a link.
  peek(): CliChoice {
    const setting = this.o.setting?.trim();
    if (setting && setting !== FOLLOW_VSCODE) return { source: "config", path: setting, version: versionOf(setting) };
    for (const ext of extensionFolders(this.o.extensionsDir, this.o.platform)) {
      const file = bundledClaude(ext.dir);
      if (executable(file)) return { source: "vscode", path: file, version: ext.version };
    }
    if (executable(this.o.global)) return { source: "global", path: this.o.global, version: versionOf(this.o.global) };
    return { source: "sdk", version: sdkVersion() };
  }

  // The Claude Code for a session starting now; links no running session (inUse) uses any more are removed.
  async choose(inUse: Iterable<string | undefined> = []): Promise<CliChoice> {
    const c = this.peek();
    if (c.source !== "vscode" || !c.path || !c.version) return c;
    let link = this.linking.get(c.version);
    if (!link) {
      link = this.link(c.path, c.version).finally(() => this.linking.delete(c.version!));
      this.linking.set(c.version, link);
    }
    const file = await link;
    this.prune(c.version, inUse);
    if (!file) return c;
    this.handed.set(file, Date.now());
    return { ...c, path: file, from: c.path };
  }

  // A hard link costs nothing while VS Code keeps its file; across file systems it is a copy.
  private async link(from: string, version: string): Promise<string | undefined> {
    const dir = path.join(this.o.linkDir, version);
    const file = path.join(dir, "claude");
    try {
      if (fs.statSync(file).size === fs.statSync(from).size && executable(file)) return file;
    } catch {}
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.rmSync(tmp, { force: true });
      try {
        fs.linkSync(from, tmp);
      } catch {
        await fs.promises.copyFile(from, tmp, fs.constants.COPYFILE_FICLONE);
        fs.chmodSync(tmp, 0o755);
      }
      fs.renameSync(tmp, file);
      return file;
    } catch {
      fs.rmSync(tmp, { force: true });
      return undefined;
    }
  }

  private prune(keep: string, inUse: Iterable<string | undefined>): void {
    const used = new Set(inUse);
    const now = Date.now();
    for (const [file, at] of this.handed) if (now - at > HANDED_KEEP_MS) this.handed.delete(file);
    let names: string[];
    try {
      names = fs.readdirSync(this.o.linkDir);
    } catch {
      return;
    }
    for (const name of names) {
      const file = path.join(this.o.linkDir, name, "claude");
      if (name === keep || !VERSION.test(name) || used.has(file) || this.handed.has(file)) continue;
      fs.rmSync(path.join(this.o.linkDir, name), { recursive: true, force: true });
    }
  }
}
