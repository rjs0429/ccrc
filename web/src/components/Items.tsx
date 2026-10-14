import { memo, useState } from "react";
import { hideDialogCommands } from "../../../broker/src/dialog-commands.ts";
import type { DisplayItem, QueuedMessage, SubagentActivity } from "../../../broker/src/protocol.ts";
import { clock, noteText } from "../labels.ts";
import { useApp } from "../state.ts";
import { DiffView, PatchStats } from "./diff/DiffView.tsx";
import { Markdown } from "./Markdown.tsx";
import { ContextView } from "./sheets/Context.tsx";
import { UsageView } from "./sheets/Usage.tsx";
import { ToolInput, ToolOutput } from "./ToolInput.tsx";
import { UserAttachments } from "./UserAttachments.tsx";
import { Folded } from "./tools/parts.tsx";
import { Icon, Spinner } from "./ui.tsx";

function UserItem({ item }: { item: Extract<DisplayItem, { kind: "user" }> }) {
  return (
    <div className="flex flex-col items-end gap-1.5">
      {item.attachments && <UserAttachments messageId={item.id} list={item.attachments} />}
      {item.text && <div className="max-w-[88%] rounded-2xl rounded-br-md bg-surface-2 px-3.5 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap">{item.text}</div>}
      {item.ts && <div className="-mt-0.5 text-[11px] text-muted">{clock(item.ts)}</div>}
    </div>
  );
}

// A message Claude Code has not taken in yet. One sent from here can be taken back.
export function QueuedItem({ message, host, onTakeBack, taking }: { message: QueuedMessage; host: string; onTakeBack?: () => void; taking?: boolean }) {
  return (
    <div className="flex flex-col items-end" data-queued={message.id}>
      <div className="flex max-w-[88%] items-end gap-1">
        {onTakeBack && (
          <button onClick={onTakeBack} disabled={taking} aria-label="보내지 않기" className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted disabled:opacity-40">
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
        {taking ? "되돌리는 중…" : message.from === "host" && host ? `대기 중 · ${host}에서 보냄` : "대기 중"}
      </div>
    </div>
  );
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1 text-sm text-muted">
        <span>Thinking</span>
        <Icon.chevronDown className={`size-4 transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && <div className="mt-1.5 border-l-2 border-line pl-3 text-sm text-muted whitespace-pre-wrap">{text}</div>}
    </div>
  );
}

function SubActivity({ sub }: { sub: SubagentActivity }) {
  return (
    <div className="space-y-1 border-t border-line px-3 py-2">
      <div className="text-xs text-muted">도구 {sub.tools}회</div>
      {sub.recent.map((r, n) => (
        <div key={n} className="truncate font-mono text-[12px] text-muted">
          <span className="text-fg">{r.name}</span> {r.summary}
        </div>
      ))}
      {sub.text && <div className="line-clamp-3 text-[13px] whitespace-pre-wrap text-muted">{sub.text}</div>}
    </div>
  );
}

function ToolItem({ item, running }: { item: Extract<DisplayItem, { kind: "tool" }>; running: boolean }) {
  const [open, setOpen] = useState(false);
  // A call that went on in the background is still running after its result arrived.
  const background = useApp((s) => Boolean(s.chat?.state?.tasks?.some((t) => t.toolUseId === item.id && t.status === "running")));
  const active = background || (!item.result && running);
  const status =
    item.result && !background ? (
      item.result.isError ? (
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
        <span className="shrink-0 text-sm font-medium">{item.name || "도구"}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-muted">{item.summary}</span>
        {item.patch && <PatchStats hunks={item.patch} />}
        {item.sub && !active && !open && <span className="shrink-0 text-xs text-muted">도구 {item.sub.tools}회</span>}
        <Icon.chevronDown className={`size-4 shrink-0 text-muted transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {item.sub && (active || open) && <SubActivity sub={item.sub} />}
      {open && (
        <div className="space-y-2 border-t border-line px-3 py-2.5">
          {item.patch ? (
            <DiffView hunks={item.patch} cut={item.patchCut} />
          ) : (
            item.input != null && <ToolInput name={item.name} input={item.input} reply={item.reply} />
          )}
          {item.result && (!item.patch || item.result.isError) && !item.reply && (
            <ToolOutput text={item.result.text + (item.result.truncated ? "\n…" : "")} isError={item.result.isError} />
          )}
        </div>
      )}
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
  const head = item.name ? `/${item.name}${item.args ? ` ${item.args}` : ""}` : "명령 출력";
  return (
    <div className="rounded-xl border border-line bg-surface" data-command={item.name ?? ""}>
      <div className="flex items-center gap-2 px-3 pt-2 pb-1">
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-muted">{head}</span>
        {(item.context || (item.usage && item.text)) && (
          <button onClick={() => setMore(!more)} className="shrink-0 text-xs font-medium text-accent">
            {more ? "접기" : item.context ? "자세히" : "원문"}
          </button>
        )}
      </div>
      <div className="px-3 pb-3 pt-1">
        <CommandBody item={item} more={more} />
      </div>
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

export const ItemView = memo(function ItemView({ item, running }: { item: DisplayItem; running: boolean }) {
  switch (item.kind) {
    case "user":
      return <UserItem item={item} />;
    case "assistant":
      return <Markdown text={item.text} className="text-[15px]" />;
    case "thinking":
      return <Thinking text={item.text} />;
    case "tool":
      return <ToolItem item={item} running={running} />;
    case "command":
      return <CommandCard item={item} />;
    case "note":
      return (
        <div className={`text-center text-xs whitespace-pre-wrap ${item.code === "error" ? "text-danger" : "text-muted"}`}>
          {noteText(item.code, item.text)}
        </div>
      );
  }
});

export function StreamPreview({ text, thinking }: { text: string; thinking: boolean }) {
  if (thinking) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Spinner className="size-3.5" />
        생각하는 중…
      </div>
    );
  }
  return <Markdown text={text} className="caret text-[15px]" />;
}
