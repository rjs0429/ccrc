import { useEffect, useState } from "react";
import type { AuditEntry, AuditPage } from "../../../../broker/src/admin-protocol.ts";
import { request } from "../../api.ts";
import { Spinner } from "../../components/ui.tsx";
import { EFFORT_LABEL, MODE_LABEL, baseName } from "../../labels.ts";
import { SectionTitle, dateTime, showError } from "./common.tsx";

const PAGE = 30;

const EVENT_LABEL: Record<string, string> = {
  login: "로그인",
  login_failed: "로그인 실패",
  logout: "로그아웃",
  lease_revoked: "로그인 끝남",
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
  release: "원격 실행 끝냄",
  attach: "VS Code 세션 연결",
  handoff: "VS Code로 넘김",
  upload: "파일 올림",
  file_read: "파일 열람",
  call: "세션 작업",
  claude_settings: "Claude Code 설정 바꿈",
  push_subscribe: "알림 켬",
  push_unsubscribe: "알림 끔",
  doctor: "호환성 점검",
};

const CALL_LABEL: Record<string, string> = {
  mcp_toggle: "MCP 켜기·끄기",
  mcp_reconnect: "MCP 다시 연결",
  rewind: "파일 되돌리기",
  stop_task: "작업 중지",
};

const READ_OUTCOME: Record<string, string> = {
  ok: "",
  truncated: "앞부분만",
  denied: "거부됨",
  not_found: "없음",
  too_large: "너무 큼",
  invalid: "잘못된 링크",
  failed: "실패",
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
};

// The value as a label from the first map that has it, else as it is.
function named(v: unknown, ...maps: Record<string, string>[]): string {
  if (typeof v !== "string") return "";
  for (const m of maps) if (Object.hasOwn(m, v)) return m[v];
  return v;
}

function detail(e: AuditEntry): string {
  switch (e.event) {
    case "set_mode":
      return named(e.mode, MODE_LABEL);
    case "set_model":
      return named(e.model);
    case "set_effort":
      return named(e.effort, EFFORT_LABEL);
    case "set_ultracode":
      return e.on ? "켬" : "끔";
    case "answer":
      return named(e.decision, WORD, MODE_LABEL);
    case "call":
      return [named(e.op, CALL_LABEL), named(e.server)].filter(Boolean).join(" · ");
    case "claude_settings":
      return Array.isArray(e.keys) ? e.keys.join(", ") : "";
    case "file_read":
      return [typeof e.path === "string" ? baseName(e.path) : "", named(e.outcome, READ_OUTCOME)].filter(Boolean).join(" · ");
    case "new_session":
      return typeof e.cwd === "string" ? baseName(e.cwd) : "";
    case "login_failed":
    case "lease_revoked":
      return named(e.reason, WORD);
    case "device_denied":
      return named(e.ip);
    case "send":
      return typeof e.attachments === "number" ? `첨부 ${e.attachments}개` : "";
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
      <SectionTitle>감사 로그</SectionTitle>
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
