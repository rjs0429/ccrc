import type { AgentTranscript, DisplayItem, TranscriptAfter } from "../../../../broker/src/protocol.ts";

// The broker looks at no more of the held items still waiting for a result than this.
const OPEN_MAX = 100;

// What the phone holds of a subagent's transcript: items from `from` on, out of `total`.
export interface Held {
  agentId: string;
  items: DisplayItem[];
  from: number;
  total: number;
  promptId?: string;
  agentType?: string;
  description?: string;
  missing?: boolean;
}

export function held(r: AgentTranscript): Held {
  const { agentId, items, from, total, promptId, agentType, description, missing } = r;
  return { agentId, items, from, total, ...(promptId ? { promptId } : {}), ...(agentType ? { agentType } : {}), ...(description ? { description } : {}), ...(missing ? { missing } : {}) };
}

// What the broker needs to send only what came since: where the held items end, and the calls still without a result.
export function afterOf(h: Held): TranscriptAfter {
  const last = h.items.at(-1);
  if (!last) return { count: 0, lastId: "" };
  const open = h.items.flatMap((i) => (i.kind === "tool" && !i.result ? [i.id] : [])).slice(-OPEN_MAX);
  return { count: h.from + h.items.length, lastId: last.id, ...(open.length ? { open } : {}) };
}

// The held items after an answer to `afterOf`: new items at the end, the ones another answer brought already left out,
// and changed ones in place; or the latest page when the broker found the held items no longer line up.
export function followed(h: Held, r: AgentTranscript): Held {
  const end = h.from + h.items.length;
  if (r.reset || r.missing || r.from < h.from || r.from > end) return held(r);
  const changed = new Map((r.changed ?? []).map((i) => [i.id, i]));
  const items = changed.size ? h.items.map((i) => changed.get(i.id) ?? i) : h.items;
  const fresh = r.items.slice(end - r.from);
  return { ...held(r), items: fresh.length ? [...items, ...fresh] : items, from: h.from };
}

// The held items with the page before them in front; a page that does not end where they start changes nothing.
export function prepended(h: Held, r: AgentTranscript): Held {
  if (r.from + r.items.length !== h.from) return h;
  return { ...h, items: [...r.items, ...h.items], from: r.from, total: r.total };
}
