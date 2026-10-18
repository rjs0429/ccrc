import { createContext, createElement, memo, useContext, useState } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { FileImages, FileLinks, isWebLink, urlTransform } from "./fileLinks.ts";

function Link({ href, children }: { href?: string; children?: React.ReactNode }) {
  const open = useContext(FileLinks);
  if (href && open && !isWebLink(href)) {
    return (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault();
          open(href);
        }}
      >
        {children}
      </a>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

function Image({ src, alt }: { src?: unknown; alt?: string }) {
  const resolve = useContext(FileImages);
  const [failed, setFailed] = useState<string>();
  const url = typeof src === "string" && src ? (resolve ? resolve(src) : src) : "";
  if (!url || failed === url) {
    return (
      <span className="inline-block rounded-md border border-line bg-surface-2 px-2 py-1 text-xs text-muted" title={alt || undefined}>
        이미지를 불러올 수 없습니다
      </span>
    );
  }
  return <img src={url} alt={alt ?? ""} onError={() => setFailed(url)} className="max-w-full rounded-md" />;
}

const components: Components = { a: Link, img: Image };

// The source lines a text's blocks were drawn from, for a view that comments on them: the block being commented on
// and the blocks that have a comment, by their first line.
export const LineMarks = createContext<{ picked?: number; marked: ReadonlySet<number> } | null>(null);

const BLOCKS = ["p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote", "tr"] as const;

function lined(tag: (typeof BLOCKS)[number]) {
  return function Lined({ node, className, ...props }: React.HTMLAttributes<HTMLElement> & ExtraProps) {
    const marks = useContext(LineMarks);
    const start = node?.position?.start.line;
    const mark = start === undefined ? "" : marks?.picked === start ? "md-picked" : marks?.marked.has(start) ? "md-marked" : "";
    return createElement(tag, { ...props, className: [className, mark].filter(Boolean).join(" ") || undefined, "data-line": start, "data-end": node?.position?.end.line });
  };
}

const lineComponents: Components = { ...components, ...Object.fromEntries(BLOCKS.map((t) => [t, lined(t)])) };

// lines: each block names the lines of the text it was drawn from (data-line, data-end).
export const Markdown = memo(function Markdown({ text, className = "", lines }: { text: string; className?: string; lines?: boolean }) {
  return (
    <div className={`md ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={lines ? lineComponents : components}
        urlTransform={urlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
