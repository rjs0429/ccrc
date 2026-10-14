import fs from "node:fs";
import type { Thread, ThreadMessage } from "../search-protocol.ts";
import { rowMessages } from "./search.ts";

const BEFORE = 20;
const AFTER = 40;
const MESSAGE_CHARS = 8000;
const ID_MAX = 128;

interface Node {
  line: number;
  parent?: string;
  // The last line written below this row, which tells the branch that went on longest.
  last: number;
  children: string[];
}

// The user and assistant text around one message of a transcript, along that message's own branch: up to its
// earlier messages and on to the branch's latest row. `shared` marks messages the current conversation also holds,
// so a branch left by a rewind shows where it split off.
export async function threadAround(file: string, itemId: string, current: Set<string>): Promise<Thread | undefined> {
  if (!itemId || itemId.length > ID_MAX) return undefined;
  const lines = (await fs.promises.readFile(file, "utf8")).split("\n");
  const nodes = new Map<string, Node>();
  const queued = new Map<string, string>();
  const order: string[] = [];
  lines.forEach((text, line) => {
    if (!text.includes('"parentUuid"')) return;
    try {
      const e = JSON.parse(text) as { uuid?: unknown; parentUuid?: unknown; attachment?: { type?: unknown; source_uuid?: unknown } };
      if (typeof e.uuid !== "string" || nodes.has(e.uuid)) return;
      nodes.set(e.uuid, { line, parent: typeof e.parentUuid === "string" ? e.parentUuid : undefined, last: line, children: [] });
      order.push(e.uuid);
      if (e.attachment?.type === "queued_command" && typeof e.attachment.source_uuid === "string") queued.set(e.attachment.source_uuid, e.uuid);
    } catch {}
  });
  for (const id of order) {
    const p = nodes.get(id)!.parent;
    nodes.get(p ?? "")?.children.push(id);
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const n = nodes.get(order[i])!;
    const p = nodes.get(n.parent ?? "");
    if (p && p.last < n.last) p.last = n.last;
  }
  const rowId = itemId.replace(/:\d+$/, "");
  const hit = nodes.has(rowId) ? rowId : queued.get(itemId);
  if (!hit) return undefined;

  const messagesOf = (id: string): ThreadMessage[] => {
    const n = nodes.get(id)!;
    try {
      const shared = current.has(id) ? { shared: true } : {};
      return rowMessages(JSON.parse(lines[n.line]), MESSAGE_CHARS).map((m) => ({ ...m, ...shared }));
    } catch {
      return [];
    }
  };
  const before: ThreadMessage[] = [];
  const seen = new Set<string>([hit]);
  for (let id = nodes.get(hit)!.parent; id && nodes.has(id) && !seen.has(id) && before.length < BEFORE; id = nodes.get(id)!.parent) {
    seen.add(id);
    before.unshift(...messagesOf(id));
  }
  const at = messagesOf(hit);
  const after: ThreadMessage[] = [];
  for (let n = nodes.get(hit)!; n.children.length && after.length < AFTER; ) {
    const next = n.children.reduce((a, b) => (nodes.get(b)!.last > nodes.get(a)!.last ? b : a));
    if (seen.has(next)) break;
    seen.add(next);
    after.push(...messagesOf(next));
    n = nodes.get(next)!;
  }
  const focus = at.find((m) => m.id === itemId)?.id ?? at[0]?.id;
  if (!focus) return undefined;
  return { messages: [...before.slice(-BEFORE), ...at, ...after.slice(0, AFTER)], focus, rewound: !current.has(hit) };
}
