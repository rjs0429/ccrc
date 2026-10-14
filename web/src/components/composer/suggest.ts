import { useEffect, useState } from "react";
import type { CommandInfo } from "../../../../broker/src/protocol.ts";
import { call } from "../../state.ts";

const FILES_DEBOUNCE_MS = 150;

// The "@" mention the caret is in: its range and what follows "@" up to the caret. Claude Code reads
// a mention at the start of the text or after a space or 。、？！.
export function mentionAt(text: string, caret: number): { start: number; end: number; query: string } | undefined {
  const m = /(^|[\s。、？！])@([^\s"]*)$/.exec(text.slice(0, caret));
  if (!m) return undefined;
  const rest = /^\S*/.exec(text.slice(caret))?.[0] ?? "";
  return { start: m.index + m[1].length, end: caret + rest.length, query: m[2] };
}

// A plain mention ends at a space and drops trailing characters other than ASCII letters, digits
// and "_", so other paths are quoted the way Claude Code reads them.
export function mentionText(path: string): string {
  return /^[^\s"]*[A-Za-z0-9_]$/.test(path) || path.includes('"') ? `@${path}` : `@"${path}"`;
}

// The command name typed so far while the message is "/" and a name without a space.
export function commandQuery(text: string): string | undefined {
  return /^\/(\S*)$/.exec(text)?.[1];
}

function commandScore(name: string, q: string): number | undefined {
  const n = name.toLowerCase();
  if (n.startsWith(q)) return 3000 - n.length;
  const at = n.indexOf(q);
  if (at !== -1) return 2000 - at * 10 - n.length;
  let from = 0;
  let gaps = 0;
  for (const c of q) {
    const i = n.indexOf(c, from);
    if (i === -1) return undefined;
    if (from) gaps += i - from;
    from = i + 1;
  }
  return 1000 - gaps * 10 - n.length;
}

// Prefix matches first, then substrings, then the letters in order with the fewest gaps.
export function rankCommands(commands: CommandInfo[], query: string): CommandInfo[] {
  const q = query.toLowerCase();
  if (!q) return commands;
  return commands
    .map((c) => ({ c, score: commandScore(c.name, q) }))
    .filter((x): x is { c: CommandInfo; score: number } => x.score !== undefined)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.c);
}

function containsInOrder(path: string, query: string): boolean {
  const p = path.toLowerCase();
  let i = 0;
  for (const c of query.toLowerCase()) {
    i = p.indexOf(c, i) + 1;
    if (!i) return false;
  }
  return true;
}

// Files of the session's folder matching the query. While the answer for a longer query is on its way,
// the files of the previous answer that still match stay; no other file is ever offered.
export function useFileSuggestions(sessionId: string | undefined, query: string | undefined): string[] | undefined {
  const [found, setFound] = useState<{ query: string; files: string[] }>();
  useEffect(() => {
    if (!sessionId || query === undefined) return;
    let live = true;
    const timer = setTimeout(() => {
      call(sessionId, "files", { query }).then(
        (files) => live && setFound({ query, files }),
        () => live && setFound({ query, files: [] }),
      );
    }, FILES_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [sessionId, query]);
  if (query === undefined || !found) return undefined;
  if (found.query === query) return found.files;
  return query.startsWith(found.query) ? found.files.filter((f) => containsInOrder(f, query)) : undefined;
}

const commandLists = new Map<string, CommandInfo[]>();

// The session's "/" commands, asked once per session while the app is open.
export function useCommands(sessionId: string | undefined, wanted: boolean): CommandInfo[] | undefined {
  const [, setLoaded] = useState(0);
  useEffect(() => {
    if (!sessionId || !wanted || commandLists.has(sessionId)) return;
    let live = true;
    call(sessionId, "commands").then(
      (list) => {
        if (list.length) commandLists.set(sessionId, list);
        if (live) setLoaded((n) => n + 1);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [sessionId, wanted]);
  return sessionId ? commandLists.get(sessionId) : undefined;
}
