import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Frames on the socket between a wrapper (one VS Code conversation process) and the broker,
// one JSON object per line. Lines copied from either side of the conversation travel unparsed
// as "m"; "t" is written last so a copied line can never rename its frame.

export const LINK_VERSION = 1;

// Prefix of the request ids the broker gives its own control requests.
export const REMOTE_PREFIX = "ccrc-";

export type Party = "host" | "remote" | "cli";

export interface Hello {
  t: "hello";
  v: number;
  wpid: number;
  cwd: string;
  args: string[];
  // Session the conversation process is known to run, if any.
  sessionId?: string;
  // Session the wrapper waits to start until the broker hands it over.
  claim?: string;
  // What this wrapper passes on beyond what LINK_VERSION promises: "fast_mode" and "thinking" changes.
  caps?: string[];
}

export type WrapperFrame =
  | Hello
  | { t: "spawned"; cpid: number }
  // A line Claude Code wrote towards VS Code.
  | { t: "out"; m: unknown }
  // A control line VS Code wrote towards Claude Code.
  | { t: "in"; m: unknown }
  // Claude Code's answer to a broker control request.
  | { t: "reply"; m: unknown }
  | { t: "settled"; id: string; by: Party }
  | { t: "dropped"; id: string; from: Party; by: Party }
  | { t: "rejected"; id?: string; reason: string }
  // An MCP input request the wrapper keeps from VS Code, which would decline it, until the broker takes or passes it.
  | { t: "held"; id: string }
  // hostLeft: VS Code closed Claude Code's input or passed it a signal; running: a turn was under way. Older wrappers send neither.
  | { t: "exit"; code: number | null; signal: string | null; hostLeft?: boolean; running?: boolean };

export type BrokerFrame =
  | { t: "claim_wait"; ms: number }
  // fork: the session is still held by another process, so Claude Code starts on a copy of it.
  | { t: "claim_ok"; fork?: boolean }
  | { t: "to_cli"; m: Record<string, unknown> }
  // take: the phone answers the held input request; pass: VS Code gets it after all.
  | { t: "take"; id: string }
  | { t: "pass"; id: string };

// The user's runtime folder when there is one, else the ccrc state folder; never a shared folder such as /tmp.
export function linkSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CCRC_LINK_SOCKET) return env.CCRC_LINK_SOCKET;
  const userRun = `/run/user/${process.getuid?.() ?? 0}`;
  const runtime = env.XDG_RUNTIME_DIR || (fs.existsSync(userRun) ? userRun : undefined);
  if (runtime) return path.join(runtime, "ccrc", "link.sock");
  const state = env.CCRC_STATE_DIR || path.join(env.XDG_STATE_HOME || path.join(env.HOME || os.homedir(), ".local", "state"), "ccrc");
  return path.join(state, "link.sock");
}

// Wrappers and the broker only use a socket whose folder belongs to this user and is closed to everyone else.
export function isPrivateDir(dir: string): boolean {
  try {
    const st = fs.lstatSync(dir);
    return st.isDirectory() && st.uid === process.getuid?.() && (st.mode & 0o077) === 0;
  } catch {
    return false;
  }
}
