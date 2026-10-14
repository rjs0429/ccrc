import { memo, useContext } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { FileLinks, isWebLink, urlTransform } from "./fileLinks.ts";

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

const components = { a: Link };

export const Markdown = memo(function Markdown({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div className={`md ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]} components={components} urlTransform={urlTransform}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
