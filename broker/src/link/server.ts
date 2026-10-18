import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { LineSplitter, parseLine } from "./lines.ts";
import { LINK_VERSION, REMOTE_PREFIX, isPrivateDir, type BrokerFrame, type Hello } from "./protocol.ts";

const REQUEST_TIMEOUT_MS = 15_000;

interface Waiter {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  progress?: (m: Record<string, unknown>) => void;
}

export interface RequestOptions {
  // Claude Code's control_request_progress lines for the request.
  onProgress?: (m: Record<string, unknown>) => void;
  // Gives the request up and asks Claude Code to cancel it.
  signal?: AbortSignal;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// One wrapper connection, that is one Claude Code conversation process started by VS Code.
// Events: hello (Hello), session (id, when a line names a session other than the known one),
// out (msg), in (msg), settled (id, by), held (id), dropped (id, from, by), rejected (id, reason),
// spawned (cpid), exit (code, signal, hostLeft, running), close.
export class Link extends EventEmitter {
  hello?: Hello;
  cpid?: number;
  sessionId?: string;
  exited = false;
  private sock: net.Socket;
  private waiting = new Map<string, Waiter>();

  constructor(sock: net.Socket) {
    super();
    this.sock = sock;
    const split = new LineSplitter((line) => this.onLine(line));
    sock.on("data", (chunk: Buffer) => split.push(chunk));
    sock.on("error", () => {});
    sock.on("close", () => {
      for (const w of this.waiting.values()) {
        clearTimeout(w.timer);
        w.reject(Error("session closed"));
      }
      this.waiting.clear();
      this.emit("close");
    });
  }

  get usable(): boolean {
    return !this.sock.destroyed && !this.exited;
  }

  send(frame: BrokerFrame): void {
    if (!this.sock.destroyed) this.sock.write(JSON.stringify(frame) + "\n");
  }

  // Sends a control request to Claude Code and resolves with its success payload.
  request(request: Record<string, unknown>, ms = REQUEST_TIMEOUT_MS, opts: RequestOptions = {}): Promise<Record<string, unknown>> {
    if (!this.usable) return Promise.reject(Error("session closed"));
    const { signal, onProgress } = opts;
    if (signal?.aborted) return Promise.reject(Error("cancelled"));
    const id = `${REMOTE_PREFIX}${randomUUID()}`;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(Error("Claude Code did not answer"));
      }, ms);
      this.waiting.set(id, { resolve, reject, timer, ...(onProgress ? { progress: onProgress } : {}) });
      this.send({ t: "to_cli", m: { type: "control_request", request_id: id, request } });
      signal?.addEventListener(
        "abort",
        () =>
          this.settleWaiter(id, (w) => {
            this.send({ t: "to_cli", m: { type: "control_cancel_request", request_id: id } });
            w.reject(Error("cancelled"));
          }),
        { once: true },
      );
    });
  }

  close(): void {
    this.sock.destroy();
  }

  private settleWaiter(id: unknown, fn: (w: Waiter) => void): void {
    if (typeof id !== "string") return;
    const w = this.waiting.get(id);
    if (!w) return;
    this.waiting.delete(id);
    clearTimeout(w.timer);
    fn(w);
  }

  private onLine(line: Buffer): void {
    const f = parseLine(line);
    if (!f) return;
    switch (f.t) {
      case "hello": {
        if (this.hello || f.v !== LINK_VERSION || typeof f.wpid !== "number" || typeof f.cwd !== "string" || !Array.isArray(f.args)) {
          this.close();
          return;
        }
        const hello = f as unknown as Hello;
        this.hello = hello;
        this.sessionId = typeof hello.sessionId === "string" ? hello.sessionId : undefined;
        this.emit("hello", hello);
        return;
      }
      case "spawned":
        if (typeof f.cpid === "number") {
          this.cpid = f.cpid;
          this.emit("spawned", f.cpid);
        }
        return;
      case "out": {
        if (!this.hello || !isObject(f.m)) return;
        if (f.m.type === "system" && f.m.subtype === "control_request_progress") {
          if (typeof f.m.request_id === "string") this.waiting.get(f.m.request_id)?.progress?.(f.m);
          return;
        }
        const sid = f.m.session_id;
        if (typeof sid === "string" && sid && sid !== this.sessionId) {
          this.sessionId = sid;
          this.emit("session", sid);
        }
        this.emit("out", f.m);
        return;
      }
      case "in":
        if (this.hello && isObject(f.m)) this.emit("in", f.m);
        return;
      case "reply": {
        const r = isObject(f.m) && isObject(f.m.response) ? f.m.response : undefined;
        this.settleWaiter(r?.request_id, (w) =>
          r?.subtype === "success" ? w.resolve(isObject(r.response) ? r.response : {}) : w.reject(Error(String(r?.error ?? "request failed"))),
        );
        return;
      }
      case "settled":
        this.emit("settled", f.id, f.by);
        return;
      case "held":
        if (this.hello && typeof f.id === "string") this.emit("held", f.id);
        return;
      case "dropped":
        this.emit("dropped", f.id, f.from, f.by);
        return;
      case "rejected":
        this.settleWaiter(f.id, (w) => w.reject(Error(`rejected by the wrapper: ${String(f.reason)}`)));
        this.emit("rejected", f.id, f.reason);
        return;
      case "exit":
        this.exited = true;
        this.emit("exit", f.code, f.signal, f.hostLeft, f.running);
        return;
    }
  }
}

// Unix socket the wrappers connect to. Only the owner can reach it (private folder, 0600 socket).
// Emits "link" (Link) for each connection.
export class LinkServer extends EventEmitter {
  readonly socketPath: string;
  private server?: net.Server;
  private links = new Set<Link>();

  constructor(socketPath: string) {
    super();
    this.socketPath = socketPath;
  }

  async listen(): Promise<void> {
    const dir = path.dirname(this.socketPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {}
    if (!isPrivateDir(dir)) throw Error(`${dir} must be a folder owned by this user with mode 0700`);
    await removeStaleSocket(this.socketPath);
    const server = net.createServer((sock) => {
      const link = new Link(sock);
      this.links.add(link);
      link.on("close", () => this.links.delete(link));
      this.emit("link", link);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    fs.chmodSync(this.socketPath, 0o600);
    this.server = server;
  }

  async close(): Promise<void> {
    for (const link of this.links) link.close();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

// A socket file left by a broker that is gone is removed; one that still answers belongs to a running broker.
async function removeStaleSocket(p: string): Promise<void> {
  if (!fs.existsSync(p)) return;
  const inUse = await new Promise<boolean>((resolve) => {
    const s = net.createConnection(p);
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
  if (inUse) throw Error(`another broker is listening on ${p}`);
  fs.unlinkSync(p);
}
