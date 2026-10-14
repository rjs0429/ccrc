import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EffortName, LiveState, ModelOption, PermissionModeName } from "../../../broker/src/protocol.ts";
import { MODE_HINT, MODE_LABEL, baseName, effortLabel, effortLevels, findModel, modelLabel } from "../labels.ts";
import { Switch } from "../screens/settings/common.tsx";
import { usePrefs } from "../prefs.ts";
import { rememberSent } from "../sentPreviews.ts";
import { toast, useApp } from "../state.ts";
import { isDialogCommand, parseCommand } from "../../../broker/src/dialog-commands.ts";
import { bareCommandSheet } from "./commandSheets.ts";
import { ContextRing } from "./ContextRing.tsx";
import { AgentChip } from "./agents/AgentChip.tsx";
import type { AgentMap } from "./agents/tree.ts";
import { AttachmentChips } from "./composer/AttachmentChips.tsx";
import { ATTACH_ACCEPT, MAX_MESSAGE_BYTES, addFiles, takeAttachments, useAttachments } from "./composer/attachments.ts";
import { afterKeyboard } from "./composer/picker.ts";
import { Suggestions, type SuggestRow } from "./composer/Suggestions.tsx";
import { commandQuery, mentionAt, mentionText, rankCommands, useCommands, useFileSuggestions } from "./composer/suggest.ts";
import { Choice, Icon, Sheet } from "./ui.tsx";

const MODES: PermissionModeName[] = ["default", "acceptEdits", "plan", "auto"];
const MAX_INPUT_PX = 168;
const MAX_COMMAND_ROWS = 50;
const DRAFT_KEY = "ccrc.draft.";
const START_HINT = "여기서 이 세션을 시작할 때 적용합니다. VS Code에서 열면 적용되지 않습니다.";

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

function StartHint() {
  return <div className="mb-2 px-3 text-xs text-muted">{START_HINT}</div>;
}

function Chip({
  name,
  children,
  onClick,
  disabled,
  className = "shrink-0",
}: {
  name: string;
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      data-chip={name}
      className={`flex min-h-8 items-center gap-0.5 rounded-lg px-1.5 py-1 text-[13px] text-muted hover:bg-surface-2 disabled:opacity-50 ${className}`}
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
  // A session without a process: the chips choose what it starts with here (state.start).
  deferred?: boolean;
  // The session is being started here; its chips wait until it runs.
  starting?: boolean;
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
  // The context ring next to the model chip; absent where there is no session.
  onContext?: () => void;
  // The agent chip between the chip groups, while subagents or workflows are listed.
  agents?: AgentMap["chip"];
  onAgents?: () => void;
}

export function Composer({
  sessionId,
  state,
  models,
  controllable,
  deferred = false,
  starting = false,
  disabledReason,
  placeholder,
  onSend,
  onStop,
  onMode,
  onModel,
  onEffort,
  onUltracode,
  onCommand,
  openSheet,
  onContext,
  agents,
  onAgents,
}: Props) {
  const [text, setText] = useState(() => loadDraft(sessionId));
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [sheet, setSheet] = useState<"mode" | "model" | "effort" | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const picking = useRef(false);
  const nextCaret = useRef<number | null>(null);
  const { enterToSend } = usePrefs();
  const insert = useApp((s) => s.insert);
  const attachments = useAttachments(sessionId);
  const busy = Boolean(state?.busy);
  const choosable = (controllable || deferred) && !starting;
  const start = deferred ? state?.start : undefined;
  const model = deferred ? start?.model : state?.model;
  const mode = deferred ? start?.mode : state?.permissionMode;
  const effort = deferred ? start?.effort : state?.effort;
  const ultracode = deferred ? start?.ultracode === true : state?.ultracode === true;
  const current = findModel(models, model);
  const efforts = effortLevels(models, model, effort);
  const chosen = Boolean(start && (start.model || start.mode || start.effort || start.ultracode));
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
    if (!openSheet || !choosable) return;
    ref.current?.blur();
    setSheet(openSheet.name);
  }, [openSheet?.at]);

  // With the keyboard up, the picker opens once it has gone down, so iOS anchors its menu to where the
  // paperclip settles; otherwise it opens within the tap.
  const attach = () => {
    const input = fileRef.current;
    if (!input || picking.current) return;
    const keyboard = document.documentElement.hasAttribute("data-keyboard");
    ref.current?.blur();
    if (!keyboard) return input.click();
    picking.current = true;
    afterKeyboard(() => {
      picking.current = false;
      input.click();
    });
  };

  const openAgents = () => {
    if (!onAgents) return;
    const keyboard = document.documentElement.hasAttribute("data-keyboard");
    ref.current?.blur();
    if (keyboard) afterKeyboard(onAgents);
    else onAgents();
  };

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
    if (sessionId) rememberSent(sessionId, text.trim(), takeAttachments(sessionId));
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
    return <div className="pb-safe border-t border-line bg-bg px-safe-4 pt-3 text-center text-sm text-muted short:pt-2">{disabledReason}</div>;
  }

  return (
    <div className="pb-safe border-t border-line bg-bg px-safe-3 pt-2 short:pt-1">
      <div className="relative mx-auto max-w-3xl">
        {shown && <Suggestions rows={rows} active={active} onPick={pick} />}
        <div className="rounded-2xl border border-line bg-surface px-3 pt-2.5 pb-1.5 focus-within:border-accent short:pt-1.5 short:pb-1">
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
            className="block max-h-42 w-full resize-none bg-transparent text-[16px] leading-relaxed outline-none placeholder:text-muted short:max-h-20 short:leading-snug"
          />
          {chosen && (
            <div className="mt-1 text-[11px] text-muted" data-start-hint>
              고른 값은 여기서 시작할 때 적용됩니다
            </div>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-0.5 short:mt-0.5 sm:flex-nowrap" data-chip-rows>
            <div className="flex min-w-0 basis-full items-center sm:flex-1 sm:basis-auto" data-chip-group="left">
              {sessionId && (
                <span className="relative shrink-0">
                  <button
                    aria-label="파일 첨부"
                    onClick={attach}
                    className="flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2"
                  >
                    <Icon.paperclip className="size-[18px]" />
                  </button>
                  <input
                    ref={fileRef}
                    type="file"
                    multiple
                    accept={ATTACH_ACCEPT}
                    tabIndex={-1}
                    aria-hidden
                    onChange={(e) => {
                      const picked = [...(e.target.files ?? [])];
                      e.target.value = "";
                      if (picked.length) addFiles(sessionId, picked);
                    }}
                    className="pointer-events-none absolute inset-0 size-full opacity-0"
                  />
                </span>
              )}
              <Chip name="model" className="min-w-0" disabled={!choosable} onClick={() => setSheet("model")}>
                <span className="truncate">{modelLabel(models, model)}</span>
                <Icon.chevronDown className="size-3 shrink-0" />
              </Chip>
              {efforts && (
                <Chip name="effort" disabled={!choosable} onClick={() => setSheet("effort")}>
                  {effort || controllable ? `Effort ${effortLabel(effort)}` : "Effort"}
                  {ultracode && <span className="ml-0.5 rounded bg-accent-soft px-1 text-[11px] font-medium text-accent">Ultracode</span>}
                  <Icon.chevronDown className="size-3" />
                </Chip>
              )}
            </div>
            {agents && onAgents && <AgentChip chip={agents} onClick={openAgents} />}
            <div className="ml-auto flex shrink-0 items-center gap-0.5" data-chip-group="right">
              <Chip name="mode" disabled={!choosable} onClick={() => setSheet("mode")}>
                {MODE_LABEL[mode ?? ""] ?? "권한 모드"}
                <Icon.chevronDown className="size-3" />
              </Chip>
              {onContext && <ContextRing gauge={state?.context} onClick={onContext} />}
              {busy && (
                <button onClick={onStop} aria-label="중지" className="flex size-11 shrink-0 items-center justify-center rounded-full bg-surface-2 text-fg">
                  <Icon.stop />
                </button>
              )}
              <button
                onClick={submit}
                disabled={!canSend}
                aria-label="보내기"
                className="flex size-11 shrink-0 items-center justify-center rounded-full bg-accent text-white disabled:opacity-30"
              >
                <Icon.send className="size-5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {sheet === "mode" && (
        <Sheet title="권한 모드" onClose={() => setSheet(null)}>
          {deferred && <StartHint />}
          {MODES.map((m) => (
            <Choice key={m} label={MODE_LABEL[m]} hint={MODE_HINT[m]} selected={mode === m} onClick={() => (onMode(m), setSheet(null))} />
          ))}
        </Sheet>
      )}
      {sheet === "model" && (
        <Sheet title="모델" onClose={() => setSheet(null)}>
          {deferred && <StartHint />}
          {models.length === 0 && <div className="px-3 py-2 text-sm text-muted">모델 목록을 불러오는 중입니다</div>}
          {models.map((m) => (
            <Choice key={m.value} label={m.label} hint={m.description} selected={m === current} onClick={() => (onModel(m.value), setSheet(null))} />
          ))}
        </Sheet>
      )}
      {sheet === "effort" && (
        <Sheet title="Effort" onClose={() => setSheet(null)}>
          {deferred && <StartHint />}
          {!efforts && <div className="px-3 py-2 text-sm text-muted">이 모델은 Effort를 고를 수 없습니다</div>}
          {(efforts ?? []).map((e) => (
            <Choice key={e} label={effortLabel(e)} selected={effort === e} onClick={() => (onEffort(e), setSheet(null))} />
          ))}
          {(deferred || state?.ultracodeAvailable) && (
            <button
              role="switch"
              aria-checked={ultracode}
              onClick={() => onUltracode(!ultracode)}
              className="mt-2 flex w-full items-center justify-between gap-3 rounded-xl border-t border-line px-3 py-2.5 text-left hover:bg-surface-2"
            >
              <span>
                <span className="block text-[15px]">Ultracode</span>
                <span className="block text-xs text-muted">
                  {deferred ? "모델이 지원하면 시작할 때 켭니다 (이번 세션만)" : "모든 작업에 동적 워크플로를 씁니다 (이번 세션만)"}
                </span>
              </span>
              <Switch on={ultracode} />
            </button>
          )}
          {!deferred && state?.appliedUnknown && (
            <div className="mt-2 border-t border-line px-3 pt-2.5 text-xs text-muted">VS Code가 Claude Code를 다시 시작하면 Ultracode와 지금 값이 보입니다.</div>
          )}
        </Sheet>
      )}
    </div>
  );
}
