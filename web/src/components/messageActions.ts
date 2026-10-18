import type { DisplayItem, RewindResult } from "../../../broker/src/protocol.ts";
import { errorText } from "../labels.ts";

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

// Why a rewind left the files as they were, without the words a sentence about it already says.
export const filesError = (r: RewindResult): string => errorText((r.error ?? "").replace(/^Failed to rewind: /, ""));

// What a rewind did to the files, for the end of a sentence or as one. Claude Code counts every tracked file it left as a
// link, changed or not, so with links left the preview's count is not told.
export function filesDone(r: RewindResult, previewed: number): string {
  return r.skippedLinks ? ` · 링크라서 건너뛴 파일 ${r.skippedLinks}개` : ` · 파일 ${previewed}개`;
}

export function filesBack(r: RewindResult, previewed: number): string {
  return r.skippedLinks ? `파일을 되돌렸습니다 · 링크라서 건너뛴 파일 ${r.skippedLinks}개` : `파일 ${previewed}개를 되돌렸습니다`;
}

// Why one of a message's files was not attached again: the broker's reasons, "too_many" past the composer's limit, or
// "failed" when the broker could not be asked.
export type ReattachFailure = "gone" | "unreadable" | "too_large" | "too_many" | "failed";

const NOT_ATTACHED: Record<ReattachFailure, string> = { gone: "기록에 없음", unreadable: "붙일 수 없는 형식", too_large: "너무 큼", too_many: "10개 넘음", failed: "가져오지 못함" };

// What of a message's files could not be attached again, in one line; nothing when all were.
export function reattachNote(failed: ReattachFailure[]): string | undefined {
  if (!failed.length) return undefined;
  const counts = new Map<ReattachFailure, number>();
  for (const f of failed) counts.set(f, (counts.get(f) ?? 0) + 1);
  const why = [...counts].map(([f, n]) => (counts.size > 1 ? `${NOT_ATTACHED[f]} ${n}개` : NOT_ATTACHED[f])).join(", ");
  return `첨부 ${failed.length}개는 다시 붙이지 못했습니다 (${why})`;
}
