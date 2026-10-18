import type { DisplayItem } from "../../broker/src/protocol.ts";

// What the phone keeps of the conversations it showed, to read while the broker cannot be reached: the end of the last
// few, their words only. Tool input and output, diffs, command output and thinking stay on the laptop, as do pictures.
export const COPY_SESSIONS = 5;
export const COPY_ITEMS = 80;
export const COPY_CHARS = 160 * 1024;
// The login's idle time when the broker does not say (its default).
export const COPY_IDLE_MINUTES = 720;
const TEXT_MAX = 20_000;
const MESSAGE_MAX = 4000;
// Calls whose input is what was said: a question, a plan, files sent with their caption.
const SAID = new Set(["AskUserQuestion", "ExitPlanMode", "SendUserFile"]);

export interface SavedChat {
  sessionId: string;
  title: string;
  cwd: string;
  branch?: string;
  savedAt: number;
  items: DisplayItem[];
  // The conversation goes on before the first item kept.
  cut: boolean;
}

// Until when the copy may show: as long as the login would last without activity. stamp: when the login's password was
// set, so a change made anywhere drops what was kept before it.
export interface CopyLogin {
  until: number;
  stamp?: string;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

export function keptItem(item: DisplayItem): DisplayItem | undefined {
  switch (item.kind) {
    case "thinking":
      return undefined;
    case "user":
    case "assistant":
      return { ...item, text: clip(item.text, TEXT_MAX) };
    case "message":
      return { ...item, text: clip(item.text, MESSAGE_MAX) };
    case "tool": {
      const { kind, id, ts, name, summary, file, reply, sent, sentCut, by, result, sub } = item;
      return {
        kind,
        id,
        ...(ts ? { ts } : {}),
        name,
        summary,
        input: SAID.has(name) ? item.input : null,
        ...(result ? { result: { text: "", isError: result.isError, truncated: false } } : {}),
        ...(file ? { file } : {}),
        ...(sub ? { sub: { tools: sub.tools, recent: [], ...(sub.ended ? { ended: sub.ended } : {}) } } : {}),
        ...(reply ? { reply } : {}),
        ...(sent ? { sent } : {}),
        ...(sentCut ? { sentCut } : {}),
        ...(by ? { by } : {}),
      };
    }
    case "command": {
      const { kind, id, ts, name, args } = item;
      return { kind, id, ...(ts ? { ts } : {}), ...(name ? { name } : {}), ...(args ? { args } : {}), text: "" };
    }
    case "shell": {
      const { kind, id, ts, command } = item;
      return { kind, id, ...(ts ? { ts } : {}), command };
    }
    case "task": {
      const { kind, id, ts, status, summary } = item;
      return { kind, id, ...(ts ? { ts } : {}), ...(status ? { status } : {}), summary };
    }
    case "note":
      return item.text ? { ...item, text: clip(item.text, TEXT_MAX) } : item;
  }
}

// The end of a conversation as the copy keeps it, from the latest part when a gap splits what the phone holds
// (gapBefore: the first item after the gap).
export function copied(items: DisplayItem[], o: { hasMore: boolean; gapBefore?: string }): { items: DisplayItem[]; cut: boolean } {
  const start = o.gapBefore ? Math.max(0, items.findIndex((i) => i.id === o.gapBefore)) : 0;
  const out: DisplayItem[] = [];
  let size = 0;
  let at = items.length;
  for (; at > start && out.length < COPY_ITEMS; at--) {
    const item = keptItem(items[at - 1]);
    if (!item) continue;
    const n = JSON.stringify(item).length;
    if (out.length && size + n > COPY_CHARS) break;
    size += n;
    out.push(item);
  }
  const cut = o.hasMore || start > 0 || items.slice(start, at).some((i) => i.kind !== "thinking");
  return { items: out.reverse(), cut };
}

export function usable(login: CopyLogin | undefined, now = Date.now()): boolean {
  return Boolean(login && now < login.until);
}

// The password was set again since the copy was kept.
export function passwordChanged(login: CopyLogin | undefined, stamp: string | undefined): boolean {
  return Boolean(login?.stamp && stamp && login.stamp !== stamp);
}

// The broker moves a login's last activity at most once a minute, so the login may end up to a minute before its idle
// time counted from the phone's last contact.
const LAST_SEEN_STEP_MS = 60_000;

export function untilAfter(contact: number, idleMinutes = COPY_IDLE_MINUTES): number {
  return contact + idleMinutes * 60_000 - LAST_SEEN_STEP_MS;
}

// When the broker last took in something the phone sent, which is what it counts the login's idle time from: a request
// from when it was made, once answered; what went on the socket, and the socket's opening, once the broker's next
// message shows that the connection carried it. The broker's own messages say nothing of the phone's activity.
export class Contact {
  at = 0;
  private unheard = 0;

  // Whether the contact moved.
  answered(madeAt: number): boolean {
    if (madeAt <= this.at) return false;
    this.at = madeAt;
    return true;
  }

  sent(at: number): void {
    this.unheard = at;
  }

  heard(): boolean {
    const sent = this.unheard;
    this.unheard = 0;
    return sent ? this.answered(sent) : false;
  }

  // The socket closed: what it did not answer may not have arrived.
  lost(): void {
    this.unheard = 0;
  }

  reset(): void {
    this.at = 0;
    this.unheard = 0;
  }
}
