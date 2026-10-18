import { getPrefs, setPrefs } from "../prefs.ts";
import { lang, onLang, resolveLang, setLang, type LangPref } from "./index.ts";

const languages = (): readonly string[] => (navigator.languages?.length ? navigator.languages : [navigator.language]);

function apply(): void {
  setLang(resolveLang(getPrefs().lang, languages()), languages());
}

// The language this browser chose, or the device's; <html lang> follows it, and "auto" follows the device as it changes.
export function startLang(): void {
  onLang(() => (document.documentElement.lang = lang()));
  apply();
  document.documentElement.lang = lang();
  addEventListener("languagechange", apply);
}

export function setLangPref(pref: LangPref): void {
  setPrefs({ lang: pref });
  apply();
}

// The language "auto" stands for on this device.
export const autoLang = () => resolveLang("auto", languages());
