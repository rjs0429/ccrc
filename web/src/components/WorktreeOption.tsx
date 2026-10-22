import { useId } from "react";
import type { GitFolderInfo, WorktreeChoice } from "../../../broker/src/protocol.ts";
import { worktreeBranch, worktreeFolder, worktreeNameProblem } from "../../../broker/src/worktree-names.ts";
import { k, t } from "../i18n/index.ts";
import { errorText, forkWorktreeText } from "../labels.ts";
import { Switch } from "../screens/settings/common.tsx";
import { NAME_PROBLEM } from "../worktree.ts";

// What the new-session screen keeps of the choice; name only once the user typed one.
export interface WorktreeDraft {
  on: boolean;
  base: WorktreeChoice["base"];
  name?: string;
}

export type FolderGit = GitFolderInfo | "loading" | { failed: string };

// Why the folder can have no worktree of its own, if it cannot.
export function worktreeBlocked(info: FolderGit): string | undefined {
  if (info === "loading") return t("확인하는 중…");
  if ("failed" in info) return t("확인하지 못했습니다: {error}", { error: errorText(info.failed) });
  if (info.subfolder) return forkWorktreeText("subfolder");
  if (info.hook) return undefined;
  if (!info.repo) return t("git 저장소가 아니라 worktree를 만들 수 없습니다");
  if (!info.head) return t("커밋이 없는 저장소라 worktree를 만들 수 없습니다");
  return undefined;
}

// The worktree the start asks for, or what is wrong with its name. fork: a fork's, always a new worktree from HEAD.
export function worktreeChoice(info: GitFolderInfo, draft: WorktreeDraft, fork?: boolean): { choice: WorktreeChoice } | { problem: string } {
  const name = draft.name ?? info.suggested;
  const problem = worktreeNameProblem(name);
  if (problem) return { problem: t(NAME_PROBLEM[problem]) };
  if (!info.hook && info.blocked.includes(name)) return { problem: t("이미 있는 브랜치({branch})라 이 이름은 쓸 수 없습니다", { branch: worktreeBranch(name) }) };
  if (fork && !info.hook && info.existing.includes(name)) return { problem: forkWorktreeText("exists") };
  return { choice: { name, base: draft.base } };
}

const BASES: [WorktreeChoice["base"], string][] = [
  ["fresh", k("원격 기본 브랜치")],
  ["head", k("지금 커밋")],
];

function baseNote(info: GitFolderInfo, base: WorktreeChoice["base"]): string {
  const at = [info.branch, info.head].filter(Boolean).join(" · ");
  const left = info.changed ? t("커밋하지 않은 변경(파일 {n}개)은 가져가지 않습니다.", { n: info.changed }) : t("커밋하지 않은 변경은 가져가지 않습니다.");
  if (base === "head") return `${t("지금 커밋({at})에서 시작합니다.", { at })} ${left}`;
  if (!info.origin) return `${t("원격이 없어 지금 커밋({at})에서 시작합니다.", { at })} ${left}`;
  const from = info.origin === "origin" ? t("origin의 기본 브랜치에서 시작합니다(받아오지 못하면 지금 커밋).") : t("{origin}에서 시작합니다.", { origin: info.origin });
  return `${from} ${t("푸시하지 않은 커밋과 커밋하지 않은 변경은 가져가지 않습니다.")}`;
}

// Sits under the chosen folder in the new-session screen's list: a switch for the session's own worktree, its name and
// the commit it starts from. error: why the last start in a worktree failed. fork: a fork's, a new worktree from the
// folder's HEAD with no choice; className: the frame, where it stands elsewhere.
export function WorktreeOption({
  info,
  draft,
  onChange,
  error,
  disabled,
  fork,
  className = "border-b border-line bg-accent-soft/40 pr-3 pb-1 pl-10 last:border-0",
}: {
  info: FolderGit;
  draft: WorktreeDraft;
  onChange: (d: WorktreeDraft) => void;
  error?: string;
  disabled?: boolean;
  fork?: boolean;
  className?: string;
}) {
  const id = useId();
  const blocked = worktreeBlocked(info);
  const git = blocked ? undefined : (info as GitFolderInfo);
  const on = draft.on && Boolean(git);
  const name = git ? (draft.name ?? git.suggested) : "";
  const picked = git && worktreeChoice(git, draft, fork);
  const problem = picked && "problem" in picked ? picked.problem : undefined;
  const reopens = git && !problem && git.existing.includes(name);
  const hint = blocked ?? (!on || problem ? t("이 폴더는 그대로 두고 새 브랜치에서 작업합니다") : git!.hook ? t("WorktreeCreate 훅이 worktree를 만듭니다") : undefined);
  return (
    <div className={className} data-worktree-option>
      <button
        role="switch"
        aria-checked={on}
        disabled={Boolean(blocked) || disabled}
        onClick={() => onChange({ ...draft, on: !on })}
        className="group flex w-full items-center gap-3 py-2.5 text-left"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] group-disabled:text-muted">{t("새 worktree에서 시작")}</span>
          <span className={`block text-xs text-muted ${hint ? "break-keep" : "break-all"}`} data-worktree-hint>
            {hint ?? (
              <>
                <span className="block">.claude/worktrees/{worktreeFolder(name)}</span>
                <span className="block">{t("브랜치 {branch}", { branch: worktreeBranch(name) })}</span>
              </>
            )}
          </span>
        </span>
        <span className="flex group-disabled:opacity-50">
          <Switch on={on} />
        </span>
      </button>
      {on && git && (
        <div className="space-y-3 pb-2.5">
          <div>
            <label htmlFor={`${id}-name`} className="mb-1 block text-xs font-medium text-muted">
              {t("이름")}
            </label>
            <input
              id={`${id}-name`}
              value={name}
              onChange={(e) => onChange({ ...draft, name: e.target.value.replace(/\s/g, "") })}
              disabled={disabled}
              aria-invalid={Boolean(problem)}
              aria-describedby={problem || reopens ? `${id}-name-note` : undefined}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="done"
              className="w-full rounded-lg border border-line bg-bg px-3 py-2 font-mono text-[16px] outline-none focus:border-accent aria-invalid:border-danger"
              data-worktree-name
            />
            {(problem || reopens) && (
              <p id={`${id}-name-note`} className={`mt-1 text-xs ${problem ? "text-danger" : "text-muted"}`} data-worktree-name-note>
                {problem ?? t("이미 있는 worktree를 엽니다")}
              </p>
            )}
          </div>
          {!git.hook && fork && (
            <p className="text-xs text-muted" data-worktree-base-note>
              {baseNote(git, "head")}
            </p>
          )}
          {!git.hook && !fork && (
            <div>
              <div id={`${id}-base`} className="mb-1 text-xs font-medium text-muted">
                {t("시작할 커밋")}
              </div>
              <div role="radiogroup" aria-labelledby={`${id}-base`} className="grid grid-cols-2 gap-0.5 rounded-lg bg-surface-2 p-0.5">
                {BASES.map(([v, label]) => (
                  <button
                    key={v}
                    role="radio"
                    aria-checked={draft.base === v}
                    disabled={disabled}
                    onClick={() => onChange({ ...draft, base: v })}
                    className={`min-h-9 rounded-md px-2 text-[13px] ${draft.base === v ? "bg-surface font-medium shadow-sm" : "text-muted"}`}
                    data-worktree-base={v}
                  >
                    {t(label)}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-muted" data-worktree-base-note>
                {baseNote(git, draft.base)}
              </p>
            </div>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="pb-2.5 text-xs break-words text-danger" data-worktree-error>
          {error}
        </p>
      )}
    </div>
  );
}
