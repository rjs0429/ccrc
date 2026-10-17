import fs from "node:fs";
import path from "node:path";
import jsonc from "jsonc-parser";
import { ensureDir } from "../config.ts";

// VS Code's user settings.json is JSON with comments and trailing commas. Setup changes one key in place, keeping the
// rest of the text as it was, and copies the file aside first.

export const WRAPPER_SETTING = "claudeCode.claudeProcessWrapper";

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

export function settingsFile(vscodeUserDir: string): string {
  return path.join(vscodeUserDir, "User", "settings.json");
}

export function parseSettingsText(text: string, file = "settings.json"): Obj {
  if (trivia(text)) return {};
  const errors: jsonc.ParseError[] = [];
  const v: unknown = jsonc.parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) {
    const at = errors[0].offset;
    const before = text.slice(0, at).split("\n");
    throw Error(`${file}: cannot read it at line ${before.length}, column ${before.at(-1)!.length + 1}; fix it in VS Code and run setup again`);
  }
  if (!isObject(v)) throw Error(`${file}: must hold a JSON object`);
  return v;
}

const splice = (text: string, at: number, length: number, insert: string) => text.slice(0, at) + insert + text.slice(at + length);
const blank = (s: string) => /^[ \t]*$/.test(s);
const lineStart = (text: string, i: number) => text.lastIndexOf("\n", i - 1) + 1;

// Where the line holding i ends, before its line break.
function lineEnd(text: string, i: number): number {
  const n = text.indexOf("\n", i);
  if (n < 0) return text.length;
  return text[n - 1] === "\r" ? n - 1 : n;
}

// The first comma between from and to that is not in a comment; -1 when there is none.
function commaIn(text: string, from: number, to: number): number {
  const scan = jsonc.createScanner(text.slice(from, to), false);
  for (let t = scan.scan(); t !== jsonc.SyntaxKind.EOF; t = scan.scan()) if (t === jsonc.SyntaxKind.CommaToken) return from + scan.getTokenOffset();
  return -1;
}

// Whether text holds only spaces and whole comments (a block comment cut off at its end does not count).
function trivia(text: string): boolean {
  const scan = jsonc.createScanner(text, false);
  for (let t = scan.scan(); t !== jsonc.SyntaxKind.EOF; t = scan.scan()) {
    if (t !== jsonc.SyntaxKind.Trivia && t !== jsonc.SyntaxKind.LineCommentTrivia && t !== jsonc.SyntaxKind.BlockCommentTrivia && t !== jsonc.SyntaxKind.LineBreakTrivia) return false;
    if (scan.getTokenError() !== jsonc.ScanError.None) return false;
  }
  return true;
}

function rootOf(text: string): jsonc.Node | undefined {
  parseSettingsText(text);
  return jsonc.parseTree(text, [], { allowTrailingComma: true });
}

const keyOf = (p: jsonc.Node) => p.children?.[0]?.value as unknown;

function removeOne(text: string, root: jsonc.Node, i: number): string {
  const props = root.children!;
  const p = props[i];
  let start = p.offset;
  let end = p.offset + p.length;
  const next = i + 1 < props.length ? props[i + 1].offset : root.offset + root.length - 1;
  const after = commaIn(text, end, next);
  if (after >= 0) end = after + 1;
  else if (i > 0) {
    // The last member goes with the comma before it.
    const before = commaIn(text, props[i - 1].offset + props[i - 1].length, start);
    if (before >= 0) {
      text = splice(text, before, 1, "");
      start--;
      end--;
    }
  }
  if (blank(text.slice(lineStart(text, start), start)) && blank(text.slice(end, lineEnd(text, end)))) {
    start = lineStart(text, start);
    const le = lineEnd(text, end);
    end = le + (text.startsWith("\r\n", le) ? 2 : text[le] === "\n" ? 1 : 0);
  }
  return splice(text, start, end - start, "");
}

function insert(text: string, root: jsonc.Node, entry: string, eol: string): string {
  const props = root.children ?? [];
  const close = root.offset + root.length - 1;
  if (!props.length) {
    const inner = text.slice(root.offset + 1, close);
    const indent = /\n([ \t]+)\S/.exec(text)?.[1] ?? "    ";
    return blank(inner.replace(/\r?\n/g, "")) ? splice(text, root.offset + 1, inner.length, `${eol}${indent}${entry}${eol}`) : splice(text, root.offset + 1, 0, `${eol}${indent}${entry}`);
  }
  const last = props.at(-1)!;
  const lastEnd = last.offset + last.length;
  const comma = commaIn(text, lastEnd, close);
  const indent = text.slice(lineStart(text, last.offset), last.offset);
  // Members written on one line get the new one on that line too.
  if (!blank(indent)) return comma >= 0 ? splice(text, comma + 1, 0, ` ${entry},`) : splice(text, lastEnd, 0, `, ${entry}`);
  // With a trailing comma after the last member the new one gets one too; a comment after it stays on its line.
  let anchor = comma >= 0 ? comma + 1 : lastEnd;
  if (comma < 0) {
    text = splice(text, lastEnd, 0, ",");
    anchor++;
  }
  const end = lineEnd(text, anchor);
  const at = trivia(text.slice(anchor, end)) ? end : anchor;
  return splice(text, at, 0, `${eol}${indent}${entry}${comma >= 0 ? "," : ""}`);
}

// The text with a top-level key set to value, or taken out when value is undefined. Only that member and the comma
// next to it change; comments, layout and the rest of the text stay as they were.
export function editSettingsText(text: string, key: string, value: string | undefined): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const entry = `${JSON.stringify(key)}: ${JSON.stringify(value)}`;
  let root = rootOf(text);
  if (!root) {
    if (value === undefined) return text;
    return `${text}${text && !text.endsWith("\n") ? eol : ""}{${eol}    ${entry}${eol}}${eol}`;
  }
  if (value !== undefined) {
    const p = root.children?.findLast((c) => keyOf(c) === key);
    const v = p?.children?.[1];
    return v ? splice(text, v.offset, v.length, JSON.stringify(value)) : insert(text, root, entry, eol);
  }
  // VS Code reads the last of keys written twice; all of them go.
  for (;;) {
    const i = root?.children?.findLastIndex((c) => keyOf(c) === key) ?? -1;
    if (!root || i < 0) return text;
    text = removeOne(text, root, i);
    root = rootOf(text);
  }
}

export function readSettingsFile(file: string): { text: string; settings: Obj } | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  return { text, settings: parseSettingsText(text, file) };
}

export interface SettingsChange {
  file: string;
  // The copy of the file before the change; none when the file did not exist.
  backup?: string;
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

// Sets (or with undefined, removes) one key of settings.json. A file that is a link is changed where it points, so a
// settings file kept elsewhere stays linked; the file keeps its permissions.
export function changeSetting(file: string, key: string, value: string | undefined, backupDir: string, now = new Date()): SettingsChange {
  const current = readSettingsFile(file);
  const next = editSettingsText(current?.text ?? "", key, value);
  if (current && next === current.text) return { file };
  let target = file;
  let mode = 0o644;
  let backup: string | undefined;
  if (current) {
    target = fs.realpathSync(file);
    mode = fs.statSync(target).mode & 0o777;
    ensureDir(backupDir);
    backup = path.join(backupDir, `vscode-settings-${stamp(now)}.json`);
    fs.copyFileSync(target, backup);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const tmp = `${target}.ccrc-${process.pid}.tmp`;
  fs.writeFileSync(tmp, next, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, target);
  return { file, ...(backup ? { backup } : {}) };
}
