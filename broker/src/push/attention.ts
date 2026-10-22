import type { PendingKind } from "../protocol.ts";
import type { PushAttention } from "./types.ts";

// A session's notification is tagged `<session>:<kind>`. A notice of what went on in the session (its turn's end,
// Claude's own notification, files sent, a copy's first message) counts while the session is unread; a request while
// one waits for an answer. web/public/sw.js keeps a copy of these kinds and of settled().
export type NoticeKind = "end" | "claude" | "file" | "copy";
const NOTICES: Record<NoticeKind, true> = { end: true, claude: true, file: true, copy: true };
const REQUESTS: Record<PendingKind, true> = { permission: true, question: true, plan: true, dialog: true, elicitation: true };
export const NOTICE_KINDS = Object.keys(NOTICES) as NoticeKind[];
export const REQUEST_KINDS = Object.keys(REQUESTS) as PendingKind[];

export function sessionTag(sessionId: string, kind: NoticeKind | PendingKind): string {
  return `${sessionId}:${kind}`;
}

export interface ShownNotification {
  tag: string;
  data?: unknown;
}

// When the broker made the notification, on its clock; one that does not say counts as older than any.
function madeAt(n: ShownNotification): number {
  const at = n.data !== null && typeof n.data === "object" ? (n.data as { at?: unknown }).at : undefined;
  return typeof at === "number" ? at : 0;
}

// Whether a notification on the phone no longer counts: a newer one of its tag is there, or, by a state taken after it
// was made, the phone shows its session (viewing) or the state no longer counts the session for its kind. Others, and
// kinds this does not know, stay.
export function settled(n: ShownNotification, list: readonly ShownNotification[], state?: PushAttention, viewing?: string): boolean {
  if (n.tag && list.some((m) => m.tag === n.tag && madeAt(m) > madeAt(n))) return true;
  if (!state || madeAt(n) >= state.at) return false;
  const i = n.tag.indexOf(":");
  if (i < 1) return false;
  const session = n.tag.slice(0, i);
  const kind = n.tag.slice(i + 1);
  if (session === viewing) return true;
  if (Object.hasOwn(NOTICES, kind)) return !state.unseen.includes(session);
  if (Object.hasOwn(REQUESTS, kind)) return !state.waiting.includes(session);
  return false;
}
