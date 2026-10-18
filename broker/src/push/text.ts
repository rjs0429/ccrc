import type { Lang } from "../lang.ts";
import type { PendingKind } from "../protocol.ts";
import type { ErrorReason, TurnOutcome } from "../sessions/outcome.ts";

// What notifications say, in the language each device chose.
export interface PushText {
  request: Record<PendingKind, string>;
  localOnly: string;
  ended: Record<Exclude<TurnOutcome, "interrupted" | "local">, string>;
  reason: Record<Exclude<ErrorReason, "api">, string>;
  // When a usage limit resets, in the broker's time zone, with the date when it is not today.
  resets: (at: number, now: number) => string;
  files: (n: number) => string;
  sent: string;
  more: (n: number) => string;
  claude: string;
  test: string;
  update: (tag: string) => string;
}

const pad = (n: number) => String(n).padStart(2, "0");

const KO: PushText = {
  request: { permission: "권한 요청", question: "질문이 있습니다", plan: "계획 승인 요청", dialog: "확인 요청", elicitation: "입력 요청" },
  localOnly: "VS Code에서 답변하기",
  ended: { done: "작업을 마쳤습니다", error: "오류로 끝났습니다", limit: "사용 한도에 걸렸습니다", crashed: "Claude Code가 비정상 종료되었습니다" },
  reason: { context: "문맥 한도", login: "로그인 필요", model: "모델 없음" },
  resets: (at, now) => {
    const d = new Date(at);
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return `${d.toDateString() === new Date(now).toDateString() ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`} 초기화`;
  },
  files: (n) => `파일 ${n}개`,
  sent: "파일을 보냈습니다",
  more: (n) => ` 외 ${n}개`,
  claude: "Claude의 알림",
  test: "테스트 알림입니다",
  update: (tag) => `새 버전 ${tag}: 노트북에서 ccrc update 로 적용합니다`,
};

const EN: PushText = {
  request: {
    permission: "Waiting for your permission",
    question: "Claude has a question",
    plan: "Plan ready for your review",
    dialog: "Waiting for your confirmation",
    elicitation: "Waiting for your input",
  },
  localOnly: "Answer in VS Code",
  ended: { done: "Finished", error: "Stopped with an error", limit: "Usage limit reached", crashed: "Claude Code exited unexpectedly" },
  reason: { context: "context limit", login: "login needed", model: "model unavailable" },
  resets: (at, now) => {
    const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
    const when = new Intl.DateTimeFormat("en-US", { ...(sameDay ? {} : { month: "short", day: "numeric" }), hour: "numeric", minute: "2-digit" }).format(at);
    return `resets ${when}`;
  },
  files: (n) => `${n} ${n === 1 ? "file" : "files"}`,
  sent: "Claude sent a file",
  more: (n) => ` and ${n} more`,
  claude: "Notification from Claude",
  test: "This is a test notification",
  update: (tag) => `New version ${tag}: run ccrc update on the laptop`,
};

export const PUSH_TEXT: Record<Lang, PushText> = { ko: KO, en: EN };
