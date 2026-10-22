import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { isPrivateDir } from "../link/protocol.ts";
import type { Lang } from "../lang.ts";
import { INBOX_SENDER, type InboxInfo } from "../protocol.ts";

// The line format of a session's inbox socket (cross-session messaging) that its registry file names peerProtocol 1.
// Claude takes such a message as one from another session, never from the user.
export const INBOX_PROTOCOL = 1;
const TAG = "cross-session-message";
const SEND_MS = 5000;
const TAIL_BYTES = 256 * 1024;
const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;
// A closing tag in the body gets the escape Claude Code gives one, so the body cannot end the message early.
const CLOSING = /<(?!\\)(?=[^A-Za-z0-9_\-<>/]*\/[^A-Za-z0-9_\-<>]*cross[-_]session[-_]message(?:[^A-Za-z0-9_-]|$))/giu;
const LADDER = ["accept", "hold", "refuse"] as const;
type Inbound = (typeof LADDER)[number];

// One message as Claude Code's own sessions send it, without a reply address. Claude Code drops it when its process
// runs another conversation than session_id by then.
export function inboxLine(sessionId: string, text: string, id: string = randomUUID(), lang: Lang = "ko"): string {
  const content = `<${TAG} from-name="${INBOX_SENDER[lang]}" from-mode="prompting">\n${text.replace(CLOSING, "<\\")}\n</${TAG}>`;
  return JSON.stringify({ msgV: INBOX_PROTOCOL, msg_id: id, type: "user", session_id: sessionId, message: { role: "user", content }, priority: "next" });
}

// The peer token in <pid>.<hash>.key beside the registry file, for the process that started at procStart.
export function inboxToken(dir: string, pid: number, procStart: string): string | undefined {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.startsWith(`${pid}.`) && n.endsWith(".key"));
  } catch {}
  for (const name of names) {
    try {
      const k = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as { peerToken?: unknown; procStart?: unknown };
      if (String(k.procStart) === procStart && typeof k.peerToken === "string" && TOKEN.test(k.peerToken)) return k.peerToken;
    } catch {}
  }
  return undefined;
}

// A socket of this user's in a folder closed to everyone else, as Claude Code makes them.
export function usableSocket(file: string): boolean {
  if (!path.isAbsolute(file) || !file.endsWith(".sock") || Buffer.byteLength(file) > 103) return false;
  try {
    const st = fs.lstatSync(file);
    return st.isSocket() && st.uid === process.getuid?.() && isPrivateDir(path.dirname(file));
  } catch {
    return false;
  }
}

// Done once Claude Code has read the lines and closed its end.
export function postToInbox(socket: string, lines: string[], ms = SEND_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection({ path: socket });
    let done = false;
    const finish = (e?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      conn.destroy();
      if (e) reject(e);
      else resolve();
    };
    const timer = setTimeout(() => finish(Error("inbox did not answer")), ms);
    conn.on("connect", () => conn.end(lines.map((l) => `${l}\n`).join("")));
    conn.on("error", (e) => finish(e));
    conn.on("close", () => finish());
    conn.resume();
  });
}

// The permission mode the transcript last recorded with a message.
export async function lastPermissionMode(file: string): Promise<string | undefined> {
  try {
    const fh = await fs.promises.open(file, "r");
    try {
      const { size } = await fh.stat();
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      return [...buf.toString("utf8").matchAll(/"permissionMode":"([A-Za-z]+)"/g)].pop()?.[1];
    } finally {
      await fh.close();
    }
  } catch {
    return undefined;
  }
}

function inboundOf(file: string): Inbound | undefined {
  try {
    const v = (JSON.parse(fs.readFileSync(file, "utf8")) as { crossSessionInbound?: unknown }).crossSessionInbound;
    return LADDER.includes(v as Inbound) ? (v as Inbound) : undefined;
  } catch {
    return undefined;
  }
}

// crossSessionInbound from the user's settings, or a stricter value from the project's; Claude Code ignores a
// project value that is not stricter, so only the user's own accept counts.
export function inboundSetting(userFile: string, cwd: string): Inbound | undefined {
  const user = inboundOf(userFile);
  const project = [path.join(cwd, ".claude", "settings.json"), path.join(cwd, ".claude", "settings.local.json")].map(inboundOf);
  const all = [user, ...project].filter((v): v is Inbound => v !== undefined);
  if (all.includes("refuse")) return "refuse";
  if (all.includes("hold")) return "hold";
  return user;
}

// Without a setting Claude Code holds a message to a session that skips permission prompts: its terminal screen, in a
// terminal or a background session, asks there; anywhere else drops it unless the mode changes before the dialog deadline.
export function inboxInfo(host: string | undefined, mode: string | undefined, setting: Inbound | undefined): InboxInfo {
  if (setting === "refuse") return { gate: "refused" };
  if (setting === "hold") return { gate: "held", why: "setting" };
  if (setting === "accept" || mode !== "bypassPermissions") return { gate: "deliver" };
  return host === "Terminal" || host === "Background" ? { gate: "approve" } : { gate: "held", why: "mode" };
}
