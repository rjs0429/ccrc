import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ModelOption, TaskInfo, WorkflowAgent, WorkflowAgentState, WorkflowInfo } from "../../../../broker/src/protocol.ts";
import { duration, errorText, modelLabel, taskKindLabel } from "../../labels.ts";
import { call, useApp } from "../../state.ts";
import type { TranscriptRef } from "../agents/links.ts";
import { SHELL_KINDS } from "../agents/output.ts";
import { ShellOutput } from "../agents/ShellOutput.tsx";
import { Transcript } from "../agents/Transcript.tsx";
import { agentMap, elapsed, findNode, type AgentMap, type AgentNode, type NodeStatus } from "../agents/tree.ts";
import { Icon, Sheet } from "../ui.tsx";
import { tokens } from "./Context.tsx";
import { SmallButton, Waiting } from "./parts.tsx";

const NO_MODELS: ModelOption[] = [];
// Deeper levels stay at this indent and name their depth.
const MAX_INDENT = 4;
const PAST_SHOWN = 20;
const TICK_MS = 1000;

const STATUS_LABEL: Record<NodeStatus, string> = {
  waiting: "권한 대기",
  running: "실행 중",
  completed: "완료",
  failed: "실패",
  stopped: "중지됨",
  unknown: "결과 모름",
};
const AGENT_STATE_LABEL: Record<WorkflowAgentState, string> = { queued: "대기", running: "실행 중", done: "완료", failed: "실패" };
const agentMark = (a: WorkflowAgent, ended?: boolean): NodeStatus | "queued" =>
  a.state === "done" ? "completed" : a.state === "failed" ? "failed" : ended ? "stopped" : a.state;
const TASK_STATUS: Record<TaskInfo["status"], NodeStatus> = { running: "running", completed: "completed", failed: "failed", stopped: "stopped" };

function Mark({ status, small }: { status: NodeStatus | "queued"; small?: boolean }) {
  const box = small ? "size-3.5" : "size-4";
  switch (status) {
    case "running":
      return (
        <span className={`flex ${box} shrink-0 items-center justify-center`} data-mark="running">
          <span className="size-2.5 animate-pulse rounded-full bg-accent" />
        </span>
      );
    case "waiting":
      return (
        <span className={`flex ${box} shrink-0 items-center justify-center rounded-full bg-warn text-[10px] font-bold text-white`} data-mark="waiting">
          !
        </span>
      );
    case "completed":
      return <Icon.check className={`${box} shrink-0 text-ok`} />;
    case "failed":
      return <Icon.x className={`${box} shrink-0 text-danger`} />;
    case "stopped":
      return (
        <span className={`flex ${box} shrink-0 items-center justify-center`} data-mark="stopped">
          <span className="size-2.5 rounded-full border-2 border-muted" />
        </span>
      );
    case "queued":
      return (
        <span className={`flex ${box} shrink-0 items-center justify-center`} data-mark="queued">
          <span className="size-2.5 rounded-full border border-dashed border-muted" />
        </span>
      );
    default:
      return <span className={`flex ${box} shrink-0 items-center justify-center text-xs font-semibold text-muted`}>?</span>;
  }
}

const live = (n: AgentNode) => n.status === "running" || n.status === "waiting";

interface Clock {
  now: number;
  stateAt?: number;
}

function timeOf(n: { ms?: number }, running: boolean, clock: Clock): string {
  const ms = elapsed(n.ms, running, clock.stateAt, clock.now);
  return ms === undefined ? "" : duration(ms);
}

function kindText(n: AgentNode): string {
  return n.workflow ? "워크플로" : (n.agentType ?? "서브에이전트");
}

function workflowLine(n: AgentNode, clock: Clock): string {
  const p = n.progress;
  const parts = [
    p?.phases.length ? `단계 ${(p.phase ?? 0) + 1}/${p.phases.length}` : "",
    p?.total ? `에이전트 ${p.done}/${p.total} 끝남` : n.ended?.agents ? `에이전트 ${n.ended.agents}` : "",
    timeOf(n, live(n), clock),
    n.tokens !== undefined ? `${tokens(n.tokens)} 토큰` : "",
  ];
  return parts.filter(Boolean).join(" · ");
}

function agentLine(n: AgentNode): string {
  return [kindText(n), n.tokens !== undefined ? `${tokens(n.tokens)} 토큰` : "", n.tools ? `도구 ${n.tools}회` : ""].filter(Boolean).join(" · ");
}

// A workflow agent's row; one whose id is known opens its transcript.
function WorkflowAgentRow({ a, onRead }: { a: WorkflowAgent; onRead: (r: TranscriptRef) => void }) {
  const body = (
    <>
      <Mark status={agentMark(a)} small />
      <span className="min-w-0 flex-1 truncate">{a.label}</span>
      <span className="shrink-0 text-xs text-muted">{[a.tokens ? tokens(a.tokens) : "", a.state === "failed" ? "오류" : a.activity].filter(Boolean).join(" · ")}</span>
    </>
  );
  if (!a.id) {
    return (
      <div className="flex items-center gap-2 py-1 text-[13px]" data-workflow-agent={a.label}>
        {body}
      </div>
    );
  }
  return (
    <button onClick={() => onRead({ agentId: a.id, title: a.label })} className="flex min-h-9 w-full items-center gap-2 py-1 text-left text-[13px]" data-workflow-agent={a.label}>
      {body}
      <Icon.chevronRight className="size-3.5 shrink-0 text-muted" />
    </button>
  );
}

function NodeRow({ node, level, clock, onOpen, onRead }: { node: AgentNode; level: number; clock: Clock; onOpen: (n: AgentNode) => void; onRead: (r: TranscriptRef) => void }) {
  const [all, setAll] = useState(false);
  const running = live(node);
  const agents = node.progress?.agents ?? [];
  const shownAgents = all ? agents : agents.filter((a) => a.state === "running" || a.state === "failed");
  const deep = level > MAX_INDENT;
  return (
    <div data-node={node.key} data-status={node.status}>
      <button onClick={() => onOpen(node)} className="flex min-h-11 w-full items-start gap-2 rounded-lg px-2 py-2 text-left hover:bg-surface-2">
        <span className="mt-0.5">
          <Mark status={node.status} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="line-clamp-2 min-w-0 flex-1 text-[15px]">
              {deep && <span className="mr-1 text-xs text-muted">↳{level}</span>}
              {node.workflow ? `워크플로 · ${node.name ?? node.title}` : node.title}
            </span>
            <span className="shrink-0 text-xs text-muted tabular-nums">{timeOf(node, running, clock)}</span>
          </span>
          <span className="mt-0.5 block text-xs text-muted">{node.workflow ? workflowLine(node, clock) : agentLine(node)}</span>
          {node.status === "waiting" ? (
            <span className="mt-0.5 block text-xs font-medium text-warn">권한 요청을 기다립니다 ›</span>
          ) : (
            running &&
            node.activity && <span className="mt-0.5 block truncate text-xs text-muted/80">지금: {node.activity}</span>
          )}
        </span>
      </button>
      {shownAgents.length > 0 && (
        <div className="mb-1 ml-8 border-l border-muted/40 pl-2">
          {shownAgents.map((a, n) => (
            <WorkflowAgentRow key={`${a.label}-${n}`} a={a} onRead={onRead} />
          ))}
        </div>
      )}
      {agents.length > shownAgents.length && (
        <button onClick={() => setAll(true)} className="mb-1 ml-8 min-h-8 px-2 text-xs font-medium text-accent">
          모두 보기 ›
        </button>
      )}
      {node.children.length > 0 && (
        <div className={deep || level >= MAX_INDENT ? "" : "ml-3 border-l border-muted/40 pl-1"}>
          {node.children.map((c) => (
            <NodeRow key={c.key} node={c} level={level + 1} clock={clock} onOpen={onOpen} onRead={onRead} />
          ))}
        </div>
      )}
    </div>
  );
}

function BackgroundRow({
  task,
  parent,
  clock,
  stopping,
  error,
  onStop,
  onOpen,
}: {
  task: TaskInfo;
  parent?: string;
  clock: Clock;
  stopping: boolean;
  error?: string;
  onStop?: () => void;
  onOpen: () => void;
}) {
  const running = task.status === "running";
  const meta = [taskKindLabel(task.kind ?? task.type), STATUS_LABEL[TASK_STATUS[task.status]], timeOf(task, running, clock)].filter(Boolean).join(" · ");
  return (
    <div className="flex items-start gap-2 border-b border-line px-2 py-2 last:border-0" data-task={task.id}>
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-start gap-2 text-left">
        <span className="mt-0.5">
          <Mark status={TASK_STATUS[task.status]} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-[15px]">{task.description || "(설명 없음)"}</span>
          <span className="mt-0.5 block text-xs text-muted">
            {meta}
            {parent ? ` · ← ${parent}` : ""}
          </span>
          {error && <span className="mt-1 block text-xs text-danger">{error}</span>}
        </span>
      </button>
      {running && onStop && (
        <SmallButton onClick={onStop} disabled={stopping} tone="text-danger">
          {stopping ? "중지 중…" : "중지"}
        </SmallButton>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-4">
      <div className="mb-1.5 px-1 text-xs font-semibold text-muted">{title}</div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <div className="text-xs font-semibold text-muted">{label}</div>
      <div className="mt-0.5 text-sm">{children}</div>
    </div>
  );
}

type Selected = { key: string; itemId?: string; task?: string };

interface DetailProps {
  node?: AgentNode;
  gone: boolean;
  parent: string;
  clock: Clock;
  canStop: boolean;
  stopping: boolean;
  error?: string;
  onBack: () => void;
  onStop: (taskId: string) => void;
  onJump: (itemId: string) => void;
  onPending: (requestId: string) => void;
  onRead: (r: TranscriptRef) => void;
}

// The transcript of a subagent on the map: by its id, and by its Agent call for one whose id is not known.
const transcriptOf = (n: AgentNode): TranscriptRef => ({ ...(n.agentId ? { agentId: n.agentId } : {}), ...(n.itemId ? { toolUseId: n.itemId } : {}), title: n.title });

function Actions({ node, canStop, stopping, onStop, onJump, onRead, stopLabel }: Pick<DetailProps, "canStop" | "stopping" | "onStop" | "onJump" | "onRead"> & { node: AgentNode; stopLabel: string }) {
  const stoppable = canStop && node.task?.status === "running";
  const readable = !node.workflow && Boolean(node.agentId || node.itemId);
  if (!node.itemId && !stoppable && !readable) return null;
  return (
    <div className="mt-4 flex items-center gap-2">
      {readable && (
        <SmallButton tall onClick={() => onRead(transcriptOf(node))}>
          기록 보기
        </SmallButton>
      )}
      {node.itemId && (
        <SmallButton tall onClick={() => onJump(node.itemId!)}>
          대화에서 보기
        </SmallButton>
      )}
      {stoppable && (
        <span className="ml-auto">
          <SmallButton tall tone="text-danger" disabled={stopping} onClick={() => onStop(node.task!.id)}>
            {stopping ? "중지 중…" : stopLabel}
          </SmallButton>
        </span>
      )}
    </div>
  );
}

function Back({ onBack }: { onBack: () => void }) {
  return (
    <button onClick={onBack} className="-ml-1 mb-2 flex min-h-11 items-center gap-1 px-1 text-sm font-medium text-accent sm:hidden" data-map-back>
      <Icon.back className="size-4" /> 지도
    </button>
  );
}

// A workflow's phases, each done once all its agents are, and the one it is in now.
function Phases({ p }: { p: WorkflowInfo }) {
  return (
    <Field label="단계">
      <ol className="space-y-0.5">
        {p.phases.map((title, i) => {
          const agents = p.agents.filter((a) => a.phase === i);
          const done = agents.length > 0 && agents.every((a) => a.state === "done");
          const current = i === p.phase && !done;
          return (
            <li key={i} className={`flex items-center gap-2 ${current ? "font-medium" : "text-muted"}`} data-phase={title}>
              {done ? <Icon.check className="size-3.5 text-ok" /> : current ? <span className="mx-0.5 size-2.5 rounded-full bg-accent" /> : <span className="mx-0.5 size-2.5 rounded-full border border-muted" />}
              {title}
            </li>
          );
        })}
      </ol>
    </Field>
  );
}

// A workflow's agents; one whose id is known opens its transcript. ended: the workflow is over, so an agent the
// journal leaves running never finished.
function WorkflowAgents({ p, ended, onRead }: { p: WorkflowInfo; ended?: boolean; onRead: (r: TranscriptRef) => void }) {
  return (
    <Field label={`에이전트 ${p.total}`}>
      {p.agents.map((a, n) => {
        const body = (
          <>
            <span className="mt-0.5">
              <Mark status={agentMark(a, ended)} small />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate">{a.label}</span>
              <span className="block text-xs text-muted">
                {[ended && a.state === "running" ? "끝나지 않음" : AGENT_STATE_LABEL[a.state], ended && p.phases.length > 1 && a.phase !== undefined ? p.phases[a.phase] : "", a.tokens ? `${tokens(a.tokens)} 토큰` : "", a.tools ? `도구 ${a.tools}회` : "", a.activity]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              {a.error && <span className="block text-xs text-danger">{a.error}</span>}
            </span>
          </>
        );
        return a.id ? (
          <button key={`${a.id}-${n}`} onClick={() => onRead({ agentId: a.id, title: a.label })} className="flex min-h-11 w-full items-start gap-2 py-1 text-left" data-workflow-agent={a.label}>
            {body}
            <Icon.chevronRight className="mt-1 size-4 shrink-0 text-muted" />
          </button>
        ) : (
          <div key={`${a.label}-${n}`} className="flex items-start gap-2 py-1" data-workflow-agent={a.label}>
            {body}
          </div>
        );
      })}
      {p.total > p.agents.length && <div className="text-xs text-muted">외 {p.total - p.agents.length}개</div>}
    </Field>
  );
}

// The agents of a workflow no longer listed, from the journal Claude Code keeps of its run.
function PastWorkflowAgents({ sessionId, runId, ended, onRead }: { sessionId: string; runId: string; ended: boolean; onRead: (r: TranscriptRef) => void }) {
  const [p, setP] = useState<WorkflowInfo>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let current = true;
    call(sessionId, "workflow_agents", { runId }).then(
      (w) => current && setP(w),
      (e: Error) => current && setError(errorText(e.message)),
    );
    return () => {
      current = false;
    };
  }, [sessionId, runId]);
  if (error) return <div className="mt-3 text-sm text-danger">{error}</div>;
  if (!p) return <Waiting text="에이전트 목록을 불러오는 중…" />;
  if (!p.total) return <div className="mt-3 text-sm text-muted">이 워크플로의 에이전트 기록이 없습니다</div>;
  return (
    <div data-past-workflow-agents>
      {p.phases.length > 0 && <Phases p={{ ...p, phase: undefined }} />}
      <WorkflowAgents p={p} ended={ended} onRead={onRead} />
    </div>
  );
}

function AgentDetail({ sessionId, node, gone, parent, clock, canStop, stopping, error, onBack, onStop, onJump, onPending, onRead }: DetailProps & { sessionId: string; node: AgentNode }) {
  const running = live(node);
  const p = node.progress;
  const head = [STATUS_LABEL[node.status], kindText(node), node.model, node.background === undefined ? "" : node.background ? "백그라운드" : "포그라운드"].filter(Boolean);
  const numbers = [
    timeOf(node, running, clock) && `경과 ${timeOf(node, running, clock)}`,
    node.tokens !== undefined ? `${tokens(node.tokens)} 토큰` : "",
    node.tools ? `도구 ${node.tools}회` : "",
  ].filter(Boolean);
  const ended = node.status === "failed" || node.status === "stopped";
  return (
    <div data-detail={node.key}>
      <Back onBack={onBack} />
      <div className="flex items-start gap-2">
        <span className="mt-1">
          <Mark status={node.status} />
        </span>
        <div className="min-w-0 flex-1 text-[16px] font-semibold break-words">{node.workflow ? `워크플로 · ${node.name ?? node.title}` : node.title}</div>
      </div>
      <div className="mt-1 text-xs text-muted">{head.join(" · ")}</div>
      {gone && <div className="mt-1 text-xs text-muted">목록에서 빠졌습니다. 마지막 내용입니다.</div>}
      {!node.workflow && <div className="mt-2 text-sm text-muted">띄운 곳: {parent}</div>}
      {numbers.length > 0 && <div className="mt-1 text-sm tabular-nums">{numbers.join(" · ")}</div>}
      {node.status === "waiting" && node.pending ? (
        <div className="mt-3 rounded-xl bg-warn/10 px-3 py-2.5 text-sm">
          <div className="text-warn">{node.pending.toolName} 실행 허락을 기다립니다</div>
          <button onClick={() => onPending(node.pending!.id)} className="mt-1.5 min-h-8 font-medium text-accent">
            권한 요청으로 가기 ›
          </button>
        </div>
      ) : (
        running && node.activity && <Field label="지금 하는 일">{node.activity}</Field>
      )}
      {ended && (node.error || node.summary) && <div className="mt-3 text-sm text-danger">{node.error ?? node.summary}</div>}
      {node.status === "completed" && node.summary && !node.workflow && !node.result && <Field label="요약">{node.summary}</Field>}
      {node.result && (
        <Field label="결과">
          <div className="line-clamp-12 whitespace-pre-wrap">{node.result}</div>
        </Field>
      )}
      {p && p.phases.length > 0 && <Phases p={p} />}
      {p && p.agents.length > 0 && <WorkflowAgents p={p} onRead={onRead} />}
      {node.workflow && !p?.agents.length && node.runId && <PastWorkflowAgents sessionId={sessionId} runId={node.runId} ended={!running} onRead={onRead} />}
      {node.workflow && <div className="mt-3 text-xs text-muted">워크플로 안의 에이전트는 하나씩 멈출 수 없습니다. 워크플로 전체만 멈춥니다.</div>}
      {node.recent && (
        <Field label="최근 도구">
          {node.recent.map((r, n) => (
            <div key={n} className="truncate font-mono text-[12px] text-muted">
              <span className="text-fg">{r.name}</span> {r.summary}
            </div>
          ))}
        </Field>
      )}
      {node.text && (
        <Field label="마지막 글">
          <div className="line-clamp-6 whitespace-pre-wrap text-muted">{node.text}</div>
        </Field>
      )}
      {node.prompt && (
        <details className="mt-3">
          <summary className="min-h-8 cursor-pointer text-xs font-semibold text-muted">지시</summary>
          <div className="mt-1 max-h-60 overflow-y-auto rounded-lg bg-surface-2 px-3 py-2 text-[13px] whitespace-pre-wrap">{node.prompt}</div>
        </details>
      )}
      <Actions node={node} canStop={canStop && !gone} stopping={stopping} onStop={onStop} onJump={onJump} onRead={onRead} stopLabel={node.workflow ? "워크플로 중지" : "중지"} />
      {error && <div className="mt-2 text-sm text-danger">{error}</div>}
    </div>
  );
}

function TaskDetail({
  sessionId,
  task,
  parent,
  clock,
  canStop,
  canRead,
  stopping,
  error,
  onBack,
  onStop,
  onRead,
}: Omit<DetailProps, "node" | "onJump" | "onPending" | "gone"> & { sessionId: string; task: TaskInfo; canRead: boolean }) {
  const running = task.status === "running";
  return (
    <div data-detail={`t:${task.id}`}>
      <Back onBack={onBack} />
      <div className="flex items-start gap-2">
        <span className="mt-1">
          <Mark status={TASK_STATUS[task.status]} />
        </span>
        <div className="min-w-0 flex-1 text-[16px] font-semibold break-words">{task.description || "(설명 없음)"}</div>
      </div>
      <div className="mt-1 text-xs text-muted">{[STATUS_LABEL[TASK_STATUS[task.status]], taskKindLabel(task.kind ?? task.type)].filter(Boolean).join(" · ")}</div>
      {parent && <div className="mt-2 text-sm text-muted">띄운 곳: {parent}</div>}
      <div className="mt-1 text-sm tabular-nums">경과 {timeOf(task, running, clock)}</div>
      {running && task.activity && <Field label="지금 하는 일">{task.activity}</Field>}
      {(task.error || (task.status !== "completed" && task.summary)) && <div className="mt-3 text-sm text-danger">{task.error ?? task.summary}</div>}
      {SHELL_KINDS.has(task.kind ?? "") && (canRead || task.background === false) && (
        <ShellOutput sessionId={sessionId} task={task} onAgent={task.parentId ? () => onRead({ agentId: task.parentId, title: parent || "서브에이전트" }) : undefined} />
      )}
      {canStop && running && (
        <div className="mt-4 flex justify-end">
          <SmallButton tall tone="text-danger" disabled={stopping} onClick={() => onStop(task.id)}>
            {stopping ? "중지 중…" : "중지"}
          </SmallButton>
        </div>
      )}
      {error && <div className="mt-2 text-sm text-danger">{error}</div>}
    </div>
  );
}

function summaryLine(map: AgentMap): string {
  const c = map.counts;
  return [
    c.running ? `실행 중 ${c.running}` : "",
    c.waiting ? `권한 대기 ${c.waiting}` : "",
    c.completed ? `끝남 ${c.completed}` : "",
    c.failed ? `실패 ${c.failed}` : "",
    c.stopped ? `중지 ${c.stopped}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

interface Props {
  sessionId: string;
  title: string;
  // Stop buttons only where the phone drives the session.
  controllable: boolean;
  onClose: () => void;
  onJump: (itemId: string) => void;
  onPending: (requestId: string) => void;
  onFile: (href: string) => void;
}

// A transcript open on the map, and where its scroller stood when another was opened over it.
type Reading = { ref: TranscriptRef; scroll?: number };

// The session's subagents, workflows and background tasks; tapping one shows its card beside the map on a wide
// screen and in place of it on a narrow one. A subagent's transcript opens over its card, a nested one over that,
// and takes the whole height of a narrow screen.
export function AgentMapSheet({ sessionId, title, controllable, onClose, onJump, onPending, onFile }: Props) {
  const chat = useApp((s) => (s.chat?.sessionId === sessionId ? s.chat : undefined));
  const models = useApp((s) => s.options?.models ?? NO_MODELS);
  const st = chat?.state;
  const busy = Boolean(st?.busy);
  const map = useMemo(() => agentMap({ tasks: st?.tasks, items: chat?.items ?? [], pending: chat?.pending ?? [], busy }), [st?.tasks, chat?.items, chat?.pending, busy]);
  const [selected, setSelected] = useState<Selected | null>(null);
  // With nothing listed the map opens on the conversation's past agents.
  const [showPast, setShowPast] = useState(() => map.nodes.length === 0);
  const [pastLimit, setPastLimit] = useState(PAST_SHOWN);
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState<{ id: string; text: string }>();
  const [now, setNow] = useState(Date.now());
  const [reading, setReading] = useState<Reading[]>([]);
  const last = useRef<{ node?: AgentNode; task?: TaskInfo }>({});
  const detailRef = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);
  // Where the sheet and the card column stood before the first transcript opened.
  const beforeReading = useRef<{ panel: number; detail: number }>({ panel: 0, detail: 0 });
  const clock: Clock = { now, stateAt: chat?.stateAt };
  const roots = useMemo(() => (st?.cwd ? [st.cwd] : []), [st?.cwd]);

  const ticking = map.nodes.some(live) || map.background.some((t) => t.status === "running");
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, [ticking, chat?.stateAt]);

  useEffect(() => {
    const running = new Set((st?.tasks ?? []).filter((t) => t.status === "running").map((t) => t.id));
    setStopping((s) => (s.size && [...s].some((id) => !running.has(id)) ? new Set([...s].filter((id) => running.has(id))) : s));
  }, [st?.tasks]);

  const stop = (id: string) => {
    setStopping((s) => new Set(s).add(id));
    setFailed(undefined);
    call(sessionId, "stop_task", { taskId: id }).catch((e: Error) => {
      setStopping((s) => new Set([...s].filter((x) => x !== id)));
      setFailed({ id, text: errorText(e.message) });
    });
  };

  const byTask = new Map((st?.tasks ?? []).map((t) => [t.id, t]));
  const parentName = (id?: string) => {
    const t = id ? byTask.get(id) : undefined;
    return t ? t.description || "서브에이전트" : "";
  };

  let node: AgentNode | undefined;
  let task: TaskInfo | undefined;
  let gone = false;
  if (selected?.task) {
    task = byTask.get(selected.task);
    if (task) last.current = { task };
    else {
      task = last.current.task;
      gone = true;
    }
  } else if (selected) {
    node = findNode(map, selected.key, selected.itemId);
    if (node) last.current = { node };
    else {
      node = last.current.node;
      gone = true;
    }
  }
  const panel = () => detailRef.current?.closest<HTMLElement>('[role="dialog"]');
  // The card column scrolls on its own on a wide screen; on a narrow one the sheet does.
  const scroller = () => (detailRef.current && /(auto|scroll)/.test(getComputedStyle(detailRef.current).overflowY) ? detailRef.current : panel());
  const show = (sel: Selected) => {
    if (!selected && !reading.length) listScroll.current = panel()?.scrollTop ?? 0;
    setReading([]);
    setSelected(sel);
  };
  const open = (n: AgentNode) => show({ key: n.key, itemId: n.itemId });
  const back = () => setSelected(null);
  const read = (ref: TranscriptRef) => {
    if (!reading.length) beforeReading.current = { panel: panel()?.scrollTop ?? 0, detail: detailRef.current?.scrollTop ?? 0 };
    const at = scroller()?.scrollTop;
    setReading((r) => [...r.slice(0, -1), ...r.slice(-1).map((x) => ({ ...x, scroll: at })), { ref }]);
  };
  const unread = () => setReading((r) => r.slice(0, -1));
  const top = reading.at(-1);
  // Back on the card or the map, the sheet stands where it stood before the first transcript opened.
  const notReading = reading.length === 0;
  useLayoutEffect(() => {
    if (!notReading) return;
    const p = panel();
    if (p) p.scrollTop = beforeReading.current.panel;
    if (detailRef.current) detailRef.current.scrollTop = beforeReading.current.detail;
  }, [notReading]);
  // A card opens at its top, with its way back in view; going back finds the map where it was left.
  const selectedKey = selected ? `${selected.key}|${selected.itemId ?? ""}` : "";
  useLayoutEffect(() => {
    const p = panel();
    if (detailRef.current) detailRef.current.scrollTop = 0;
    if (p) p.scrollTop = selectedKey ? 0 : listScroll.current;
  }, [selectedKey]);
  const mainStatus = (chat?.pending ?? []).some((p) => !p.agentId) ? "권한 대기" : busy ? "작업 중" : st?.state === "inactive" ? "꺼져 있음" : "쉬는 중";
  const past = map.past.slice(0, pastLimit);
  const detailProps = {
    clock,
    canStop: controllable,
    onBack: back,
    onStop: stop,
    onJump,
    onPending,
    onRead: read,
  };
  // A transcript follows its subagent while the broker lists it running, or while its card does.
  const runningOf = (r: TranscriptRef): boolean => {
    const t = r.agentId ? byTask.get(r.agentId) : undefined;
    if (t) return t.status === "running";
    const a = r.agentId ? (st?.tasks ?? []).flatMap((x) => x.workflow?.agents ?? []).find((w) => w.id === r.agentId) : undefined;
    if (a) return a.state === "running";
    const n = r.toolUseId ? [...map.nodes, ...map.past].find((x) => x.itemId === r.toolUseId) : undefined;
    return n ? live(n) : false;
  };

  return (
    <Sheet title="에이전트 지도" onClose={onClose} wide tall={Boolean(top)}>
      <div className="sm:grid sm:grid-cols-12 sm:gap-4" data-agent-map>
        <div className={`${selected || top ? "hidden sm:block" : ""} sm:col-span-5 sm:max-h-[calc(var(--vv-height,100dvh)-7rem)] sm:overflow-y-auto sm:overscroll-contain`} data-map-list>
          {summaryLine(map) && (
            <div className="mb-2 px-1 text-sm" data-map-summary>
              {summaryLine(map)}
            </div>
          )}
          <div className="sticky top-0 z-10 -mx-1 rounded-xl border border-line bg-surface px-3 py-2" data-map-main>
            <div className="truncate text-[15px] font-medium">메인 · {title}</div>
            <div className="mt-0.5 text-xs text-muted">
              {[mainStatus, st?.model ? modelLabel(models, st.model) : "", st?.context ? `Context ${Math.round(st.context.percent)}%` : ""].filter(Boolean).join(" · ")}
            </div>
          </div>
          <div className="mt-1 ml-2 border-l border-muted/40 pl-1" data-map-tree>
            {map.tree.length ? (
              map.tree.map((n) => <NodeRow key={n.key} node={n} level={1} clock={clock} onOpen={open} onRead={read} />)
            ) : (
              <div className="px-2 py-3 text-sm text-muted">{map.past.length ? "실행 중인 에이전트가 없습니다" : "이 대화에서 쓴 에이전트가 없습니다"}</div>
            )}
          </div>
          <Section title={map.background.length ? `백그라운드 작업 ${map.background.length}` : "백그라운드 작업"}>
            {map.background.length ? (
              <div className="overflow-hidden rounded-xl border border-line" data-map-background>
                {map.background.map((t) => (
                  <BackgroundRow
                    key={t.id}
                    task={t}
                    parent={parentName(t.parentId)}
                    clock={clock}
                    stopping={stopping.has(t.id)}
                    error={failed?.id === t.id && !selected ? failed.text : undefined}
                    onStop={controllable ? () => stop(t.id) : undefined}
                    onOpen={() => show({ key: `t:${t.id}`, task: t.id })}
                  />
                ))}
              </div>
            ) : (
              <div className="px-1 py-1 text-sm text-muted">실행 중인 백그라운드 작업이 없습니다</div>
            )}
          </Section>
          {map.past.length > 0 && (
            <section className="mt-4" data-map-past>
              <button onClick={() => setShowPast(!showPast)} className="flex min-h-11 w-full items-center gap-1 px-1 text-left text-xs font-semibold text-muted">
                이 대화의 지난 에이전트 {map.past.length}
                <Icon.chevronDown className={`size-4 transition-transform ${showPast ? "" : "-rotate-90"}`} />
              </button>
              {showPast && (
                <div>
                  {past.map((n) => (
                    <NodeRow key={n.key} node={n} level={1} clock={clock} onOpen={open} onRead={read} />
                  ))}
                  {map.past.length > past.length && (
                    <button onClick={() => setPastLimit(pastLimit + PAST_SHOWN)} className="min-h-11 px-2 text-sm font-medium text-accent">
                      더 보기
                    </button>
                  )}
                  {chat?.hasMore && <div className="px-2 py-1 text-xs text-muted">이전 대화의 에이전트는 빠져 있습니다</div>}
                </div>
              )}
            </section>
          )}
          {controllable && <div className="mt-4 px-1 text-xs text-muted">입력창의 중지는 지금 턴만 멈춥니다. 백그라운드 에이전트는 여기서 하나씩 멈춥니다.</div>}
        </div>
        <div className={`${selected || top ? "" : "hidden sm:block"} sm:col-span-7 sm:max-h-[calc(var(--vv-height,100dvh)-7rem)] sm:overflow-y-auto sm:overscroll-contain sm:border-l sm:border-line sm:pl-4`} data-map-detail ref={detailRef}>
          {top ? (
            <Transcript
              key={`${reading.length}|${top.ref.agentId ?? ""}|${top.ref.toolUseId ?? ""}`}
              sessionId={sessionId}
              target={top.ref}
              startAt={top.scroll}
              running={runningOf(top.ref)}
              roots={roots}
              onFile={onFile}
              onBack={unread}
              onOpen={read}
            />
          ) : node ? (
            <AgentDetail
              {...detailProps}
              sessionId={sessionId}
              node={node}
              gone={gone}
              parent={parentName(node.parentId) || "메인 에이전트"}
              stopping={Boolean(node.task && stopping.has(node.task.id))}
              error={node.task && failed?.id === node.task.id ? failed.text : undefined}
            />
          ) : task ? (
            <>
              <TaskDetail
                {...detailProps}
                sessionId={sessionId}
                task={task}
                parent={parentName(task.parentId)}
                canStop={controllable && !gone}
                canRead={controllable && !gone}
                stopping={stopping.has(task.id)}
                error={failed?.id === task.id ? failed.text : undefined}
              />
              {gone && <div className="mt-2 text-xs text-muted">목록에서 빠졌습니다. 마지막 내용입니다.</div>}
            </>
          ) : (
            <div className="hidden py-6 text-center text-sm text-muted sm:block">에이전트를 누르면 자세히 보입니다</div>
          )}
        </div>
      </div>
    </Sheet>
  );
}
