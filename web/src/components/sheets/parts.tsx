import type { ReactNode } from "react";
import { Spinner } from "../ui.tsx";

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
      <div className="break-words text-danger">{text}</div>
      {onRetry && (
        <button onClick={onRetry} className="mt-1.5 font-medium text-accent">
          다시 시도
        </button>
      )}
    </div>
  );
}

export function SmallButton({ children, onClick, disabled, tone = "" }: { children: ReactNode; onClick: () => void; disabled?: boolean; tone?: string }) {
  return (
    <button onClick={onClick} disabled={disabled} className={`shrink-0 rounded-lg bg-surface-2 px-3 py-1.5 text-sm font-medium disabled:opacity-40 ${tone}`}>
      {children}
    </button>
  );
}
