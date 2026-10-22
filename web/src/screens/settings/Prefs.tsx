import { useState } from "react";
import { api } from "../../api.ts";
import { t, tc } from "../../i18n/index.ts";
import { setPrefs, usePrefs } from "../../prefs.ts";
import { refreshOptions, refreshSessions, useApp } from "../../state.ts";
import { SectionTitle, Switch, showError } from "./common.tsx";

export function PrefsSection() {
  const prefs = usePrefs();
  return (
    <section className="space-y-2">
      <SectionTitle>{t("입력")}</SectionTitle>
      <button
        role="switch"
        aria-checked={prefs.enterToSend}
        onClick={() => setPrefs({ enterToSend: !prefs.enterToSend })}
        className="flex w-full items-center gap-3 rounded-xl bg-surface p-3.5 text-left"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-[15px]">{t("Enter로 보내기")}</span>
          <span className="block text-xs text-muted">{t("켜면 Shift+Enter로 줄을 바꿉니다. 끄면 ⌘/Ctrl+Enter로 보냅니다.")}</span>
        </span>
        <Switch on={prefs.enterToSend} />
      </button>
    </section>
  );
}

export function ChatSection() {
  const prefs = usePrefs();
  return (
    <section className="space-y-2">
      <SectionTitle>{tc("settings section", "대화")}</SectionTitle>
      <button
        role="switch"
        aria-checked={prefs.thinkingOpen}
        onClick={() => setPrefs({ thinkingOpen: !prefs.thinkingOpen })}
        className="flex w-full items-center gap-3 rounded-xl bg-surface p-3.5 text-left"
        data-setting="thinking-open"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-[15px]">{t("Thinking 펼쳐 보기")}</span>
          <span className="block text-xs break-keep text-pretty text-muted">{t("대화와 에이전트 기록의 Thinking을 처음부터 펼쳐 보여 줍니다.")}</span>
        </span>
        <Switch on={prefs.thinkingOpen} />
      </button>
    </section>
  );
}

// A broker setting, so the list on every device follows it.
export function ListSection() {
  const saved = useApp((s) => s.options?.vscodeArchive);
  const [wanted, setWanted] = useState<boolean>();
  const on = wanted ?? saved === true;
  if (saved === undefined) return null;
  const turn = () => {
    const next = !on;
    setWanted(next);
    api.setVscodeArchive(next).then(
      () => void Promise.all([refreshOptions(), refreshSessions()]).then(() => setWanted(undefined)),
      (e: unknown) => {
        setWanted(undefined);
        showError(e, { config_unwritable: t("노트북에서 ccrc 설정 파일을 쓰지 못했습니다") });
      },
    );
  };
  return (
    <section className="space-y-2">
      <SectionTitle>{t("세션 목록")}</SectionTitle>
      <button role="switch" aria-checked={on} onClick={turn} className="flex w-full items-center gap-3 rounded-xl bg-surface p-3.5 text-left" data-setting="vscode-archive">
        <span className="min-w-0 flex-1">
          <span className="block text-[15px]">{t("VS Code에서 보관한 세션도 보관으로 보기")}</span>
          <span className="block text-xs break-keep text-pretty text-muted">
            {t(
              "VS Code의 Claude Code 확장에서 보관한 세션을 이 목록에서도 보관됨으로 보입니다. 확장이 한동안 쓰지 않아 자동으로 보관한 세션(기본 14일)도 들어옵니다. VS Code의 보관은 읽기만 하고 바꾸지 않습니다.",
            )}
          </span>
        </span>
        <Switch on={on} />
      </button>
    </section>
  );
}
