import net from "node:net";
import { LineSplitter, parseLine } from "./lines.ts";
import { linkSocketPath, type WorkingSession } from "./protocol.ts";

const ASK_MS = 3000;

function isWorking(v: unknown): v is WorkingSession {
  const s = v as Partial<WorkingSession> | null;
  return (
    s !== null &&
    typeof s === "object" &&
    typeof s.id === "string" &&
    typeof s.cwd === "string" &&
    (s.title === undefined || typeof s.title === "string") &&
    typeof s.busy === "boolean" &&
    typeof s.requests === "number" &&
    typeof s.tasks === "number"
  );
}

// The sessions the broker on this machine runs that are at work, asked on the wrappers' socket; undefined when no broker
// answers in time, as one that is not running or is older than the question.
export function askWorking(socketPath = linkSocketPath(), ms = ASK_MS): Promise<WorkingSession[] | undefined> {
  return new Promise((resolve) => {
    const sock = net.createConnection(socketPath);
    const done = (v: WorkingSession[] | undefined) => {
      clearTimeout(timer);
      sock.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => done(undefined), ms);
    const split = new LineSplitter((line) => {
      const f = parseLine(line);
      if (f?.t === "working" && Array.isArray(f.sessions)) done(f.sessions.filter(isWorking));
    });
    sock.on("connect", () => sock.write(JSON.stringify({ t: "ask_working" }) + "\n"));
    sock.on("data", (c: Buffer) => split.push(c));
    sock.on("error", () => done(undefined));
    sock.on("close", () => done(undefined));
  });
}

// One line for each session: its name, or the start of its id, its folder and what it is doing.
export function workingLines(list: WorkingSession[]): string[] {
  return list.map((s) => {
    const doing = [
      s.busy ? "answering" : "",
      s.requests ? `waiting for ${s.requests} answer${s.requests === 1 ? "" : "s"}` : "",
      s.tasks ? `${s.tasks} task${s.tasks === 1 ? "" : "s"} running` : "",
    ].filter(Boolean);
    return `  - ${s.title || s.id.slice(0, 8)} (${s.cwd}): ${doing.join(", ") || "at work"}`;
  });
}
