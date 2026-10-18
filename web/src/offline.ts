import type { SessionSummary } from "../../broker/src/protocol.ts";
import type { Me } from "./api.ts";
import { getPrefs } from "./prefs.ts";
import { COPY_IDLE_MINUTES, COPY_SESSIONS, copied, passwordChanged, untilAfter, usable, type CopyLogin, type SavedChat } from "./offlineCopy.ts";
import type { Chat } from "./state.ts";

// The phone's copy of recent conversations in IndexedDB, and in localStorage until when it may show. It belongs to the
// login it was made under: whatever ends that login, or sets its password again, drops it.
const DB = "ccrc-copy";
const STORE = "chats";
const BY_TIME = "savedAt";
const LOGIN_KEY = "ccrc.copyLogin";
// Each answer of the broker moves the copy's end; writing it down at most this often leaves it a little short of the
// login's.
const WRITE_MS = 30_000;

let db: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  if (!db) {
    db = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "sessionId" }).createIndex(BY_TIME, BY_TIME);
      req.onsuccess = () => {
        const d = req.result;
        d.onversionchange = () => {
          d.close();
          db = undefined;
        };
        resolve(d);
      };
      req.onerror = () => reject(req.error);
    });
    db.catch(() => (db = undefined));
  }
  return db;
}

function finished(t: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = t.onabort = () => reject(t.error);
  });
}

function answer<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

// Saves, reads and clears go one at a time in the order asked: a clear comes after every save asked before it.
let queue: Promise<unknown> = Promise.resolve();
function queued<T>(op: () => Promise<T>): Promise<T> {
  const next = queue.then(op, op);
  queue = next.catch(() => {});
  return next;
}

const watchers = new Set<() => void>();

// Called after the copy changed: a conversation saved or the whole copy dropped.
export function onCopies(fn: () => void): () => void {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

function changed(): void {
  for (const fn of watchers) fn();
}

let signedIn = false;
// The items and title last kept, so a chat that changed only in what the copy leaves out is not written again.
let lastKept: { items: Chat["items"]; title: string } | undefined;
let idleMinutes = COPY_IDLE_MINUTES;
let stamp: string | undefined;
let contact = 0;
let written = 0;

function readLogin(): CopyLogin | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(LOGIN_KEY) ?? "null") as Partial<CopyLogin> | null;
    return v && typeof v.until === "number" ? { until: v.until, ...(typeof v.stamp === "string" ? { stamp: v.stamp } : {}) } : undefined;
  } catch {
    return undefined;
  }
}

function writeLogin(): void {
  if (!signedIn || !contact) return;
  written = Date.now();
  try {
    localStorage.setItem(LOGIN_KEY, JSON.stringify({ until: untilAfter(contact, idleMinutes), ...(stamp ? { stamp } : {}) }));
  } catch {}
}

// When the copy stops showing; undefined when there is none to show.
export function copyEnd(): number | undefined {
  if (signedIn && contact) return untilAfter(contact, idleMinutes);
  return readLogin()?.until;
}

function showable(): boolean {
  return getPrefs().keepCopies && usable(signedIn && contact ? { until: untilAfter(contact, idleMinutes) } : readLogin());
}

// What /api/me said of this browser's login.
export function copyLogin(me: Me): void {
  if (!me.loggedIn) return copyLoggedOut();
  if (passwordChanged(readLogin(), me.loginSetAt)) void forgetCopies();
  signedIn = true;
  idleMinutes = me.leaseIdleMinutes ?? COPY_IDLE_MINUTES;
  stamp = me.loginSetAt;
  contact = Date.now();
  writeLogin();
}

export function copySignedIn(): boolean {
  return signedIn;
}

export function copyLoggedOut(): void {
  signedIn = false;
  contact = 0;
  void forgetCopies();
}

// The broker answered this login.
export function noteContact(): void {
  if (!signedIn) return;
  contact = Date.now();
  if (contact - written >= WRITE_MS) writeLogin();
}

export function flushContact(): void {
  writeLogin();
}

// Keeps the end of the chat on screen, as the newest of the copy.
export function keepCopy(chat: Chat, summary?: SessionSummary): Promise<void> {
  if (!signedIn || !getPrefs().keepCopies || !chat.loaded) return Promise.resolve();
  const title = summary?.title || chat.state?.title || "";
  if (lastKept?.items === chat.items && lastKept.title === title) return Promise.resolve();
  lastKept = { items: chat.items, title };
  const { items, cut } = copied(chat.items, { hasMore: chat.hasMore, gapBefore: chat.gap?.before });
  if (!items.length) return Promise.resolve();
  const rec: SavedChat = {
    sessionId: chat.sessionId,
    title,
    cwd: chat.state?.cwd ?? summary?.cwd ?? "",
    ...(summary?.branch ? { branch: summary.branch } : {}),
    savedAt: Date.now(),
    items,
    cut,
  };
  writeLogin();
  return queued(async () => {
    const t = (await open()).transaction(STORE, "readwrite");
    const store = t.objectStore(STORE);
    store.put(rec);
    const keys = await answer(store.index(BY_TIME).getAllKeys());
    for (const key of keys.slice(0, Math.max(0, keys.length - COPY_SESSIONS))) store.delete(key);
    await finished(t);
  })
    .then(changed)
    .catch(() => {});
}

// The conversations kept, newest first; none once the copy may no longer show, which then goes.
export function savedCopies(): Promise<SavedChat[]> {
  if (!showable()) return forgetCopies().then(() => []);
  return queued(async () => {
    const all = await answer((await open()).transaction(STORE).objectStore(STORE).getAll() as IDBRequest<SavedChat[]>);
    return all.sort((a, b) => b.savedAt - a.savedAt);
  }).catch(() => []);
}

export function savedCopy(sessionId: string): Promise<SavedChat | undefined> {
  if (!showable()) return forgetCopies().then(() => undefined);
  return queued(async () => {
    const found = await answer((await open()).transaction(STORE).objectStore(STORE).get(sessionId) as IDBRequest<SavedChat | undefined>);
    return found ?? undefined;
  }).catch(() => undefined);
}

// How many conversations are kept and their size in bytes, for the settings screen.
export function copySize(): Promise<{ count: number; bytes: number }> {
  return queued(async () => {
    const all = await answer((await open()).transaction(STORE).objectStore(STORE).getAll() as IDBRequest<SavedChat[]>);
    return { count: all.length, bytes: all.reduce((n, c) => n + new Blob([JSON.stringify(c)]).size, 0) };
  }).catch(() => ({ count: 0, bytes: 0 }));
}

export function forgetCopies(): Promise<void> {
  try {
    localStorage.removeItem(LOGIN_KEY);
  } catch {}
  written = 0;
  lastKept = undefined;
  return queued(async () => {
    const t = (await open()).transaction(STORE, "readwrite");
    t.objectStore(STORE).clear();
    await finished(t);
  })
    .then(changed)
    .catch(() => {});
}
