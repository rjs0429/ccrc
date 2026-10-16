import type { DisplayItem, PendingRequest, SubagentActivity, TaskInfo, WorkflowInfo } from "../../../../broker/src/protocol.ts";
import { workflowMeta } from "../../../../broker/src/tools.ts";

export type NodeStatus = "waiting" | "running" | "completed" | "failed" | "stopped" | "unknown";
export type ChipDot = "waiting" | "running" | "failed" | "done" | "idle";

type ToolItem = Extract<DisplayItem, { kind: "tool" }>;

// A subagent or workflow on the map. task: the live task the broker lists; itemId: the Agent/Workflow call in the
// conversation. key: "t:<task id>" for a listed task, "i:<item id>" for one known only from the conversation.
// agentId: the subagent's id, which names its transcript; runId: the workflow's run, which names its agents' folder.
export interface AgentNode {
  key: string;
  task?: TaskInfo;
  itemId?: string;
  agentId?: string;
  runId?: string;
  workflow: boolean;
  title: string;
  name?: string;
  agentType?: string;
  model?: string;
  background?: boolean;
  status: NodeStatus;
  parentId?: string;
  ms?: number;
  tokens?: number;
  tools?: number;
  activity?: string;
  summary?: string;
  error?: string;
  prompt?: string;
  recent?: SubagentActivity["recent"];
  text?: string;
  result?: string;
  progress?: WorkflowInfo;
  ended?: SubagentActivity["ended"];
  // The permission request this agent, or an agent of this workflow, waits on.
  pending?: PendingRequest;
  children: AgentNode[];
}

export interface AgentMap {
  // Listed subagents and workflows, nested by the subagent that started them.
  tree: AgentNode[];
  nodes: AgentNode[];
  // Other listed tasks: shells, monitors, MCP tasks, teammates, ...
  background: TaskInfo[];
  // Subagents and workflows of the conversation no longer listed, latest first.
  past: AgentNode[];
  counts: Record<NodeStatus, number>;
  // Absent while the conversation has no subagent or workflow, listed or not. total: listed ones and past ones.
  chip?: { running: number; dot: ChipDot; total: number };
}

const AGENT_TOOLS = new Set(["Agent", "Task"]);
const LAUNCHED = /^(Async agent launched|Workflow launched in background)/;
// Claude Code hands a subagent's report back under a notice, every report line indented by two spaces, and
// follows it at column zero with the agent id and usage.
const HANDBACK = /^\[Subagent hand-back\][^\n]*\n/;
const RANK: Record<NodeStatus, number> = { waiting: 0, running: 1, failed: 2, completed: 3, stopped: 3, unknown: 4 };

const kindOf = (t: TaskInfo) => t.kind ?? t.type;
const isAgent = (t: TaskInfo) => kindOf(t) === "local_agent";
const isWorkflow = (t: TaskInfo) => kindOf(t) === "local_workflow" || t.workflow !== undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function inputOf(item?: ToolItem): Record<string, unknown> {
  return item?.input && typeof item.input === "object" ? (item.input as Record<string, unknown>) : {};
}

// A call known only from the conversation: how it ended per its end notice or result, or that it still runs
// while the session works and it has no result.
function itemStatus(item: ToolItem, busy: boolean): NodeStatus {
  const ended = item.sub?.ended?.status;
  if (ended) return ended;
  if (item.result?.isError) return "failed";
  if (item.result && !LAUNCHED.test(item.result.text)) return "completed";
  if (busy && !item.result) return "running";
  return "unknown";
}

function answerOf(text: string): string {
  if (!HANDBACK.test(text)) return text;
  const lines = text.replace(HANDBACK, "").split("\n");
  const end = lines.findIndex((l) => l && !l.startsWith("  "));
  return (end < 0 ? lines : lines.slice(0, end)).map((l) => l.slice(2)).join("\n").trim();
}

function fromItem(item: ToolItem | undefined, workflow: boolean) {
  const input = inputOf(item);
  const script = str(input.script);
  const result = item?.result && !item.result.isError && !LAUNCHED.test(item.result.text) ? answerOf(item.result.text) : undefined;
  return {
    name: workflow ? (script ? workflowMeta(script, "name") : undefined) || str(input.name) : undefined,
    title: (workflow && script ? workflowMeta(script, "description") : undefined) || str(input.description) || item?.summary || "",
    agentType: str(input.subagent_type),
    model: str(input.model),
    background: typeof input.run_in_background === "boolean" ? input.run_in_background : undefined,
    prompt: str(input.prompt),
    recent: item?.sub?.recent.length ? item.sub.recent : undefined,
    text: item?.sub?.text,
    result,
    ended: item?.sub?.ended,
    agentId: workflow ? undefined : item?.sub?.agentId,
    runId: workflow ? item?.sub?.runId : undefined,
  };
}

function clean<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

// What a running agent does now as its own progress reports it, else its latest call seen in the conversation,
// which also counts the calls of subagents it started.
function activityOf(recent: SubagentActivity["recent"] | undefined, task: TaskInfo): string | undefined {
  const last = recent?.at(-1);
  return task.activity ?? (last ? `${last.name} ${last.summary}`.trim() : undefined);
}

// The map of a session's agents, from the broker's task list, the conversation and the open requests.
export function agentMap({ tasks = [], items, pending, busy }: { tasks?: TaskInfo[]; items: DisplayItem[]; pending: PendingRequest[]; busy: boolean }): AgentMap {
  const calls = new Map<string, ToolItem>();
  for (const i of items) if (i.kind === "tool" && (AGENT_TOOLS.has(i.name) || i.name === "Workflow")) calls.set(i.id, i);
  const asking = new Map<string, PendingRequest>();
  for (const p of pending) if (p.agentId && !asking.has(p.agentId)) asking.set(p.agentId, p);

  const nodes: AgentNode[] = [];
  const background: TaskInfo[] = [];
  const listedCalls = new Set<string>();
  for (const t of tasks) {
    if (!isAgent(t) && !isWorkflow(t)) {
      background.push(t);
      continue;
    }
    const workflow = isWorkflow(t);
    const item = t.toolUseId ? calls.get(t.toolUseId) : undefined;
    if (item) listedCalls.add(item.id);
    const known = fromItem(item, workflow);
    const ask = t.status === "running" ? (asking.get(t.id) ?? t.workflow?.agents.map((a) => (a.id ? asking.get(a.id) : undefined)).find(Boolean)) : undefined;
    nodes.push(
      clean({
        key: `t:${t.id}`,
        task: t,
        itemId: item?.id,
        agentId: workflow ? undefined : t.id,
        runId: known.runId,
        workflow,
        title: t.description || known.title || (workflow ? "워크플로" : "서브에이전트"),
        name: t.workflow?.name ?? known.name,
        agentType: t.agentType ?? known.agentType,
        model: known.model,
        background: t.background ?? known.background,
        status: ask ? "waiting" : t.status,
        parentId: t.parentId,
        ms: t.ms,
        tokens: t.tokens ?? known.ended?.tokens,
        tools: t.tools ?? item?.sub?.tools,
        activity: t.status === "running" ? activityOf(known.recent, t) : undefined,
        summary: t.summary,
        error: t.error,
        prompt: known.prompt,
        recent: known.recent,
        text: known.text,
        result: known.result,
        progress: t.workflow && (t.workflow.total || t.workflow.phases.length) ? t.workflow : undefined,
        ended: known.ended,
        pending: ask,
        children: [],
      }),
    );
  }

  const byId = new Map(nodes.map((n) => [n.task!.id, n]));
  const tree: AgentNode[] = [];
  for (const n of nodes) {
    const parent = n.parentId ? byId.get(n.parentId) : undefined;
    // A node whose parents lead back to itself hangs under the main agent.
    const seen = new Set<AgentNode>();
    let up = parent;
    while (up && up !== n && !seen.has(up)) {
      seen.add(up);
      up = up.parentId ? byId.get(up.parentId) : undefined;
    }
    if (parent && !up) parent.children.push(n);
    else tree.push(n);
  }
  // Waiting first, then running ones longest running first, then failed, then the rest as the broker lists them
  // (latest end first).
  const order = (list: AgentNode[]) => {
    const at = new Map(list.map((n, i) => [n, i]));
    list.sort((a, b) => RANK[a.status] - RANK[b.status] || (RANK[a.status] <= 1 ? (b.ms ?? 0) - (a.ms ?? 0) : at.get(a)! - at.get(b)!));
    for (const n of list) order(n.children);
  };
  order(tree);

  const past: AgentNode[] = [];
  for (const item of [...calls.values()].reverse()) {
    if (listedCalls.has(item.id)) continue;
    const workflow = item.name === "Workflow";
    const known = fromItem(item, workflow);
    past.push(
      clean({
        key: `i:${item.id}`,
        itemId: item.id,
        agentId: known.agentId,
        runId: known.runId,
        workflow,
        title: known.title || (workflow ? "워크플로" : "서브에이전트"),
        name: known.name,
        agentType: known.agentType,
        model: known.model,
        background: known.background,
        status: itemStatus(item, busy),
        ms: known.ended?.ms,
        tokens: known.ended?.tokens,
        tools: item.sub?.tools,
        prompt: known.prompt,
        recent: known.recent,
        text: known.text,
        result: known.result,
        ended: known.ended,
        children: [],
      }),
    );
  }

  const counts: Record<NodeStatus, number> = { waiting: 0, running: 0, completed: 0, failed: 0, stopped: 0, unknown: 0 };
  for (const n of nodes) counts[n.status]++;
  // The chip counts running agents listed or not; failed and done show only while the broker still lists them.
  let chip: AgentMap["chip"];
  if (nodes.length || past.length) {
    const listed = nodes.reduce((sum, n) => {
      if (n.status !== "running" && n.status !== "waiting") return sum;
      return sum + (n.progress?.total ? Math.max(1, n.progress.running) : 1);
    }, 0);
    const running = listed + past.filter((n) => n.status === "running").length;
    const dot: ChipDot = counts.waiting ? "waiting" : running ? "running" : counts.failed ? "failed" : nodes.length ? "done" : "idle";
    chip = { running, dot, total: nodes.length + past.length };
  }
  return { tree, nodes, background, past, counts, chip };
}

// The node a key names now; one that left the list is found again by its conversation call.
export function findNode(map: AgentMap, key: string, itemId?: string): AgentNode | undefined {
  return map.nodes.find((n) => n.key === key) ?? map.past.find((n) => n.key === key) ?? (itemId ? [...map.nodes, ...map.past].find((n) => n.itemId === itemId) : undefined);
}

// How long a node has run as the user looks at it: the broker's measure plus the time since that state arrived.
export function elapsed(ms: number | undefined, running: boolean, stateAt: number | undefined, now: number): number | undefined {
  if (ms === undefined) return undefined;
  return running && stateAt ? ms + Math.max(0, now - stateAt) : ms;
}
