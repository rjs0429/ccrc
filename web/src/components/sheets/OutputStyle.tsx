import { useEffect, useState } from "react";
import type { OutputStyleInfo } from "../../../../broker/src/protocol.ts";
import { k, t } from "../../i18n/index.ts";
import { errorText } from "../../labels.ts";
import { call } from "../../state.ts";
import { Choice, Sheet } from "../ui.tsx";
import { Failed, Waiting } from "./parts.tsx";
import type { SheetProps } from "./types.ts";

// Claude Code's built-in styles; custom styles show by name only, as in VS Code.
const BUILT_IN_HINT: Record<string, string> = {
  default: k("Claude Code의 기본 응답 방식"),
  Proactive: k("바로 실행하고, 묻는 일을 줄이며, 계획보다 실행을 앞세웁니다"),
  Concise: k("결과부터 짧게 답하고 서두와 진행 설명을 뺍니다"),
  Explanatory: k("구현 선택과 코드베이스의 패턴을 설명합니다"),
  Learning: k("중간에 멈추고 작은 코드 조각을 직접 써 보게 합니다"),
};

export function outputStyleLabel(name: string): string {
  return name === "default" ? "Default" : name;
}

export function OutputStyleSheet({ sessionId, onClose }: SheetProps) {
  const [info, setInfo] = useState<OutputStyleInfo>();
  const [error, setError] = useState<string>();
  const [round, setRound] = useState(0);
  const [saving, setSaving] = useState<string>();

  useEffect(() => {
    let live = true;
    setError(undefined);
    call(sessionId, "output_style")
      .then(
        (r) => live && setInfo(r),
        (e: Error) => live && setError(errorText(e.message)),
      );
    return () => {
      live = false;
    };
  }, [sessionId, round]);

  const pick = (style: string) => {
    if (saving) return;
    if (style === info?.current) return onClose();
    setSaving(style);
    setError(undefined);
    call(sessionId, "set_output_style", { style })
      .then(onClose, (e: Error) => setError(errorText(e.message)))
      .finally(() => setSaving(undefined));
  };

  return (
    <Sheet title={t("출력 스타일")} onClose={onClose}>
      {info?.available.map((s) => (
        <Choice
          key={s}
          label={outputStyleLabel(s)}
          hint={Object.hasOwn(BUILT_IN_HINT, s) ? t(BUILT_IN_HINT[s]) : undefined}
          selected={(saving ?? info.current) === s}
          onClick={() => pick(s)}
        />
      ))}
      {info && <div className="mt-2 px-3 text-xs text-muted">{t("고른 스타일은 이 프로젝트의 .claude/settings.local.json에 저장되어 다음 세션에도 쓰입니다")}</div>}
      {!info && !error && <Waiting text={t("출력 스타일을 불러오는 중입니다")} />}
      {saving && <Waiting text={t("바꾸는 중입니다")} />}
      {error && <Failed text={error} onRetry={info ? undefined : () => setRound((r) => r + 1)} />}
    </Sheet>
  );
}
