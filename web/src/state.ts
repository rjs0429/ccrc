import { useSyncExternalStore } from "react";
import type {
  ClientMsg,
  DisplayItem,
  LiveState,
  PendingRequest,
  ServerMsg,
  SessionSummary,
} from "../../broker/src/protocol.ts";
import { api, ApiError, type Me, type Options } from "./api.ts";

export type Route = { name: "home" } | { name: "chat"; sessionId: string } | { name: "new" } | { name: "settings" };
export type Conn = "idle" | "connecting" | "ready" | "conflict" | "taken" | "offline";

export interface Chat {
  sessionId: string;
  loaded: boolean;
  items: DisplayItem[];
  pending: PendingRequest[];
  state?: LiveState;
  stream?: { text: string; thinking: boolean };
  hasMore: boolean;
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
}

type Listener = () => void;
let state: AppState = { route: parseRoute(), conn: "idle" };
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

function parseRoute(): Route {
  const h = location.hash.replace(/^#/, "");
  const m = h.match(/^\/s\/([0-9a-f-]{36})$/);
  if (m) return { name: "chat", sessionId: m[1] };
  if (h === "/new") return { name: "new" };
  if (h === "/settings") return { name: "settings" };
  return { name: "home" };
}

export function navigate(route: Route): void {
  const hash = route.name === "chat" ? `#/s/${route.sessionId}` : route.name === "home" ? "#/" : `#/${route.name}`;
  if (location.hash !== hash) location.hash = hash;
  else onRoute();
}

function onRoute(): void {
  const route = parseRoute();
  setState({ route });
  const viewing = route.name === "chat" ? route.sessionId : null;
  if (viewing && state.chat?.sessionId !== viewing) {
    setState({ chat: { sessionId: viewing, loaded: false, items: [], pending: [], hasMore: false } });
  }
  if (!viewing) setState({ chat: undefined });
  send({ t: "view", sessionId: viewing });
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
  setState((s) => ({ me: s.me ? { ...s.me, loggedIn: false } : s.me, conn: "idle", loggedOutReason: reason, chat: undefined }));
}

let socket: WebSocket | undefined;
let retry = 0;
let retryTimer: number | undefined;

export function send(msg: ClientMsg): void {
  if (socket?.readyState === WebSocket.OPEN && state.conn === "ready") socket.send(JSON.stringify(msg));
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
    if (e.code === 4001) return loggedOut(state.loggedOutReason ?? "expired");
    if (e.code === 4000) return setState({ conn: "taken" });
    setState({ conn: "offline" });
    retryTimer = window.setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000));
  };
}

// iOS suspends pages in the background; reconnect as soon as the page is visible again.
document.addEventListener("visibilitychange", () => {
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
      send({ t: "view", sessionId: state.route.name === "chat" ? state.route.sessionId : null });
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
    case "pong":
      return;
  }
}
