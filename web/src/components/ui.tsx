import { useId, type ReactNode, type Ref } from "react";

type IconProps = { className?: string };

function svg(path: ReactNode, viewBox = "0 0 24 24") {
  return ({ className = "size-5" }: IconProps) => (
    <svg viewBox={viewBox} className={className} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {path}
    </svg>
  );
}

export const Icon = {
  back: svg(<path d="M15 18l-6-6 6-6" />),
  plus: svg(<path d="M12 5v14M5 12h14" />),
  gear: svg(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
    </>,
  ),
  send: svg(<path d="M12 19V5M5 12l7-7 7 7" />),
  arrowDown: svg(<path d="M12 5v14M19 12l-7 7-7-7" />),
  paperclip: svg(<path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />),
  file: svg(
    <>
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <path d="M14 2v6h6M16 13H8M16 17H8" />
    </>,
  ),
  zap: ({ className = "size-3" }: IconProps) => (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path d="M13.5 2 4 13.5h6.5L9.5 22 20 9.5h-6.5z" fill="currentColor" />
    </svg>
  ),
  stop: ({ className = "size-4" }: IconProps) => (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
    </svg>
  ),
  check: svg(<path d="M20 6L9 17l-5-5" />),
  x: svg(<path d="M18 6L6 18M6 6l12 12" />),
  chevronDown: svg(<path d="M6 9l6 6 6-6" />),
  chevronRight: svg(<path d="M9 18l6-6-6-6" />),
  dots: svg(
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>,
  ),
  image: svg(
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="M21 15l-5-5L5 21" />
    </>,
  ),
  camera: svg(
    <>
      <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
      <circle cx="12" cy="13" r="4" />
    </>,
  ),
  folder: svg(<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />),
  agents: svg(
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="12" r="2" />
      <path d="M6 7v10M6 9c0 3 3 3 6 3h4" />
    </>,
  ),
  search: svg(
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </>,
  ),
  refresh: svg(
    <>
      <path d="M21 12a9 9 0 11-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </>,
  ),
  pencil: svg(
    <>
      <path d="M17 3a2.85 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5z" />
      <path d="M15 5l4 4" />
    </>,
  ),
  archive: svg(
    <>
      <rect x="2" y="3" width="20" height="5" rx="1" />
      <path d="M4 8v11a2 2 0 002 2h12a2 2 0 002-2V8M10 12h4" />
    </>,
  ),
  unarchive: svg(
    <>
      <rect x="2" y="3" width="20" height="5" rx="1" />
      <path d="M4 8v11a2 2 0 002 2h2M20 8v11a2 2 0 01-2 2h-2M9 15l3-3 3 3M12 12v9" />
    </>,
  ),
  branch: svg(
    <>
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M6 3v12M18 9a9 9 0 01-9 9" />
    </>,
  ),
  bell: svg(<path d="M6 8a6 6 0 0112 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 003.4 0" />),
};

export function Spinner({ className = "size-4" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={`${className} animate-spin`} aria-hidden>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth={3} opacity={0.2} />
      <path d="M21 12a9 9 0 00-9-9" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" />
    </svg>
  );
}

// wide: room for two columns on a landscape screen. tall: the whole height of a portrait screen below its status bar,
// with a header of the content's own in place of the title there.
export function Sheet({ title, onClose, children, wide, tall }: { title?: string; onClose: () => void; children: ReactNode; wide?: boolean; tall?: boolean }) {
  return (
    <div className="overlay fixed z-40 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div
        className={`pb-safe ${tall ? "h-[calc(100%-var(--sat)-0.5rem)] sm:h-auto" : "max-h-[85%]"} w-full max-w-lg overflow-y-auto overscroll-contain rounded-t-2xl bg-surface p-4 shadow-xl sm:max-h-full sm:rounded-2xl ${wide ? "sm:max-w-3xl" : ""}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
      >
        {title && <div className={`mb-3 text-sm font-semibold text-muted ${tall ? "hidden sm:block" : ""}`}>{title}</div>}
        {children}
      </div>
    </div>
  );
}

// value: the current setting, at the end of the line; the label alone names the button. next: it opens more choices.
export function Choice({
  label,
  hint,
  value,
  selected,
  next,
  disabled,
  describedBy,
  onClick,
  ref,
}: {
  label: string;
  hint?: ReactNode;
  value?: string;
  selected?: boolean;
  next?: boolean;
  disabled?: boolean;
  describedBy?: string;
  onClick: () => void;
  ref?: Ref<HTMLButtonElement>;
}) {
  const valueId = useId();
  const described = [describedBy, value && valueId].filter(Boolean).join(" ");
  return (
    <button
      ref={ref}
      onClick={onClick}
      disabled={disabled}
      aria-label={value ? label : undefined}
      aria-describedby={described || undefined}
      className={`flex min-h-11 w-full items-center justify-between rounded-xl px-3 py-2.5 text-left disabled:opacity-50 ${selected ? "bg-accent-soft" : "enabled:hover:bg-surface-2"}`}
    >
      <span>
        <span className="block text-[15px]">{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
      {value && (
        <span id={valueId} className="ml-3 truncate text-sm text-muted" data-choice-value>
          {value}
        </span>
      )}
      {selected && <Icon.check className="size-4 text-accent" />}
      {next && <Icon.chevronRight className="size-4 shrink-0 text-muted" />}
    </button>
  );
}

// A sheet's most used actions side by side in equal tiles, each an icon above a short label.
export function Tiles({ children }: { children: ReactNode }) {
  return (
    <div className="grid auto-cols-fr grid-flow-col gap-2" data-tiles>
      {children}
    </div>
  );
}

export function Tile({ icon, label, disabled, describedBy, onClick }: { icon: ReactNode; label: string; disabled?: boolean; describedBy?: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-describedby={describedBy}
      className="flex min-h-11 min-w-0 flex-col items-center justify-center gap-1 rounded-xl bg-surface-2 px-1 py-2.5 text-[13px] leading-tight enabled:hover:bg-line enabled:active:bg-line disabled:opacity-50"
    >
      {icon}
      <span className="text-center">{label}</span>
    </button>
  );
}

export function Row({ label, value, onClick }: { label: string; value?: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center justify-between border-b border-line px-1 py-3 text-left">
      <span className="text-[15px]">{label}</span>
      <span className="flex items-center gap-1 text-sm text-muted">
        {value}
        <Icon.chevronRight className="size-4" />
      </span>
    </button>
  );
}

export function Notice({ title, body, action, onAction }: { title: string; body?: string; action: string; onAction: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg px-safe-6 py-6">
      <div className="w-full max-w-sm text-center">
        <div className="text-lg font-semibold">{title}</div>
        {body && <p className="mt-2 text-sm text-muted">{body}</p>}
        <button onClick={onAction} className="mt-6 w-full rounded-xl bg-accent px-4 py-3 font-medium text-white">
          {action}
        </button>
      </div>
    </div>
  );
}

export function Button({
  children,
  onClick,
  kind = "secondary",
  disabled,
  className = "",
  describedBy,
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
  className?: string;
  describedBy?: string;
}) {
  const styles = {
    primary: "bg-accent text-white",
    secondary: "bg-surface-2 text-fg",
    danger: "bg-surface-2 text-danger",
    ghost: "text-muted",
  }[kind];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-describedby={describedBy}
      className={`rounded-xl px-3.5 py-2.5 text-[15px] font-medium disabled:opacity-40 ${styles} ${className}`}
    >
      {children}
    </button>
  );
}
