import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

// How setup runs other programs and asks the person at the terminal. Tests hand in fakes of both.

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Runner {
  // Runs to the end with its output captured. A program that cannot start gives code 127.
  run(cmd: string, args: string[], o?: { timeoutMs?: number }): Promise<RunResult>;
  // Runs on this terminal, so the person sees it and answers it (sudo, `tailscale up --qr`, `ccrc passwd`).
  attached(cmd: string, args: string[]): Promise<number>;
  // The program's path on PATH.
  which(cmd: string): string | undefined;
}

export function whichOn(cmd: string, pathVar = process.env.PATH ?? ""): string | undefined {
  if (cmd.includes("/")) return fs.existsSync(cmd) ? cmd : undefined;
  for (const dir of pathVar.split(":")) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return undefined;
}

export const realRunner: Runner = {
  run(cmd, args, o = {}) {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], timeout: o.timeoutMs ?? 30_000 });
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
      child.on("error", (e) => resolve({ code: 127, stdout, stderr: stderr + e.message }));
      child.on("close", (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr }));
    });
  },
  attached(cmd, args) {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, { stdio: "inherit" });
      child.on("error", () => resolve(127));
      child.on("close", (code) => resolve(code ?? 1));
    });
  },
  which: (cmd) => whichOn(cmd),
};

export interface Choice<T extends string = string> {
  value: T;
  label: string;
  detail?: string;
}

export interface Prompt {
  // Whether a person can answer: questions on a prompt that is not throw NoTerminalError.
  readonly interactive: boolean;
  confirm(question: string, def: boolean): Promise<boolean>;
  choose<T extends string>(question: string, choices: Choice<T>[], def: T): Promise<T>;
  // Any number of the choices.
  pick(question: string, choices: Choice[], def: string[]): Promise<string[]>;
  text(question: string, def: string): Promise<string>;
  // Typed without echo.
  secret(question: string): Promise<string>;
  // Waits up to ms for a line: the line typed, or undefined when the time ran out.
  wait(ms: number): Promise<string | undefined>;
}

export class NoTerminalError extends Error {
  constructor() {
    super("setup has a question but no terminal to ask it on: run it in a terminal, or pass --yes to take the defaults (and --allow-sudo for the steps that need sudo)");
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function numbered(choices: Choice[], out: (s: string) => void): void {
  choices.forEach((c, i) => {
    out(`  ${i + 1}) ${c.label}`);
    if (c.detail) for (const line of c.detail.split("\n")) out(`       ${line}`);
  });
}

function byNumberOrValue(answer: string, choices: Choice[]): Choice | undefined {
  const n = Number(answer);
  if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1];
  return choices.find((c) => c.value === answer);
}

// Asks on this process's standard input, which install.sh points at /dev/tty.
export class TerminalPrompt implements Prompt {
  readonly interactive = Boolean(process.stdin.isTTY);
  private out = (s: string) => process.stdout.write(s + "\n");

  private async line(question: string, signal?: AbortSignal): Promise<string> {
    if (!this.interactive) throw new NoTerminalError();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(question, signal ? { signal } : {})).trim();
    } finally {
      rl.close();
    }
  }

  async confirm(question: string, def: boolean): Promise<boolean> {
    for (;;) {
      const a = (await this.line(`${question} [${def ? "Y/n" : "y/N"}] `)).toLowerCase();
      if (!a) return def;
      if (a === "y" || a === "yes") return true;
      if (a === "n" || a === "no") return false;
    }
  }

  async choose<T extends string>(question: string, choices: Choice<T>[], def: T): Promise<T> {
    this.out(question);
    numbered(choices, this.out);
    const at = choices.findIndex((c) => c.value === def) + 1;
    for (;;) {
      const a = await this.line(`Choose 1-${choices.length} [${at}]: `);
      if (!a) return def;
      const c = byNumberOrValue(a, choices);
      if (c) return c.value as T;
    }
  }

  async pick(question: string, choices: Choice[], def: string[]): Promise<string[]> {
    this.out(question);
    numbered(choices, this.out);
    const defText = def.map((v) => choices.findIndex((c) => c.value === v) + 1).join(" ");
    for (;;) {
      const a = await this.line(`Numbers separated by spaces [${defText || "none"}]: `);
      if (!a) return def;
      const picked = a.split(/[\s,]+/).map((w) => byNumberOrValue(w, choices));
      if (picked.every(Boolean)) return [...new Set(picked.map((c) => c!.value))];
    }
  }

  async text(question: string, def: string): Promise<string> {
    return (await this.line(def ? `${question} [${def}]: ` : `${question}: `)) || def;
  }

  secret(question: string): Promise<string> {
    if (!this.interactive) return Promise.reject(new NoTerminalError());
    return new Promise((resolve, reject) => {
      const stdin = process.stdin;
      let value = "";
      const done = () => {
        stdin.off("data", onData);
        stdin.setRawMode(false);
        stdin.pause();
        process.stdout.write("\n");
      };
      const onData = (chunk: string) => {
        for (const c of chunk) {
          if (c === "\r" || c === "\n") {
            done();
            return resolve(value);
          }
          if (c === "\u0003") {
            done();
            return reject(Error("cancelled"));
          }
          if (c === "\u007f" || c === "\b") value = Array.from(value).slice(0, -1).join("");
          else if (c >= " ") value += c;
        }
      };
      process.stdout.write(question);
      stdin.setEncoding("utf8");
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
    });
  }

  async wait(ms: number): Promise<string | undefined> {
    if (!this.interactive) {
      await sleep(ms);
      return undefined;
    }
    try {
      return await this.line("", AbortSignal.timeout(ms));
    } catch (e) {
      if ((e as Error).name === "AbortError") return undefined;
      throw e;
    }
  }
}

// --yes: every question takes its default; a secret still needs the person, and waiting still waits.
export function withDefaults(p: Prompt): Prompt {
  return {
    interactive: p.interactive,
    confirm: async (_q, def) => def,
    choose: async (_q, _c, def) => def,
    pick: async (_q, _c, def) => def,
    text: async (_q, def) => def,
    secret: (q) => p.secret(q),
    wait: (ms) => p.wait(ms),
  };
}
