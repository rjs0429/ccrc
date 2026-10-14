import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_FILES = 20_000;
const MAX_DEPTH = 8;
const LIST_MS = 30_000;
const GIT_TIMEOUT_MS = 5000;
const RESULTS = 30;
const MAX_QUERY = 256;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".venv", "__pycache__", "target"]);
const SEPARATORS = "/-_. ";

interface Listing {
  at: number;
  files: Promise<string[]>;
  recent?: Promise<string[]>;
}

const listings = new Map<string, Listing>();

// File search for "@" mentions in a session's folder: paths relative to it, best match first, or the
// most recently modified files for an empty query.
export async function searchFiles(cwd: string, query: string): Promise<string[]> {
  if (query.length > MAX_QUERY) throw Error("invalid request");
  const l = listing(cwd);
  const q = query.trim().replace(/^\.\//, "");
  if (!q) return (l.recent ??= l.files.then((files) => recentFiles(cwd, files)));
  return rankFiles(await l.files, q).slice(0, RESULTS);
}

function listing(cwd: string): Listing {
  const now = Date.now();
  for (const [dir, l] of listings) if (now - l.at > LIST_MS) listings.delete(dir);
  let l = listings.get(cwd);
  if (!l) {
    l = { at: now, files: listFiles(cwd) };
    listings.set(cwd, l);
  }
  return l;
}

// The files git knows in the folder (tracked and not ignored), or a bounded walk outside git. A repository
// counts only when its work tree holds the folder, as its config may place the work tree anywhere.
export async function listFiles(cwd: string): Promise<string[]> {
  return ((await inWorkTree(cwd)) ? await gitFiles(cwd) : undefined) ?? walk(cwd);
}

async function inWorkTree(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["-c", "core.fsmonitor=false", "-C", cwd, "rev-parse", "--show-toplevel"], { timeout: GIT_TIMEOUT_MS });
    const top = stdout.trim();
    const rel = path.relative(top, await fs.promises.realpath(cwd));
    return top !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

function gitFiles(cwd: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    const files = new Set<string>();
    let rest = "";
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(ok || files.size ? [...files] : undefined);
    };
    const child = spawn("git", ["-c", "core.fsmonitor=false", "-C", cwd, "ls-files", "-co", "--exclude-standard", "-z"], { stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => finish(false), GIT_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const parts = (rest + chunk).split("\0");
      rest = parts.pop() ?? "";
      for (const p of parts) {
        if (p) files.add(p);
        if (files.size >= MAX_FILES) return finish(true);
      }
    });
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

// Breadth first, so the shallow files are in when the limit cuts the walk short. Links are not followed.
async function walk(cwd: string): Promise<string[]> {
  const files: string[] = [];
  let seen = 0;
  let level = [""];
  for (let depth = 0; depth < MAX_DEPTH && level.length; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(path.join(cwd, dir), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (++seen > MAX_FILES) return files;
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) next.push(rel);
        } else if (e.isFile()) files.push(rel);
      }
    }
    level = next;
  }
  return files;
}

async function recentFiles(cwd: string, files: string[]): Promise<string[]> {
  const times: { file: string; mtime: number }[] = [];
  for (let i = 0; i < files.length; i += 256) {
    const batch = files.slice(i, i + 256);
    const stats = await Promise.all(batch.map((f) => fs.promises.lstat(path.join(cwd, f)).catch(() => undefined)));
    batch.forEach((file, j) => {
      const st = stats[j];
      if (st && !st.isDirectory()) times.push({ file, mtime: st.mtimeMs });
    });
  }
  return times
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, RESULTS)
    .map((t) => t.file);
}

// Positions of the query's characters found in order in `s`, starting at `from`.
function subsequence(s: string, q: string, from: number): number[] | undefined {
  const pos: number[] = [];
  let i = from;
  for (const c of q) {
    i = s.indexOf(c, i);
    if (i === -1) return undefined;
    pos.push(i++);
  }
  return pos;
}

function alignmentScore(file: string, pos: number[], base: number): number {
  let score = 0;
  for (let k = 0; k < pos.length; k++) {
    const i = pos[k];
    if (k > 0 && pos[k - 1] === i - 1) score += 8;
    if (i === 0 || SEPARATORS.includes(file[i - 1]) || (/[a-z]/.test(file[i - 1]) && /[A-Z]/.test(file[i]))) score += 6;
    if (i >= base) score += 4;
  }
  return score - (pos[pos.length - 1] - pos[0] + 1 - pos.length) * 0.5;
}

// Fuzzy match: the query's characters in order, ranked up for hits in the file name, runs of
// consecutive characters and word starts, and down for longer names and paths.
function fileScore(file: string, q: string): number | undefined {
  const lower = file.toLowerCase();
  const first = subsequence(lower, q, 0);
  if (!first) return undefined;
  const base = file.lastIndexOf("/") + 1;
  const candidates = [first, base > first[0] ? subsequence(lower, q, base) : undefined];
  const at = lower.lastIndexOf(q);
  if (at !== -1) candidates.push(Array.from({ length: q.length }, (_, k) => at + k));
  const best = Math.max(...candidates.map((pos) => (pos ? alignmentScore(file, pos, base) : -Infinity)));
  return best - (file.length - base) * 0.3 - file.length * 0.05;
}

export function rankFiles(files: string[], query: string): string[] {
  const q = query.toLowerCase();
  const scored: { file: string; score: number }[] = [];
  for (const file of files) {
    const score = fileScore(file, q);
    if (score !== undefined) scored.push({ file, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file)).map((s) => s.file);
}
