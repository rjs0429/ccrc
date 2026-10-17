import { spawn } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  // Lets the command use the terminal (npm's progress, a git credential prompt) instead of collecting its output.
  inherit?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// After a timeout: how long SIGTERM gets before SIGKILL, and how long the output pipes get to close once the command
// is gone (a helper it started, such as git-remote-https, can hold them open long after).
const KILL_AFTER_MS = 5000;
const DRAIN_MS = 1000;

// Runs a command without a shell. A command that cannot start answers code 127 with the reason in stderr, and one
// past its time limit is killed and answers 124, so callers only read the code.
export type Runner = (cmd: string, args: string[], o?: RunOptions) => Promise<RunResult>;

export const run: Runner = (cmd, args, o = {}) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env ?? process.env, stdio: o.inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;
    const timers: NodeJS.Timeout[] = [];
    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    const finish = (r: RunResult) => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(r);
    };
    const result = (code: number | null): RunResult => ({
      code: timedOut ? 124 : (code ?? 1),
      stdout,
      stderr: timedOut ? `${stderr}timed out after ${o.timeoutMs} ms` : stderr,
    });
    if (o.timeoutMs) {
      timers.push(
        setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          timers.push(setTimeout(() => child.kill("SIGKILL"), KILL_AFTER_MS));
        }, o.timeoutMs),
      );
    }
    child.on("error", (e) => finish({ code: 127, stdout, stderr: stderr + e.message }));
    child.on("exit", (code) => timers.push(setTimeout(() => finish(result(code)), DRAIN_MS)));
    child.on("close", (code) => finish(result(code)));
  });
