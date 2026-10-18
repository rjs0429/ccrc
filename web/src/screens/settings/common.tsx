import type { ReactNode } from "react";
import { ApiError } from "../../api.ts";
import { clock } from "../../labels.ts";
import { loggedOut, toast } from "../../state.ts";

export function SectionTitle({ children }: { children: ReactNode }) {
  return <div className="text-sm font-semibold text-muted">{children}</div>;
}

// Shows why a request failed; error codes listed in `known` get their own text.
export function showError(e: unknown, known: Record<string, string> = {}): void {
  if (e instanceof ApiError && e.status === 401) return loggedOut("expired");
  const code = e instanceof ApiError && typeof e.body.error === "string" ? e.body.error : "";
  toast(known[code] ?? (e instanceof Error ? e.message : String(e)));
}

export function dateTime(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : `${d.getMonth() + 1}월 ${d.getDate()}일 ${clock(ts)}`;
}

export function Switch({ on }: { on: boolean }) {
  return (
    <span aria-hidden className={`relative inline-block h-7 w-12 shrink-0 rounded-full transition-colors ${on ? "bg-accent" : "bg-line"}`}>
      <span className={`absolute top-0.5 left-0.5 size-6 rounded-full bg-white shadow transition-transform ${on ? "translate-x-5" : ""}`} />
    </span>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="flex shrink-0 rounded-lg bg-surface-2 p-0.5">
      {options.map(([v, label]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          aria-pressed={value === v}
          className={`relative min-w-11 rounded-md px-2.5 py-1 text-[13px] after:absolute after:inset-x-0 after:-inset-y-2.5 ${value === v ? "bg-surface font-medium shadow-sm" : "text-muted"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
