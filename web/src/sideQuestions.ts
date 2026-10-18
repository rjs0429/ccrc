import { useSyncExternalStore } from "react";
import { SIDE_THREAD_BYTES, type SideAnswer, type SideTurn } from "../../broker/src/protocol.ts";
import { errorText } from "./labels.ts";
import { call, getState, onConnected, type CallProgress } from "./state.ts";

// A session's side questions as VS Code keeps them, the latest KEEP in this tab's sessionStorage only: answered, answered
// by Claude Code's notice in place of an answer, left without one, failed, or given up. busy: refused while an earlier
// question, whose answer does not come here, was still being answered.
export type SideEntry =
  | { kind: "answer"; question: string; text: string; notice?: string; at: number }
  | { kind: "notice"; question: string; text: string; at: number }
  | { kind: "none"; question: string; at: number }
  | { kind: "error"; question: string; text: string; at: number; busy?: boolean }
  | { kind: "cancelled"; question: string; at: number };

// The question being asked: the session starting first ("starting"), sent, taken up by Claude Code, waiting to retry
// the API, or asked before the connection dropped and waited for again once it is back ("offline"). ask: the id the
// broker knows it by.
export interface SidePending {
  question: string;
  since: number;
  status: "starting" | "sent" | "started" | "retry" | "offline";
  attempt?: number;
  maxRetries?: number;
  ask: string;
}

export interface SideThread {
  entries: SideEntry[];
  pending?: SidePending;
}

const KEEP = 20;
// The broker gives up after five minutes, as VS Code does; the phone waits a little longer for its word.
const ANSWER_WAIT_MS = 5 * 60_000 + 30_000;
const START_WAIT_MS = 60_000;
// Waiting again for a question that has ended gets how it ended at once.
const WAIT_AGAIN_MIN_MS = 15_000;
const KINDS = new Set<unknown>(["answer", "notice", "none", "error", "cancelled"]);

const key = (sessionId: string) => `ccrc.btw.${sessionId}`;
// The question waited for, so that a page loaded again waits for it again.
const askingKey = (sessionId: string) => `ccrc.btw.${sessionId}.asking`;
const ASKING_KEY = /^ccrc\.btw\.(.+)\.asking$/;
const threads = new Map<string, SideThread>();
const given = new Set<string>();
const listeners = new Set<() => void>();
const utf8 = new TextEncoder();

function load(sessionId: string): SideEntry[] {
  try {
    const v: unknown = JSON.parse(sessionStorage.getItem(key(sessionId)) ?? "[]");
    return Array.isArray(v) ? v.filter((e): e is SideEntry => e !== null && typeof e === "object" && KINDS.has(e.kind) && typeof e.question === "string").slice(-KEEP) : [];
  } catch {
    return [];
  }
}

function loadAsking(sessionId: string): SidePending | undefined {
  try {
    const v = JSON.parse(sessionStorage.getItem(askingKey(sessionId)) ?? "null") as Partial<SidePending> | null;
    return v && typeof v.question === "string" && typeof v.ask === "string" && typeof v.since === "number" ? { question: v.question, since: v.since, ask: v.ask, status: "offline" } : undefined;
  } catch {
    return undefined;
  }
}

function thread(sessionId: string): SideThread {
  let t = threads.get(sessionId);
  if (!t) {
    const pending = loadAsking(sessionId);
    t = { entries: load(sessionId), ...(pending ? { pending } : {}) };
    threads.set(sessionId, t);
    if (pending) setTimeout(() => void waitAgain(sessionId), 0);
  }
  return t;
}

function update(sessionId: string, patch: Partial<SideThread>): void {
  const t = { ...thread(sessionId), ...patch };
  threads.set(sessionId, t);
  try {
    if ("entries" in patch) {
      if (t.entries.length) sessionStorage.setItem(key(sessionId), JSON.stringify(t.entries));
      else sessionStorage.removeItem(key(sessionId));
    }
    if ("pending" in patch) {
      const p = t.pending;
      if (p && p.status !== "starting") sessionStorage.setItem(askingKey(sessionId), JSON.stringify({ question: p.question, since: p.since, ask: p.ask }));
      else sessionStorage.removeItem(askingKey(sessionId));
    }
  } catch {}
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

const bytes = (v: unknown) => utf8.encode(JSON.stringify(v)).length;

// The turn with as much of its answer as lets it take at most `room` bytes as JSON; undefined when none of it would.
function shortened(t: SideTurn, room: number): SideTurn | undefined {
  const upTo = (n: number): SideTurn => ({ ...t, answer: `${t.answer.slice(0, n).replace(/[\uD800-\uDBFF]$/, "")}…` });
  let [lo, hi] = [0, t.answer.length - 1];
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (bytes(upTo(mid)) <= room) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 && bytes(upTo(lo)) <= room ? upTo(lo) : undefined;
}

// The answered questions a follow-up is asked with: the latest that fit SIDE_THREAD_BYTES as JSON, the earliest of them
// with its answer cut short where it would not fit whole.
function history(entries: SideEntry[]): SideTurn[] {
  const turns = entries.flatMap((e): SideTurn[] => (e.kind === "answer" ? [{ question: e.question, answer: e.text, ...(e.notice ? { notice: e.notice } : {}) }] : []));
  const kept: SideTurn[] = [];
  let room = SIDE_THREAD_BYTES - 2;
  for (const t of turns.reverse()) {
    const size = bytes(t) + 1;
    if (size <= room) {
      kept.unshift(t);
      room -= size;
      continue;
    }
    const cut = shortened(t, room - 1);
    if (cut) kept.unshift(cut);
    break;
  }
  return kept;
}

function ended(question: string, a: SideAnswer): SideEntry {
  const at = Date.now();
  if (a.answer === null) return { kind: "none", question, at };
  if (a.synthetic) return { kind: "notice", question, text: a.answer, at };
  return { kind: "answer", question, text: a.answer, ...(a.notice ? { notice: a.notice } : {}), at };
}

const newAsk = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

// The question being asked, when it is still the one asked with `ask`.
function asking(sessionId: string, ask: string): SidePending | undefined {
  const p = thread(sessionId).pending;
  return p?.ask === ask ? p : undefined;
}

function patch(sessionId: string, ask: string, change: Partial<SidePending>): void {
  const p = asking(sessionId, ask);
  if (p) update(sessionId, { pending: { ...p, ...change } });
}

const heard = (sessionId: string, ask: string) => (p: CallProgress) => patch(sessionId, ask, { status: p.status, attempt: p.attempt, maxRetries: p.maxRetries });

function answered(sessionId: string, ask: string, a: SideAnswer): void {
  const p = asking(sessionId, ask);
  if (p) add(sessionId, ended(p.question, a));
}

// sent: the question had gone to the broker, which still answers it after the connection drops; it is waited for again
// once the connection is back.
function failed(sessionId: string, ask: string, e: unknown, sent: boolean): void {
  const p = asking(sessionId, ask);
  if (!p) return;
  const message = e instanceof Error ? e.message : String(e);
  if (message === "not connected" && sent) {
    update(sessionId, { pending: { question: p.question, since: p.since, ask, status: "offline" } });
    return;
  }
  const at = Date.now();
  if (message === "side question cancelled") add(sessionId, { kind: "cancelled", question: p.question, at });
  else add(sessionId, { kind: "error", question: p.question, text: errorText(message), at, ...(message === "a side question is under way" ? { busy: true } : {}) });
}

// Asks a side question of the session; `start` first starts a session that has no process, which sends nothing to it.
export async function askSide(sessionId: string, question: string, start = false): Promise<void> {
  const t = thread(sessionId);
  if (t.pending) return;
  const asked = history(t.entries);
  const ask = newAsk();
  update(sessionId, { pending: { question, since: Date.now(), status: start ? "starting" : "sent", ask } });
  given.delete(sessionId);
  let sent = false;
  try {
    if (start) await call(sessionId, "resume", {}, START_WAIT_MS);
    if (given.has(sessionId)) throw Error("side question cancelled");
    patch(sessionId, ask, { status: "sent" });
    sent = getState().conn === "ready";
    answered(sessionId, ask, await call(sessionId, "side_question", { question, history: asked, ask }, ANSWER_WAIT_MS, heard(sessionId, ask)));
  } catch (e) {
    failed(sessionId, ask, e, sent);
  }
}

// Waits again for a question asked before the connection dropped, once the connection is back.
async function waitAgain(sessionId: string): Promise<void> {
  const p = thread(sessionId).pending;
  if (p?.status !== "offline" || getState().conn !== "ready") return;
  const { ask } = p;
  patch(sessionId, ask, { status: "started" });
  try {
    answered(sessionId, ask, await call(sessionId, "side_question_wait", { ask }, Math.max(WAIT_AGAIN_MIN_MS, p.since + ANSWER_WAIT_MS - Date.now()), heard(sessionId, ask)));
  } catch (e) {
    failed(sessionId, ask, e, true);
  }
}

// Gives up the question being asked; one still waiting for its session to start is not sent, and one waiting for the
// connection to come back is given up here at once.
export function cancelSide(sessionId: string): void {
  const p = thread(sessionId).pending;
  if (!p) return;
  given.add(sessionId);
  if (p.status !== "starting") call(sessionId, "side_question_cancel", { ask: p.ask }).catch(() => {});
  if (p.status === "offline") add(sessionId, { kind: "cancelled", question: p.question, at: Date.now() });
}

// Asks again a question refused while an earlier one, whose answer does not come here, was being answered, giving that
// one up first.
export async function askInstead(sessionId: string, entry: SideEntry, start = false): Promise<void> {
  if (thread(sessionId).pending || !thread(sessionId).entries.includes(entry)) return;
  await call(sessionId, "side_question_cancel", {}).catch(() => {});
  const t = thread(sessionId);
  if (t.pending || !t.entries.includes(entry)) return;
  update(sessionId, { entries: t.entries.filter((e) => e !== entry) });
  await askSide(sessionId, entry.question, start);
}

export function clearSide(sessionId: string): void {
  if (!thread(sessionId).pending) update(sessionId, { entries: [] });
}

onConnected(() => {
  for (const sessionId of threads.keys()) void waitAgain(sessionId);
});

try {
  for (let i = 0; i < sessionStorage.length; i++) {
    const m = ASKING_KEY.exec(sessionStorage.key(i) ?? "");
    if (m) thread(m[1]);
  }
} catch {}
