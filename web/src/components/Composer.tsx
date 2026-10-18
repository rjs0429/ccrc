import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { EffortName, LiveState, ModelOption, PermissionModeName, StartSettings } from "../../../broker/src/protocol.ts";
import { MODE_HINT, MODE_LABEL, baseName, effortLabel, effortLevels, fastReasonText, findModel, modelLabel, modelOffers } from "../labels.ts";
import { Switch } from "../screens/settings/common.tsx";
import { usePrefs } from "../prefs.ts";
import { rememberSent } from "../sentPreviews.ts";
import { toast, useApp } from "../state.ts";
import { commandName, isDialogCommand, parseCommand } from "../../../broker/src/dialog-commands.ts";
import { bareCommandSheet, withPhoneCommands } from "./commandSheets.ts";
import { CacheClock } from "./CacheClock.tsx";
import { ContextRing } from "./ContextRing.tsx";
import { AgentChip, agentChipWidth } from "./agents/AgentChip.tsx";
import type { AgentMap } from "./agents/tree.ts";
import { AttachmentChips } from "./composer/AttachmentChips.tsx";
import { ATTACH_ACCEPT, MAX_MESSAGE_BYTES, NEW_SESSION_SCOPE, addFiles, takeAttachments, useAttachments } from "./composer/attachments.ts";
import { chipLayout, sameLayout, type ChipLayout } from "./composer/chipLayout.ts";
import { afterKeyboard } from "./composer/picker.ts";
import { Suggestions, type SuggestRow } from "./composer/Suggestions.tsx";
import { commandQuery, mentionAt, mentionText, rankCommands, useCommands, useFileSuggestions, type SuggestTarget } from "./composer/suggest.ts";
import { Button, Choice, Icon, Sheet, Spinner } from "./ui.tsx";

const MODES: PermissionModeName[] = ["default", "acceptEdits", "plan", "auto"];
const MAX_INPUT_PX = 168;
const MAX_COMMAND_ROWS = 50;
const DRAFT_KEY = "ccrc.draft.";
const START_HINT = "여기서 이 세션을 시작할 때 적용합니다. VS Code에서 열면 적용되지 않습니다.";
const DRAFT_HINT = "새 세션을 시작할 때 적용합니다.";
// Commands that mean nothing before a session exists.
const DRAFT_HIDDEN = new Set(["clear", "compact", "rename", "recap", "heapdump"]);
// The round button sits on the last chip line. Its tap target grows to 44px across and mostly downward, into
// the composer's bottom padding, so it covers no other control.
const ROUND_TAP = "relative after:absolute after:-inset-x-1.5 after:-top-0.5 after:-bottom-2.5";
const STOP_SETTLE_MS = 500;
const FAST_ASKED_KEY = "ccrc.fastAsked";
const OLD_WRAPPER = "VS Code에서 Claude Code를 다시 띄우면 바꿀 수 있습니다.";

// Each composerInsert request is applied once, by the composer that is mounted when it arrives.
let appliedInsert = 0;

export function loadDraft(scope?: string): string {
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

// Sessions where turning Fast mode on mid-conversation was confirmed on this device; it is asked once per session.
function fastAsked(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(FAST_ASKED_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function rememberFastAsked(sessionId: string): void {
  try {
    localStorage.setItem(FAST_ASKED_KEY, JSON.stringify([...fastAsked().filter((id) => id !== sessionId), sessionId].slice(-100)));
  } catch {}
}

// What Fast mode is doing, under its switch.
function fastStatus(state?: LiveState): { text: string; tone: string } | undefined {
  if (!state) return undefined;
  if (state.fastWanted !== undefined) return { text: state.fastWanted ? "다음 턴부터 켜집니다" : "다음 턴부터 꺼집니다", tone: "text-muted" };
  if (state.fastCredits) return { text: "사용 크레딧이 다 떨어져 표준 속도로 보냅니다", tone: "text-danger" };
  if (state.fastMode === "cooldown") return { text: "속도 제한으로 잠시 표준 속도로 보냅니다", tone: "text-muted" };
  const reason = state.fastMode === "off" ? fastReasonText(state.fastReason) : undefined;
  if (!reason) return undefined;
  return state.fastReason === "pending" ? { text: reason, tone: "text-muted" } : { text: `쓸 수 없음: ${reason}`, tone: "text-warn" };
}

function SwitchRow({
  name,
  label,
  hint,
  status,
  on,
  disabled,
  onClick,
}: {
  name: string;
  label: React.ReactNode;
  hint: string;
  status?: { text: string; tone: string };
  on: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={onClick}
      data-switch={name}
      className="mt-2 flex w-full items-center justify-between gap-3 rounded-xl border-t border-line px-3 py-2.5 text-left enabled:hover:bg-surface-2 disabled:opacity-50"
    >
      <span>
        <span className="flex items-center gap-1 text-[15px]">{label}</span>
        <span className="block text-xs text-muted">{hint}</span>
        {status && <span className={`mt-0.5 block text-xs ${status.tone}`} data-switch-status>{status.text}</span>}
      </span>
      <Switch on={on} />
    </button>
  );
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
  // Fast mode and Thinking for this session only; absent where they cannot be chosen.
  onFast?: (on: boolean) => void;
  onThinking?: (on: boolean) => void;
  // The conversation has messages, which Claude Code reads again at Fast mode's rates once it is turned on.
  inConversation?: boolean;
  // Back to what Claude Code starts with when nothing is chosen; offered in a draft's sheets.
  onReset?: (key: "model" | "mode" | "effort") => void;
  // A bare "/" command, picked from the list or sent, that opens a screen here instead; true when it did. A draft
  // also passes a command with its arguments; "kept" leaves the message as it is, unsent.
  onCommand?: (name: string, args?: string) => boolean | "kept";
  // Opens the model or effort sheet when `at` changes.
  openSheet?: { name: "model" | "effort"; at: number };
  // The context ring next to the paperclip; absent where there is no session.
  onContext?: () => void;
  // Given onAgents, the agent chip shows for the whole conversation, also beside a reason that stands in for the
  // composer; agents is absent while the conversation has no subagent or workflow.
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
  onFast,
  onThinking,
  inConversation = false,
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
  const [sheet, setSheet] = useState<"mode" | "model" | "effort" | "fast" | null>(null);
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
  const chosen = !draft && Boolean(start && (start.model || start.mode || start.effort || start.ultracode || start.fast || start.thinking === false));
  // Whether the model offered Ultracode in an earlier session.
  const offered = findModel(models, starts)?.ultracode;
  const ultracodeShown = draft ? offered === true || ultracode : deferred ? offered !== false || ultracode : state?.ultracodeAvailable === true;
  const offers = modelOffers(models, starts);
  const fastRunning = state?.fastMode === "on" || state?.fastMode === "cooldown";
  const fastOn = choosing ? start?.fast === true : (state?.fastWanted ?? fastRunning);
  const thinkingOn = choosing ? start?.thinking !== false : state?.thinking !== false;
  // A stopped session started with no model chosen runs the one Claude Code picks, which may offer Fast mode.
  const fastUnknown = deferred && !starts;
  const fastRow = Boolean(onFast) && (offers.fast || fastOn || fastUnknown || (!choosing && fastRunning));
  const thinkingRow = Boolean(onThinking) && (offers.thinkingOff === true || !thinkingOn);
  const optionsUnknown = !choosing && state?.optionsUnknown === true;
  // The mark on the input's border: Fast mode on, cooling down, asked for, or out of credits; and Thinking off.
  const fastMark = choosing
    ? start?.fast && "wanted"
    : state?.fastCredits && fastOn
      ? "credits"
      : state?.fastWanted
        ? "wanted"
        : state?.fastWanted === undefined && fastRunning
          ? state.fastMode
          : undefined;
  const thinkingMark = !thinkingOn && offers.thinkingOff === true;
  // Claude Code holds such a model at High while Thinking is off.
  const capped = offers.capped && (effort === "xhigh" || effort === "max");
  const uploading = attachments.some((a) => !a.uploaded);
  // While a new session starts, its first message stays as it was sent.
  const locked = Boolean(draft && starting);
  const filled = text.trim() !== "" || attachments.length > 0;
  const canSend = !uploading && !locked && filled;
  // One round button: stop while a turn runs and there is nothing to send, else send, which queues during a turn.
  const stops = busy && !filled;

  const draftCwd = draft?.cwd;
  const target = useMemo<SuggestTarget | undefined>(() => (sessionId ? { sessionId } : draftCwd ? { cwd: draftCwd } : undefined), [sessionId, draftCwd]);
  const mention = target && !dismissed ? mentionAt(text, caret) : undefined;
  const command = target && !dismissed && !mention ? commandQuery(text) : undefined;
  const files = useFileSuggestions(target, mention?.query);
  const listed = useCommands(target, command !== undefined, state?.commands);
  const commands = draft ? listed?.filter((c) => !DRAFT_HIDDEN.has(c.name)) : withPhoneCommands(listed);
  const rows: SuggestRow[] =
    mention && files
      ? files.map((f) => ({ key: f, label: baseName(f), hint: f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : undefined }))
      : command !== undefined && commands
        ? rankCommands(commands, command)
            .slice(0, MAX_COMMAND_ROWS)
            .map((c) => ({ key: c.name, label: `/${c.name}`, hint: c.argumentHint, detail: c.description }))
        : [];
  const shown = rows.length > 0 && !locked;
  const chipText = efforts ? (effort ? effortLabel(effort) : "Effort") : thinkingRow ? "Thinking" : "Fast";
  const effortName = [
    efforts ? (effort ? `Effort ${effortLabel(effort)}` : "Effort") : chipText,
    ultracode ? "Ultracode 켜짐" : "",
    fastMark === "on" || fastMark === "credits" ? "Fast 모드 켜짐" : fastMark === "cooldown" ? "Fast 모드 쿨다운" : fastMark ? (choosing ? "Fast 모드로 시작" : "Fast 모드 켜는 중") : "",
    thinkingMark ? "Thinking 꺼짐" : "",
  ]
    .filter(Boolean)
    .join(", ");

  const [layout, setLayout] = useState<ChipLayout>({ lines: "two", word: true });
  const barRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLSpanElement>(null);
  const modeRef = useRef<HTMLSpanElement>(null);
  const agentRef = useRef<HTMLButtonElement>(null);
  const roundRef = useRef<HTMLButtonElement>(null);
  // The chip lines follow from the chips' widths with every name in full, measured after each render before it
  // paints, and again when the composer's width changes or fonts load.
  const measure = (): ChipLayout | undefined => {
    const [bar, rows, left, right, round] = [barRef.current, rowsRef.current, leftRef.current, rightRef.current, roundRef.current];
    if (!bar || !rows || !left || !right || !round) return undefined;
    return chipLayout({
      composer: bar.getBoundingClientRect().width,
      row: rows.getBoundingClientRect().width,
      gap: parseFloat(getComputedStyle(left.parentElement!).columnGap) || 0,
      left: groupWidth(left, modelRef.current),
      right: groupWidth(right, modeRef.current),
      round: round.getBoundingClientRect().width + (parseFloat(getComputedStyle(round).marginLeft) || 0),
      agent: agentRef.current ? agentChipWidth(agentRef.current) : undefined,
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

  // The textarea fits its text as it changes, as the textarea appears, and as the window's size changes its width or
  // its line height.
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    // The box holds its height while the field is measured at one row; the composer changes height once, to the new one.
    const box = el.parentElement!;
    box.style.minHeight = `${box.getBoundingClientRect().height}px`;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_PX)}px`;
    box.style.minHeight = "";
  };
  useLayoutEffect(() => {
    fit();
    const el = ref.current;
    if (el && nextCaret.current !== null) {
      el.setSelectionRange(nextCaret.current, nextCaret.current);
      nextCaret.current = null;
    }
  }, [text, hasRows]);
  useEffect(() => {
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

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
    const next = insert.replace ? insert.text : text && !/\s$/.test(text) ? `${text}\n${insert.text}` : text + insert.text;
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

  // Turning Fast mode on mid-conversation reads the conversation again at its rates, so that is confirmed once per session.
  const fastTold = useRef(false);
  const turnFast = (on: boolean, told = false) => {
    if (on && inConversation && sessionId && !fastAsked().includes(sessionId)) {
      fastTold.current = told;
      return setSheet("fast");
    }
    onFast?.(on);
    if (told) toast(choosing ? "시작 설정을 바꿨습니다" : on ? "Fast 모드를 켰습니다 (이번 세션만)" : "Fast 모드를 껐습니다");
  };

  // "/fast", "/fast on" and "/fast off" act as the switch does, for this session only; a draft's bare "/fast" opens it.
  const fastCommand = (args: string): boolean | "kept" => {
    const v = args.toLowerCase();
    if (v && v !== "on" && v !== "off") {
      toast("/fast 다음에는 on이나 off만 쓸 수 있습니다");
      return "kept";
    }
    if (draft && !v) {
      setSheet("effort");
      return true;
    }
    if (!choosable || optionsUnknown) {
      toast(optionsUnknown ? OLD_WRAPPER : "session is starting");
      return "kept";
    }
    const on = v ? v === "on" : !fastOn;
    if (on && !fastRow) {
      toast("이 모델에서는 Fast 모드를 쓸 수 없습니다");
      return true;
    }
    turnFast(on, true);
    return true;
  };

  const submit = () => {
    if (!canSend || disabledReason) return;
    const c = attachments.length ? undefined : parseCommand(text);
    const fast = c && onFast && commandName(c.name) === "fast" ? fastCommand(c.args) : false;
    if (fast === "kept") return;
    if (fast) return opened();
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

  // A tap does what the round button showed as the finger went down. A stop that has only just taken its place takes
  // no tap or key until it has been left alone for STOP_SETTLE_MS.
  const face = useRef({ stops, since: 0 });
  useLayoutEffect(() => {
    if (face.current.stops !== stops) face.current = { stops, since: performance.now() };
  }, [stops]);
  const pressed = useRef<"send" | "stop" | "none" | null>(null);
  const meant = () => {
    if (!face.current.stops) return "send";
    const now = performance.now();
    if (now - face.current.since >= STOP_SETTLE_MS) return "stop";
    face.current.since = now;
    return "none";
  };
  // Where a click gives the button the focus, the focus moves on to the input, since by the next key the button may
  // be a stop.
  const tapRound = (e: React.MouseEvent) => {
    const act = e.detail === 0 ? meant() : (pressed.current ?? meant());
    pressed.current = null;
    if (document.activeElement === e.currentTarget) ref.current?.focus();
    if (act === "send") submit();
    else if (act === "stop" && busy) onStop();
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
    if (!onAgents) return <div className="pb-safe border-t border-line bg-bg px-safe-4 pt-3 text-center text-sm text-muted short:pt-2">{disabledReason}</div>;
    return (
      <div className="pb-safe border-t border-line bg-bg px-safe-4 pt-2 short:pt-1">
        <div className="mx-auto flex max-w-3xl items-center gap-2">
          <AgentChip chip={agents} word onClick={openAgents} />
          <p className="min-w-0 flex-1 text-sm break-keep text-balance text-muted" data-disabled-reason>
            {disabledReason}
          </p>
        </div>
      </div>
    );
  }

  const two = layout.lines === "two";
  const agentChip = onAgents && <AgentChip ref={agentRef} chip={agents} word={layout.word} onClick={openAgents} className={two ? "col-start-1 row-start-1" : ""} />;
  // Sharing a line with the right group, the left group never shrinks: a longer name is measured in full and takes
  // the chips to two lines instead of being cut. On two lines the agent chip and the right group take line 1, the left
  // group and the round button line 2.
  const leftFit = two ? "col-[1/3] row-start-2" : layout.lines === "wide" ? "min-w-0" : "shrink-0";

  return (
    <div ref={barRef} className={`pb-safe border-t border-line bg-bg px-safe-3 ${fastMark || thinkingMark ? "pt-2.5 short:pt-2" : "pt-2 short:pt-1"}`}>
      <div className="relative mx-auto max-w-3xl">
        {shown && <Suggestions rows={rows} active={active} onPick={pick} />}
        <div className="relative rounded-2xl border border-line bg-surface px-3 pt-2.5 pb-1.5 focus-within:border-accent short:pt-1.5 short:pb-1">
          {(fastMark || thinkingMark) && (
            <div
              className={`pointer-events-none absolute -top-[7px] right-4 z-10 flex h-3 items-center gap-1 px-1 before:absolute before:inset-x-0 before:top-[4px] before:z-[-1] before:h-[3px] before:bg-bg ${choosing ? "opacity-60" : ""}`}
              data-legend
            >
              {thinkingMark && <span className="text-[11px] leading-none text-muted">Thinking 끔</span>}
              {fastMark && (
                <span
                  title={fastMark === "cooldown" ? "Fast 모드 쿨다운" : fastMark === "credits" ? "Fast 모드: 사용 크레딧 소진" : "Fast 모드"}
                  data-fast-mark={fastMark}
                  className={fastMark === "credits" ? "text-danger" : fastMark === "cooldown" ? "text-muted" : `text-accent ${fastMark === "wanted" && !choosing ? "opacity-50" : ""}`}
                >
                  <Icon.zap />
                </span>
              )}
            </div>
          )}
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
            <div className={`items-center gap-x-1 ${two ? "grid grid-cols-[auto_minmax(0,1fr)_auto] gap-y-1 short:gap-y-0.5" : "flex"}`}>
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
                {onContext && <ContextRing gauge={state?.context} onClick={onContext} />}
                {onContext && <CacheClock cache={state?.cache} onClick={onContext} />}
                <Chip name="model" className="min-w-0" disabled={!choosable} onClick={() => setSheet("model")}>
                  <span ref={modelRef} className="truncate">{modelLabel(models, model)}</span>
                  <Icon.chevronDown className="size-3 shrink-0" />
                </Chip>
                {(efforts || fastRow || thinkingRow) && (
                  <Chip name="effort" label={effortName} disabled={!choosable} onClick={() => setSheet("effort")}>
                    {chipText}
                    {ultracode && (
                      <span title="Ultracode" data-ultracode className="ml-0.5 rounded bg-accent-soft px-1 text-[11px] font-medium text-accent">
                        U
                      </span>
                    )}
                    <Icon.chevronDown className="size-3" />
                  </Chip>
                )}
              </div>
              {agentChip}
              <div ref={rightRef} className={`flex min-w-0 items-center justify-end ${two ? "col-[2/4] row-start-1" : "ml-auto shrink-0"}`} data-chip-group="right">
                <Chip name="mode" className="min-w-0" disabled={!choosable} onClick={() => setSheet("mode")}>
                  <span ref={modeRef} className="truncate">{MODE_LABEL[mode ?? ""] ?? "권한 모드"}</span>
                  <Icon.chevronDown className="size-3 shrink-0" />
                </Chip>
              </div>
              <button
                ref={roundRef}
                onPointerDown={() => (pressed.current = meant())}
                onPointerCancel={() => (pressed.current = null)}
                onClick={tapRound}
                disabled={!stops && !canSend}
                aria-label={locked ? "시작하는 중" : stops ? "중지" : draft ? "시작" : busy ? "대기열에 추가" : "보내기"}
                data-starting={locked || undefined}
                className={`ml-0.5 flex size-8 shrink-0 items-center justify-center rounded-full ${ROUND_TAP} ${two ? "col-start-3 row-start-2" : ""} ${stops ? "bg-surface-2 text-fg" : `bg-accent text-white ${locked ? "" : "disabled:opacity-30"}`}`}
              >
                {locked ? <Spinner className="size-4" /> : stops ? <Icon.stop className="size-5" /> : <Icon.send className="size-4 [stroke-width:2.5]" />}
              </button>
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
          {fastRow && (
            <SwitchRow
              name="fast"
              label={
                <>
                  Fast 모드 <Icon.zap className="size-3 text-accent" />
                </>
              }
              hint={
                !choosing
                  ? "Opus를 최대 2.5배 빠르게 돌리고, 사용 크레딧으로 더 비싸게 냅니다 (이번 세션만)"
                  : fastUnknown
                    ? "모델이 지원하면 시작할 때 켭니다 (이번 세션만)"
                    : "시작할 때 켭니다 (이번 세션만)"
              }
              status={choosing ? undefined : fastStatus(state)}
              on={fastOn}
              disabled={optionsUnknown}
              onClick={() => turnFast(!fastOn)}
            />
          )}
          {thinkingRow && (
            <SwitchRow
              name="thinking"
              label="Thinking"
              hint={choosing ? "꺼 두면 Thinking 없이 시작합니다" : "끄면 생각하지 않고 바로 답합니다 (이번 세션만)"}
              on={thinkingOn}
              disabled={optionsUnknown}
              onClick={() => onThinking?.(!thinkingOn)}
            />
          )}
          {(fastRow || thinkingRow) && (optionsUnknown || (thinkingRow && (capped || (!choosing && state?.host === "VS Code")))) && (
            <div className="space-y-1 px-3 pt-1 text-xs text-muted" data-toggle-notes>
              {optionsUnknown && <p>{OLD_WRAPPER}</p>}
              {thinkingRow && capped && <p>Thinking을 끄면 이 모델은 Effort High로 실행됩니다.</p>}
              {thinkingRow && !optionsUnknown && !choosing && state?.host === "VS Code" && <p>VS Code 메뉴의 Thinking 표시는 바뀌지 않습니다.</p>}
            </div>
          )}
          {(onFast || onThinking) && (!fastRow || (!thinkingRow && offers.thinkingOff === false)) && (
            <div className="mt-2 border-t border-line px-3 pt-2.5 text-xs text-muted" data-model-note>
              {!fastRow && !thinkingRow && offers.thinkingOff === false
                ? "이 모델에서는 Fast 모드를 쓸 수 없고 Thinking을 끌 수 없습니다."
                : !fastRow
                  ? "이 모델에서는 Fast 모드를 쓸 수 없습니다."
                  : "이 모델은 늘 생각하므로 Thinking을 끌 수 없습니다."}
            </div>
          )}
        </Sheet>
      )}
      {sheet === "fast" && (
        <Sheet title="Fast 모드" onClose={() => setSheet(null)}>
          <p className="px-1 text-[15px] leading-relaxed">대화 중간에 켜면 지금까지의 대화를 다음 요청에서 한 번 Fast 모드 요금으로 다시 읽습니다. 계속할까요?</p>
          <p className="mt-1 px-1 text-xs text-muted">이 세션에서는 다시 묻지 않습니다.</p>
          <div className="mt-4 flex gap-2">
            <Button className="flex-1" onClick={() => setSheet(null)}>
              취소
            </Button>
            <Button
              kind="primary"
              className="flex-1"
              onClick={() => {
                if (sessionId) rememberFastAsked(sessionId);
                setSheet(null);
                turnFast(true, fastTold.current);
              }}
            >
              켜기
            </Button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
