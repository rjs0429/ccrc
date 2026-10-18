import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentFileChange, DisplayItem, GitChanges, GitFileChange, Hunk } from "../../../../broker/src/protocol.ts";
import { clock, errorText, shortPath } from "../../labels.ts";
import { call, composerInsert, useApp } from "../../state.ts";
import { DiffView, PatchStats } from "../diff/DiffView.tsx";
import type { DiffLine } from "../diff/hunks.ts";
import { Button, Icon, Sheet } from "../ui.tsx";
import { Failed, SmallButton, Waiting, inOrder, useFound } from "./parts.tsx";
import type { SheetProps } from "./types.ts";

// agent: the subagent that made the change, by what it is for.
interface Change {
  id: string;
  name: string;
  ts?: string;
  patch: Hunk[];
  cut?: number;
  agent?: string;
}

interface ChangedFile {
  file: string;
  changes: Change[];
  hunks: Hunk[];
  agents: number;
}

interface Picked {
  change: string;
  key: string;
  line: DiffLine;
}

type Tab = "session" | "git";

const NO_ITEMS: DisplayItem[] = [];
// While a subagent runs, its changes are asked for again this often.
const AGENTS_FOLLOW_MS = 5000;
// Claude Code may take a while over the folder's git changes, and ccrc again when it cannot.
const GIT_WAIT_MS = 45_000;

// The changes the conversation's tool calls and its subagents' made, by file, in the order the files were first changed.
function changedFiles(items: DisplayItem[], agents: AgentFileChange[]): ChangedFile[] {
  const own = new Set<string>();
  const all: (Change & { file: string })[] = [];
  for (const item of items) {
    if (item.kind !== "tool" || !item.file || !item.patch) continue;
    own.add(item.id);
    all.push({ id: item.id, name: item.name, ts: item.ts, patch: item.patch, cut: item.patchCut, file: item.file });
  }
  for (const a of agents) {
    if (!own.has(a.id)) all.push({ id: a.id, name: a.name, ts: a.ts, patch: a.patch, cut: a.patchCut, file: a.file, agent: a.agent ?? "" });
  }
  const files = new Map<string, ChangedFile>();
  for (const c of all.map((c, n) => ({ c, n })).sort((a, b) => (a.c.ts ?? "").localeCompare(b.c.ts ?? "") || a.n - b.n)) {
    const { file, ...change } = c.c;
    const f = files.get(file) ?? { file, changes: [], hunks: [], agents: 0 };
    f.changes.push(change);
    f.hunks.push(...change.patch);
    if (change.agent !== undefined) f.agents++;
    files.set(file, f);
  }
  return [...files.values()];
}

function inside(file: string, cwd: string): string | undefined {
  return cwd && file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : undefined;
}

// The line as a quote for the message, with its place in the file and whether it was added or removed.
function quote(path: string, line: DiffLine, comment: string): string {
  const no = line.kind === "removed" ? line.oldNo : line.newNo;
  const sign = line.kind === "removed" ? "-" : line.kind === "added" ? "+" : " ";
  return `> ${path}:${no}\n> ${sign}${line.text}\n\n${comment.trim()}`;
}

function changeTitle(c: Change): string {
  return [c.agent !== undefined ? (c.agent ? `에이전트 · ${c.agent}` : "에이전트") : "", c.name, c.ts ? clock(c.ts) : ""].filter(Boolean).join(" · ");
}

// The picked line and its comment, at the bottom of a file's diff, which go into the composer together.
function PickBar({ name, pick, onClear, onInsert }: { name: string; pick: Picked | null; onClear: () => void; onInsert: (comment: string) => void }) {
  const [comment, setComment] = useState("");
  if (!pick) return <div className="mt-3 px-1 text-xs text-muted">줄을 누르면 코멘트를 달아 입력창에 넣을 수 있습니다.</div>;
  return (
    <div className="sticky bottom-0 -mx-4 mt-3 border-t border-line bg-surface px-4 pt-2.5">
      <div className="mb-1.5 flex items-center gap-2 text-xs text-muted">
        <span className="min-w-0 flex-1 truncate font-mono">
          {name}:{pick.line.kind === "removed" ? pick.line.oldNo : pick.line.newNo}
        </span>
        <button onClick={onClear} aria-label="닫기" className="p-1">
          <Icon.x className="size-4" />
        </button>
      </div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        rows={2}
        placeholder="코멘트 (선택)"
        className="block w-full resize-none rounded-xl border border-line bg-bg px-3 py-2 text-[16px] leading-snug outline-none placeholder:text-muted focus:border-accent"
      />
      <Button kind="primary" className="mt-2 w-full" onClick={() => onInsert(comment)}>
        입력창에 넣기
      </Button>
    </div>
  );
}

function Back({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="mb-2 flex items-center gap-0.5 text-sm text-muted">
      <Icon.back className="size-4" />
      파일 목록
    </button>
  );
}

function AgentBadge() {
  return <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">에이전트</span>;
}

// The session's changes as its tool calls and its subagents' reported them.
function SessionChanges({ sessionId, cwd, onClose }: { sessionId: string; cwd: string; onClose: () => void }) {
  const items = useApp((s) => (s.chat?.sessionId === sessionId ? s.chat.items : NO_ITEMS));
  const partial = useApp((s) => s.chat?.sessionId === sessionId && Boolean(s.chat.hasMore || s.chat.gap));
  const found = useFound(sessionId, "changes", partial);
  const running = useApp((s) => (s.chat?.sessionId === sessionId ? (s.chat.state?.tasks ?? []).some((t) => t.status === "running" && (t.kind === "local_agent" || t.kind === "local_workflow")) : false));
  const [agents, setAgents] = useState<AgentFileChange[]>([]);
  const [agentsFailed, setAgentsFailed] = useState<string>();
  const files = useMemo(() => changedFiles(inOrder(items, found), agents), [items, found, agents]);
  const [open, setOpen] = useState<string | null>(null);
  const [pick, setPick] = useState<Picked | null>(null);
  const file = files.find((f) => f.file === open);
  const name = (path: string) => inside(path, cwd) ?? shortPath(path);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const read = (follow: boolean) =>
    call(sessionId, "agent_changes", follow ? { follow } : {}).then(
      (list) => mounted.current && (setAgents(list), setAgentsFailed(undefined)),
      (e: Error) => mounted.current && setAgentsFailed(errorText(e.message)),
    );
  useEffect(() => void read(false), [sessionId]);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void read(true), AGENTS_FOLLOW_MS);
    return () => clearInterval(t);
  }, [sessionId, running]);

  if (!file) {
    const waiting = partial && found === undefined;
    return (
      <>
        {waiting ? (
          <Waiting text="이전 대화의 변경을 불러오는 중입니다" />
        ) : (
          <div className="mb-2 px-1 text-xs text-muted">
            {partial && found === null ? "화면에 불러온 대화와 이 세션의 에이전트 기록에서 바뀐 파일을 보여 줍니다." : "대화와 이 세션의 에이전트 기록에서 바뀐 파일을 보여 줍니다."}
          </div>
        )}
        {agentsFailed && <div className="mb-2 px-1 text-xs text-danger">에이전트 기록을 읽지 못했습니다: {agentsFailed}</div>}
        {files.length === 0 && !waiting && <div className="px-1 py-2 text-sm text-muted">바뀐 파일이 없습니다</div>}
        {files.map((f) => (
          <button
            key={f.file}
            onClick={() => setOpen(f.file)}
            className="flex w-full items-center gap-2 rounded-xl px-2 py-2.5 text-left hover:bg-surface-2"
            data-change-file={f.agents ? "agent" : "session"}
          >
            <span className="min-w-0 flex-1 font-mono text-[13px] break-all">{name(f.file)}</span>
            {f.agents > 0 && <AgentBadge />}
            {f.changes.length > 1 && <span className="shrink-0 text-xs text-muted">{f.changes.length}회</span>}
            <PatchStats hunks={f.hunks} />
            <Icon.chevronRight className="size-4 shrink-0 text-muted" />
          </button>
        ))}
      </>
    );
  }

  return (
    <>
      <Back onClick={() => (setOpen(null), setPick(null))} />
      <div className="mb-3 flex items-start gap-2">
        <div className="min-w-0 flex-1 font-mono text-[13px] break-all">{name(file.file)}</div>
        <PatchStats hunks={file.hunks} />
      </div>
      <div className="space-y-2.5">
        {file.changes.map((c) => (
          <DiffView
            key={c.id}
            hunks={c.patch}
            cut={c.cut}
            full
            title={changeTitle(c)}
            picked={pick?.change === c.id ? pick.key : undefined}
            onLine={(line, key) => setPick({ change: c.id, key, line })}
          />
        ))}
      </div>
      <PickBar
        name={name(file.file)}
        pick={pick}
        onClear={() => setPick(null)}
        onInsert={(comment) => {
          if (!pick) return;
          composerInsert(quote(inside(file.file, cwd) ?? file.file, pick.line, comment));
          onClose();
        }}
      />
    </>
  );
}

const STATUS_LABEL: Record<GitFileChange["status"], string> = { added: "새 파일", removed: "지움", renamed: "이름 바뀜", copied: "복사", modified: "" };

function Counts({ f }: { f: GitFileChange }) {
  if (!f.added && !f.removed) return null;
  return (
    <span className="shrink-0 font-mono text-[12px]">
      {f.added > 0 && <span className="text-ok">+{f.added}</span>}
      {f.added > 0 && f.removed > 0 && " "}
      {f.removed > 0 && <span className="text-danger">−{f.removed}</span>}
    </span>
  );
}

// Why a changed file shows no lines.
function noLines(f: GitFileChange): string | undefined {
  if (f.hidden) return "내용 숨김";
  if (f.binary) return "바이너리";
  if (f.untracked) return "git이 아직 모르는 새 파일";
  if (f.large) return "너무 커서 생략";
  return f.hunks?.length ? undefined : "줄 변경 없음";
}

const HIDDEN_WHY = "키·토큰이 든 파일이거나 세션 폴더 밖의 파일이라 내용은 보여 주지 않습니다.";

// The folder's git changes, the way the official diff panel shows them.
function GitChangesTab({ sessionId, cwd, onClose }: { sessionId: string; cwd: string; onClose: () => void }) {
  const [data, setData] = useState<GitChanges>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<GitFileChange | null>(null);
  const [pick, setPick] = useState<Picked | null>(null);
  const load = () => {
    setLoading(true);
    setError(undefined);
    call(sessionId, "git_changes", {}, GIT_WAIT_MS)
      .then(setData, (e: Error) => setError(errorText(e.message)))
      .finally(() => setLoading(false));
  };
  useEffect(load, [sessionId]);

  const abs = (p: string) => (data?.root ? `${data.root}/${p}` : p);
  const shown = (p: string) => inside(abs(p), cwd) ?? p;
  const name = (f: GitFileChange) => (f.previousPath && f.newPath ? `${shown(f.previousPath)} → ${shown(f.newPath)}` : shown(f.newPath ?? f.path));

  if (open && data) {
    const target = shown(open.newPath ?? open.path);
    return (
      <>
        <Back onClick={() => (setOpen(null), setPick(null))} />
        <div className="mb-3 flex items-start gap-2">
          <div className="min-w-0 flex-1 font-mono text-[13px] break-all">{name(open)}</div>
          <Counts f={open} />
        </div>
        {open.hunks?.length ? (
          <DiffView
            hunks={open.hunks}
            cut={open.cut}
            full
            picked={pick?.key}
            onLine={(line, key) => setPick({ change: open.path, key, line })}
          />
        ) : (
          <div className="px-1 py-2 text-sm text-muted">{open.hidden ? HIDDEN_WHY : noLines(open)}</div>
        )}
        {open.hunks?.length ? (
          <PickBar
            name={target}
            pick={pick}
            onClear={() => setPick(null)}
            onInsert={(comment) => {
              if (!pick) return;
              composerInsert(quote(target, pick.line, comment));
              onClose();
            }}
          />
        ) : null}
      </>
    );
  }

  return (
    <>
      <div className="mb-2 flex items-start gap-2 px-1 text-xs text-muted" data-git-summary={data?.state ?? (error ? "error" : "loading")}>
        <div className="min-w-0 flex-1">
          {data?.state === "ok" && (
            <>
              <span className="block">{data.base ? `${data.base.branch}에서 갈라진 뒤의 변경입니다. 커밋한 것과 안 한 것을 함께 보여 줍니다.` : "마지막 커밋 뒤에 바뀐 것입니다."}</span>
              {data.stats && (
                <span className="block">
                  파일 {data.stats.files}개 · <span className="text-ok">+{data.stats.added}</span> <span className="text-danger">−{data.stats.removed}</span>
                </span>
              )}
              <span className="block">{data.via === "claude" ? "Claude Code가 자기 읽기 규칙으로 읽었습니다." : "ccrc가 git으로 읽었습니다."}</span>
            </>
          )}
          {data?.state === "none" && <span className="block">git 저장소가 아닙니다.</span>}
          {data?.state === "busy" && <span className="block">병합이나 리베이스가 진행 중이라 지금은 보여 줄 수 없습니다.</span>}
        </div>
        <SmallButton tall onClick={load} disabled={loading}>
          새로고침
        </SmallButton>
      </div>
      {loading && !data && <Waiting text="git에서 변경을 읽는 중입니다" />}
      {error && <Failed text={error} onRetry={load} />}
      {data?.state === "ok" && data.files.length === 0 && !data.more && <div className="px-1 py-2 text-sm text-muted">바뀐 파일이 없습니다</div>}
      {data?.files.map((f) => {
        const why = noLines(f);
        return (
          <button
            key={f.path}
            onClick={() => setOpen(f)}
            className="flex w-full items-center gap-2 rounded-xl px-2 py-2.5 text-left hover:bg-surface-2"
            data-git-file={f.hidden ? "hidden" : f.hunks?.length ? "lines" : "none"}
          >
            <span className="min-w-0 flex-1">
              <span className="block font-mono text-[13px] break-all">{name(f)}</span>
              {(STATUS_LABEL[f.status] || why) && (
                <span className="block text-xs text-muted">{[STATUS_LABEL[f.status], why && why !== "줄 변경 없음" ? why : ""].filter(Boolean).join(" · ")}</span>
              )}
            </span>
            <Counts f={f} />
            <Icon.chevronRight className="size-4 shrink-0 text-muted" />
          </button>
        );
      })}
      {data?.more ? (
        <div className="px-1 py-2 text-xs text-muted">
          {data.files.length ? `파일이 많아 ${data.more}개는 목록에서 뺐습니다.` : `바뀐 파일이 너무 많아(${data.more}개) 목록은 보여 주지 않습니다.`}
        </div>
      ) : null}
    </>
  );
}

// The session's changes in two views: as its tool calls and subagents reported them, and as git sees the whole folder.
export function ChangesSheet({ sessionId, onClose }: SheetProps) {
  const cwd = useApp((s) => (s.chat?.sessionId === sessionId ? s.chat.state?.cwd : undefined) ?? s.sessions?.find((x) => x.id === sessionId)?.cwd ?? "");
  const [tab, setTab] = useState<Tab>("session");
  return (
    <Sheet title="변경 사항" onClose={onClose}>
      <div className="mb-3 flex gap-1" role="tablist">
        {(["session", "git"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`relative rounded-lg px-3 py-1.5 text-sm after:absolute after:inset-x-0 after:-inset-y-1.5 ${tab === t ? "bg-surface-2 font-semibold" : "text-muted"}`}
            data-changes-tab={t}
          >
            {t === "session" ? "이 세션" : "git 전체"}
          </button>
        ))}
      </div>
      {tab === "session" ? <SessionChanges sessionId={sessionId} cwd={cwd} onClose={onClose} /> : <GitChangesTab sessionId={sessionId} cwd={cwd} onClose={onClose} />}
    </Sheet>
  );
}
