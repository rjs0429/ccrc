import { useEffect, useState } from "react";
import type { AuditEntry, AuditPage } from "../../../../broker/src/admin-protocol.ts";
import { request } from "../../api.ts";
import { Spinner } from "../../components/ui.tsx";
import { k, t, tc } from "../../i18n/index.ts";
import { EFFORT_LABEL, MODE_LABEL, baseName } from "../../labels.ts";
import { placeLabel } from "../../worktree.ts";
import { SectionTitle, dateTime, showError } from "./common.tsx";

const PAGE = 30;

const EVENT_LABEL: Record<string, string> = {
  login: k("로그인"),
  login_failed: k("로그인 실패"),
  logout: k("로그아웃"),
  lease_revoked: k("로그인 해제됨"),
  password_changed: k("비밀번호 바꿈"),
  window_taken: k("다른 창으로 옮김"),
  device_denied: k("허용되지 않은 기기"),
  send: k("메시지 보냄"),
  new_session: k("새 세션"),
  answer: k("요청에 답함"),
  interrupt: k("중지"),
  set_mode: k("권한 모드 바꿈"),
  set_model: k("모델 바꿈"),
  set_effort: k("Effort 바꿈"),
  set_ultracode: k("Ultracode 바꿈"),
  set_fast: k("Fast 모드 바꿈"),
  set_thinking: k("Thinking 바꿈"),
  start_settings: k("시작 설정 적용"),
  release: k("원격 실행 끝냄"),
  attach: k("VS Code 세션 연결"),
  handoff: k("VS Code로 넘김"),
  upload: k("파일 첨부"),
  reattach: k("첨부 다시 붙임"),
  file_read: k("파일 열람"),
  agent_transcript: k("에이전트 기록 열람"),
  call: k("세션 작업"),
  folder_index: k("폴더 파일 목록 만듦"),
  folder_denied: k("폴더 요청 거부됨"),
  claude_settings: k("Claude Code 설정 바꿈"),
  push_subscribe: k("알림 켬"),
  push_unsubscribe: k("알림 끔"),
  doctor: k("호환성 점검"),
  archive: k("보관 해제"),
  worktree_remove: k("worktree 지우기"),
  fork: k("갈래"),
  rewind_conversation: k("대화 되돌리기"),
  git_changes: k("git 변경 열람"),
  agent_changes: k("에이전트 변경 열람"),
  side_question: k("곁질문"),
  export: k("대화 내보내기"),
  config: k("ccrc 설정 바꿈"),
  passkey_registered: k("패스키 등록"),
  passkey_verified: k("패스키로 확인"),
  passkey_failed: k("패스키 확인 실패"),
  passkey_removed: k("패스키 지움"),
  passkey_reset: k("패스키 모두 지움"),
};

const CALL_LABEL: Record<string, string> = {
  mcp_toggle: k("MCP 켜기·끄기"),
  mcp_reconnect: k("MCP 다시 연결"),
  rewind: k("파일 되돌리기"),
  stop_task: k("작업 중지"),
  resume: k("이어서 실행"),
  set_output_style: k("출력 스타일 바꿈"),
  unqueue: k("대기 메시지 되돌림"),
  rename: k("이름 바꿈"),
  background: k("백그라운드로 보냄"),
  mcp_authenticate: k("MCP 인증 시작"),
  mcp_oauth_callback: k("MCP 인증 마침"),
};

const READ_OUTCOME: Record<string, string> = {
  ok: "",
  truncated: k("앞부분만"),
  denied: k("거부됨"),
  too_large: k("너무 큼"),
  invalid: k("잘못된 링크"),
  failed: k("실패"),
  ticket_invalid: k("잘못된 임시 링크"),
  ticket_expired: k("만료된 임시 링크"),
};

const WORD: Record<string, string> = {
  allow: k("허용"),
  allow_always: k("항상 허용"),
  deny: k("거부"),
  keep_planning: k("아니요, 계속 계획하기"),
  invalid: k("비밀번호 틀림"),
  locked: k("잠김"),
  taken_over: k("다른 기기에서 로그인"),
  idle: k("오래 쓰지 않음"),
  logout: k("로그아웃"),
  expired: k("만료"),
  accept: k("보냄"),
  decline: k("거절"),
  cancel: k("취소"),
  retry_fallback: k("다른 모델로 계속"),
  edit_prompt: k("메시지 고치기"),
  continue: k("계속"),
  interrupt: k("중지"),
};

// A VS Code tab that opened a session another process held: it moved from a resting tab, or opened as a copy beside
// the process that kept it (heldBy), which shows on the entry's second line.
const MOVED = k("VS Code 다른 탭에서 옮김");
const COPY = k("VS Code에서 복사본으로 엶");
const COPY_OF: Record<string, string> = {
  "VS Code": k("원본은 VS Code의 다른 탭"),
  Terminal: k("원본은 터미널"),
  Background: k("원본은 백그라운드 세션"),
};
const COPY_OF_OTHER = k("원본은 다른 Claude Code 프로세스");

function eventLabel(e: AuditEntry): string {
  if (e.event === "handoff" && e.moved) return t(MOVED);
  if (e.event === "handoff" && e.forked) return t(COPY);
  return named(e.event, EVENT_LABEL);
}

function original(e: AuditEntry): string {
  if (e.event !== "handoff" || !e.forked || e.moved) return "";
  return t(typeof e.heldBy === "string" && Object.hasOwn(COPY_OF, e.heldBy) ? COPY_OF[e.heldBy] : COPY_OF_OTHER);
}

// The value as a label from the first map that has it, else as it is.
function named(v: unknown, ...maps: Record<string, string>[]): string {
  if (typeof v !== "string") return "";
  for (const m of maps) if (Object.hasOwn(m, v)) return t(m[v]);
  return v;
}

// A change to a session without a process waits for the session to start here.
function changed(value: string, e: AuditEntry): string {
  return e.start ? t("{value} · 시작할 때", { value }) : value;
}

function detail(e: AuditEntry): string {
  switch (e.event) {
    case "set_mode":
      return changed(named(e.mode, MODE_LABEL), e);
    case "set_model":
      return changed(named(e.model), e);
    case "set_effort":
      return changed(named(e.effort, EFFORT_LABEL), e);
    case "set_ultracode":
    case "set_fast":
    case "set_thinking":
      return changed(e.on ? t("켬") : t("끔"), e);
    case "start_settings":
      return [named(e.model), named(e.mode, MODE_LABEL), named(e.effort, EFFORT_LABEL), e.ultracode ? "Ultracode" : "", e.fast ? "Fast" : "", e.thinking === false ? t("Thinking 끔") : ""]
        .filter(Boolean)
        .join(" · ");
    case "answer":
      return e.kind === "elicitation"
        ? [t("입력 요청"), named(e.action, WORD), named(e.server)].filter(Boolean).join(" · ")
        : e.kind === "dialog"
          ? [t("확인 요청"), named(e.choice, WORD)].filter(Boolean).join(" · ")
          : named(e.decision, WORD, MODE_LABEL);
    case "call":
      return [e.op === "archive" ? (e.archived ? t("보관") : t("보관 해제")) : named(e.op, CALL_LABEL), named(e.server), named(e.style)].filter(Boolean).join(" · ");
    case "archive":
      return e.by === "send" ? t("메시지를 보내서") : "";
    case "claude_settings":
      return Array.isArray(e.keys) ? e.keys.join(", ") : "";
    case "export":
      return [typeof e.messages === "number" ? t("메시지 {n}개", { n: e.messages }) : "", e.ticket ? t("내려받기") : "", e.outcome === "failed" ? t("실패") : ""].filter(Boolean).join(" · ");
    case "file_read":
      return [typeof e.path === "string" ? baseName(e.path) : "", e.ticket && e.outcome === "ok" ? t("임시 링크") : "", e.outcome === "not_found" ? tc("file read", "없음") : named(e.outcome, READ_OUTCOME)].filter(Boolean).join(" · ");
    case "new_session":
      return [
        typeof e.cwd === "string" ? placeLabel(e.cwd) : "",
        e.ultracode ? "Ultracode" : "",
        e.fast ? "Fast" : "",
        e.thinking === false ? t("Thinking 끔") : "",
        typeof e.attachments === "number" ? t("첨부 {n}개", { n: e.attachments }) : "",
      ]
        .filter(Boolean)
        .join(" · ");
    case "worktree_remove":
      return [
        typeof e.path === "string" ? placeLabel(e.path) : "",
        typeof e.discarded === "number" && e.discarded > 0 ? t("바뀐 파일 {n}개 버림", { n: e.discarded }) : "",
        typeof e.branchKept === "string" ? t("브랜치 남김") : "",
      ]
        .filter(Boolean)
        .join(" · ");
    case "folder_index":
      return [typeof e.cwd === "string" ? baseName(e.cwd) : "", typeof e.files === "number" ? t("파일 {n}개", { n: e.files }) : ""].filter(Boolean).join(" · ");
    case "folder_denied":
      return typeof e.cwd === "string" ? baseName(e.cwd) : "";
    case "login_failed":
    case "lease_revoked":
      return named(e.reason, WORD);
    case "device_denied":
      return named(e.ip);
    case "send":
      return e.via === "inbox" ? t("다른 세션 메시지로") : typeof e.attachments === "number" ? t("첨부 {n}개", { n: e.attachments }) : "";
    case "config":
      if (e.key === "vscodeArchive") return e.value ? t("VS Code 보관 보기 켬") : t("VS Code 보관 보기 끔");
      return named(e.key);
    case "fork":
      return [
        e.before ? t("메시지에서") : t("지금까지"),
        e.draft === true ? t("첫 메시지라 새 세션 화면으로") : "",
        typeof e.worktree === "string" ? `worktree ${e.worktree}` : "",
        typeof e.chars === "number" ? t("바로 시작") : "",
        typeof e.attachments === "number" ? t("첨부 {n}개", { n: e.attachments }) : "",
      ]
        .filter(Boolean)
        .join(" · ");
    case "reattach":
      return typeof e.files === "number" ? t("파일 {n}개", { n: e.files }) : "";
    case "rewind_conversation":
      return [e.choice === "both" ? t("대화와 코드") : t("대화만"), e.mode === "in_place" ? t("제자리") : t("새 세션")].join(" · ");
    case "git_changes":
      return [e.via === "claude" ? t("Claude Code가 읽음") : t("ccrc가 읽음"), typeof e.files === "number" ? t("파일 {n}개", { n: e.files }) : ""].filter(Boolean).join(" · ");
    case "side_question":
      return typeof e.thread === "number" ? t("이어서 묻기 · 앞선 질문 {n}개", { n: e.thread }) : "";
    default:
      return "";
  }
}

function Entry({ e }: { e: AuditEntry }) {
  const more = detail(e);
  const who = [e.device === "local" ? t("노트북") : named(e.device), named(e.sessionId).slice(0, 8)].filter(Boolean).join(" · ");
  const origin = original(e);
  return (
    <li className="px-3.5 py-2.5">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-[15px]">
          {eventLabel(e)}
          {more && <span className="text-muted"> · {more}</span>}
        </span>
        <span className="shrink-0 text-xs text-muted">{dateTime(e.ts)}</span>
      </div>
      {origin ? (
        <div className="mt-0.5 truncate text-xs text-muted">
          <span className="font-mono">{who}</span>
          {who ? ` · ${origin}` : origin}
        </div>
      ) : (
        who && <div className="mt-0.5 truncate font-mono text-xs text-muted">{who}</div>
      )}
    </li>
  );
}

export function AuditSection() {
  const [entries, setEntries] = useState<AuditEntry[]>();
  const [next, setNext] = useState<number>();
  const [loading, setLoading] = useState(false);

  const load = async (before?: number) => {
    setLoading(true);
    try {
      const page = await request<AuditPage>("GET", `/api/audit?limit=${PAGE}${before === undefined ? "" : `&before=${before}`}`);
      setEntries((old) => [...(before === undefined ? [] : (old ?? [])), ...page.entries]);
      setNext(page.next);
    } catch (e) {
      showError(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <section className="space-y-2">
      <SectionTitle>{t("활동 기록")}</SectionTitle>
      <div className="overflow-hidden rounded-xl bg-surface">
        {entries && entries.length > 0 && (
          <ul className="divide-y divide-line">
            {entries.map((e, i) => (
              <Entry key={`${e.ts}-${i}`} e={e} />
            ))}
          </ul>
        )}
        {entries?.length === 0 && <div className="p-4 text-center text-sm text-muted">{t("기록이 없습니다")}</div>}
        {loading && (
          <div className="flex justify-center p-4 text-muted">
            <Spinner />
          </div>
        )}
        {!loading && next !== undefined && (
          <button onClick={() => void load(next)} className="w-full border-t border-line py-3 text-sm text-muted">
            {t("더 보기")}
          </button>
        )}
      </div>
      <p className="px-1 text-xs text-muted">{t("원격에서 한 일을 기록합니다. 메시지 내용과 도구 입력은 남기지 않습니다.")}</p>
    </section>
  );
}
