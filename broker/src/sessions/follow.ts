import fs from "node:fs";
import type { AgentTranscript, DisplayItem, FollowStart, ServerMsg, TaskOutput, TranscriptAfter } from "../protocol.ts";
import type { SessionCore } from "./core.ts";
import { afterArg, agentTranscript, transcriptFile } from "./subagents.ts";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
// The most one window follows at once; another ends the oldest.
const FOLLOWS_MAX = 8;
// The lines Claude Code writes for one message go out together.
const GATHER_MS = 50;
// How soon a change the kernel's watch did not report is found all the same, and how often a file is looked at where the
// kernel cannot watch it (its watches used up, as an editor watching a large tree can do).
const CHECK_MS = 2000;
const LOOK_MS = 500;
// A shell's output is read again this soon after a read that found it changed, and this soon after one that did not.
const OUTPUT_BUSY_MS = 1000;
const OUTPUT_QUIET_MS = 2000;
const OPEN_MAX = 100;

export interface FollowHost {
  cwdOf(sessionId: string): Promise<string>;
  // The session's process this broker drives, if any.
  session(sessionId: string): SessionCore | undefined;
  push(sessionId: string, msg: ServerMsg): void;
}

interface Follow {
  readonly sessionId: string;
  closed: boolean;
  close(): void;
}

type Obj = Record<string, unknown>;

const openOf = (items: DisplayItem[]): string[] => items.flatMap((i) => (i.kind === "tool" && !i.result ? [i.id] : []));

// Where the phone stands once it took an answer to `after`, as it would ask next.
export function advance(after: TranscriptAfter, r: AgentTranscript): TranscriptAfter {
  if (r.reset || r.missing) {
    const last = r.items.at(-1);
    return last ? { count: r.from + r.items.length, lastId: last.id, open: openOf(r.items).slice(-OPEN_MAX) } : { count: 0, lastId: "" };
  }
  const done = new Set((r.changed ?? []).map((i) => i.id));
  return {
    count: r.from + r.items.length,
    lastId: r.items.at(-1)?.id ?? after.lastId,
    open: [...(after.open ?? []).filter((id) => !done.has(id)), ...openOf(r.items)].slice(-OPEN_MAX),
  };
}

// Whether an answer to `after` tells the phone anything it does not hold.
function news(after: TranscriptAfter, r: AgentTranscript): boolean {
  if (r.items.length || r.changed?.length) return true;
  return Boolean(r.reset || r.missing) && !(after.count === 0 && r.total === 0);
}

// A subagent's transcript the phone shows: watched while followed, each change read from where the last read stopped and
// sent as what changed since the last one sent. The kernel tells of a change where it can; otherwise the file is looked at
// often. The watch ends when the file goes, which the phone hears of.
class TranscriptFollow implements Follow {
  closed = false;
  private cwd = "";
  private agentId = "";
  private file = "";
  private cursor: TranscriptAfter = { count: 0, lastId: "" };
  private watcher?: fs.FSWatcher;
  private looking = false;
  private check?: NodeJS.Timeout;
  private timer?: NodeJS.Timeout;
  private stat?: { size: number; mtimeMs: number };
  private queue: Promise<unknown> = Promise.resolve();

  readonly sessionId: string;
  readonly id: string;
  readonly ref: { agentId?: string; toolUseId?: string };
  private host: FollowHost;
  private lost: (f: Follow) => void;

  constructor(sessionId: string, id: string, ref: { agentId?: string; toolUseId?: string }, host: FollowHost, lost: (f: Follow) => void) {
    this.sessionId = sessionId;
    this.id = id;
    this.ref = ref;
    this.host = host;
    this.lost = lost;
  }

  names(ref: { agentId?: string; toolUseId?: string }): boolean {
    return ref.agentId === this.ref.agentId && ref.toolUseId === this.ref.toolUseId;
  }

  async start(after: TranscriptAfter): Promise<FollowStart> {
    this.cwd = await this.host.cwdOf(this.sessionId);
    const found = await transcriptFile(this.sessionId, this.cwd, this.ref);
    if (!found || this.closed) return { live: false };
    this.agentId = found.agentId;
    this.file = found.file;
    const changed = await this.resync(after);
    if (this.closed) return { ...changed, live: false };
    try {
      const st = fs.statSync(this.file);
      this.stat = { size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      this.close();
      return { ...changed, live: false };
    }
    try {
      this.watcher = fs.watch(this.file, { persistent: false }, (event) => (event === "rename" ? this.gone() : this.soon()));
      this.watcher.on("error", () => this.look());
      this.check = setInterval(() => void this.recheck(), CHECK_MS);
      this.check.unref();
    } catch {
      this.look();
    }
    // Lines written before the watch began go out too.
    this.soon();
    return { ...changed, live: true };
  }

  // Looks at the file's size and time often instead of waiting for the kernel to tell.
  private look(): void {
    this.watcher?.close();
    clearInterval(this.check);
    this.watcher = this.check = undefined;
    if (this.closed || this.looking) return;
    this.looking = true;
    fs.watchFile(this.file, { interval: LOOK_MS, persistent: false }, this.looked);
  }

  private looked = (now: fs.Stats, before: fs.Stats): void => {
    if (!now.ino) this.gone();
    else if (now.size !== before.size || now.mtimeMs !== before.mtimeMs) this.soon();
  };

  // What changed since what the phone says it holds, from which the next changes go on.
  resync(after: TranscriptAfter): Promise<FollowStart> {
    return this.run(async () => {
      const r = await agentTranscript(this.sessionId, this.cwd, { agentId: this.agentId, after });
      this.cursor = advance(after, r);
      return { live: !this.closed, ...(news(after, r) ? { transcript: r } : {}) };
    });
  }

  close(): void {
    this.closed = true;
    this.watcher?.close();
    if (this.looking) fs.unwatchFile(this.file, this.looked);
    this.looking = false;
    clearInterval(this.check);
    clearTimeout(this.timer);
    this.watcher = this.check = this.timer = undefined;
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  private soon(): void {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run(() => this.send()).catch((e: unknown) => {
        if (e instanceof Error && /too large/.test(e.message)) this.gone();
      });
    }, GATHER_MS);
  }

  private async send(): Promise<void> {
    if (this.closed) return;
    const base = { count: this.cursor.count, lastId: this.cursor.lastId };
    const r = await agentTranscript(this.sessionId, this.cwd, { agentId: this.agentId, after: this.cursor });
    if (this.closed || !news(this.cursor, r)) return;
    this.cursor = advance(this.cursor, r);
    this.host.push(this.sessionId, { t: "follow", sessionId: this.sessionId, id: this.id, base, transcript: r });
  }

  private async recheck(): Promise<void> {
    try {
      const st = await fs.promises.stat(this.file);
      const known = this.stat;
      this.stat = { size: st.size, mtimeMs: st.mtimeMs };
      if (known && (known.size !== st.size || known.mtimeMs !== st.mtimeMs)) this.soon();
    } catch {
      this.gone();
    }
  }

  private gone(): void {
    if (this.closed) return;
    this.close();
    this.lost(this);
  }
}

// A shell's or monitor's output the phone shows, read again while the shell runs: soon after a read that found it changed,
// later after one that did not, once more when it ends. Only a changed output is sent.
class OutputFollow implements Follow {
  closed = false;
  private timer?: NodeJS.Timeout;
  private reading = false;
  private last = "";

  readonly sessionId: string;
  readonly id: string;
  readonly taskId: string;
  private session: SessionCore;
  private host: FollowHost;
  private lost: (f: Follow) => void;

  constructor(sessionId: string, id: string, taskId: string, session: SessionCore, host: FollowHost, lost: (f: Follow) => void) {
    this.sessionId = sessionId;
    this.id = id;
    this.taskId = taskId;
    this.session = session;
    this.host = host;
    this.lost = lost;
  }

  async start(): Promise<FollowStart> {
    const output = await this.session.taskOutput(this.taskId);
    this.last = JSON.stringify(output);
    if (this.closed) return { live: false, output };
    if (this.running()) {
      this.session.on("state", this.onState);
      this.session.once("closed", this.onClosed);
      this.wait(OUTPUT_BUSY_MS);
    }
    return { live: true, output };
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.session.off("state", this.onState);
    this.session.off("closed", this.onClosed);
  }

  private running(): boolean {
    return this.session.tasks.get(this.taskId)?.status === "running";
  }

  private onState = (): void => {
    if (!this.running() && this.timer) this.wait(0);
  };

  private onClosed = (): void => this.gone();

  private wait(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.read(), ms);
  }

  private async read(): Promise<void> {
    this.timer = undefined;
    if (this.closed || this.reading) return;
    this.reading = true;
    const ended = !this.running();
    let output: TaskOutput;
    try {
      output = await this.session.taskOutput(this.taskId);
    } catch {
      this.reading = false;
      return this.gone();
    }
    this.reading = false;
    if (this.closed) return;
    const shown = JSON.stringify(output);
    const changed = shown !== this.last;
    if (changed) {
      this.last = shown;
      this.host.push(this.sessionId, { t: "follow", sessionId: this.sessionId, id: this.id, output });
    }
    if (ended) {
      this.session.off("state", this.onState);
      return;
    }
    this.wait(changed ? OUTPUT_BUSY_MS : OUTPUT_QUIET_MS);
  }

  private gone(): void {
    if (this.closed) return;
    this.close();
    this.lost(this);
  }
}

// What the window on the phone follows, by the ids it gave them. A follow the phone lets go of, or one that loses what
// it watched, ends; one that ends on its own tells the phone, which reads again itself.
export class Follows {
  private all = new Map<string, Follow>();
  private host: FollowHost;

  constructor(host: FollowHost) {
    this.host = host;
  }

  get size(): number {
    return this.all.size;
  }

  async start(sessionId: string, args: Obj): Promise<FollowStart> {
    const id = args.id;
    if (typeof id !== "string" || !ID.test(id)) throw Error("invalid request");
    if (args.kind === "transcript") {
      const after = afterArg(args.after) ?? { count: 0, lastId: "", open: [] };
      const ref = {
        ...(typeof args.agentId === "string" ? { agentId: args.agentId } : {}),
        ...(typeof args.toolUseId === "string" ? { toolUseId: args.toolUseId } : {}),
      };
      const same = this.all.get(id);
      if (same instanceof TranscriptFollow && same.sessionId === sessionId && same.names(ref)) return same.resync(after);
      const f = new TranscriptFollow(sessionId, id, ref, this.host, (x) => this.lose(x));
      return this.open(id, f, () => f.start(after));
    }
    if (args.kind === "output") {
      if (typeof args.taskId !== "string" || !args.taskId) throw Error("invalid request");
      const session = this.host.session(sessionId);
      if (!session) throw Error("session is not running here");
      const f = new OutputFollow(sessionId, id, args.taskId, session, this.host, (x) => this.lose(x));
      return this.open(id, f, () => f.start());
    }
    throw Error("invalid request");
  }

  stop(id: string): void {
    this.all.get(id)?.close();
    this.all.delete(id);
  }

  stopAll(): void {
    for (const f of this.all.values()) f.close();
    this.all.clear();
  }

  // Taken in before it starts, so letting go of it meanwhile ends it.
  private async open(id: string, f: Follow, start: () => Promise<FollowStart>): Promise<FollowStart> {
    this.stop(id);
    this.all.set(id, f);
    for (const [old, x] of [...this.all].slice(0, -FOLLOWS_MAX)) {
      this.stop(old);
      this.host.push(x.sessionId, { t: "follow_end", sessionId: x.sessionId, id: old });
    }
    try {
      const r = await start();
      if (!r.live) this.drop(id, f);
      return r;
    } catch (e) {
      this.drop(id, f);
      throw e;
    }
  }

  private drop(id: string, f: Follow): void {
    f.close();
    if (this.all.get(id) === f) this.all.delete(id);
  }

  private lose(f: Follow): void {
    for (const [id, x] of this.all) {
      if (x !== f) continue;
      this.all.delete(id);
      this.host.push(f.sessionId, { t: "follow_end", sessionId: f.sessionId, id });
    }
  }
}
