import type { ModelOption, NoticeInfo } from "../../../broker/src/protocol.ts";
import { k, t } from "../i18n/index.ts";
import { modelLabel } from "../labels.ts";

// Lines Claude Code writes in English that the app says in its own words; a model's name in them stays as written.
const LINES: [RegExp, string][] = [
  [/^(.+)'s safeguards stopped the response above · continuing once with that noted$/, k("{model} 모델의 안전장치가 위 응답을 멈췄습니다 · 이를 알리고 한 번 이어 갑니다")],
  [
    /^Compacted using a summary written while you were away · turn off with "idleCompaction": false in settings\.json$/,
    k('자리를 비운 사이 써 둔 요약으로 대화를 압축했습니다 · 끄려면 settings.json에 "idleCompaction": false'),
  ],
];

// Whether a notice is about a model's safeguards.
export const safeguarded = (n: NoticeInfo): boolean => n.notice !== "line" || /'s safeguards /.test(n.text);

// A model's name in a sentence: the label of its own entry in the list, never that of the default it may stand for.
export function modelName(models: ModelOption[], id: string): string {
  return modelLabel(models.filter((m) => m.value !== "default"), id);
}

// A notice in the app's words, and Claude Code's own when they say more: the original and the API's reason.
export function noticeText(n: NoticeInfo, models: ModelOption[]): { text: string; more?: string } {
  const name = (id?: string) => (id ? modelName(models, id) : "Claude");
  const said = [n.text, n.detail].filter(Boolean).join("\n\n") || undefined;
  if (n.notice === "fallback") {
    const vars = { model: name(n.model), fallback: name(n.fallback) };
    const text = n.local
      ? t("{model} 모델의 안전장치에 걸려 서브에이전트나 곁질문의 답 하나를 {fallback} 모델이 했습니다", vars)
      : t("{model} 모델의 안전장치에 걸려 이 세션은 {fallback} 모델로 바뀌었습니다", vars);
    return { text, more: said };
  }
  if (n.notice === "refusal") return { text: t("{model} 모델의 안전장치가 응답을 막았습니다", { model: name(n.model) }), more: said };
  for (const [line, ko] of LINES) {
    const m = line.exec(n.text);
    if (!m) continue;
    const text = t(ko, { model: m[1] ?? "" });
    return text === n.text ? { text } : { text, more: n.text };
  }
  return { text: n.text };
}
