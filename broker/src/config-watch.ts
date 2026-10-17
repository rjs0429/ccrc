import fs from "node:fs";
import { ConfigError, RESTART_KEYS, readConfig, type Config } from "./config.ts";

const WATCH_INTERVAL_MS = 2000;

// Keys a running broker takes in as soon as config.json changes.
export const LIVE_KEYS = ["allowedDevices", "allowLocal", "roots", "brokerSessions", "leaseIdleMinutes", "sessionIdleMinutes"] as const;

export interface ConfigSinks {
  // Called with the config once its live keys hold the new values.
  apply: (config: Config, changed: string[]) => void;
  log: (line: string) => void;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Copies the live keys of `next` into `current`, which the broker's parts keep reading, and tells which keys changed:
// the ones taken in, and the ones that wait for a restart.
export function applyConfig(current: Config, next: Config): { applied: string[]; restart: string[] } {
  const applied = LIVE_KEYS.filter((k) => !same(current[k], next[k]));
  for (const k of applied) Object.assign(current, { [k]: next[k] });
  const restart = RESTART_KEYS.filter((k) => !same(current[k as keyof Config], next[k as keyof Config]));
  return { applied, restart };
}

// Reads config.json again whenever it changes. A file that cannot be used changes nothing and is logged; so is a
// change that needs a restart.
export function watchConfig(file: string, current: Config, sinks: ConfigSinks, intervalMs = WATCH_INTERVAL_MS): () => void {
  const reload = () => {
    let next: Config;
    try {
      const r = readConfig(file);
      for (const w of r.warnings) sinks.log(`ccrc: ${w}`);
      next = r.config;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return sinks.log(`ccrc: ${file} is gone; the broker keeps its config`);
      return sinks.log(`ccrc: config not applied: ${e instanceof ConfigError || e instanceof Error ? e.message : String(e)}`);
    }
    const { applied, restart } = applyConfig(current, next);
    if (applied.length) {
      sinks.log(`ccrc: config applied: ${applied.join(", ")}`);
      sinks.apply(current, applied);
    }
    if (restart.length) sinks.log(`ccrc: config change to ${restart.join(", ")} takes effect after a restart (systemctl --user restart ccrc)`);
  };
  const listener = (cur: fs.Stats, prev: fs.Stats) => {
    if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size || cur.ino !== prev.ino) reload();
  };
  fs.watchFile(file, { interval: intervalMs }, listener);
  return () => fs.unwatchFile(file, listener);
}
