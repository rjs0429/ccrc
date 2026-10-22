import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import {
  CLAUDE_SETTING_FIELDS,
  LEGACY_EFFORT,
  MODEL_DEFAULT,
  canonicalModel,
  effortKeyModel,
  isAbsoluteDir,
  isPermissionRule,
  modelEffortKey,
  type ClaudeSettingsView,
  type SettingField,
} from "../../../../broker/src/admin-protocol.ts";
import type { ModelOption } from "../../../../broker/src/protocol.ts";
import { ApiError, request } from "../../api.ts";
import { Button, Choice, Icon, Sheet, Spinner } from "../../components/ui.tsx";
import { k, t } from "../../i18n/index.ts";
import { EFFORT_LABEL, modeHints, shortPath } from "../../labels.ts";
import { loggedOut, toast, useApp, type SettingsPart } from "../../state.ts";
import { ERRORS, PROBLEM, choiceLabels, effortModels, failureText, inheritedEffort, isDefaultModel, modelName, valueText } from "./claudeLabels.ts";
import { SettingsSaver, same, type SaveResult } from "./claudeSaver.ts";
import { SectionTitle, Segmented } from "./common.tsx";

type TextField = Extract<SettingField, { kind: "text" }>;

const NO_MODELS: ModelOption[] = [];
const LISTS = ["permissions.allow", "permissions.ask", "permissions.deny", "permissions.additionalDirectories"];
const MODEL_PATTERN = (CLAUDE_SETTING_FIELDS.find((f) => f.key === "model") as TextField).pattern;

const LABEL: Record<string, string> = {
  model: k("모델"),
  "permissions.defaultMode": k("기본 권한 모드"),
  "permissions.allow": k("허용 규칙"),
  "permissions.ask": k("묻기 규칙"),
  "permissions.deny": k("거부 규칙"),
  "permissions.additionalDirectories": k("추가 폴더"),
  [LEGACY_EFFORT]: k("Effort · 이전 모델 공통"),
  alwaysThinkingEnabled: "Thinking",
  showThinkingSummaries: k("Thinking 요약 보기"),
  language: k("응답 언어"),
  theme: k("터미널 테마"),
  autoCompactEnabled: "Auto-compact",
  includeGitInstructions: k("Git 작업 지침"),
  respectGitignore: k(".gitignore 따르기"),
};

const HINT: Record<string, string> = {
  "permissions.allow": k("묻지 않고 허용합니다"),
  "permissions.ask": k("늘 묻습니다"),
  "permissions.deny": k("늘 거부합니다"),
  "permissions.additionalDirectories": k("작업 폴더 밖에서 다룰 수 있는 폴더입니다"),
  alwaysThinkingEnabled: k("끄면 thinking 없이 답합니다"),
  showThinkingSummaries: k("Thinking 요약을 대화에 보여 줍니다"),
  autoCompactEnabled: k("Context가 차면 이전 대화를 요약합니다"),
  includeGitInstructions: k("커밋·PR 작업 지침을 시스템 프롬프트에 넣습니다"),
  respectGitignore: k("파일 찾기에서 무시할 파일을 뺍니다"),
};

const NOTE: Record<string, string> = {
  command: k("명령을 실행하는 설정"),
  security: k("권한·보안 설정"),
};

const DEFAULT_HINT = k("이 설정을 지우고 Claude Code 기본값을 씁니다");
const DEFAULT_MODEL_HINT = k("Claude Code가 모델 이름으로 읽어 모델별 Effort가 적용되지 않습니다. 기본값을 고르면 지웁니다");

const labelText = (key: string) => (Object.hasOwn(LABEL, key) ? t(LABEL[key]) : key);
const hintText = (key: string) => (Object.hasOwn(HINT, key) ? t(HINT[key]) : undefined);

function labelOf(key: string): string {
  const model = effortKeyModel(key);
  return model ? `Effort · ${modelName(model)}` : labelText(key);
}

function errorText(e: unknown): string {
  if (e instanceof ApiError) return failureText(typeof e.body.error === "string" ? e.body.error : "", e.status);
  if (e instanceof TypeError) return failureText("", 0);
  return failureText(typeof e === "string" ? e : e instanceof Error ? e.message : String(e));
}

function failed(e: unknown): void {
  if (e instanceof ApiError && e.status === 401) return loggedOut("expired");
  toast(t("설정을 읽지 못했습니다: {error}", { error: errorText(e) }));
}

function report(saver: SettingsSaver, r: SaveResult): void {
  const label = labelOf(r.key);
  if (r.t === "saved") {
    if (r.undo) return toast(t("되돌렸습니다 · {label}", { label }));
    return toast(t("저장했습니다 · {label}", { label }), { label: t("되돌리기"), run: () => saver.set(r.key, r.before, true) });
  }
  if (r.t === "changed") return toast(t("그사이 설정 파일에서 바뀐 값을 보입니다 · {label}", { label }));
  if (r.error instanceof ApiError && r.error.status === 401) return loggedOut("expired");
  toast(t("저장하지 못했습니다 · {label}: {error}", { label, error: errorText(r.error) }));
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
        <span className="shrink-0 text-muted" role="img" aria-label={t("저장하는 중")} data-saving>
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
  const fits = (v: string) => v === "" || field.pattern.test(v);
  const commit = () => {
    const typed = text.trim();
    if (typed === shown) return setText(shown);
    if (!fits(typed)) {
      toast(t("저장하지 못했습니다 · {label}: {error}", { label, error: t(ERRORS.invalid) }));
      return setText(shown);
    }
    onSave(typed);
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
        else toast(`${label}: ${t(ERRORS.invalid)}`);
      }}
      onBlur={() => {
        editing.current = false;
        commit();
      }}
      placeholder={t("기본값")}
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
  const entry = text.trim();
  const ok = !entry || (dirs ? isAbsoluteDir(entry) : isPermissionRule(entry));
  const add = () => {
    if (!entry || !ok) return;
    if (!items.includes(entry)) onChange([...items, entry]);
    setText("");
  };
  return (
    <div className="rounded-xl bg-surface p-3.5" data-list={field}>
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[15px]">{labelText(field)}</span>
        {busy && (
          <span className="text-muted" role="img" aria-label={t("저장하는 중")} data-saving>
            <Spinner />
          </span>
        )}
      </div>
      <div className="text-xs text-muted">{hintText(field)}</div>
      {items.length > 0 && (
        <ul className="mt-2 divide-y divide-line border-y border-line">
          {items.map((item, i) => (
            <li key={i} className="flex items-center gap-2 py-2">
              <span className="min-w-0 flex-1 font-mono text-[13px] break-all">{item}</span>
              <button onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label={t("{item} 빼기", { item })} className="-my-2 -mr-2 flex size-11 shrink-0 items-center justify-center rounded-lg text-muted">
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
          aria-label={t("{label} 추가", { label: labelText(field) })}
          className={`min-w-0 flex-1 rounded-lg border bg-bg px-2.5 py-2 font-mono text-[16px] outline-none ${ok ? "border-line focus:border-accent" : "border-danger"}`}
        />
        <Button onClick={add} disabled={!entry || !ok}>
          {t("추가")}
        </Button>
      </div>
      {!ok && <div className="mt-1 text-xs text-danger">{dirs ? t("/로 시작하는 절대 경로로 적어 주세요") : t("도구 이름이나 도구(내용) 꼴로 적어 주세요")}</div>}
    </div>
  );
}

function ChoiceSheet(p: {
  title: string;
  values: string[];
  labels: Record<string, string>;
  hints?: Record<string, string>;
  defaultHint?: string;
  value: unknown;
  onPick: (v?: string) => void;
  onClose: () => void;
}) {
  return (
    <Sheet title={p.title} onClose={p.onClose}>
      <Choice label={t("기본값")} hint={p.defaultHint ?? t(DEFAULT_HINT)} selected={p.value === undefined} onClick={() => p.onPick(undefined)} />
      {p.values.map((v) => (
        <Choice key={v} label={p.labels[v] ?? v} hint={p.hints?.[v]} selected={p.value === v} onClick={() => p.onPick(v)} />
      ))}
    </Sheet>
  );
}

// Claude Code's own "default" entry is the 기본값 choice, which removes the key.
function ModelSheet({ value, models, onPick, onClose }: { value: unknown; models: ModelOption[]; onPick: (v?: string) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  const typed = text.trim();
  const fallback = models.find((m) => m.value === MODEL_DEFAULT)?.resolved;
  const listed = models.filter((m) => m.value !== MODEL_DEFAULT);
  return (
    <Sheet title={t("모델")} onClose={onClose}>
      <Choice
        label={t("기본값")}
        hint={fallback ? t("이 설정을 지우고 Claude Code 기본값({model})을 씁니다", { model: modelName(canonicalModel(fallback)) }) : t(DEFAULT_HINT)}
        selected={value === undefined}
        onClick={() => onPick(undefined)}
      />
      {typeof value === "string" && !listed.some((m) => m.value === value) && <Choice label={value} selected onClick={onClose} />}
      {listed.map((m) => (
        <Choice key={m.value} label={m.label} hint={m.value} selected={m.value === value} onClick={() => onPick(m.value)} />
      ))}
      <div className="mt-2 flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && MODEL_PATTERN.test(typed)) onPick(typed);
          }}
          placeholder={t("직접 입력 (예: opus[1m])")}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-2.5 py-2 font-mono text-[16px] outline-none focus:border-accent"
        />
        <Button disabled={!MODEL_PATTERN.test(typed)} onClick={() => onPick(typed)}>
          {t("적용")}
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
      <summary className="cursor-pointer text-[15px]">{t("나머지 설정 (읽기 전용)")}</summary>
      {notes.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs">
          {notes.map((n) => (
            <li key={n.key}>
              <span className="font-mono">{n.key}</span>
              <span className="text-muted"> · {Object.hasOwn(NOTE, n.reason) && t(NOTE[n.reason])}</span>
            </li>
          ))}
        </ul>
      )}
      <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-code p-2.5 font-mono text-[12px] leading-relaxed">{JSON.stringify(view.rest, null, 2)}</pre>
      <p className="mt-2 text-xs text-muted">{t("이 설정들은 노트북에서 고칩니다. 환경 변수 값은 가려서 보여 줍니다.")}</p>
    </details>
  );
}

// Turning Thinking off does not reach a model that always thinks; the hint names one when Claude Code lists one.
function thinkingHint(models: ModelOption[]): string {
  const always = models.find((m) => m.thinkingOff === false && m.resolved);
  return always
    ? t("끄면 thinking 없이 답합니다. {model} 같은 늘 생각하는 모델에는 쓰이지 않습니다", { model: modelName(canonicalModel(always.resolved!)) })
    : t(HINT.alwaysThinkingEnabled);
}

export function ClaudeSettingsSection({ part }: { part?: SettingsPart }) {
  const models = useApp((s) => s.options?.models) ?? NO_MODELS;
  const [saver, setSaver] = useState(shared);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [sheet, setSheet] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    if (shared) void shared.reload().catch((e: unknown) => live && failed(e));
    else
      io.read().then(
        (v) => {
          if (!shared) {
            const s: SettingsSaver = new SettingsSaver(v, io, (r) => report(s, r));
            shared = s;
          }
          if (live) setSaver(shared);
        },
        (e: unknown) => live && failed(e),
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
        <SectionTitle>{t("Claude Code 설정")}</SectionTitle>
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
  const hintOf = (key: string, base?: string) => (odd.has(key) && same(value(key), view.values[key]) ? t("여기서 고를 수 없는 값입니다") : base);
  const efforts = effortModels(models, view.values);
  const legacy = value(LEGACY_EFFORT);
  const inheriting = efforts.filter(({ model }) => inheritedEffort(model, value(modelEffortKey(model)), legacy)).map(({ model }) => modelName(model));
  const legacyHint = inheriting.length
    ? t("모델별 값이 없는 {models}에 쓰입니다. 여기서는 지울 수만 있습니다", { models: inheriting.join("·") })
    : t("모델별 값이 없는 이전 모델에 쓰입니다. 여기서는 지울 수만 있습니다");
  const open = sheet ? CLAUDE_SETTING_FIELDS.find((f) => f.key === sheet) : undefined;
  const openEffort = sheet ? efforts.find((e) => modelEffortKey(e.model) === sheet) : undefined;
  const afterClear = openEffort && inheritedEffort(openEffort.model, undefined, legacy);
  const pick = (key: string) => (v?: string) => {
    set(key, v);
    setSheet(null);
  };

  return (
    <section className="space-y-2">
      <SectionTitle>{t("Claude Code 설정")}</SectionTitle>
      <div className="px-1 font-mono text-xs break-all text-muted">
        {shortPath(view.path)}
        {view.exists ? "" : ` ${t("(없음, 바꾸면 만듭니다)")}`}
      </div>
      {view.problem ? (
        <div className="rounded-xl bg-surface p-3.5 text-sm">{t(PROBLEM[view.problem])}</div>
      ) : (
        <>
          <div className="divide-y divide-line rounded-xl bg-surface">
            {CLAUDE_SETTING_FIELDS.filter((f) => !LISTS.includes(f.key) && f.key !== LEGACY_EFFORT).map((f) => {
              const v = value(f.key);
              const busy = saver.busy(f.key);
              const hint = f.key === "model" && isDefaultModel(v) ? t(DEFAULT_MODEL_HINT) : hintOf(f.key, f.key === "alwaysThinkingEnabled" ? thinkingHint(models) : hintText(f.key));
              if (f.kind === "bool") {
                return (
                  <Row key={f.key} setting={f.key} label={labelText(f.key)} hint={hint} busy={busy}>
                    <Segmented
                      value={v === true ? "on" : v === false ? "off" : "default"}
                      options={[
                        ["default", t("기본")],
                        ["on", t("켬")],
                        ["off", t("끔")],
                      ]}
                      onChange={(x) => set(f.key, x === "default" ? undefined : x === "on")}
                    />
                  </Row>
                );
              }
              if (f.kind === "text" && f.key !== "model") {
                return (
                  <Row key={f.key} setting={f.key} label={labelText(f.key)} hint={hint} busy={busy}>
                    <TextInput field={f} label={labelText(f.key)} value={v} onSave={(text) => set(f.key, text)} />
                  </Row>
                );
              }
              return (
                <Row key={f.key} setting={f.key} label={labelText(f.key)} hint={hint} busy={busy} onClick={() => setSheet(f.key)}>
                  <span className="flex min-w-0 items-center gap-1 text-sm text-muted">
                    <span className="truncate">{valueText(f.key, v, models)}</span>
                    <Icon.chevronRight className="size-4 shrink-0" />
                  </span>
                </Row>
              );
            })}
          </div>
          {(efforts.length > 0 || legacy !== undefined) && (
            <div id="claude-effort" className="space-y-1">
              <div className="px-1 text-xs text-muted">{t("Effort는 모델마다 따로 저장합니다. /effort로 고른 값과 같습니다")}</div>
              <div className="divide-y divide-line rounded-xl bg-surface">
                {efforts.map(({ model }) => {
                  const key = modelEffortKey(model);
                  const inherited = inheritedEffort(model, value(key), legacy);
                  return (
                    <Row key={key} setting={key} label={`Effort · ${modelName(model)}`} hint={hintOf(key)} busy={saver.busy(key)} onClick={() => setSheet(key)}>
                      <span className="flex min-w-0 items-center gap-1 text-sm text-muted">
                        <span className="truncate">{inherited ? t("{level} (이전 모델 공통)", { level: EFFORT_LABEL[inherited] }) : valueText(key, value(key), models)}</span>
                        <Icon.chevronRight className="size-4 shrink-0" />
                      </span>
                    </Row>
                  );
                })}
                {legacy !== undefined && (
                  <Row setting={LEGACY_EFFORT} label={labelText(LEGACY_EFFORT)} hint={hintOf(LEGACY_EFFORT, legacyHint)} busy={saver.busy(LEGACY_EFFORT)} onClick={() => setSheet(LEGACY_EFFORT)}>
                    <span className="flex min-w-0 items-center gap-1 text-sm text-muted">
                      <span className="truncate">{valueText(LEGACY_EFFORT, legacy, models)}</span>
                      <Icon.chevronRight className="size-4 shrink-0" />
                    </span>
                  </Row>
                )}
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
            {t(
              "바꾸면 바로 저장합니다. 처음 고치기 전의 파일과 최근 10개를 같은 폴더에 백업합니다(10분 안에 이어 바꾼 것은 하나로). 새로 시작하는 세션부터 적용되고, 열려 있는 세션은 모델과 Effort를 그대로 씁니다.",
            )}
          </p>
        </>
      )}
      {open?.key === "model" && <ModelSheet value={value("model")} models={models} onPick={pick("model")} onClose={() => setSheet(null)} />}
      {open?.kind === "choice" && open.key !== LEGACY_EFFORT && (
        <ChoiceSheet
          title={labelText(open.key)}
          values={open.values}
          labels={choiceLabels(open.key)}
          hints={open.key === "permissions.defaultMode" ? modeHints() : undefined}
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
          defaultHint={afterClear ? t("이 설정을 지우고 이전 모델 공통 값({level})을 씁니다", { level: EFFORT_LABEL[afterClear] }) : undefined}
          value={value(sheet!)}
          onPick={pick(sheet!)}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === LEGACY_EFFORT && (
        <ChoiceSheet
          title={labelText(LEGACY_EFFORT)}
          values={typeof legacy === "string" ? [legacy] : []}
          labels={EFFORT_LABEL}
          defaultHint={t("이 설정을 지웁니다. 이전 모델도 모델별 값이나 Claude Code 기본값을 씁니다")}
          value={legacy}
          onPick={pick(LEGACY_EFFORT)}
          onClose={() => setSheet(null)}
        />
      )}
    </section>
  );
}
