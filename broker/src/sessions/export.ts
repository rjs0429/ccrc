import type { Lang } from "../lang.ts";
import type { DisplayItem, ExportInfo, NoteCode } from "../protocol.ts";

// The most characters a file holds; the items after it are left out and counted.
export const EXPORT_MAX = 10_000_000;
const TITLE_MAX = 200;
const NAME_MAX = 60;
const LINE_MAX = 300;

export interface ExportOptions {
  title: string;
  cwd: string;
  sessionId: string;
  at: Date;
  tz?: string;
  // A line for each tool call, background task and subagent report; questions, plans, commands and messages from
  // other sessions stay either way.
  tools: boolean;
  // The language of the headings and lines the broker writes; Claude's and the user's text stay as written.
  lang?: Lang;
}

type Tool = Extract<DisplayItem, { kind: "tool" }>;

interface ExportText {
  title: string;
  cwd: string;
  session: string;
  exported: string;
  user: string;
  note: Partial<Record<NoteCode, string>>;
  from: Record<Extract<DisplayItem, { kind: "message" }>["from"], string>;
  task: Record<string, string>;
  document: string;
  attached: (parts: string) => string;
  images: (n: number) => string;
  question: string;
  answer: string;
  unanswered: string;
  plan: string;
  approved: string;
  keptPlanning: string;
  failed: string;
  subagent: string;
  toolCalls: (n: number) => string;
  sentFile: string;
  notification: string;
  todos: string;
  todoItems: (n: string) => string;
  tool: string;
  background: string;
  command: string;
  error: string;
  unsent: string;
  fastCredits: string;
  fastFailed: string;
  cut: (n: number) => string;
  file: string;
}

const TEXT: Record<Lang, ExportText> = {
  ko: {
    title: "대화",
    cwd: "작업 폴더",
    session: "세션 ID",
    exported: "내보낸 때",
    user: "사용자",
    note: { interrupted: "중단됨", compacted: "이전 대화를 요약했습니다", ultracode: "Ultracode를 켜지 못했습니다" },
    from: { agent: "에이전트 보고", session: "다른 세션 메시지", channel: "채널 메시지" },
    task: { completed: "완료", failed: "실패", stopped: "중지됨" },
    document: "문서",
    attached: (parts) => `첨부: ${parts}`,
    images: (n) => `이미지 ${n}개`,
    question: "질문",
    answer: "답",
    unanswered: "답하지 않음",
    plan: "계획",
    approved: "승인함",
    keptPlanning: "계속 계획하기",
    failed: "오류",
    subagent: "서브에이전트",
    toolCalls: (n) => `도구 ${n}회`,
    sentFile: "보낸 파일",
    notification: "알림",
    todos: "할 일 목록",
    todoItems: (n) => `${n}개`,
    tool: "도구",
    background: "백그라운드 작업",
    command: "명령 출력",
    error: "오류",
    unsent: "Claude Code가 받지 못한 메시지",
    fastCredits: "Fast 모드: 사용 크레딧이 다 떨어졌습니다",
    fastFailed: "Fast 모드를 켜지 못했습니다",
    cut: (n) => `파일이 너무 커서 마지막 항목 ${n}개는 뺐습니다`,
    file: "대화",
  },
  en: {
    title: "Conversation",
    cwd: "Working folder",
    session: "Session ID",
    exported: "Exported",
    user: "User",
    note: { interrupted: "Interrupted", compacted: "Conversation compacted", ultracode: "Could not turn on Ultracode" },
    from: { agent: "Agent report", session: "Message from another session", channel: "Channel message" },
    task: { completed: "completed", failed: "failed", stopped: "stopped" },
    document: "document",
    attached: (parts) => `Attached: ${parts}`,
    images: (n) => `${n} ${n === 1 ? "image" : "images"}`,
    question: "Question",
    answer: "Answer",
    unanswered: "not answered",
    plan: "Plan",
    approved: "Approved",
    keptPlanning: "Kept planning",
    failed: "error",
    subagent: "Subagent",
    toolCalls: (n) => `${n} tool ${n === 1 ? "call" : "calls"}`,
    sentFile: "Sent file",
    notification: "Notification",
    todos: "To-do list",
    todoItems: (n) => `· ${n} ${n === "1" ? "item" : "items"}`,
    tool: "Tool",
    background: "Background task",
    command: "Command output",
    error: "Error",
    unsent: "Message Claude Code did not receive",
    fastCredits: "Fast mode: usage credits ran out",
    fastFailed: "Could not turn on Fast mode",
    cut: (n) => `The file was too large, so the last ${n} ${n === 1 ? "item was" : "items were"} left out`,
    file: "conversation",
  },
};

// A time zone the phone named, when this runtime knows it.
export function timeZone(tz: unknown): string | undefined {
  if (typeof tz !== "string" || !tz || tz.length > 64) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

function stamp(at: Date, tz?: string): { day: string; time: string } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

const oneLine = (text: string, max = LINE_MAX): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

// A fence longer than any run of backticks in the text.
function fenced(text: string, info = ""): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${text.replace(/\n+$/, "")}\n${fence}`;
}

const quoted = (text: string): string =>
  text
    .replace(/\n+$/, "")
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");

const code = (text: string): string => {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${longest ? " " : ""}${text}${longest ? " " : ""}${ticks}`;
};

function attachmentsLine(item: Extract<DisplayItem, { kind: "user" }>, w: ExportText): string | undefined {
  const list = item.attachments ?? [];
  if (!list.length) return undefined;
  const images = list.filter((a) => a.kind === "image").length;
  const docs = list.filter((a) => a.kind === "document").map((a) => a.name || w.document);
  return `*${w.attached([images ? w.images(images) : "", ...docs].filter(Boolean).join(", "))}*`;
}

// The questions a call asked and the user's answers.
function questionLines(item: Tool, w: ExportText): string[] {
  const input = item.input && typeof item.input === "object" ? (item.input as Record<string, unknown>) : {};
  const questions = Array.isArray(input.questions) ? input.questions.map((q) => (q && typeof q === "object" ? String((q as Record<string, unknown>).question ?? "") : "")).filter(Boolean) : [];
  const answers = item.reply?.kind === "answered" ? item.reply.answers : undefined;
  if (!questions.length) return [];
  return questions.map((q) => `- ${w.question}: ${oneLine(q)}${answers?.[q] ? ` → ${w.answer}: ${oneLine(answers[q])}` : item.reply ? ` (${w.unanswered})` : ""}`);
}

function planLines(item: Tool, w: ExportText): string[] {
  const input = item.input && typeof item.input === "object" ? (item.input as Record<string, unknown>) : {};
  const plan = item.reply?.kind === "approved" && item.reply.plan ? item.reply.plan : typeof input.plan === "string" ? input.plan : "";
  const r = item.reply;
  const how = r?.kind === "approved" ? w.approved : r?.kind === "kept_planning" ? `${w.keptPlanning}${r.feedback ? `: ${oneLine(r.feedback)}` : ""}` : "";
  return [`**${w.plan}**`, "", ...(plan ? [quoted(plan), ""] : []), ...(how ? [`*${how}*`] : [])];
}

function toolLine(item: Tool, w: ExportText): string | undefined {
  const s = item.summary ? ` · ${oneLine(item.summary)}` : "";
  const failed = item.result?.isError ? ` (${w.failed})` : "";
  if (item.name === "Agent" || item.name === "Task") return `- ${w.subagent}${s}${item.sub?.tools ? ` (${w.toolCalls(item.sub.tools)})` : ""}${failed}`;
  if (item.name === "SendUserFile") return `- ${w.sentFile}${s}${failed}`;
  if (item.name === "PushNotification") return `- ${w.notification}${s}`;
  if (item.name === "TodoWrite") return `- ${w.todos}${item.summary ? ` ${w.todoItems(item.summary)}` : ""}`;
  return `- ${w.tool} ${code(item.name || w.tool)}${s}${failed}`;
}

// The conversation as a Markdown file: a heading for each turn of the user and of Claude with its time, Claude's text as
// it wrote it, and a line for each tool call when asked for.
export function exportMarkdown(items: DisplayItem[], o: ExportOptions): ExportInfo {
  const w = TEXT[o.lang ?? "ko"];
  const now = stamp(o.at, o.tz);
  const title = oneLine(o.title, TITLE_MAX) || w.title;
  let text = [`# ${title}`, "", `- ${w.cwd}: ${code(o.cwd)}`, `- ${w.session}: ${code(o.sessionId)}`, `- ${w.exported}: ${now.day} ${now.time}${o.tz ? ` (${o.tz})` : ""}`, "", "---"].join("\n");
  let day = "";
  let section: "user" | "claude" | "other" | undefined;
  let listed = false;
  let messages = 0;
  let cut = 0;
  const heading = (who: string, ts?: string) => {
    const at = ts ? new Date(ts) : undefined;
    const s = at && !Number.isNaN(at.getTime()) ? stamp(at, o.tz) : undefined;
    const when = s ? (s.day === day ? s.time : `${s.day} ${s.time}`) : "";
    if (s) day = s.day;
    return `### ${who}${when ? ` · ${when}` : ""}`;
  };
  // Lines of one list stay together; every other block stands apart.
  const add = (block: string, kind: NonNullable<typeof section>, who: string | undefined, ts: string | undefined, list: boolean) => {
    const opened = who !== undefined && kind !== section;
    const piece = `${opened ? `\n\n${heading(who, ts)}` : ""}${list && listed && !opened ? "\n" : "\n\n"}${block}`;
    if (text.length + piece.length > EXPORT_MAX) return false;
    text += piece;
    section = kind;
    listed = list;
    return true;
  };
  for (const [n, item] of items.entries()) {
    let block: string | undefined;
    let kind: NonNullable<typeof section> = "claude";
    let who: string | undefined = "Claude";
    let list = false;
    switch (item.kind) {
      case "user":
        block = [item.text.replace(/\s+$/, ""), attachmentsLine(item, w)].filter(Boolean).join("\n\n");
        kind = "user";
        who = w.user;
        section = undefined;
        break;
      case "assistant":
        block = item.text.replace(/\s+$/, "");
        break;
      case "tool":
        if (item.name === "AskUserQuestion") {
          block = questionLines(item, w).join("\n") || undefined;
          list = true;
        } else if (item.name === "ExitPlanMode") block = planLines(item, w).join("\n");
        else if (o.tools) {
          block = toolLine(item, w);
          list = true;
        }
        break;
      case "task":
        if (o.tools) {
          block = `- ${w.background}${item.status ? ` ${w.task[item.status] ?? item.status}` : ""}${item.summary ? ` · ${oneLine(item.summary)}` : ""}`;
          list = true;
        }
        break;
      case "message":
        if (item.from !== "agent" || o.tools) {
          block = quoted(item.text);
          kind = "other";
          who = `${w.from[item.from]}${item.name ? ` · @${item.name}` : ""}`;
          section = undefined;
        }
        break;
      case "command":
        block = fenced(item.text, "text");
        kind = "other";
        who = `${w.command}${item.name ? ` · /${item.name}${item.args ? ` ${item.args}` : ""}` : ""}`;
        section = undefined;
        break;
      case "shell":
        block = fenced(`! ${item.command}${item.output ? `\n${item.output}` : ""}`);
        kind = "user";
        who = w.user;
        section = undefined;
        break;
      case "note":
        if (item.code === "command") {
          block = code(item.text ?? "");
          kind = "user";
          who = w.user;
          section = undefined;
        } else if (item.code === "error") block = `*${w.error}: ${oneLine(item.text ?? "")}*`;
        else if (item.code === "unsent") block = `*${w.unsent}${item.text ? `: ${oneLine(item.text)}` : ""}*`;
        else if (item.code === "fast") block = `*${item.text === "credits" ? w.fastCredits : w.fastFailed}*`;
        else if (w.note[item.code]) {
          block = `*${w.note[item.code]}*`;
          kind = "other";
          who = undefined;
        }
        break;
      case "thinking":
        break;
    }
    if (!block) continue;
    if (!add(block, kind, who, item.ts, list)) {
      cut = items.length - n;
      break;
    }
    if (item.kind === "user" || item.kind === "assistant") messages++;
  }
  if (cut) text += `\n\n*${w.cut(cut)}*`;
  return { name: exportName(o.title, o.at, o.tz, o.lang), text: `${text}\n`, messages, ...(cut ? { cut } : {}) };
}

// The title, made safe for a file name, and the time of the export.
export function exportName(title: string, at: Date, tz?: string, lang: Lang = "ko"): string {
  const s = stamp(at, tz);
  const base = [...oneLine(title, TITLE_MAX).replace(/[\x00-\x1f\x7f/\\:*?"<>|#%]/g, " ").replace(/\s+/g, " ").trim()]
    .slice(0, NAME_MAX)
    .join("")
    .replace(/[\s.]+$/, "");
  return `${base || TEXT[lang].file}-${s.day.replace(/-/g, "")}-${s.time.replace(":", "")}.md`;
}
