import type { EventEmitter } from "node:events";

const REPEAT_LOG_MS = 60_000;
const KEYS_MAX = 100;

const stack = (e: unknown) => (e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : String(e));

// The broker goes on after a failed promise nothing waited for, which is logged once a minute for each error. An
// exception nothing caught is logged and ends it, for systemd to start it again.
export function watchProcessErrors(
  proc: Pick<EventEmitter, "on"> = process,
  log: (line: string) => void = (line) => console.error(line),
  exit: (code: number) => void = (code) => process.exit(code),
  now: () => number = Date.now,
): void {
  const logged = new Map<string, number>();
  proc.on("unhandledRejection", (e: unknown) => {
    const text = stack(e);
    const key = text.split("\n")[0];
    const at = now();
    if (at - (logged.get(key) ?? -Infinity) < REPEAT_LOG_MS) return;
    logged.delete(key);
    logged.set(key, at);
    for (const old of [...logged.keys()].slice(0, -KEYS_MAX)) logged.delete(old);
    log(`ccrc: a promise failed with nothing waiting for it: ${text}`);
  });
  proc.on("uncaughtException", (e: unknown) => {
    log(`ccrc: stopping on an exception nothing caught: ${stack(e)}`);
    exit(1);
  });
}
