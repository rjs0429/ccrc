import { Suspense, lazy, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SENT_MAX_BYTES, type DisplayItem, type FileView, type SentFile, type SentRef } from "../../../../broker/src/protocol.ts";
import { ApiError, request } from "../../api.ts";
import { sizeText } from "../../labels.ts";
import { toast, useApp } from "../../state.ts";
import { FileLinks, SentAgent } from "../fileLinks.ts";
import { Icon, Spinner } from "../ui.tsx";
import { BIG_IMAGE_BYTES, useNear } from "../UserAttachments.tsx";
import { PREVIEW_MAX_BYTES, SENT_ERROR_TEXT, sentUrl } from "../viewer/sent.ts";
import type { FileTarget } from "../viewer/FileViewer.tsx";
import { Folded, fileHref, record, str } from "./parts.tsx";

const FileViewer = lazy(() => import("../viewer/FileViewer.tsx"));

type ToolItem = Extract<DisplayItem, { kind: "tool" }>;

const TYPES: [RegExp, string][] = [
  [/^(md|markdown|mdx)$/, "Markdown"],
  [/^(txt|log)$/, "텍스트"],
  [/^svg$/, "SVG 그림"],
  [/^(png|jpe?g|gif|webp|bmp|ico|heic|heif|avif|tiff?)$/, "그림"],
  [/^pdf$/, "PDF"],
  [/^json$/, "JSON"],
  [/^(csv|tsv)$/, "표"],
  [/^html?$/, "HTML"],
  [/^xml$/, "XML"],
  [/^(mp4|m4v|mov|webm|avi|mkv)$/, "동영상"],
  [/^(mp3|m4a|wav|ogg|aac|flac)$/, "소리"],
  [/^docx?$/, "Word 문서"],
  [/^xlsx?$/, "Excel 시트"],
  [/^pptx?$/, "PowerPoint"],
  [/^(zip|gz|tgz|7z|rar|tar)$/, "압축 파일"],
];

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function typeLabel(name: string, mediaType?: string): string {
  const ext = extOf(name);
  return TYPES.find(([re]) => re.test(ext))?.[1] ?? (mediaType?.startsWith("text/") ? "텍스트" : "파일");
}

const isImage = (f: SentFile) => f.image === true || Boolean(f.mediaType?.startsWith("image/")) || /^(png|jpe?g|gif|webp|svg|bmp|avif)$/.test(extOf(f.name));

function DownloadIcon({ className = "size-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
    </svg>
  );
}

// The file's kind in a few letters, where no picture of it shows.
function TypeBox({ name }: { name: string }) {
  const ext = extOf(name).slice(0, 4).toUpperCase() || "FILE";
  return (
    <span className="flex size-14 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2 font-mono text-[12px] font-semibold text-muted" aria-hidden>
      {ext}
    </span>
  );
}

// A picture loads once it comes near the screen, a large one only after the user has opened it; onRefused hears of one
// that did not load.
function Thumb({ src, size, wait, onRefused }: { src: string; size: number; wait: boolean; onRefused: () => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  const near = useNear(ref);
  const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
  const load = near && !wait;
  return (
    <span
      ref={ref}
      className="relative flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-surface-2 text-muted"
      data-thumb={wait ? "big" : !load ? "idle" : state}
      aria-hidden
    >
      {load && state !== "failed" ? (
        <img
          src={src}
          alt=""
          decoding="async"
          className={`size-full object-contain ${state === "loaded" ? "" : "opacity-0"}`}
          onLoad={() => setState("loaded")}
          onError={() => {
            setState("failed");
            onRefused();
          }}
        />
      ) : null}
      {(!load || state !== "loaded") && (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 text-[11px] leading-tight">
          <Icon.image className={`size-5 ${wait ? "" : "opacity-60"}`} />
          {wait && sizeText(size)}
        </span>
      )}
    </span>
  );
}

// Downloads through a ticket, as the home-screen app hands a download to a browser without its login: a tap without a
// live ticket gets one and then downloads.
function Download({ sessionId, file, name, primary }: { sessionId: string; file: SentRef; name: string; primary: boolean }) {
  const [ticket, setTicket] = useState<{ url: string; until: number }>();
  const [busy, setBusy] = useState(false);
  const link = useRef<HTMLAnchorElement>(null);
  const go = useRef(false);
  useEffect(() => {
    if (!ticket || !go.current) return;
    go.current = false;
    link.current?.click();
  }, [ticket]);
  const onClick = (e: React.MouseEvent) => {
    if (ticket && Date.now() < ticket.until - 3000) return;
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    request<{ url: string; expiresInMs: number }>("POST", `/api/sessions/${encodeURIComponent(sessionId)}/file/ticket`, { sent: file })
      .then((t) => {
        go.current = true;
        setTicket({ url: t.url, until: Date.now() + t.expiresInMs });
      })
      .catch(() => toast("내려받지 못했습니다. 다시 시도하세요"))
      .finally(() => setBusy(false));
  };
  return (
    <a
      ref={link}
      href={ticket ? `${ticket.url}?download=1` : sentUrl(sessionId, file, true, true)}
      download={name}
      onClick={onClick}
      aria-label={`${name} 내려받기`}
      className={`flex size-11 shrink-0 items-center justify-center rounded-xl ${primary ? "bg-accent-soft text-accent" : "text-muted"}`}
      data-download
    >
      {busy ? <Spinner className="size-4" /> : <DownloadIcon />}
    </a>
  );
}

interface RowProps {
  sessionId: string;
  file: SentFile;
  at: SentRef;
  attach: boolean;
  failed?: string;
  opened: boolean;
  onOpen: () => void;
  onFailed: (code: string) => void;
}

function SentRow({ sessionId, file, at, attach, failed, opened, onOpen, onFailed }: RowProps) {
  const image = isImage(file) && !attach;
  const tooLarge = file.size > SENT_MAX_BYTES;
  const shut = file.error !== undefined || tooLarge;
  const note =
    file.error !== undefined
      ? `보내지 못한 파일입니다${file.error ? `: ${file.error}` : ""}`
      : tooLarge
        ? "너무 커서(50MB 초과) 받을 수 없습니다"
        : failed
          ? (SENT_ERROR_TEXT[failed] ?? "파일을 열지 못했습니다")
          : undefined;
  // A picture the broker refuses says why; one it serves but the browser cannot draw is just not shown.
  const explain = () =>
    request<FileView>("GET", sentUrl(sessionId, at)).catch((e: unknown) => {
      if (e instanceof ApiError && typeof e.body.error === "string") onFailed(e.body.error);
    });
  const body = (
    <>
      {image && !shut && !failed ? (
        <Thumb src={sentUrl(sessionId, at, true)} size={file.size} wait={(file.size > BIG_IMAGE_BYTES && !opened) || file.size > PREVIEW_MAX_BYTES} onRefused={() => void explain()} />
      ) : (
        <TypeBox name={file.name} />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium">{file.name}</span>
        <span className="block truncate text-xs text-muted">
          {sizeText(file.size)} · {typeLabel(file.name, file.mediaType)}
        </span>
        {note && <span className={`mt-0.5 block text-xs ${file.error !== undefined || failed === "denied" ? "text-danger" : "text-warn"}`}>{note}</span>}
      </span>
    </>
  );
  return (
    <div className="flex items-center gap-1 pr-1.5 pl-3" data-sent-file={at.n}>
      {shut ? (
        <div className="flex min-h-15 min-w-0 flex-1 items-center gap-3 py-2 opacity-80">{body}</div>
      ) : (
        <button onClick={onOpen} className="flex min-h-15 min-w-0 flex-1 items-center gap-3 py-2 text-left" data-open-sent>
          {body}
        </button>
      )}
      {!shut && failed !== "denied" && <Download sessionId={sessionId} file={at} name={file.name} primary={attach} />}
    </div>
  );
}

// A file named only in the call's input, without the result that says where it went: it opens as any link to a file.
function AskedRow({ path, pending }: { path: string; pending: boolean }) {
  const open = useContext(FileLinks);
  const name = path.split("/").filter(Boolean).pop() ?? path;
  const dir = path.slice(0, Math.max(0, path.length - name.length - 1));
  const body = (
    <>
      <TypeBox name={name} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium">{name}</span>
        {dir ? <span className="block truncate font-mono text-[11.5px] text-muted">{dir}</span> : <span className="block truncate text-xs text-muted">{typeLabel(name)}</span>}
      </span>
    </>
  );
  const cls = "flex min-h-15 w-full items-center gap-3 px-3 py-2 text-left";
  if (pending || !open) return <div className={`${cls} ${pending ? "opacity-60" : ""}`}>{body}</div>;
  return (
    <button data-file={path} onClick={() => open(fileHref(path))} className={cls}>
      {body}
      <Icon.chevronRight className="size-4 shrink-0 text-muted" />
    </button>
  );
}

// The files Claude sent with SendUserFile, always open: what it said with them, and each file to look at or download.
// A file a subagent sent names the subagent. The viewer opens over whatever shows the card, the agent map too.
export function SentFiles({ item, running }: { item: ToolItem; running: boolean }) {
  const agent = useContext(SentAgent);
  const sessionId = useApp((s) => s.chat?.sessionId);
  const cwd = useApp((s) => s.chat?.state?.cwd ?? "");
  const byName = useApp((s) => {
    const owner = item.by ? s.chat?.items.find((i) => i.id === item.by) : undefined;
    return owner?.kind === "tool" ? owner.summary : undefined;
  });
  const [viewing, setViewing] = useState<number | null>(null);
  const [failed, setFailed] = useState<Record<number, string>>({});
  const [opened, setOpened] = useState<Set<number>>(() => new Set());
  const input = record(item.input) ?? {};
  const caption = str(input.caption);
  const attach = input.display === "attach";
  const asked = (Array.isArray(input.files) ? input.files : [input.files]).filter((f): f is string => typeof f === "string" && f !== "");
  const files = item.sent;
  const pending = !item.result && (running || Boolean(item.by));
  const refused = item.result?.isError === true || (!item.result && !pending);
  // Files Claude Code could not deliver do not count as sent.
  const count = files ? files.filter((f) => f.error === undefined).length : asked.length;
  const ref = (n: number): SentRef => ({ call: item.id, n, ...(agent ? { agent } : {}) });
  const nothing = !pending && (refused || count === 0);
  const head = pending ? "파일을 보내는 중…" : nothing ? "파일을 보내지 못했습니다" : count > 1 ? `파일 ${count}개를 보냈습니다` : "파일을 보냈습니다";
  const close = () => {
    const n = viewing;
    setViewing(null);
    if (n !== null) setOpened((s) => new Set(s).add(n));
  };
  const target: FileTarget | null = viewing !== null && files?.[viewing] ? { href: files[viewing].name, sent: ref(viewing) } : null;

  return (
    <div className="rounded-xl border border-line bg-surface" data-sent-card={item.id}>
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
        {pending ? (
          <Spinner className="size-4 shrink-0 text-muted" />
        ) : nothing ? (
          <Icon.x className="size-4 shrink-0 text-danger" />
        ) : (
          <Icon.paperclip className="size-4 shrink-0 text-muted" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium" data-sent-head>
          {head}
        </span>
        {item.by && (
          <span className="max-w-[50%] shrink-0 truncate text-xs text-muted" data-sent-by>
            에이전트{byName ? ` · ${byName}` : ""}
          </span>
        )}
      </div>
      {caption && <div className="px-3 pb-2 text-[14px] leading-relaxed whitespace-pre-wrap">{caption}</div>}
      {item.result?.isError && (
        <div className="px-3 pb-2.5 text-sm text-muted">
          <Folded text={item.result.text} plain />
        </div>
      )}
      {!refused && (
        <div className="divide-y divide-line border-t border-line">
          {files && sessionId
            ? files.map((f, n) => (
                <SentRow
                  key={n}
                  sessionId={sessionId}
                  file={f}
                  at={ref(n)}
                  attach={attach}
                  failed={failed[n]}
                  opened={opened.has(n)}
                  onOpen={() => setViewing(n)}
                  onFailed={(code) => setFailed((s) => ({ ...s, [n]: code }))}
                />
              ))
            : asked.map((p, n) => <AskedRow key={n} path={p} pending={pending} />)}
        </div>
      )}
      {files && asked.length > files.length && <div className="border-t border-line px-3 py-2 text-xs text-muted">나머지 {asked.length - files.length}개는 여기 보이지 않습니다</div>}
      {target &&
        sessionId &&
        createPortal(
          <Suspense
            fallback={
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg text-muted">
                <Spinner className="size-6" />
              </div>
            }
          >
            <FileViewer
              sessionId={sessionId}
              cwd={cwd}
              target={target}
              onClose={close}
              onError={(code) => viewing !== null && setFailed((s) => ({ ...s, [viewing]: code }))}
            />
          </Suspense>,
          document.body,
        )}
    </div>
  );
}
