import { useEffect, useState, type ReactNode } from "react";
import type { DisplayItem, HistoryFind } from "../../../../broker/src/protocol.ts";
import { t } from "../../i18n/index.ts";
import { call } from "../../state.ts";
import { Spinner } from "../ui.tsx";

// What a sheet lists from the whole conversation while the chat holds only part of it: undefined until it comes or
// when the chat holds it all, null when it could not be read.
export function useFound(sessionId: string, find: HistoryFind, partial: boolean): DisplayItem[] | null | undefined {
  const [found, setFound] = useState<DisplayItem[] | null>();
  useEffect(() => {
    if (!partial) return;
    let live = true;
    call(sessionId, "history_find", { find }).then(
      (r) => live && setFound(r.items),
      () => live && setFound(null),
    );
    return () => {
      live = false;
    };
  }, [sessionId, find, partial]);
  return found;
}

// The loaded items in the order of the whole conversation, then the ones that came since it was read.
export function inOrder<T extends { id: string }>(loaded: T[], found: T[] | null | undefined): T[] {
  if (!found) return loaded;
  const fresh = new Map(loaded.map((i) => [i.id, i]));
  const ids = new Set(found.map((i) => i.id));
  return [...found.map((i) => fresh.get(i.id) ?? i), ...loaded.filter((i) => !ids.has(i.id))];
}

export function Waiting({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 px-1 py-3 text-sm text-muted">
      <Spinner className="size-4 shrink-0" />
      {text}
    </div>
  );
}

export function Failed({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="rounded-xl bg-surface-2 px-3 py-2.5 text-sm">
      <div className="text-danger">{text}</div>
      {onRetry && (
        <button onClick={onRetry} className="mt-1.5 font-medium text-accent">
          {t("다시 시도")}
        </button>
      )}
    </div>
  );
}

// `tall` keeps a full 44px tap target, for a button that is the main action where it stands.
export function SmallButton({ children, onClick, disabled, tone = "", tall }: { children: ReactNode; onClick: () => void; disabled?: boolean; tone?: string; tall?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`shrink-0 rounded-lg bg-surface-2 py-1.5 text-sm font-medium disabled:opacity-40 ${tall ? "min-h-11 px-4" : "px-3"} ${tone}`}
    >
      {children}
    </button>
  );
}
