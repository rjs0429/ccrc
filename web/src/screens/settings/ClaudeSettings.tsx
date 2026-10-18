import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import {
  CLAUDE_SETTING_FIELDS,
  MODEL_EFFORTS,
  canonicalModel,
  effortKeyModel,
  isAbsoluteDir,
  isModelName,
  isPermissionRule,
  modelEffortKey,
  type ClaudeSettingsView,
  type SettingField,
} from "../../../../broker/src/admin-protocol.ts";
import type { ModelOption } from "../../../../broker/src/protocol.ts";
import { ApiError, request } from "../../api.ts";
import { Button, Choice, Icon, Sheet, Spinner } from "../../components/ui.tsx";
import { EFFORT_LABEL, MODE_HINT, MODE_LABEL, shortPath } from "../../labels.ts";
import { loggedOut, toast, useApp, type SettingsPart } from "../../state.ts";
import { SettingsSaver, same, type SaveResult } from "./claudeSaver.ts";
import { SectionTitle, Segmented, showError } from "./common.tsx";

type TextField = Extract<SettingField, { kind: "text" }>;

const NO_MODELS: ModelOption[] = [];
const LISTS = ["permissions.allow", "permissions.ask", "permissions.deny", "permissions.additionalDirectories"];
const MODEL_PATTERN = (CLAUDE_SETTING_FIELDS.find((f) => f.key === "model") as TextField).pattern;

const LABEL: Record<string, string> = {
  model: "모델",
  "permissions.defaultMode": "기본 권한 모드",
  "permissions.allow": "허용 규칙",
  "permissions.ask": "묻기 규칙",
  "permissions.deny": "거부 규칙",
  "permissions.additionalDirectories": "추가 폴더",
  alwaysThinkingEnabled: "Thinking",
  showThinkingSummaries: "Thinking 요약 보기",
  language: "응답 언어",
  theme: "터미널 테마",
  autoCompactEnabled: "Auto-compact",
  includeGitInstructions: "Git 작업 지침",
  respectGitignore: ".gitignore 따르기",
};

const HINT: Record<string, string> = {
  "permissions.allow": "묻지 않고 허용합니다",
  "permissions.ask": "늘 묻습니다",
  "permissions.deny": "늘 거부합니다",
  "permissions.additionalDirectories": "작업 폴더 밖에서 다룰 수 있는 폴더입니다",
  alwaysThinkingEnabled: "끄면 thinking 없이 답합니다",
  showThinkingSummaries: "Thinking 요약을 대화에 보여 줍니다",
  autoCompactEnabled: "Context가 차면 이전 대화를 요약합니다",
  includeGitInstructions: "커밋·PR 작업 지침을 시스템 프롬프트에 넣습니다",
  respectGitignore: "파일 찾기에서 무시할 파일을 뺍니다",
};

const THEME_LABEL: Record<string, string> = {
  auto: "시스템 따라가기",
  dark: "어둡게",
  light: "밝게",
  "dark-daltonized": "어둡게 (색각 보정)",
  "light-daltonized": "밝게 (색각 보정)",
  "dark-ansi": "어둡게 (ANSI)",
  "light-ansi": "밝게 (ANSI)",
};

const CHOICE_LABEL: Record<string, Record<string, string>> = {
  "permissions.defaultMode": MODE_LABEL,
  theme: THEME_LABEL,
};

const PROBLEM: Record<string, string> = {
  not_json: "설정 파일에 주석이 있거나 엄격한 JSON이 아니어서 여기서는 바꾸지 않습니다. 노트북에서 고쳐 주세요.",
  not_object: "설정 파일의 형식이 맞지 않아 여기서는 바꾸지 않습니다.",
};

const ERRORS: Record<string, string> = {
  ...PROBLEM,
  invalid: "값이 올바르지 않습니다",
  not_allowed: "여기서 바꿀 수 없는 설정입니다",
};

const NOTE: Record<string, string> = {
  command: "명령을 실행하는 설정",
  security: "권한·보안 설정",
  legacy: "모델별 Effort 전의 키로, Opus 5.5 같은 새 모델에는 쓰이지 않습니다",
};

// "claude-opus-5-5" as "Opus 5.5"; other names stay as they are.
function modelName(name: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/.exec(name);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}` : name;
}

function labelOf(key: string): string {
  const model = effortKeyModel(key);
  return model ? `Effort · ${modelName(model)}` : (LABEL[key] ?? key);
}

// The models whose effort Claude Code keeps: those it offers with effort levels, then others the file names, each
// with the levels that can be saved for it.
function effortModels(models: ModelOption[], values: Record<string, unknown>): { model: string; levels: string[] }[] {
  const out = new Map<string, string[]>();
  for (const m of models) {
    const name = canonicalModel(m.resolved ?? m.value);
    const levels = MODEL_EFFORTS.filter((l) => m.efforts?.includes(l as never));
    if (name.startsWith("claude-") && isModelName(name) && !out.has(name) && levels.length) out.set(name, levels);
  }
  for (const key of Object.keys(values)) {
    const name = effortKeyModel(key);
    if (name && !out.has(name)) out.set(name, MODEL_EFFORTS);
  }
  return [...out].map(([model, levels]) => ({ model, levels }));
}

function valueText(key: string, v: unknown, models: ModelOption[]): string {
  if (v === undefined || v === null) return "기본값";
  if (typeof v === "boolean") return v ? "켬" : "끔";
  if (key === "model") return models.find((m) => m.value === v)?.label ?? String(v);
  const labels = effortKeyModel(key) ? EFFORT_LABEL : CHOICE_LABEL[key];
  return labels && typeof v === "string" && Object.hasOwn(labels, v) ? labels[v] : String(v);
}

function errorOf(e: unknown): string {
  const code = typeof e === "string" ? e : e instanceof ApiError && typeof e.body.error === "string" ? e.body.error : "";
  if (Object.hasOwn(ERRORS, code)) return ERRORS[code];
  if (e instanceof ApiError && e.status >= 500) return "노트북에서 설정 파일을 쓰지 못했습니다";
  if (e instanceof TypeError) return "노트북에 연결하지 못했습니다";
  return e instanceof Error ? e.message : String(e);
}

function report(saver: SettingsSaver, r: SaveResult): void {
  const label = labelOf(r.key);
  if (r.t === "saved") {
    if (r.undo) return toast(`되돌렸습니다 · ${label}`);
    return toast(`저장했습니다 · ${label}`, { label: "되돌리기", run: () => saver.set(r.key, r.before, true) });
  }
  if (r.t === "changed") return toast(`그사이 설정 파일에서 바뀐 값을 보입니다 · ${label}`);
  if (r.error instanceof ApiError && r.error.status === 401) return loggedOut("expired");
  toast(`저장하지 못했습니다 · ${label}: ${errorOf(r.error)}`);
}

const io = {
  read: () => request<ClaudeSettingsView>("GET", "/api/claude-settings"),
  write: (changes: Record<string, unknown>, baseHash: string) => request<ClaudeSettingsView>("PUT", "/api/claude-settings", { changes, baseHash }),
  conflict: (e: unknown) => e instanceof ApiError && e.status === 409,
};

// One for the app's whole run, so a save still going when the screen is left carries on and the next visit sees it.
let shared: SettingsSaver | undefined;

function Row({ setting, label, hint, busy, onClick, children }: { setting: string; label: string; hint?: string; busy?: boolean; onClick?: () => void; children: ReactNode }) {
  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px]">{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
      {busy && (
        <span className="shrink-0 text-muted" role="img" aria-label="저장하는 중" data-saving>
          <Spinner />
        </span>
      )}
      {children}
    </>
  );
  return onClick ? (
    <button onClick={onClick} className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left" data-setting={setting}>
      {body}
    </button>
  ) : (
    <div className="flex items-center gap-3 px-3.5 py-2.5" data-setting={setting}>
      {body}
    </div>
  );
}

// Saved on Enter or on leaving the field, never while typing; a value that does not fit goes back to the file's.
function TextInput({ field, label, value, onSave }: { field: TextField; label: string; value: unknown; onSave: (v: string) => void }) {
  const shown = typeof value === "string" ? value : "";
  const [text, setText] = useState(shown);
  const editing = useRef(false);
  const latest = useRef({ text, shown, onSave });
  latest.current = { text, shown, onSave };
  useEffect(() => {
    if (!editing.current) setText(shown);
  }, [shown]);
  const fits = (t: string) => t === "" || field.pattern.test(t);
  const commit = () => {
    const t = text.trim();
    if (t === shown) return setText(shown);
    if (!fits(t)) {
      toast(`저장하지 못했습니다 · ${label}: ${ERRORS.invalid}`);
      return setText(shown);
    }
    onSave(t);
  };
  useEffect(
    () => () => {
      const { text, shown, onSave } = latest.current;
      if (editing.current && text.trim() !== shown && fits(text.trim())) onSave(text.trim());
    },
    [],
  );
  return (
    <input
      value={text}
      onFocus={() => (editing.current = true)}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape") setText(shown);
        if (e.key !== "Enter") return;
        e.preventDefault();
        if (fits(text.trim())) e.currentTarget.blur();
        else toast(`${label}: ${ERRORS.invalid}`);
      }}
      onBlur={() => {
        editing.current = false;
        commit();
      }}
      placeholder="기본값"
      autoCapitalize="none"
      enterKeyHint="done"
      aria-label={label}
      className={`w-32 rounded-lg border bg-bg px-2.5 py-1.5 text-right text-[16px] outline-none ${fits(text.trim()) ? "border-line focus:border-accent" : "border-danger"}`}
    />
  );
}

function ListEditor({ field, items, busy, onChange }: { field: string; items: string[]; busy: boolean; onChange: (items: string[]) => void }) {
  const [text, setText] = useState("");
  const dirs = field === "permissions.additionalDirectories";
  const t = text.trim();
  const ok = !t || (dirs ? isAbsoluteDir(t) : isPermissionRule(t));
  const add = () => {
    if (!t || !ok) return;
    if (!items.includes(t)) onChange([...items, t]);
    setText("");
  };
  return (
    <div className="rounded-xl bg-surface p-3.5" data-list={field}>
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[15px]">{LABEL[field]}</span>
        {busy && (
          <span className="text-muted" role="img" aria-label="저장하는 중" data-saving>
            <Spinner />
          </span>
        )}
      </div>
      <div className="text-xs text-muted">{HINT[field]}</div>
      {items.length > 0 && (
        <ul className="mt-2 divide-y divide-line border-y border-line">
          {items.map((item, i) => (
            <li key={i} className="flex items-center gap-2 py-1.5">
              <span className="min-w-0 flex-1 font-mono text-[13px] break-all">{item}</span>
              <button onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label={`${item} 빼기`} className="rounded-lg p-1.5 text-muted">
                <Icon.x className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder={dirs ? "/home/me/other-project" : "Bash(npm run test:*)"}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-label={`${LABEL[field]} 추가`}
          className={`min-w-0 flex-1 rounded-lg border bg-bg px-2.5 py-2 font-mono text-[16px] outline-none ${ok ? "border-line focus:border-accent" : "border-danger"}`}
        />
        <Button onClick={add} disabled={!t || !ok}>
          추가
        </Button>
      </div>
      {!ok && <div className="mt-1 text-xs text-danger">{dirs ? "/로 시작하는 절대 경로로 적어 주세요" : "도구 이름이나 도구(내용) 꼴로 적어 주세요"}</div>}
    </div>
  );
}

function ChoiceSheet(p: { title: string; values: string[]; labels: Record<string, string>; hints?: Record<string, string>; value: unknown; onPick: (v?: string) => void; onClose: () => void }) {
  return (
    <Sheet title={p.title} onClose={p.onClose}>
      <Choice label="기본값" hint="이 설정을 지우고 Claude Code 기본값을 씁니다" selected={p.value === undefined} onClick={() => p.onPick(undefined)} />
      {p.values.map((v) => (
        <Choice key={v} label={p.labels[v] ?? v} hint={p.hints?.[v]} selected={p.value === v} onClick={() => p.onPick(v)} />
      ))}
    </Sheet>
  );
}

function ModelSheet({ value, models, onPick, onClose }: { value: unknown; models: ModelOption[]; onPick: (v?: string) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  const t = text.trim();
  return (
    <Sheet title="모델" onClose={onClose}>
      <Choice label="기본값" hint="이 설정을 지우고 Claude Code 기본값을 씁니다" selected={value === undefined} onClick={() => onPick(undefined)} />
      {typeof value === "string" && !models.some((m) => m.value === value) && <Choice label={value} selected onClick={onClose} />}
      {models.map((m) => (
        <Choice key={m.value} label={m.label} hint={m.value} selected={m.value === value} onClick={() => onPick(m.value)} />
      ))}
      <div className="mt-2 flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && MODEL_PATTERN.test(t)) onPick(t);
          }}
          placeholder="직접 입력 (예: opus[1m])"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-2.5 py-2 font-mono text-[16px] outline-none focus:border-accent"
        />
        <Button disabled={!MODEL_PATTERN.test(t)} onClick={() => onPick(t)}>
          적용
        </Button>
      </div>
    </Sheet>
  );
}

function Rest({ view }: { view: ClaudeSettingsView }) {
  const notes = view.notes.filter((n) => n.reason !== "value");
  if (!Object.keys(view.rest).length) return null;
  return (
    <details className="rounded-xl bg-surface p-3.5">
      <summary className="cursor-pointer text-[15px]">나머지 설정 (읽기 전용)</summary>
      {notes.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs">
          {notes.map((n) => (
            <li key={n.key}>
              <span className="font-mono">{n.key}</span>
              <span className="text-muted"> · {NOTE[n.reason]}</span>
            </li>
          ))}
        </ul>
      )}
      <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-code p-2.5 font-mono text-[12px] leading-relaxed">{JSON.stringify(view.rest, null, 2)}</pre>
      <p className="mt-2 text-xs text-muted">이 설정들은 노트북에서 고칩니다. 환경 변수 값은 가려서 보여 줍니다.</p>
    </details>
  );
}

// Turning Thinking off does not reach a model that always thinks; the hint names one when Claude Code lists one.
function thinkingHint(models: ModelOption[]): string {
  const always = models.find((m) => m.thinkingOff === false && m.resolved);
  return always ? `${HINT.alwaysThinkingEnabled}. ${modelName(canonicalModel(always.resolved!))} 같은 늘 생각하는 모델에는 쓰이지 않습니다` : HINT.alwaysThinkingEnabled;
}

export function ClaudeSettingsSection({ part }: { part?: SettingsPart }) {
  const models = useApp((s) => s.options?.models) ?? NO_MODELS;
  const [saver, setSaver] = useState(shared);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [sheet, setSheet] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    if (shared) void shared.reload().catch((e: unknown) => live && showError(e, ERRORS));
    else
      io.read().then(
        (v) => {
          if (!shared) {
            const s: SettingsSaver = new SettingsSaver(v, io, (r) => report(s, r));
            shared = s;
          }
          if (live) setSaver(shared);
        },
        (e: unknown) => live && showError(e, ERRORS),
      );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => saver?.subscribe(rerender), [saver]);

  useEffect(() => {
    if (saver && part) document.getElementById(`claude-${part}`)?.scrollIntoView({ block: "start" });
  }, [Boolean(saver), part]);

  if (!saver) {
    return (
      <section className="space-y-2">
        <SectionTitle>Claude Code 설정</SectionTitle>
        <div className="flex justify-center rounded-xl bg-surface p-4 text-muted">
          <Spinner />
        </div>
      </section>
    );
  }

  const view = saver.view;
  const value = (key: string) => saver.value(key);
  const set = (key: string, v: unknown) => saver.set(key, v);
  const list = (key: string) => (Array.isArray(value(key)) ? (value(key) as unknown[]).map(String) : []);
  const odd = new Set(view.notes.filter((n) => n.reason === "value").map((n) => n.key));
  const hintOf = (key: string, base?: string) => (odd.has(key) && same(value(key), view.values[key]) ? "여기서 고를 수 없는 값입니다" : base);
  const efforts = effortModels(models, view.values);
  const open = sheet ? CLAUDE_SETTING_FIELDS.find((f) => f.key === sheet) : undefined;
  const openEffort = sheet ? efforts.find((e) => modelEffortKey(e.model) === sheet) : undefined;
  const pick = (key: string) => (v?: string) => {
    set(key, v);
    setSheet(null);
  };

  return (
    <section className="space-y-2">
      <SectionTitle>Claude Code 설정</SectionTitle>
      <div className="px-1 font-mono text-xs break-all text-muted">
        {shortPath(view.path)}
        {view.exists ? "" : " (없음, 바꾸면 만듭니다)"}
      </div>
      {view.problem ? (
        <div className="rounded-xl bg-surface p-3.5 text-sm">{PROBLEM[view.problem]}</div>
      ) : (
        <>
          <div className="divide-y divide-line rounded-xl bg-surface">
            {CLAUDE_SETTING_FIELDS.filter((f) => !LISTS.includes(f.key)).map((f) => {
              const v = value(f.key);
              const busy = saver.busy(f.key);
              const hint = hintOf(f.key, f.key === "alwaysThinkingEnabled" ? thinkingHint(models) : HINT[f.key]);
              if (f.kind === "bool") {
                return (
                  <Row key={f.key} setting={f.key} label={LABEL[f.key]} hint={hint} busy={busy}>
                    <Segmented
                      value={v === true ? "on" : v === false ? "off" : "default"}
                      options={[
                        ["default", "기본"],
                        ["on", "켬"],
                        ["off", "끔"],
                      ]}
                      onChange={(x) => set(f.key, x === "default" ? undefined : x === "on")}
                    />
                  </Row>
                );
              }
              if (f.kind === "text" && f.key !== "model") {
                return (
                  <Row key={f.key} setting={f.key} label={LABEL[f.key]} hint={hint} busy={busy}>
                    <TextInput field={f} label={LABEL[f.key]} value={v} onSave={(t) => set(f.key, t)} />
                  </Row>
                );
              }
              return (
                <Row key={f.key} setting={f.key} label={LABEL[f.key]} hint={hint} busy={busy} onClick={() => setSheet(f.key)}>
                  <span className="flex min-w-0 items-center gap-1 text-sm text-muted">
                    <span className="truncate">{valueText(f.key, v, models)}</span>
                    <Icon.chevronRight className="size-4 shrink-0" />
                  </span>
                </Row>
              );
            })}
          </div>
          {efforts.length > 0 && (
            <div id="claude-effort" className="space-y-1">
              <div className="px-1 text-xs text-muted">Effort는 모델마다 따로 저장합니다. /effort로 고른 값과 같습니다</div>
              <div className="divide-y divide-line rounded-xl bg-surface">
                {efforts.map(({ model }) => {
                  const key = modelEffortKey(model);
                  return (
                    <Row key={key} setting={key} label={`Effort · ${modelName(model)}`} hint={hintOf(key)} busy={saver.busy(key)} onClick={() => setSheet(key)}>
                      <span className="flex min-w-0 items-center gap-1 text-sm text-muted">
                        <span className="truncate">{valueText(key, value(key), models)}</span>
                        <Icon.chevronRight className="size-4 shrink-0" />
                      </span>
                    </Row>
                  );
                })}
              </div>
            </div>
          )}
          <div id="claude-permissions" className="scroll-mt-4 space-y-2">
            {LISTS.map((key) => (
              <ListEditor key={key} field={key} items={list(key)} busy={saver.busy(key)} onChange={(items) => set(key, items)} />
            ))}
          </div>
          <Rest view={view} />
          <p className="px-1 text-xs leading-relaxed text-muted" data-claude-note>
            바꾸면 바로 저장합니다. 처음 고치기 전의 파일과 최근 10개를 같은 폴더에 백업합니다(10분 안에 이어 바꾼 것은 하나로). 새로 시작하는 세션부터
            적용되고, 열려 있는 세션은 모델과 Effort를 그대로 씁니다.
          </p>
        </>
      )}
      {open?.key === "model" && <ModelSheet value={value("model")} models={models} onPick={pick("model")} onClose={() => setSheet(null)} />}
      {open?.kind === "choice" && (
        <ChoiceSheet
          title={LABEL[open.key]}
          values={open.values}
          labels={CHOICE_LABEL[open.key] ?? {}}
          hints={open.key === "permissions.defaultMode" ? MODE_HINT : undefined}
          value={value(open.key)}
          onPick={pick(open.key)}
          onClose={() => setSheet(null)}
        />
      )}
      {openEffort && (
        <ChoiceSheet
          title={`Effort · ${modelName(openEffort.model)}`}
          values={openEffort.levels}
          labels={EFFORT_LABEL}
          value={value(sheet!)}
          onPick={pick(sheet!)}
          onClose={() => setSheet(null)}
        />
      )}
    </section>
  );
}
