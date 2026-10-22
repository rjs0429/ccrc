import type { Lang } from "../../../broker/src/lang.ts";
import { en } from "./en/index.ts";

// Screens write their text in Korean through t(), and the Korean sentence is the key of the English dictionary
// (en/g1.ts–g5.ts). The language can change while the app runs, so t() runs where the text is shown: a sentence kept
// in a table at module level is marked with k() and handed to t() when it is shown.
export type { Lang };
// "auto" follows the device's language.
export type LangPref = "auto" | Lang;
export type Vars = Record<string, string | number>;

export const LANG_PREFS: LangPref[] = ["auto", "ko", "en"];
export const LANG_NAMES: Record<Lang, string> = { ko: "한국어", en: "English" };

let current: Lang = "ko";
let currentLocale = "ko-KR";
const listeners = new Set<() => void>();

export const lang = (): Lang => current;

// The locale dates and numbers are written in.
export const locale = (): string => currentLocale;

// What the screens are drawn for: the language and its locale, since en-US and en-GB write times differently.
export const langKey = (): string => `${current} ${currentLocale}`;

export function onLang(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

// What "auto" means: Korean when the device's first preferred language is Korean, English otherwise.
export function deviceLang(languages: readonly string[]): Lang {
  return languages[0]?.toLowerCase().startsWith("ko") ? "ko" : "en";
}

export function resolveLang(pref: unknown, languages: readonly string[]): Lang {
  return pref === "ko" || pref === "en" ? pref : deviceLang(languages);
}

// English follows the device's own English locale (en-GB, en-AU, ...) when it lists one, else en-US.
export function localeOf(l: Lang, languages: readonly string[]): string {
  if (l === "ko") return "ko-KR";
  for (const tag of languages) {
    if (!/^en(-|$)/i.test(tag)) continue;
    try {
      return Intl.getCanonicalLocales(tag)[0];
    } catch {}
  }
  return "en-US";
}

export function setLang(l: Lang, languages: readonly string[] = []): void {
  const loc = localeOf(l, languages);
  if (l === current && loc === currentLocale) return;
  current = l;
  currentLocale = loc;
  for (const listener of [...listeners]) listener();
}

// The sentence in the current language: its English when the dictionary has it, else the Korean.
export function translate(ko: string): string {
  return current === "en" && Object.hasOwn(en, ko) ? en[ko] : ko;
}

const count = (v: string | number): number => (typeof v === "number" ? v : Number(v.replace(/[^\d.-]/g, "")));

// `{name}` takes vars.name. `{name|one|other}` takes the first form when vars.name is 1 and the second otherwise, with
// `#` in it standing for the value. A name not in vars stays as written.
export function fill(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)(?:\|([^|{}]*)\|([^|{}]*))?\}/g, (all, name: string, one?: string, other?: string) => {
    if (!Object.hasOwn(vars, name)) return all;
    const v = vars[name];
    return one === undefined ? String(v) : (count(v) === 1 ? one : (other ?? "")).replaceAll("#", String(v));
  });
}

export function t(ko: string, vars?: Vars): string {
  return fill(translate(ko), vars);
}

// t() for a sentence that one place shows with another English than the rest (a toast's "Undo" where the rewind sheet
// says "Rewind", both 되돌리기). The dictionary keeps it as "place|sentence".
export function tc(place: string, ko: string, vars?: Vars): string {
  const key = `${place}|${ko}`;
  return fill(current === "en" && Object.hasOwn(en, key) ? en[key] : translate(ko), vars);
}

export function k(ko: string): string {
  return ko;
}
