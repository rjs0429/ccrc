import { useContext, useState, type ReactNode } from "react";
import { FileLinks, FileRoots } from "../fileLinks.ts";
import { looksLikeFile } from "../filePaths.ts";
import { Markdown } from "../Markdown.tsx";
import { Icon } from "../ui.tsx";

export type Input = Record<string, unknown>;

export const str = (v: unknown) => (typeof v === "string" ? v : "");

export const record = (v: unknown): Input | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Input) : undefined);

export function Pre({ children }: { children: string }) {
  return <pre className="max-h-72 overflow-auto rounded-lg bg-code p-2.5 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap break-all">{children}</pre>;
}

const FOLD_CHARS = 600;
const FOLD_LINES = 12;

// Long text shows its start with a fade and a "더 보기" button. Text is Markdown unless mono or plain.
export function Folded({ text, mono, plain }: { text: string; mono?: boolean; plain?: boolean }) {
  const long = text.length > FOLD_CHARS || text.split("\n").length > FOLD_LINES;
  const [open, setOpen] = useState(!long);
  return (
    <div>
      <div className={open ? "" : "max-h-48 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]"}>
        {mono ? (
          <pre className="font-mono text-[12.5px] break-words whitespace-pre-wrap">{text}</pre>
        ) : plain ? (
          <div className="text-[14px] break-words whitespace-pre-wrap">{text}</div>
        ) : (
          <Markdown text={text} className="text-[14px]" />
        )}
      </div>
      {long && (
        <button onClick={() => setOpen(!open)} className="mt-1 text-sm font-medium text-accent">
          {open ? "접기" : "더 보기"}
        </button>
      )}
    </div>
  );
}

export function Code({ text }: { text: string }) {
  return (
    <div className="rounded-lg bg-code p-2.5">
      <Folded text={text} mono />
    </div>
  );
}

// A link that opens the file in the viewer; "%" and "#" are escaped so the path reaches it whole.
export function fileHref(path: string, line?: number): string {
  return path.replace(/%/g, "%25").replace(/#/g, "%23") + (line ? `#L${line}` : "");
}

export function FileLink({ path, line }: { path: string; line?: number }) {
  const open = useContext(FileLinks);
  const cls = "font-mono text-[12.5px] break-all";
  if (!open || !path) return <div className={`${cls} text-muted`}>{path}</div>;
  const href = fileHref(path, line);
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        open(href);
      }}
      className={`block ${cls} text-accent`}
    >
      {path}
    </a>
  );
}

// A search location, usually a folder: a link only when its name says it is a file.
export function PathValue({ path }: { path: string }) {
  return looksLikeFile(path, [], true) ? <FileLink path={path} /> : <div className="font-mono text-[12.5px] break-all">{path}</div>;
}

export function FileCard({ path, note }: { path: string; note?: string }) {
  const open = useContext(FileLinks);
  const name = path.split("/").filter(Boolean).pop() ?? path;
  const dir = path.slice(0, Math.max(0, path.length - name.length - 1));
  const body = (
    <>
      <Icon.file className="size-5 shrink-0 text-muted" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium">{name}</span>
        {(dir || note) && <span className="block truncate font-mono text-[11.5px] text-muted">{note ?? dir}</span>}
      </span>
      {open && <Icon.chevronRight className="size-4 shrink-0 text-muted" />}
    </>
  );
  const cls = "flex w-full items-center gap-2.5 rounded-xl border border-line bg-bg px-3 py-2 text-left";
  if (!open) return <div className={cls}>{body}</div>;
  return (
    <button data-file={path} onClick={() => open(fileHref(path))} className={cls}>
      {body}
    </button>
  );
}

export function Chip({ children }: { children: ReactNode }) {
  return <span className="inline-block rounded-md bg-surface-2 px-1.5 py-0.5 text-xs text-muted">{children}</span>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0" data-key={label}>
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-0.5 min-w-0 text-[14px] break-words">{children}</div>
    </div>
  );
}

export function Fields({ children }: { children: ReactNode }) {
  return <div className="space-y-2">{children}</div>;
}

const PATH_KEY = /(^|_)(path|file|dir|directory|notebook)(_path)?s?$|Path$/i;
const LONG_TEXT = 200;

// Any value as readable as it gets: text, a file link, or compact JSON for nested values.
export function Value({ name, value }: { name: string; value: unknown }) {
  const roots = useContext(FileRoots);
  const isFile = (v: string) => looksLikeFile(v, roots, PATH_KEY.test(name));
  if (typeof value === "string") {
    if (!value) return <span className="text-muted">(비어 있음)</span>;
    if (isFile(value)) return <FileLink path={value} />;
    if (value.length > LONG_TEXT || value.includes("\n")) return <Folded text={value} plain />;
    return <span className="whitespace-pre-wrap">{value}</span>;
  }
  if (typeof value === "boolean") return <span>{value ? "예" : "아니요"}</span>;
  if (typeof value === "number") return <span className="font-mono text-[13px]">{value}</span>;
  if (value == null) return <span className="text-muted">없음</span>;
  if (Array.isArray(value) && value.length && value.every((v) => typeof v === "string" && isFile(v))) {
    return (
      <div className="space-y-0.5">
        {(value as string[]).map((v, n) => (
          <FileLink key={n} path={v} />
        ))}
      </div>
    );
  }
  if (Array.isArray(value) && value.length && value.every((v) => typeof v === "string" && v && !v.includes("\n") && v.length <= LONG_TEXT)) {
    return <span className="break-words">{value.join(", ")}</span>;
  }
  return <Code text={JSON.stringify(value)} />;
}

// Key and value rows for the input keys a view does not show itself.
export function Rest({ input, skip = [] }: { input: Input; skip?: string[] }) {
  const rows = Object.entries(input).filter(([k, v]) => !skip.includes(k) && v !== undefined);
  if (!rows.length) return null;
  return (
    <Fields>
      {rows.map(([k, v]) => (
        <Field key={k} label={k}>
          <Value name={k} value={v} />
        </Field>
      ))}
    </Fields>
  );
}
