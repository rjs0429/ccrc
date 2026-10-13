import type { NoteCode, SessionSummary } from "../../broker/src/protocol.ts";

export const MODE_LABEL: Record<string, string> = {
  default: "수동 승인",
  acceptEdits: "편집 자동 허용",
  plan: "계획",
  auto: "자동",
  dontAsk: "묻지 않음",
  bypassPermissions: "모든 권한 허용",
};

export const MODE_HINT: Record<string, string> = {
  default: "파일 편집과 명령 실행 전에 묻습니다",
  acceptEdits: "파일 편집은 묻지 않고 허용합니다",
  plan: "파일을 바꾸지 않고 계획만 세웁니다",
  auto: "안전 검사를 거쳐 대부분 묻지 않고 실행합니다",
};

export const EFFORT_LABEL: Record<string, string> = {
  low: "낮음",
  medium: "보통",
  high: "높음",
  xhigh: "매우 높음",
  max: "최대",
};

const DESTINATION_LABEL: Record<string, string> = {
  session: "이번 세션",
  localSettings: "이 프로젝트(나만)",
  projectSettings: "이 프로젝트(공유)",
  userSettings: "모든 프로젝트",
};

export function hostLabel(host?: string): string {
  return host === "Terminal" ? "터미널" : host === "ccrc" ? "원격" : (host ?? "");
}

// Why a session no longer has a process the broker drives, as a sentence that ends with a space.
export function closedText(reason?: string): string {
  switch (reason) {
    case "vscode_closed":
      return "VS Code에서 닫혔습니다. ";
    case "switched":
      return "VS Code에서 다른 대화로 바뀌었습니다. ";
    case "handed_off":
      return "VS Code로 넘겼습니다. ";
    case "idle":
      return "한동안 쓰지 않아 원격 실행을 끝냈습니다. ";
    case "released":
      return "원격 실행을 끝냈습니다. ";
    default:
      return "";
  }
}

export function noteText(code: NoteCode, text?: string): string {
  switch (code) {
    case "interrupted":
      return "중단됨";
    case "compacted":
      return "이전 대화를 요약했습니다";
    case "error":
      return `오류: ${text ?? ""}`;
    default:
      return text ?? "";
  }
}

const ERRORS: [RegExp, string | ((m: RegExpMatchArray) => string)][] = [
  [/^session is open in (.+)$/, (m) => `${hostLabel(m[1])}에서 열려 있어 원격으로 실행할 수 없습니다`],
  [/^folder is not allowed for new sessions$/, "이 폴더에서는 새 세션을 시작할 수 없습니다"],
  [/^folder does not exist$/, "폴더가 없습니다"],
  [/^request is no longer pending$/, "이미 처리된 요청입니다"],
  [/^session is not running here$/, "원격에서 실행 중인 세션이 아닙니다. 메시지를 보내면 이어서 실행합니다"],
  [/^session closed$/, "세션 프로세스가 종료되었습니다"],
  [/^unknown session$/, "세션을 찾을 수 없습니다"],
  [/^session runs in VS Code$/, "VS Code에서 실행 중인 세션입니다"],
  [/^session is opening in VS Code$/, "VS Code에서 이 세션을 여는 중입니다"],
  [/^this request can only be answered where the session is open$/, "이 요청은 VS Code에서만 응답할 수 있습니다"],
  [/^Claude Code did not answer$/, "Claude Code가 응답하지 않았습니다"],
  [/^rejected by the wrapper: (.+)$/, (m) => `VS Code 쪽에서 받지 않았습니다 (${m[1]})`],
];

export function errorText(message: string): string {
  for (const [re, out] of ERRORS) {
    const m = message.match(re);
    if (m) return typeof out === "string" ? out : out(m);
  }
  return message;
}

export function loggedOutText(reason?: string): string | undefined {
  switch (reason) {
    case "taken_over":
      return "다른 기기에서 로그인해 이 기기는 로그아웃되었습니다.";
    case "idle":
      return "오래 사용하지 않아 로그아웃되었습니다.";
    case "logout":
      return "로그아웃되었습니다.";
    case "expired":
      return "로그인이 만료되었습니다. 다시 로그인하세요.";
    default:
      return undefined;
  }
}

// What the "always allow" button grants, in the user's words.
export function allowAlwaysLabel(suggestions: unknown[] | undefined): string {
  const parts: string[] = [];
  for (const s of (suggestions ?? []) as Record<string, unknown>[]) {
    const where = DESTINATION_LABEL[String(s.destination)] ?? "";
    if (s.type === "setMode") {
      parts.push(s.mode === "acceptEdits" ? `${where} 동안 편집 모두 허용` : `${where} 동안 ${MODE_LABEL[String(s.mode)] ?? s.mode}`);
    } else if (s.type === "addRules" && Array.isArray(s.rules)) {
      const rules = (s.rules as { toolName?: string; ruleContent?: string }[]).map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName));
      parts.push(`${where}에서 항상 허용: ${rules.join(", ")}`);
    } else if (s.type === "addDirectories" && Array.isArray(s.directories)) {
      parts.push(`${where}에 폴더 추가: ${(s.directories as string[]).map(baseName).join(", ")}`);
    }
  }
  return parts.join(" · ") || "항상 허용";
}

export function baseName(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() || p;
}

export function shortPath(p: string): string {
  return p.replace(/^\/home\/[^/]+(?=\/|$)/, "~");
}

export function sessionTitle(s: Pick<SessionSummary, "title">): string {
  return s.title.trim() || "(제목 없음)";
}

export function relTime(ms: number, now = Date.now()): string {
  const diff = Math.max(0, now - ms);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}일 전`;
  const d = new Date(ms);
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

export function clock(ts?: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
