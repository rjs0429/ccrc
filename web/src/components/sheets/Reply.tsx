import type { DisplayItem } from "../../../../broker/src/protocol.ts";
import { t } from "../../i18n/index.ts";
import { copyText } from "../clipboard.ts";
import { Choice, Sheet } from "../ui.tsx";

export type Reply = Extract<DisplayItem, { kind: "assistant" }>;

// What a reply of Claude's offers: its Markdown as Claude wrote it, to copy whole or to select part of, and the whole
// conversation as a file where the broker can make one.
export function ReplySheet({ reply, onExport, onClose }: { reply: Reply; onExport?: () => void; onClose: () => void }) {
  return (
    <Sheet title={t("Claude 답")} onClose={onClose}>
      <div className="mb-2 max-h-[40dvh] overflow-y-auto rounded-xl bg-surface-2 px-3 py-2 font-mono text-[12.5px] leading-relaxed break-words whitespace-pre-wrap select-text" data-reply-source>
        {reply.text}
      </div>
      <Choice
        label={t("Markdown 원문 복사")}
        onClick={() => {
          onClose();
          copyText(reply.text, t("답을 복사했습니다"));
        }}
      />
      {onExport && <Choice label={t("대화 내보내기")} hint={t("대화 전체를 Markdown 파일로 받습니다")} onClick={onExport} />}
    </Sheet>
  );
}
