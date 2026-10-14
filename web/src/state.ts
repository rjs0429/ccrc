import { useSyncExternalStore } from "react";
import type {
  CallMap,
  CallOp,
  ClientMsg,
  DisplayItem,
  LiveState,
  PendingRequest,
  ServerMsg,
  SessionSummary,
} from "../../broker/src/protocol.ts";
import { api, ApiError, type Me, type Options } from "./api.ts";

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
  stream?: { text: string; thinking: boolean };
  hasMore: boolean;
  // An item to scroll to once it has arrived, as a search result asks.
  focus?: string;
}

export interface AppState {
  me?: Me;
  route: Route;
  sessions?: SessionSummary[];
  options?: Options;
  conn: Conn;
  loggedOutReason?: string;
  chat?: Chat;
  toast?: { text: string; at: number };
  // Text another part of the app asks the composer to add (for example a comment on a changed line).
  insert?: { text: string; at: number };
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

export function toast(text: string): void {
  setState({ toast: { text, at: Date.now() } });
}

export function composerInsert(text: string): void {
  setState({ insert: { text, at: Date.now() } });
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
export function openAt(sessionId: string, itemId?: string): void {
  setState({ chat: { sessionId, loaded: false, items: [], pending: [], hasMore: false, focus: itemId } });
  navigate({ name: "chat", sessionId });
}

export function focusDone(sessionId: string): void {
  updateChat(sessionId, () => ({ focus: undefined }));
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
}
window.addEventListener("hashchange", onRoute);

export async function refreshSessions(): Promise<void> {
  try {
    setState({ sessions: await api.sessions() });
  } catch (e) {
    handleApiError(e);
  }
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
  if (socket?.readyState !== WebSocket.OPEN || state.conn !== "ready") return Promise.reject(Error("not connected"));
  const id = ++callSeq;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      calls.delete(id);
      reject(Error("no answer"));
    }, ms);
    calls.set(id, { resolve: resolve as (data: unknown) => void, reject, timer });
    socket!.send(JSON.stringify({ t: "call", id, sessionId, op, args: args ?? {} } satisfies ClientMsg));
  });
}

function settleCalls(): void {
  for (const c of calls.values()) {
    clearTimeout(c.timer);
    c.reject(Error("not connected"));
  }
  calls.clear();
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
      setState({ conn: "ready" });
      send({ t: "visibility", visible: document.visibilityState === "visible" });
      send(viewMsg());
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
      updateChat(msg.sessionId, () => ({ loaded: true, items: msg.items, pending: msg.pending, state: msg.state, hasMore: msg.hasMore, stream: undefined }));
      return;
    case "item":
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
      updateChat(msg.sessionId, () => ({ state: msg.state }));
      if (!state.options?.models.length) void refreshOptions();
      return;
    case "session_started":
      setState({ chat: { sessionId: msg.sessionId, loaded: false, items: [], pending: [], hasMore: false } });
      navigate({ name: "chat", sessionId: msg.sessionId });
      return;
    case "sessions_changed":
      void refreshSessions();
      return;
    case "error":
      toast(msg.message);
      return;
    case "call_result": {
      const c = calls.get(msg.id);
      if (!c) return;
      calls.delete(msg.id);
      clearTimeout(c.timer);
      if (msg.ok) c.resolve(msg.data);
      else c.reject(Error(msg.error ?? "failed"));
      return;
    }
    case "pong":
      return;
  }
}
