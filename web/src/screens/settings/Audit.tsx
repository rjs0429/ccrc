import { useEffect, useState } from "react";
import type { AuditEntry, AuditPage } from "../../../../broker/src/admin-protocol.ts";
import { request } from "../../api.ts";
import { Spinner } from "../../components/ui.tsx";
import { EFFORT_LABEL, MODE_LABEL, baseName } from "../../labels.ts";
import { placeLabel } from "../../worktree.ts";
import { SectionTitle, dateTime, showError } from "./common.tsx";

const PAGE = 30;

const EVENT_LABEL: Record<string, string> = {
  login: "로그인",
  login_failed: "로그인 실패",
  logout: "로그아웃",
  lease_revoked: "로그인 해제됨",
  password_changed: "비밀번호 바꿈",
  window_taken: "다른 창으로 옮김",
  device_denied: "허용되지 않은 기기",
  send: "메시지 보냄",
  new_session: "새 세션",
  answer: "요청에 답함",
  interrupt: "중지",
  set_mode: "권한 모드 바꿈",
  set_model: "모델 바꿈",
  set_effort: "Effort 바꿈",
  set_ultracode: "Ultracode 바꿈",
  set_fast: "Fast 모드 바꿈",
  set_thinking: "Thinking 바꿈",
  start_settings: "시작 설정 적용",
  release: "원격 실행 끝냄",
  attach: "VS Code 세션 연결",
  handoff: "VS Code로 넘김",
  upload: "파일 첨부",
  file_read: "파일 열람",
  agent_transcript: "에이전트 기록 열람",
  call: "세션 작업",
  folder_index: "폴더 파일 목록 만듦",
  folder_denied: "폴더 요청 거부됨",
  claude_settings: "Claude Code 설정 바꿈",
  push_subscribe: "알림 켬",
  push_unsubscribe: "알림 끔",
  doctor: "호환성 점검",
  archive: "보관 해제",
  worktree_remove: "worktree 지우기",
  fork: "갈래",
  rewind_conversation: "대화 되돌리기",
  config: "ccrc 설정 바꿈",
};

const CALL_LABEL: Record<string, string> = {
  mcp_toggle: "MCP 켜기·끄기",
  mcp_reconnect: "MCP 다시 연결",
  rewind: "파일 되돌리기",
  stop_task: "작업 중지",
  resume: "이어서 실행",
  set_output_style: "출력 스타일 바꿈",
  rename: "이름 바꿈",
};

const READ_OUTCOME: Record<string, string> = {
  ok: "",
  truncated: "앞부분만",
  denied: "거부됨",
  not_found: "없음",
  too_large: "너무 큼",
  invalid: "잘못된 링크",
  failed: "실패",
  ticket_invalid: "잘못된 임시 링크",
  ticket_expired: "만료된 임시 링크",
};

const WORD: Record<string, string> = {
  allow: "허용",
  allow_always: "항상 허용",
  deny: "거부",
  keep_planning: "아니요, 계속 계획하기",
  invalid: "비밀번호 틀림",
  locked: "잠김",
  taken_over: "다른 기기에서 로그인",
  idle: "오래 쓰지 않음",
  logout: "로그아웃",
  expired: "만료",
  accept: "보냄",
  decline: "거절",
  cancel: "취소",
};

// The value as a label from the first map that has it, else as it is.
function named(v: unknown, ...maps: Record<string, string>[]): string {
  if (typeof v !== "string") return "";
  for (const m of maps) if (Object.hasOwn(m, v)) return m[v];
  return v;
}

// A change to a session without a process waits for the session to start here.
function changed(value: string, e: AuditEntry): string {
  return e.start ? `${value} · 시작할 때` : value;
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
      return changed(e.on ? "켬" : "끔", e);
    case "start_settings":
      return [named(e.model), named(e.mode, MODE_LABEL), named(e.effort, EFFORT_LABEL), e.ultracode ? "Ultracode" : "", e.fast ? "Fast" : "", e.thinking === false ? "Thinking 끔" : ""]
        .filter(Boolean)
        .join(" · ");
    case "answer":
      return e.kind === "elicitation"
        ? ["입력 요청", named(e.action, WORD), named(e.server)].filter(Boolean).join(" · ")
        : named(e.decision, WORD, MODE_LABEL);
    case "call":
      return [e.op === "archive" ? (e.archived ? "보관" : "보관 해제") : named(e.op, CALL_LABEL), named(e.server), named(e.style)].filter(Boolean).join(" · ");
    case "archive":
      return e.by === "send" ? "메시지를 보내서" : "";
    case "claude_settings":
      return Array.isArray(e.keys) ? e.keys.join(", ") : "";
    case "file_read":
      return [typeof e.path === "string" ? baseName(e.path) : "", e.ticket && e.outcome === "ok" ? "임시 링크" : "", named(e.outcome, READ_OUTCOME)].filter(Boolean).join(" · ");
    case "new_session":
      return [
        typeof e.cwd === "string" ? placeLabel(e.cwd) : "",
        e.ultracode ? "Ultracode" : "",
        e.fast ? "Fast" : "",
        e.thinking === false ? "Thinking 끔" : "",
        typeof e.attachments === "number" ? `첨부 ${e.attachments}개` : "",
      ]
        .filter(Boolean)
        .join(" · ");
    case "worktree_remove":
      return [
        typeof e.path === "string" ? placeLabel(e.path) : "",
        typeof e.discarded === "number" && e.discarded > 0 ? `바뀐 파일 ${e.discarded}개 버림` : "",
        typeof e.branchKept === "string" ? "브랜치 남김" : "",
      ]
        .filter(Boolean)
        .join(" · ");
    case "folder_index":
      return [typeof e.cwd === "string" ? baseName(e.cwd) : "", typeof e.files === "number" ? `파일 ${e.files}개` : ""].filter(Boolean).join(" · ");
    case "folder_denied":
      return typeof e.cwd === "string" ? baseName(e.cwd) : "";
    case "login_failed":
    case "lease_revoked":
      return named(e.reason, WORD);
    case "device_denied":
      return named(e.ip);
    case "send":
      return e.via === "inbox" ? "다른 세션 메시지로" : typeof e.attachments === "number" ? `첨부 ${e.attachments}개` : "";
    case "config":
      return e.key === "vscodeArchive" ? `VS Code 보관 보기 ${e.value ? "켬" : "끔"}` : named(e.key);
    case "fork":
      return [e.before ? "메시지에서" : "지금까지", typeof e.chars === "number" ? "바로 시작" : "", typeof e.attachments === "number" ? `첨부 ${e.attachments}개` : ""].filter(Boolean).join(" · ");
    case "rewind_conversation":
      return [e.choice === "both" ? "대화와 코드" : "대화만", e.mode === "in_place" ? "제자리" : "새 세션"].join(" · ");
    default:
      return "";
  }
}

function Entry({ e }: { e: AuditEntry }) {
  const more = detail(e);
  const who = [e.device === "local" ? "노트북" : named(e.device), named(e.sessionId).slice(0, 8)].filter(Boolean).join(" · ");
  return (
    <li className="px-3.5 py-2.5">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-[15px]">
          {named(e.event, EVENT_LABEL)}
          {more && <span className="text-muted"> · {more}</span>}
        </span>
        <span className="shrink-0 text-xs text-muted">{dateTime(e.ts)}</span>
      </div>
      {who && <div className="mt-0.5 truncate font-mono text-xs text-muted">{who}</div>}
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
      <SectionTitle>활동 기록</SectionTitle>
      <div className="overflow-hidden rounded-xl bg-surface">
        {entries && entries.length > 0 && (
          <ul className="divide-y divide-line">
            {entries.map((e, i) => (
              <Entry key={`${e.ts}-${i}`} e={e} />
            ))}
          </ul>
        )}
        {entries?.length === 0 && <div className="p-4 text-center text-sm text-muted">기록이 없습니다</div>}
        {loading && (
          <div className="flex justify-center p-4 text-muted">
            <Spinner />
          </div>
        )}
        {!loading && next !== undefined && (
          <button onClick={() => void load(next)} className="w-full border-t border-line py-3 text-sm text-muted">
            더 보기
          </button>
        )}
      </div>
      <p className="px-1 text-xs text-muted">원격에서 한 일을 기록합니다. 메시지 내용과 도구 입력은 남기지 않습니다.</p>
    </section>
  );
}
