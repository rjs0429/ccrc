import { useSyncExternalStore } from "react";
import type { SideAnswer, SideTurn } from "../../broker/src/protocol.ts";
import { errorText } from "./labels.ts";
import { call, type CallProgress } from "./state.ts";

// A session's side questions as VS Code keeps them, the latest KEEP in this tab's sessionStorage only: answered, answered
// by Claude Code's notice in place of an answer, left without one, failed, or given up.
export type SideEntry =
  | { kind: "answer"; question: string; text: string; notice?: string; at: number }
  | { kind: "notice"; question: string; text: string; at: number }
  | { kind: "none"; question: string; at: number }
  | { kind: "error"; question: string; text: string; at: number }
  | { kind: "cancelled"; question: string; at: number };

// The question being asked: the session starting first ("starting"), sent, taken up by Claude Code, or waiting to retry
// the API.
export interface SidePending {
  question: string;
  since: number;
  status: "starting" | "sent" | "started" | "retry";
  attempt?: number;
  maxRetries?: number;
}

export interface SideThread {
  entries: SideEntry[];
  pending?: SidePending;
}

const KEEP = 20;
// The broker gives up after five minutes, as VS Code does; the phone waits a little longer for its word.
const ANSWER_WAIT_MS = 5 * 60_000 + 30_000;
const START_WAIT_MS = 60_000;
const KINDS = new Set<unknown>(["answer", "notice", "none", "error", "cancelled"]);

const key = (sessionId: string) => `ccrc.btw.${sessionId}`;
const threads = new Map<string, SideThread>();
const given = new Set<string>();
const listeners = new Set<() => void>();

function load(sessionId: string): SideEntry[] {
  try {
    const v: unknown = JSON.parse(sessionStorage.getItem(key(sessionId)) ?? "[]");
    return Array.isArray(v) ? v.filter((e): e is SideEntry => e !== null && typeof e === "object" && KINDS.has(e.kind) && typeof e.question === "string").slice(-KEEP) : [];
  } catch {
    return [];
  }
}

function thread(sessionId: string): SideThread {
  let t = threads.get(sessionId);
  if (!t) {
    t = { entries: load(sessionId) };
    threads.set(sessionId, t);
  }
  return t;
}

function update(sessionId: string, patch: Partial<SideThread>): void {
  const t = { ...thread(sessionId), ...patch };
  threads.set(sessionId, t);
  if ("entries" in patch) {
    try {
      if (t.entries.length) sessionStorage.setItem(key(sessionId), JSON.stringify(t.entries));
      else sessionStorage.removeItem(key(sessionId));
    } catch {}
  }
  for (const l of listeners) l();
}

function add(sessionId: string, entry: SideEntry): void {
  update(sessionId, { entries: [...thread(sessionId).entries, entry].slice(-KEEP), pending: undefined });
}

export function useSideThread(sessionId: string): SideThread {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => thread(sessionId),
  );
}

// The answered questions a follow-up is asked with.
function history(entries: SideEntry[]): SideTurn[] {
  return entries.flatMap((e) => (e.kind === "answer" ? [{ question: e.question, answer: e.text, ...(e.notice ? { notice: e.notice } : {}) }] : []));
}

function ended(question: string, a: SideAnswer): SideEntry {
  const at = Date.now();
  if (a.answer === null) return { kind: "none", question, at };
  if (a.synthetic) return { kind: "notice", question, text: a.answer, at };
  return { kind: "answer", question, text: a.answer, ...(a.notice ? { notice: a.notice } : {}), at };
}

// Asks a side question of the session; `start` first starts a session that has no process, which sends nothing to it.
export async function askSide(sessionId: string, question: string, start = false): Promise<void> {
  const t = thread(sessionId);
  if (t.pending) return;
  const asked = history(t.entries);
  update(sessionId, { pending: { question, since: Date.now(), status: start ? "starting" : "sent" } });
  given.delete(sessionId);
  const progress = (p: CallProgress) => {
    const now = thread(sessionId).pending;
    if (now) update(sessionId, { pending: { ...now, status: p.status, attempt: p.attempt, maxRetries: p.maxRetries } });
  };
  try {
    if (start) await call(sessionId, "resume", {}, START_WAIT_MS);
    if (given.has(sessionId)) throw Error("side question cancelled");
    const pending = thread(sessionId).pending;
    if (pending) update(sessionId, { pending: { ...pending, status: "sent" } });
    add(sessionId, ended(question, await call(sessionId, "side_question", { question, history: asked }, ANSWER_WAIT_MS, progress)));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const at = Date.now();
    add(sessionId, message === "side question cancelled" ? { kind: "cancelled", question, at } : { kind: "error", question, text: errorText(message), at });
  }
}

// Gives up the question being asked; one still waiting for its session to start is not sent.
export function cancelSide(sessionId: string): void {
  const pending = thread(sessionId).pending;
  if (!pending) return;
  given.add(sessionId);
  if (pending.status !== "starting") call(sessionId, "side_question_cancel").catch(() => {});
}

export function clearSide(sessionId: string): void {
  if (!thread(sessionId).pending) update(sessionId, { entries: [] });
}
