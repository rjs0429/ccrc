import { LEGACY_EFFORT, MODEL_DEFAULT, MODEL_EFFORTS, canonicalModel, effortKeyModel, isModelName, takesLegacyEffort } from "../../../../broker/src/admin-protocol.ts";
import type { ModelOption } from "../../../../broker/src/protocol.ts";
import { EFFORT_LABEL, MODE_LABEL } from "../../labels.ts";

const THEME_LABEL: Record<string, string> = {
  auto: "시스템 따라가기",
  dark: "어둡게",
  light: "밝게",
  "dark-daltonized": "어둡게 (색각 보정)",
  "light-daltonized": "밝게 (색각 보정)",
  "dark-ansi": "어둡게 (ANSI)",
  "light-ansi": "밝게 (ANSI)",
};

export const CHOICE_LABEL: Record<string, Record<string, string>> = {
  "permissions.defaultMode": MODE_LABEL,
  theme: THEME_LABEL,
};

export const PROBLEM: Record<string, string> = {
  not_json: "설정 파일에 주석이 있거나 엄격한 JSON이 아니어서 여기서는 바꾸지 않습니다. 노트북에서 고쳐 주세요.",
  not_object: "설정 파일의 형식이 맞지 않아 여기서는 바꾸지 않습니다.",
};

export const ERRORS: Record<string, string> = {
  ...PROBLEM,
  invalid: "값이 올바르지 않습니다",
  not_allowed: "여기서 바꿀 수 없는 설정입니다",
  changed: "설정 파일이 계속 바뀌고 있습니다",
};

// Why a save failed: status is the broker's answer, 0 when it could not be reached, and code its error code or a file
// problem's.
export function failureText(code: string, status?: number): string {
  if (Object.hasOwn(ERRORS, code)) return ERRORS[code];
  if (status === 0) return "노트북에 연결하지 못했습니다";
  if (status === undefined) return `알 수 없는 오류입니다 (${code})`;
  return status >= 500 ? "노트북에서 설정 파일을 쓰지 못했습니다" : `노트북이 요청을 받지 않았습니다 (${code || `HTTP ${status}`})`;
}

export const isDefaultModel = (v: unknown): boolean => typeof v === "string" && v.toLowerCase() === MODEL_DEFAULT;

// "claude-opus-5-5" as "Opus 5.5"; other names stay as they are.
export function modelName(name: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/.exec(name);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}` : name;
}

// The models whose effort Claude Code keeps: those it offers with effort levels, then others the file names, each
// with the levels that can be saved for it.
export function effortModels(models: ModelOption[], values: Record<string, unknown>): { model: string; levels: string[] }[] {
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

// The level a model without its own effort takes from the top-level effortLevel, when Claude Code gives it that.
export function inheritedEffort(model: string, own: unknown, legacy: unknown): string | undefined {
  return own === undefined && typeof legacy === "string" && MODEL_EFFORTS.includes(legacy) && takesLegacyEffort(model) ? legacy : undefined;
}

export function valueText(key: string, v: unknown, models: ModelOption[]): string {
  if (v === undefined || v === null) return "기본값";
  if (typeof v === "boolean") return v ? "켬" : "끔";
  if (key === "model") return (!isDefaultModel(v) && models.find((m) => m.value === v)?.label) || String(v);
  const labels = effortKeyModel(key) || key === LEGACY_EFFORT ? EFFORT_LABEL : CHOICE_LABEL[key];
  return labels && typeof v === "string" && Object.hasOwn(labels, v) ? labels[v] : String(v);
}
