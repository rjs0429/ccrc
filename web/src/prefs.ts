import { useSyncExternalStore } from "react";

// Preferences of this browser, kept in localStorage.
export interface Prefs {
  // Enter sends the message (Shift+Enter adds a line); otherwise Ctrl/Cmd+Enter sends.
  enterToSend: boolean;
}

const KEY = "ccrc.prefs";
const DEFAULTS: Prefs = { enterToSend: false };
const listeners = new Set<() => void>();

function load(): Prefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>) };
  } catch {
    return DEFAULTS;
  }
}

let prefs = load();

export function getPrefs(): Prefs {
  return prefs;
}

export function setPrefs(patch: Partial<Prefs>): void {
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {}
  for (const l of listeners) l();
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => prefs,
  );
}
