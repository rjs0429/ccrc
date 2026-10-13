import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import net from "node:net";
import type { Readable, Writable } from "node:stream";
import { LineSplitter, parseLine } from "../link/lines.ts";
import { LINK_VERSION, REMOTE_PREFIX, type BrokerFrame, type Hello, type Party, type WrapperFrame } from "../link/protocol.ts";

const NL = Buffer.from("\n");
const CONTROL = Buffer.from('"control_');
const INIT = Buffer.from('"subtype":"init"');
const STATUS = Buffer.from('"subtype":"status"');
const MODE = Buffer.from('"permissionMode"');
const STATE = Buffer.from('"subtype":"session_state_changed"');
const MODELS = Buffer.from('"models":');
// Requests from Claude Code that the remote side shows. Only can_use_tool may be answered from there.
const SHOWN = new Set(["can_use_tool", "elicitation", "request_user_dialog"]);
// Settings VS Code changes on the fly; the last of each is replayed to a broker that connects later.
const HOST_SETTINGS = new Set(["set_model", "set_permission_mode", "apply_flag_settings"]);
const SETTLED_KEEP = 500;
const LINK_BUFFER_MAX = 16 * 1024 * 1024;

export interface RelayOptions {
  claudePath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  socketPath: string;
  hostIn: Readable;
  hostOut: Writable;
  log: (msg: string) => void;
  // How long a launch that resumes a session waits for the broker to acknowledge it, and at most for the hand-over.
  claimAckMs?: number;
  claimMaxMs?: number;
  retryMs?: number[];
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

  constructor(ms: number) {
    this.opened = new Promise((resolve) => (this.release = resolve));
    this.wait(ms);
  }

  wait(ms: number): void {
    if (this.isOpen) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.open(), ms);
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
      split.end();
      this.hostEnded = true;
      this.child?.stdin?.end();
    });
    this.o.hostOut.on("error", () => (this.hostGone = true));
    if (this.claim) this.gate = new Gate(this.o.claimAckMs ?? 3000);
    this.connect();
    if (this.gate) {
      const t0 = Date.now();
      await this.gate.opened;
      this.o.log(`claim ${this.claim} took ${Date.now() - t0}ms`);
    }
    this.spawnChild();
  }

  // Forwards a termination signal; before Claude Code has started the relay just ends.
  signal(sig: NodeJS.Signals): void {
    if (this.child) this.child.kill(sig);
    else this.finish(null, sig);
  }

  private spawnChild(): void {
    if (this.finished) return;
    const child = spawn(this.o.claudePath, this.o.args, { cwd: this.o.cwd, env: this.o.env, stdio: ["pipe", "pipe", "inherit"] });
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
      if (msg?.type === "control_request") {
        const subtype = (msg.request as Record<string, unknown> | undefined)?.subtype;
        if (typeof subtype === "string" && HOST_SETTINGS.has(subtype)) this.remember(`in:${subtype}`, "in", line);
      }
      if (typeof msg?.type === "string" && msg.type.startsWith("control_")) this.copy("in", line);
    }
    this.toChild(line);
  }

  private fromChild(line: Buffer): void {
    let msg: Record<string, unknown> | undefined;
    if (line.includes(CONTROL)) {
      msg = parseLine(line);
      const id = msg?.type === "control_response" ? (msg.response as Record<string, unknown> | undefined)?.request_id : msg?.request_id;
      if (msg?.type === "control_response" && typeof id === "string" && id.startsWith(REMOTE_PREFIX)) {
        this.copy("reply", line);
        return;
      }
      if (msg?.type === "control_request" && typeof id === "string") {
        const subtype = (msg.request as Record<string, unknown> | undefined)?.subtype;
        if (typeof subtype === "string" && SHOWN.has(subtype)) this.open.set(id, { subtype, line });
      } else if (msg?.type === "control_cancel_request" && typeof id === "string" && this.open.delete(id)) {
        this.settle(id, "cli");
      }
    }
    this.toHost(line);
    this.noteState(line, msg);
    this.copy("out", line);
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
    if (this.hostEnded || this.finished) return reject("closed");
    if (m.type === "user") {
      if ((m.message as Record<string, unknown> | undefined)?.role !== "user") return reject("invalid user message");
      this.toChild(Buffer.from(JSON.stringify(m)));
      return;
    }
    if (m.type === "control_request") {
      const req = m.request as Record<string, unknown> | undefined;
      if (typeof m.request_id !== "string" || !m.request_id.startsWith(REMOTE_PREFIX) || !req) return reject("invalid request", m.request_id);
      if (req.subtype === "set_permission_mode" && req.mode === "bypassPermissions") return reject("mode not allowed", m.request_id);
      this.toChild(Buffer.from(JSON.stringify(m)));
      return;
    }
    if (m.type === "control_response") {
      const id = (m.response as Record<string, unknown> | undefined)?.request_id;
      if (typeof id !== "string") return reject("invalid response");
      const by = this.settled.get(id);
      if (by) {
        this.send({ t: "dropped", id, from: "remote", by });
        return;
      }
      if (this.open.get(id)?.subtype !== "can_use_tool") return reject("not answerable", id);
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
      if (f.t === "claim_ok") this.gate?.open();
      else if (f.t === "claim_wait") this.gate?.wait(Math.min(Math.max(0, Number(f.ms) || 0), this.o.claimMaxMs ?? 25_000));
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
