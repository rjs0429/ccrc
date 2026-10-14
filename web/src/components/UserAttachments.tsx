import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { UserAttachment } from "../../../broker/src/protocol.ts";
import { sizeText } from "../labels.ts";
import { sentPreview } from "../sentPreviews.ts";
import { useApp } from "../state.ts";
import { Icon, Spinner } from "./ui.tsx";

// Larger images wait for a tap before they are fetched.
export const BIG_IMAGE_BYTES = 1024 * 1024;
const SERVED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A message sent while Claude works reaches the transcript only when it is delivered, which can take
// minutes, so a thumbnail in view keeps retrying at the last interval.
const RETRY_MS = [2000, 5000, 15_000, 30_000, 60_000];
// Thumbnails load while within this distance of the visible part of the conversation and are let go beyond it.
const NEAR_MARGIN = "600px 0px";
const SWIPE_PX = 50;

// Images opened in the large view; their thumbnails show from then on, from the browser's cache.
const opened = new Set<string>();

// local: the preview of an image sent from here, which may have been let go; the broker's copy stands in then.
interface Shown {
  local?: string;
  remote?: string;
  size: number;
}

const observers = new WeakMap<Element, IntersectionObserver>();
const callbacks = new WeakMap<Element, (near: boolean) => void>();

// One observer per scrolling list watches every thumbnail in it.
function observe(el: Element, cb: (near: boolean) => void): () => void {
  const root = el.closest("[data-scroll-root]");
  const key = root ?? document.documentElement;
  let o = observers.get(key);
  if (!o) {
    o = new IntersectionObserver((entries) => entries.forEach((e) => callbacks.get(e.target)?.(e.isIntersecting)), { root, rootMargin: NEAR_MARGIN });
    observers.set(key, o);
  }
  callbacks.set(el, cb);
  o.observe(el);
  return () => {
    o.unobserve(el);
    callbacks.delete(el);
  };
}

function useNear(ref: React.RefObject<Element | null>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => (ref.current ? observe(ref.current, setNear) : undefined), []);
  return near;
}

function Thumb({ shown, index, onOpen }: { shown: Shown; index: number; onOpen: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const near = useNear(ref);
  const [failed, setFailed] = useState(0);
  const [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [gone, setGone] = useState(false);
  const local = !gone && shown.local;
  const src = local || shown.remote;
  const big = !local && shown.size > BIG_IMAGE_BYTES && !(src && opened.has(src));

  useEffect(() => {
    if (!failed) return;
    const t = setTimeout(() => setRetry(failed), RETRY_MS[Math.min(failed, RETRY_MS.length) - 1]);
    return () => clearTimeout(t);
  }, [failed]);

  const load = Boolean(near && src && !big && failed <= retry);
  useEffect(() => {
    if (!load) setLoaded(false);
  }, [load]);
  return (
    <button
      ref={ref}
      onClick={onOpen}
      aria-label={`첨부 이미지 ${index + 1}${shown.size ? ` · ${sizeText(shown.size)}` : ""}`}
      className="relative flex size-18 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-line bg-surface-2 text-muted"
      data-thumb={big ? "big" : load ? (loaded ? "loaded" : "loading") : "idle"}
    >
      {load ? (
        <img
          key={retry}
          src={src}
          alt=""
          decoding="async"
          className="size-full object-cover"
          onLoad={() => setLoaded(true)}
          onError={() => (local ? setGone(true) : setFailed(retry + 1))}
        />
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

function DocumentChip({ a }: { a: UserAttachment }) {
  const name = a.name || (a.mediaType === "application/pdf" ? "PDF 문서" : "문서");
  return (
    <div className="flex max-w-full min-w-0 items-center gap-1.5 rounded-xl border border-line bg-surface-2 px-2.5 py-1.5 text-xs" data-doc>
      <Icon.file className="size-4 shrink-0 text-muted" />
      <span className="min-w-0 truncate">{name}</span>
      {a.size > 0 && <span className="shrink-0 text-muted">{sizeText(a.size)}</span>}
    </div>
  );
}

function ImageViewer({ images, start, onClose }: { images: Shown[]; start: number; onClose: () => void }) {
  const [at, setAt] = useState(start);
  const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
  const [attempt, setAttempt] = useState(0);
  const [gone, setGone] = useState<Set<number>>(new Set());
  const touch = useRef<number | null>(null);
  const shown = images[at];
  const local = !gone.has(at) && shown.local;
  const src = local || shown.remote;
  const go = (d: number) => {
    const next = at + d;
    if (next < 0 || next >= images.length) return;
    setAt(next);
    setState("loading");
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black text-white"
      role="dialog"
      aria-label="첨부 이미지"
      onTouchStart={(e) => (touch.current = e.touches[0]?.clientX ?? null)}
      onTouchEnd={(e) => {
        const from = touch.current;
        const to = e.changedTouches[0]?.clientX;
        touch.current = null;
        if (from !== null && to !== undefined && Math.abs(to - from) > SWIPE_PX) go(to < from ? 1 : -1);
      }}
    >
      <header className="pt-safe flex items-center gap-2 px-safe-2 py-2">
        <div className="min-w-0 flex-1 px-2 text-sm text-white/80">
          {images.length > 1 ? `${at + 1} / ${images.length}` : "이미지"}
          {shown.size > 0 && ` · ${sizeText(shown.size)}`}
        </div>
        <button onClick={onClose} aria-label="닫기" className="rounded-lg p-2">
          <Icon.x />
        </button>
      </header>
      <div className="pb-safe relative flex min-h-0 flex-1 items-center justify-center px-safe-0">
        {src && state !== "failed" && (
          <img
            key={`${at}-${attempt}-${src}`}
            src={src}
            alt=""
            className={`max-h-full max-w-full object-contain ${state === "loaded" ? "" : "opacity-0"}`}
            onLoad={() => {
              setState("loaded");
              opened.add(src);
            }}
            onError={() => (local ? setGone((g) => new Set(g).add(at)) : setState("failed"))}
          />
        )}
        {src && state === "loading" && (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-white/70">
            <Spinner className="size-6" />
            {shown.size > BIG_IMAGE_BYTES && sizeText(shown.size)}
          </span>
        )}
        {(!src || state === "failed") && (
          <div className="flex flex-col items-center gap-3 px-6 text-center text-sm text-white/80">
            <Icon.image className="size-10 opacity-60" />
            {src ? "이미지를 불러오지 못했습니다." : "이 이미지는 미리 볼 수 없습니다."}
            {src && (
              <button
                onClick={() => {
                  setAttempt((n) => n + 1);
                  setState("loading");
                }}
                className="rounded-xl bg-white/15 px-4 py-2 font-medium"
              >
                다시 시도
              </button>
            )}
          </div>
        )}
        {at > 0 && (
          <button onClick={() => go(-1)} aria-label="이전 이미지" className="absolute left-1 rounded-full bg-white/15 p-2">
            <Icon.back />
          </button>
        )}
        {at < images.length - 1 && (
          <button onClick={() => go(1)} aria-label="다음 이미지" className="absolute right-1 rounded-full bg-white/15 p-2">
            <Icon.chevronRight />
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}

// The images of a user message as thumbnails that open a large view, and its documents as chips. A waiting
// message is not in the transcript yet, so only the previews kept here show.
export function UserAttachments({ messageId, list, waiting }: { messageId: string; list: UserAttachment[]; waiting?: boolean }) {
  const sessionId = useApp((s) => s.chat?.sessionId);
  const [open, setOpen] = useState<number | null>(null);
  const servable = !waiting && Boolean(sessionId) && UUID.test(messageId);
  const entries = list.map((a, i) => ({ a, i }));
  const images: Shown[] = entries
    .filter((e) => e.a.kind === "image")
    .map(({ a, i }) => {
      const remote =
        servable && SERVED.has(a.mediaType)
          ? `/api/sessions/${encodeURIComponent(sessionId!)}/messages/${encodeURIComponent(messageId)}/attachments/${i}`
          : undefined;
      return { local: sentPreview(messageId, i), remote, size: a.size };
    });
  const docs = list.filter((a) => a.kind === "document");
  return (
    <div className="flex max-w-[88%] flex-col items-end gap-1.5" data-attachments>
      {images.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {images.map((shown, n) => (
            <Thumb key={n} shown={shown} index={n} onOpen={() => setOpen(n)} />
          ))}
        </div>
      )}
      {docs.map((a, n) => (
        <DocumentChip key={n} a={a} />
      ))}
      {open !== null && images[open] && <ImageViewer images={images} start={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
