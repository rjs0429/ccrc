import type { Lang } from "../lang.ts";

// What a VS Code tab and the phone are told when the session a tab opens is held by another process: it moved from an
// idle tab, or opened as a copy. The broker writes in the phone's language, the wrapper alone in its environment's.

export type HolderKind = "vscode" | "terminal" | "background" | "other";

// The kind of process that holds a session, from the name the session registry gives it (live.ts).
export function holderKind(host: string | undefined): HolderKind {
  return host === "VS Code" ? "vscode" : host === "Terminal" ? "terminal" : host === "Background" ? "background" : "other";
}

export interface HoldText {
  holder: Record<HolderKind, string>;
  // For the tab that opened a copy: where the original is open, and whether a turn was running there.
  copy: (holder: string, answering: boolean) => string;
  // For the tab the session moved to, and the one it moved from.
  moved: string;
  stopped: string;
  // The start of a copy's name, the second copy of a copy being 2.
  copyPrefix: (n: number) => string;
}

const KO: HoldText = {
  holder: { vscode: "VS Code의 다른 탭", terminal: "터미널", background: "백그라운드 세션", other: "다른 Claude Code 프로세스" },
  copy: (h, answering) =>
    `이 대화는 ${h}에서 ${answering ? "답하는 중이라" : "열려 있어"} 복사본으로 열었습니다. 여기서 보내는 메시지는 원본에 들어가지 않습니다. 원본을 이으려면 이 탭을 닫고 ${h}에서 이어 가세요.`,
  moved: "VS Code의 다른 탭에서 쉬고 있던 이 대화를 여기로 옮겼습니다. 그 탭은 멈췄습니다.",
  stopped:
    "이 대화를 VS Code의 다른 탭에서 열어 여기서는 멈췄습니다. 이 탭은 닫아도 됩니다. 여기서 다시 보내면 이 탭으로 옮겨 오지만, 그사이 다른 탭에서 주고받은 내용은 여기에 보이지 않습니다.",
  copyPrefix: (n) => (n === 1 ? "(복사본)" : `(복사본 ${n})`),
};

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const EN: HoldText = {
  holder: { vscode: "another VS Code tab", terminal: "a terminal", background: "a background session", other: "another Claude Code process" },
  copy: (h, answering) =>
    `${answering ? `${capital(h)} is still answering in this conversation` : `This conversation is open in ${h}`}, so it opened here as a copy. Messages sent here don't go to the original. To continue the original, close this tab and go on in ${h}.`,
  moved: "This conversation was idle in another VS Code tab and moved here. That tab has stopped.",
  stopped: "This conversation was opened in another VS Code tab, so it stopped here. You can close this tab. Sending here moves it back, but what was said in the other tab meanwhile isn't shown here.",
  copyPrefix: (n) => (n === 1 ? "(copy)" : `(copy ${n})`),
};

export const HOLD_TEXT: Record<Lang, HoldText> = { ko: KO, en: EN };

// The language of an environment's locale: Korean for ko, English otherwise.
export function envLang(env: NodeJS.ProcessEnv): Lang {
  return /^ko([_.@-]|$)/i.test(env.LC_ALL || env.LC_MESSAGES || env.LANG || "") ? "ko" : "en";
}
