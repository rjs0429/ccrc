import { useEffect, useMemo, useRef, useState } from "react";
import type { FileView } from "../../../../broker/src/protocol.ts";
import { ApiError, request } from "../../api.ts";
import { sizeText } from "../../labels.ts";
import { FileImages, FileLinks } from "../fileLinks.ts";
import { Markdown } from "../Markdown.tsx";
import { Icon, Spinner } from "../ui.tsx";
import { htmlLines, languageOf, parseTable, slug } from "./text.ts";

export interface FileTarget {
  href: string;
  // The folder of the file the link was in, for links inside a file opened in the viewer.
  base?: string;
}

type Loaded = { view: FileView } | { error: string; path?: string };

const ERROR_TEXT: Record<string, string> = {
  not_found: "파일을 찾을 수 없습니다.",
  denied: "작업 폴더 밖이거나 읽기가 허용되지 않은 파일이라 열 수 없습니다.",
  too_large: "파일이 너무 커서(10MB 초과) 열 수 없습니다.",
  invalid: "파일 링크가 아닙니다.",
  unknown_session: "세션을 찾을 수 없습니다.",
};

const FALLBACK_TEXT: Record<string, string> = {
  parent: "링크 경로에서 앞쪽 ../ 를 빼고 찾은 파일입니다.",
  suffix: "링크 경로에 파일이 없어, 끝부분 경로가 같은 파일을 찾아 열었습니다.",
};

function dirName(p: string): string {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "/";
}

// A Markdown image source as an absolute path from the file's folder; a web or data URL is not a file.
function imagePath(src: string, dir: string): string | undefined {
  let p = src;
  if (/^file:/i.test(p)) {
    try {
      const u = new URL(p);
      if (u.host && u.host !== "localhost") return undefined;
      p = u.pathname;
    } catch {
      return undefined;
    }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith("//")) return undefined;
  else p = p.split(/[?#]/)[0];
  try {
    p = decodeURIComponent(p);
  } catch {}
  if (!p || p.includes("\0")) return undefined;
  const out: string[] = [];
  for (const s of [...(p.startsWith("/") ? [] : dir.split("/")), ...p.split("/")]) {
    if (s === "..") out.pop();
    else if (s && s !== ".") out.push(s);
  }
  return `/${out.join("/")}`;
}

interface Ticket {
  url: string;
  until: number;
}

// A cookie-free URL for the file, for pages the app opens outside itself (PDF, downloads): the
// home-screen app does not share its login with the browser it opens them in. Renewed before it expires.
function useTicket(sessionId: string, path: string | undefined): [Ticket | undefined, () => void] {
  const [ticket, setTicket] = useState<Ticket>();
  const renew = useRef<() => void>(() => {});
  useEffect(() => {
    setTicket(undefined);
    if (!path) return;
    let live = true;
    let timer: number | undefined;
    const mint = () => {
      window.clearTimeout(timer);
      if (!live) return;
      request<{ url: string; expiresInMs: number }>("POST", `/api/sessions/${encodeURIComponent(sessionId)}/file/ticket`, { path })
        .then((t) => {
          if (!live) return;
          setTicket({ url: t.url, until: Date.now() + t.expiresInMs });
          timer = window.setTimeout(mint, Math.max(5000, t.expiresInMs - 20_000));
        })
        .catch(() => {
          if (!live) return;
          setTicket(undefined);
          timer = window.setTimeout(mint, 15_000);
        });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") mint();
    };
    renew.current = mint;
    mint();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [sessionId, path]);
  return [ticket, () => renew.current()];
}

function shown(p: string, cwd: string): string {
  return cwd && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p;
}

function CodeLines({ text, lang, line, endLine }: { text: string; lang?: string; line?: number; endLine?: number }) {
  const lines = useMemo(() => htmlLines(text, lang), [text, lang]);
  const last = endLine ?? line;
  const width = String(lines.length).length;
  return (
    <pre className="min-w-max py-2 font-mono text-[12.5px] leading-[1.55]">
      {lines.map((html, i) => {
        const n = i + 1;
        const marked = line !== undefined && last !== undefined && n >= line && n <= last;
        return (
          <div key={n} data-line={n} className={`flex ${marked ? "bg-accent-soft" : ""}`}>
            <span
              className={`sticky left-0 shrink-0 pr-3 pl-2 text-right text-muted select-none ${marked ? "bg-accent-soft" : "bg-bg"}`}
              style={{ width: `calc(${width}ch + 1.25rem)` }}
            >
              {n}
            </span>
            <code className="pr-4 whitespace-pre" dangerouslySetInnerHTML={{ __html: html || " " }} />
          </div>
        );
      })}
    </pre>
  );
}

function Table({ text, sep }: { text: string; sep: string }) {
  const { rows, more } = useMemo(() => parseTable(text, sep), [text, sep]);
  const [head, ...body] = rows;
  return (
    <div className="p-3">
      <table className="border-collapse text-[13px]">
        {head && (
          <thead>
            <tr>
              {head.map((c, i) => (
                <th key={i} className="border border-line bg-surface-2 px-2 py-1 text-left font-semibold whitespace-nowrap">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {body.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className="border border-line px-2 py-1 align-top whitespace-pre-wrap">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {more && <div className="mt-2 text-xs text-muted">처음 1000행만 표로 보입니다. 나머지는 원문에서 보세요.</div>}
    </div>
  );
}

function prettyJson(text: string): string | undefined {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return undefined;
  }
}

interface BodyProps {
  view: FileView;
  raw: boolean;
  url: string;
  // Where "열기" points: a ticket URL when there is one.
  openUrl: string;
  onOpen: (e: React.MouseEvent) => void;
  onLink: (href: string) => void;
  image: (src: string) => string;
}

function Body({ view, raw, url, openUrl, onOpen, onLink, image }: BodyProps) {
  const text = view.text ?? "";
  if (view.kind === "image") {
    return (
      <div className="flex justify-center p-3">
        <img src={url} alt={view.name} className="max-w-full rounded-lg bg-surface-2" />
      </div>
    );
  }
  if (view.kind === "pdf") {
    return (
      <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
        <Icon.file className="size-10 text-muted" />
        <div className="text-sm text-muted">PDF 문서 · {sizeText(view.size)}</div>
        <a href={openUrl} onClick={onOpen} target="_blank" rel="noopener" className="rounded-xl bg-accent px-5 py-2.5 font-medium text-white">
          열기
        </a>
      </div>
    );
  }
  if (view.kind === "binary") {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted">
        <Icon.file className="size-10" />
        <div>미리 볼 수 없는 파일입니다 · {sizeText(view.size)}</div>
        <div>위의 내려받기로 받으세요.</div>
      </div>
    );
  }
  if (view.kind === "markdown" && !raw) {
    return (
      <FileLinks.Provider value={onLink}>
        <FileImages.Provider value={image}>
          <div className="px-4 py-3">
            <Markdown text={text} className="text-[15px]" />
          </div>
        </FileImages.Provider>
      </FileLinks.Provider>
    );
  }
  if ((view.kind === "csv" || view.kind === "tsv") && !raw) return <Table text={text} sep={view.kind === "csv" ? "," : "\t"} />;
  if (view.kind === "json" && !raw) {
    const pretty = prettyJson(text);
    if (pretty !== undefined) return <CodeLines text={pretty} lang="json" />;
  }
  return <CodeLines text={text} lang={view.kind === "markdown" ? "markdown" : languageOf(view.name)} line={view.line} endLine={view.endLine} />;
}

// Full-screen viewer for files that links in the conversation point to. Links inside a Markdown file
// open on top of it; the back button returns to the file before.
export default function FileViewer({ sessionId, cwd, target, onClose }: { sessionId: string; cwd: string; target: FileTarget; onClose: () => void }) {
  const [stack, setStack] = useState<FileTarget[]>([target]);
  const [loaded, setLoaded] = useState<Loaded | undefined>();
  const [raw, setRaw] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const current = stack[stack.length - 1];

  useEffect(() => {
    let live = true;
    setLoaded(undefined);
    setRaw(false);
    const q = new URLSearchParams({ href: current.href, ...(current.base ? { base: current.base } : {}) });
    request<FileView>("GET", `/api/sessions/${encodeURIComponent(sessionId)}/file?${q}`)
      .then((view) => {
        if (!live) return;
        setLoaded({ view });
        // Line numbers belong to the source, so a link to a line opens it.
        setRaw(view.line !== undefined);
      })
      .catch((e: unknown) => {
        if (!live) return;
        const body = e instanceof ApiError ? e.body : {};
        setLoaded({ error: typeof body.error === "string" ? body.error : "failed", path: typeof body.path === "string" ? body.path : undefined });
      });
    return () => {
      live = false;
    };
  }, [sessionId, current]);

  const view = loaded && "view" in loaded ? loaded.view : undefined;

  useEffect(() => {
    const el = scroller.current;
    if (!el || !view) return;
    el.scrollTop = 0;
    if (view.line && (view.kind === "text" || raw)) {
      el.querySelector(`[data-line="${view.line}"]`)?.scrollIntoView({ block: "center" });
    } else if (view.heading && view.kind === "markdown" && !raw) scrollToHeading(view.heading);
  }, [view, raw]);

  const scrollToHeading = (id: string) => {
    const want = slug(id);
    const found = [...(scroller.current?.querySelectorAll("h1, h2, h3, h4, h5, h6") ?? [])].find((h) => slug(h.textContent ?? "") === want);
    found?.scrollIntoView({ block: "start" });
  };

  const onLink = (href: string) => {
    if (href.startsWith("#")) return scrollToHeading(decodeURIComponent(href.slice(1)));
    if (view) setStack((s) => [...s, { href, base: dirName(view.path) }]);
  };

  const rawUrl = (p: string) => `/api/sessions/${encodeURIComponent(sessionId)}/file/raw?path=${encodeURIComponent(p)}`;
  const url = view ? rawUrl(view.path) : "";
  const [ticket, renewTicket] = useTicket(sessionId, view?.path);
  const outside = ticket?.url ?? url;
  // Without a live ticket (not yet issued, or run out while the app slept) a tap gets one; the next tap opens it.
  const onOutside = (e: React.MouseEvent) => {
    if (ticket && Date.now() < ticket.until - 3000) return;
    e.preventDefault();
    renewTicket();
  };
  const image = (src: string) => {
    const p = view && imagePath(src, dirName(view.path));
    return p ? rawUrl(p) : src;
  };
  const toggles = view && view.text !== undefined && (view.kind === "markdown" || view.kind === "json" || view.kind === "csv" || view.kind === "tsv");
  const title = view?.name ?? current.href.split(/[?#]/)[0].split("/").pop() ?? current.href;

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-bg" role="dialog" aria-label="파일 보기">
      <header className="pt-safe border-b border-line bg-surface">
        <div className="flex items-center gap-1 px-2 py-2">
          {stack.length > 1 ? (
            <button onClick={() => setStack((s) => s.slice(0, -1))} aria-label="이전 파일" className="rounded-lg p-2">
              <Icon.back />
            </button>
          ) : null}
          <div className="min-w-0 flex-1 px-1">
            <div className="truncate text-[15px] font-semibold">{title}</div>
            {view && (
              <div className="truncate font-mono text-[11.5px] text-muted" title={view.path}>
                {shown(view.path, cwd)}
              </div>
            )}
          </div>
          <button onClick={onClose} aria-label="닫기" className="rounded-lg p-2">
            <Icon.x />
          </button>
        </div>
        {view && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 pb-2 text-xs text-muted">
            <span>{sizeText(view.size)}</span>
            {toggles && (
              <span className="flex overflow-hidden rounded-lg border border-line">
                <button onClick={() => setRaw(false)} className={`px-2.5 py-1 ${!raw ? "bg-accent-soft text-fg" : ""}`}>
                  {view.kind === "markdown" ? "보기" : view.kind === "json" ? "정리" : "표"}
                </button>
                <button onClick={() => setRaw(true)} className={`px-2.5 py-1 ${raw ? "bg-accent-soft text-fg" : ""}`}>
                  원문
                </button>
              </span>
            )}
            <a href={ticket ? `${ticket.url}?download=1` : `${url}&download=1`} onClick={onOutside} download={view.name} className="ml-auto font-medium text-accent">
              내려받기
            </a>
          </div>
        )}
        {view?.fallback && <div className="border-t border-line bg-surface-2 px-3 py-1.5 text-xs text-warn">{FALLBACK_TEXT[view.fallback]}</div>}
        {view?.truncated && (
          <div className="border-t border-line bg-surface-2 px-3 py-1.5 text-xs text-warn">파일이 커서 앞 1MB만 보입니다. 전체는 내려받아 보세요.</div>
        )}
      </header>
      <div ref={scroller} className="pb-safe flex-1 overflow-auto overscroll-contain">
        {!loaded && (
          <div className="flex justify-center py-10 text-muted">
            <Spinner className="size-6" />
          </div>
        )}
        {loaded && "error" in loaded && (
          <div className="m-4 rounded-xl bg-surface-2 px-3 py-3 text-sm">
            <div className="text-danger">{ERROR_TEXT[loaded.error] ?? "파일을 읽지 못했습니다."}</div>
            <div className="mt-1 font-mono text-xs break-all text-muted">{loaded.path ? shown(loaded.path, cwd) : current.href}</div>
          </div>
        )}
        {view && <Body view={view} raw={raw} url={url} openUrl={outside} onOpen={onOutside} onLink={onLink} image={image} />}
      </div>
    </div>
  );
}
