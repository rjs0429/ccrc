import { createContext } from "react";
import { defaultUrlTransform } from "react-markdown";

// Opens a link to a file of the session in the viewer; where it is absent, links just navigate.
export const FileLinks = createContext<((href: string) => void) | null>(null);

export const isWebLink = (href: string): boolean => /^(https?:|mailto:|tel:)/i.test(href);

// Markdown keeps file:// links and "name.ext:42" links, which its URL check would take for unknown schemes.
export function urlTransform(url: string): string {
  return /^file:/i.test(url) || /^[^/?#:]+:\d+(?::\d+)?(?:-\d+)?(?:[?#]|$)/.test(url) ? url : defaultUrlTransform(url);
}
