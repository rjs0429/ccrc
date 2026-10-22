import { memo, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { hideDialogCommands } from "../../../broker/src/dialog-commands.ts";
import type { DisplayItem, QueuedMessage, SubagentActivity, TaskInfo } from "../../../broker/src/protocol.ts";
import { k, t, tc } from "../i18n/index.ts";
import { clock, noteText } from "../labels.ts";
import { usePrefs } from "../prefs.ts";
import { useApp } from "../state.ts";
import { DiffView, PatchStats } from "./diff/DiffView.tsx";
import { Markdown } from "./Markdown.tsx";
import { ContextView } from "./sheets/Context.tsx";
import { UsageView } from "./sheets/Usage.tsx";
import { ToolInput, ToolOutput } from "./ToolInput.tsx";
import { UserAttachments } from "./UserAttachments.tsx";
import { OLD_WRAPPER_NOTE, movedOut, useMovable, useMove } from "./agents/background.ts";
import { AgentLinks } from "./agents/links.ts";
import { actionable, type UserMessage } from "./messageActions.ts";
import { NOT_KEPT, OfflineView } from "./offlineView.ts";
import { useLongPress } from "./useLongPress.ts";
import { Folded } from "./tools/parts.tsx";
import { SentFiles } from "./tools/SentFiles.tsx";
import { fullTime, stampTime, type Day } from "./stamps.ts";
import { chooseThought, liveThought, thoughtChoice } from "./thoughts.ts";
import { Icon, Spinner } from "./ui.tsx";

// When a message was sent, with the full date and time on hover.
function Stamp({ at, className }: { at: Date; className?: string }) {
  return (
    <time dateTime={at.toISOString()} title={fullTime(at)} className={className}>
      {clock(at)}
    </time>
  );
}

// A message the conversation can be forked from or rewound to opens its actions from a long press on its bubble or from
// the button before its time, whose target reaches 44px into the space around the line without making it taller.
function UserItem({ item, onActions }: { item: UserMessage; onActions?: (m: UserMessage) => void }) {
  const at = stampTime(item);
  const open = onActions && actionable(item) ? () => onActions(item) : undefined;
  const press = useLongPress(() => open?.());
  return (
    <div className="flex flex-col items-end gap-1.5">
      {item.attachments && <UserAttachments messageId={item.id} list={item.attachments} />}
      {item.text && (
        <div
          {...(open ? press : {})}
          className={`max-w-[88%] rounded-2xl rounded-br-md bg-surface-2 px-3.5 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap ${open ? "pointer-coarse:select-none pointer-coarse:[-webkit-touch-callout:none]" : ""}`}
        >
          {item.text}
        </div>
      )}
      {open ? (
        <div className="-mt-0.5 flex h-4 items-center gap-1 text-[11px] text-muted">
          <button
            onClick={open}
            aria-label={t("메시지 동작")}
            aria-haspopup="dialog"
            className="relative flex h-4 w-6 items-center justify-center rounded text-muted after:absolute after:-inset-x-2.5 after:-inset-y-3.5 active:text-fg"
            data-message-actions
          >
            <Icon.dots className="size-4" />
          </button>
          {at && <Stamp at={at} />}
        </div>
      ) : (
        at && <Stamp at={at} className="-mt-0.5 text-[11px] text-muted" />
      )}
    </div>
  );
}

// The line under a Claude reply's text that holds its time; while the reply streams, the same line holds the caret.
// The room under it holds the lower part of the ⋯ button's target, which stays off the reply's text.
const REPLY_LINE = "mt-1 h-4 leading-4";
const REPLY_ROOM = "pb-2";

type AssistantMessage = Extract<DisplayItem, { kind: "assistant" }>;

// A reply opens its actions as a message does: by a long press on its text, or from the button before its time. On a
// touch screen its text is selected in the actions sheet instead.
function AssistantItem({ item, onActions }: { item: AssistantMessage; onActions?: (m: AssistantMessage) => void }) {
  const at = stampTime(item);
  const open = onActions ? () => onActions(item) : undefined;
  const press = useLongPress(() => open?.());
  return (
    <div className={open ? REPLY_ROOM : undefined}>
      <div {...(open ? press : {})} className={open ? "pointer-coarse:select-none pointer-coarse:[-webkit-touch-callout:none]" : ""}>
        <Markdown text={item.text} className="text-[15px]" />
      </div>
      {(at || open) && (
        <div className={`${REPLY_LINE} flex items-center gap-1 text-[11px] text-muted`}>
          {open && (
            <button
              onClick={open}
              aria-label={t("답 동작")}
              aria-haspopup="dialog"
              className="relative -ml-1 flex h-4 w-6 items-center justify-center rounded text-muted after:absolute after:-inset-x-2.5 after:-top-1 after:-bottom-6 active:text-fg"
              data-reply-actions
            >
              <Icon.dots className="size-4" />
            </button>
          )}
          {at && <Stamp at={at} />}
        </div>
      )}
    </div>
  );
}

// Where the local day changes in the conversation: the day between two thin rules.
export function DateLine({ day }: { day?: Day }) {
  if (!day) return null;
  return (
    <div className="flex items-center gap-3 text-xs text-muted" data-day={day.date}>
      <span className="h-px flex-1 bg-line" />
      <time dateTime={day.date}>{day.label}</time>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

// A message Claude Code has not taken in yet. One sent from here can be taken back.
// note: what the line under it says in place of "대기 중".
export function QueuedItem({ message, host, onTakeBack, taking, note }: { message: QueuedMessage; host: string; onTakeBack?: () => void; taking?: boolean; note?: string }) {
  return (
    <div className="flex flex-col items-end" data-queued={message.id}>
      <div className="flex max-w-[88%] items-end gap-1">
        {onTakeBack && (
          <button onClick={onTakeBack} disabled={taking} aria-label={t("보내지 않기")} className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted disabled:opacity-40">
            <Icon.x className="size-4" />
          </button>
        )}
        <div className="flex min-w-0 flex-col items-end gap-1.5">
          {message.attachments && <UserAttachments messageId={message.id} list={message.attachments} waiting />}
          {message.text && (
            <div className="min-w-0 rounded-2xl rounded-br-md border border-dashed border-line bg-surface-2/60 px-3.5 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-muted">
              {message.text}
            </div>
          )}
        </div>
      </div>
      <div className="mt-1 text-[11px] text-muted">
        {taking ? tc("queued message", "되돌리는 중…") : note ? note : message.from === "host" && host ? t("대기 중 · {host}에서 보냄", { host }) : t("대기 중")}
      </div>
    </div>
  );
}

// Thinking starts open or closed as the device setting says; a box opened or closed by hand stays so. id: the item's;
// a thought still streaming has none.
function Thinking({ id, text }: { id?: string; text: string }) {
  const { thinkingOpen } = usePrefs();
  const [mine, setMine] = useState(() => thoughtChoice(id, text));
  const live = id === undefined;
  useEffect(() => {
    if (live) liveThought(text, mine);
  }, [live, text, mine]);
  if (live && !text) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted" data-thinking="live">
        <Spinner className="size-3.5" />
        {t("생각하는 중…")}
      </div>
    );
  }
  const open = mine ?? thinkingOpen;
  const turn = () => {
    setMine(!open);
    if (id) chooseThought(id, !open);
  };
  return (
    <div data-thinking={live ? "live" : "done"}>
      <button onClick={turn} aria-expanded={open} className="flex items-center gap-1 text-sm text-muted">
        {live && <Spinner className="mr-1 size-3.5" />}
        <span>{live ? t("생각하는 중…") : "Thinking"}</span>
        <Icon.chevronDown className={`size-4 transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && <div className="mt-1.5 border-l-2 border-line pl-3 text-sm text-muted whitespace-pre-wrap">{text}</div>}
    </div>
  );
}

// While its agent runs the activity never gets shorter at the width it has, so each step it reports does not move what
// is below it; at another width (the phone turned) it is measured afresh.
function SubActivity({ sub, running }: { sub: SubagentActivity; running: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const tallest = useRef({ width: 0, height: 0 });
  const hold = () => {
    const el = ref.current;
    if (!el) return;
    if (!running) {
      tallest.current = { width: 0, height: 0 };
      el.style.minHeight = "";
      return;
    }
    const width = el.getBoundingClientRect().width;
    if (width !== tallest.current.width) {
      el.style.minHeight = "";
      tallest.current = { width, height: 0 };
    }
    const height = el.getBoundingClientRect().height;
    if (height > tallest.current.height) {
      tallest.current.height = height;
      el.style.minHeight = `${height}px`;
    }
  };
  useLayoutEffect(hold);
  // The first row spans the activity's width and not its held height, so watching it sees a change of width alone.
  useEffect(() => {
    if (!running || !head.current) return;
    const resized = new ResizeObserver(hold);
    resized.observe(head.current);
    return () => resized.disconnect();
  }, [running]);
  return (
    <div ref={ref} className="space-y-1 border-t border-line px-3 py-2">
      <div ref={head} className="text-xs text-muted">{t("도구 {n}회", { n: sub.tools })}</div>
      {sub.recent.map((r, n) => (
        <div key={n} className="truncate font-mono text-[12px] text-muted">
          <span className="text-fg">{r.name}</span> {r.summary}
        </div>
      ))}
      {sub.text && <div className="line-clamp-3 text-[13px] whitespace-pre-wrap text-muted">{sub.text}</div>}
    </div>
  );
}

// The calls Claude Code can move to the background while the turn waits on them.
const MOVABLE_CALLS = new Set(["Bash", "PowerShell", "Agent", "Task"]);

// Under a call the turn waits on, once it has run a while: a way to move it to the background; once moved, that it runs
// there.
function BackgroundLine({ item, task }: { item: Extract<DisplayItem, { kind: "tool" }>; task: TaskInfo }) {
  const sessionId = useApp((s) => s.chat?.sessionId);
  const { movable, old } = useMovable(task);
  const { moving, move } = useMove(sessionId);
  if (movedOut(sessionId, item.id, task, item.result?.text)) {
    return (
      <div className="flex min-h-11 items-center border-t border-line px-3 text-sm text-muted" data-background-running={item.id}>
        {t("백그라운드에서 실행 중")}
      </div>
    );
  }
  if (old) {
    return (
      <div className="border-t border-line px-3 py-2.5 text-xs break-keep text-muted" data-background-old={item.id}>
        {t(OLD_WRAPPER_NOTE)}
      </div>
    );
  }
  if (!movable && !moving) return null;
  return (
    <button onClick={() => move(item.id)} disabled={moving} className="flex min-h-11 w-full items-center border-t border-line px-3 text-left text-sm font-medium text-accent disabled:opacity-50" data-background={item.id}>
      {moving ? t("보내는 중…") : t("백그라운드로")}
    </button>
  );
}

function ToolItem({ item, running }: { item: Extract<DisplayItem, { kind: "tool" }>; running: boolean }) {
  const [open, setOpen] = useState(false);
  const openAgent = useContext(AgentLinks);
  const offline = useContext(OfflineView);
  // A call that went on in the background is still running after its result arrived.
  const task = useApp((s) => s.chat?.state?.tasks?.find((t) => t.toolUseId === item.id && t.status === "running"));
  const background = Boolean(task);
  const active = background || (!item.result && running);
  // A subagent known by its id alone has done nothing to show yet.
  const sub = item.sub && (item.sub.tools || item.sub.recent.length || item.sub.text) ? item.sub : undefined;
  const notice = item.name === "PushNotification" && !item.result?.isError;
  const status =
    item.result && !background ? (
      notice ? (
        <Icon.bell className="size-4 text-accent" />
      ) : item.result.isError ? (
        <Icon.x className="size-4 text-danger" />
      ) : (
        <Icon.check className="size-4 text-ok" />
      )
    ) : active ? (
      <Spinner className="size-4 text-muted" />
    ) : (
      <span className="size-4" />
    );
  return (
    <div className="rounded-xl border border-line bg-surface">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        {status}
        <span className="shrink-0 text-sm font-medium">{item.name || t("도구")}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-muted">{item.summary}</span>
        {item.patch && <PatchStats hunks={item.patch} />}
        {sub && !active && !open && <span className="shrink-0 text-xs text-muted">{t("도구 {n}회", { n: sub.tools })}</span>}
        <Icon.chevronDown className={`size-4 shrink-0 text-muted transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {sub && (active || open) && <SubActivity sub={sub} running={active} />}
      {open && (
        <div className="space-y-2 border-t border-line px-3 py-2.5">
          {item.patch ? (
            <DiffView hunks={item.patch} cut={item.patchCut} />
          ) : item.input != null ? (
            <ToolInput name={item.name} input={item.input} reply={item.reply} />
          ) : (
            offline && <p className="text-xs text-muted" data-copy-note>{t(NOT_KEPT)}</p>
          )}
          {item.result && (!item.patch || item.result.isError) && !item.reply && !offline && (
            <ToolOutput text={item.result.text + (item.result.truncated ? "\n…" : "")} isError={item.result.isError} />
          )}
        </div>
      )}
      {openAgent && (item.name === "Agent" || item.name === "Task") && (
        <button
          onClick={() => openAgent({ ...(item.sub?.agentId ? { agentId: item.sub.agentId } : {}), toolUseId: item.id, title: item.summary || t("서브에이전트") })}
          className="flex min-h-11 w-full items-center justify-between border-t border-line px-3 text-left text-sm font-medium text-accent"
          data-open-transcript={item.id}
        >
          {t("기록 보기")}
          <Icon.chevronRight className="size-4" />
        </button>
      )}
      {task && MOVABLE_CALLS.has(item.name) && <BackgroundLine item={item} task={task} />}
    </div>
  );
}

type CommandResult = Extract<DisplayItem, { kind: "command" }>;

// Command output is written line by line; Markdown would join adjacent lines, so they become hard breaks
// outside code fences and tables.
function keepLines(text: string): string {
  const fence = (l: string) => /^\s*(```|~~~)/.test(l);
  const plain = (l?: string) => l !== undefined && l.trim() !== "" && !l.trimStart().startsWith("|") && !fence(l);
  let fenced = false;
  const lines = text.split("\n");
  return lines
    .map((line, i) => {
      if (fence(line)) fenced = !fenced;
      return !fenced && plain(line) && plain(lines[i + 1]) ? `${line}  ` : line;
    })
    .join("\n");
}

// A local command's result: /usage and /context drawn from their data, any other output as text.
export function CommandBody({ item, more }: { item: CommandResult; more?: boolean }) {
  return (
    <>
      {item.usage ? <UsageView usage={item.usage} /> : item.context ? <ContextView detail={item.context} full={more} /> : <Folded text={keepLines(item.text)} />}
      {item.usage && more && (
        <div className="mt-3 border-t border-line pt-2">
          <Folded text={item.text} mono />
        </div>
      )}
    </>
  );
}

function CommandCard({ item }: { item: CommandResult }) {
  const [more, setMore] = useState(false);
  const offline = useContext(OfflineView);
  const head = item.name ? `/${item.name}${item.args ? ` ${item.args}` : ""}` : t("명령 출력");
  return (
    <div className="rounded-xl border border-line bg-surface" data-command={item.name ?? ""}>
      <div className="flex items-center gap-2 px-3 pt-2 pb-1">
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-muted">{head}</span>
        {(item.context || (item.usage && item.text)) && (
          <button onClick={() => setMore(!more)} className="shrink-0 text-xs font-medium text-accent">
            {more ? t("접기") : item.context ? t("자세히") : t("원문")}
          </button>
        )}
      </div>
      <div className="px-3 pb-3 pt-1">
        {offline ? (
          <p className="text-xs text-muted" data-copy-note>
            {t(NOT_KEPT)}
          </p>
        ) : (
          <CommandBody item={item} more={more} />
        )}
      </div>
    </div>
  );
}

const SENDER_LABEL: Record<Extract<DisplayItem, { kind: "message" }>["from"], string> = {
  agent: k("에이전트 보고"),
  session: k("다른 세션 메시지"),
  channel: k("채널 메시지"),
};

// The first line of a Markdown text as plain words, for a folded card.
function leadLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim() && !/^\s*(```|~~~|---+\s*$|\|)/.test(l)) ?? "";
  return line
    .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .trim();
}

// A message Claude Code passed on from a subagent, another session or a channel: folded to its first line.
function MessageCard({ item }: { item: Extract<DisplayItem, { kind: "message" }> }) {
  const [open, setOpen] = useState(false);
  const lead = leadLine(item.text);
  return (
    <div className="rounded-xl border border-line bg-surface/60" data-message={item.from}>
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-h-11 w-full items-start gap-2 px-3 py-2 text-left">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-muted">
            {t(SENDER_LABEL[item.from])}
            {item.name && ` · @${item.name}`}
          </span>
          {!open && lead && <span className="mt-0.5 block truncate text-[13px] text-muted">{lead}</span>}
        </span>
        <Icon.chevronDown className={`mt-0.5 size-4 shrink-0 text-muted transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && (
        <div className="border-t border-line px-3 py-2.5">
          <Markdown text={item.text} className="text-[14px]" />
        </div>
      )}
    </div>
  );
}

const TASK_STATUS: Record<NonNullable<Extract<DisplayItem, { kind: "task" }>["status"]>, string> = {
  completed: k("완료"),
  failed: k("실패"),
  stopped: k("중지됨"),
};

// Claude Code's notice about a background task as one line; the result or event it carried opens below, and so
// does a summary longer than the narrowest line holds.
function TaskNote({ item }: { item: Extract<DisplayItem, { kind: "task" }> }) {
  const [open, setOpen] = useState(false);
  const more = Boolean(item.text) || [...item.summary].length > 20 || item.summary.includes("\n");
  const icon =
    item.status === "completed" ? (
      <Icon.check className="size-3.5 shrink-0 text-ok" />
    ) : item.status === "failed" ? (
      <Icon.x className="size-3.5 shrink-0 text-danger" />
    ) : item.status === "stopped" ? (
      <Icon.stop className="size-3.5 shrink-0 text-muted" />
    ) : (
      <span className="mx-[5px] size-1.5 shrink-0 rounded-full bg-current" />
    );
  const line = (
    <>
      {icon}
      <span className={`min-w-0 flex-1 ${open ? "whitespace-pre-wrap" : "truncate"}`}>
        {item.status ? t(TASK_STATUS[item.status]) : tc("task note", "알림")}
        {item.summary && ` · ${item.summary}`}
      </span>
    </>
  );
  return (
    <div data-task={item.status ?? "event"}>
      {more ? (
        <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-h-8 w-full items-center gap-1.5 text-left text-xs text-muted">
          {line}
          <Icon.chevronDown className={`size-3.5 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} />
        </button>
      ) : (
        <div className="flex min-h-8 items-center gap-1.5 text-xs text-muted">{line}</div>
      )}
      {open && item.text && (
        <div className="mt-1 ml-5 border-l-2 border-line pl-3 text-muted">
          <Markdown text={item.text} className="text-[13px]" />
        </div>
      )}
    </div>
  );
}

// A command run with "!" in the terminal and its output.
function ShellCard({ item }: { item: Extract<DisplayItem, { kind: "shell" }> }) {
  return (
    <div className="rounded-xl border border-line bg-surface" data-shell>
      <div className="px-3 py-2 font-mono text-[12.5px] break-all whitespace-pre-wrap text-muted">{item.command ? `! ${item.command}` : t("명령 출력")}</div>
      {item.output && (
        <div className="px-3 pb-3">
          <Folded text={item.output} mono />
        </div>
      )}
    </div>
  );
}

const USAGE_NAMES = new Set(["usage", "cost", "stats"]);
const commandOf = (item?: DisplayItem) => (item?.kind === "command" && item.name ? (USAGE_NAMES.has(item.name) ? "usage" : item.name) : undefined);

// Dialog commands show only in sheets. The "/name" line next to the card of the same command says nothing
// the card's head does not.
export function shownItems(all: DisplayItem[]): DisplayItem[] {
  const items = hideDialogCommands(all);
  return items.filter((item, i) => {
    if (item.kind !== "note" || item.code !== "command") return true;
    let name = /^\/(\S+)/.exec(item.text ?? "")?.[1];
    if (name && USAGE_NAMES.has(name)) name = "usage";
    return !name || (commandOf(items[i - 1]) !== name && commandOf(items[i + 1]) !== name);
  });
}

// onMessage, onReply: open the actions of a message the user sent and of Claude's reply; without them, they offer none.
export const ItemView = memo(function ItemView({
  item,
  running,
  onMessage,
  onReply,
}: {
  item: DisplayItem;
  running: boolean;
  onMessage?: (m: UserMessage) => void;
  onReply?: (m: AssistantMessage) => void;
}) {
  switch (item.kind) {
    case "user":
      return <UserItem item={item} onActions={onMessage} />;
    case "assistant":
      return <AssistantItem item={item} onActions={onReply} />;
    case "thinking":
      return <Thinking id={item.id} text={item.text} />;
    case "tool":
      return item.name === "SendUserFile" ? <SentFiles item={item} running={running} /> : <ToolItem item={item} running={running} />;
    case "command":
      return <CommandCard item={item} />;
    case "message":
      return <MessageCard item={item} />;
    case "task":
      return <TaskNote item={item} />;
    case "shell":
      return <ShellCard item={item} />;
    case "note":
      return (
        <div className={`text-center text-xs whitespace-pre-wrap ${item.code === "error" ? "text-danger" : "text-muted"}`}>
          {noteText(item.code, item.text, item.attachments)}
        </div>
      );
  }
});

export function StreamPreview({ text, thinking }: { text: string; thinking: boolean }) {
  if (thinking) return <Thinking text={text} />;
  return (
    <div className={REPLY_ROOM}>
      <Markdown text={text} className="text-[15px]" />
      <div className={`${REPLY_LINE} caret text-[15px]`} />
    </div>
  );
}
