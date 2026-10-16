import { worktreeBranch, worktreeOf, type WorktreeNameProblem } from "../../broker/src/worktree-names.ts";
import { baseName } from "./labels.ts";

// A session's folder as a line names it: the repository and the worktree for one in a worktree Claude Code made.
export function placeLabel(cwd: string): string {
  const wt = worktreeOf(cwd);
  return wt ? `${baseName(wt.root)} · worktree ${wt.name}` : baseName(cwd);
}

// The branch beside the folder, unless it says nothing more: HEAD, or the branch Claude Code named after the worktree.
export function shownBranch(cwd: string, branch?: string): string | undefined {
  if (!branch || branch === "HEAD") return undefined;
  const wt = worktreeOf(cwd);
  return wt && branch === worktreeBranch(wt.name) ? undefined : branch;
}

// The folder Home groups a session under: a worktree's repository.
export function groupFolder(cwd: string): string {
  return worktreeOf(cwd)?.root ?? cwd;
}

export const NAME_PROBLEM: Record<WorktreeNameProblem, string> = {
  empty: "이름을 입력하세요",
  long: "64자까지 쓸 수 있습니다",
  chars: "영문, 숫자, . _ - / 만 쓸 수 있습니다",
  segment: "/ 앞뒤가 비거나 . .. .git일 수 없습니다",
  ref: "..이 들어가거나 . 또는 .lock으로 끝날 수 없습니다",
};
