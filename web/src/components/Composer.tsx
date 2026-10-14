import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EffortName, LiveState, ModelOption, PermissionModeName } from "../../../broker/src/protocol.ts";
import { MODE_HINT, MODE_LABEL, baseName, effortLabel, findModel, modelLabel } from "../labels.ts";
import { Switch } from "../screens/settings/common.tsx";
import { usePrefs } from "../prefs.ts";
import { toast, useApp } from "../state.ts";
import { isDialogCommand, parseCommand } from "../../../broker/src/dialog-commands.ts";
import { bareCommandSheet } from "./commandSheets.ts";
import { AttachmentChips } from "./composer/AttachmentChips.tsx";
import { DOCUMENT_ACCEPT, IMAGE_ACCEPT, MAX_MESSAGE_BYTES, addFiles, clearAttachments, useAttachments } from "./composer/attachments.ts";
import { Suggestions, type SuggestRow } from "./composer/Suggestions.tsx";
import { commandQuery, mentionAt, mentionText, rankCommands, useCommands, useFileSuggestions } from "./composer/suggest.ts";
import { Choice, Icon, Sheet } from "./ui.tsx";

const MODES: PermissionModeName[] = ["default", "acceptEdits", "plan", "auto"];
const EFFORTS: EffortName[] = ["low", "medium", "high", "xhigh", "max"];
const MAX_INPUT_PX = 168;
const MAX_COMMAND_ROWS = 50;
const DRAFT_KEY = "ccrc.draft.";

// Each composerInsert request is applied once, by the composer that is mounted when it arrives.
let appliedInsert = 0;

function loadDraft(sessionId?: string): string {
  if (!sessionId) return "";
  try {
    return sessionStorage.getItem(DRAFT_KEY + sessionId) ?? "";
  } catch {
    return "";
  }
}

function saveDraft(sessionId: string | undefined, text: string): void {
  if (!sessionId) return;
  try {
    if (text) sessionStorage.setItem(DRAFT_KEY + sessionId, text);
    else sessionStorage.removeItem(DRAFT_KEY + sessionId);
  } catch {}
}

// A direct tap on the file input itself, so iOS opens its picker for this row.
function AttachOption({ icon, label, onFiles, ...input }: { icon: React.ReactNode; label: string; onFiles: (files: File[]) => void } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="relative flex w-full cursor-pointer items-center gap-3 overflow-hidden rounded-xl px-3 py-3 text-[15px] hover:bg-surface-2">
      <span className="text-muted">{icon}</span>
      {label}
      <input
        type="file"
        aria-label={label}
        {...input}
        onChange={(e) => {
          const picked = [...(e.target.files ?? [])];
          e.target.value = "";
          if (picked.length) onFiles(picked);
        }}
        className="absolute inset-0 size-full cursor-pointer opacity-0"
      />
    </label>
  );
}

function Chip({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex shrink-0 items-center gap-0.5 rounded-lg px-2 py-1 text-[13px] text-muted hover:bg-surface-2 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

interface Props {
  // Absent on the new-session screen, which has no attachments, "@" files or "/" commands.
  sessionId?: string;
  state?: LiveState;
  models: ModelOption[];
  controllable: boolean;
  disabledReason?: string;
  placeholder: string;
  // attachments: upload ids, in the order they were added. Returns whether the message went out.
  onSend: (text: string, attachments: string[]) => boolean;
  onStop: () => void;
  onMode: (mode: PermissionModeName) => void;
  onModel: (model: string) => void;
  onEffort: (effort: EffortName) => void;
  onUltracode: (on: boolean) => void;
  // A bare "/" command, picked from the list or sent, that opens a screen here instead; true when it did.
  onCommand?: (name: string) => boolean;
  // Opens the model or effort sheet when `at` changes.
  openSheet?: { name: "model" | "effort"; at: number };
}

export function Composer({ sessionId, state, models, controllable, disabledReason, placeholder, onSend, onStop, onMode, onModel, onEffort, onUltracode, onCommand, openSheet }: Props) {
  const [text, setText] = useState(() => loadDraft(sessionId));
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [sheet, setSheet] = useState<"mode" | "model" | "effort" | "attach" | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const nextCaret = useRef<number | null>(null);
  const { enterToSend } = usePrefs();
  const insert = useApp((s) => s.insert);
  const attachments = useAttachments(sessionId);
  const busy = Boolean(state?.busy);
  const current = findModel(models, state?.model);
  const efforts = current?.efforts?.length ? current.efforts : EFFORTS;
  const hasEffort = !current || Boolean(current.efforts?.length) || Boolean(state?.effort);
  const uploading = attachments.some((a) => !a.uploaded);
  const canSend = !uploading && (text.trim() !== "" || attachments.length > 0);

  const mention = sessionId && !dismissed ? mentionAt(text, caret) : undefined;
  const command = sessionId && !dismissed && !mention ? commandQuery(text) : undefined;
  const files = useFileSuggestions(sessionId, mention?.query);
  const commands = useCommands(sessionId, command !== undefined);
  const rows: SuggestRow[] =
    mention && files
      ? files.map((f) => ({ key: f, label: baseName(f), hint: f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : undefined }))
      : command !== undefined && commands
        ? rankCommands(commands, command)
            .slice(0, MAX_COMMAND_ROWS)
            .map((c) => ({ key: c.name, label: `/${c.name}`, hint: c.argumentHint, detail: c.description }))
        : [];
  const shown = rows.length > 0;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_PX)}px`;
    if (nextCaret.current !== null) {
      el.setSelectionRange(nextCaret.current, nextCaret.current);
      nextCaret.current = null;
    }
  }, [text]);

  useEffect(() => saveDraft(sessionId, text), [sessionId, text]);

  useEffect(() => setActive(0), [mention?.query, command, rows.length]);

  const edit = (next: string, at: number) => {
    setText(next);
    setCaret(at);
    setDismissed(false);
    nextCaret.current = at;
    ref.current?.focus();
  };

  useEffect(() => {
    if (!insert || insert.at <= appliedInsert) return;
    appliedInsert = insert.at;
    const next = text && !/\s$/.test(text) ? `${text}\n${insert.text}` : text + insert.text;
    edit(next, next.length);
  }, [insert]);

  // A sheet opened from the list takes the screen, so the keyboard goes down with the text.
  const opened = () => {
    setText("");
    setDismissed(false);
    ref.current?.blur();
  };

  useEffect(() => {
    if (!openSheet || !controllable) return;
    ref.current?.blur();
    setSheet(openSheet.name);
  }, [openSheet?.at]);

  const pick = (i: number) => {
    const row = rows[i];
    if (!row) return;
    if (mention) {
      const added = `${mentionText(row.key)} `;
      edit(text.slice(0, mention.start) + added + text.slice(mention.end), mention.start + added.length);
    } else if (onCommand?.(row.key)) {
      opened();
    } else {
      edit(`/${row.key} `, row.key.length + 2);
    }
  };

  const submit = () => {
    if (!canSend || disabledReason) return;
    const bare = attachments.length ? undefined : bareCommandSheet(text);
    if (bare && onCommand?.(bare)) return opened();
    const total = attachments.reduce((n, a) => n + (a.uploaded?.size ?? 0), 0);
    if (total > MAX_MESSAGE_BYTES) return toast("attachments too large");
    if (!onSend(text.trim(), attachments.map((a) => a.uploaded!.id))) return toast("not connected");
    if (!attachments.length && isDialogCommand(parseCommand(text)?.name)) ref.current?.blur();
    setText("");
    setDismissed(false);
    if (sessionId) clearAttachments(sessionId);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = e.nativeEvent.isComposing || e.keyCode === 229;
    if (shown && !composing) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
        e.preventDefault();
        pick(active);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (e.key !== "Enter" || composing) return;
    if (enterToSend ? !e.shiftKey : e.metaKey || e.ctrlKey) {
      e.preventDefault();
      submit();
    }
  };

  if (disabledReason) {
    return <div className="pb-safe border-t border-line bg-bg px-4 pt-3 text-center text-sm text-muted">{disabledReason}</div>;
  }

  return (
    <div className="pb-safe relative border-t border-line bg-bg px-3 pt-2">
      {shown && <Suggestions rows={rows} active={active} onPick={pick} />}
      <div className="rounded-2xl border border-line bg-surface px-3 pt-2.5 pb-1.5 focus-within:border-accent">
        {sessionId && <AttachmentChips sessionId={sessionId} items={attachments} />}
        <textarea
          ref={ref}
          value={text}
          rows={1}
          enterKeyHint={enterToSend ? "send" : "enter"}
          placeholder={busy ? "대기열에 추가할 메시지…" : placeholder}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
            setDismissed(false);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          className="block max-h-42 w-full resize-none bg-transparent text-[16px] leading-relaxed outline-none placeholder:text-muted"
        />
        <div className="mt-1 flex items-center gap-1">
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
            {sessionId && (
              // The keyboard goes down first, so the sheet and any picker menu open on a page that stays put.
              <button
                aria-label="파일 첨부"
                onClick={() => {
                  ref.current?.blur();
                  setSheet("attach");
                }}
                className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2"
              >
                <Icon.paperclip className="size-[18px]" />
              </button>
            )}
            <Chip disabled={!controllable} onClick={() => setSheet("model")}>
              {modelLabel(models, state?.model)}
              <Icon.chevronDown className="size-3.5" />
            </Chip>
            <Chip disabled={!controllable} onClick={() => setSheet("mode")}>
              {MODE_LABEL[state?.permissionMode ?? ""] ?? "권한 모드"}
              <Icon.chevronDown className="size-3.5" />
            </Chip>
            {hasEffort && (
              <Chip disabled={!controllable} onClick={() => setSheet("effort")}>
                {state?.effort || controllable ? `Effort ${effortLabel(state?.effort)}` : "Effort"}
                {state?.ultracode && <span className="ml-1 rounded bg-accent-soft px-1 text-[11px] font-medium text-accent">Ultracode</span>}
                <Icon.chevronDown className="size-3.5" />
              </Chip>
            )}
            {state?.contextPercent !== undefined && <span className="shrink-0 px-1 text-[12px] text-muted">context {state.contextPercent}%</span>}
          </div>
          {busy && (
            <button onClick={onStop} aria-label="중지" className="flex size-9 items-center justify-center rounded-full bg-surface-2 text-fg">
              <Icon.stop />
            </button>
          )}
          <button
            onClick={submit}
            disabled={!canSend}
            aria-label="보내기"
            className="flex size-9 items-center justify-center rounded-full bg-accent text-white disabled:opacity-30"
          >
            <Icon.send className="size-5" />
          </button>
        </div>
      </div>

      {sheet === "attach" && sessionId && (
        <Sheet title="첨부" onClose={() => setSheet(null)}>
          {[
            { key: "photos", icon: <Icon.image />, label: "사진 보관함", accept: IMAGE_ACCEPT, multiple: true },
            { key: "camera", icon: <Icon.camera />, label: "카메라", accept: IMAGE_ACCEPT, capture: "environment" as const },
            { key: "files", icon: <Icon.file />, label: "파일", accept: DOCUMENT_ACCEPT, multiple: true },
          ].map(({ key, ...o }) => (
            <AttachOption
              key={key}
              data-attach={key}
              {...o}
              onFiles={(files) => {
                addFiles(sessionId, files);
                setSheet(null);
              }}
            />
          ))}
        </Sheet>
      )}
      {sheet === "mode" && (
        <Sheet title="권한 모드" onClose={() => setSheet(null)}>
          {MODES.map((m) => (
            <Choice key={m} label={MODE_LABEL[m]} hint={MODE_HINT[m]} selected={state?.permissionMode === m} onClick={() => (onMode(m), setSheet(null))} />
          ))}
        </Sheet>
      )}
      {sheet === "model" && (
        <Sheet title="모델" onClose={() => setSheet(null)}>
          {models.length === 0 && <div className="px-3 py-2 text-sm text-muted">모델 목록을 불러오는 중입니다</div>}
          {models.map((m) => (
            <Choice key={m.value} label={m.label} hint={m.description} selected={m === current} onClick={() => (onModel(m.value), setSheet(null))} />
          ))}
        </Sheet>
      )}
      {sheet === "effort" && (
        <Sheet title="Effort" onClose={() => setSheet(null)}>
          {efforts.map((e) => (
            <Choice key={e} label={effortLabel(e)} selected={state?.effort === e} onClick={() => (onEffort(e), setSheet(null))} />
          ))}
          {state?.ultracodeAvailable && (
            <button
              role="switch"
              aria-checked={state.ultracode === true}
              onClick={() => onUltracode(!state.ultracode)}
              className="mt-2 flex w-full items-center justify-between gap-3 rounded-xl border-t border-line px-3 py-2.5 text-left hover:bg-surface-2"
            >
              <span>
                <span className="block text-[15px]">Ultracode</span>
                <span className="block text-xs text-muted">모든 작업에 동적 워크플로를 씁니다 (이번 세션만)</span>
              </span>
              <Switch on={state.ultracode === true} />
            </button>
          )}
          {state?.appliedUnknown && (
            <div className="mt-2 border-t border-line px-3 pt-2.5 text-xs text-muted">VS Code가 Claude Code를 다시 시작하면 Ultracode와 지금 값이 보입니다.</div>
          )}
        </Sheet>
      )}
    </div>
  );
}
