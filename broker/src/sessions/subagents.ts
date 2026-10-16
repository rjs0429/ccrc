import fs from "node:fs";
import path from "node:path";
import { getSubagentMessages } from "@anthropic-ai/claude-agent-sdk";
import type { AgentTranscript, DisplayItem, WorkflowAgent, WorkflowAgentState, WorkflowInfo } from "../protocol.ts";
import { projectDirName, transcriptPath, usedOutput } from "./history.ts";
import { ItemBuilder, type RawMessage } from "./items.ts";

// Ids of subagents, tool calls and workflow runs as Claude Code writes them; a path never passes.
const ID = /^[A-Za-z0-9_-]{1,128}$/;
// A session's subagents keep their transcripts in subagents/, a workflow's agents in subagents/workflows/<run>/.
const DEPTH = 2;
const MAX_BYTES = 64 * 1024 * 1024;
const META_MAX = 64 * 1024;
const JOURNAL_MAX = 16 * 1024 * 1024;
const PAGE = 150;
// The JSON an answer's items may take; a page gives up its oldest items to stay within it.
const BUDGET = 900 * 1024;
const OPEN_MAX = 100;
const LAST_ID_MAX = 300;
const KEEP = 4;
const KEEP_MS = 5 * 60_000;
const FILES_KEEP = 200;
const FOLDERS_KEEP = 20;
const WORKFLOW_AGENTS_MAX = 200;
const LABEL_MAX = 120;
const DESCRIPTION_MAX = 1000;

type Obj = Record<string, unknown>;

interface Built {
  size: number;
  mtimeMs: number;
  items: DisplayItem[];
  bytes: number[];
  index: Map<string, number>;
  promptId?: string;
  agentType?: string;
  description?: string;
  usedAt: number;
}

// The latest transcripts read, by file, and the reads under way, by file, size and time.
const built = new Map<string, Built>();
const building = new Map<string, Promise<Built>>();
// Where each subagent's transcript was found, and per subagents folder the subagent each Agent call started.
const files = new Map<string, string>();
const calls = new Map<string, Map<string, string>>();

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): string | undefined => (typeof v === "string" && v ? v.slice(0, max) : undefined);

function remember<V>(map: Map<string, V>, key: string, value: V, keep: number): void {
  map.delete(key);
  map.set(key, value);
  for (const old of [...map.keys()].slice(0, -keep)) map.delete(old);
}

// An id the phone named, absent when it named none.
function idArg(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !ID.test(v)) throw Error("invalid request");
  return v;
}

// A session's subagents folder, and the folder the SDK's reader finds the session from when it lies where the
// session's working folder puts it.
function folderOf(sessionId: string, cwd: string): { dir: string; sdkDir?: string } | undefined {
  const file = transcriptPath(sessionId, cwd);
  if (!file) return undefined;
  const project = path.dirname(file);
  return { dir: path.join(project, sessionId, "subagents"), ...(path.basename(project) === projectDirName(cwd) ? { sdkDir: cwd } : {}) };
}

// The real path of a file or folder that really lies inside `dir`.
function inside(p: string, dir: string): string | undefined {
  try {
    const real = fs.realpathSync(p);
    return real.startsWith(fs.realpathSync(dir) + path.sep) ? real : undefined;
  } catch {
    return undefined;
  }
}

// The files `want` picks by name in a subagents folder and the folders below it, without following links.
async function scan(dir: string, want: (name: string) => boolean): Promise<string[]> {
  const found: string[] = [];
  let level = [dir];
  for (let depth = 0; depth <= DEPTH && level.length; depth++) {
    const next: string[] = [];
    for (const at of level) {
      for (const e of await fs.promises.readdir(at, { withFileTypes: true }).catch(() => [])) {
        if (e.isFile() && want(e.name)) found.push(path.join(at, e.name));
        else if (e.isDirectory()) next.push(path.join(at, e.name));
      }
    }
    level = next;
  }
  return found;
}

async function readObj(file: string, max: number): Promise<Obj | undefined> {
  try {
    if ((await fs.promises.stat(file)).size > max) return undefined;
    const v = JSON.parse(await fs.promises.readFile(file, "utf8")) as unknown;
    return isObj(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

async function agentFile(dir: string, agentId: string): Promise<string | undefined> {
  const key = `${dir}\n${agentId}`;
  const known = files.get(key);
  if (known && fs.existsSync(known)) return known;
  const name = `agent-${agentId}.jsonl`;
  const [found] = await scan(dir, (n) => n === name);
  const real = found && inside(found, dir);
  if (real) remember(files, key, real, FILES_KEEP);
  return real || undefined;
}

// The subagent an Agent call started, as its meta file names the call.
async function agentOfCall(dir: string, toolUseId: string): Promise<string | undefined> {
  const known = calls.get(dir)?.get(toolUseId);
  if (known) return known;
  const ids = new Map<string, string>();
  for (const file of await scan(dir, (n) => n.startsWith("agent-") && n.endsWith(".meta.json"))) {
    const id = path.basename(file).slice("agent-".length, -".meta.json".length);
    const meta = ID.test(id) && inside(file, dir) ? await readObj(file, META_MAX) : undefined;
    if (typeof meta?.toolUseId === "string") ids.set(meta.toolUseId, id);
  }
  remember(calls, dir, ids, FOLDERS_KEEP);
  return ids.get(toolUseId);
}

// The subagent's conversation as items: the SDK's reader follows the chain of its messages, the file adds the tool
// outputs items are built from. Without their Agent call the messages read as a conversation of their own. The result
// of a call made beside others hangs off the chain on a branch of its own, so it is taken from the file by call id.
async function build(sessionId: string, agentId: string, file: string, sdkDir: string | undefined, cwd: string, st: fs.Stats): Promise<Built> {
  const [messages, raw, meta] = await Promise.all([
    getSubagentMessages(sessionId, agentId, sdkDir ? { dir: sdkDir } : undefined),
    fs.promises.readFile(file, "utf8"),
    readObj(file.replace(/\.jsonl$/, ".meta.json"), META_MAX),
  ]);
  const outputs = new Map<string, unknown>();
  const results = new Map<string, RawMessage>();
  for (const line of raw.split("\n")) {
    if (!line.includes('"tool_result"')) continue;
    try {
      const e = JSON.parse(line) as { type?: unknown; uuid?: unknown; timestamp?: unknown; message?: { content?: unknown }; toolUseResult?: unknown };
      if (e.type !== "user" || typeof e.uuid !== "string") continue;
      const output = usedOutput(e.toolUseResult) ? e.toolUseResult : undefined;
      if (output) outputs.set(e.uuid, output);
      const blocks = Array.isArray(e.message?.content) ? (e.message.content as unknown[]).filter((b) => isObj(b) && b.type === "tool_result" && typeof b.tool_use_id === "string") : [];
      const timestamp = typeof e.timestamp === "string" ? e.timestamp : undefined;
      for (const b of blocks as Obj[]) results.set(b.tool_use_id as string, { type: "user", uuid: e.uuid, timestamp, message: { content: [b as { type: string }] }, toolUseResult: blocks.length === 1 ? output : undefined });
    } catch {}
  }
  const builder = new ItemBuilder(cwd);
  for (const m of messages) builder.add({ ...(m as unknown as RawMessage), parent_tool_use_id: null, toolUseResult: outputs.get(m.uuid) });
  const chain = new Set(messages.map((m) => m.uuid));
  const aside = builder.items.flatMap((i) => {
    const r = i.kind === "tool" && !i.result ? results.get(i.id) : undefined;
    return r && !chain.has(r.uuid!) ? [r] : [];
  });
  for (const m of aside) builder.add(m);
  const items = builder.items;
  const agentType = text(meta?.agentType, LABEL_MAX);
  const description = text(meta?.description, DESCRIPTION_MAX);
  const promptId = items.find((i) => i.kind === "user")?.id;
  return {
    size: st.size,
    mtimeMs: st.mtimeMs,
    items,
    bytes: items.map((i) => Buffer.byteLength(JSON.stringify(i))),
    index: new Map(items.map((i, n) => [i.id, n])),
    ...(promptId ? { promptId } : {}),
    ...(agentType ? { agentType } : {}),
    ...(description ? { description } : {}),
    usedAt: Date.now(),
  };
}

// A transcript is read again only once its size or time changed; reads of the same file at once share one.
async function current(sessionId: string, agentId: string, file: string, sdkDir: string | undefined, cwd: string): Promise<Built> {
  const now = Date.now();
  for (const [k, b] of built) if (now - b.usedAt > KEEP_MS) built.delete(k);
  const st = await fs.promises.stat(file);
  if (st.size > MAX_BYTES) throw Error("transcript too large");
  const kept = built.get(file);
  if (kept && kept.size === st.size && kept.mtimeMs === st.mtimeMs) {
    kept.usedAt = now;
    remember(built, file, kept, KEEP);
    return kept;
  }
  const key = `${file}\n${st.size}\n${st.mtimeMs}`;
  let reading = building.get(key);
  if (!reading) {
    reading = build(sessionId, agentId, file, sdkDir, cwd, st).finally(() => building.delete(key));
    building.set(key, reading);
  }
  const b = await reading;
  remember(built, file, b, KEEP);
  return b;
}

// Items from..to, without the oldest ones the answer has no room for; one item always goes.
function page(b: Built, from: number, to: number): { from: number; items: DisplayItem[] } {
  let start = to;
  let bytes = 0;
  while (start > from && (start === to || bytes + b.bytes[start - 1] <= BUDGET)) bytes += b.bytes[--start];
  return { from: start, items: b.items.slice(start, to) };
}

function afterArg(v: unknown): { count: number; lastId: string; open: string[] } | undefined {
  if (v === undefined) return undefined;
  const a = isObj(v) ? v : {};
  if (!Number.isSafeInteger(a.count) || (a.count as number) < 0 || typeof a.lastId !== "string" || a.lastId.length > LAST_ID_MAX) throw Error("invalid request");
  if (a.open !== undefined && !Array.isArray(a.open)) throw Error("invalid request");
  const open = ((a.open as unknown[] | undefined) ?? []).filter((id): id is string => typeof id === "string").slice(0, OPEN_MAX);
  return { count: a.count as number, lastId: a.lastId, open };
}

// A subagent's transcript for the agent map: the latest page, the page before item `before`, or what came after the
// items the phone holds (`after`) with the ones of them whose result has arrived since.
export async function agentTranscript(sessionId: string, cwd: string, args: Obj): Promise<AgentTranscript> {
  const byId = idArg(args.agentId);
  const byCall = idArg(args.toolUseId);
  if (!byId && !byCall) throw Error("invalid request");
  const after = afterArg(args.after);
  const before = args.before;
  if (before !== undefined && (!Number.isSafeInteger(before) || (before as number) < 0)) throw Error("invalid request");
  const where = folderOf(sessionId, cwd);
  const agentId = byId ?? (where && byCall ? await agentOfCall(where.dir, byCall) : undefined);
  const file = where && agentId ? await agentFile(where.dir, agentId) : undefined;
  if (!where || !agentId || !file) return { agentId: agentId ?? "", items: [], from: 0, total: 0, missing: true };
  const b = await current(sessionId, agentId, file, where.sdkDir, cwd);
  const total = b.items.length;
  const head = {
    agentId,
    total,
    ...(b.promptId ? { promptId: b.promptId } : {}),
    ...(b.agentType ? { agentType: b.agentType } : {}),
    ...(b.description ? { description: b.description } : {}),
  };
  const latest = () => ({ ...head, ...page(b, Math.max(0, total - PAGE), total) });
  if (after) {
    if (after.count === 0 || after.count > total || b.items[after.count - 1].id !== after.lastId) return { ...latest(), reset: true };
    const fresh = page(b, after.count, total);
    const changed = after.open.flatMap((id) => {
      const n = b.index.get(id);
      const item = n !== undefined && n < after.count ? b.items[n] : undefined;
      return item?.kind === "tool" && item.result ? [{ item, bytes: b.bytes[n!] }] : [];
    });
    const bytes = fresh.items.reduce((sum, _, n) => sum + b.bytes[fresh.from + n], 0) + changed.reduce((sum, c) => sum + c.bytes, 0);
    if (fresh.from !== after.count || bytes > BUDGET) return { ...latest(), reset: true };
    return { ...head, ...fresh, ...(changed.length ? { changed: changed.map((c) => c.item) } : {}) };
  }
  const to = before === undefined ? total : Math.min(before as number, total);
  return { ...head, ...page(b, Math.max(0, to - PAGE), to) };
}

// The agents of a workflow run as its journal lists them, with their labels and phases.
export async function workflowAgents(sessionId: string, cwd: string, runIdArg: unknown): Promise<WorkflowInfo> {
  const runId = idArg(runIdArg);
  if (!runId) throw Error("invalid request");
  const empty: WorkflowInfo = { phases: [], agents: [], total: 0, running: 0, done: 0, failed: 0 };
  const where = folderOf(sessionId, cwd);
  const folder = where && inside(path.join(where.dir, "workflows", runId), where.dir);
  const journal = folder && inside(path.join(folder, "journal.jsonl"), folder);
  if (!journal) return empty;
  const st = await fs.promises.stat(journal);
  if (!st.isFile() || st.size > JOURNAL_MAX) return empty;
  const seen = new Map<string, { label?: string; phase?: string; state: WorkflowAgentState }>();
  for (const line of (await fs.promises.readFile(journal, "utf8")).split("\n")) {
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(e) || typeof e.agentId !== "string" || !ID.test(e.agentId)) continue;
    const a = seen.get(e.agentId) ?? { state: "running" as WorkflowAgentState };
    if (e.type === "started") Object.assign(a, { state: "running", label: text(e.label, LABEL_MAX) ?? a.label, phase: text(e.phase, LABEL_MAX) ?? a.phase });
    else if (e.type === "result") a.state = "done";
    else if (e.type === "failed") a.state = "failed";
    else continue;
    seen.set(e.agentId, a);
  }
  const phases: string[] = [];
  const agents: WorkflowAgent[] = [];
  for (const [id, a] of [...seen].slice(0, WORKFLOW_AGENTS_MAX)) {
    const label = a.label ?? text((await readObj(path.join(folder, `agent-${id}.meta.json`), META_MAX))?.description, LABEL_MAX) ?? id;
    if (a.phase && !phases.includes(a.phase)) phases.push(a.phase);
    agents.push({ label, id, ...(a.phase ? { phase: phases.indexOf(a.phase) } : {}), state: a.state });
  }
  const all = [...seen.values()];
  return {
    phases,
    agents,
    total: all.length,
    running: all.filter((a) => a.state === "running").length,
    done: all.filter((a) => a.state === "done").length,
    failed: all.filter((a) => a.state === "failed").length,
  };
}
