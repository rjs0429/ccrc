import type { LiveState, ModelOption } from "../../../../broker/src/protocol.ts";
import { t } from "../../i18n/index.ts";
import { findModel } from "../../labels.ts";
import { modelName } from "../notices.ts";

// A model's id without its [1m] window or a date the API may add.
const base = (id: string) => id.replace(/\[1m\]$/i, "").replace(/-\d{8}$/, "");

// The API id a model choice stands for: an id as it is, a name such as "opus" or "default" through the model list. None
// when it cannot be told, as for an id of another provider's form.
function idOf(models: ModelOption[], model?: string): string | undefined {
  const id = model?.startsWith("claude-") ? model : findModel(models, model)?.resolved;
  return id?.startsWith("claude-") ? base(id) : undefined;
}

// Why the model chip of a running session is marked, said in the model sheet: the latest response came from another
// model than the chip names, or a model's safeguards moved the session to the one it names. None when neither holds.
export function modelMark(models: ModelOption[], state?: LiveState): string | undefined {
  if (!state) return undefined;
  const chosen = idOf(models, state.model);
  const answered = state.answered?.startsWith("claude-") ? base(state.answered) : undefined;
  const swap = state.swapped;
  const to = swap && base(swap.to);
  const moved = swap ? t("{from} 모델의 안전장치가 메시지를 막아 이 세션을 {to} 모델로 바꿨습니다.", { from: modelName(models, swap.from), to: modelName(models, swap.to) }) : "";
  if (chosen && answered && chosen !== answered) {
    const last = t("마지막 답은 {model} 모델이 했습니다.", { model: modelName(models, answered) });
    return to === answered ? `${last} ${moved}` : last;
  }
  if (to && (chosen ?? answered) === to) return `${moved} ${t("다른 모델을 고르면 다음 답부터 바뀝니다.")}`;
  return undefined;
}
