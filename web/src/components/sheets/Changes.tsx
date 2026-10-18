import { useMemo, useState } from "react";
import type { DisplayItem, Hunk } from "../../../../broker/src/protocol.ts";
import { clock, shortPath } from "../../labels.ts";
import { composerInsert, useApp } from "../../state.ts";
import { DiffView, PatchStats } from "../diff/DiffView.tsx";
import type { DiffLine } from "../diff/hunks.ts";
import { Button, Icon, Sheet } from "../ui.tsx";
import { Waiting, inOrder, useFound } from "./parts.tsx";
import type { SheetProps } from "./types.ts";

interface Change {
  id: string;
  name: string;
  ts?: string;
  patch: Hunk[];
  cut?: number;
}

interface ChangedFile {
  file: string;
  changes: Change[];
  hunks: Hunk[];
}

interface Picked {
  change: string;
  key: string;
  line: DiffLine;
}

const NO_ITEMS: DisplayItem[] = [];

// Tool calls that changed files, by file, in the order the files were first changed.
function changedFiles(items: DisplayItem[]): ChangedFile[] {
  const files = new Map<string, ChangedFile>();
  for (const item of items) {
    if (item.kind !== "tool" || !item.file || !item.patch) continue;
    const f = files.get(item.file) ?? { file: item.file, changes: [], hunks: [] };
    f.changes.push({ id: item.id, name: item.name, ts: item.ts, patch: item.patch, cut: item.patchCut });
    f.hunks.push(...item.patch);
    files.set(item.file, f);
  }
  return [...files.values()];
}

function inside(file: string, cwd: string): string | undefined {
  return cwd && file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : undefined;
}

// The line as a quote for the message, with its place in the file and whether it was added or removed.
function quote(path: string, line: DiffLine, comment: string): string {
  const no = line.kind === "removed" ? line.oldNo : line.newNo;
  const sign = line.kind === "removed" ? "-" : line.kind === "added" ? "+" : " ";
  return `> ${path}:${no}\n> ${sign}${line.text}\n\n${comment.trim()}`;
}

export function ChangesSheet({ sessionId, onClose }: SheetProps) {
  const items = useApp((s) => (s.chat?.sessionId === sessionId ? s.chat.items : NO_ITEMS));
  const partial = useApp((s) => s.chat?.sessionId === sessionId && Boolean(s.chat.hasMore || s.chat.gap));
  const found = useFound(sessionId, "changes", partial);
  const cwd = useApp((s) => (s.chat?.sessionId === sessionId ? s.chat.state?.cwd : undefined) ?? s.sessions?.find((x) => x.id === sessionId)?.cwd ?? "");
  const files = useMemo(() => changedFiles(inOrder(items, found)), [items, found]);
  const [open, setOpen] = useState<string | null>(null);
  const [pick, setPick] = useState<Picked | null>(null);
  const [comment, setComment] = useState("");
  const file = files.find((f) => f.file === open);
  const name = (path: string) => inside(path, cwd) ?? shortPath(path);

  if (!file) {
    return (
      <Sheet title="변경 사항" onClose={onClose}>
        {partial && found === undefined && <Waiting text="이전 대화의 변경을 불러오는 중입니다" />}
        {partial && found === null && <div className="mb-2 px-1 text-xs text-muted">화면에 불러온 대화에서 바뀐 파일만 보여 줍니다.</div>}
        {files.length === 0 && !(partial && found === undefined) && <div className="px-1 py-2 text-sm text-muted">바뀐 파일이 없습니다</div>}
        {files.map((f) => (
          <button key={f.file} onClick={() => setOpen(f.file)} className="flex w-full items-center gap-2 rounded-xl px-2 py-2.5 text-left hover:bg-surface-2">
            <span className="min-w-0 flex-1 font-mono text-[13px] break-all">{name(f.file)}</span>
            {f.changes.length > 1 && <span className="shrink-0 text-xs text-muted">{f.changes.length}회</span>}
            <PatchStats hunks={f.hunks} />
            <Icon.chevronRight className="size-4 shrink-0 text-muted" />
          </button>
        ))}
      </Sheet>
    );
  }

  const insert = () => {
    if (!pick) return;
    composerInsert(quote(inside(file.file, cwd) ?? file.file, pick.line, comment));
    onClose();
  };

  return (
    <Sheet title="변경 사항" onClose={onClose}>
      <button onClick={() => (setOpen(null), setPick(null))} className="mb-2 flex items-center gap-0.5 text-sm text-muted">
        <Icon.back className="size-4" />
        파일 목록
      </button>
      <div className="mb-3 flex items-start gap-2">
        <div className="min-w-0 flex-1 font-mono text-[13px] break-all">{name(file.file)}</div>
        <PatchStats hunks={file.hunks} />
      </div>
      <div className="space-y-2.5">
        {file.changes.map((c) => (
          <DiffView
            key={c.id}
            hunks={c.patch}
            cut={c.cut}
            full
            title={`${c.name}${c.ts ? ` · ${clock(c.ts)}` : ""}`}
            picked={pick?.change === c.id ? pick.key : undefined}
            onLine={(line, key) => setPick({ change: c.id, key, line })}
          />
        ))}
      </div>
      {pick ? (
        <div className="sticky bottom-0 -mx-4 mt-3 border-t border-line bg-surface px-4 pt-2.5">
          <div className="mb-1.5 flex items-center gap-2 text-xs text-muted">
            <span className="min-w-0 flex-1 truncate font-mono">
              {name(file.file)}:{pick.line.kind === "removed" ? pick.line.oldNo : pick.line.newNo}
            </span>
            <button onClick={() => setPick(null)} aria-label="닫기" className="p-1">
              <Icon.x className="size-4" />
            </button>
          </div>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={2}
            placeholder="코멘트 (선택)"
            className="block w-full resize-none rounded-xl border border-line bg-bg px-3 py-2 text-[16px] leading-snug outline-none placeholder:text-muted focus:border-accent"
          />
          <Button kind="primary" className="mt-2 w-full" onClick={insert}>
            입력창에 넣기
          </Button>
        </div>
      ) : (
        <div className="mt-3 px-1 text-xs text-muted">줄을 누르면 코멘트를 달아 입력창에 넣을 수 있습니다.</div>
      )}
    </Sheet>
  );
}
