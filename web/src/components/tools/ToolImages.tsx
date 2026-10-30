import { useContext, useEffect, useRef, useState } from "react";
import type { ToolImage } from "../../../../broker/src/protocol.ts";
import { t } from "../../i18n/index.ts";
import { sizeText } from "../../labels.ts";
import { useApp } from "../../state.ts";
import { SentAgent } from "../fileLinks.ts";
import { OfflineView } from "../offlineView.ts";
import { Icon } from "../ui.tsx";
import { BIG_IMAGE_BYTES, ImageViewer, openedLarge, useNear, type Shown } from "../UserAttachments.tsx";

// A result can show before Claude Code has written it to the transcript the picture is read from, so a thumbnail that
// did not load tries again a few times.
const RETRY_MS = [1000, 3000, 10_000];

export function toolImageUrl(sessionId: string, call: string, n: number, agent?: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/tools/${encodeURIComponent(call)}/images/${n}${agent ? `?agent=${encodeURIComponent(agent)}` : ""}`;
}

// A large picture loads once it has been opened.
function Thumb({ shown, index, onOpen }: { shown: Shown; index: number; onOpen: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const near = useNear(ref);
  const [failed, setFailed] = useState(0);
  const [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const src = shown.remote ?? "";
  const big = shown.size > BIG_IMAGE_BYTES && !openedLarge(src);
  const gaveUp = failed > RETRY_MS.length;
  useEffect(() => {
    if (!failed || failed > RETRY_MS.length) return;
    const timer = setTimeout(() => setRetry(failed), RETRY_MS[failed - 1]);
    return () => clearTimeout(timer);
  }, [failed]);
  const load = near && !big && failed <= retry;
  useEffect(() => {
    if (!load) setLoaded(false);
  }, [load]);
  return (
    <button
      ref={ref}
      onClick={onOpen}
      aria-label={`${t("결과 그림 {n}", { n: index + 1 })}${shown.size ? ` · ${sizeText(shown.size)}` : ""}`}
      className="relative flex h-18 w-28 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-line bg-surface-2 text-muted"
      data-thumb={big ? "big" : load ? (loaded ? "loaded" : "loading") : gaveUp ? "failed" : "idle"}
    >
      {load ? (
        <img key={retry} src={src} alt="" decoding="async" draggable={false} className="size-full object-cover" onLoad={() => setLoaded(true)} onError={() => setFailed(retry + 1)} />
      ) : big ? (
        <span className="flex flex-col items-center gap-0.5 text-[11px] leading-tight">
          <Icon.image className="size-5" />
          {sizeText(shown.size)}
        </span>
      ) : (
        <Icon.image className="size-5 opacity-60" />
      )}
    </button>
  );
}

// The pictures of a tool's result as thumbnails under its card's head, which open in the photo viewer. They are fetched
// when they come near the screen; the phone's copy of a conversation keeps none.
export function ToolImages({ call, images }: { call: string; images: ToolImage[] }) {
  const sessionId = useApp((s) => s.chat?.sessionId);
  const agent = useContext(SentAgent);
  const offline = useContext(OfflineView);
  const [open, setOpen] = useState<number | null>(null);
  if (!sessionId || offline || !images.length) return null;
  const shown: Shown[] = images.map((image, n) => ({ remote: toolImageUrl(sessionId, call, n, agent), size: image.size }));
  return (
    <div className="flex flex-wrap gap-1.5 px-3 pb-2.5" data-tool-images={call}>
      {shown.map((s, n) => (
        <Thumb key={n} shown={s} index={n} onOpen={() => setOpen(n)} />
      ))}
      {open !== null && <ImageViewer images={shown} start={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
