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
}

// A word for a unit file: `%` is systemd's specifier sign, and a word with spaces or quotes goes in double quotes.
function word(s: string): string {
  const v = s.replace(/%/g, "%%");
  return /[\s"'\\]/.test(v) ? `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : v;
}

export const execLine = (s: Pick<UnitSpec, "ccrc">) => `ExecStart=${word(s.ccrc)} serve`;
export const nodeLine = (s: Pick<UnitSpec, "node">) => `Environment=${word(`CCRC_NODE=${s.node}`)}`;

export function unitText(s: UnitSpec): string {
  const extra = Object.entries(s.env).map(([k, v]) => `Environment=${word(`${k}=${v}`)}\n`);
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

// The program a unit file's ExecStart runs.
export function unitProgram(text: string): string | undefined {
  const line = text.split("\n").find((l) => l.trim().startsWith("ExecStart="));
  if (!line) return undefined;
  const v = line.trim().slice("ExecStart=".length);
  const m = v.startsWith('"') ? /^"((?:[^"\\]|\\.)*)"/.exec(v) : /^(\S+)/.exec(v);
  return m?.[1].replace(/\\(.)/g, "$1").replace(/%%/g, "%");
}
