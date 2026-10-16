import assert from "node:assert/strict";
import { test } from "node:test";
import { errorText } from "../../web/src/labels.ts";
import { NAME_PROBLEM, groupFolder, offeredFolder, placeLabel, shownBranch } from "../../web/src/worktree.ts";

test("a session in a worktree reads as its repository and the worktree, without the branch named after it", () => {
  const wt = "/home/u/app/.claude/worktrees/feature+login";
  assert.equal(placeLabel(wt), "app · worktree feature/login");
  assert.equal(placeLabel("/home/u/app"), "app");
  assert.equal(shownBranch(wt, "worktree-feature+login"), undefined);
  assert.equal(shownBranch(wt, "main"), "main", "a branch switched to inside the worktree still shows");
  assert.equal(shownBranch("/home/u/app", "HEAD"), undefined);
  assert.equal(shownBranch("/home/u/app", "dev"), "dev");
  assert.equal(groupFolder(wt), "/home/u/app");
  assert.equal(groupFolder("/home/u/app"), "/home/u/app");
});

test("the new-session screen lists a worktree as its repository only when the broker offers the repository", () => {
  const wt = "/home/u/app/.claude/worktrees/x";
  assert.equal(offeredFolder(wt, new Set(["/home/u/app", wt])), "/home/u/app");
  assert.equal(offeredFolder(wt, new Set([wt])), wt, "a repository where no session ran and no root lies is not offered");
  assert.equal(offeredFolder("/home/u/lib", new Set()), "/home/u/lib");
});

test("every name problem and every worktree error reads in Korean", () => {
  for (const text of Object.values(NAME_PROBLEM)) assert.match(text, /[가-힣]/);
  const errors: [string, string][] = [
    ["not a git repository", "git 저장소가 아니라 worktree를 만들 수 없습니다"],
    ["repository has no commits", "커밋이 없는 저장소라 worktree를 만들 수 없습니다"],
    ["invalid worktree name: chars", "worktree 이름이 올바르지 않습니다"],
    ["branch worktree-x already exists", "이미 있는 브랜치(worktree-x)라 이 이름은 쓸 수 없습니다"],
    ["Claude Code could not start: Error: Can only use --worktree in a git repository", "Claude Code가 시작하지 못했습니다: Can only use --worktree in a git repository"],
    ["Claude Code did not start in 60s", "Claude Code가 60초 안에 시작하지 않았습니다"],
    ["Claude Code did not start in 60s: fetching origin", "Claude Code가 60초 안에 시작하지 않았습니다: fetching origin"],
    ["not a worktree session", "worktree에서 시작한 세션이 아닙니다"],
    ["worktree is in use in ccrc", "원격에서 실행 중이라 worktree를 지울 수 없습니다. 먼저 끝내세요"],
    ["worktree is in use in Terminal", "터미널에서 실행 중이라 worktree를 지울 수 없습니다. 먼저 끝내세요"],
    ["worktree is in use", "다른 Claude Code가 이 worktree에서 실행 중이라 지울 수 없습니다"],
    ["worktree is locked: moving disks", "직접 건 잠금이 있어 지우지 않았습니다 (moving disks)"],
    ["worktree is locked", "직접 건 잠금이 있어 지우지 않았습니다"],
    ["worktree has work to keep", "바뀐 파일이나 커밋이 생겼습니다. 다시 확인한 뒤 지우세요"],
    ["worktree has commits on no branch", "detached HEAD에만 있는 커밋이 있어 지우지 않았습니다. 브랜치를 만든 뒤 다시 하세요"],
    ["not a registered worktree: /r/.claude/worktrees/x", "git에 등록된 worktree가 아니라 지우지 않았습니다"],
    ["git worktree remove failed: Permission denied", "git 명령이 실패했습니다: Permission denied"],
  ];
  for (const [message, text] of errors) assert.equal(errorText(message), text, message);
});
