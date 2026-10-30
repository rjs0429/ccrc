import { useState } from "react";
import type { DisplayItem, ModelOption } from "../../../broker/src/protocol.ts";
import { useApp } from "../state.ts";
import { noticeText, safeguarded } from "./notices.ts";
import { Icon } from "./ui.tsx";

const NO_MODELS: ModelOption[] = [];

// A notice Claude Code showed, as one line: a model's safeguards with a shield, any other line with a dot. A line cut
// short opens to its whole text, and to what Claude Code said itself.
export function NoticeLine({ item }: { item: Extract<DisplayItem, { kind: "notice" }> }) {
  const models = useApp((s) => s.options?.models) ?? NO_MODELS;
  const [open, setOpen] = useState(false);
  const { text, more } = noticeText(item, models);
  const warn = item.notice !== "line" || item.level === "warning";
  const icon = safeguarded(item) ? (
    <Icon.shield className={`size-3.5 shrink-0 ${warn ? "text-warn" : ""}`} />
  ) : (
    <span className={`mx-[5px] size-1.5 shrink-0 rounded-full ${warn ? "bg-warn" : "bg-current"}`} />
  );
  const line = (
    <>
      {icon}
      <span className={`min-w-0 flex-1 ${open ? "whitespace-pre-wrap" : "truncate"}`}>{text}</span>
    </>
  );
  const opens = Boolean(more) || [...text].length > 30;
  return (
    <div data-notice={item.notice}>
      {opens ? (
        <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-h-8 w-full items-center gap-1.5 text-left text-xs text-muted">
          {line}
          <Icon.chevronDown className={`size-3.5 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} />
        </button>
      ) : (
        <div className="flex min-h-8 items-center gap-1.5 text-xs text-muted">{line}</div>
      )}
      {open && more && (
        <div className="selectable mt-1 ml-5 border-l-2 border-line pl-3 text-[13px] break-words whitespace-pre-wrap text-muted" data-notice-more>
          {more}
        </div>
      )}
    </div>
  );
}
