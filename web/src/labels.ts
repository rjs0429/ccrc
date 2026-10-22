import type { BrokerSessionsInfo, EffortName, InboxInfo, ModelOption, NoteCode, SessionSummary } from "../../broker/src/protocol.ts";
import { clock, dateTime, monthDay } from "./i18n/format.ts";
import { k, locale, t, tc } from "./i18n/index.ts";

export { clock };

// Why sessions cannot start from the phone, and how to turn them on at the laptop.
const BROKER_OFF = k("원격 세션이 꺼져 있어 여기서 Claude Code를 시작할 수 없습니다. 노트북에서 ccrc config set brokerSessions apiKey (또는 subscription) 로 켭니다.");
const BROKER_NO_KEY = k("원격 세션에 쓸 API 키가 없어 여기서 Claude Code를 시작할 수 없습니다. 노트북에서 ccrc config set-api-key 로 키를 넣습니다.");

export function brokerSessionsBlocked(b: BrokerSessionsInfo | undefined): string | undefined {
  if (!b || b.ready) return undefined;
  return t(b.mode === "apiKey" ? BROKER_NO_KEY : BROKER_OFF);
}

const BROKER_SESSIONS_LABEL: Record<string, string> = {
  off: k("꺼짐"),
  apiKey: k("API 키"),
  subscription: k("구독 로그인"),
};

export function brokerSessionsLabel(mode: string): string {
  return Object.hasOwn(BROKER_SESSIONS_LABEL, mode) ? t(BROKER_SESSIONS_LABEL[mode]) : mode;
}

export const MODE_LABEL: Record<string, string> = {
  default: "Manual",
  acceptEdits: "Edit automatically",
  plan: "Plan",
  auto: "Auto",
  dontAsk: "Don't ask",
  bypassPermissions: "Bypass permissions",
};

const MODE_HINT: Record<string, string> = {
  default: k("파일 편집과 명령 실행 전에 묻습니다"),
  acceptEdits: k("파일 편집은 묻지 않고 허용합니다"),
  plan: k("파일을 바꾸지 않고 계획만 세웁니다"),
  auto: k("안전 검사를 거쳐 대부분 묻지 않고 실행합니다"),
  dontAsk: k("승인이 필요한 동작은 묻지 않고 거부합니다"),
};

// What each permission mode does, by mode.
export function modeHints(): Record<string, string> {
  return Object.fromEntries(Object.entries(MODE_HINT).map(([mode, hint]) => [mode, t(hint)]));
}

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
  if (!model) return t("모델");
  const known = findModel(models, model);
  if (known) return known.label;
  const base = baseModel(models, model);
  if (base) return `${base.label} (1M)`;
  const m = model.match(/^claude-([a-z]+)-(\d+)-(\d+)/);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}${model.endsWith(LONG_CONTEXT) ? " (1M)" : ""}` : model;
}

const DESTINATION_LABEL: Record<string, string> = {
  session: k("이번 세션"),
  localSettings: k("이 프로젝트(나만)"),
  projectSettings: k("이 프로젝트(공유)"),
  userSettings: k("모든 프로젝트"),
};

// The program a session is open in, as the sentences around it name it ("in a terminal").
export function hostLabel(host?: string): string {
  return host === "Terminal" ? tc("host", "터미널") : host === "Background" ? tc("host", "백그라운드") : host === "ccrc" ? tc("host", "원격") : (host ?? "");
}

export interface PeerNote {
  text: string;
  warn?: boolean;
}

// What becomes of a message sent to a session open in another program, shown before it is sent.
export function inboxNotes(host: string | undefined, inbox: InboxInfo | undefined): PeerNote[] {
  const where = host === "Terminal" ? tc("inbox", "터미널") : host === "Background" ? t("백그라운드 세션") : host === "VS Code" ? "VS Code" : t("그 세션");
  const notes: PeerNote[] = [{ text: t("다른 세션 메시지로 전달됩니다. Claude가 중요한 작업은 {where}에서 다시 묻습니다.", { where }) }];
  if (inbox?.gate === "approve" && host === "Background") notes.push({ text: t("claude agents에서 이 세션을 열어 승인해야 전달됩니다."), warn: true });
  else if (inbox?.gate === "approve") notes.push({ text: t("터미널에서 승인해야 전달됩니다."), warn: true });
  else if (inbox?.gate === "held" && inbox.why === "mode") notes.push({ text: t("권한 확인을 건너뛰는 세션이라 5분 안에 권한 모드를 바꾸지 않으면 전달되지 않습니다."), warn: true });
  else if (inbox?.gate === "held") notes.push({ text: t("이 세션의 설정(crossSessionInbound)에 따라 보류되어 전달되지 않습니다."), warn: true });
  else if (inbox?.gate === "refused") notes.push({ text: t("이 세션의 설정(crossSessionInbound)에 따라 다른 세션 메시지를 받지 않습니다."), warn: true });
  return notes;
}

const DIALOG_LABEL: Record<string, string> = {
  refusal_fallback_prompt: k("다른 모델로 계속할지 확인"),
  fable_overage_consent_prompt: k("사용 크레딧 동의"),
  auto_mode_server_fallback: k("Auto 모드 분류기 과금 확인"),
};

export function dialogLabel(kind: string): string {
  return Object.hasOwn(DIALOG_LABEL, kind) ? t(DIALOG_LABEL[kind]) : kind;
}

const REFUSAL_FIELD: Record<string, string> = { cyber: k("정상적인 코딩·보안 작업"), bio: k("정상적인 생명과학 작업") };

// Why a turn stopped at a refusal and what the user can do, as VS Code tells it. A particle after a model's name would
// depend on how the name ends, so "모델" carries it.
export function refusalText(model: string, fallback: string, category?: string): string {
  const field = category && Object.hasOwn(REFUSAL_FIELD, category) ? t(REFUSAL_FIELD[category]) : undefined;
  const why = field ? t("안전장치를 넓게 잡아 {field}도 가끔 걸립니다.", { field }) : t("평범한 대화에서도 가끔 일어납니다.");
  return t("{model}의 안전장치가 이 메시지를 막았습니다. {why} {fallback} 모델로 계속하거나, 메시지를 고쳐 {model} 모델로 다시 보내세요.", { model, why, fallback });
}

const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND"]);

function money(cents: number, currency = "USD"): string {
  const code = currency.toUpperCase();
  const amount = ZERO_DECIMAL.has(code) ? cents : cents / 100;
  try {
    return new Intl.NumberFormat(locale(), { style: "currency", currency: code }).format(amount);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

// What the usage credits consent asks, from the dialog's own figures.
export function creditsText(info: { model?: string; enabled: boolean; balanceCents?: number; currency?: string }): string {
  const model = info.model ?? "Fable";
  const base = t("{model} 모델은 요금제와 따로 과금되는 사용 크레딧으로 실행됩니다.", { model });
  if (!info.enabled) return `${base} ${t("이 계정에는 아직 사용 크레딧이 없습니다.")}`;
  const balance = info.balanceCents !== undefined ? ` ${t("남은 크레딧은 {amount}입니다.", { amount: money(info.balanceCents, info.currency) })}` : "";
  return `${base}${balance} ${t("크레딧을 쓸지는 계정의 과금 결정이라 VS Code에서만 답할 수 있습니다.")}`;
}

// Why a session no longer has a process the broker drives, as a sentence.
export function closedText(reason?: string): string {
  switch (reason) {
    case "vscode_closed":
      return t("VS Code에서 닫혔습니다.");
    case "switched":
      return t("VS Code에서 다른 대화로 바뀌었습니다.");
    case "handed_off":
      return t("VS Code로 넘겼습니다.");
    case "moved":
      return t("VS Code의 다른 탭으로 옮겼습니다.");
    case "idle":
      return t("한동안 쓰지 않아 원격 실행을 끝냈습니다.");
    case "released":
      return t("원격 실행을 끝냈습니다.");
    case "crashed":
      return t("Claude Code가 비정상 종료되었습니다.");
    default:
      return "";
  }
}

export function noteText(code: NoteCode, text?: string, attachments?: number): string {
  switch (code) {
    case "unsent": {
      const head = attachments ? t("Claude Code가 받지 못한 메시지 (첨부 {n}개)", { n: attachments }) : t("Claude Code가 받지 못한 메시지");
      return text ? `${head}: ${text}` : head;
    }
    case "interrupted":
      return t("중단됨");
    case "compacted":
      return t("이전 대화를 요약했습니다");
    case "ultracode":
      return t("Ultracode를 켜지 못했습니다. 이 모델이나 지금 설정에서는 쓸 수 없습니다");
    case "fast":
      return text === "credits" ? t("Fast 모드: 사용 크레딧이 다 떨어져 표준 속도로 보냅니다") : t("Fast 모드를 켜지 못했습니다. {reason}", { reason: fastReasonText(text) ?? t(FAST_REASON.unknown) });
    case "error":
      return t("오류: {error}", { error: errorText(text ?? "") });
    default:
      return text ?? "";
  }
}

// Why Claude Code would not rewind a conversation, which then stays as it was.
const REWIND_REFUSED: Record<string, string> = {
  turn_running: k("작업 중에는 되돌릴 수 없습니다. 먼저 멈추세요"),
  commands_queued: k("대기 중인 메시지나 답할 요청이 있습니다"),
  prompt_pending: k("대기 중인 메시지나 답할 요청이 있습니다"),
  stale_target: k("그사이 대화가 바뀌었습니다. 새로고침한 뒤 다시 하세요"),
  unseen_later_turn: k("그사이 대화가 바뀌었습니다. 새로고침한 뒤 다시 하세요"),
  state_changed: k("그사이 대화가 바뀌었습니다. 새로고침한 뒤 다시 하세요"),
  target_not_found: k("이 메시지로는 되돌릴 수 없습니다 (Compact 앞이거나 이미 지운 메시지)"),
  target_splits_tool_call: k("도구 실행 도중이라 이 지점으로는 되돌릴 수 없습니다"),
  poll_tool_result_target: k("도구 실행 도중이라 이 지점으로는 되돌릴 수 없습니다"),
  delivered_poll_events_in_range: k("도구 실행 도중이라 이 지점으로는 되돌릴 수 없습니다"),
  persist_failed: k("기록에 쓰지 못해 되돌리지 않았습니다"),
};

// Why a fork gets no worktree of its own: it would work at the worktree's top, not in the subfolder the session's paths
// are relative to; or the name is a worktree's already, which holds other work than the folder's HEAD.
const FORK_WORKTREE: Record<"subfolder" | "exists", string> = {
  subfolder: k("저장소 하위 폴더에서 작업한 세션이라 worktree를 만들 수 없습니다. 갈래가 worktree 맨 위에서 돌아 파일 경로가 어긋납니다"),
  exists: k("이미 있는 worktree라 지금 커밋에서 시작할 수 없습니다"),
};

export function forkWorktreeText(why: "subfolder" | "exists"): string {
  return t(FORK_WORKTREE[why]);
}

// Each error Claude Code or the broker reports, by its message; a sentence is handed to t() when it is shown.
const ERRORS: [RegExp, string | ((m: RegExpMatchArray) => string)][] = [
  [/^broker_sessions_off$/, BROKER_OFF],
  [/^broker_sessions_off: no API key$/, BROKER_NO_KEY],
  [/^session is starting$/, k("세션을 시작하는 중입니다. 시작된 뒤 다시 고르세요")],
  [/^session started meanwhile$/, k("그 사이 세션이 시작되었습니다. 다시 고르세요")],
  [/^unknown model$/, k("목록에 없는 모델입니다")],
  [/^session is open in (.+)$/, (m) => t("{host}에서 열려 있어 원격으로 실행할 수 없습니다", { host: hostLabel(m[1]) })],
  [/^folder is not allowed for new sessions$/, k("이 폴더에서는 새 세션을 시작할 수 없습니다")],
  [/^folder does not exist$/, k("폴더가 없습니다")],
  [/^not a folder$/, k("폴더가 아닙니다")],
  [/^not a git repository$/, k("git 저장소가 아니라 worktree를 만들 수 없습니다")],
  [/^repository has no commits$/, k("커밋이 없는 저장소라 worktree를 만들 수 없습니다")],
  [/^invalid worktree name: \w+$/, k("worktree 이름이 올바르지 않습니다")],
  [/^branch (\S+) already exists$/, (m) => t("이미 있는 브랜치({branch})라 이 이름은 쓸 수 없습니다", { branch: m[1] })],
  [/^worktree (\S+) already exists$/, (m) => t("이미 있는 worktree({name})라 지금 커밋에서 시작할 수 없습니다", { name: m[1] })],
  [/^session works in a subfolder of its repository$/, FORK_WORKTREE.subfolder],
  [/^Claude Code could not start: [\s\S]*No conversation found/, k("대화 기록을 찾지 못해 이 세션을 이어서 실행할 수 없습니다")],
  [/^Claude Code could not start: (?:Error: )?([\s\S]+)$/, (m) => t("Claude Code가 시작하지 못했습니다: {error}", { error: m[1] })],
  [
    /^Claude Code did not start in (\d+)s(?:: ([\s\S]+))?$/,
    (m) => `${t("Claude Code가 {n}초 안에 시작하지 않았습니다", { n: m[1] })}${m[2] ? `: ${m[2]}` : ""}`,
  ],
  [/^not a worktree session$/, k("worktree에서 시작한 세션이 아닙니다")],
  [/^worktree is in use in (.+)$/, (m) => t("{host}에서 실행 중이라 worktree를 지울 수 없습니다. 먼저 끝내세요", { host: hostLabel(m[1]) })],
  [/^worktree is in use$/, k("다른 Claude Code가 이 worktree에서 실행 중이라 지울 수 없습니다")],
  [/^worktree is locked(?:: (.+))?$/, (m) => `${t("직접 건 잠금이 있어 지우지 않았습니다")}${m[1] ? ` (${m[1]})` : ""}`],
  [/^worktree has work to keep$/, k("바뀐 파일이나 커밋이 생겼습니다. 다시 확인한 뒤 지우세요")],
  [/^worktree has commits on no branch$/, k("detached HEAD에만 있는 커밋이 있어 지우지 않았습니다. 브랜치를 만든 뒤 다시 하세요")],
  [/^not a registered worktree: /, k("git에 등록된 worktree가 아니라 지우지 않았습니다")],
  [/^git [\w ]+ failed: ([\s\S]+)$/, (m) => t("git 명령이 실패했습니다: {error}", { error: m[1] })],
  [/^working folder is missing: (.+)$/, (m) => t("작업 폴더가 없어 세션을 시작할 수 없습니다: {folder}", { folder: shortPath(m[1]) })],
  [
    /^Claude Code (?:native binary|executable) at [\s\S]+ exists but failed to launch/,
    k("Claude Code를 실행하지 못했습니다. 작업 폴더가 그대로 있는지, 실행 파일이 이 컴퓨터에 맞는지 확인하세요"),
  ],
  [/^Claude Code (?:native binary|executable) not found at ([\s\S]+?)\.(?:\s|$)/, (m) => t("Claude Code 실행 파일을 찾을 수 없습니다: {path}", { path: m[1] })],
  [/^Failed to spawn Claude Code process: ([\s\S]+)$/, (m) => t("Claude Code를 실행하지 못했습니다 ({error})", { error: m[1] })],
  [/^Claude Code process exited with code \d+[\s\S]*No conversation found/, k("대화 기록을 찾지 못해 이 세션을 이어서 실행할 수 없습니다")],
  [
    /^Claude Code process exited with code (\d+)(?:\. stderr: ([\s\S]+))?$/,
    (m) => `${t("Claude Code가 종료되었습니다 (코드 {code})", { code: m[1] })}${m[2] ? `: ${m[2]}` : ""}`,
  ],
  [/^Claude Code process terminated by signal (\w+)/, (m) => t("Claude Code가 강제로 종료되었습니다 ({signal})", { signal: m[1] })],
  [/^request is no longer pending$/, k("이미 처리된 요청입니다")],
  [/^session is not running here$/, k("원격에서 실행 중인 세션이 아닙니다. 메시지를 보내면 이어서 실행합니다")],
  [/^session is not open elsewhere$/, k("다른 곳에서 열려 있지 않아 보내지 않았습니다")],
  [/^session takes no messages$/, k("이 세션은 다른 세션 메시지를 받을 수 없습니다")],
  [/^inbox send failed: (.+)$/, (m) => t("보내지 못했습니다. 그 세션이 방금 닫혔을 수 있습니다 ({error})", { error: m[1] })],
  [/^session closed$/, k("세션 프로세스가 종료되었습니다")],
  [/^unknown session$/, k("세션을 찾을 수 없습니다")],
  [/^session runs in VS Code$/, k("VS Code에서 실행 중인 세션입니다")],
  [/^session is opening in VS Code$/, k("VS Code에서 이 세션을 여는 중입니다")],
  [/^title must be non-empty$/, k("이름을 입력하세요")],
  [
    /^cannot rename while open in (.+)$/,
    (m) => t("{host}에서 열려 있어 여기서는 이름을 바꿀 수 없습니다. 그곳에서 바꾸거나 닫은 뒤 다시 시도하세요", { host: hostLabel(m[1]) }),
  ],
  [/^session_id is not the current session$/, k("VS Code에서 이 세션이 다른 대화로 바뀌었습니다. 새로고침 뒤 다시 시도하세요")],
  [/^this request can only be answered where the session is open$/, k("이 요청은 VS Code에서만 응답할 수 있습니다")],
  [/^Claude Code did not answer$/, k("Claude Code가 응답하지 않았습니다")],
  [/^rejected by the wrapper: request not allowed$/, k("VS Code 쪽 래퍼가 아직 이 요청을 모릅니다. VS Code에서 세션을 다시 연 뒤 시도하세요")],
  [/^rejected by the wrapper: message not allowed$/, k("Claude Code가 이미 받은 메시지라 되돌릴 수 없습니다")],
  [/^rejected by the wrapper: (.+)$/, (m) => t("VS Code 쪽에서 받지 않았습니다 ({error})", { error: m[1] })],
  [/^attachment expired$/, k("첨부 파일이 만료되었습니다. 다시 첨부하세요")],
  [/^attachments too large$/, k("첨부 파일이 너무 큽니다 (한 번에 10MB까지)")],
  [/^unknown MCP server$/, k("MCP 서버를 찾을 수 없습니다")],
  [/^unknown message$/, k("이 세션에서 찾을 수 없는 메시지입니다")],
  [/^session is busy$/, k("Claude가 작업 중입니다. 작업이 끝난 뒤 다시 시도하세요")],
  [/^task is not running$/, k("멈추지 못했습니다. 이미 끝났을 수 있습니다.")],
  [/^not a shell task$/, k("목록에 있는 셸·모니터 작업만 출력을 볼 수 있습니다")],
  [/^transcript too large$/, k("기록이 너무 커서(64MB 초과) 열 수 없습니다")],
  [/^message is no longer queued$/, k("Claude Code가 이미 받은 메시지라 되돌릴 수 없습니다")],
  [/^only a message sent from here can be taken back$/, k("여기서 보낸 메시지만 되돌릴 수 있습니다")],
  [/^unknown output style$/, k("목록에 없는 출력 스타일입니다")],
  [/^output styles are not available for this session$/, k("이 세션에서는 출력 스타일을 고를 수 없습니다")],
  [/^File rewinding is not enabled\.?$/, k("이 세션은 파일 되돌리기가 꺼져 있습니다")],
  [/^No file checkpoint found for this message\.?$/, k("이 메시지 시점의 파일 기록이 없습니다")],
  [/^Failed to rewind: (.+)$/, (m) => t("되돌리지 못했습니다: {error}", { error: m[1] })],
  [/^rewind refused: (\w+)$/, (m) => (Object.hasOwn(REWIND_REFUSED, m[1]) ? t(REWIND_REFUSED[m[1]]) : t("지금은 되돌릴 수 없습니다 ({reason})", { reason: m[1] }))],
  [/^cannot rewind files while open in (.+)$/, (m) => t("{host}에서 열려 있어 파일은 되돌릴 수 없습니다", { host: hostLabel(m[1]) })],
  [/^fork failed: ([\s\S]+)$/, (m) => t("갈래를 만들지 못했습니다: {error}", { error: errorText(m[1]) })],
  [/^Claude Code did not run \/rename$/, k("갈래에 이름을 붙이지 못했습니다")],
  [/^a side question is under way$/, k("앞서 보낸 곁질문에 아직 답하는 중이라 묻지 못했습니다. 그 답은 여기로 오지 않습니다")],
  [/^side question gone$/, k("연결이 끊겨 답을 받지 못했습니다. 다시 물으세요")],
  [/^side question timed out$/, k("5분 안에 답이 오지 않아 곁질문을 취소했습니다")],
  [/^side question cancelled$/, k("곁질문을 취소했습니다")],
  [/^git diff failed$/, k("git에서 변경을 읽지 못했습니다")],
  [/^Unsupported control request subtype/, k("이 Claude Code 버전은 이 요청을 처리하지 못합니다")],
  [/^no answer$/, k("응답이 없습니다")],
  [/^nothing to export$/, k("내보낼 대화가 아직 없습니다")],
  [/^not connected$/, k("연결되어 있지 않습니다")],
  [/^unsupported_push_service$/, k("이 브라우저의 푸시 서비스로는 알림을 보낼 수 없습니다")],
  [/^invalid_subscription$/, k("알림 구독 정보가 올바르지 않습니다")],
  [/^not_subscribed$/, k("이 기기는 알림이 꺼져 있습니다")],
  [/^push_failed (\d+)$/, (m) => (m[1] === "0" ? t("푸시 서비스에 연결하지 못했습니다") : t("푸시 서비스가 알림을 받지 않았습니다 ({status})", { status: m[1] }))],
];

ERRORS.push(
  [/^not running in the foreground$/, k("이미 끝났거나 백그라운드에서 실행 중입니다")],
  [/^(?:Error: )?Background tasks are disabled in this session\.?$/, k("이 세션은 백그라운드 작업이 꺼져 있습니다")],
);

ERRORS.push(
  [/^invalid callback URL$/, k("로그인 뒤 넘어간 localhost 주소를 통째로 붙여 넣으세요")],
  [/^Invalid callback URL: missing authorization code/, k("주소에 인증 코드가 없습니다. 주소를 통째로 붙여 넣으세요")],
  [/^Callback URL not accepted:/, k("다른 로그인 시도의 주소입니다. 방금 연 로그인 페이지에서 넘어간 주소를 붙여 넣으세요")],
  [/^No active OAuth flow for server/, k("진행 중인 인증이 없습니다. '인증'을 다시 누르세요")],
  [/does not support OAuth authentication|does not support authentication/, k("이 서버는 여기서 인증할 수 없습니다")],
  [/^Server not found: /, k("MCP 서버를 찾을 수 없습니다")],
  [/blocked by enterprise managed policy/, k("관리자 정책으로 막힌 서버입니다")],
  [/^Unable to build claude\.ai connector auth URL/, k("claude.ai 커넥터의 인증 주소를 만들지 못했습니다")],
  [/OAuth authentication failed/, k("인증하지 못했습니다. '인증'을 다시 누르세요")],
  [/^invalid answer$/, k("이 요청에 맞지 않는 답입니다")],
  [/^passkey_required$/, k("패스키로 확인해야 합니다")],
);

export function errorText(message: string): string {
  for (const [re, out] of ERRORS) {
    const m = message.match(re);
    if (m) return typeof out === "string" ? t(out) : out(m);
  }
  return message;
}

export function loggedOutText(reason?: string): string | undefined {
  switch (reason) {
    case "taken_over":
      return t("다른 기기에서 로그인해 이 기기는 로그아웃되었습니다.");
    case "idle":
      return t("오래 사용하지 않아 로그아웃되었습니다.");
    case "logout":
      return t("로그아웃되었습니다.");
    case "expired":
      return t("로그인이 만료되었습니다. 다시 로그인하세요.");
    default:
      return undefined;
  }
}

// What the "always allow" button grants, in the user's words.
export function allowAlwaysLabel(suggestions: unknown[] | undefined): string {
  const parts: string[] = [];
  for (const s of (suggestions ?? []) as Record<string, unknown>[]) {
    const destination = String(s.destination);
    const where = Object.hasOwn(DESTINATION_LABEL, destination) ? t(DESTINATION_LABEL[destination]) : "";
    if (s.type === "setMode") {
      parts.push(s.mode === "acceptEdits" ? t("{where} 동안 편집 모두 허용", { where }) : t("{where} 동안 {mode} 모드", { where, mode: MODE_LABEL[String(s.mode)] ?? String(s.mode) }));
    } else if (s.type === "addRules" && Array.isArray(s.rules)) {
      const rules = (s.rules as { toolName?: string; ruleContent?: string }[]).map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName));
      parts.push(t("{where}에서 항상 허용: {rules}", { where, rules: rules.join(", ") }));
    } else if (s.type === "addDirectories" && Array.isArray(s.directories)) {
      parts.push(t("{where}에 폴더 추가: {folders}", { where, folders: (s.directories as string[]).map(baseName).join(", ") }));
    }
  }
  return parts.join(" · ") || t("항상 허용");
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
  return s.title.trim() || t("(제목 없음)");
}

export function relTime(ms: number, now = Date.now()): string {
  const diff = Math.max(0, now - ms);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return t("방금");
  if (min < 60) return t("{n}분 전", { n: min });
  const hours = Math.floor(min / 60);
  if (hours < 24) return t("{n}시간 전", { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t("{n}일 전", { n: days });
  return monthDay(new Date(ms));
}

// A span of minutes in words: "45분", "12시간", "1시간 30분".
export function minutesText(minutes: number): string {
  const m = Math.max(1, Math.round(minutes));
  if (m < 60) return t("{m}분", { m });
  return m % 60 ? t("{h}시간 {m}분", { h: Math.floor(m / 60), m: m % 60 }) : t("{h}시간", { h: m / 60 });
}

// A time to come with its day: "오늘 21:30", "내일 09:10", "10월 20일 09:10".
export function dayClock(ms: number, now = new Date()): string {
  const d = new Date(ms);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const ahead = Math.round((day(d) - day(now)) / 86_400_000);
  return ahead === 0 ? t("오늘 {time}", { time: clock(d) }) : ahead === 1 ? t("내일 {time}", { time: clock(d) }) : dateTime(d);
}

export function usageLimitLabel(kind: string, scope?: string): string {
  if (kind === "session") return t("현재 세션");
  if (kind === "weekly_all") return t("이번 주 · 모든 모델");
  if (kind === "weekly_scoped" && scope) return t("이번 주 · {scope}", { scope });
  return scope ? `${kind} · ${scope}` : kind;
}

export function usageResetText(at: string, now = new Date()): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const day = d.toDateString() === now.toDateString() ? t("오늘") : monthDay(d);
  return t("{day} {time} 초기화", { day, time: clock(at) });
}

// What a trait of usage Claude Code names went to, and what to do about it, as VS Code words them. Claude Code may name
// traits not listed here; they show by their key alone.
const USAGE_TRAIT: Record<string, { name: string; advice: string }> = {
  cache_miss: {
    name: k("10만 토큰 넘는 캐시 미스"),
    advice: k("캐시되지 않은 입력은 비쌉니다. 쉬던 세션에 메시지를 보낼 때 자주 생깁니다. 자리를 비우기 전에 /compact 하면 다시 시작할 때 부담이 작습니다."),
  },
  long_context: {
    name: k("15만 토큰 넘는 Context"),
    advice: k("캐시되어 있어도 긴 세션은 더 비쌉니다. 작업 중간에 /compact, 새 작업으로 넘어갈 때는 /clear 하세요."),
  },
  subagent_heavy: {
    name: k("서브에이전트를 많이 쓴 세션"),
    advice: k("서브에이전트는 저마다 요청을 보냅니다. 꼭 필요할 때만 띄우고, 간단한 서브에이전트에는 더 싼 모델을 지정해 보세요."),
  },
  high_parallel: {
    name: k("세션 4개 이상 동시 실행"),
    advice: k("모든 세션이 한 한도를 나눠 씁니다. 한꺼번에 돌릴 필요가 없으면 차례로 돌리는 편이 고르게 씁니다."),
  },
  cron: { name: k("8시간 넘게 이어진 세션"), advice: k("대개 백그라운드나 반복 세션입니다. 계속 쓰면 빨리 쌓이니 의도한 것인지 확인하세요.") },
  max_effort: { name: "Effort Max", advice: k("Max는 단계마다 훨씬 오래 생각합니다. 가장 어려운 작업에만 쓰고 평소에는 낮은 단계를 쓰세요.") },
  workflow: {
    name: k("워크플로"),
    advice: k("워크플로는 작업을 여러 에이전트에 나눠 저마다 요청을 보냅니다. 큰 작업에만 쓰세요. Ultracode는 모든 작업에 워크플로를 쓰며 Effort에서 끌 수 있습니다."),
  },
  always_on_context: {
    name: k("4만 토큰 넘게 늘 붙는 Context"),
    advice: k("CLAUDE.md, MCP 도구, 스킬, 메모리는 요청마다 함께 갑니다. /context로 무엇이 자리를 차지하는지 보고 필요 없는 것은 줄이거나 끄세요."),
  },
  large_tool_results: {
    name: k("1만 토큰 넘는 도구 결과"),
    advice: k("큰 결과는 요약하거나 지울 때까지 이후 요청마다 다시 듭니다. 읽기·검색·명령 출력을 좁히거나, 시끄러운 작업은 서브에이전트에 맡기세요."),
  },
};

export function usageTrait(key: string): { name: string; advice: string } | undefined {
  if (!Object.hasOwn(USAGE_TRAIT, key)) return undefined;
  const trait = USAGE_TRAIT[key];
  return { name: t(trait.name), advice: t(trait.advice) };
}

export type UsageGroup = "skills" | "agents" | "plugins" | "mcpServers";

const USAGE_GROUP: Record<UsageGroup, { title: string; advice: string; label?: (name: string) => string }> = {
  skills: { title: k("스킬"), label: (n) => `/${n}`, advice: k("무거운 스킬은 범위를 줄이거나, 스킬 머리말(frontmatter)에서 더 싼 모델을 지정할 수 있습니다.") },
  agents: { title: k("서브에이전트"), advice: k("자주 돈다면 그 서브에이전트에 더 싼 모델을 지정하거나 프롬프트를 줄여 보세요.") },
  plugins: { title: k("플러그인"), advice: k("이 플러그인이 더하는 에이전트, 스킬, MCP 도구가 모두 한도에 들어갑니다.") },
  mcpServers: { title: k("MCP 서버"), advice: k("MCP 도구 결과는 세션이 끝날 때까지 Context에 남습니다. /compact로 비우거나 쓰지 않는 서버는 끄세요.") },
};

export function usageGroup(group: UsageGroup): { title: string; advice: string; label?: (name: string) => string } {
  const g = USAGE_GROUP[group];
  return { ...g, title: t(g.title), advice: t(g.advice) };
}

// How long the user has been away, as VS Code tells it: "12분", "3시간 4분", "2일 5시간".
export function idleText(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return t("{m}분", { m });
  const h = Math.floor(m / 60);
  return h < 24 ? t("{h}시간 {m}분", { h, m: m % 60 }) : t("{d}일 {h}시간", { d: Math.floor(h / 24), h: h % 24 });
}

// How long something took: "12초", "3분 4초", "1시간 2분".
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return t("{s}초", { s });
  const m = Math.floor(s / 60);
  return m < 60 ? t("{m}분 {s}초", { m, s: s % 60 }) : t("{h}시간 {m}분", { h: Math.floor(m / 60), m: m % 60 });
}

const TASK_KIND_LABEL: Record<string, string> = {
  local_agent: k("서브에이전트"),
  local_bash: k("셸 (Bash)"),
  local_workflow: k("워크플로"),
  remote_agent: k("원격 에이전트"),
  monitor_mcp: k("모니터"),
  monitor_ws: k("모니터 (WebSocket)"),
  mcp_task: k("MCP 작업"),
  in_process_teammate: k("팀원"),
  dream: k("기억 정리"),
};

export function taskKindLabel(kind?: string): string {
  if (!kind) return "";
  return Object.hasOwn(TASK_KIND_LABEL, kind) ? t(TASK_KIND_LABEL[kind]) : kind;
}

// What the model offers: Fast mode, turning Thinking off (unknown when absent), and whether Claude Code holds its Effort at
// High while Thinking is off.
export function modelOffers(models: ModelOption[], model?: string): { fast: boolean; thinkingOff?: boolean; capped: boolean } {
  const known = findModel(models, model) ?? baseModel(models, model);
  const id = (known?.resolved ?? model ?? "").replace(/\[1m\]$/i, "");
  return { fast: known?.fast === true, thinkingOff: known?.thinkingOff, capped: id === "claude-opus-5" };
}

const FAST_REASON: Record<string, string> = {
  extra_usage_disabled: k("사용 크레딧이 꺼져 있습니다 (claude.ai 설정 > 사용량)"),
  free: k("유료 요금제나 사용 크레딧이 필요합니다"),
  preference: k("조직에서 Fast 모드를 꺼 두었습니다"),
  model_not_allowed: k("조직의 허용 모델에 Fast 모드용 Opus가 없습니다"),
  network_error: k("가능 여부를 확인하지 못했습니다 (네트워크)"),
  not_first_party: k("Anthropic API에 바로 연결할 때만 쓸 수 있습니다"),
  disabled_by_env: k("CLAUDE_CODE_DISABLE_FAST_MODE가 켜져 있습니다"),
  unknown: k("지금은 쓸 수 없습니다"),
  pending: k("쓸 수 있는지 확인하는 중입니다"),
};

// Why Claude Code says Fast mode cannot run. A broker session reports sdk_opt_in_required until Fast mode is first asked
// for, which says nothing of the account.
export function fastReasonText(reason?: string): string | undefined {
  if (!reason || reason === "sdk_opt_in_required") return undefined;
  return Object.hasOwn(FAST_REASON, reason) ? t(FAST_REASON[reason]) : t("지금은 쓸 수 없습니다 ({reason})", { reason });
}
