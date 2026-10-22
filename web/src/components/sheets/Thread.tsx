import { useLayoutEffect, useRef } from "react";
import type { Thread } from "../../../../broker/src/search-protocol.ts";
import { shortDateTime } from "../../i18n/format.ts";
import { t } from "../../i18n/index.ts";
import { Markdown } from "../Markdown.tsx";
import { Sheet } from "../ui.tsx";

export type ShownThread = Thread & { earlier?: boolean };

export function threadTitle(thread: ShownThread): string {
  return thread.earlier ? t("요약 전 대화") : thread.rewound ? t("되감기 전 대화") : t("대화 기록");
}

function when(at?: number): string {
  return at ? shortDateTime(new Date(at)) : "";
}

// A search hit the chat view does not hold, read-only, with the messages around it along its own branch.
export function ThreadSheet({ thread, onClose }: { thread: ShownThread; onClose: () => void }) {
  const focusRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    focusRef.current?.scrollIntoView({ block: "center" });
  }, [thread]);
  const split = thread.rewound && !thread.earlier ? thread.messages.findIndex((m, i) => !m.shared && i > 0 && thread.messages[i - 1].shared) : -1;
  return (
    <Sheet title={threadTitle(thread)} onClose={onClose}>
      <div className="mb-3 rounded-xl bg-surface-2 px-3 py-2 text-xs text-muted" data-thread-note>
        {thread.earlier
          ? t("요약하기 전의 대화라 대화 화면에는 없습니다. 읽기만 할 수 있습니다.")
          : thread.rewound
            ? t("되감기로 지금 대화에서 빠진 가지입니다. 읽기만 할 수 있습니다.")
            : t("읽기만 할 수 있습니다.")}
      </div>
      <div className="space-y-3" data-thread>
        {thread.messages.map((m, i) => (
          <div key={m.id}>
            {i === split && (
              <div className="mb-3 flex items-center gap-3 text-xs text-muted" data-thread-split>
                <span className="h-px flex-1 bg-line" />
                {t("여기서부터 되감기 전 가지")}
                <span className="h-px flex-1 bg-line" />
              </div>
            )}
            <div
              ref={m.id === thread.focus ? focusRef : undefined}
              data-thread-item={m.id}
              className={`rounded-xl px-3 py-2 ${m.id === thread.focus ? "ring-2 ring-accent/70" : ""} ${m.role === "user" ? "bg-accent-soft" : "bg-bg"} ${m.shared ? "opacity-60" : ""}`}
            >
              <div className="mb-1 text-[11px] text-muted">
                {m.role === "user" ? t("나") : "Claude"}
                {m.at ? ` · ${when(m.at)}` : ""}
              </div>
              {m.role === "user" ? (
                <div className="text-[15px] leading-relaxed whitespace-pre-wrap">{m.text}</div>
              ) : (
                <Markdown text={m.text} className="text-[15px]" />
              )}
            </div>
          </div>
        ))}
      </div>
    </Sheet>
  );
}
