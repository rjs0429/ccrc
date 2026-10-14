import { useEffect, useRef } from "react";

export interface SuggestRow {
  key: string;
  label: string;
  hint?: string;
  detail?: string;
}

// The "@" file and "/" command choices, shown above the input.
export function Suggestions({ rows, active, onPick }: { rows: SuggestRow[]; active: number; onPick: (index: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = ref.current;
    const row = box?.children[active] as HTMLElement | undefined;
    if (!box || !row) return;
    if (row.offsetTop < box.scrollTop) box.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = row.offsetTop + row.offsetHeight - box.clientHeight;
  }, [active]);
  return (
    <div ref={ref} role="listbox" className="absolute inset-x-0 bottom-full z-20 mb-1.5 max-h-56 short:max-h-32 overflow-y-auto overscroll-contain rounded-xl border border-line bg-surface py-1 shadow-lg">
      {rows.map((r, i) => (
        <button
          key={r.key}
          role="option"
          aria-selected={i === active}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(i)}
          className={`block w-full px-3 py-1.5 text-left ${i === active ? "bg-surface-2" : ""}`}
        >
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 text-[14px]">{r.label}</span>
            {r.hint && <span className="min-w-0 truncate text-xs text-muted">{r.hint}</span>}
          </span>
          {r.detail && <span className="block truncate text-xs text-muted">{r.detail}</span>}
        </button>
      ))}
    </div>
  );
}
