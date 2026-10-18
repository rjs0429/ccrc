import { useSyncExternalStore } from "react";
import type {
  CallMap,
  CallOp,
  ClientMsg,
  FolderOp,
  DisplayItem,
  LiveState,
  PendingRequest,
  ServerMsg,
  SessionSummary,
  SnapshotGap,
} from "../../broker/src/protocol.ts";
import { api, ApiError, type Me, type Options } from "./api.ts";
import { syncBadge } from "./push.ts";
import { bindSent } from "./sentPreviews.ts";

export type SettingsPage = "claude" | "alerts" | "account" | "status";
export type SettingsPart = "permissions";
export type Route =
  | { name: "home" }
  | { name: "chat"; sessionId: string }
  | { name: "new" }
  | { name: "settings"; page?: SettingsPage; part?: SettingsPart };
export type Conn = "idle" | "connecting" | "ready" | "conflict" | "taken" | "offline";

export interface Chat {
  sessionId: string;
  loaded: boolean;
  items: DisplayItem[];
  pending: PendingRequest[];
  state?: LiveState;
  // When the state arrived, so a running task's time counts on from the broker's measure.
  stateAt?: number;
  stream?: { text: string; thinking: boolean };
  hasMore: boolean;
  gap?: SnapshotGap;
  // An item to scroll to once it has arrived, as a search result asks; `earlier` when it was said before a compaction.
  focus?: string;
  focusEarlier?: boolean;
}

export interface AppState {
  me?: Me;
  route: Route;
  sessions?: SessionSummary[];
  options?: Options;
  conn: Conn;
  loggedOutReason?: string;
  chat?: Chat;
  toast?: { text: string; at: number; action?: ToastAction };
  // Text another part of the app asks the composer to add (for example a comment on a changed line), or to hold in place
  // of what it has.
  insert?: { text: string; at: number; replace?: boolean };
  // A new session asked for from here and not yet started or refused.
  starting?: string;
}

type Listener = () => void;
// Server messages only fill a chat that exists, so a chat route always has one.
function emptyChat(route: Route): Chat | undefined {
  return route.name === "chat" ? { sessionId: route.sessionId, loaded: false, items: [], pending: [], hasMore: false } : undefined;
}
const startRoute = parseRoute();
let state: AppState = { route: startRoute, conn: "idle", chat: emptyChat(startRoute) };
const listeners = new Set<Listener>();

export function getState(): AppState {
  return state;
}

function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  for (const l of listeners) l();
}

function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useApp<T>(select: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}

// A button on a toast, for what the user may want to do next.
export interface ToastAction {
  label: string;
  run: () => void;
}

export function toast(text: string, action?: ToastAction): void {
  setState({ toast: { text, at: Date.now(), ...(action ? { action } : {}) } });
}

export function composerInsert(text: string, replace = false): void {
  setState({ insert: { text, at: Date.now(), ...(replace ? { replace } : {}) } });
}

function parseRoute(): Route {
  const h = location.hash.replace(/^#/, "");
  const m = h.match(/^\/s\/([0-9a-f-]{36})$/);
  if (m) return { name: "chat", sessionId: m[1] };
  if (h === "/new") return { name: "new" };
  if (h === "/settings") return { name: "settings" };
  const p = h.match(/^\/settings\/(claude|alerts|account|status)(?:\/(permissions))?$/);
  if (p) return { name: "settings", page: p[1] as SettingsPage, ...(p[2] ? { part: p[2] as SettingsPart } : {}) };
  return { name: "home" };
}

export function navigate(route: Route): void {
  const hash =
    route.name === "chat"
      ? `#/s/${route.sessionId}`
      : route.name === "home"
        ? "#/"
        : route.name === "settings" && route.page
          ? `#/settings/${route.page}${route.part ? `/${route.part}` : ""}`
          : `#/${route.name}`;
  if (location.hash !== hash) location.hash = hash;
  else onRoute();
}

// Where the settings page opened by a "/" command returns to.
let settingsReturn: string | undefined;

export function openSettingsFrom(page: SettingsPage, part?: SettingsPart): void {
  settingsReturn = location.hash;
  navigate({ name: "settings", page, ...(part ? { part } : {}) });
}

export function leaveSettings(page?: SettingsPage): void {
  const back = settingsReturn;
  settingsReturn = undefined;
  if (back && page) location.hash = back;
  else navigate(page ? { name: "settings" } : { name: "home" });
}

function viewMsg(): ClientMsg {
  const sessionId = state.route.name === "chat" ? state.route.sessionId : null;
  const focus = sessionId && state.chat?.sessionId === sessionId ? state.chat.focus : undefined;
  return { t: "view", sessionId, ...(focus ? { focus } : {}) };
}

// Opens a session at one of its items.
export function openAt(sessionId: string, itemId?: string, earlier?: boolean): void {
  setState({ chat: { sessionId, loaded: false, items: [], pending: [], hasMore: false, focus: itemId, ...(earlier ? { focusEarlier: true } : {}) } });
  navigate({ name: "chat", sessionId });
}

export function focusDone(sessionId: string): void {
  updateChat(sessionId, () => ({ focus: undefined, focusEarlier: undefined }));
}

function onRoute(): void {
  const route = parseRoute();
  if (route.name !== "settings") settingsReturn = undefined;
  setState({ route });
  const viewing = route.name === "chat" ? route.sessionId : null;
  if (viewing && state.chat?.sessionId !== viewing) {
    setState({ chat: { sessionId: viewing, loaded: false, items: [], pending: [], hasMore: false } });
  }
  if (!viewing) setState({ chat: undefined });
  send(viewMsg());
  if (route.name === "home" || route.name === "new") void refreshSessions();
  badgeSoon();
}
window.addEventListener("hashchange", onRoute);

// The app icon's number is asked for a moment after something changed, once the broker has taken the new view, which
// counts as opening that session.
const BADGE_MS = 500;
let badgeTimer: number | undefined;

function badgeSoon(): void {
  if (!state.me?.loggedIn) return;
  clearTimeout(badgeTimer);
  badgeTimer = window.setTimeout(() => void syncBadge().catch(() => {}), BADGE_MS);
}

export async function refreshSessions(): Promise<void> {
  try {
    setState({ sessions: await api.sessions() });
  } catch (e) {
    handleApiError(e);
  }
}

// Changes a session of the list at once, ahead of the broker's next list.
export function patchSession(sessionId: string, patch: Partial<SessionSummary>): void {
  setState((s) => (s.sessions ? { sessions: s.sessions.map((x) => (x.id === sessionId ? { ...x, ...patch } : x)) } : {}));
}

export async function refreshOptions(): Promise<void> {
  try {
    setState({ options: await api.options() });
  } catch (e) {
    handleApiError(e);
  }
}

function handleApiError(e: unknown): void {
  if (e instanceof ApiError && e.status === 401) {
    loggedOut("expired");
    return;
  }
  toast(e instanceof Error ? e.message : String(e));
}

export async function loadMe(): Promise<void> {
  const me = await api.me();
  setState({ me });
  if (me.loggedIn) startSession();
}

export function startSession(): void {
  setState((s) => ({ me: s.me ? { ...s.me, loggedIn: true } : s.me, loggedOutReason: undefined }));
  connect();
  void refreshSessions();
  void refreshOptions();
}

export function loggedOut(reason: string): void {
  socket?.close();
  socket = undefined;
  setState((s) => ({ me: s.me ? { ...s.me, loggedIn: false } : s.me, conn: "idle", loggedOutReason: reason, chat: emptyChat(s.route) }));
}

let socket: WebSocket | undefined;
let retry = 0;
let retryTimer: number | undefined;

// Whether the message went out; nothing is kept for a later connection.
export function send(msg: ClientMsg): boolean {
  if (socket?.readyState !== WebSocket.OPEN || state.conn !== "ready") return false;
  socket.send(JSON.stringify(msg));
  return true;
}

const CALL_TIMEOUT_MS = 30_000;
let callSeq = 0;
const calls = new Map<number, { resolve: (data: unknown) => void; reject: (e: Error) => void; timer: number }>();

// Asks the broker something about a session; rejects with the broker's error message.
export function call<K extends CallOp>(sessionId: string, op: K, args?: CallMap[K]["args"], ms = CALL_TIMEOUT_MS): Promise<CallMap[K]["data"]> {
  return ask((id) => ({ t: "call", id, sessionId, op, args: args ?? {} }), ms) as Promise<CallMap[K]["data"]>;
}

// Asks about a folder no session runs in yet, for the new-session screen.
export function callFolder<K extends FolderOp>(cwd: string, op: K, args?: CallMap[K]["args"], ms = CALL_TIMEOUT_MS): Promise<CallMap[K]["data"]> {
  return ask((id) => ({ t: "call", id, cwd, op, args: args ?? {} }), ms) as Promise<CallMap[K]["data"]>;
}

function ask(msg: (id: number) => ClientMsg, ms: number): Promise<unknown> {
  if (socket?.readyState !== WebSocket.OPEN || state.conn !== "ready") return Promise.reject(Error("not connected"));
  const id = ++callSeq;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      calls.delete(id);
      reject(Error("no answer"));
    }, ms);
    calls.set(id, { resolve, reject, timer });
    socket!.send(JSON.stringify(msg(id)));
  });
}

const START_WAIT_MS = 60_000;
// A start in a new worktree also waits for Claude Code to make it, which the broker allows a minute.
const WORKTREE_START_WAIT_MS = 90_000;
type NewSessionMsg = Extract<ClientMsg, { t: "new_session" }>;
type Start = { id: string; msg: NewSessionMsg };
// The new session being started from here, by the draftId the broker answers with. It outlasts a reconnect,
// which asks for it again; the broker starts a draftId once. The last one that went unanswered is kept, so a late
// answer still clears its draft and starting the same draft again names the same start.
let startingSent: (Start & { timer: number }) | undefined;
let unanswered: Start | undefined;
let draftStarted: ((sessionId: string, text: string) => void) | undefined;

// Called when the new session asked for from here has started, before the chat opens.
export function onDraftStarted(fn: (sessionId: string, text: string) => void): void {
  draftStarted = fn;
}

let draftFailed: ((message: string, start: NewSessionMsg) => boolean) | undefined;

// Called when the broker refused the new session asked for from here; true when the caller shows why itself.
export function onDraftFailed(fn: typeof draftFailed): void {
  draftFailed = fn;
}

function startDone(): void {
  if (startingSent) clearTimeout(startingSent.timer);
  startingSent = undefined;
  setState({ starting: undefined });
}

function startTimedOut(): void {
  unanswered = startingSent;
  startDone();
}

const sameStart = (a: NewSessionMsg, b: NewSessionMsg) => JSON.stringify({ ...a, draftId: "" }) === JSON.stringify({ ...b, draftId: "" });

// Starts a new session; false when it could not be asked for. session_started or an error with the same
// draftId ends the wait.
export function startNewSession(start: Omit<NewSessionMsg, "draftId">): boolean {
  if (state.starting) return false;
  const fresh = `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const msg: NewSessionMsg = { ...start, draftId: fresh };
  if (unanswered && sameStart(unanswered.msg, msg)) msg.draftId = unanswered.id;
  if (!send(msg)) return false;
  unanswered = undefined;
  startingSent = { id: msg.draftId!, msg, timer: window.setTimeout(startTimedOut, msg.worktree ? WORKTREE_START_WAIT_MS : START_WAIT_MS) };
  setState({ starting: msg.draftId });
  return true;
}

function settleCalls(): void {
  for (const c of calls.values()) {
    clearTimeout(c.timer);
    c.reject(Error("not connected"));
  }
  calls.clear();
}

// What the page follows of the session it shows, by the ids it gave the broker: changes as they come, and the end of
// the broker's watch, which a lost connection also is.
type FollowMsg = Extract<ServerMsg, { t: "follow" }>;
export interface Follower {
  change: (m: FollowMsg) => void;
  end: () => void;
}
const followers = new Map<string, Follower>();
let followSeq = 0;

export function follower(f: Follower): { id: string; off: () => void } {
  const id = `f${++followSeq}`;
  followers.set(id, f);
  return { id, off: () => followers.delete(id) };
}

export function unfollow(id: string): void {
  followers.delete(id);
  send({ t: "unfollow", id });
}

export function following(id: string): boolean {
  return followers.has(id);
}

function endFollows(): void {
  const all = [...followers.values()];
  followers.clear();
  for (const f of all) f.end();
}

export function takeWindow(): void {
  if (state.conn === "conflict") socket?.send(JSON.stringify({ t: "take_window" } satisfies ClientMsg));
  else if (state.conn === "taken" || state.conn === "offline") connect();
}

export function connect(): void {
  if (!state.me?.loggedIn) return;
  clearTimeout(retryTimer);
  socket?.close();
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  socket = ws;
  setState({ conn: "connecting" });
  ws.onmessage = (e) => {
    if (ws === socket) onServer(JSON.parse(String(e.data)) as ServerMsg);
  };
  ws.onclose = (e) => {
    if (ws !== socket) return;
    settleCalls();
    endFollows();
    if (e.code === 4001) return loggedOut(state.loggedOutReason ?? "expired");
    if (e.code === 4000) return setState({ conn: "taken" });
    setState({ conn: "offline" });
    retryTimer = window.setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000));
  };
}

// iOS suspends pages in the background; reconnect as soon as the page is visible again.
document.addEventListener("visibilitychange", () => {
  send({ t: "visibility", visible: document.visibilityState === "visible" });
  if (document.visibilityState === "visible" && state.conn === "offline") {
    retry = 0;
    connect();
  }
  if (document.visibilityState === "visible") badgeSoon();
});

function upsert(items: DisplayItem[], item: DisplayItem): DisplayItem[] {
  const at = items.findIndex((i) => i.id === item.id);
  if (at === -1) return [...items, item];
  const next = items.slice();
  next[at] = item;
  return next;
}

function updateChat(sessionId: string, fn: (c: Chat) => Partial<Chat>): void {
  setState((s) => (s.chat && s.chat.sessionId === sessionId ? { chat: { ...s.chat, ...fn(s.chat) } } : {}));
}

function onServer(msg: ServerMsg): void {
  switch (msg.t) {
    case "ready":
      retry = 0;
      // A new window follows nothing yet.
      endFollows();
      setState({ conn: "ready" });
      send({ t: "visibility", visible: document.visibilityState === "visible" });
      send(viewMsg());
      if (startingSent) send(startingSent.msg);
      badgeSoon();
      return;
    case "window_conflict":
      setState({ conn: "conflict" });
      return;
    case "window_taken":
      setState({ conn: "taken" });
      return;
    case "lease_revoked":
      setState({ loggedOutReason: msg.reason });
      return;
    case "snapshot":
      for (const item of [...msg.items, ...(msg.state.queued ?? [])]) bindSent(msg.sessionId, item);
      updateChat(msg.sessionId, () => ({ loaded: true, items: msg.items, pending: msg.pending, state: msg.state, stateAt: Date.now(), hasMore: msg.hasMore, gap: msg.gap, stream: undefined }));
      return;
    case "item":
      bindSent(msg.sessionId, msg.item);
      updateChat(msg.sessionId, (c) => ({ items: upsert(c.items, msg.item) }));
      return;
    case "stream":
      updateChat(msg.sessionId, () => ({ stream: msg.text || msg.thinking ? { text: msg.text, thinking: msg.thinking } : undefined }));
      return;
    case "pending_add":
      updateChat(msg.sessionId, (c) => ({ pending: [...c.pending.filter((p) => p.id !== msg.request.id), msg.request] }));
      return;
    case "pending_remove":
      updateChat(msg.sessionId, (c) => ({ pending: c.pending.filter((p) => p.id !== msg.requestId) }));
      return;
    case "state":
      for (const q of msg.state.queued ?? []) bindSent(msg.sessionId, q);
      updateChat(msg.sessionId, () => ({ state: msg.state, stateAt: Date.now() }));
      if (!state.options?.models.length) void refreshOptions();
      return;
    case "session_started": {
      const started = msg.draftId ? [startingSent, unanswered].find((d) => d?.id === msg.draftId) : undefined;
      if (started) {
        draftStarted?.(msg.sessionId, started.msg.text);
        if (started === unanswered) unanswered = undefined;
        else startDone();
      }
      setState({ chat: { sessionId: msg.sessionId, loaded: false, items: [], pending: [], hasMore: false } });
      navigate({ name: "chat", sessionId: msg.sessionId });
      return;
    }
    case "sessions_changed":
      void refreshSessions();
      badgeSoon();
      return;
    case "options_changed":
      void refreshOptions();
      return;
    case "error": {
      // A start refused by the brokerSessions setting means the options this window holds are out of date.
      if (msg.message.startsWith("broker_sessions_off")) void refreshOptions();
      const failed = msg.draftId ? [startingSent, unanswered].find((d) => d?.id === msg.draftId) : undefined;
      if (msg.draftId && msg.draftId === startingSent?.id) startDone();
      if (msg.draftId && msg.draftId === unanswered?.id) unanswered = undefined;
      if (!(failed && draftFailed?.(msg.message, failed.msg))) toast(msg.message);
      return;
    }
    case "call_result": {
      const c = calls.get(msg.id);
      if (!c) return;
      calls.delete(msg.id);
      clearTimeout(c.timer);
      if (msg.ok) c.resolve(msg.data);
      else c.reject(Error(msg.error ?? "failed"));
      return;
    }
    case "follow":
      followers.get(msg.id)?.change(msg);
      return;
    case "follow_end": {
      const f = followers.get(msg.id);
      followers.delete(msg.id);
      f?.end();
      return;
    }
    case "pong":
      return;
  }
}
