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
  | { t: "exit"; code: number | null; signal: string | null };

export type BrokerFrame =
  | { t: "claim_wait"; ms: number }
  | { t: "claim_ok" }
  | { t: "to_cli"; m: Record<string, unknown> };

export function linkSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CCRC_LINK_SOCKET) return env.CCRC_LINK_SOCKET;
  const uid = process.getuid?.() ?? 0;
  const userRun = `/run/user/${uid}`;
  const runtime = env.XDG_RUNTIME_DIR || (fs.existsSync(userRun) ? userRun : path.join(os.tmpdir(), `ccrc-${uid}`));
  return path.join(runtime, "ccrc", "link.sock");
}
