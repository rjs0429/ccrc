import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { EffortName, LiveState, ModelOption, PermissionModeName, StartSettings } from "../../../broker/src/protocol.ts";
import { MODE_HINT, MODE_LABEL, baseName, effortLabel, effortLevels, findModel, modelLabel } from "../labels.ts";
import { Switch } from "../screens/settings/common.tsx";
import { usePrefs } from "../prefs.ts";
import { rememberSent } from "../sentPreviews.ts";
import { toast, useApp } from "../state.ts";
import { isDialogCommand, parseCommand } from "../../../broker/src/dialog-commands.ts";
import { bareCommandSheet } from "./commandSheets.ts";
import { ContextRing } from "./ContextRing.tsx";
import { AgentChip, agentChipWidths } from "./agents/AgentChip.tsx";
import type { AgentMap } from "./agents/tree.ts";
import { AttachmentChips } from "./composer/AttachmentChips.tsx";
import { ATTACH_ACCEPT, MAX_MESSAGE_BYTES, NEW_SESSION_SCOPE, addFiles, takeAttachments, useAttachments } from "./composer/attachments.ts";
import { chipLayout, sameLayout, type ChipLayout } from "./composer/chipLayout.ts";
import { afterKeyboard } from "./composer/picker.ts";
import { Suggestions, type SuggestRow } from "./composer/Suggestions.tsx";
import { commandQuery, mentionAt, mentionText, rankCommands, useCommands, useFileSuggestions, type SuggestTarget } from "./composer/suggest.ts";
import { Choice, Icon, Sheet, Spinner } from "./ui.tsx";

const MODES: PermissionModeName[] = ["default", "acceptEdits", "plan", "auto"];
const MAX_INPUT_PX = 168;
const MAX_COMMAND_ROWS = 50;
const DRAFT_KEY = "ccrc.draft.";
const START_HINT = "여기서 이 세션을 시작할 때 적용합니다. VS Code에서 열면 적용되지 않습니다.";
const DRAFT_HINT = "새 세션을 시작할 때 적용합니다.";
// Commands that mean nothing before a session exists.
const DRAFT_HIDDEN = new Set(["clear", "compact", "rename", "recap", "heapdump"]);
// The round buttons sit on the last chip line. Their tap target grows to 44px across and mostly downward, into
// the composer's bottom padding, so it covers no other control.
const ROUND_TAP = "relative after:absolute after:-inset-x-1.5 after:-top-0.5 after:-bottom-2.5";
// The stop button's width with its margins (size-8 mx-1.5), as wide as the room kept for it (w-11).
const STOP_PX = 44;

// Each composerInsert request is applied once, by the composer that is mounted when it arrives.
let appliedInsert = 0;

function loadDraft(scope?: string): string {
  if (!scope) return "";
  try {
    return sessionStorage.getItem(DRAFT_KEY + scope) ?? "";
  } catch {
    return "";
  }
}

export function saveDraft(scope: string | undefined, text: string): void {
  if (!scope) return;
  try {
    if (text) sessionStorage.setItem(DRAFT_KEY + scope, text);
    else sessionStorage.removeItem(DRAFT_KEY + scope);
  } catch {}
}

function StartHint({ draft }: { draft: boolean }) {
  return <div className="mb-2 px-3 text-xs text-muted">{draft ? DRAFT_HINT : START_HINT}</div>;
}

function Chip({
  name,
  label,
  children,
  onClick,
  disabled,
  className = "shrink-0",
}: {
  name: string;
  label?: string;
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
      aria-label={label}
      className={`flex min-h-8 items-center gap-0.5 rounded-lg px-1.5 py-1 text-[13px] text-muted hover:bg-surface-2 disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  );
}

// A chip group's width with its cut name in full: from its first part to its last, plus what the name hides.
function groupWidth(group: HTMLElement, name: HTMLElement | null): number {
  const parts = [...group.children].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0);
  if (!parts.length) return 0;
  const span = Math.max(...parts.map((r) => r.right)) - Math.min(...parts.map((r) => r.left));
  return span + (name ? name.scrollWidth - name.clientWidth : 0);
}

interface Props {
  sessionId?: string;
  // The new-session screen: the folder the session starts in and what it starts with, chosen through the chips.
  // The message stays here until the session has started.
  draft?: { cwd?: string; start: StartSettings };
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
  // Back to what Claude Code starts with when nothing is chosen; offered in a draft's sheets.
  onReset?: (key: "model" | "mode" | "effort") => void;
  // A bare "/" command, picked from the list or sent, that opens a screen here instead; true when it did. A draft
  // also passes a command with its arguments; "kept" leaves the message as it is, unsent.
  onCommand?: (name: string, args?: string) => boolean | "kept";
  // Opens the model or effort sheet when `at` changes.
  openSheet?: { name: "model" | "effort"; at: number };
  // The context ring next to the model chip; absent where there is no session.
  onContext?: () => void;
  // The agent chip, while the conversation has subagents or workflows.
  agents?: AgentMap["chip"];
  onAgents?: () => void;
}

export function Composer({
  sessionId,
  draft,
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
  onReset,
  onCommand,
  openSheet,
  onContext,
  agents,
  onAgents,
}: Props) {
  const scope = sessionId ?? (draft ? NEW_SESSION_SCOPE : undefined);
  const [text, setText] = useState(() => loadDraft(scope));
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
  const attachments = useAttachments(scope);
  const busy = Boolean(state?.busy);
  const choosing = deferred || Boolean(draft);
  const choosable = (controllable || choosing) && !starting;
  const start = draft ? draft.start : deferred ? state?.start : undefined;
  const model = choosing ? start?.model : state?.model;
  const mode = choosing ? start?.mode : state?.permissionMode;
  const effort = choosing ? start?.effort : state?.effort;
  const ultracode = choosing ? start?.ultracode === true : state?.ultracode === true;
  const current = findModel(models, model);
  // A draft without a model starts with the default one.
  const starts = model ?? (draft ? "default" : undefined);
  const efforts = effortLevels(models, starts, effort);
  const chosen = !draft && Boolean(start && (start.model || start.mode || start.effort || start.ultracode));
  // Whether the model offered Ultracode in an earlier session.
  const offered = findModel(models, starts)?.ultracode;
  const ultracodeShown = draft ? offered === true || ultracode : deferred ? offered !== false || ultracode : state?.ultracodeAvailable === true;
  const uploading = attachments.some((a) => !a.uploaded);
  // While a new session starts, its first message stays as it was sent.
  const locked = Boolean(draft && starting);
  const canSend = !uploading && !locked && (text.trim() !== "" || attachments.length > 0);

  const draftCwd = draft?.cwd;
  const target = useMemo<SuggestTarget | undefined>(() => (sessionId ? { sessionId } : draftCwd ? { cwd: draftCwd } : undefined), [sessionId, draftCwd]);
  const mention = target && !dismissed ? mentionAt(text, caret) : undefined;
  const command = target && !dismissed && !mention ? commandQuery(text) : undefined;
  const files = useFileSuggestions(target, mention?.query);
  const listed = useCommands(target, command !== undefined);
  const commands = draft ? listed?.filter((c) => !DRAFT_HIDDEN.has(c.name)) : listed;
  const rows: SuggestRow[] =
    mention && files
      ? files.map((f) => ({ key: f, label: baseName(f), hint: f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : undefined }))
      : command !== undefined && commands
        ? rankCommands(commands, command)
            .slice(0, MAX_COMMAND_ROWS)
            .map((c) => ({ key: c.name, label: `/${c.name}`, hint: c.argumentHint, detail: c.description }))
        : [];
  const shown = rows.length > 0 && !locked;
  const effortName = [effort ? `Effort ${effortLabel(effort)}` : "Effort", ultracode ? "Ultracode 켜짐" : ""].filter(Boolean).join(", ");

  const [layout, setLayout] = useState<ChipLayout>({ lines: "two", agent: "above", word: true });
  const barRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLSpanElement>(null);
  const modeRef = useRef<HTMLSpanElement>(null);
  const agentRef = useRef<HTMLButtonElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const roomRef = useRef<HTMLSpanElement>(null);
  // The chip lines follow from the chips' widths with every name in full, measured after each render before it
  // paints, and again when the composer's width changes or fonts load. The right group counts the stop button while
  // it is hidden: by the room kept for it or, on the wide line, by its width.
  const measure = (): ChipLayout | undefined => {
    const [bar, rows, left, right] = [barRef.current, rowsRef.current, leftRef.current, rightRef.current];
    if (!bar || !rows || !left || !right) return undefined;
    return chipLayout({
      composer: bar.getBoundingClientRect().width,
      row: rows.getBoundingClientRect().width,
      gap: parseFloat(getComputedStyle(left.parentElement!).columnGap) || 0,
      left: groupWidth(left, modelRef.current),
      right: groupWidth(right, modeRef.current) + (draft || stopRef.current || roomRef.current ? 0 : STOP_PX),
      agent: agentRef.current ? agentChipWidths(agentRef.current) : undefined,
    });
  };
  useLayoutEffect(() => {
    const next = measure();
    if (next && !sameLayout(next, layout)) setLayout(next);
  });
  const hasRows = !disabledReason;
  // The textarea spans the chip rows and its height never follows them, so watching it sees each width change
  // and never the layout chosen here.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const next = measure();
      if (next) flushSync(() => setLayout((was) => (sameLayout(was, next) ? was : next)));
    };
    const resized = new ResizeObserver(update);
    resized.observe(el);
    document.fonts.addEventListener("loadingdone", update);
    void document.fonts.ready.then(update);
    return () => {
      resized.disconnect();
      document.fonts.removeEventListener("loadingdone", update);
    };
  }, [hasRows]);

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

  useEffect(() => saveDraft(scope, text), [scope, text]);

  // An "@" path typed for one folder may not be there in another.
  const shownCwd = useRef(draftCwd);
  useEffect(() => {
    const was = shownCwd.current;
    shownCwd.current = draftCwd;
    if (was && was !== draftCwd && /(^|\s)@\S/.test(text)) toast("입력한 @ 파일은 새 폴더 기준으로 다시 확인하세요");
  }, [draftCwd]);

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
    if (!input || picking.current || locked) return;
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
    } else if (onCommand?.(row.key) === true) {
      opened();
    } else {
      edit(`/${row.key} `, row.key.length + 2);
    }
  };

  const submit = () => {
    if (!canSend || disabledReason) return;
    const c = attachments.length ? undefined : parseCommand(text);
    const bare = attachments.length ? undefined : bareCommandSheet(text);
    const taken = draft && c ? onCommand?.(c.name, c.args || undefined) : bare ? onCommand?.(bare) : false;
    if (taken === "kept") return;
    if (taken) return opened();
    const total = attachments.reduce((n, a) => n + (a.uploaded?.size ?? 0), 0);
    if (total > MAX_MESSAGE_BYTES) return toast("attachments too large");
    if (!onSend(text.trim(), attachments.map((a) => a.uploaded!.id))) return toast("not connected");
    if (draft) return ref.current?.blur();
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

  const agentChip = agents && onAgents && <AgentChip ref={agentRef} chip={agents} word={layout.word} onClick={openAgents} />;
  const two = layout.lines === "two";
  // Sharing a line with the right group, the left group never shrinks: a longer name is measured in full and takes
  // the chips to two lines instead of being cut.
  const leftFit = two ? "basis-full" : layout.lines === "wide" ? "flex-1" : "shrink-0";
  // The stop button's room, kept while it is hidden so a turn starting or ending leaves the chips on their lines. The
  // wide line never wraps and keeps none, so the agent chip stays beside the right group.
  const stopRoom = !busy && !draft && layout.lines !== "wide";

  return (
    <div ref={barRef} className="pb-safe border-t border-line bg-bg px-safe-3 pt-2 short:pt-1">
      <div className="relative mx-auto max-w-3xl">
        {shown && <Suggestions rows={rows} active={active} onPick={pick} />}
        <div className="rounded-2xl border border-line bg-surface px-3 pt-2.5 pb-1.5 focus-within:border-accent short:pt-1.5 short:pb-1">
          {scope && <AttachmentChips scope={scope} items={attachments} locked={locked} />}
          <textarea
            ref={ref}
            value={text}
            rows={1}
            readOnly={locked}
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
          <div ref={rowsRef} className="mt-1 short:mt-0.5" data-chip-rows={layout.lines}>
            {agentChip && layout.agent === "above" && <div className="mb-1 flex short:mb-0.5">{agentChip}</div>}
            <div className={`flex items-center gap-x-1 gap-y-1 short:gap-y-0.5 ${two ? "flex-wrap" : ""}`}>
              <div ref={leftRef} className={`flex min-w-0 items-center ${leftFit}`} data-chip-group="left">
                {scope && (
                  <span className="relative shrink-0">
                    <button
                      aria-label="파일 첨부"
                      onClick={attach}
                      disabled={locked}
                      className="flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 disabled:opacity-50"
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
                      disabled={locked}
                      onChange={(e) => {
                        const picked = [...(e.target.files ?? [])];
                        e.target.value = "";
                        if (picked.length) addFiles(scope, picked);
                      }}
                      className="pointer-events-none absolute inset-0 size-full opacity-0"
                    />
                  </span>
                )}
                <Chip name="model" className="min-w-0" disabled={!choosable} onClick={() => setSheet("model")}>
                  <span ref={modelRef} className="truncate">{modelLabel(models, model)}</span>
                  <Icon.chevronDown className="size-3 shrink-0" />
                </Chip>
                {efforts && (
                  <Chip name="effort" label={effortName} disabled={!choosable} onClick={() => setSheet("effort")}>
                    {effort ? effortLabel(effort) : "Effort"}
                    {ultracode && <span className="ml-0.5 rounded bg-accent-soft px-1 text-[11px] font-medium text-accent">Ultracode</span>}
                    <Icon.chevronDown className="size-3" />
                  </Chip>
                )}
              </div>
              {agentChip && layout.agent === "inline" && agentChip}
              <div ref={rightRef} className="ml-auto flex max-w-full shrink-0 items-center" data-chip-group="right">
                {stopRoom && <span ref={roomRef} className="w-11 shrink-0" aria-hidden />}
                <Chip name="mode" className="min-w-0" disabled={!choosable} onClick={() => setSheet("mode")}>
                  <span ref={modeRef} className="truncate">{MODE_LABEL[mode ?? ""] ?? "권한 모드"}</span>
                  <Icon.chevronDown className="size-3 shrink-0" />
                </Chip>
                {onContext && <ContextRing gauge={state?.context} onClick={onContext} className="ml-0.5" />}
                {busy && (
                  <button ref={stopRef} onClick={onStop} aria-label="중지" className={`mx-1.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-fg ${ROUND_TAP}`}>
                    <Icon.stop className="size-5" />
                  </button>
                )}
                <button
                  onClick={submit}
                  disabled={!canSend}
                  aria-label={locked ? "시작하는 중" : draft ? "시작" : "보내기"}
                  data-starting={locked || undefined}
                  className={`ml-1.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-white ${ROUND_TAP} ${locked ? "" : "disabled:opacity-30"}`}
                >
                  {locked ? <Spinner className="size-4" /> : <Icon.send className="size-4 [stroke-width:2.5]" />}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {sheet === "mode" && (
        <Sheet title="권한 모드" onClose={() => setSheet(null)}>
          {choosing && <StartHint draft={Boolean(draft)} />}
          {onReset && <Choice label="기본값" hint="Claude Code 설정을 따릅니다" selected={!mode} onClick={() => (onReset("mode"), setSheet(null))} />}
          {MODES.map((m) => (
            <Choice key={m} label={MODE_LABEL[m]} hint={MODE_HINT[m]} selected={mode === m} onClick={() => (onMode(m), setSheet(null))} />
          ))}
        </Sheet>
      )}
      {sheet === "model" && (
        <Sheet title="모델" onClose={() => setSheet(null)}>
          {choosing && <StartHint draft={Boolean(draft)} />}
          {models.length === 0 && <div className="px-3 py-2 text-sm text-muted">모델 목록을 불러오는 중입니다</div>}
          {onReset && <Choice label="기본값" hint="Claude Code 설정을 따릅니다" selected={!model} onClick={() => (onReset("model"), setSheet(null))} />}
          {models.map((m) => (
            <Choice key={m.value} label={m.label} hint={m.description} selected={m === current} onClick={() => (onModel(m.value), setSheet(null))} />
          ))}
        </Sheet>
      )}
      {sheet === "effort" && (
        <Sheet title="Effort" onClose={() => setSheet(null)}>
          {choosing && <StartHint draft={Boolean(draft)} />}
          {!efforts && <div className="px-3 py-2 text-sm text-muted">이 모델은 Effort를 고를 수 없습니다</div>}
          {onReset && efforts && <Choice label="Auto" hint="모델 기본값" selected={!effort} onClick={() => (onReset("effort"), setSheet(null))} />}
          {(efforts ?? []).map((e) => (
            <Choice key={e} label={effortLabel(e)} selected={effort === e} onClick={() => (onEffort(e), setSheet(null))} />
          ))}
          {ultracodeShown && (
            <button
              role="switch"
              aria-checked={ultracode}
              onClick={() => onUltracode(!ultracode)}
              className="mt-2 flex w-full items-center justify-between gap-3 rounded-xl border-t border-line px-3 py-2.5 text-left hover:bg-surface-2"
            >
              <span>
                <span className="block text-[15px]">Ultracode</span>
                <span className="block text-xs text-muted">
                  {deferred && offered === undefined ? "모델이 지원하면 시작할 때 켭니다 (이번 세션만)" : "모든 작업에 동적 워크플로를 씁니다 (이번 세션만)"}
                </span>
              </span>
              <Switch on={ultracode} />
            </button>
          )}
          {choosing && !ultracodeShown && (
            <div className="mt-2 border-t border-line px-3 pt-2.5 text-xs text-muted" data-ultracode-note>
              {offered === false ? "이 모델에서는 Ultracode를 쓸 수 없습니다." : "이 모델이 Ultracode를 지원하는지는 세션을 시작한 뒤에 알 수 있습니다."}
            </div>
          )}
          {!deferred && state?.appliedUnknown && (
            <div className="mt-2 border-t border-line px-3 pt-2.5 text-xs text-muted">VS Code가 Claude Code를 다시 시작하면 Ultracode와 지금 값이 보입니다.</div>
          )}
        </Sheet>
      )}
    </div>
  );
}
