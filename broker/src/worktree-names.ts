// Where Claude Code's --worktree puts a worktree and its branch, and the names it takes. Shared with the web client.

export const WORKTREE_NAME_MAX = 64;
const SEGMENT = /^[a-zA-Z0-9._-]+$/;
const IN_WORKTREE = /^(.+)\/\.claude\/worktrees\/([^/]+)(?:\/.*)?$/;

// "chars": a letter other than a-z, A-Z, 0-9, ".", "_", "-" and "/"; "segment": a "/"-separated part that is empty,
// "." or "..", or names .git; "ref": git takes no branch name with ".." or ending in "." or ".lock".
export type WorktreeNameProblem = "empty" | "long" | "chars" | "segment" | "ref";

// Claude Code's rule for a --worktree name, and git's for the branch made from it.
export function worktreeNameProblem(name: string): WorktreeNameProblem | undefined {
  if (!name) return "empty";
  if (name.length > WORKTREE_NAME_MAX) return "long";
  for (const segment of name.split("/")) {
    if (!segment || segment === "." || segment === ".." || segment.toLowerCase().replace(/\.+$/, "") === ".git") return "segment";
    if (!SEGMENT.test(segment)) return "chars";
  }
  if (name.includes("..") || name.endsWith(".") || name.endsWith(".lock")) return "ref";
  return undefined;
}

// A "/" in the name becomes "+" in the folder and the branch.
export function worktreeFolder(name: string): string {
  return name.replaceAll("/", "+");
}

export function worktreeBranch(name: string): string {
  return `worktree-${worktreeFolder(name)}`;
}

export function worktreePath(root: string, name: string): string {
  return `${root}/.claude/worktrees/${worktreeFolder(name)}`;
}

// The worktree Claude Code made that a working folder lies in: the repository root and the worktree's name.
export function worktreeOf(cwd: string): { root: string; name: string; path: string } | undefined {
  const m = IN_WORKTREE.exec(cwd);
  return m ? { root: m[1], name: m[2].replaceAll("+", "/"), path: `${m[1]}/.claude/worktrees/${m[2]}` } : undefined;
}

// ccrc-MMDD-xxxx: the day and four random letters or digits.
export function suggestWorktreeName(now = new Date(), random = Math.random): string {
  const day = `${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const letters = Array.from({ length: 4 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(random() * 36)]).join("");
  return `ccrc-${day}-${letters}`;
}
