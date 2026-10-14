import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import net from "node:net";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { LineSplitter, parseLine } from "../link/lines.ts";
import { LINK_VERSION, REMOTE_PREFIX, isPrivateDir, type BrokerFrame, type Hello, type Party, type WrapperFrame } from "../link/protocol.ts";
import { liveProcesses } from "../sessions/live.ts";
import type { TurnStore } from "./turns.ts";

const NL = Buffer.from("\n");
const CONTROL = Buffer.from('"control_');
const INIT = Buffer.from('"subtype":"init"');
const STATUS = Buffer.from('"subtype":"status"');
const MODE = Buffer.from('"permissionMode"');
const STATE = Buffer.from('"subtype":"session_state_changed"');
const MODELS = Buffer.from('"models":');
const RESULT = Buffer.from('"type":"result"');
const USER = Buffer.from('"type":"user"');
// The broker sees the conversation, these requests from Claude Code (only can_use_tool may be answered
// remotely), the answer to VS Code's initialize, and these settings changes from VS Code; other control
// traffic between VS Code and Claude Code stays between them.
const SHOWN = new Set(["can_use_tool", "elicitation", "request_user_dialog"]);
const HOST_SETTINGS = new Set(["set_model", "set_permission_mode", "apply_flag_settings"]);
// Control requests the broker may send.
const REMOTE_REQUESTS = new Set([
  "interrupt",
  "set_model",
  "set_permission_mode",
  "apply_flag_settings",
  "get_context_usage",
  "mcp_status",
  "mcp_toggle",
  "mcp_reconnect",
  "rewind_files",
  "stop_task",
]);
const SETTLED_KEEP = 500;
const LINK_BUFFER_MAX = 16 * 1024 * 1024;
const RELEASE_WAIT_MS = 9000;

export interface RelayOptions {
  claudePath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  socketPath: string;
  hostIn: Readable;
  hostOut: Writable;
  log: (msg: string) => void;
  // How long a launch that resumes a session waits for the broker to acknowledge it, and at most in all.
  claimAckMs?: number;
  claimMaxMs?: number;
  retryMs?: number[];
  // VS Code's process. When it goes away mid-turn, as on a window reload, `turns` notes the turn so the
  // next launch of the session can continue it.
  hostPid?: number;
  turns?: TurnStore;
  // Whether another process holds a session, and how long a resuming launch waits for it to let go.
  heldElsewhere?: (sessionId: string) => boolean;
  releaseWaitMs?: number;
}

export function argValue(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1];
    if (args[i].startsWith(name + "=")) return args[i].slice(name.length + 1);
  }
  return undefined;
}

// The session a launch runs when the arguments say so. Only a plain resume continues an existing
// session in place, so only that waits for the broker to hand it over.
export function launchSession(args: string[]): { sessionId?: string; claim?: string } {
  const explicit = argValue(args, "--session-id");
  if (explicit) return { sessionId: explicit };
  const resume = argValue(args, "--resume");
  if (resume && !args.includes("--fork-session")) return { sessionId: resume, claim: resume };
  return {};
}

class Gate {
  readonly opened: Promise<void>;
  isOpen = false;
  private release!: () => void;
  private timer?: NodeJS.Timeout;
  private deadline: number;

  constructor(ms: number, maxMs: number) {
    this.opened = new Promise((resolve) => (this.release = resolve));
    this.deadline = Date.now() + maxMs;
    this.wait(ms);
  }

  wait(ms: number): void {
    if (this.isOpen) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.open(), Math.max(0, Math.min(ms, this.deadline - Date.now())));
  }

  open(): void {
    clearTimeout(this.timer);
    this.isOpen = true;
    this.release();
  }
}

// Sits between VS Code (hostIn/hostOut) and the Claude Code process it asked for. Every line passes
// through unchanged and a copy goes to the broker, which may add user messages, its own control
// requests and answers to open permission prompts. Whichever side answers a prompt first wins.
// Without a broker the relay keeps working and reconnects in the background.
// Emits "exit" (code, signal) once Claude Code has ended and its output has been passed on.
export class Relay extends EventEmitter {
  private o: RelayOptions;
  private child?: ChildProcess;
  private queued: Buffer[] = [];
  private hostEnded = false;
  private hostGone = false;
  private open = new Map<string, { subtype: string; line: Buffer }>();
  private settled = new Map<string, Party>();
  private state = new Map<string, { seq: number; t: "out" | "in"; line: Buffer }>();
  private seq = 0;
  private sessionId?: string;
  private claim?: string;
  private gate?: Gate;
  private fork = false;
  private claimSettled = false;
  private running = false;
  private hostLeft = false;
  private warnedDir = false;
  private link?: net.Socket;
  private retry = 0;
  private retryTimer?: NodeJS.Timeout;
  private finished = false;
  private childPaused = false;
  private hostPaused = false;

  constructor(o: RelayOptions) {
    super();
    this.o = o;
    const launch = launchSession(o.args);
    this.sessionId = launch.sessionId;
    this.claim = launch.claim;
  }

  async start(): Promise<void> {
    const split = new LineSplitter((line) => this.fromHost(line));
    this.o.hostIn.on("data", (chunk: Buffer) => split.push(chunk));
    this.o.hostIn.on("end", () => {
      this.o.log("VS Code closed its input");
      this.leave();
      split.end();
      this.hostEnded = true;
      this.child?.stdin?.end();
    });
    this.o.hostOut.on("error", () => {
      if (!this.hostGone) this.o.log("VS Code stopped reading");
      this.hostGone = true;
    });
    if (this.claim) this.gate = new Gate(this.o.claimAckMs ?? 3000, this.o.claimMaxMs ?? 45_000);
    this.connect();
    let env = this.o.env;
    if (this.gate) {
      const t0 = Date.now();
      await this.gate.opened;
      this.o.log(`claim ${this.claim} took ${Date.now() - t0}ms`);
      if (!this.claimSettled) await this.awaitRelease(this.claim!);
      const extra = this.fork || this.finished || !this.o.hostPid ? undefined : await this.continueEnv(this.claim!, this.o.hostPid);
      if (extra) {
        this.o.log("continuing the turn VS Code left unfinished");
        env = { ...env, ...extra };
      }
    }
    this.spawnChild(env);
  }

  // Forwards a termination signal; before Claude Code has started the relay just ends.
  signal(sig: NodeJS.Signals): void {
    this.leave();
    if (this.child) this.child.kill(sig);
    else this.finish(null, sig);
  }

  private leave(): void {
    if (this.hostLeft) return;
    this.hostLeft = true;
    if (!this.running || !this.sessionId || !this.o.hostPid || !this.o.turns) return;
    try {
      this.o.turns.cut(this.sessionId, this.o.hostPid);
      this.o.log("VS Code left during a turn");
    } catch (e) {
      this.o.log(`cannot note the unfinished turn: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // A note that cannot be read or updated continues nothing, and Claude Code starts all the same.
  private async continueEnv(sessionId: string, hostPid: number): Promise<Record<string, string> | undefined> {
    try {
      return await this.o.turns?.continueEnv(sessionId, hostPid);
    } catch (e) {
      this.o.log(`cannot use the note of an unfinished turn: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  }

  // Only the broker's go-ahead says the session's previous process is gone. Without it the launch waits for
  // that process itself, and starts on a copy if it does not let go, so two processes never share a session.
  private async awaitRelease(sessionId: string): Promise<void> {
    const held = this.o.heldElsewhere ?? ((id: string) => liveProcesses({ fresh: true }).some((l) => l.sessionId === id));
    if (this.finished || !held(sessionId)) return;
    this.o.log(`session ${sessionId} is still open in another process; waiting for it`);
    const until = Date.now() + (this.o.releaseWaitMs ?? RELEASE_WAIT_MS);
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 250));
      if (this.finished || !held(sessionId)) return;
    }
    this.fork = true;
    this.sessionId = undefined;
  }

  private spawnChild(env: NodeJS.ProcessEnv): void {
    if (this.finished) return;
    const args = this.fork && !this.o.args.includes("--fork-session") ? [...this.o.args, "--fork-session"] : this.o.args;
    if (this.fork) this.o.log(`session ${this.claim} is held by another process; starting a copy of it`);
    const child = spawn(this.o.claudePath, args, { cwd: this.o.cwd, env, stdio: ["pipe", "pipe", "inherit"] });
    this.child = child;
    child.stdin!.on("error", () => {});
    child.on("error", (e) => {
      this.o.log(`cannot start claude: ${e.message}`);
      process.stderr.write(`ccrc-wrapper: cannot start ${this.o.claudePath}: ${e.message}\n`);
      this.finish(127, null);
    });
    const split = new LineSplitter((line) => this.fromChild(line));
    child.stdout!.on("data", (chunk: Buffer) => split.push(chunk));
    child.stdout!.on("end", () => split.end());
    child.on("close", (code, signal) => this.finish(code, signal));
    child.stdin!.on("drain", () => {
      if (this.hostPaused) {
        this.hostPaused = false;
        this.o.hostIn.resume();
      }
    });
    if (child.pid) {
      this.o.log(`spawned claude pid=${child.pid}`);
      this.send({ t: "spawned", cpid: child.pid });
    }
    for (const line of this.queued.splice(0)) this.toChild(line);
    if (this.hostEnded) child.stdin!.end();
  }

  private fromHost(line: Buffer): void {
    if (line.includes(CONTROL)) {
      const msg = parseLine(line);
      if (msg?.type === "control_response") {
        const id = (msg.response as Record<string, unknown> | undefined)?.request_id;
        if (typeof id === "string") {
          const by = this.settled.get(id);
          if (by) {
            this.send({ t: "dropped", id, from: "host", by });
            return;
          }
          if (this.open.delete(id)) this.settle(id, "host");
        }
      }
      const subtype = msg?.type === "control_request" ? (msg.request as Record<string, unknown> | undefined)?.subtype : undefined;
      if (typeof subtype === "string" && HOST_SETTINGS.has(subtype)) {
        this.remember(`in:${subtype}`, "in", line);
        this.copy("in", line);
      }
    }
    this.toChild(line);
  }

  private fromChild(line: Buffer): void {
    let msg: Record<string, unknown> | undefined;
    let shared = true;
    if (line.includes(CONTROL)) {
      msg = parseLine(line);
      const id = msg?.type === "control_response" ? (msg.response as Record<string, unknown> | undefined)?.request_id : msg?.request_id;
      if (msg?.type === "control_response") {
        if (typeof id === "string" && id.startsWith(REMOTE_PREFIX)) {
          this.copy("reply", line);
          return;
        }
        shared = line.includes(MODELS);
      } else if (msg?.type === "control_request") {
        const subtype = (msg.request as Record<string, unknown> | undefined)?.subtype;
        shared = typeof id === "string" && typeof subtype === "string" && SHOWN.has(subtype);
        if (shared) this.open.set(id as string, { subtype: subtype as string, line });
      } else if (msg?.type === "control_cancel_request" && typeof id === "string" && this.open.delete(id)) {
        this.settle(id, "cli");
      }
    }
    this.toHost(line);
    this.noteTurn(line, msg);
    if (!shared) return;
    this.noteState(line, msg);
    this.copy("out", line);
  }

  // A turn runs from its init line or the user message that opens it until its result.
  private noteTurn(line: Buffer, parsed?: Record<string, unknown>): void {
    if (line.includes(RESULT)) {
      if ((parsed ?? parseLine(line))?.type !== "result") return;
      this.running = false;
      if (this.hostLeft || !this.sessionId) return;
      try {
        this.o.turns?.completed(this.sessionId);
      } catch (e) {
        this.o.log(`cannot clear the note of a finished turn: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (!this.running && (line.includes(INIT) || line.includes(USER))) {
      const m = parsed ?? parseLine(line);
      if (m?.type === "user" || (m?.type === "system" && m.subtype === "init")) this.running = true;
    }
  }

  private noteState(line: Buffer, parsed?: Record<string, unknown>): void {
    let key: string | undefined;
    if (line.includes(INIT)) key = "init";
    else if (line.includes(STATE)) key = "state";
    else if (line.includes(STATUS) && line.includes(MODE)) key = "status";
    else if (parsed?.type === "control_response" && line.includes(MODELS)) key = "models";
    if (!key) return;
    const msg = parsed ?? parseLine(line);
    if (!msg || (key !== "models" && msg.type !== "system")) return;
    if (key === "init" && typeof msg.session_id === "string" && msg.session_id) this.sessionId = msg.session_id;
    this.remember(key, "out", line);
  }

  private remember(key: string, t: "out" | "in", line: Buffer): void {
    this.state.set(key, { seq: ++this.seq, t, line });
  }

  private inject(m: Record<string, unknown>): void {
    const reject = (reason: string, id?: unknown) => {
      this.o.log(`rejected remote line: ${reason}`);
      this.send({ t: "rejected", ...(typeof id === "string" ? { id } : {}), reason });
    };
    if (this.hostEnded || this.finished) return reject("closed", m.type === "control_request" ? m.request_id : undefined);
    if (m.type === "user") {
      if ((m.message as Record<string, unknown> | undefined)?.role !== "user") return reject("invalid user message");
      this.toChild(Buffer.from(JSON.stringify(m)));
      return;
    }
    if (m.type === "control_request") {
      const req = m.request as Record<string, unknown> | undefined;
      if (typeof m.request_id !== "string" || !m.request_id.startsWith(REMOTE_PREFIX) || !req) return reject("invalid request", m.request_id);
      if (typeof req.subtype !== "string" || !REMOTE_REQUESTS.has(req.subtype)) return reject("request not allowed", m.request_id);
      if (req.subtype === "set_permission_mode" && req.mode === "bypassPermissions") return reject("mode not allowed", m.request_id);
      const settings = req.subtype === "apply_flag_settings" ? req.settings : undefined;
      if (settings !== undefined && (typeof settings !== "object" || settings === null || Object.keys(settings).some((k) => k !== "effortLevel"))) {
        return reject("setting not allowed", m.request_id);
      }
      this.toChild(Buffer.from(JSON.stringify(m)));
      return;
    }
    if (m.type === "control_response") {
      const response = m.response as Record<string, unknown> | undefined;
      const id = response?.request_id;
      if (typeof id !== "string") return reject("invalid response");
      const by = this.settled.get(id);
      if (by) {
        this.send({ t: "dropped", id, from: "remote", by });
        return;
      }
      if (this.open.get(id)?.subtype !== "can_use_tool") return reject("not answerable", id);
      const updates = (response?.response as Record<string, unknown> | undefined)?.updatedPermissions;
      if (Array.isArray(updates) && updates.some((u) => (u as Record<string, unknown> | null)?.mode === "bypassPermissions")) {
        return reject("mode not allowed", id);
      }
      this.open.delete(id);
      this.toChild(Buffer.from(JSON.stringify(m)));
      this.toHost(Buffer.from(JSON.stringify({ type: "control_cancel_request", request_id: id })));
      this.settle(id, "remote");
      return;
    }
    reject("unsupported");
  }

  private settle(id: string, by: Party): void {
    this.settled.set(id, by);
    if (this.settled.size > SETTLED_KEEP) this.settled.delete(this.settled.keys().next().value!);
    this.send({ t: "settled", id, by });
  }

  private toChild(line: Buffer): void {
    const stdin = this.child?.stdin;
    if (!stdin) {
      this.queued.push(line);
      return;
    }
    if (!stdin.writable) return;
    stdin.write(line);
    if (!stdin.write(NL) && !this.hostPaused) {
      this.hostPaused = true;
      this.o.hostIn.pause();
    }
  }

  private toHost(line: Buffer): void {
    if (this.hostGone) return;
    const out = this.o.hostOut;
    out.write(line);
    if (!out.write(NL) && !this.childPaused && this.child?.stdout) {
      this.childPaused = true;
      this.child.stdout.pause();
      out.once("drain", () => {
        this.childPaused = false;
        this.child?.stdout?.resume();
      });
    }
  }

  private send(frame: WrapperFrame): void {
    this.write(Buffer.from(JSON.stringify(frame) + "\n"));
  }

  // Embeds the line as it is; the frame type comes after it so it wins over anything inside.
  private copy(t: "out" | "in" | "reply", line: Buffer): void {
    if (!line.length) return;
    this.write(Buffer.concat([Buffer.from('{"m":'), line, Buffer.from(`,"t":"${t}"}\n`)]));
  }

  private write(data: Buffer): void {
    const link = this.link;
    if (!link || link.destroyed) return;
    if (link.writableLength > LINK_BUFFER_MAX) {
      this.o.log("broker is not reading; dropping the connection");
      link.destroy();
      return;
    }
    link.write(data);
  }

  private connect(): void {
    if (this.finished) return;
    if (!isPrivateDir(path.dirname(this.o.socketPath))) {
      if (!this.warnedDir) this.o.log(`not connecting: ${path.dirname(this.o.socketPath)} is missing or not private`);
      this.warnedDir = true;
      this.gate?.open();
      this.retryLater();
      return;
    }
    const sock = net.createConnection(this.o.socketPath);
    sock.on("connect", () => {
      this.link = sock;
      if (this.retry) this.o.log("broker connected");
      this.retry = 0;
      const claiming = this.gate && !this.gate.isOpen;
      const hello: Hello = {
        t: "hello",
        v: LINK_VERSION,
        wpid: process.pid,
        cwd: this.o.cwd,
        args: this.o.args,
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
        ...(claiming ? { claim: this.claim } : {}),
      };
      this.send(hello);
      if (this.child?.pid) this.send({ t: "spawned", cpid: this.child.pid });
      for (const s of [...this.state.values()].sort((a, b) => a.seq - b.seq)) this.copy(s.t, s.line);
      for (const { line } of this.open.values()) this.copy("out", line);
      if (claiming) this.gate!.wait(this.o.claimAckMs ?? 3000);
    });
    const split = new LineSplitter((line) => this.fromBroker(line));
    sock.on("data", (chunk: Buffer) => split.push(chunk));
    sock.on("error", () => {});
    sock.on("close", () => {
      if (this.link === sock) {
        this.link = undefined;
        this.o.log("broker connection closed");
      }
      this.gate?.open();
      this.retryLater();
    });
  }

  private retryLater(): void {
    if (this.finished) return;
    const delays = this.o.retryMs ?? [1000, 2000, 5000, 10_000, 15_000];
    const ms = delays[Math.min(this.retry++, delays.length - 1)];
    this.retryTimer = setTimeout(() => this.connect(), ms);
    this.retryTimer.unref();
  }

  private fromBroker(line: Buffer): void {
    const f = parseLine(line) as BrokerFrame | undefined;
    if (!f) return;
    try {
      if (f.t === "claim_ok") {
        if (this.gate && !this.gate.isOpen) {
          this.claimSettled = true;
          if (f.fork) {
            this.fork = true;
            this.sessionId = undefined;
          }
        }
        this.gate?.open();
      } else if (f.t === "claim_wait") this.gate?.wait(Math.max(0, Number(f.ms) || 0));
      else if (f.t === "to_cli" && f.m && typeof f.m === "object") this.inject(f.m);
    } catch (e) {
      this.o.log(`broker frame failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.retryTimer);
    this.gate?.open();
    this.o.log(`claude exited code=${code} signal=${signal}`);
    this.send({ t: "exit", code, signal });
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      this.emit("exit", code, signal);
    };
    const link = this.link;
    if (link && !link.destroyed) {
      link.end(end);
      setTimeout(end, 500);
    } else end();
  }
}
