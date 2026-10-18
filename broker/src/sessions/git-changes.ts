import fs from "node:fs";
import path from "node:path";
import type { GitChanges, GitFileChange, Hunk } from "../protocol.ts";
import { inside, isSecretPath } from "./secret-paths.ts";
import { git } from "./worktrees.ts";

// The bounds Claude Code's own diff keeps to: git commands, the whole read, files listed, a file's diff and lines, and all
// diffs together. A folder with more changed files than LIST_MAX gets its counts only.
const GIT_MS = 5000;
const TOTAL_MS = 8000;
const FILES_MAX = 50;
const LIST_MAX = 500;
const UNTRACKED_MAX = 500;
const FILE_TEXT_MAX = 1_000_000;
const FILE_LINES_MAX = 400;
const TOTAL_TEXT_MAX = 2_000_000;
const LINE_MAX = 500;
const NAME_MAX = 4096;
// A file with more changed lines than this is not diffed at all.
const DIFF_LINES_MAX = 20_000;
const PARALLEL = 4;
const BUSY = ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"];
const STATUS: Record<string, GitFileChange["status"]> = { A: "added", D: "removed", R: "renamed", C: "copied" };
const STATUSES = new Set<unknown>(["added", "modified", "removed", "renamed", "copied"]);
const DIFF = ["-c", "diff.relative=false", "-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "-M"];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);
const name = (v: unknown): string | undefined => (typeof v === "string" && v && v.length <= NAME_MAX && !v.includes("\0") ? v : undefined);
const clip = (line: string): string => (line.length > LINE_MAX ? `${line.slice(0, LINE_MAX)}…` : line);

// The repository a folder belongs to: its top and git folder; undefined outside one.
async function repoOf(cwd: string): Promise<{ root: string; gitDir: string } | undefined> {
  const r = await git(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir"], GIT_MS);
  const [root, gitDir] = r.out.trim().split("\n");
  return r.code === 0 && root && gitDir ? { root, gitDir } : undefined;
}

const busy = (gitDir: string) => BUSY.some((f) => fs.existsSync(path.join(gitDir, f)));

// Where the paths of a change may be shown from: under one of the session's folders, never a key or token file, and on
// disk a regular file with no other name, as Claude Code's own diff demands.
async function shownIn(roots: string[]): Promise<(abs: string) => Promise<boolean>> {
  const real = await Promise.all(roots.map((r) => fs.promises.realpath(r).catch(() => path.resolve(r))));
  const under = (p: string) => real.some((r) => inside(p, r));
  return async (abs) => {
    if (isSecretPath(abs) || !under(abs)) return false;
    const st = await fs.promises.lstat(abs).catch(() => undefined);
    if (!st) return true;
    if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1) return false;
    const at = await fs.promises.realpath(abs).catch(() => abs);
    return !isSecretPath(at) && under(at);
  };
}

// The hunks of a unified diff, at most FILE_LINES_MAX lines; cut: the lines left out.
export function parseHunks(text: string): { hunks: Hunk[]; cut: number } {
  const hunks: Hunk[] = [];
  let at: Hunk | undefined;
  let lines = 0;
  let cut = 0;
  for (const line of text.split("\n")) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) {
      at = { oldStart: Number(h[1]), oldLines: Number(h[2] ?? 1), newStart: Number(h[3]), newLines: Number(h[4] ?? 1), lines: [] };
      hunks.push(at);
      continue;
    }
    if (!at || !/^[ +\-\\]/.test(line)) continue;
    if (lines >= FILE_LINES_MAX) cut++;
    else {
      at.lines.push(clip(line));
      lines++;
    }
  }
  return { hunks, cut };
}

// The default branch as Claude Code finds it: origin's HEAD, else origin's main or master, else main.
async function defaultBranch(root: string): Promise<string> {
  const head = await git(root, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"], GIT_MS);
  const named = head.code === 0 ? head.out.trim().replace(/^origin\//, "") : "";
  for (const b of [named, "main", "master"].filter(Boolean)) {
    if ((await git(root, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${b}`], GIT_MS)).code === 0) return b;
  }
  return "main";
}

// Where a branch left its base branch, from origin's copy of the base or the local one, whichever is later.
async function branchPoint(root: string, base: string): Promise<string | undefined> {
  const found: string[] = [];
  for (const ref of [`origin/${base}`, base]) {
    const r = await git(root, ["merge-base", "HEAD", ref], GIT_MS);
    if (r.code === 0 && r.out.trim()) found.push(r.out.trim());
  }
  const [a, b] = found;
  if (!b || a === b) return a;
  return (await git(root, ["merge-base", "--is-ancestor", a, b], GIT_MS)).code === 0 ? b : a;
}

// What the changes are against: the branch point while the branch is ahead of its base branch, else HEAD, else (no
// commit yet) the empty tree.
async function baseOf(root: string): Promise<{ ref: string; head?: string; base?: GitChanges["base"] }> {
  const head = (await git(root, ["rev-parse", "--verify", "-q", "HEAD"], GIT_MS)).out.trim();
  if (!head) return { ref: (await git(root, ["hash-object", "-t", "tree", "/dev/null"], GIT_MS)).out.trim() };
  const branch = (await git(root, ["symbolic-ref", "--short", "-q", "HEAD"], GIT_MS)).out.trim();
  if (!branch || branch.startsWith("-")) return { ref: "HEAD", head };
  const main = await defaultBranch(root);
  if (main === branch || !/^[\w.][\w./-]*$/.test(main)) return { ref: "HEAD", head };
  const point = await branchPoint(root, main);
  return point && point !== head ? { ref: point, head, base: { branch: main, ref: point } } : { ref: "HEAD", head };
}

// git diff --shortstat's line: "3 files changed, 5 insertions(+), 2 deletions(-)".
function shortStat(out: string): GitChanges["stats"] | undefined {
  const m = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(out);
  return m ? { files: Number(m[1]), added: Number(m[2] ?? 0), removed: Number(m[3] ?? 0) } : undefined;
}

interface Row {
  file: GitFileChange;
  paths: string[];
}

// git diff --raw -z and --numstat -z against `ref`, as rows in git's order.
async function tracked(root: string, ref: string): Promise<Row[] | undefined> {
  const [raw, num] = await Promise.all([git(root, [...DIFF, "--raw", "-z", ref, "--"], GIT_MS), git(root, [...DIFF, "--numstat", "-z", ref, "--"], GIT_MS)]);
  if (raw.code !== 0 || num.code !== 0) return undefined;
  const counts = new Map<string, { added: number; removed: number; binary: boolean }>();
  const n = num.out.split("\0");
  for (let i = 0; i < n.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(n[i]);
    if (!m) continue;
    const p = m[3] === "" ? n[(i += 2)] : m[3];
    counts.set(p, { added: m[1] === "-" ? 0 : Number(m[1]), removed: m[2] === "-" ? 0 : Number(m[2]), binary: m[1] === "-" && m[2] === "-" });
  }
  const rows: Row[] = [];
  const r = raw.out.split("\0");
  for (let i = 0; i < r.length; i++) {
    const m = /^:\d+ \d+ [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(r[i]);
    if (!m) continue;
    const two = m[1] === "R" || m[1] === "C";
    const from = r[++i];
    const to = two ? r[++i] : from;
    if (!from || !to) continue;
    const c = counts.get(to) ?? { added: 0, removed: 0, binary: false };
    rows.push({
      file: {
        path: two ? `${from} => ${to}` : to,
        status: STATUS[m[1]] ?? "modified",
        added: c.added,
        removed: c.removed,
        ...(c.binary ? { binary: true } : {}),
        ...(two ? { previousPath: from, newPath: to } : {}),
      },
      paths: two ? [from, to] : [to],
    });
  }
  return rows;
}

// Untracked files changed since the session began, as Claude Code lists the ones its session made.
async function untracked(root: string, since: number | undefined, known: Set<string>): Promise<Row[]> {
  if (since === undefined) return [];
  const r = await git(root, ["ls-files", "--others", "--exclude-standard", "--full-name", "-z"], GIT_MS);
  if (r.code !== 0) return [];
  const rows: Row[] = [];
  for (const p of r.out.split("\0").filter(Boolean).slice(0, UNTRACKED_MAX)) {
    if (known.has(p)) continue;
    const st = await fs.promises.lstat(path.join(root, p)).catch(() => undefined);
    if (st && Math.max(st.mtimeMs, st.ctimeMs) >= since) rows.push({ file: { path: p, status: "added", added: 0, removed: 0, untracked: true }, paths: [p] });
  }
  return rows;
}

// The changes ccrc works out with git for a session's folder, the way Claude Code's diff panel shows them, for a session
// without a process to ask. Only files under the session's folders (`roots`) show their contents, never key or token
// files. since: when the session began, which untracked files must have changed after to be listed.
export async function brokerChanges(cwd: string, roots: string[], since?: number): Promise<GitChanges> {
  const until = Date.now() + TOTAL_MS;
  const repo = await repoOf(cwd);
  if (!repo) return { state: "none", files: [], via: "broker" };
  const { root, gitDir } = repo;
  if (busy(gitDir)) return { state: "busy", root, files: [], via: "broker" };
  const base = await baseOf(root);
  const counted = shortStat((await git(root, [...DIFF, "--shortstat", base.ref, "--"], GIT_MS)).out);
  if (counted && counted.files > LIST_MAX) {
    return { state: "ok", root, ...(base.base ? { base: base.base } : {}), stats: counted, files: [], more: counted.files, via: "broker" };
  }
  const rows = await tracked(root, base.ref);
  if (!rows) throw Error("git diff failed");
  // Uncommitted changes come first, then untracked files, then what the branch committed, as Claude Code lists them.
  let open = rows;
  let committed: Row[] = [];
  if (base.base) {
    const now = await git(root, [...DIFF, "--name-only", "-z", "HEAD", "--"], GIT_MS);
    const changed = new Set(now.out.split("\0").filter(Boolean));
    open = rows.filter((r) => r.paths.some((p) => changed.has(p)));
    committed = rows.filter((r) => !open.includes(r));
  }
  const extra = rows.length > LIST_MAX ? [] : await untracked(root, since, new Set(rows.flatMap((r) => r.paths)));
  const ordered = [...open, ...extra, ...committed];
  const head = {
    state: "ok" as const,
    root,
    ...(base.base ? { base: base.base } : {}),
    stats: { files: ordered.length, added: rows.reduce((n, r) => n + r.file.added, 0), removed: rows.reduce((n, r) => n + r.file.removed, 0) },
    via: "broker" as const,
  };
  if (ordered.length > LIST_MAX) return { ...head, files: [], more: ordered.length };
  const shown = ordered.slice(0, FILES_MAX);
  const visible = await shownIn(roots);
  const work: Row[] = [];
  for (const r of shown) {
    if (r.file.binary || r.file.untracked) continue;
    if ((await Promise.all(r.paths.map((p) => visible(path.join(root, p))))).every(Boolean)) work.push(r);
    else r.file.hidden = true;
  }
  let room = TOTAL_TEXT_MAX;
  const next = async (): Promise<void> => {
    for (let r = work.shift(); r; r = work.shift()) {
      if (r.file.added + r.file.removed > DIFF_LINES_MAX || Date.now() >= until) {
        r.file.large = true;
        continue;
      }
      const d = await git(root, [...DIFF, "-U3", base.ref, "--", ...r.paths], Math.min(GIT_MS, Math.max(1, until - Date.now())));
      if (d.code !== 0 || d.out.length > FILE_TEXT_MAX || d.out.length > room) {
        r.file.large = true;
        continue;
      }
      room -= d.out.length;
      const { hunks, cut } = parseHunks(d.out);
      if (hunks.length) r.file.hunks = hunks;
      if (cut) r.file.cut = cut;
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, next));
  return { ...head, files: shown.map((r) => r.file), ...(ordered.length > shown.length ? { more: ordered.length - shown.length } : {}) };
}

function hunksOf(v: unknown): Hunk[] {
  if (!Array.isArray(v)) return [];
  let room = FILE_LINES_MAX;
  return v.flatMap((h): Hunk[] => {
    if (!isObj(h) || !Array.isArray(h.lines) || room <= 0) return [];
    const lines = h.lines.filter((l): l is string => typeof l === "string").slice(0, room).map(clip);
    room -= lines.length;
    return [{ oldStart: count(h.oldStart), oldLines: count(h.oldLines), newStart: count(h.newStart), newLines: count(h.newLines), lines }];
  });
}

// Claude Code's get_workspace_diff answer for a session's folder, with no contents for a key or token file or one outside
// the session's folders; undefined when it has no diff to give, which ccrc then looks into itself.
export async function claudeChanges(answer: unknown, cwd: string, roots: string[]): Promise<GitChanges | undefined> {
  const d = isObj(answer) && isObj(answer.diff) ? answer.diff : undefined;
  if (!d || !Array.isArray(d.perFileStats)) return undefined;
  const root = (await repoOf(cwd))?.root ?? cwd;
  const visible = await shownIn(roots);
  const hunks = new Map<string, unknown>();
  for (const h of Array.isArray(d.hunks) ? d.hunks : []) if (isObj(h) && typeof h.path === "string") hunks.set(h.path, h.hunks);
  const set = (v: unknown) => new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const [large, restricted] = [set(d.skippedLarge), set(d.restricted)];
  let room = TOTAL_TEXT_MAX;
  const files: GitFileChange[] = [];
  for (const row of d.perFileStats.slice(0, FILES_MAX)) {
    const p = isObj(row) ? name(row.path) : undefined;
    if (!isObj(row) || !p) continue;
    const previousPath = name(row.previousPath);
    const newPath = name(row.newPath);
    const f: GitFileChange = {
      path: p,
      status: STATUSES.has(row.status) ? (row.status as GitFileChange["status"]) : "modified",
      added: count(row.added),
      removed: count(row.removed),
      ...(row.isBinary === true ? { binary: true } : {}),
      ...(row.isUntracked === true ? { untracked: true } : {}),
      ...(previousPath ? { previousPath } : {}),
      ...(newPath ? { newPath } : {}),
    };
    const paths = [newPath ?? (previousPath ? undefined : p), previousPath].filter((x): x is string => Boolean(x));
    const shown = (await Promise.all(paths.map((x) => visible(path.join(root, x))))).every(Boolean);
    const h = hunksOf(hunks.get(p));
    const size = h.reduce((n, x) => n + x.lines.reduce((m, l) => m + l.length + 1, 0), 0);
    if (restricted.has(p) || (!shown && !f.binary && !f.untracked)) f.hidden = true;
    else if (large.has(p) || size > room) f.large = true;
    else if (h.length) {
      room -= size;
      f.hunks = h;
    }
    files.push(f);
  }
  const stats = isObj(d.stats) ? { files: count(d.stats.filesCount), added: count(d.stats.linesAdded), removed: count(d.stats.linesRemoved) } : undefined;
  const source = isObj(d.source) ? d.source : {};
  const base = source.kind === "branch" && name(source.baseBranch) && name(source.baseRef) ? { branch: source.baseBranch as string, ref: source.baseRef as string } : undefined;
  const more = (stats?.files ?? files.length) - files.length;
  return { state: "ok", root, ...(base ? { base } : {}), ...(stats ? { stats } : {}), files, ...(more > 0 ? { more } : {}), via: "claude" };
}
