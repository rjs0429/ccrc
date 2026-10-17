import { useEffect, useState, type ReactNode } from "react";
import { SEND_FILES_CLI, type DoctorCheck, type HealthInfo, type UpdateInfo } from "../../../../broker/src/admin-protocol.ts";
import { request } from "../../api.ts";
import { Button, Icon, Spinner } from "../../components/ui.tsx";
import { BROKER_SESSIONS_LABEL } from "../../labels.ts";
import { SectionTitle, dateTime, showError } from "./common.tsx";

const RECHECK_MS = 3000;

const CHECK_LABEL: Record<string, string> = {
  extension: "VS Code 확장",
  cli: "Claude Code 실행 파일",
  initialize: "initialize 응답",
  context: "context 조회",
  exit: "정상 종료",
  broker_cli: "원격 세션 CLI",
};

const CLI_SOURCE: Record<string, string> = {
  vscode: "VS Code",
  global: "전역 설치",
  config: "설정 경로",
  sdk: "SDK 내장",
};

function cliText(c: HealthInfo["brokerCli"]): string {
  return c ? `${c.version ?? "-"} · ${CLI_SOURCE[c.source] ?? c.source}` : "-";
}

const DETAIL: Record<string, string> = {
  "not found": "찾을 수 없음",
  "no answer": "응답 없음",
  "no version": "버전을 알 수 없음",
  "timed out": "시간 초과",
};

function detailText(c: DoctorCheck): string {
  const d = c.detail ?? "";
  const cli = c.name === "broker_cli" ? d.match(/^(\S+) (\w+)$/) : null;
  if (cli) {
    const where = CLI_SOURCE[cli[2]] ?? cli[2];
    if (cli[1] === "missing") return `${where} 실행 파일을 찾을 수 없음`;
    return `${cli[1] === "unknown" ? "버전을 알 수 없음" : cli[1]} · ${where}${c.warn ? ` · 파일 보내기는 ${SEND_FILES_CLI} 이상` : ""}`;
  }
  const counts = d.match(/^(\d+) models, (\d+) commands$/);
  if (counts) return `모델 ${counts[1]}개 · 명령 ${counts[2]}개`;
  return (
    DETAIL[d] ??
    d
      .replace(/^timed out/, "시간 초과")
      .replace(/^exit code (\S+)/, "종료 코드 $1")
      .replace(/^signal (\S+)/, "신호 $1")
      .replace(/^cannot start/, "시작하지 못함")
  );
}

function wrapperText(w: HealthInfo["wrapper"]): string {
  if (w.unreadable) return "설정을 읽지 못함";
  if (!w.path) return "꺼짐";
  if (!w.on) return "꺼짐 (CCRC_WRAPPER=off)";
  return w.thisBroker ? "켜짐" : "켜짐 · 다른 경로";
}

// The brokerSessions setting, which only the laptop changes.
function brokerSessionsText(b: HealthInfo["brokerSessions"]): string {
  if (!b) return "-";
  const label = BROKER_SESSIONS_LABEL[b.mode] ?? b.mode;
  return b.mode === "apiKey" ? `${label} · ${b.ready ? "설정됨" : "키 없음"}` : label;
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 text-[15px]">
      <span className="shrink-0">{label}</span>
      <span className="min-w-0 truncate text-right font-mono text-[13px] text-muted">{value}</span>
    </div>
  );
}

const KIND_LABEL: Record<UpdateInfo["kind"], string> = { installed: "설치본", git: "개발 사본", plain: "직접 받은 사본" };

function newVersion(u: UpdateInfo): ReactNode {
  if (u.available && u.latest) {
    const text = `${u.latest} 있음`;
    return u.url ? (
      <a href={u.url} target="_blank" rel="noopener noreferrer" className="text-accent underline" data-update-link>
        {text} · 변경 내용
      </a>
    ) : (
      <span className="text-accent">{text}</span>
    );
  }
  if (!u.enabled) return "확인 끔";
  if (u.error && !u.latest) return "확인 실패";
  if (u.latest) return u.kind === "installed" ? "없음 (최신)" : `최신 릴리스 ${u.latest}`;
  return u.checkedAt ? "릴리스 없음" : "아직 확인 전";
}

// ccrc's own version and the newest release the broker found; updates are applied on the laptop.
function UpdateRows({ u }: { u: UpdateInfo }) {
  return (
    <>
      <Row label="ccrc 버전" value={`${u.version ?? "-"} · ${KIND_LABEL[u.kind]}`} />
      <Row label="새 버전" value={newVersion(u)} />
      <Row label="마지막 확인" value={u.checkedAt ? `${dateTime(u.checkedAt)}${u.error ? " · 실패" : ""}` : "-"} />
    </>
  );
}

export function HealthSection() {
  const [info, setInfo] = useState<HealthInfo>();
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    request<HealthInfo>("GET", "/api/health").then(setInfo, (e) => showError(e));
  }, []);

  useEffect(() => {
    if (!info?.running || checking) return;
    const timer = setTimeout(() => request<HealthInfo>("GET", "/api/health").then(setInfo, () => {}), RECHECK_MS);
    return () => clearTimeout(timer);
  }, [info, checking]);

  const check = async () => {
    setChecking(true);
    try {
      setInfo(await request<HealthInfo>("POST", "/api/health/check", {}));
    } catch (e) {
      showError(e);
    } finally {
      setChecking(false);
    }
  };

  const last = info?.last;
  const busy = checking || Boolean(info?.running);
  return (
    <section className="space-y-2">
      <SectionTitle>호환성 점검</SectionTitle>
      {!info ? (
        <div className="flex justify-center rounded-xl bg-surface p-4 text-muted">
          <Spinner />
        </div>
      ) : (
        <div className="divide-y divide-line rounded-xl bg-surface px-3.5">
          <Row label="VS Code 확장" value={info.extensionVersion ?? "없음"} />
          <Row label="Claude Code" value={info.cliVersion ?? "-"} />
          <Row label="원격 세션 CLI" value={cliText(info.brokerCli)} />
          {info.update ? <UpdateRows u={info.update} /> : <Row label="ccrc" value={info.brokerVersion ?? "-"} />}
          <Row label="VS Code 래퍼" value={wrapperText(info.wrapper)} />
          <Row label="원격 세션 인증" value={brokerSessionsText(info.brokerSessions)} />
        </div>
      )}
      {last && (
        <div className="rounded-xl bg-surface p-3.5">
          <div className="flex items-center gap-2 text-[15px]">
            <span className={`size-2.5 shrink-0 rounded-full ${last.ok ? "bg-ok" : "bg-danger"}`} />
            <span className="flex-1 font-medium">{last.ok ? "점검 통과" : "점검 실패"}</span>
            <span className="text-xs text-muted">{dateTime(last.at)}</span>
          </div>
          <ul className="mt-2 space-y-1 text-[13px]">
            {last.checks.map((c) => (
              <li key={c.name} className="flex items-start gap-2">
                {!c.ok ? (
                  <Icon.x className="mt-0.5 size-4 shrink-0 text-danger" />
                ) : c.warn ? (
                  <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-warn text-[11px] font-bold text-white" aria-label="확인 필요">
                    !
                  </span>
                ) : (
                  <Icon.check className="mt-0.5 size-4 shrink-0 text-ok" />
                )}
                <span className="shrink-0">{CHECK_LABEL[c.name] ?? c.name}</span>
                {c.detail && <span className="min-w-0 flex-1 text-right text-muted">{detailText(c)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <Button className="w-full" disabled={busy || !info} onClick={() => void check()}>
        {busy ? (
          <span className="inline-flex items-center gap-2">
            <Spinner />
            점검하는 중…
          </span>
        ) : (
          "지금 점검"
        )}
      </Button>
      <p className="px-1 text-xs leading-relaxed text-muted">
        VS Code 확장에 든 Claude Code를 래퍼로 띄워, 모델을 부르지 않고 첫 응답과 종료까지 확인합니다. 6시간마다 확장 버전을 보고, 바뀌었거나 지난 점검이 실패했으면 다시
        점검합니다.
      </p>
      {info?.update && (
        <p className="px-1 text-xs leading-relaxed text-muted" data-update-note>
          {info.update.kind === "installed"
            ? `새 버전은 노트북에서 ccrc update 로 적용하고, 문제가 있으면 ccrc rollback 으로 되돌립니다.${info.update.enabled ? " 새 버전은 하루 한 번 확인합니다." : ""}`
            : "개발 사본은 git 으로 갱신합니다. 설치본으로 쓰려면 노트북에서 ccrc update --from <저장소 경로> 를 실행합니다."}
        </p>
      )}
      <p className="px-1 text-xs leading-relaxed text-muted" data-broker-sessions-note>
        원격 세션 인증은 여기서 새로 시작하는 Claude Code가 로그인하는 방식입니다. 노트북에서 ccrc config set brokerSessions off · apiKey · subscription 으로 바꿉니다.
      </p>
    </section>
  );
}
