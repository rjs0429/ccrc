import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DoctorCheck, DoctorResult, HealthInfo } from "./admin-protocol.ts";
import { ensureDir, paths, writeFileAtomic } from "./config.ts";
import { LineSplitter, parseLine } from "./link/lines.ts";
import { readSettings } from "./wrapper/vscode.ts";

const EXTENSION = /^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)-(.+)$/;
// The options VS Code starts a conversation process with, less the ones about the conversation itself.
const LAUNCH_ARGS = [
  "--output-format",
  "stream-json",
  "--verbose",
  "--input-format",
  "stream-json",
  "--permission-prompt-tool=stdio",
  "--setting-sources=user,project,local",
];
// Variables that would make the wrapper step aside or tie Claude Code to a running VS Code or Claude Code.
const DROPPED_ENV = ["CCRC_WRAPPER", "CLAUDE_CODE_CONFIG_PROBE", "VSCODE_CODE_CACHE_PATH", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"];
const KILL_WAIT_MS = 2000;

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

export interface DoctorOptions {
  stateDir: string;
  // VS Code's extensions folder and user data folder.
  extensionsDir: string;
  vscodeDir: string;
  // VS Code's name for this platform in extension folder names.
  platform: string;
  repoDir: string;
  wrapper: string;
  // Added to the environment of the processes a check starts.
  env: NodeJS.ProcessEnv;
  stepTimeoutMs: number;
  intervalMs: number;
  startDelayMs: number;
}

function defaults(): DoctorOptions {
  const home = os.homedir();
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  return {
    stateDir: paths.stateDir,
    extensionsDir: path.join(home, ".vscode", "extensions"),
    vscodeDir: path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Code"),
    platform: `${process.platform}-${process.arch}`,
    repoDir: repo,
    wrapper: path.join(repo, "bin", "ccrc-wrapper"),
    env: {},
    stepTimeoutMs: 30_000,
    intervalMs: 6 * 3600_000,
    startDelayMs: 10_000,
  };
}

function newer(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

function isResult(v: unknown): v is DoctorResult {
  return isObject(v) && typeof v.ok === "boolean" && typeof v.at === "string" && Array.isArray(v.checks);
}

// The first of the promises to settle, or the fallback after ms.
function first<T>(promises: Promise<T>[], ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), ms)));
  return Promise.race([...promises, late]).finally(() => clearTimeout(timer));
}

// Checks that the wrapper still works with the Claude Code bundled in VS Code's extension, without a
// model call. It runs at start and every intervalMs when the extension or this broker changed since the
// last check, or that check failed; the result is kept in <stateDir>/doctor.json.
export class Doctor {
  private o: DoctorOptions;
  private firstTimer?: NodeJS.Timeout;
  private everyTimer?: NodeJS.Timeout;
  private running?: Promise<DoctorResult>;
  private child?: ChildProcess;
  private result?: DoctorResult | null;
  private broker?: string | null;
  private cli = new Map<string, Promise<string | undefined>>();

  constructor(options: Partial<DoctorOptions> = {}) {
    this.o = { ...defaults(), ...options };
  }

  start(): void {
    this.brokerVersion();
    const tick = () => void this.checkIfDue().catch(() => {});
    this.firstTimer = setTimeout(tick, this.o.startDelayMs);
    this.everyTimer = setInterval(tick, this.o.intervalMs);
    this.firstTimer.unref();
    this.everyTimer.unref();
  }

  close(): void {
    clearTimeout(this.firstTimer);
    clearInterval(this.everyTimer);
    this.child?.kill("SIGTERM");
  }

  async checkIfDue(): Promise<DoctorResult | undefined> {
    const last = this.last();
    if (last?.ok && last.extensionVersion === this.extension()?.version && last.brokerVersion === this.brokerVersion()) return undefined;
    return this.run();
  }

  run(): Promise<DoctorResult> {
    this.running ??= this.check().finally(() => (this.running = undefined));
    return this.running;
  }

  async info(): Promise<HealthInfo> {
    const ext = this.extension();
    return {
      brokerVersion: this.brokerVersion(),
      extensionVersion: ext?.version,
      cliVersion: ext ? await this.cliVersion(this.claudeOf(ext.dir)) : undefined,
      wrapper: this.wrapperSetting(),
      last: this.last(),
      running: Boolean(this.running),
    };
  }

  last(): DoctorResult | undefined {
    if (this.result === undefined) {
      try {
        const v: unknown = JSON.parse(fs.readFileSync(this.resultFile(), "utf8"));
        this.result = isResult(v) ? v : null;
      } catch {
        this.result = null;
      }
    }
    return this.result ?? undefined;
  }

  // The newest Claude Code extension for this platform, leaving out versions VS Code marked for removal.
  extension(): { version: string; dir: string } | undefined {
    let names: string[];
    try {
      names = fs.readdirSync(this.o.extensionsDir);
    } catch {
      return undefined;
    }
    let obsolete: Obj = {};
    try {
      const v: unknown = JSON.parse(fs.readFileSync(path.join(this.o.extensionsDir, ".obsolete"), "utf8"));
      if (isObject(v)) obsolete = v;
    } catch {}
    let best: { v: number[]; name: string } | undefined;
    for (const name of names) {
      const m = EXTENSION.exec(name);
      if (!m || m[4] !== this.o.platform || obsolete[name]) continue;
      const v = m.slice(1, 4).map(Number);
      if (!best || newer(v, best.v)) best = { v, name };
    }
    return best && { version: best.v.join("."), dir: path.join(this.o.extensionsDir, best.name) };
  }

  // The git commit the broker started from, read once.
  brokerVersion(): string | undefined {
    if (this.broker === undefined) {
      try {
        const out = execFileSync("git", ["-C", this.o.repoDir, "rev-parse", "--short", "HEAD"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
        this.broker = out.trim() || null;
      } catch {
        this.broker = null;
      }
    }
    return this.broker ?? undefined;
  }

  wrapperSetting(): HealthInfo["wrapper"] {
    let settings: Obj;
    try {
      settings = readSettings(this.o.vscodeDir);
    } catch {
      return { on: false, thisBroker: false, unreadable: true };
    }
    const setting = settings["claudeCode.claudeProcessWrapper"];
    const wrapper = typeof setting === "string" && setting ? setting : undefined;
    const vars = settings["claudeCode.environmentVariables"];
    const off = Array.isArray(vars) && vars.some((v) => isObject(v) && v.name === "CCRC_WRAPPER" && v.value === "off");
    return { path: wrapper, on: Boolean(wrapper) && !off, thisBroker: Boolean(wrapper) && samePath(wrapper!, this.o.wrapper) };
  }

  private resultFile(): string {
    return path.join(this.o.stateDir, "doctor.json");
  }

  private claudeOf(extDir: string): string {
    return path.join(extDir, "resources", "native-binary", "claude");
  }

  private env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const env = { ...process.env, ...this.o.env, ...extra };
    for (const k of DROPPED_ENV) delete env[k];
    return env;
  }

  private cliVersion(claude: string): Promise<string | undefined> {
    let key: string;
    try {
      key = `${claude}:${fs.statSync(claude).mtimeMs}`;
    } catch {
      return Promise.resolve(undefined);
    }
    let version = this.cli.get(key);
    if (!version) {
      version = new Promise((resolve) => {
        execFile(claude, ["--version"], { env: this.env(), timeout: this.o.stepTimeoutMs }, (err, stdout) => {
          resolve(err ? undefined : /^\s*(\d+\.\d+\.\d+\S*)/.exec(String(stdout))?.[1]);
        });
      });
      this.cli.set(key, version);
      void version.then((v) => {
        if (!v) this.cli.delete(key);
      });
    }
    return version;
  }

  private async check(): Promise<DoctorResult> {
    const ext = this.extension();
    const checks: DoctorCheck[] = [{ name: "extension", ok: Boolean(ext), detail: ext?.version ?? "not found" }];
    let cliVersion: string | undefined;
    if (ext) {
      const claude = this.claudeOf(ext.dir);
      cliVersion = fs.existsSync(claude) ? await this.cliVersion(claude) : undefined;
      checks.push({ name: "cli", ok: Boolean(cliVersion), detail: cliVersion ?? (fs.existsSync(claude) ? "no version" : "not found") });
      if (cliVersion) {
        const smoke = await this.smoke(claude).catch((e: Error) => [{ name: "initialize", ok: false, detail: e.message }]);
        checks.push(...smoke);
      }
    }
    const result: DoctorResult = {
      ok: checks.every((c) => c.ok),
      at: new Date().toISOString(),
      extensionVersion: ext?.version,
      cliVersion,
      brokerVersion: this.brokerVersion(),
      checks,
    };
    this.result = result;
    try {
      writeFileAtomic(this.resultFile(), JSON.stringify(result, null, 2) + "\n");
    } catch {}
    return result;
  }

  // Asks Claude Code, started through the wrapper, what VS Code asks first, then ends its input and expects
  // a clean exit. It runs in <stateDir>/doctor, the same folder each time as Claude Code keeps a project
  // folder for every folder it starts in; the wrapper's socket path leads nowhere, so no broker sees it.
  private async smoke(claude: string): Promise<DoctorCheck[]> {
    const dir = path.join(this.o.stateDir, "doctor");
    const cwd = path.join(dir, "cwd");
    fs.rmSync(dir, { recursive: true, force: true });
    ensureDir(cwd);
    const child = spawn(this.o.wrapper, [claude, ...LAUNCH_ARGS], {
      cwd,
      env: this.env({ CCRC_LINK_SOCKET: path.join(dir, "none", "link.sock"), CCRC_WRAPPER_LOG: path.join(dir, "wrapper.log"), CCRC_STATE_DIR: dir }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    const replies = new Map<string, (r: Obj) => void>();
    const split = new LineSplitter((line) => {
      const m = parseLine(line);
      const r = m?.type === "control_response" && isObject(m.response) ? m.response : undefined;
      if (r && typeof r.request_id === "string") replies.get(r.request_id)?.(r);
    });
    let stderr = "";
    child.stdout!.on("data", (c: Buffer) => split.push(c));
    child.stderr!.on("data", (c: Buffer) => (stderr = (stderr + c.toString("utf8")).slice(-2000)));
    child.stdin!.on("error", () => {});
    const exit = new Promise<string>((resolve) => {
      child.on("error", (e) => resolve(`cannot start: ${e.message}`));
      child.on("close", (code, signal) => resolve(signal ? `signal ${signal}` : `exit code ${code}`));
    });
    const gone = exit.then(() => undefined);
    const ask = (id: string, request: Obj): Promise<Obj | undefined> => {
      child.stdin!.write(JSON.stringify({ type: "control_request", request_id: id, request }) + "\n");
      return first([new Promise<Obj>((resolve) => replies.set(id, resolve)), gone], this.o.stepTimeoutMs, undefined);
    };
    const failure = (r: Obj | undefined) => (!r ? "no answer" : typeof r.error === "string" ? r.error.slice(0, 300) : String(r.subtype));

    const checks: DoctorCheck[] = [];
    const init = await ask("doctor-1", { subtype: "initialize" });
    const answer = isObject(init?.response) ? init.response : {};
    const models = Array.isArray(answer.models) ? answer.models.length : 0;
    const commands = Array.isArray(answer.commands) ? answer.commands.length : 0;
    const initOk = init?.subtype === "success" && models > 0 && commands > 0;
    checks.push({ name: "initialize", ok: initOk, detail: init?.subtype === "success" ? `${models} models, ${commands} commands` : failure(init) });
    if (initOk) {
      const context = await ask("doctor-2", { subtype: "get_context_usage", detail: "summary" });
      checks.push({ name: "context", ok: context?.subtype === "success", ...(context?.subtype === "success" ? {} : { detail: failure(context) }) });
    }
    child.stdin!.end();
    const ended = await first([exit], this.o.stepTimeoutMs, "timed out");
    if (ended === "timed out") {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), KILL_WAIT_MS).unref();
    }
    const clean = ended === "exit code 0";
    const said = stderr.trim().split("\n").pop()?.slice(0, 300);
    checks.push({ name: "exit", ok: clean, ...(clean ? {} : { detail: said ? `${ended}: ${said}` : ended }) });
    this.child = undefined;
    return checks;
  }
}
