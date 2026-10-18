import fs from "node:fs";
import path from "node:path";
import type { SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { paths } from "../paths.ts";
import { projectDirName } from "./history.ts";

const CHUNK = 1 << 20;
const SCAN_MAX = 32 * 1024 * 1024;
const CWD_KEY = Buffer.from('"cwd":');

// The working folder of a transcript's first line that names one.
export async function firstCwd(file: string, max = SCAN_MAX): Promise<string | undefined> {
  const fh = await fs.promises.open(file, "r");
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let line: Buffer[] = [];
    for (let pos = 0; pos < max; ) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const chunk = buf.subarray(0, bytesRead);
      let start = 0;
      for (let nl = chunk.indexOf(10); nl !== -1; nl = chunk.indexOf(10, start)) {
        line.push(Buffer.from(chunk.subarray(start, nl)));
        const cwd = cwdOf(Buffer.concat(line));
        line = [];
        if (cwd) return cwd;
        start = nl + 1;
      }
      if (start < bytesRead) line.push(Buffer.from(chunk.subarray(start)));
    }
    return line.length ? cwdOf(Buffer.concat(line)) : undefined;
  } finally {
    await fh.close();
  }
}

function cwdOf(line: Buffer): string | undefined {
  if (!line.includes(CWD_KEY)) return undefined;
  try {
    const row = JSON.parse(line.toString("utf8")) as { cwd?: unknown } | null;
    return typeof row?.cwd === "string" && path.isAbsolute(row.cwd) ? row.cwd : undefined;
  } catch {
    return undefined;
  }
}

// The SDK reads a session's working folder from the start of its transcript, which a long first message can fill.
// Such a session takes the one folder the other sessions in its project folder share, or else the first cwd its
// transcript records; what a transcript gave is kept while its size and time stay, or while it only grows.
export class SessionCwds {
  private root: () => string;
  private found = new Map<string, { size: number; mtimeMs: number; cwd?: string }>();

  constructor(root = () => paths.claudeProjectsDir) {
    this.root = root;
  }

  async fill(infos: SDKSessionInfo[]): Promise<SDKSessionInfo[]> {
    const missing = new Set(infos.filter((i) => !i.cwd).map((i) => i.sessionId));
    if (!missing.size) return infos;
    const shared = new Map<string, Set<string>>();
    for (const i of infos) {
      if (!i.cwd) continue;
      const dir = projectDirName(i.cwd);
      shared.set(dir, (shared.get(dir) ?? new Set()).add(i.cwd));
    }
    const cwds = new Map<string, string>();
    for (const [id, file] of await this.locate(missing)) {
      const folders = shared.get(path.basename(path.dirname(file)));
      const cwd = folders?.size === 1 ? [...folders][0] : await this.read(file);
      if (cwd) cwds.set(id, cwd);
    }
    return infos.map((i) => (cwds.has(i.sessionId) ? { ...i, cwd: cwds.get(i.sessionId) } : i));
  }

  private async locate(ids: Set<string>): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const root = this.root();
    const dirs = await fs.promises.readdir(root).catch(() => [] as string[]);
    for (const dir of dirs) {
      for (const id of ids) {
        const file = path.join(root, dir, `${id}.jsonl`);
        if (!out.has(id) && fs.existsSync(file)) out.set(id, file);
      }
    }
    return out;
  }

  private async read(file: string): Promise<string | undefined> {
    const st = await fs.promises.stat(file).catch(() => undefined);
    if (!st) return undefined;
    const known = this.found.get(file);
    if (known && ((known.size === st.size && known.mtimeMs === st.mtimeMs) || (known.cwd && st.size > known.size))) return known.cwd;
    const cwd = await firstCwd(file).catch(() => undefined);
    this.found.set(file, { size: st.size, mtimeMs: st.mtimeMs, cwd });
    return cwd;
  }
}
