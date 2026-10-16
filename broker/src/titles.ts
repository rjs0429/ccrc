// Session names as Claude Code keeps them. Shared by the broker and the web client.

// Claude Code cuts a session name to this many code points.
export const TITLE_MAX = 200;

// Claude Code's rule for a session name: trimmed, each run of control or format characters (line breaks, zero-width
// spaces, direction marks) made one space, cut to TITLE_MAX code points and trimmed again.
export function cleanTitle(raw: string): string {
  const spaced = raw
    .trim()
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  return [...spaced].slice(0, TITLE_MAX).join("").trim();
}
