import { sizeText } from "../../labels.ts";
import { Icon, Spinner } from "../ui.tsx";
import { removeAttachment, type Attachment } from "./attachments.ts";

export function AttachmentChips({ scope, items }: { scope: string; items: Attachment[] }) {
  if (!items.length) return null;
  return (
    <div className="-mx-1 mb-2 flex gap-1.5 overflow-x-auto px-1">
      {items.map((a) => (
        <div key={a.key} className="flex h-10 max-w-44 shrink-0 items-center gap-1.5 rounded-lg bg-surface-2 p-1">
          {a.thumb ? (
            <img src={a.thumb} alt="" className="size-8 shrink-0 rounded-md object-cover" />
          ) : (
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-bg text-muted">
              <Icon.file className="size-4" />
            </span>
          )}
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-xs">{a.name}</span>
            <span className="flex items-center gap-1 text-[11px] text-muted">
              {a.uploaded ? (
                sizeText(a.uploaded.size)
              ) : (
                <>
                  <Spinner className="size-3" />
                  {Math.round(a.progress * 100)}%
                </>
              )}
            </span>
          </span>
          <button onClick={() => removeAttachment(scope, a.key)} aria-label="첨부 빼기" className="shrink-0 rounded-md p-1 text-muted">
            <Icon.x className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
