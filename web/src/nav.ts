import { useCallback, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

export type SettingsPage = "claude" | "alerts" | "account" | "status";
export type SettingsPart = "permissions";
export type Route =
  | { name: "home" }
  | { name: "chat"; sessionId: string }
  | { name: "new" }
  | { name: "settings"; page?: SettingsPage; part?: SettingsPart };

export function parseRoute(hash: string = location.hash): Route {
  const h = hash.replace(/^#/, "");
  const m = h.match(/^\/s\/([0-9a-f-]{36})$/);
  if (m) return { name: "chat", sessionId: m[1] };
  if (h === "/new") return { name: "new" };
  if (h === "/settings") return { name: "settings" };
  const p = h.match(/^\/settings\/(claude|alerts|account|status)(?:\/(permissions))?$/);
  if (p) return { name: "settings", page: p[1] as SettingsPage, ...(p[2] ? { part: p[2] as SettingsPart } : {}) };
  return { name: "home" };
}

export function routeHash(route: Route): string {
  if (route.name === "chat") return `#/s/${route.sessionId}`;
  if (route.name === "home") return "#/";
  if (route.name === "settings" && route.page) return `#/settings/${route.page}${route.part ? `/${route.part}` : ""}`;
  return `#/${route.name}`;
}

// The screens a route stands on when the app starts there: home, then each level down to it.
export function lineage(route: Route): Route[] {
  if (route.name === "home") return [route];
  if (route.name !== "settings" || !route.page) return [{ name: "home" }, route];
  const page: Route = { name: "settings", page: route.page };
  return [{ name: "home" }, { name: "settings" }, page, ...(route.part ? [route] : [])];
}

// The history is the stack of what is open: home at the bottom, each screen over the one it was opened from, a layer
// (sheet, viewer) over its screen. The browser's back and iOS's edge swipe close the top of it.
interface Entry {
  ccrc: 1;
  // How many of the app's entries lie under this one.
  below: number;
  layer?: string;
  // How many layer entries, this one included, stand over the screen's.
  layers?: number;
  // The first of the app's entries under it is not home, as when the address was set from outside the app.
  base?: true;
  // What the screen kept of itself when it was left.
  keep?: Record<string, unknown>;
}

interface Layer {
  key: string;
  close: () => void;
  // A close asked by the user, waiting for the history to step back over the layer.
  closing: boolean;
}

// A history step the app asked for gives up waiting after this long.
const STUCK_MS = 2000;
const LOAD = Math.random().toString(36).slice(2, 8);
let seq = 0;
let cur: Entry = { ccrc: 1, below: 0 };
// The keys of the layer entries over the screen's, up to the entry the page is at.
let stack: string[] = [];
// The layers open on the page, bottom first; one not in the history yet goes in at the next sync.
let live: Layer[] = [];
// The route the app shows, as a hash.
let shown = "";
let moving: { then?: () => void; timer: number } | undefined;
const waiting: (() => void)[] = [];
let syncSoon = false;
const listeners = new Set<() => void>();
const keepers = new Map<string, () => unknown>();

function isEntry(v: unknown): v is Entry {
  return typeof v === "object" && v !== null && (v as Entry).ccrc === 1 && Number.isInteger((v as Entry).below);
}

const base = (): { base?: true } => (cur.base ? { base: true } : {});
const same = (route: Route) => routeHash(route) === routeHash(parseRoute());
const screenBelow = () => cur.below - stack.length;
const hrefOf = (route: Route) => `${location.pathname}${location.search}${routeHash(route)}`;

function write(entry: Entry, url: string, push: boolean): boolean {
  try {
    if (push) history.pushState(entry, "", url);
    else history.replaceState(entry, "", url);
  } catch {
    return false;
  }
  cur = entry;
  return true;
}

// Calls fn whenever the route the address names changes.
export function listen(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function show(again = false): void {
  const hash = routeHash(parseRoute());
  if (!again && hash === shown) return;
  shown = hash;
  for (const fn of listeners) fn();
}

function save(): void {
  if (stack.length || moving || !keepers.size) return;
  const keep = Object.fromEntries([...keepers].map(([k, get]) => [k, get()]));
  if (JSON.stringify(keep) !== JSON.stringify(cur.keep)) write({ ...cur, keep }, location.href, false);
}

function put(route: Route, entry: Entry, push: boolean): void {
  stack = [];
  write(entry, hrefOf(route), push);
  show(true);
}

// Steps through the history, then; anything asked meanwhile waits for it to land.
function step(delta: number, then?: () => void): void {
  if (delta === 0) return void then?.();
  moving = { then, timer: window.setTimeout(() => land(history.state, true), STUCK_MS) };
  history.go(delta);
}

function busy(op: () => void): boolean {
  if (!moving) return false;
  waiting.push(op);
  return true;
}

function land(state: unknown, stuck = false): void {
  const was = moving;
  moving = undefined;
  if (was) clearTimeout(was.timer);
  const away = routeHash(parseRoute()) !== shown;
  const before = stack;
  if (!isEntry(state)) {
    // An entry the app did not make: an address set from outside, or one from before this version.
    stack = [];
    write(parseRoute().name === "home" ? { ccrc: 1, below: 0 } : { ccrc: 1, below: 0, base: true }, location.href, false);
  } else {
    cur = state;
    const n = state.layers ?? 0;
    const known = n <= before.length && (n === 0 || before[n - 1] === state.layer);
    stack = before.slice(0, Math.min(n, before.length));
    if (!known && !stuck) {
      // A layer that has closed, or one left by a reload: step on to the entry under it.
      closePopped(before, away);
      step(-1, was?.then);
      return;
    }
  }
  if (!isEntry(state)) {
    for (const l of live.splice(0).reverse()) if (!away) l.close();
  } else closePopped(before, away);
  for (const l of live) l.closing = false;
  was?.then?.();
  show();
  while (!moving && waiting.length) waiting.shift()!();
  sync();
}

// The layers whose entries the history has stepped back over close; with the screen they go without a word.
function closePopped(before: string[], away: boolean): void {
  const popped = live.filter((l) => before.includes(l.key) && !stack.includes(l.key));
  live = live.filter((l) => !popped.includes(l));
  for (const l of popped.reverse()) if (!away) l.close();
}

function later(): void {
  if (syncSoon) return;
  syncSoon = true;
  queueMicrotask(() => {
    syncSoon = false;
    sync();
  });
}

// Brings the layer entries in line with the layers open: a layer that closes as another opens hands it its entry.
function sync(): void {
  if (moving) return;
  const want = live.map((l) => l.key);
  let n = 0;
  while (n < stack.length && n < want.length && stack[n] === want[n]) n++;
  const extra = stack.length - n;
  if (extra > 1 || (extra === 1 && n === want.length)) return step(-extra);
  if (extra === 1 && writeLayer(want[n], false)) n++;
  for (const key of want.slice(n)) if (!writeLayer(key, true)) return;
}

function writeLayer(key: string, push: boolean): boolean {
  if (push && !stack.length) save();
  const layers = push ? stack.length + 1 : stack.length;
  if (!write({ ccrc: 1, below: push ? cur.below + 1 : cur.below, layer: key, layers, ...base() }, location.href, push)) return false;
  if (push) stack.push(key);
  else stack[stack.length - 1] = key;
  return true;
}

function toHome(): void {
  const below = screenBelow();
  live = [];
  if (!cur.base) return step(-below - stack.length);
  step(-below - stack.length, () => put({ name: "home" }, { ccrc: 1, below: 0 }, false));
}

export const nav = {
  // Opens a screen over this one; from a layer, the screen takes the layer's place. Home is the bottom of the stack.
  open(route: Route): void {
    if (busy(() => nav.open(route))) return;
    if (same(route)) return show(true);
    if (route.name === "home") return toHome();
    live = [];
    const below = screenBelow();
    if (stack.length) return step(1 - stack.length, () => put(route, { ccrc: 1, below: below + 1, ...base() }, false));
    save();
    put(route, { ccrc: 1, below: below + 1, ...base() }, true);
  },
  // Puts a screen in place of this one, as a fork's conversation takes its source's; over home it opens.
  replace(route: Route): void {
    if (busy(() => nav.replace(route))) return;
    if (same(route)) return show(true);
    if (route.name === "home") return toHome();
    const below = screenBelow();
    if (!below && !cur.base) return nav.open(route);
    live = [];
    step(-stack.length, () => put(route, { ccrc: 1, below, ...base() }, false));
  },
  // Puts a screen right over home whatever is open, as a notification's conversation.
  top(route: Route): void {
    if (busy(() => nav.top(route))) return;
    if (same(route)) return show(true);
    if (route.name === "home") return toHome();
    const below = screenBelow();
    if (cur.base || below <= 1) return nav.replace(route);
    live = [];
    step(1 - below - stack.length, () => put(route, { ccrc: 1, below: 1 }, false));
  },
  // Leaves this screen, its layers with it, for the one under it; without one of the app's, for its parent.
  back(): void {
    if (busy(() => nav.back())) return;
    const route = parseRoute();
    if (screenBelow() > 0) {
      live = [];
      return step(-1 - stack.length);
    }
    if (route.name === "home") return;
    const up = lineage(route).at(-2) ?? { name: "home" };
    live = [];
    step(-stack.length, () => put(up, up.name === "home" ? { ccrc: 1, below: 0 } : { ccrc: 1, below: 0, base: true }, false));
  },
};

function dismiss(l: Layer): void {
  if (l.closing) return;
  if (!moving && live.at(-1) === l && stack.at(-1) === l.key) {
    l.closing = true;
    step(-1);
  } else l.close();
}

export interface LayerHandle {
  // Closes the layer as the back does.
  dismiss: () => void;
  // The layer is gone from the page; its entry leaves the history unless a back took it already.
  release: () => void;
}

// Gives a layer an entry of its own in the history until it is released: the back and the edge swipe close it with
// close, and so does Escape.
export function openLayer(close: () => void): LayerHandle {
  const layer: Layer = { key: `${LOAD}.${++seq}`, close, closing: false };
  live.push(layer);
  later();
  return {
    dismiss: () => dismiss(layer),
    release: () => {
      const i = live.indexOf(layer);
      if (i < 0) return;
      live.splice(i, 1);
      later();
    },
  };
}

// A layer for as long as the component is on the page; what it returns closes it through the history.
export function useLayer(close: () => void): () => void {
  const latest = useRef(close);
  useLayoutEffect(() => {
    latest.current = close;
  });
  const handle = useRef<LayerHandle>(undefined);
  useLayoutEffect(() => {
    const h = openLayer(() => latest.current());
    handle.current = h;
    return h.release;
  }, []);
  return useCallback(() => handle.current?.dismiss(), []);
}

// Closes the top layer as a back would.
export function dismissTop(): void {
  const top = live.at(-1);
  if (top) dismiss(top);
}

// What the screen kept under key when it was left, for the screen coming back to it.
export function kept(key: string): unknown {
  const st: unknown = history.state;
  return isEntry(st) && !st.layers ? st.keep?.[key] : undefined;
}

// Keeps what get gives under key in the screen's entry each time the app leaves it.
export function useKeep(key: string, get: () => unknown): void {
  const latest = useRef(get);
  useLayoutEffect(() => {
    latest.current = get;
  });
  useLayoutEffect(() => {
    const read = () => latest.current();
    keepers.set(key, read);
    return () => {
      if (keepers.get(key) === read) keepers.delete(key);
    };
  }, [key]);
}

// A state of the screen that comes back with it, from what it kept when it was left.
export function useKept<T>(key: string, init: T, valid: (v: unknown) => v is T): [T, Dispatch<SetStateAction<T>>] {
  const [value, set] = useState<T>(() => {
    const v = kept(key);
    return valid(v) ? v : init;
  });
  const now = useRef(value);
  now.current = value;
  useKeep(key, () => now.current);
  return [value, set];
}

const editable = (el: Element | null) => el instanceof HTMLElement && (el.isContentEditable || el.matches("input, textarea, select"));

// Escape closes what is on top: a layer, else the screen unless a field has the keyboard.
function onKey(e: KeyboardEvent): void {
  if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
  const top = live.at(-1);
  if (top) {
    e.preventDefault();
    return dismiss(top);
  }
  if (editable(document.activeElement) || parseRoute().name === "home") return;
  e.preventDefault();
  nav.back();
}

// The app opened at an address of its own: home first, then each screen down to it, so a back goes up to home. One
// reloaded over a layer steps back to its screen; one whose entries below are gone from the history starts over.
export function startNav(): void {
  history.scrollRestoration = "manual";
  const st: unknown = history.state;
  if (isEntry(st) && history.length > st.below) {
    cur = st;
    stack = Array.from({ length: st.layers ?? 0 }, () => "");
    later();
  } else {
    const href = location.href;
    const chain = lineage(parseRoute());
    chain.forEach((r, i) => write({ ccrc: 1, below: i }, i === chain.length - 1 ? href : `${location.pathname}${routeHash(r)}`, i > 0));
  }
  shown = routeHash(parseRoute());
  window.addEventListener("popstate", (e) => land(e.state));
  window.addEventListener("hashchange", () => {
    if (!isEntry(history.state) || routeHash(parseRoute()) !== shown) land(history.state);
  });
  window.addEventListener("keydown", onKey);
  window.addEventListener("pagehide", save);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") save();
  });
}
