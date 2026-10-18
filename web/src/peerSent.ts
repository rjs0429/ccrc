import { INBOX_SENDER, type DisplayItem } from "../../broker/src/protocol.ts";

// Claude Code escapes a tag in a passed-on message that could end or fake a frame with a backslash after its "<", and
// the transcript cuts a long message; text sent from here matches its message without those marks.
const unmarked = (text: string) => text.replace(/<\\/g, "<").trim();

export function sameText(shown: string, sent: string): boolean {
  const a = unmarked(shown);
  const b = unmarked(sent);
  return a === b || (a.endsWith("…") && b.startsWith(a.slice(0, -1)));
}

// How many messages from this phone with the text the conversation shows.
export function sentCount(items: DisplayItem[], text: string): number {
  return items.filter((i) => i.kind === "message" && i.from === "session" && i.name === INBOX_SENDER && sameText(i.text, text)).length;
}
