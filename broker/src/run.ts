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

// Runs a command without a shell. A command that cannot start answers code 127 with the reason in stderr, and one
// past its time limit is killed and answers 124, so callers only read the code.
export type Runner = (cmd: string, args: string[], o?: RunOptions) => Promise<RunResult>;

export const run: Runner = (cmd, args, o = {}) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env ?? process.env, stdio: o.inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    const timer = o.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, o.timeoutMs)
      : undefined;
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : (code ?? 1), stdout, stderr: timedOut ? `${stderr}timed out after ${o.timeoutMs} ms` : stderr });
    });
  });
