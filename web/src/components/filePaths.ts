const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const EXTENSION = /^\.?[^.]+(\.[^.]+)*\.[A-Za-z][A-Za-z0-9_-]{0,11}$|^\.[A-Za-z][\w.-]*$/;

const under = (p: string, root: string) => Boolean(root) && p.length > root.length && p.startsWith(root.endsWith("/") ? root : `${root}/`);

// Whether a tool input value reads as a file the viewer can open: a path whose last segment has an extension,
// a ./ ../ ~/ path, or a path under one of the session's folders. URL paths without an extension and plain
// words stay text; a bare name counts only when the key says it is a path.
export function looksLikeFile(value: string, roots: readonly string[] = [], pathKey = false): boolean {
  const v = value.trim();
  if (!v || v !== value || v.length >= 1000 || /[\n\0*?]/.test(v) || SCHEME.test(v) || v.endsWith("/")) return false;
  if (!pathKey && /\s/.test(v)) return false;
  const last = v.slice(v.lastIndexOf("/") + 1);
  if (last === "." || last === "..") return false;
  if (!v.includes("/")) return pathKey && EXTENSION.test(last);
  if (/^(\.\.?|~)\//.test(v)) return true;
  if (v.startsWith("/") && roots.some((r) => under(v, r))) return true;
  return EXTENSION.test(last);
}
