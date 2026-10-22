import { useState } from "react";
import { Choice, Row, Sheet } from "../../components/ui.tsx";
import { autoLang, setLangPref } from "../../i18n/device.ts";
import { LANG_NAMES, LANG_PREFS, t, type LangPref } from "../../i18n/index.ts";
import { usePrefs } from "../../prefs.ts";

// Kept on this device, so the login screen shows it too. The Korean screen names it in both languages.
export function LanguageRow() {
  const saved = usePrefs().lang;
  const pref: LangPref = LANG_PREFS.includes(saved) ? saved : "auto";
  const [open, setOpen] = useState(false);
  const pick = (p: LangPref) => {
    setOpen(false);
    setLangPref(p);
  };
  return (
    <>
      <Row label={t("언어 / Language")} value={pref === "auto" ? t("자동") : LANG_NAMES[pref]} onClick={() => setOpen(true)} />
      {open && (
        <Sheet title={t("언어 / Language")} onClose={() => setOpen(false)}>
          <div className="space-y-0.5" data-language-sheet>
            <Choice
              label={t("자동 (기기 언어)")}
              hint={t("기기 언어가 한국어면 한국어, 아니면 영어로 보입니다. 지금 {lang}", { lang: LANG_NAMES[autoLang()] })}
              selected={pref === "auto"}
              onClick={() => pick("auto")}
            />
            <Choice label={LANG_NAMES.ko} selected={pref === "ko"} onClick={() => pick("ko")} />
            <Choice label={LANG_NAMES.en} selected={pref === "en"} onClick={() => pick("en")} />
          </div>
        </Sheet>
      )}
    </>
  );
}
