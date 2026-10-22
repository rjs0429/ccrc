// The languages the phone app shows and the broker writes notifications and exported conversations in.
export type Lang = "ko" | "en";

export const LANGS: Lang[] = ["ko", "en"];

export const isLang = (v: unknown): v is Lang => v === "ko" || v === "en";
