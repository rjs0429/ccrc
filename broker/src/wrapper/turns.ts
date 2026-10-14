import fs from "node:fs";
import path from "node:path";
import { startTime } from "../sessions/live.ts";

// The VS Code extension continues a turn cut off by a window reload, but not when Claude Code runs through a
// wrapper; the wrapper then does it with the same Claude Code switch. A turn counts as cut off when VS Code went
// away mid-turn and another VS Code process opens the session within the hour, at most twice in a row.
const MAX_AGE_MS = 60 * 60_000;
const MAX_RERUNS = 2;
const HOST_EXIT_WAIT_MS = 5000;
const KEEP_MS = 24 * 60 * 60_000;
const SESSION_ID = /^[0-9a-zA-Z-]{1,64}$/;

export const CONTINUE_ENV: Record<string, string> = {
  CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "1",
  CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS: String(MAX_AGE_MS),
};

interface Host {
  pid: number;
  start?: string;
}

interface Entry {
  cutAt?: number;
  host?: Host;
  reruns?: number;
}

export interface TurnStoreOptions {
  dir: string;
  now?: () => number;
  processStart?: (pid: number) => string | undefined;
  hostExitWaitMs?: number;
}

export class TurnStore {
  private o: Required<TurnStoreOptions>;

  constructor(o: TurnStoreOptions) {
    this.o = { now: Date.now, processStart: startTime, hostExitWaitMs: HOST_EXIT_WAIT_MS, ...o };
  }

  // VS Code (process hostPid) went away while a turn of the session ran.
  cut(sessionId: string, hostPid: number): void {
    const prev = this.read(sessionId);
    this.write(sessionId, { cutAt: this.o.now(), host: { pid: hostPid, start: this.o.processStart(hostPid) }, reruns: prev?.reruns ?? 0 });
    this.prune();
  }

  // A turn ended with VS Code still there.
  completed(sessionId: string): void {
    const file = this.file(sessionId);
    if (file) fs.rmSync(file, { force: true });
  }

  // The environment that makes Claude Code continue the session's cut-off turn when it is opened by a VS Code
  // process (hostPid) other than the one that went away. Waits briefly for that one to finish exiting.
  async continueEnv(sessionId: string, hostPid: number): Promise<Record<string, string> | undefined> {
    const e = this.read(sessionId);
    if (!e?.cutAt || !e.host) return undefined;
    const reruns = e.reruns ?? 0;
    if (this.o.now() - e.cutAt > MAX_AGE_MS || reruns >= MAX_RERUNS || this.same(e.host, hostPid)) return undefined;
    if (!(await this.gone(e.host))) return undefined;
    this.write(sessionId, { reruns: reruns + 1 });
    return CONTINUE_ENV;
  }

  private same(host: Host, pid: number): boolean {
    return host.pid === pid && host.start === this.o.processStart(pid);
  }

  private async gone(host: Host): Promise<boolean> {
    const until = Date.now() + this.o.hostExitWaitMs;
    for (;;) {
      const start = this.o.processStart(host.pid);
      if (start === undefined || start !== host.start) return true;
      if (Date.now() >= until) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // Notes of sessions that were never opened again.
  private prune(): void {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.o.dir);
    } catch {}
    for (const name of names) {
      const file = path.join(this.o.dir, name);
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > KEEP_MS) fs.rmSync(file, { force: true });
      } catch {}
    }
  }

  private file(sessionId: string): string | undefined {
    return SESSION_ID.test(sessionId) ? path.join(this.o.dir, `${sessionId}.json`) : undefined;
  }

  private read(sessionId: string): Entry | undefined {
    const file = this.file(sessionId);
    if (!file) return undefined;
    try {
      const v = JSON.parse(fs.readFileSync(file, "utf8"));
      return v && typeof v === "object" ? (v as Entry) : undefined;
    } catch {
      return undefined;
    }
  }

  private write(sessionId: string, e: Entry): void {
    const file = this.file(sessionId);
    if (!file) return;
    fs.mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(e), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
}
