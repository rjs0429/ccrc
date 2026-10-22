import type { Lang } from "../lang.ts";
import { cleanTitle } from "../titles.ts";
import { HOLD_TEXT } from "../wrapper/hold.ts";

const COPY_TITLE_MAX = 120;
const COPY_PREFIX = /^\((?:복사본|copy)(?: (\d{1,4}))?\) /iu;

// The name of a copy VS Code opens while another process holds the session: the first line of the original's name, cut
// short, after "(복사본)"; a copy of a copy counts on as "(복사본 2)". Nothing for a session without a name.
export function copyTitle(title: string, lang: Lang): string | undefined {
  const line = cleanTitle(title.split(/\r\n|\r|\n/).find((l) => l.trim()) ?? "");
  if (!line) return undefined;
  const m = COPY_PREFIX.exec(line);
  const base = [...(m ? line.slice(m[0].length) : line)].slice(0, COPY_TITLE_MAX).join("").trim();
  const n = m ? Number(m[1] ?? 1) + 1 : 1;
  return base ? `${HOLD_TEXT[lang].copyPrefix(n)} ${base}` : undefined;
}
