import type { BrokerSessionsInfo, EffortName, ModelOption, NoteCode, SessionSummary } from "../../broker/src/protocol.ts";

// Why sessions cannot start from the phone, and how to turn them on at the laptop.
const BROKER_OFF = "원격 세션이 꺼져 있어 여기서 Claude Code를 시작할 수 없습니다. 노트북에서 ccrc config set brokerSessions apiKey (또는 subscription) 로 켭니다.";
const BROKER_NO_KEY = "원격 세션에 쓸 API 키가 없어 여기서 Claude Code를 시작할 수 없습니다. 노트북에서 ccrc config set-api-key 로 키를 넣습니다.";

export function brokerSessionsBlocked(b: BrokerSessionsInfo | undefined): string | undefined {
  if (!b || b.ready) return undefined;
  return b.mode === "apiKey" ? BROKER_NO_KEY : BROKER_OFF;
}

export const BROKER_SESSIONS_LABEL: Record<BrokerSessionsInfo["mode"], string> = {
  off: "꺼짐",
  apiKey: "API 키",
  subscription: "구독 로그인",
};

export const MODE_LABEL: Record<string, string> = {
  default: "Manual",
  acceptEdits: "Edit automatically",
  plan: "Plan",
  auto: "Auto",
  dontAsk: "Don't ask",
  bypassPermissions: "Bypass permissions",
};

export const MODE_HINT: Record<string, string> = {
  default: "파일 편집과 명령 실행 전에 묻습니다",
  acceptEdits: "파일 편집은 묻지 않고 허용합니다",
  plan: "파일을 바꾸지 않고 계획만 세웁니다",
  auto: "안전 검사를 거쳐 대부분 묻지 않고 실행합니다",
  dontAsk: "승인이 필요한 동작은 묻지 않고 거부합니다",
};

export const EFFORT_LABEL: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function effortLabel(effort?: string): string {
  return effort ? (EFFORT_LABEL[effort] ?? effort) : "Auto";
}

// Claude Code reports the resolved model id, which "default" shares with the model it stands for;
// that model's own entry names it.
export function findModel(models: ModelOption[], model?: string): ModelOption | undefined {
  if (!model) return undefined;
  return (
    models.find((m) => m.value === model) ??
    models.find((m) => m.value !== "default" && m.resolved === model) ??
    models.find((m) => m.resolved === model)
  );
}

const LONG_CONTEXT = "[1m]";

// The base model's entry for a 1M context variant the list does not name itself.
function baseModel(models: ModelOption[], model?: string): ModelOption | undefined {
  return model?.endsWith(LONG_CONTEXT) ? findModel(models, model.slice(0, -LONG_CONTEXT.length)) : undefined;
}

const EFFORTS: EffortName[] = ["low", "medium", "high", "xhigh", "max"];

// The Effort levels to offer; none when the model's entry lists none and no level is set.
export function effortLevels(models: ModelOption[], model?: string, effort?: string): EffortName[] | undefined {
  const known = findModel(models, model) ?? baseModel(models, model);
  if (known?.efforts?.length) return known.efforts;
  return !known || effort ? EFFORTS : undefined;
}

export function modelLabel(models: ModelOption[], model?: string): string {
  if (!model) return "모델";
  const known = findModel(models, model);
  if (known) return known.label;
  const base = baseModel(models, model);
  if (base) return `${base.label} (1M)`;
  const m = model.match(/^claude-([a-z]+)-(\d+)-(\d+)/);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}${model.endsWith(LONG_CONTEXT) ? " (1M)" : ""}` : model;
}

const DESTINATION_LABEL: Record<string, string> = {
  session: "이번 세션",
  localSettings: "이 프로젝트(나만)",
  projectSettings: "이 프로젝트(공유)",
  userSettings: "모든 프로젝트",
};

export function hostLabel(host?: string): string {
  return host === "Terminal" ? "터미널" : host === "ccrc" ? "원격" : (host ?? "");
}

const DIALOG_LABEL: Record<string, string> = {
  refusal_fallback_prompt: "다른 모델로 다시 시도할지 확인",
  fable_overage_consent_prompt: "Fable 추가 사용량 동의",
  auto_mode_server_fallback: "Auto 모드 분류기 과금 확인",
};

export function dialogLabel(kind: string): string {
  return DIALOG_LABEL[kind] ?? kind;
}

// Why a session no longer has a process the broker drives, as a sentence.
export function closedText(reason?: string): string {
  switch (reason) {
    case "vscode_closed":
      return "VS Code에서 닫혔습니다.";
    case "switched":
      return "VS Code에서 다른 대화로 바뀌었습니다.";
    case "handed_off":
      return "VS Code로 넘겼습니다.";
    case "idle":
      return "한동안 쓰지 않아 원격 실행을 끝냈습니다.";
    case "released":
      return "원격 실행을 끝냈습니다.";
    case "crashed":
      return "Claude Code가 비정상 종료되었습니다.";
    default:
      return "";
  }
}

export function noteText(code: NoteCode, text?: string, attachments?: number): string {
  switch (code) {
    case "unsent":
      return `Claude Code가 받지 못한 메시지${attachments ? ` (첨부 ${attachments}개)` : ""}${text ? `: ${text}` : ""}`;
    case "interrupted":
      return "중단됨";
    case "compacted":
      return "이전 대화를 요약했습니다";
    case "ultracode":
      return "Ultracode를 켜지 못했습니다. 이 모델이나 지금 설정에서는 쓸 수 없습니다";
    case "fast":
      return text === "credits" ? "Fast 모드: 사용 크레딧이 다 떨어져 표준 속도로 보냅니다" : `Fast 모드를 켜지 못했습니다. ${fastReasonText(text) ?? FAST_REASON.unknown}`;
    case "error":
      return `오류: ${errorText(text ?? "")}`;
    default:
      return text ?? "";
  }
}

// Why Claude Code would not rewind a conversation, which then stays as it was.
const REWIND_REFUSED: Record<string, string> = {
  turn_running: "작업 중에는 되돌릴 수 없습니다. 먼저 멈추세요",
  commands_queued: "대기 중인 메시지나 답할 요청이 있습니다",
  prompt_pending: "대기 중인 메시지나 답할 요청이 있습니다",
  stale_target: "그사이 대화가 바뀌었습니다. 새로고침한 뒤 다시 하세요",
  unseen_later_turn: "그사이 대화가 바뀌었습니다. 새로고침한 뒤 다시 하세요",
  state_changed: "그사이 대화가 바뀌었습니다. 새로고침한 뒤 다시 하세요",
  target_not_found: "이 메시지로는 되돌릴 수 없습니다 (Compact 앞이거나 이미 지운 메시지)",
  target_splits_tool_call: "도구 실행 도중이라 이 지점으로는 되돌릴 수 없습니다",
  poll_tool_result_target: "도구 실행 도중이라 이 지점으로는 되돌릴 수 없습니다",
  delivered_poll_events_in_range: "도구 실행 도중이라 이 지점으로는 되돌릴 수 없습니다",
  persist_failed: "기록에 쓰지 못해 되돌리지 않았습니다",
};

const ERRORS: [RegExp, string | ((m: RegExpMatchArray) => string)][] = [
  [/^broker_sessions_off$/, BROKER_OFF],
  [/^broker_sessions_off: no API key$/, BROKER_NO_KEY],
  [/^session is starting$/, "세션을 시작하는 중입니다. 시작된 뒤 다시 고르세요"],
  [/^session started meanwhile$/, "그 사이 세션이 시작되었습니다. 다시 고르세요"],
  [/^unknown model$/, "목록에 없는 모델입니다"],
  [/^session is open in (.+)$/, (m) => `${hostLabel(m[1])}에서 열려 있어 원격으로 실행할 수 없습니다`],
  [/^folder is not allowed for new sessions$/, "이 폴더에서는 새 세션을 시작할 수 없습니다"],
  [/^folder does not exist$/, "폴더가 없습니다"],
  [/^not a folder$/, "폴더가 아닙니다"],
  [/^not a git repository$/, "git 저장소가 아니라 worktree를 만들 수 없습니다"],
  [/^repository has no commits$/, "커밋이 없는 저장소라 worktree를 만들 수 없습니다"],
  [/^invalid worktree name: \w+$/, "worktree 이름이 올바르지 않습니다"],
  [/^branch (\S+) already exists$/, (m) => `이미 있는 브랜치(${m[1]})라 이 이름은 쓸 수 없습니다`],
  [/^Claude Code could not start: [\s\S]*No conversation found/, "대화 기록을 찾지 못해 이 세션을 이어서 실행할 수 없습니다"],
  [/^Claude Code could not start: (?:Error: )?([\s\S]+)$/, (m) => `Claude Code가 시작하지 못했습니다: ${m[1]}`],
  [/^Claude Code did not start in (\d+)s(?:: ([\s\S]+))?$/, (m) => `Claude Code가 ${m[1]}초 안에 시작하지 않았습니다${m[2] ? `: ${m[2]}` : ""}`],
  [/^not a worktree session$/, "worktree에서 시작한 세션이 아닙니다"],
  [/^worktree is in use in (.+)$/, (m) => `${hostLabel(m[1])}에서 실행 중이라 worktree를 지울 수 없습니다. 먼저 끝내세요`],
  [/^worktree is in use$/, "다른 Claude Code가 이 worktree에서 실행 중이라 지울 수 없습니다"],
  [/^worktree is locked(?:: (.+))?$/, (m) => `직접 건 잠금이 있어 지우지 않았습니다${m[1] ? ` (${m[1]})` : ""}`],
  [/^worktree has work to keep$/, "바뀐 파일이나 커밋이 생겼습니다. 다시 확인한 뒤 지우세요"],
  [/^worktree has commits on no branch$/, "detached HEAD에만 있는 커밋이 있어 지우지 않았습니다. 브랜치를 만든 뒤 다시 하세요"],
  [/^not a registered worktree: /, "git에 등록된 worktree가 아니라 지우지 않았습니다"],
  [/^git [\w ]+ failed: ([\s\S]+)$/, (m) => `git 명령이 실패했습니다: ${m[1]}`],
  [/^working folder is missing: (.+)$/, (m) => `작업 폴더가 없어 세션을 시작할 수 없습니다: ${shortPath(m[1])}`],
  [/^Claude Code (?:native binary|executable) at [\s\S]+ exists but failed to launch/, "Claude Code를 실행하지 못했습니다. 작업 폴더가 그대로 있는지, 실행 파일이 이 컴퓨터에 맞는지 확인하세요"],
  [/^Claude Code (?:native binary|executable) not found at ([\s\S]+?)\.(?:\s|$)/, (m) => `Claude Code 실행 파일을 찾을 수 없습니다: ${m[1]}`],
  [/^Failed to spawn Claude Code process: ([\s\S]+)$/, (m) => `Claude Code를 실행하지 못했습니다 (${m[1]})`],
  [/^Claude Code process exited with code \d+[\s\S]*No conversation found/, "대화 기록을 찾지 못해 이 세션을 이어서 실행할 수 없습니다"],
  [/^Claude Code process exited with code (\d+)(?:\. stderr: ([\s\S]+))?$/, (m) => `Claude Code가 종료되었습니다 (코드 ${m[1]})${m[2] ? `: ${m[2]}` : ""}`],
  [/^Claude Code process terminated by signal (\w+)/, (m) => `Claude Code가 강제로 종료되었습니다 (${m[1]})`],
  [/^request is no longer pending$/, "이미 처리된 요청입니다"],
  [/^session is not running here$/, "원격에서 실행 중인 세션이 아닙니다. 메시지를 보내면 이어서 실행합니다"],
  [/^session closed$/, "세션 프로세스가 종료되었습니다"],
  [/^unknown session$/, "세션을 찾을 수 없습니다"],
  [/^session runs in VS Code$/, "VS Code에서 실행 중인 세션입니다"],
  [/^session is opening in VS Code$/, "VS Code에서 이 세션을 여는 중입니다"],
  [/^title must be non-empty$/, "이름을 입력하세요"],
  [/^cannot rename while open in (.+)$/, (m) => `${hostLabel(m[1])}에서 열려 있어 여기서는 이름을 바꿀 수 없습니다. 그곳에서 바꾸거나 닫은 뒤 다시 시도하세요`],
  [/^session_id is not the current session$/, "VS Code에서 이 세션이 다른 대화로 바뀌었습니다. 새로고침 뒤 다시 시도하세요"],
  [/^this request can only be answered where the session is open$/, "이 요청은 VS Code에서만 응답할 수 있습니다"],
  [/^Claude Code did not answer$/, "Claude Code가 응답하지 않았습니다"],
  [/^rejected by the wrapper: request not allowed$/, "VS Code 쪽 래퍼가 아직 이 요청을 모릅니다. VS Code에서 세션을 다시 연 뒤 시도하세요"],
  [/^rejected by the wrapper: message not allowed$/, "Claude Code가 이미 받은 메시지라 되돌릴 수 없습니다"],
  [/^rejected by the wrapper: (.+)$/, (m) => `VS Code 쪽에서 받지 않았습니다 (${m[1]})`],
  [/^attachment expired$/, "첨부 파일이 만료되었습니다. 다시 첨부하세요"],
  [/^attachments too large$/, "첨부 파일이 너무 큽니다 (한 번에 10MB까지)"],
  [/^unknown MCP server$/, "MCP 서버를 찾을 수 없습니다"],
  [/^unknown message$/, "이 세션에서 찾을 수 없는 메시지입니다"],
  [/^session is busy$/, "Claude가 작업 중입니다. 작업이 끝난 뒤 다시 시도하세요"],
  [/^task is not running$/, "멈추지 못했습니다. 이미 끝났을 수 있습니다."],
  [/^not a shell task$/, "목록에 있는 셸·모니터 작업만 출력을 볼 수 있습니다"],
  [/^transcript too large$/, "기록이 너무 커서(64MB 초과) 열 수 없습니다"],
  [/^message is no longer queued$/, "Claude Code가 이미 받은 메시지라 되돌릴 수 없습니다"],
  [/^only a message sent from here can be taken back$/, "여기서 보낸 메시지만 되돌릴 수 있습니다"],
  [/^unknown output style$/, "목록에 없는 출력 스타일입니다"],
  [/^output styles are not available for this session$/, "이 세션에서는 출력 스타일을 고를 수 없습니다"],
  [/^File rewinding is not enabled\.?$/, "이 세션은 파일 되돌리기가 꺼져 있습니다"],
  [/^No file checkpoint found for this message\.?$/, "이 메시지 시점의 파일 기록이 없습니다"],
  [/^Failed to rewind: (.+)$/, (m) => `되돌리지 못했습니다: ${m[1]}`],
  [/^rewind refused: (\w+)$/, (m) => REWIND_REFUSED[m[1]] ?? `지금은 되돌릴 수 없습니다 (${m[1]})`],
  [/^cannot rewind files while open in (.+)$/, (m) => `${hostLabel(m[1])}에서 열려 있어 파일은 되돌릴 수 없습니다`],
  [/^fork failed: ([\s\S]+)$/, (m) => `갈래를 만들지 못했습니다: ${errorText(m[1])}`],
  [/^Claude Code did not run \/rename$/, "갈래에 이름을 붙이지 못했습니다"],
  [/^no answer$/, "응답이 없습니다"],
  [/^not connected$/, "연결되어 있지 않습니다"],
  [/^unsupported_push_service$/, "이 브라우저의 푸시 서비스로는 알림을 보낼 수 없습니다"],
  [/^invalid_subscription$/, "알림 구독 정보가 올바르지 않습니다"],
  [/^not_subscribed$/, "이 기기는 알림이 꺼져 있습니다"],
  [/^push_failed (\d+)$/, (m) => (m[1] === "0" ? "푸시 서비스에 연결하지 못했습니다" : `푸시 서비스가 알림을 받지 않았습니다 (${m[1]})`)],
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
      parts.push(s.mode === "acceptEdits" ? `${where} 동안 편집 모두 허용` : `${where} 동안 ${MODE_LABEL[String(s.mode)] ?? s.mode} 모드`);
    } else if (s.type === "addRules" && Array.isArray(s.rules)) {
      const rules = (s.rules as { toolName?: string; ruleContent?: string }[]).map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName));
      parts.push(`${where}에서 항상 허용: ${rules.join(", ")}`);
    } else if (s.type === "addDirectories" && Array.isArray(s.directories)) {
      parts.push(`${where}에 폴더 추가: ${(s.directories as string[]).map(baseName).join(", ")}`);
    }
  }
  return parts.join(" · ") || "항상 허용";
}

export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)}KB` : `${(bytes / 1024 / 1024).toFixed(1)}MB`;
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

export function clock(ts?: string | Date): string {
  if (!ts) return "";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function usageLimitLabel(kind: string, scope?: string): string {
  if (kind === "session") return "현재 세션";
  if (kind === "weekly_all") return "이번 주 · 모든 모델";
  if (kind === "weekly_scoped" && scope) return `이번 주 · ${scope}`;
  return scope ? `${kind} · ${scope}` : kind;
}

export function usageResetText(at: string, now = new Date()): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const time = clock(at);
  const day = d.toDateString() === now.toDateString() ? "오늘" : `${d.getMonth() + 1}월 ${d.getDate()}일`;
  return `${day} ${time} 초기화`;
}

// How long something took: "12초", "3분 4초", "1시간 2분".
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}분 ${s % 60}초` : `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

export const TASK_KIND_LABEL: Record<string, string> = {
  local_agent: "서브에이전트",
  local_bash: "셸 (Bash)",
  local_workflow: "워크플로",
  remote_agent: "원격 에이전트",
  monitor_mcp: "모니터",
  monitor_ws: "모니터 (WebSocket)",
  mcp_task: "MCP 작업",
  in_process_teammate: "팀원",
  dream: "기억 정리",
};

export function taskKindLabel(kind?: string): string {
  return kind ? (TASK_KIND_LABEL[kind] ?? kind) : "";
}

// What the model offers: Fast mode, turning Thinking off (unknown when absent), and whether Claude Code holds its Effort at
// High while Thinking is off.
export function modelOffers(models: ModelOption[], model?: string): { fast: boolean; thinkingOff?: boolean; capped: boolean } {
  const known = findModel(models, model) ?? baseModel(models, model);
  const id = (known?.resolved ?? model ?? "").replace(/\[1m\]$/i, "");
  return { fast: known?.fast === true, thinkingOff: known?.thinkingOff, capped: id === "claude-opus-5" };
}

const FAST_REASON: Record<string, string> = {
  extra_usage_disabled: "사용 크레딧이 꺼져 있습니다 (claude.ai 설정 > 사용량)",
  free: "유료 요금제나 사용 크레딧이 필요합니다",
  preference: "조직에서 Fast 모드를 꺼 두었습니다",
  model_not_allowed: "조직의 허용 모델에 Fast 모드용 Opus가 없습니다",
  network_error: "가능 여부를 확인하지 못했습니다 (네트워크)",
  not_first_party: "Anthropic API에 바로 연결할 때만 쓸 수 있습니다",
  disabled_by_env: "CLAUDE_CODE_DISABLE_FAST_MODE가 켜져 있습니다",
  unknown: "지금은 쓸 수 없습니다",
  pending: "쓸 수 있는지 확인하는 중입니다",
};

// Why Claude Code says Fast mode cannot run. A broker session reports sdk_opt_in_required until Fast mode is first asked
// for, which says nothing of the account.
export function fastReasonText(reason?: string): string | undefined {
  if (!reason || reason === "sdk_opt_in_required") return undefined;
  return FAST_REASON[reason] ?? `지금은 쓸 수 없습니다 (${reason})`;
}
