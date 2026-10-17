import fs from "node:fs";
import path from "node:path";

// The systemd user service that runs the broker.

export const SERVICE = "ccrc.service";

export function unitFile(xdgConfigHome: string): string {
  return path.join(xdgConfigHome, "systemd", "user", SERVICE);
}

export interface UnitSpec {
  // bin/ccrc of the code to run: <dataDir>/current/bin/ccrc for an install, so an update only moves the link.
  ccrc: string;
  node: string;
  // The PATH tools that Claude runs in broker sessions are found on, as in the terminal setup ran from.
  path: string;
  // Folders setup was told to use (CCRC_CONFIG_DIR and the like), for the broker to use too.
  env: Record<string, string>;
  // Environment and EnvironmentFile lines of the unit this one replaces that setup does not write itself.
  kept?: string[];
}

// A word for a unit file: `%` is systemd's specifier sign, and a word with spaces or quotes goes in double quotes.
function word(s: string): string {
  const v = s.replace(/%/g, "%%");
  return /[\s"'\\]/.test(v) ? `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : v;
}

export const execLine = (s: Pick<UnitSpec, "ccrc">) => `ExecStart=${word(s.ccrc)} serve`;
export const nodeLine = (s: Pick<UnitSpec, "node">) => `Environment=${word(`CCRC_NODE=${s.node}`)}`;

export function unitText(s: UnitSpec): string {
  const extra = [...Object.entries(s.env).map(([k, v]) => `Environment=${word(`${k}=${v}`)}`), ...(s.kept ?? [])].map((l) => `${l}\n`);
  return `[Unit]
Description=ccrc broker
After=network-online.target

[Service]
${execLine(s)}
Environment=${word(`PATH=${s.path}`)}
Environment=CCRC_LOG_LEVEL=warn
${nodeLine(s)}
${extra.join("")}Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

// Whether a unit file runs this spec's code with its Node. PATH is not compared: it differs from shell to shell.
export function unitMatches(text: string | undefined, s: Pick<UnitSpec, "ccrc" | "node">): boolean {
  if (text === undefined) return false;
  const lines = text.split("\n").map((l) => l.trim());
  return lines.includes(execLine(s)) && lines.includes(nodeLine(s));
}

// The Environment lines of a unit setup does not write (proxies, API endpoints and the like the person added), and its
// EnvironmentFile lines. A line that sets any variable setup writes is left for setup's own.
export function keptLines(text: string, s: Pick<UnitSpec, "env">): string[] {
  const ours = new Set(["PATH", "CCRC_LOG_LEVEL", "CCRC_NODE", ...Object.keys(s.env)]);
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => {
      if (l.startsWith("EnvironmentFile=")) return true;
      if (!l.startsWith("Environment=")) return false;
      const keys = [...l.slice("Environment=".length).matchAll(/(?:^|\s)["']?([A-Za-z_][A-Za-z0-9_]*)=/g)].map((m) => m[1]);
      return keys.length > 0 && !keys.some((k) => ours.has(k));
    });
}

// Writes the unit whole or not at all.
export function writeUnit(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o644 });
  fs.renameSync(tmp, file);
}

// The program a unit file's ExecStart runs.
export function unitProgram(text: string): string | undefined {
  const line = text.split("\n").find((l) => l.trim().startsWith("ExecStart="));
  if (!line) return undefined;
  const v = line.trim().slice("ExecStart=".length);
  const m = v.startsWith('"') ? /^"((?:[^"\\]|\\.)*)"/.exec(v) : /^(\S+)/.exec(v);
  return m?.[1].replace(/\\(.)/g, "$1").replace(/%%/g, "%");
}
