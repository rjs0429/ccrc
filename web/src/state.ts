import { useSyncExternalStore } from "react";
import type {
  CallMap,
  CallOp,
  ClientMsg,
  FolderOp,
  DisplayItem,
  HistoryPage,
  LiveState,
  PendingRequest,
  ServerMsg,
  SessionSummary,
  SnapshotGap,
} from "../../broker/src/protocol.ts";
import { api, ApiError, onPasskeyDue, type Me, type Options } from "./api.ts";
import { isIos, lastTap, recentRequest, syncAttention, syncPushLang } from "./push.ts";
import { joined, placed, streamed, type Streamed } from "./chatItems.ts";
import { copyLoggedOut, copyLogin, copyPasskeyDue, copySignedIn, flushContact, keepCopy, noteHeard, noteLost, noteSent } from "./offline.ts";
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
  stream?: Streamed;
  hasMore: boolean;
  gap?: SnapshotGap;
  // The agent and to-do calls of the parts not loaded, in order, the last `earlierInGap` of them from the gap.
  earlier?: DisplayItem[];
  earlierInGap?: number;
  // The number of the snapshot that set the items, counted over all chats.
  snaps?: number;
  // A part being loaded, or the one that could not be.
  loading?: "earlier" | "gap";
  failed?: "earlier" | "gap";
  // An item to scroll to once it has arrived, as a search result asks; `earlier` when it was said before a compaction.
  focus?: string;
  focusEarlier?: boolean;
  // A request card to show once the session has arrived.
  focusRequest?: string;
}

export interface AppState {
  me?: Me;
  // Why the page shows the phone's copy of recent conversations, not knowing its login yet: the broker did not answer,
  // or does not let this device in. reaching: /api/me is being asked.
  offline?: "unreachable" | "denied";
  reaching?: boolean;
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
  const chat = state.chat;
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  if (state.chat !== chat) copySoon();
  for (const l of listeners) l();
}

// The chat on screen goes into the phone's copy a moment after it changes, and at once when the page leaves it or
// goes to the background.
const COPY_MS = 2000;
let copyTimer: number | undefined;

function copySoon(): void {
  if (copyTimer === undefined && state.chat?.loaded) copyTimer = window.setTimeout(copyNow, COPY_MS);
}

function copyNow(): void {
  clearTimeout(copyTimer);
  copyTimer = undefined;
  const c = state.chat;
  if (c?.loaded) void keepCopy(c, state.sessions?.find((s) => s.id === c.sessionId));
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

// Asking again for the chat it shows, the phone keeps the part it holds.
function viewMsg(): ClientMsg {
  const sessionId = state.route.name === "chat" ? state.route.sessionId : null;
  const chat = sessionId && state.chat?.sessionId === sessionId ? state.chat : undefined;
  const from = chat?.loaded && !chat.focus ? chat.items[0]?.id : undefined;
  return { t: "view", sessionId, ...(chat?.focus ? { focus: chat.focus } : {}), ...(from ? { from } : {}) };
}

export function refreshChat(): void {
  send(viewMsg());
}

// Opens a session at one of its items.
export function openAt(sessionId: string, itemId?: string, earlier?: boolean): void {
  setState({ chat: { sessionId, loaded: false, items: [], pending: [], hasMore: false, focus: itemId, ...(earlier ? { focusEarlier: true } : {}) } });
  navigate({ name: "chat", sessionId });
}

export function focusDone(sessionId: string): void {
  updateChat(sessionId, () => ({ focus: undefined, focusEarlier: undefined }));
}

export function requestShown(sessionId: string): void {
  updateChat(sessionId, () => ({ focusRequest: undefined }));
}

// Opens a session at a request waiting for an answer.
export function openRequest(sessionId: string, requestId: string): void {
  if (state.chat?.sessionId === sessionId) updateChat(sessionId, () => ({ focusRequest: requestId }));
  else setState({ chat: { sessionId, loaded: false, items: [], pending: [], hasMore: false, focusRequest: requestId } });
  navigate({ name: "chat", sessionId });
}

const SHOWN_REQUEST_KEY = "ccrc.shownRequest";
// How long a notification's tap may come before or after the app comes to the front and still count for it.
const TAP_WAIT_MS = 1500;
const started = Date.now();

function shownRequest(): string | null {
  try {
    return localStorage.getItem(SHOWN_REQUEST_KEY);
  } catch {
    return null;
  }
}

// iOS can bring the app to the front from a notification without going where it points. Coming to the front shortly
// after a request's notification, the app goes to that request itself, once per request, unless a tap took it
// somewhere else or the user moved meanwhile; never from a new session's draft.
async function toNotifiedRequest(front: number): Promise<void> {
  if (!isIos() || !state.me?.loggedIn) return;
  const hash = location.hash;
  const r = await recentRequest().catch(() => undefined);
  if (!r || shownRequest() === r.requestId) return;
  await new Promise((done) => setTimeout(done, front + TAP_WAIT_MS - Date.now()));
  if (shownRequest() === r.requestId || state.route.name === "new") return;
  const tap = lastTap();
  const tapped = tap && tap.at >= front - TAP_WAIT_MS ? tap.hash : undefined;
  if (tapped === undefined && location.hash !== hash) return;
  try {
    localStorage.setItem(SHOWN_REQUEST_KEY, r.requestId);
  } catch {}
  if (tapped === undefined || tapped === `#/s/${r.sessionId}`) openRequest(r.sessionId, r.requestId);
}

function onRoute(): void {
  if (copyTimer !== undefined) copyNow();
  const route = parseRoute();
  if (route.name !== "settings") settingsReturn = undefined;
  setState({ route });
  const viewing = route.name === "chat" ? route.sessionId : null;
  if (viewing && state.chat?.sessionId !== viewing) {
    setState({ chat: { sessionId: viewing, loaded: false, items: [], pending: [], hasMore: false } });
  }
  if (!viewing) setState({ chat: undefined });
  send(viewMsg());
  if (state.me?.loggedIn && (route.name === "home" || route.name === "new")) void refreshSessions();
  badgeSoon();
}
window.addEventListener("hashchange", onRoute);

// The app icon's number is asked for a moment after something changed, once the broker has taken the new view, which
// counts as opening that session; the notifications that no longer count close with it, and those of the session the
// app shows. One iOS would not close yet is tried again once it may be, while the app stays in front.
const BADGE_MS = 500;
let badgeTimer: number | undefined;
let againTimer: number | undefined;

function badgeSoon(): void {
  if (!state.me?.loggedIn) return;
  clearTimeout(badgeTimer);
  badgeTimer = window.setTimeout(() => void syncBadge(), BADGE_MS);
}

async function syncBadge(): Promise<void> {
  clearTimeout(againTimer);
  if (!state.me?.loggedIn) return;
  const viewing = document.visibilityState === "visible" && state.conn === "ready" && state.route.name === "chat" ? state.route.sessionId : undefined;
  const wait = await syncAttention(viewing).catch(() => 0);
  clearTimeout(againTimer);
  if (wait > 0 && document.visibilityState === "visible" && state.me?.loggedIn) againTimer = window.setTimeout(() => void syncBadge(), wait);
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

// A request the network failed while the connection is down says nothing the banner does not.
function handleApiError(e: unknown): void {
  if (e instanceof ApiError && e.status === 401) {
    loggedOut("expired");
    return;
  }
  if (!(e instanceof ApiError) && state.conn !== "ready") return;
  toast(e instanceof Error ? e.message : String(e));
}

// The broker may be off as the page opens. After ME_SLOW_MS the page shows the phone's copy, and the answer takes over
// when it comes; an attempt is given up after ME_GIVE_UP_MS and made again after the next of ME_RETRY_MS. A new attempt
// replaces one under way, which may hang on a connection the network dropped.
const ME_SLOW_MS = 2500;
const ME_GIVE_UP_MS = 15_000;
const ME_RETRY_MS = [2000, 4000, 8000, 15_000];
let meTries = 0;
let meTimer: number | undefined;
let meAsk: AbortController | undefined;

export async function loadMe(): Promise<void> {
  meAsk?.abort();
  const ctl = (meAsk = new AbortController());
  clearTimeout(meTimer);
  setState({ reaching: true });
  const slow = window.setTimeout(() => !state.me && setState({ offline: state.offline ?? "unreachable" }), ME_SLOW_MS);
  const giveUp = window.setTimeout(() => ctl.abort(), ME_GIVE_UP_MS);
  try {
    const me = await api.me(ctl.signal);
    if (ctl !== meAsk) return;
    meTries = 0;
    copyLogin(me);
    setState({ me, offline: undefined });
    if (me.loggedIn && !me.passkey) startSession();
  } catch (e) {
    if (ctl !== meAsk) return;
    if (e instanceof ApiError && e.status === 403) return denied();
    if (!state.me) setState({ offline: "unreachable" });
    meTimer = window.setTimeout(() => void loadMe(), ME_RETRY_MS[Math.min(meTries++, ME_RETRY_MS.length - 1)]);
  } finally {
    clearTimeout(slow);
    clearTimeout(giveUp);
    if (ctl === meAsk) {
      meAsk = undefined;
      setState({ reaching: false });
    }
  }
}

let readyBefore = false;

export function startSession(): void {
  readyBefore = false;
  setState((s) => ({ me: s.me ? { ...s.me, loggedIn: true, passkey: undefined } : s.me, loggedOutReason: undefined }));
  connect();
  void refreshSessions();
  void refreshOptions();
  void toNotifiedRequest(started);
  void syncPushLang().catch(() => {});
  if (!copySignedIn()) void api.me().then(meAgain, () => {});
}

// What /api/me says once more, after a login or a new password: the phone's copy goes by it.
export function meAgain(me: Me): void {
  copyLogin(me);
  if (me.loggedIn) setState((s) => ({ me: s.me?.loggedIn ? { ...s.me, ...me } : s.me }));
}

// The login holds but a passkey has to confirm it: the page shows nothing else until it does (startSession).
export function passkeyNeeded(): void {
  copyPasskeyDue();
  clearTimeout(retryTimer);
  const ws = socket;
  socket = undefined;
  ws?.close();
  settleCalls();
  endFollows();
  setState((s) => ({ me: s.me ? { ...s.me, loggedIn: true, passkey: "due" } : { configured: true, loggedIn: true, device: "", passkey: "due" }, conn: "idle" }));
}
onPasskeyDue(passkeyNeeded);

export function loggedOut(reason: string): void {
  socket?.close();
  socket = undefined;
  clearTimeout(copyTimer);
  copyTimer = undefined;
  copyLoggedOut();
  setState((s) => ({ me: s.me ? { ...s.me, loggedIn: false } : s.me, conn: "idle", loggedOutReason: reason, chat: emptyChat(s.route) }));
}

// The broker does not let this device in: what the phone kept goes, and the page asks again now and then.
function denied(): void {
  clearTimeout(retryTimer);
  const ws = socket;
  socket = undefined;
  ws?.close();
  settleCalls();
  endFollows();
  clearTimeout(copyTimer);
  copyTimer = undefined;
  copyLoggedOut();
  setState((s) => ({ me: undefined, offline: "denied", conn: "idle", chat: emptyChat(s.route) }));
  clearTimeout(meTimer);
  meTimer = window.setTimeout(() => void loadMe(), ME_RETRY_MS.at(-1));
}

// A dropped connection that does not come back may mean the login or the device is no longer let in.
let probing = false;
async function probe(): Promise<void> {
  if (probing || !state.me) return;
  probing = true;
  try {
    if (!(await api.me()).loggedIn && state.me?.loggedIn) loggedOut("expired");
  } catch (e) {
    if (e instanceof ApiError && e.status === 403 && state.me) denied();
  } finally {
    probing = false;
  }
}

// Tries the broker again at once: the login while it is unknown, else the connection.
export function reconnect(): void {
  if (!state.me) {
    meTries = 0;
    void loadMe();
  } else if (state.conn === "offline") {
    retry = 0;
    connect();
  }
}

let socket: WebSocket | undefined;
let retry = 0;
let retryTimer: number | undefined;

// Whether the message went out; nothing is kept for a later connection.
export function send(msg: ClientMsg): boolean {
  if (socket?.readyState !== WebSocket.OPEN || state.conn !== "ready") return false;
  socket.send(JSON.stringify(msg));
  noteSent();
  return true;
}

const CALL_TIMEOUT_MS = 30_000;
let callSeq = 0;
export type CallProgress = Omit<Extract<ServerMsg, { t: "call_progress" }>, "t" | "id">;
const calls = new Map<number, { resolve: (data: unknown) => void; reject: (e: Error) => void; timer: number; progress?: (p: CallProgress) => void }>();

// Asks the broker something about a session; rejects with the broker's error message. progress hears how a long call goes.
export function call<K extends CallOp>(
  sessionId: string,
  op: K,
  args?: CallMap[K]["args"],
  ms = CALL_TIMEOUT_MS,
  progress?: (p: CallProgress) => void,
): Promise<CallMap[K]["data"]> {
  return ask((id) => ({ t: "call", id, sessionId, op, args: args ?? {} }), ms, progress) as Promise<CallMap[K]["data"]>;
}

// Asks about a folder no session runs in yet, for the new-session screen.
export function callFolder<K extends FolderOp>(cwd: string, op: K, args?: CallMap[K]["args"], ms = CALL_TIMEOUT_MS): Promise<CallMap[K]["data"]> {
  return ask((id) => ({ t: "call", id, cwd, op, args: args ?? {} }), ms) as Promise<CallMap[K]["data"]>;
}

function ask(msg: (id: number) => ClientMsg, ms: number, progress?: (p: CallProgress) => void): Promise<unknown> {
  if (socket?.readyState !== WebSocket.OPEN || state.conn !== "ready") return Promise.reject(Error("not connected"));
  const id = ++callSeq;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      calls.delete(id);
      reject(Error("no answer"));
    }, ms);
    calls.set(id, { resolve, reject, timer, ...(progress ? { progress } : {}) });
    socket!.send(JSON.stringify(msg(id)));
    noteSent();
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

const connectedHooks = new Set<() => void>();

// Called each time the connection to the broker is ready, after a reconnect too.
export function onConnected(fn: () => void): () => void {
  connectedHooks.add(fn);
  return () => connectedHooks.delete(fn);
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
  if (!state.me?.loggedIn || state.me.passkey) return;
  clearTimeout(retryTimer);
  socket?.close();
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  socket = ws;
  noteSent();
  // While it tries again after a drop, the page stays offline, so what shows does not flicker with each try.
  setState({ conn: state.conn === "offline" ? "offline" : "connecting" });
  ws.onmessage = (e) => {
    if (ws !== socket) return;
    noteHeard();
    onServer(JSON.parse(String(e.data)) as ServerMsg);
  };
  ws.onclose = (e) => {
    if (ws !== socket) return;
    noteLost();
    settleCalls();
    endFollows();
    if (e.code === 4001) return loggedOut(state.loggedOutReason ?? "expired");
    if (e.code === 4003) return passkeyNeeded();
    if (e.code === 4000) return setState({ conn: "taken" });
    setState({ conn: "offline" });
    retryTimer = window.setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000));
    void probe();
  };
}

// iOS suspends pages in the background; reconnect as soon as the page is visible again.
document.addEventListener("visibilitychange", () => {
  send({ t: "visibility", visible: document.visibilityState === "visible" });
  if (document.visibilityState === "visible") {
    reconnect();
    badgeSoon();
    void toNotifiedRequest(Date.now());
  }
  if (document.visibilityState === "hidden") {
    clearTimeout(againTimer);
    leaving();
  }
});
window.addEventListener("pagehide", leaving);
window.addEventListener("online", reconnect);

function leaving(): void {
  if (copyTimer !== undefined) copyNow();
  flushContact();
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function updateChat(sessionId: string, fn: (c: Chat) => Partial<Chat> | undefined): void {
  setState((s) => {
    if (!s.chat || s.chat.sessionId !== sessionId) return {};
    const patch = fn(s.chat);
    return patch ? { chat: { ...s.chat, ...patch } } : {};
  });
}

// A thought that ended leaves with the next item or state of its session, or after this long.
const ENDED_THOUGHT_MS = 1000;
const settled = (c: Chat, patch: Partial<Chat> | undefined): Partial<Chat> | undefined => (c.stream?.ended ? { ...patch, stream: undefined } : patch);

const HISTORY_CHANGED = "history_changed";
let snapshots = 0;
// A loaded part that may not go in yet (canJoin said no): it stays loading until joinParked puts it in.
let parked: { sessionId: string; snaps?: number; part: "earlier" | "gap"; page: HistoryPage } | undefined;

// Loads the page before the first item the chat holds, or the next part of its gap. canJoin, asked as the part comes,
// may keep it out until joinParked.
export async function loadMore(sessionId: string, part: "earlier" | "gap", canJoin?: () => boolean): Promise<void> {
  const c = state.chat;
  if (!c || c.sessionId !== sessionId || !c.loaded || c.loading) return;
  const gapAt = c.gap ? c.items.findIndex((i) => i.id === c.gap!.before) : -1;
  const first = c.items[0]?.id;
  if (part === "earlier" ? !c.hasMore || !first : gapAt < 1) return;
  const snaps = c.snaps;
  const args = part === "earlier" ? { before: first! } : { after: c.items[gapAt - 1].id, until: c.gap!.before };
  updateChat(sessionId, () => ({ loading: part, failed: undefined }));
  try {
    const page = await call(sessionId, "history", args);
    if (state.chat?.sessionId === sessionId && state.chat.snaps === snaps && canJoin && !canJoin()) {
      parked = { sessionId, snaps, part, page };
      return;
    }
    updateChat(sessionId, (c) => (c.snaps !== snaps ? { loading: undefined } : { loading: undefined, ...joined(c, part, page) }));
  } catch (e) {
    updateChat(sessionId, () => ({ loading: undefined, failed: part }));
    if (e instanceof Error && e.message === HISTORY_CHANGED && state.chat?.sessionId === sessionId) send({ t: "view", sessionId });
  }
}

// Puts in the part loadMore kept out; false when none waits for this chat.
export function joinParked(sessionId: string): boolean {
  const p = parked;
  if (p?.sessionId !== sessionId) return false;
  parked = undefined;
  updateChat(sessionId, (c) => (c.snaps === p.snaps && c.loading === p.part ? { loading: undefined, ...joined(c, p.part, p.page) } : undefined));
  return true;
}

function onServer(msg: ServerMsg): void {
  switch (msg.t) {
    case "ready":
      retry = 0;
      // A new window follows nothing yet.
      endFollows();
      setState({ conn: "ready" });
      // Back after a drop, the login may have changed meanwhile: a new password drops the phone's copy.
      if (readyBefore) void api.me().then(meAgain, () => {});
      readyBefore = true;
      send({ t: "visibility", visible: document.visibilityState === "visible" });
      send(viewMsg());
      if (startingSent) send(startingSent.msg);
      badgeSoon();
      for (const fn of connectedHooks) fn();
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
      if (parked?.sessionId === msg.sessionId) parked = undefined;
      for (const item of [...msg.items, ...(msg.state.queued ?? [])]) bindSent(msg.sessionId, item);
      updateChat(msg.sessionId, () => ({
        loaded: true,
        items: msg.items,
        pending: msg.pending,
        state: msg.state,
        stateAt: Date.now(),
        hasMore: msg.hasMore,
        gap: msg.gap,
        earlier: msg.earlier,
        earlierInGap: msg.earlierInGap,
        snaps: ++snapshots,
        loading: undefined,
        failed: undefined,
        stream: undefined,
      }));
      return;
    case "item":
      bindSent(msg.sessionId, msg.item);
      updateChat(msg.sessionId, (c) => settled(c, placed(c, msg.item, msg.prev)));
      return;
    case "stream": {
      const stream = streamed(state.chat?.sessionId === msg.sessionId ? state.chat.stream : undefined, msg.text, msg.thinking);
      updateChat(msg.sessionId, (c) => (c.stream === stream ? undefined : { stream }));
      if (stream?.ended) setTimeout(() => updateChat(msg.sessionId, (c) => (c.stream === stream ? { stream: undefined } : undefined)), ENDED_THOUGHT_MS);
      return;
    }
    case "pending_add":
      updateChat(msg.sessionId, (c) => ({ pending: [...c.pending.filter((p) => p.id !== msg.request.id), msg.request] }));
      return;
    case "pending_remove":
      updateChat(msg.sessionId, (c) => ({ pending: c.pending.filter((p) => p.id !== msg.requestId) }));
      return;
    case "state":
      for (const q of msg.state.queued ?? []) bindSent(msg.sessionId, q);
      updateChat(msg.sessionId, (c) => settled(c, same(c.state, msg.state) ? undefined : { state: msg.state, stateAt: Date.now() }));
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
    case "call_progress": {
      const { t: _t, id, ...p } = msg;
      calls.get(id)?.progress?.(p);
      return;
    }
    case "login_changed":
      void api.me().then(meAgain, () => {});
      return;
    case "pong":
      return;
  }
}
