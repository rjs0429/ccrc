// Entry of bin/ccrc-wrapper for one Claude Code conversation process: `main.ts <claude> <args...>`.
// If the relay cannot be set up, Claude Code runs directly with this process's stdio.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
const LOG_MAX_BYTES = 1024 * 1024;
const FLUSH_WAIT_MS = 2000;

const [claudePath, ...args] = process.argv.slice(2);

function stateDir(): string {
  const home = process.env.HOME ?? "";
  return process.env.CCRC_STATE_DIR || path.join(process.env.XDG_STATE_HOME || path.join(home, ".local", "state"), "ccrc");
}

const logFile = process.env.CCRC_WRAPPER_LOG || path.join(stateDir(), "wrapper.log");

function log(msg: string): void {
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} [${process.pid}] ${msg}\n`, { mode: 0o600 });
  } catch {}
}

function rotateLog(): void {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
    if (fs.statSync(logFile).size > LOG_MAX_BYTES) fs.renameSync(logFile, `${logFile}.1`);
  } catch {}
}

// Ends the way Claude Code ended, once VS Code has been handed everything written to it.
function exitLike(code: number | null, signal: NodeJS.Signals | null): void {
  let done = false;
  const end = () => {
    if (done) return;
    done = true;
    if (signal) {
      for (const s of SIGNALS) process.removeAllListeners(s);
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  };
  setTimeout(end, FLUSH_WAIT_MS);
  process.stdout.write("", end);
}

function runDirect(reason: string): void {
  log(`running claude directly: ${reason}`);
  const child = spawn(claudePath, args, { stdio: "inherit" });
  for (const s of SIGNALS) process.on(s, () => child.kill(s));
  child.on("error", (e) => {
    process.stderr.write(`ccrc-wrapper: cannot start ${claudePath}: ${e.message}\n`);
    process.exit(127);
  });
  child.on("close", exitLike);
}

async function main(): Promise<void> {
  rotateLog();
  log(`start cwd=${process.cwd()} args=${args.join(" ")}`);
  let relay;
  try {
    const { Relay } = await import("./relay.ts");
    const { linkSocketPath } = await import("../link/protocol.ts");
    const { TurnStore } = await import("./turns.ts");
    const vscode = await import("./vscode.ts");
    const dataDir = vscode.userDataDir(process.env);
    const launchArgs = await vscode.permissionArgs(args, dataDir);
    if (launchArgs !== args) log("VS Code named no permission mode; Claude Code starts in its configured one");
    relay = new Relay({
      claudePath,
      args: launchArgs,
      cwd: process.cwd(),
      env: process.env,
      socketPath: linkSocketPath(),
      hostIn: process.stdin,
      hostOut: process.stdout,
      log,
      hostPid: process.ppid,
      turns: vscode.continuesAfterReload(dataDir) ? new TurnStore({ dir: path.join(stateDir(), "turns") }) : undefined,
    });
  } catch (e) {
    return runDirect(e instanceof Error ? e.message : String(e));
  }
  process.on("uncaughtException", (e) => log(`uncaught: ${e.stack ?? e.message}`));
  process.on("unhandledRejection", (e) => log(`unhandled: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`));
  for (const s of SIGNALS)
    process.on(s, () => {
      log(`received ${s}`);
      relay.signal(s);
    });
  relay.on("exit", exitLike);
  await relay.start();
}

if (!claudePath) {
  process.stderr.write("usage: ccrc-wrapper <claude> [args...]\n");
  process.exit(2);
}
main().catch((e) => log(`relay failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`));
