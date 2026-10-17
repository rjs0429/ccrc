import fs from "node:fs";
import path from "node:path";
import type { UpdateInfo } from "./admin-protocol.ts";
import { writeFileAtomic, type Config } from "./config.ts";
import { installKind, readInstallInfo, type InstallKind } from "./install.ts";
import { paths } from "./paths.ts";
import { isNewer, latestTag, listTags, releaseUrl, updateSource, type UpdateChannel } from "./releases.ts";
import { run, type Runner } from "./run.ts";

const FIRST_DELAY_MS = 60_000;
const INTERVAL_MS = 24 * 3600_000;
// After updateChannel or updateRepo changes, so a few edits in a row make one look.
const RECHECK_DELAY_MS = 5000;

// <stateDir>/update-check.json: the last look for a new version, and the versions a notification went out for.
export interface UpdateCheckState {
  checkedAt?: string;
  source?: string;
  channel?: UpdateChannel;
  latest?: string;
  error?: string;
  notified?: string[];
}

export interface UpdateCheckOptions {
  config: Pick<Config, "updateCheck" | "updateChannel" | "updateRepo" | "updateNotify">;
  version: () => string | undefined;
  kind?: () => InstallKind;
  // The install's own source, when it is an install.
  installSource?: () => string | undefined;
  file?: string;
  runner?: Runner;
  now?: () => Date;
  // Sends the notification of a new version; false when no device could be told.
  notify?: (tag: string, url: string | undefined) => boolean;
  firstDelayMs?: number;
  intervalMs?: number;
  log?: (line: string) => void;
}

export function updateCheckFile(stateDir = paths.stateDir): string {
  return path.join(stateDir, "update-check.json");
}

export function readUpdateCheck(file = updateCheckFile()): UpdateCheckState {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as UpdateCheckState) : {};
  } catch {
    return {};
  }
}

export function writeUpdateCheck(state: UpdateCheckState, file = updateCheckFile()): void {
  writeFileAtomic(file, JSON.stringify(state, null, 2) + "\n");
}

// Looks for a release newer than this ccrc a minute after the broker starts and once a day, while updateCheck is on.
export class UpdateCheck {
  private o: Required<Omit<UpdateCheckOptions, "notify" | "installSource">> & Pick<UpdateCheckOptions, "notify" | "installSource">;
  private timers: NodeJS.Timeout[] = [];
  private soon?: NodeJS.Timeout;
  private running?: Promise<UpdateCheckState>;

  constructor(options: UpdateCheckOptions) {
    this.o = {
      kind: () => installKind(),
      installSource: () => readInstallInfo()?.source,
      file: updateCheckFile(),
      runner: run,
      now: () => new Date(),
      firstDelayMs: FIRST_DELAY_MS,
      intervalMs: INTERVAL_MS,
      log: (line) => console.log(line),
      ...options,
    };
  }

  start(): void {
    const tick = () => void this.checkIfOn();
    this.timers.push(setTimeout(tick, this.o.firstDelayMs), setInterval(tick, this.o.intervalMs));
    for (const t of this.timers) t.unref();
  }

  close(): void {
    for (const t of this.timers) clearTimeout(t);
    clearTimeout(this.soon);
    this.timers = [];
  }

  // A changed channel or repository is looked at shortly, not at the next daily look.
  configChanged(keys: string[]): void {
    if (!keys.some((k) => k === "updateCheck" || k === "updateChannel" || k === "updateRepo")) return;
    clearTimeout(this.soon);
    this.soon = setTimeout(() => void this.checkIfOn(), RECHECK_DELAY_MS);
    this.soon.unref();
  }

  source(): string {
    return updateSource({ source: this.o.installSource?.() ?? "" }, this.o.config.updateRepo);
  }

  private channel(): UpdateChannel {
    return this.o.config.updateChannel ?? "stable";
  }

  async checkIfOn(): Promise<UpdateCheckState | undefined> {
    if (this.o.config.updateCheck === false) return undefined;
    return this.check();
  }

  check(): Promise<UpdateCheckState> {
    this.running ??= this.look().finally(() => (this.running = undefined));
    return this.running;
  }

  info(): UpdateInfo {
    const s = readUpdateCheck(this.o.file);
    const channel = this.channel();
    const version = this.o.version();
    // A look made for another channel or repository no longer says what is new.
    const fits = s.channel === channel && s.source === this.source();
    const latest = fits ? s.latest : undefined;
    const url = latest ? releaseUrl(this.source(), latest) : undefined;
    return {
      ...(version ? { version } : {}),
      kind: this.o.kind(),
      enabled: this.o.config.updateCheck !== false,
      channel,
      ...(latest ? { latest } : {}),
      available: Boolean(latest && isNewer(latest, version)),
      ...(url ? { url } : {}),
      ...(fits && s.checkedAt ? { checkedAt: s.checkedAt } : {}),
      ...(fits && s.error ? { error: s.error } : {}),
    };
  }

  private async look(): Promise<UpdateCheckState> {
    const before = readUpdateCheck(this.o.file);
    const source = this.source();
    const channel = this.channel();
    const state: UpdateCheckState = { checkedAt: this.o.now().toISOString(), source, channel, ...(before.notified ? { notified: before.notified } : {}) };
    try {
      const latest = latestTag(await listTags(this.o.runner, source), channel);
      if (latest) state.latest = latest;
    } catch (e) {
      state.error = e instanceof Error ? e.message : String(e);
      if (before.source === source && before.channel === channel && before.latest) state.latest = before.latest;
      this.o.log(`ccrc: looking for a new version failed: ${state.error}`);
    }
    // Only an install is told: a development checkout is updated with git, not ccrc update.
    if (state.latest && !state.error && this.o.kind() === "installed" && isNewer(state.latest, this.o.version()) && !state.notified?.includes(state.latest)) {
      this.o.log(`ccrc: ${state.latest} is out (this is ${this.o.version()}); run ccrc update`);
      if (this.o.config.updateNotify !== false && this.o.notify?.(state.latest, releaseUrl(source, state.latest))) {
        state.notified = [...(state.notified ?? []), state.latest].slice(-20);
      }
    }
    try {
      writeUpdateCheck(state, this.o.file);
    } catch (e) {
      this.o.log(`ccrc: cannot write ${this.o.file}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return state;
  }
}
