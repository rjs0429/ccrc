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
}

type Tool = Extract<DisplayItem, { kind: "tool" }>;

const NOTE: Partial<Record<NoteCode, string>> = {
  interrupted: "중단됨",
  compacted: "이전 대화를 요약했습니다",
  ultracode: "Ultracode를 켜지 못했습니다",
};

const FROM: Record<Extract<DisplayItem, { kind: "message" }>["from"], string> = {
  agent: "에이전트 보고",
  session: "다른 세션 메시지",
  channel: "채널 메시지",
};

const TASK: Record<string, string> = { completed: "완료", failed: "실패", stopped: "중지됨" };

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

function attachmentsLine(item: Extract<DisplayItem, { kind: "user" }>): string | undefined {
  const list = item.attachments ?? [];
  if (!list.length) return undefined;
  const images = list.filter((a) => a.kind === "image").length;
  const docs = list.filter((a) => a.kind === "document").map((a) => a.name || "문서");
  return `*첨부: ${[images ? `이미지 ${images}개` : "", ...docs].filter(Boolean).join(", ")}*`;
}

// The questions a call asked and the user's answers.
function questionLines(item: Tool): string[] {
  const input = item.input && typeof item.input === "object" ? (item.input as Record<string, unknown>) : {};
  const questions = Array.isArray(input.questions) ? input.questions.map((q) => (q && typeof q === "object" ? String((q as Record<string, unknown>).question ?? "") : "")).filter(Boolean) : [];
  const answers = item.reply?.kind === "answered" ? item.reply.answers : undefined;
  if (!questions.length) return [];
  return questions.map((q) => `- 질문: ${oneLine(q)}${answers?.[q] ? ` → 답: ${oneLine(answers[q])}` : item.reply ? " (답하지 않음)" : ""}`);
}

function planLines(item: Tool): string[] {
  const input = item.input && typeof item.input === "object" ? (item.input as Record<string, unknown>) : {};
  const plan = item.reply?.kind === "approved" && item.reply.plan ? item.reply.plan : typeof input.plan === "string" ? input.plan : "";
  const r = item.reply;
  const how = r?.kind === "approved" ? "승인함" : r?.kind === "kept_planning" ? `계속 계획하기${r.feedback ? `: ${oneLine(r.feedback)}` : ""}` : "";
  return ["**계획**", "", ...(plan ? [quoted(plan), ""] : []), ...(how ? [`*${how}*`] : [])];
}

function toolLine(item: Tool): string | undefined {
  const s = item.summary ? ` · ${oneLine(item.summary)}` : "";
  const failed = item.result?.isError ? " (오류)" : "";
  if (item.name === "Agent" || item.name === "Task") return `- 서브에이전트${s}${item.sub?.tools ? ` (도구 ${item.sub.tools}회)` : ""}${failed}`;
  if (item.name === "SendUserFile") return `- 보낸 파일${s}${failed}`;
  if (item.name === "PushNotification") return `- 알림${s}`;
  if (item.name === "TodoWrite") return `- 할 일 목록${item.summary ? ` ${item.summary}개` : ""}`;
  return `- 도구 ${code(item.name || "도구")}${s}${failed}`;
}

// The conversation as a Markdown file: a heading for each turn of the user and of Claude with its time, Claude's text as
// it wrote it, and a line for each tool call when asked for.
export function exportMarkdown(items: DisplayItem[], o: ExportOptions): ExportInfo {
  const now = stamp(o.at, o.tz);
  const title = oneLine(o.title, TITLE_MAX) || "대화";
  let text = [`# ${title}`, "", `- 작업 폴더: ${code(o.cwd)}`, `- 세션 ID: ${code(o.sessionId)}`, `- 내보낸 때: ${now.day} ${now.time}${o.tz ? ` (${o.tz})` : ""}`, "", "---"].join("\n");
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
        block = [item.text.replace(/\s+$/, ""), attachmentsLine(item)].filter(Boolean).join("\n\n");
        kind = "user";
        who = "사용자";
        section = undefined;
        break;
      case "assistant":
        block = item.text.replace(/\s+$/, "");
        break;
      case "tool":
        if (item.name === "AskUserQuestion") {
          block = questionLines(item).join("\n") || undefined;
          list = true;
        } else if (item.name === "ExitPlanMode") block = planLines(item).join("\n");
        else if (o.tools) {
          block = toolLine(item);
          list = true;
        }
        break;
      case "task":
        if (o.tools) {
          block = `- 백그라운드 작업${item.status ? ` ${TASK[item.status]}` : ""}${item.summary ? ` · ${oneLine(item.summary)}` : ""}`;
          list = true;
        }
        break;
      case "message":
        if (item.from !== "agent" || o.tools) {
          block = quoted(item.text);
          kind = "other";
          who = `${FROM[item.from]}${item.name ? ` · @${item.name}` : ""}`;
          section = undefined;
        }
        break;
      case "command":
        block = fenced(item.text, "text");
        kind = "other";
        who = `명령 출력${item.name ? ` · /${item.name}${item.args ? ` ${item.args}` : ""}` : ""}`;
        section = undefined;
        break;
      case "shell":
        block = fenced(`! ${item.command}${item.output ? `\n${item.output}` : ""}`);
        kind = "user";
        who = "사용자";
        section = undefined;
        break;
      case "note":
        if (item.code === "command") {
          block = code(item.text ?? "");
          kind = "user";
          who = "사용자";
          section = undefined;
        } else if (item.code === "error") block = `*오류: ${oneLine(item.text ?? "")}*`;
        else if (item.code === "unsent") block = `*Claude Code가 받지 못한 메시지${item.text ? `: ${oneLine(item.text)}` : ""}*`;
        else if (item.code === "fast") block = item.text === "credits" ? "*Fast 모드: 사용 크레딧이 다 떨어졌습니다*" : "*Fast 모드를 켜지 못했습니다*";
        else if (NOTE[item.code]) {
          block = `*${NOTE[item.code]}*`;
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
  if (cut) text += `\n\n*파일이 너무 커서 마지막 항목 ${cut}개는 뺐습니다*`;
  return { name: exportName(o.title, o.at, o.tz), text: `${text}\n`, messages, ...(cut ? { cut } : {}) };
}

// The title, made safe for a file name, and the time of the export.
export function exportName(title: string, at: Date, tz?: string): string {
  const s = stamp(at, tz);
  const base = [...oneLine(title, TITLE_MAX).replace(/[\x00-\x1f\x7f/\\:*?"<>|#%]/g, " ").replace(/\s+/g, " ").trim()]
    .slice(0, NAME_MAX)
    .join("")
    .replace(/[\s.]+$/, "");
  return `${base || "대화"}-${s.day.replace(/-/g, "")}-${s.time.replace(":", "")}.md`;
}
