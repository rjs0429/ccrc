import type { DisplayItem } from "../../../broker/src/protocol.ts";

export type UserMessage = Extract<DisplayItem, { kind: "user" }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Claude Code names a message it keeps by its uuid; only such a message can be forked from or rewound to.
export const actionable = (m: UserMessage): boolean => UUID.test(m.id);

// The latest turn the phone shows the user starting, by a message or a command; Claude Code refuses to rewind a
// conversation with a later one.
export function lastSeen(items: DisplayItem[]): string | undefined {
  return items.findLast((i) => (i.kind === "user" || (i.kind === "note" && i.code === "command")) && UUID.test(i.id))?.id;
}

// A message's first line, for a list or a sheet's title.
export function excerpt(m: UserMessage, max = 80): string {
  const images = m.attachments?.filter((a) => a.kind === "image").length ?? 0;
  const docs = m.attachments?.filter((a) => a.kind === "document").map((a) => a.name || "문서") ?? [];
  const line = m.text.split("\n").find((l) => l.trim())?.trim() || (images ? `이미지 ${images}개` : docs.join(", ")) || "(내용 없음)";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
