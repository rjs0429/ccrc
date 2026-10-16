import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Config {
  host: string;
  port: number;
  // Tailnet machine names (first DNS label, e.g. "phone") allowed through `tailscale serve`.
  allowedDevices: string[];
  // Requests without X-Forwarded-For come from this machine itself.
  allowLocal: boolean;
  // Claude Code CLI for broker sessions: a path, or "vscode" (or unset) for the one bundled in the newest VS Code
  // extension, else ~/.local/bin/claude, else the one bundled with the Agent SDK.
  claudePath?: string;
  // New sessions may start in these folders and below, besides folders that already have sessions.
  roots: string[];
  leaseIdleMinutes: number;
  sessionIdleMinutes: number;
}

const home = os.homedir();
export const FOLLOW_VSCODE = "vscode";

export const paths = {
  configDir: process.env.CCRC_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "ccrc"),
  stateDir: process.env.CCRC_STATE_DIR || path.join(process.env.XDG_STATE_HOME || path.join(home, ".local", "state"), "ccrc"),
  get configFile() {
    return path.join(this.configDir, "config.json");
  },
  get credentialsFile() {
    return path.join(this.configDir, "state.json");
  },
  get auditFile() {
    return path.join(this.stateDir, "audit.jsonl");
  },
  webDir: new URL("../../web/dist/", import.meta.url).pathname,
};

function defaults(): Config {
  return {
    host: "127.0.0.1",
    port: 8737,
    allowedDevices: [],
    allowLocal: true,
    claudePath: FOLLOW_VSCODE,
    roots: [],
    leaseIdleMinutes: 720,
    sessionIdleMinutes: 15,
  };
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// Replaces the file with a single rename: readers see either the old or the new content.
export function writeFileAtomic(file: string, data: string): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function loadConfig(): Config {
  const base = defaults();
  if (!fs.existsSync(paths.configFile)) {
    writeFileAtomic(paths.configFile, JSON.stringify(base, null, 2) + "\n");
    return base;
  }
  const raw = JSON.parse(fs.readFileSync(paths.configFile, "utf8")) as Partial<Config>;
  return { ...base, ...raw };
}
