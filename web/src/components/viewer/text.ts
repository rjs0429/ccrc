import hljs from "highlight.js/lib/common";

const HIGHLIGHT_MAX_CHARS = 300_000;
const ALIASES: Record<string, string> = {
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  h: "c",
  hpp: "cpp",
  cc: "cpp",
  hh: "cpp",
  zsh: "bash",
  sh: "bash",
  yml: "yaml",
  toml: "ini",
  cfg: "ini",
  conf: "ini",
  svg: "xml",
  htm: "xml",
  html: "xml",
  vue: "xml",
  jsonl: "json",
  jsonc: "json",
  patch: "diff",
  mk: "makefile",
  gradle: "groovy",
  kts: "kotlin",
  mdx: "markdown",
};

export function languageOf(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (lower === "makefile" || lower === "gnumakefile") return "makefile";
  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) return hljs.getLanguage("dockerfile") ? "dockerfile" : undefined;
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const ext = lower.slice(dot + 1);
  const lang = ALIASES[ext] ?? ext;
  return hljs.getLanguage(lang) ? lang : undefined;
}

const escape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Highlighted HTML cut into lines; spans that cross a line end are closed and reopened.
export function htmlLines(text: string, lang?: string): string[] {
  const html = lang && text.length <= HIGHLIGHT_MAX_CHARS ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value : escape(text);
  const lines: string[] = [];
  const open: string[] = [];
  let line = "";
  const tag = /<span[^>]*>|<\/span>|\n/g;
  let at = 0;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    line += html.slice(at, m.index);
    at = m.index + m[0].length;
    if (m[0] === "\n") {
      lines.push(line + "</span>".repeat(open.length));
      line = open.join("");
    } else if (m[0] === "</span>") {
      open.pop();
      line += m[0];
    } else {
      open.push(m[0]);
      line += m[0];
    }
  }
  lines.push(line + html.slice(at));
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const ROWS_MAX = 1000;

// RFC 4180 fields: quotes around a field allow the separator, line breaks and doubled quotes inside it.
export function parseTable(text: string, sep: string): { rows: string[][]; more: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === sep) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (rows.length > ROWS_MAX) return { rows: rows.slice(0, ROWS_MAX), more: true };
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return { rows, more: false };
}

// GitHub's heading anchors: lower case, punctuation dropped, spaces as hyphens.
export function slug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}
