import { INBOX_SENDER, type DisplayItem, type QueuedMessage } from "../../broker/src/protocol.ts";

// Claude Code escapes a tag in a passed-on message that could end or fake a frame with a backslash after its "<", and
// the transcript cuts a long message; text sent from here matches its message without those marks.
const unmarked = (text: string) => text.replace(/<\\/g, "<").trim();

export function sameText(shown: string, sent: string): boolean {
  const a = unmarked(shown);
  const b = unmarked(sent);
  return a === b || (a.endsWith("…") && b.startsWith(a.slice(0, -1)));
}

// Text sent from here to a session open elsewhere. msgId: its message's id, once the broker has passed it on; since:
// the time of the newest item the conversation had then; shown: the item of its message, once one came.
export interface PeerSent extends QueuedMessage {
  msgId?: string;
  since?: number;
  shown?: string;
}

const time = (i: DisplayItem) => (i.ts ? Date.parse(i.ts) : NaN);

// The time of the newest item, which a message sent now comes after.
export function newest(items: DisplayItem[]): number | undefined {
  let at: number | undefined;
  for (const i of items) {
    const t = time(i);
    if (t > (at ?? -Infinity)) at = t;
  }
  return at;
}

// A message from here is the sent text with its id; one the transcript kept without an id, a text like it sent before
// the message came.
function shows(i: DisplayItem, q: PeerSent): boolean {
  if (i.kind !== "message" || i.from !== "session" || i.name !== INBOX_SENDER) return false;
  if (i.msgId) return i.msgId === q.msgId;
  return sameText(i.text, q.text) && (q.since === undefined || time(i) > q.since);
}

// Gives each sent text the message that shows it, whatever part of the conversation is loaded: a message shows one
// text, the earliest it can, and a text stays shown. The same list when nothing changes.
export function markShown(sent: PeerSent[], items: DisplayItem[]): PeerSent[] {
  const used = new Set(sent.flatMap((q) => (q.shown ? [q.shown] : [])));
  let changed = false;
  const next = sent.map((q) => {
    const hit = q.shown ? undefined : items.find((i) => !used.has(i.id) && shows(i, q));
    if (!hit) return q;
    used.add(hit.id);
    changed = true;
    return { ...q, shown: hit.id };
  });
  return changed ? next : sent;
}
