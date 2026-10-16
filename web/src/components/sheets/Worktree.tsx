import { useEffect, useRef, useState, type ReactNode } from "react";
import type { WorktreeRemoved, WorktreeStatus } from "../../../../broker/src/protocol.ts";
import { errorText, hostLabel, shortPath } from "../../labels.ts";
import { call, patchSession, toast } from "../../state.ts";
import { Button, Sheet, Spinner } from "../ui.tsx";
import { Failed, Waiting } from "./parts.tsx";

// git status, the commit count and the lock are read in turn, and a big worktree takes a while to remove.
const STATUS_WAIT_MS = 60_000;
const REMOVE_WAIT_MS = 120_000;

// Why the worktree cannot be removed now, if it cannot.
function removeBlocked(st: WorktreeStatus): string | undefined {
  if (st.running) return `${hostLabel(st.running)}에서 실행 중입니다. 실행을 끝낸 뒤 지울 수 있습니다.`;
  if (st.lock && !st.lock.claude) return `직접 건 잠금이 있어 지우지 않습니다${st.lock.reason ? ` (${st.lock.reason})` : ""}. git worktree unlock으로 푼 뒤 다시 하세요.`;
  if (st.lock?.alive) return "다른 Claude Code가 이 worktree에서 실행 중입니다.";
  if (st.exists && !st.registered) return "git에 등록된 worktree가 아니라 지우지 않습니다.";
  if (!st.exists && !st.registered) return st.branch ? `worktree는 이미 없습니다. 브랜치는 남아 있습니다 (${st.branch}).` : "worktree는 이미 없습니다.";
  if (st.stranded) return `detached HEAD에만 있는 커밋 ${st.stranded}개가 있어 지우지 않습니다. 브랜치를 만든 뒤 다시 하세요.`;
  return undefined;
}

// Whether the cleanup in the session menu can remove it once what blocks it now is over.
const removableLater = (st: WorktreeStatus) => Boolean(st.running || st.lock || st.stranded);

// What a second confirmation has to say: changed files that go, and commits whose branch stays.
function atStake(st: WorktreeStatus): string[] {
  return [
    ...(st.changed ? [`바뀐 파일 ${st.changed}개를 버립니다. 되돌릴 수 없습니다.`] : []),
    ...(st.commits ? [`커밋 ${st.commits}개는 브랜치 ${st.branch ?? ""}에 남겨 둡니다.`] : []),
  ];
}

export function removedText(r: WorktreeRemoved): string {
  const own = r.branch ? (r.branchKept ? `브랜치는 남겨 두었습니다 (${r.branch}${r.commits ? `, 커밋 ${r.commits}개` : ""})` : `${r.checkedOut ? `${r.branch} ` : ""}브랜치도 지웠습니다`) : "";
  return [own, r.checkedOut ? `${r.checkedOut} 브랜치는 그대로 두었습니다` : ""].filter(Boolean).join(". ");
}

function useStatus(sessionId: string): { status?: WorktreeStatus; error?: string; reload: () => void } {
  const [status, setStatus] = useState<WorktreeStatus>();
  const [error, setError] = useState<string>();
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    setError(undefined);
    call(sessionId, "worktree_status", {}, STATUS_WAIT_MS).then(
      (st) => live && setStatus(st),
      (e: Error) => live && setError(errorText(e.message)),
    );
    return () => {
      live = false;
    };
  }, [sessionId, round]);
  return { status, error, reload: () => setRound((r) => r + 1) };
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2 text-sm">
      <span className="shrink-0 text-muted">{label}</span>
      <span className="min-w-0 text-right break-words">{children}</span>
    </div>
  );
}

function lockText(lock: WorktreeStatus["lock"]): string {
  if (!lock) return "없음";
  if (!lock.claude) return "직접 건 잠금";
  return lock.alive ? "Claude Code가 쓰는 중" : "Claude Code · 끝난 프로세스";
}

function Summary({ st }: { st: WorktreeStatus }) {
  return (
    <>
      <div className="px-1" data-worktree-place>
        <div className="text-[15px] font-medium break-all">worktree {st.name}</div>
        <div className="mt-0.5 text-xs break-all text-muted">{shortPath(st.path)}</div>
        {st.branch && <div className="text-xs break-all text-muted">브랜치 {st.branch}</div>}
        {st.checkedOut && (
          <div className="mt-0.5 text-xs break-words text-muted" data-worktree-checked-out>
            지금 {st.checkedOut} 브랜치에 있습니다. 그 브랜치는 지우지 않습니다.
          </div>
        )}
      </div>
      {(st.exists || st.registered) && (
        <div className="mt-3 divide-y divide-line rounded-xl bg-bg px-3" data-worktree-status>
          <Row label="바뀐 파일">{st.changed ? `${st.changed}개` : "없음"}</Row>
          <Row label="이 브랜치에만 있는 커밋">{st.commits ? `${st.commits}개` : "없음"}</Row>
          <Row label="잠금">{lockText(st.lock)}</Row>
        </div>
      )}
    </>
  );
}

function IgnoreNote({ st }: { st: WorktreeStatus }) {
  if (st.ignored || !(st.exists || st.registered)) return null;
  return (
    <p className="mt-3 px-1 text-xs text-muted" data-worktree-ignore>
      .claude/worktrees/가 .gitignore에 없어 원래 폴더의 git status에 보입니다.
    </p>
  );
}

// The second confirmation, when changed files would go or commits stay on a branch.
function Confirm({ lines, label, busy, onCancel, onConfirm }: { lines: string[]; label: string; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="mt-4 rounded-xl border border-danger/40 px-3 py-3" data-worktree-confirm>
      <div className="text-[15px] font-medium">정말 지울까요?</div>
      {lines.map((l) => (
        <p key={l} className="mt-1 text-sm text-muted">
          {l}
        </p>
      ))}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button onClick={onCancel} disabled={busy}>
          취소
        </Button>
        <Button kind="danger" onClick={onConfirm} disabled={busy}>
          {busy ? <Spinner className="mx-auto size-5" /> : label}
        </Button>
      </div>
    </div>
  );
}

// The session menu's "worktree 정리": what the worktree holds, and removing it by hand.
export function WorktreeSheet({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { status, error, reload } = useStatus(sessionId);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  const [done, setDone] = useState<WorktreeRemoved>();

  const remove = (discard: boolean) => {
    setBusy(true);
    setFailed(undefined);
    call(sessionId, "worktree_remove", { discard }, REMOVE_WAIT_MS).then(
      (r) => {
        setDone(r);
        setBusy(false);
      },
      (e: Error) => {
        setFailed(errorText(e.message));
        setBusy(false);
        setConfirming(false);
        reload();
      },
    );
  };

  const blocked = status && removeBlocked(status);
  const stake = status ? atStake(status) : [];
  return (
    <Sheet title="worktree 정리" onClose={onClose}>
      {!status && !error && <Waiting text="worktree를 살펴보는 중…" />}
      {error && !status && <Failed text={error} onRetry={reload} />}
      {status && !done && (
        <>
          <Summary st={status} />
          {blocked && (
            <p className="mt-3 px-1 text-sm text-warn" data-worktree-blocked>
              {blocked}
            </p>
          )}
          {failed && (
            <p role="alert" className="mt-3 px-1 text-sm text-danger" data-worktree-failed>
              {failed}
            </p>
          )}
          {confirming ? (
            <Confirm lines={stake} label="지우기" busy={busy} onCancel={() => setConfirming(false)} onConfirm={() => remove(true)} />
          ) : (
            !blocked && (
              <Button kind="danger" className="mt-4 w-full" disabled={busy} onClick={() => (stake.length ? setConfirming(true) : remove(false))}>
                {busy ? <Spinner className="mx-auto size-5" /> : "worktree 지우기"}
              </Button>
            )
          )}
          <IgnoreNote st={status} />
          {!confirming && <p className="mt-2 px-1 text-xs text-muted">ccrc는 worktree를 저절로 지우지 않습니다.</p>}
        </>
      )}
      {done && (
        <div className="px-1" data-worktree-done>
          <div className="text-[15px] font-medium">worktree를 지웠습니다</div>
          {done.discarded > 0 && <p className="mt-1 text-sm text-muted">바뀐 파일 {done.discarded}개를 버렸습니다.</p>}
          {done.branch &&
            (done.branchKept ? (
              <p className="mt-1 text-sm text-muted">
                브랜치는 남겨 두었습니다.
                <span className="block break-all">
                  {done.branch}
                  {done.commits ? ` · 커밋 ${done.commits}개` : ""}
                </span>
              </p>
            ) : (
              <p className="mt-1 text-sm break-words text-muted">{done.checkedOut ? `${done.branch} 브랜치도 지웠습니다.` : "브랜치도 지웠습니다."}</p>
            ))}
          {done.checkedOut && <p className="mt-1 text-sm break-words text-muted">{done.checkedOut} 브랜치는 그대로 두었습니다.</p>}
          <Button className="mt-4 w-full" onClick={onClose}>
            닫기
          </Button>
        </div>
      )}
    </Sheet>
  );
}

// Archiving a session in a worktree asks whether the worktree goes too: removing it is the default when it holds no
// work, keeping it when it does. A worktree that cannot go now is left for the session menu; one already gone leaves
// nothing to ask, and the session is archived at once.
export function ArchiveWorktree({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { status, error } = useStatus(sessionId);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<"archive" | "remove">();
  const [failed, setFailed] = useState<string>();
  const gone = Boolean(status && !status.exists && !status.registered);
  const archivedGone = useRef(false);

  const archive = async (removed?: WorktreeRemoved) => {
    await call(sessionId, "archive", { archived: true });
    patchSession(sessionId, { archived: true });
    toast(removed ? ["보관하고 worktree를 지웠습니다", removedText(removed)].filter(Boolean).join(". ") : "보관했습니다");
    onClose();
  };
  const fail = (e: Error) => {
    setFailed(errorText(e.message));
    setBusy(undefined);
    setConfirming(false);
  };
  const keep = () => {
    setBusy("archive");
    setFailed(undefined);
    archive().catch(fail);
  };
  const remove = (discard: boolean) => {
    setBusy("remove");
    setFailed(undefined);
    call(sessionId, "worktree_remove", { discard }, REMOVE_WAIT_MS)
      .then((r) => archive(r))
      .catch(fail);
  };
  useEffect(() => {
    if (!gone || archivedGone.current) return;
    archivedGone.current = true;
    keep();
  }, [gone]);

  const blocked = status ? removeBlocked(status) : error;
  const stake = status ? atStake(status) : [];
  const clean = !stake.length;
  const keepButton = (kind: "primary" | "secondary") => (
    <Button kind={kind} className="w-full" disabled={Boolean(busy)} onClick={keep}>
      {busy === "archive" ? <Spinner className="mx-auto size-5" /> : blocked ? "보관하기" : "보관만 하기"}
    </Button>
  );
  const removeButton = (kind: "primary" | "danger") => (
    <Button kind={kind} className="w-full" disabled={Boolean(busy)} onClick={() => (clean ? remove(false) : setConfirming(true))}>
      {busy === "remove" ? <Spinner className="mx-auto size-5" /> : "보관하고 worktree 지우기"}
    </Button>
  );
  return (
    <Sheet title="보관하기" onClose={onClose}>
      <p className="px-1 text-sm text-muted">
        <span className="block">ccrc 목록에서만 숨깁니다.</span>
        <span className="block">VS Code와 claude --resume에는 그대로 보입니다.</span>
      </p>
      {(!status && !error) || (gone && !failed) ? (
        <div className="mt-3">
          <Waiting text={gone ? "보관하는 중…" : "worktree를 살펴보는 중…"} />
        </div>
      ) : (
        <>
          {!gone && (
            <>
              <div className="mt-3 px-1 text-[15px] font-medium">이 세션의 worktree도 지울까요?</div>
              {status && (
                <div className="mt-2">
                  <Summary st={status} />
                </div>
              )}
              {blocked && (
                <p className="mt-3 px-1 text-sm text-warn" data-worktree-blocked>
                  {blocked}
                  {status && removableLater(status) && <span className="block text-muted">나중에 세션 메뉴의 worktree 정리에서 지울 수 있습니다.</span>}
                </p>
              )}
            </>
          )}
          {failed && (
            <p role="alert" className="mt-3 px-1 text-sm text-danger" data-worktree-failed>
              {failed}
            </p>
          )}
          {confirming ? (
            <Confirm lines={stake} label="지우고 보관" busy={busy === "remove"} onCancel={() => setConfirming(false)} onConfirm={() => remove(true)} />
          ) : (
            <div className="mt-4 space-y-2" data-archive-choices>
              {blocked ? (
                keepButton("primary")
              ) : clean ? (
                <>
                  {removeButton("primary")}
                  {keepButton("secondary")}
                </>
              ) : (
                <>
                  {keepButton("primary")}
                  {removeButton("danger")}
                </>
              )}
            </div>
          )}
        </>
      )}
    </Sheet>
  );
}
