import { useMemo, useState, type ReactNode } from "react";
import type { Hunk } from "../../../../broker/src/protocol.ts";
import { t } from "../../i18n/index.ts";
import { Icon } from "../ui.tsx";
import { numbered, patchStats, type DiffLine } from "./hunks.ts";

const PREVIEW_LINES = 60;
const NO_NEWLINE = "No newline at end of file";

const TONE: Record<DiffLine["kind"], string> = { added: "bg-ok/10", removed: "bg-danger/10", context: "", note: "" };
const SIGN: Record<DiffLine["kind"], string> = { added: "+", removed: "-", context: " ", note: " " };
const SIGN_TONE: Record<DiffLine["kind"], string> = { added: "text-ok", removed: "text-danger", context: "", note: "" };

export function PatchStats({ hunks }: { hunks: Hunk[] }) {
  const { added, removed } = patchStats(hunks);
  if (!added && !removed) return null;
  return (
    <span className="shrink-0 font-mono text-[12px]">
      {added > 0 && <span className="text-ok">+{added}</span>}
      {added > 0 && removed > 0 && " "}
      {removed > 0 && <span className="text-danger">−{removed}</span>}
    </span>
  );
}

function hunkHeader(h: Hunk): string {
  return `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
}

function firstLines(blocks: DiffLine[][], limit: number): DiffLine[][] {
  const out: DiffLine[][] = [];
  let room = limit;
  for (const lines of blocks) {
    if (room <= 0) break;
    out.push(lines.slice(0, room));
    room -= lines.length;
  }
  return out;
}

interface RowProps {
  line: DiffLine;
  width?: string;
  picked: boolean;
  onPick?: () => void;
}

function Row({ line, width, picked, onPick }: RowProps) {
  const className = `flex min-w-full text-left ${TONE[line.kind]} ${picked ? "ring-1 ring-accent ring-inset" : ""}`;
  const body =
    line.kind === "note" ? (
      <span className="px-2 font-sans text-[11px] text-muted italic">{line.text === NO_NEWLINE ? t("파일 끝에 줄바꿈 없음") : line.text}</span>
    ) : (
      <>
        {width && (
          <>
            <span className="shrink-0 pr-1 text-right text-muted/70 select-none" style={{ width }}>
              {line.oldNo ?? ""}
            </span>
            <span className="shrink-0 pr-1 text-right text-muted/70 select-none" style={{ width }}>
              {line.newNo ?? ""}
            </span>
          </>
        )}
        <span className={`w-4 shrink-0 text-center whitespace-pre select-none ${SIGN_TONE[line.kind]}`}>{SIGN[line.kind]}</span>
        <span className="pr-3 whitespace-pre">{line.text || " "}</span>
      </>
    );
  if (!onPick || line.kind === "note") return <div className={className}>{body}</div>;
  return (
    <button type="button" onClick={onPick} className={className}>
      {body}
    </button>
  );
}

interface Props {
  hunks: Hunk[];
  // Lines the broker left out of a long patch.
  cut?: number;
  // Hunks of a reported patch know where they sit in the file; a diff of two snippets does not.
  numbers?: boolean;
  // A header row that folds the diff.
  title?: ReactNode;
  // Every line at once, instead of the first few and a button for the rest.
  full?: boolean;
  onLine?: (line: DiffLine, key: string) => void;
  picked?: string;
}

// A unified diff: old and new line numbers, added and removed lines on green and red, long lines
// scrolled sideways.
export function DiffView({ hunks, cut = 0, numbers = true, title, full = false, onLine, picked }: Props) {
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(full);
  const blocks = useMemo(() => hunks.map(numbered), [hunks]);
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const shown = all ? blocks : firstLines(blocks, PREVIEW_LINES);
  const last = Math.max(1, ...hunks.map((h) => Math.max(h.oldStart + h.oldLines, h.newStart + h.newLines)));
  const width = numbers ? `${String(last).length + 1}ch` : undefined;
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      {title !== undefined && (
        <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 bg-surface-2 px-2.5 py-1.5 text-left text-xs">
          <span className="min-w-0 flex-1 truncate text-muted">{title}</span>
          <PatchStats hunks={hunks} />
          <Icon.chevronDown className={`size-3.5 shrink-0 text-muted transition-transform ${open ? "" : "-rotate-90"}`} />
        </button>
      )}
      {open && (
        <>
          <div className="overflow-x-auto bg-code font-mono text-[12px] leading-relaxed">
            <div className="w-max min-w-full py-1">
              {shown.map((lines, h) => (
                <div key={h}>
                  {numbers && <div className="px-2 text-[11px] text-muted/80 select-none">{hunkHeader(hunks[h])}</div>}
                  {lines.map((line, n) => {
                    const key = `${h}:${n}`;
                    return <Row key={key} line={line} width={width} picked={picked === key} onPick={onLine && (() => onLine(line, key))} />;
                  })}
                </div>
              ))}
            </div>
          </div>
          {!all && total > PREVIEW_LINES && (
            <button onClick={() => setAll(true)} className="w-full border-t border-line py-1.5 text-xs text-muted">
              {t("{n}줄 더 보기", { n: total - PREVIEW_LINES })}
            </button>
          )}
          {cut > 0 && (all || total <= PREVIEW_LINES) && <div className="border-t border-line px-2.5 py-1.5 text-xs text-muted">{t("길어서 {n}줄은 생략했습니다", { n: cut })}</div>}
        </>
      )}
    </div>
  );
}
