// The phone app's text as the screens hold it: sentences handed to t()/k()/tNode() and Korean left outside them.
// Run it to list what is left: node broker/test/i18n-scan.ts [path ...] (paths under web/src; all files by default).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { en } from "../../web/src/i18n/en/index.ts";

export const WEB = path.resolve(import.meta.dirname, "../../web/src");
// The dictionaries and the per-language forms of dates live here.
const I18N = path.join(WEB, "i18n");
const HANGUL = /[ㄱ-ㆎ가-힣]/;
const KEYED = new Set(["t", "k", "tNode"]);
// t() and tNode() give the text of the current language, so they run where it is shown, never at module level.
const SHOWN = new Set(["t", "tNode"]);

export interface Found {
  file: string;
  line: number;
  text: string;
}

export interface Scan {
  files: string[];
  keys: Map<string, Found[]>;
  outside: Found[];
  moduleLevel: Found[];
}

export function webFiles(dir = WEB): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (p !== I18N) out.push(...webFiles(p));
    } else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out.sort();
}

const FUNCTION = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);

function inFunction(node: ts.Node): boolean {
  for (let n = node.parent; n; n = n.parent) if (FUNCTION.has(n.kind)) return true;
  return false;
}

export function scanFiles(files = webFiles()): Scan {
  const scan: Scan = { files, keys: new Map(), outside: [], moduleLevel: [] };
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const rel = path.relative(WEB, file);
    const at = (node: ts.Node, t: string): Found => ({ file: rel, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: t });
    const keyed = new Set<ts.Node>();
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && KEYED.has(node.expression.text)) {
        const arg = node.arguments[0];
        if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
          keyed.add(arg);
          const list = scan.keys.get(arg.text) ?? [];
          list.push(at(arg, arg.text));
          scan.keys.set(arg.text, list);
        }
        if (SHOWN.has(node.expression.text) && !inFunction(node)) scan.moduleLevel.push(at(node, node.getText(sf)));
      }
      if (ts.isLiteralTypeNode(node)) return;
      if (!keyed.has(node)) {
        if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)) && HANGUL.test(node.text)) {
          scan.outside.push(at(node, node.text.trim()));
        } else if (ts.isTemplateExpression(node)) {
          if ([node.head, ...node.templateSpans.map((s) => s.literal)].some((p) => HANGUL.test(p.text))) scan.outside.push(at(node, node.getText(sf)));
          node.templateSpans.forEach((s) => visit(s.expression));
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return scan;
}

// Names in a sentence's placeholders: `{name}` and `{name|one|other}`.
export function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{(\w+)(?:\|[^|{}]*\|[^|{}]*)?\}/g)].map((m) => m[1]))].sort();
}

export function missing(scan: Scan, dict: Readonly<Record<string, string>> = en): Found[] {
  return [...scan.keys].filter(([key]) => !Object.hasOwn(dict, key)).map(([, places]) => places[0]);
}

export function byFile(found: Found[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const f of found) counts.set(f.file, (counts.get(f.file) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const wanted = process.argv.slice(2).map((p) => path.resolve(WEB, p));
  const files = webFiles().filter((f) => !wanted.length || wanted.some((w) => f === w || f.startsWith(w + path.sep)));
  const scan = scanFiles(files);
  const lack = missing(scan);
  for (const [title, list] of [
    ["Korean outside t()/k()", scan.outside],
    ["sentences without English", lack],
    ["t() at module level", scan.moduleLevel],
  ] as const) {
    console.log(`\n${title}: ${list.length}`);
    for (const f of list) console.log(`  ${f.file}:${f.line}  ${f.text.replace(/\s+/g, " ").slice(0, 120)}`);
  }
}
