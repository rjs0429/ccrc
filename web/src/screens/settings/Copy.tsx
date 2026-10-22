import { useEffect, useState } from "react";
import { t } from "../../i18n/index.ts";
import { minutesText, sizeText } from "../../labels.ts";
import { copySize, forgetCopies, onCopies } from "../../offline.ts";
import { COPY_IDLE_MINUTES, COPY_SESSIONS } from "../../offlineCopy.ts";
import { setPrefs, usePrefs } from "../../prefs.ts";
import { toast, useApp } from "../../state.ts";
import { SectionTitle, Switch } from "./common.tsx";

// The phone's copy of recent conversations: on or off, how much it holds, and a way to drop it now.
export function CopySection() {
  const prefs = usePrefs();
  const idle = useApp((s) => s.me?.leaseIdleMinutes) ?? COPY_IDLE_MINUTES;
  const [held, setHeld] = useState<{ count: number; bytes: number }>();
  useEffect(() => {
    const count = () => void copySize().then(setHeld);
    count();
    return onCopies(count);
  }, []);
  const forget = (said?: string) => void forgetCopies().then(() => said && toast(said));

  return (
    <section className="space-y-2" data-copy-section>
      <SectionTitle>{t("휴대폰에 저장한 대화")}</SectionTitle>
      <div className="rounded-xl bg-surface">
        <button
          role="switch"
          aria-checked={prefs.keepCopies}
          onClick={() => {
            setPrefs({ keepCopies: !prefs.keepCopies });
            if (prefs.keepCopies) forget();
          }}
          className="flex w-full items-center gap-3 p-3.5 text-left"
          data-copy-switch
        >
          <span className="min-w-0 flex-1">
            <span className="block text-[15px]">{t("최근 대화를 휴대폰에 저장")}</span>
            <span className="block text-xs break-keep text-muted">
              {t("노트북에 연결할 수 없을 때 최근에 연 대화 {n}개의 끝부분을 읽기 전용으로 봅니다. 도구 입력·결과, 명령 출력, 사진은 저장하지 않습니다.", { n: COPY_SESSIONS })}
            </span>
          </span>
          <Switch on={prefs.keepCopies} />
        </button>
        <div className="flex min-h-12 items-center gap-3 border-t border-line px-3.5 py-1.5 text-sm">
          <span className="min-w-0 flex-1 text-muted" data-copy-held>
            {held?.count ? t("저장한 대화 {n}개 · {size}", { n: held.count, size: sizeText(held.bytes) }) : t("저장한 대화가 없습니다")}
          </span>
          {Boolean(held?.count) && (
            <button onClick={() => forget(t("휴대폰에 저장한 대화를 지웠습니다"))} className="min-h-11 shrink-0 px-2 font-medium text-danger" data-copy-forget>
              {t("지우기")}
            </button>
          )}
        </div>
      </div>
      <p className="px-1 text-xs break-keep text-muted">
        {t("로그아웃하거나 비밀번호를 바꾸면 지웁니다. 노트북에 연결하지 못한 채 {time}이 지나면(로그인이 끝나는 때) 보이지 않고 지워집니다.", { time: minutesText(idle) })}
      </p>
    </section>
  );
}
