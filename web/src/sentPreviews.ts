import type { DisplayItem } from "../../broker/src/protocol.ts";

// The images of a message sent from here, as object URLs in attachment order (none for a document),
// shown on its item until the broker's copy takes over.
interface Waiting {
  sessionId: string;
  text: string;
  urls: (string | undefined)[];
  at: number;
}

const WAIT_MS = 120_000;
const KEEP_URLS = 20;
const waiting: Waiting[] = [];
const bound = new Map<string, (string | undefined)[]>();

const revoke = (urls: (string | undefined)[]) => urls.forEach((u) => u && URL.revokeObjectURL(u));

function prune(now: number): void {
  for (let i = waiting.length - 1; i >= 0; i--) if (now - waiting[i].at > WAIT_MS) revoke(waiting.splice(i, 1)[0].urls);
  let kept = [...bound.values()].reduce((n, urls) => n + urls.filter(Boolean).length, 0);
  for (const [id, urls] of bound) {
    if (kept <= KEEP_URLS) break;
    bound.delete(id);
    revoke(urls);
    kept -= urls.filter(Boolean).length;
  }
}

export function rememberSent(sessionId: string, text: string, urls: (string | undefined)[]): void {
  if (!urls.some(Boolean)) return;
  waiting.push({ sessionId, text, urls, at: Date.now() });
  prune(Date.now());
}

// The item for a sent message arrives with the text and attachments it was sent with.
export function bindSent(sessionId: string, item: DisplayItem): void {
  if (!waiting.length || item.kind !== "user" || !item.attachments || bound.has(item.id)) return;
  const n = item.attachments.length;
  const at = waiting.findIndex((w) => w.sessionId === sessionId && w.text === item.text && w.urls.length === n);
  if (at < 0) return;
  bound.set(item.id, waiting.splice(at, 1)[0].urls);
  prune(Date.now());
}

export function sentPreview(itemId: string, index: number): string | undefined {
  return bound.get(itemId)?.[index];
}
