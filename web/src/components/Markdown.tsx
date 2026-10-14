import { memo, useContext, useState } from "react";
import ReactMarkdown from "react-markdown";
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

const components = { a: Link, img: Image };

export const Markdown = memo(function Markdown({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div className={`md ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]} components={components} urlTransform={urlTransform}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
