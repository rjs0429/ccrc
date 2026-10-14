import { createContext } from "react";
import { defaultUrlTransform } from "react-markdown";

// Opens a link to a file of the session in the viewer; where it is absent, links just navigate.
export const FileLinks = createContext<((href: string) => void) | null>(null);

// The session's folders, under which a path in a tool's input is taken for a file even without an extension.
export const FileRoots = createContext<readonly string[]>([]);

// Turns an image source in Markdown into the URL to load it from; where it is absent, sources load as they are.
export const FileImages = createContext<((src: string) => string) | null>(null);

export const isWebLink = (href: string): boolean => /^(https?:|mailto:|tel:)/i.test(href);

// Markdown keeps file:// links and "name.ext:42" links, which its URL check would take for unknown schemes;
// the latter become ./ paths so that no scheme survives.
export function urlTransform(url: string): string {
  if (/^file:/i.test(url)) return url;
  return /^[^/?#:]+:\d+(?::\d+)?(?:-\d+)?(?:[?#]|$)/.test(url) ? `./${url}` : defaultUrlTransform(url);
}
