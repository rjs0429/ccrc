import type { ClaudeSettingsView } from "../../../../broker/src/admin-protocol.ts";

export type Values = Record<string, unknown>;

export interface SaverIo {
  read(): Promise<ClaudeSettingsView>;
  // Writes { key: value, or null to remove } when the file still has baseHash.
  write(changes: Values, baseHash: string): Promise<ClaudeSettingsView>;
  // Whether a failed write found the file changed since baseHash.
  conflict(e: unknown): boolean;
}

// saved: the file has `after` where it had `before`. changed: the file's own value of the key changed meanwhile and
// stands. failed: nothing was written; the view was read again from the file when it could be.
export type SaveResult =
  | { t: "saved"; key: string; before: unknown; after: unknown; undo: boolean }
  | { t: "changed"; key: string }
  | { t: "failed"; key: string; error: unknown };

export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// What a change writes: an empty text or list removes the key.
export function stored(v: unknown): unknown {
  return v === "" || (Array.isArray(v) && v.length === 0) ? undefined : v;
}

const CONFLICT_TRIES = 3;

// Writes Claude Code settings one key at a time, in the order changed, each against the last answer's hash; a key changed
// again before its turn is written once, with its latest value. A write the file changed under goes again on the new
// file only while the key there still holds what the change was made from.
export class SettingsSaver {
  view: ClaudeSettingsView;
  private io: SaverIo;
  private report: (r: SaveResult) => void;
  private queue = new Map<string, { value: unknown; undo: boolean }>();
  private current?: { key: string; value: unknown };
  private running = false;
  private sent = 0;
  private listeners = new Set<() => void>();

  constructor(view: ClaudeSettingsView, io: SaverIo, report: (r: SaveResult) => void) {
    this.view = view;
    this.io = io;
    this.report = report;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get idle(): boolean {
    return !this.running;
  }

  // What the screen shows for a key: the latest value asked for until the file has it, then the file's.
  value(key: string): unknown {
    const queued = this.queue.get(key);
    if (queued) return queued.value;
    return this.current?.key === key ? this.current.value : this.view.values[key];
  }

  busy(key: string): boolean {
    return this.queue.has(key) || this.current?.key === key;
  }

  // Reads the file again; a read that a write overlapped is dropped, as the write's answer is newer.
  async reload(): Promise<void> {
    const mark = this.sent;
    if (this.running) return;
    const view = await this.io.read();
    if (this.running || mark !== this.sent) return;
    this.view = view;
    this.changed();
  }

  set(key: string, value: unknown, undo = false): void {
    this.queue.set(key, { value, undo });
    this.changed();
    if (!this.running) void this.run();
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  private async run(): Promise<void> {
    this.running = true;
    try {
      for (let next = this.queue.entries().next(); !next.done; next = this.queue.entries().next()) {
        const [key, { value, undo }] = next.value;
        this.queue.delete(key);
        this.current = { key, value };
        this.changed();
        const result = await this.write(key, value, undo);
        this.current = undefined;
        if (result) this.report(result);
        this.changed();
      }
    } finally {
      this.running = false;
    }
  }

  private async write(key: string, value: unknown, undo: boolean): Promise<SaveResult | undefined> {
    const after = stored(value);
    let base = this.view;
    if (base.problem) return { t: "failed", key, error: base.problem };
    if (same(after, base.values[key])) return undefined;
    for (let tries = 1; ; tries++) {
      try {
        this.sent++;
        this.view = await this.io.write({ [key]: after ?? null }, base.hash);
        return { t: "saved", key, before: base.values[key], after, undo };
      } catch (e) {
        if (!this.io.conflict(e) || tries === CONFLICT_TRIES) return this.failed(key, e);
        try {
          this.view = await this.io.read();
        } catch (readError) {
          return { t: "failed", key, error: readError };
        }
        if (this.view.problem) return { t: "failed", key, error: this.view.problem };
        if (!same(this.view.values[key], base.values[key])) return { t: "changed", key };
        base = this.view;
      }
    }
  }

  private async failed(key: string, error: unknown): Promise<SaveResult> {
    try {
      this.view = await this.io.read();
    } catch {}
    return { t: "failed", key, error };
  }
}
