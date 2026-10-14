import { useEffect, useState, type ReactNode } from "react";
import {
  CLAUDE_SETTING_FIELDS,
  isAbsoluteDir,
  isPermissionRule,
  type ClaudeSettingsView,
  type SettingField,
} from "../../../../broker/src/admin-protocol.ts";
import type { ModelOption } from "../../../../broker/src/protocol.ts";
import { ApiError, request } from "../../api.ts";
import { Button, Choice, Icon, Sheet, Spinner } from "../../components/ui.tsx";
import { EFFORT_LABEL, MODE_HINT, MODE_LABEL, shortPath } from "../../labels.ts";
import { toast, useApp, type SettingsPart } from "../../state.ts";
import { SectionTitle, Segmented, showError } from "./common.tsx";

type Values = Record<string, unknown>;
type ChoiceField = Extract<SettingField, { kind: "choice" }>;

const NO_MODELS: ModelOption[] = [];
const LISTS = ["permissions.allow", "permissions.ask", "permissions.deny", "permissions.additionalDirectories"];
const MODEL_PATTERN = (CLAUDE_SETTING_FIELDS.find((f) => f.key === "model") as Extract<SettingField, { kind: "text" }>).pattern;

const LABEL: Record<string, string> = {
  model: "모델",
  "permissions.defaultMode": "기본 권한 모드",
  "permissions.allow": "허용 규칙",
  "permissions.ask": "확인 규칙",
  "permissions.deny": "거부 규칙",
  "permissions.additionalDirectories": "추가 폴더",
  effortLevel: "Effort",
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
  autoCompactEnabled: "context가 차면 이전 대화를 요약합니다",
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
  effortLevel: EFFORT_LABEL,
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
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// What saving writes for a draft value: an empty text or list removes the key.
function saved(v: unknown): unknown {
  return v === "" || (Array.isArray(v) && v.length === 0) ? undefined : v;
}

function changesOf(view: ClaudeSettingsView, draft: Values): Values {
  const out: Values = {};
  for (const f of CLAUDE_SETTING_FIELDS) {
    const after = saved(draft[f.key]);
    if (!same(after, view.values[f.key])) out[f.key] = after ?? null;
  }
  return out;
}

function valueText(key: string, v: unknown, models: ModelOption[]): string {
  if (v === undefined || v === null) return "기본값";
  if (typeof v === "boolean") return v ? "켬" : "끔";
  if (key === "model") return models.find((m) => m.value === v)?.label ?? String(v);
  const labels = CHOICE_LABEL[key];
  return labels && typeof v === "string" && Object.hasOwn(labels, v) ? labels[v] : String(v);
}

function diffLines(key: string, before: unknown, after: unknown, models: ModelOption[]): ["-" | "+", string][] {
  if (LISTS.includes(key)) {
    const b = Array.isArray(before) ? before.map(String) : [];
    const a = Array.isArray(after) ? after.map(String) : [];
    return [...b.filter((x) => !a.includes(x)).map((x): ["-", string] => ["-", x]), ...a.filter((x) => !b.includes(x)).map((x): ["+", string] => ["+", x])];
  }
  return [...(before === undefined ? [] : [["-", valueText(key, before, models)] as ["-", string]]), ["+", valueText(key, after, models)]];
}

function Row({ label, hint, onClick, children }: { label: string; hint?: string; onClick?: () => void; children: ReactNode }) {
  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px]">{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
      {children}
    </>
  );
  return onClick ? (
    <button onClick={onClick} className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left">
      {body}
    </button>
  ) : (
    <div className="flex items-center gap-3 px-3.5 py-2.5">{body}</div>
  );
}

function ListEditor({ field, items, onChange }: { field: string; items: string[]; onChange: (items: string[]) => void }) {
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
    <div className="rounded-xl bg-surface p-3.5">
      <div className="text-[15px]">{LABEL[field]}</div>
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

function ChoiceSheet({ field, value, onPick, onClose }: { field: ChoiceField; value: unknown; onPick: (v?: string) => void; onClose: () => void }) {
  const labels = CHOICE_LABEL[field.key] ?? {};
  return (
    <Sheet title={LABEL[field.key]} onClose={onClose}>
      <Choice label="기본값" hint="이 설정을 지우고 Claude Code 기본값을 씁니다" selected={value === undefined} onClick={() => onPick(undefined)} />
      {field.values.map((v) => (
        <Choice key={v} label={labels[v] ?? v} hint={field.key === "permissions.defaultMode" ? MODE_HINT[v] : undefined} selected={value === v} onClick={() => onPick(v)} />
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

function ConfirmSheet(p: { view: ClaudeSettingsView; changes: Values; models: ModelOption[]; saving: boolean; onSave: () => void; onClose: () => void }) {
  return (
    <Sheet title="바꿀 내용" onClose={p.onClose}>
      <div className="space-y-3">
        {Object.keys(p.changes).map((key) => (
          <div key={key}>
            <div className="text-sm">
              <span className="font-medium">{LABEL[key]}</span> <span className="font-mono text-xs text-muted">{key}</span>
            </div>
            <pre className="mt-1 overflow-x-auto rounded-lg bg-code p-2 font-mono text-[12px] leading-relaxed">
              {diffLines(key, p.view.values[key], p.changes[key] ?? undefined, p.models).map(([sign, text], i) => (
                <div key={i} className={sign === "+" ? "text-ok" : "text-danger"}>
                  {sign} {text}
                </div>
              ))}
            </pre>
          </div>
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        <Button className="flex-1" onClick={p.onClose}>
          취소
        </Button>
        <Button kind="primary" className="flex-1" disabled={p.saving} onClick={p.onSave}>
          {p.saving ? "저장하는 중…" : "저장"}
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

export function ClaudeSettingsSection({ part }: { part?: SettingsPart }) {
  const models = useApp((s) => s.options?.models) ?? NO_MODELS;
  const [view, setView] = useState<ClaudeSettingsView>();
  const [draft, setDraft] = useState<Values>({});
  const [sheet, setSheet] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // keep: draft values to lay over what was read, such as unsaved changes after the file changed.
  const load = async (keep: Values = {}) => {
    try {
      const v = await request<ClaudeSettingsView>("GET", "/api/claude-settings");
      setView(v);
      setDraft({ ...v.values, ...keep });
    } catch (e) {
      showError(e, ERRORS);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (view && part) document.getElementById(`claude-${part}`)?.scrollIntoView({ block: "start" });
  }, [Boolean(view), part]);

  if (!view) {
    return (
      <section className="space-y-2">
        <SectionTitle>Claude Code 설정</SectionTitle>
        <div className="flex justify-center rounded-xl bg-surface p-4 text-muted">
          <Spinner />
        </div>
      </section>
    );
  }

  const changes = changesOf(view, draft);
  const count = Object.keys(changes).length;
  const set = (key: string, v: unknown) => setDraft((d) => ({ ...d, [key]: v }));
  const list = (key: string) => (Array.isArray(draft[key]) ? (draft[key] as unknown[]).map(String) : []);
  const badText = (f: SettingField) => f.kind === "text" && typeof draft[f.key] === "string" && draft[f.key] !== "" && !f.pattern.test(draft[f.key] as string);
  const odd = new Set(view.notes.filter((n) => n.reason === "value").map((n) => n.key));
  const open = sheet && sheet !== "confirm" ? CLAUDE_SETTING_FIELDS.find((f) => f.key === sheet) : undefined;
  const pick = (v?: string) => {
    if (open) set(open.key, v);
    setSheet(null);
  };

  const save = async () => {
    setSaving(true);
    try {
      const v = await request<ClaudeSettingsView>("PUT", "/api/claude-settings", { changes, baseHash: view.hash });
      setView(v);
      setDraft({ ...v.values });
      toast("Claude Code 설정을 저장했습니다");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        await load(Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v ?? undefined])));
        toast("그사이 파일이 바뀌어 다시 불러왔습니다. 확인하고 다시 저장하세요");
      } else {
        showError(e, ERRORS);
        if (e instanceof ApiError && e.status === 422) await load();
      }
    } finally {
      setSaving(false);
      setSheet(null);
    }
  };

  return (
    <section className="space-y-2">
      <SectionTitle>Claude Code 설정</SectionTitle>
      <div className="px-1 font-mono text-xs break-all text-muted">
        {shortPath(view.path)}
        {view.exists ? "" : " (없음, 저장하면 만듭니다)"}
      </div>
      {view.problem ? (
        <div className="rounded-xl bg-surface p-3.5 text-sm">{PROBLEM[view.problem]}</div>
      ) : (
        <>
          <div className="divide-y divide-line rounded-xl bg-surface">
            {CLAUDE_SETTING_FIELDS.filter((f) => !LISTS.includes(f.key)).map((f) => {
              const v = draft[f.key];
              const hint = odd.has(f.key) && same(v, view.values[f.key]) ? "여기서 고를 수 없는 값입니다" : HINT[f.key];
              if (f.kind === "bool") {
                return (
                  <Row key={f.key} label={LABEL[f.key]} hint={hint}>
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
                  <Row key={f.key} label={LABEL[f.key]} hint={hint}>
                    <input
                      value={typeof v === "string" ? v : ""}
                      onChange={(e) => set(f.key, e.target.value)}
                      placeholder="기본값"
                      autoCapitalize="none"
                      className={`w-32 rounded-lg border bg-bg px-2.5 py-1.5 text-right text-[16px] outline-none ${badText(f) ? "border-danger" : "border-line focus:border-accent"}`}
                    />
                  </Row>
                );
              }
              return (
                <Row key={f.key} label={LABEL[f.key]} hint={hint} onClick={() => setSheet(f.key)}>
                  <span className="flex min-w-0 items-center gap-1 text-sm text-muted">
                    <span className="truncate">{valueText(f.key, v, models)}</span>
                    <Icon.chevronRight className="size-4 shrink-0" />
                  </span>
                </Row>
              );
            })}
          </div>
          <div id="claude-permissions" className="scroll-mt-4 space-y-2">
            {LISTS.map((key) => (
              <ListEditor key={key} field={key} items={list(key)} onChange={(items) => set(key, items)} />
            ))}
          </div>
          <div className="flex gap-2">
            <Button className="flex-1" disabled={!count} onClick={() => setDraft({ ...view.values })}>
              변경 취소
            </Button>
            <Button kind="primary" className="flex-1" disabled={!count || CLAUDE_SETTING_FIELDS.some(badText)} onClick={() => setSheet("confirm")}>
              {count ? `저장 (${count})` : "저장"}
            </Button>
          </div>
          <Rest view={view} />
          <p className="px-1 text-xs leading-relaxed text-muted">저장할 때마다 이전 파일을 같은 폴더에 백업합니다(최근 10개). 열려 있는 세션에는 바로 반영되지 않을 수 있습니다.</p>
        </>
      )}
      {sheet === "confirm" && <ConfirmSheet view={view} changes={changes} models={models} saving={saving} onSave={() => void save()} onClose={() => setSheet(null)} />}
      {open?.key === "model" && <ModelSheet value={draft.model} models={models} onPick={pick} onClose={() => setSheet(null)} />}
      {open?.kind === "choice" && <ChoiceSheet field={open} value={draft[open.key]} onPick={pick} onClose={() => setSheet(null)} />}
    </section>
  );
}
