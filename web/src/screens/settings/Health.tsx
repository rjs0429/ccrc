import { useEffect, useState } from "react";
import type { DoctorCheck, HealthInfo } from "../../../../broker/src/admin-protocol.ts";
import { request } from "../../api.ts";
import { Button, Icon, Spinner } from "../../components/ui.tsx";
import { SectionTitle, dateTime, showError } from "./common.tsx";

const RECHECK_MS = 3000;

const CHECK_LABEL: Record<string, string> = {
  extension: "VS Code 확장",
  cli: "Claude Code 실행 파일",
  initialize: "초기화 응답",
  context: "context 조회",
  exit: "정상 종료",
};

const DETAIL: Record<string, string> = {
  "not found": "찾을 수 없음",
  "no answer": "응답 없음",
  "no version": "버전을 알 수 없음",
  "timed out": "시간 초과",
};

function detailText(c: DoctorCheck): string {
  const d = c.detail ?? "";
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

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 text-[15px]">
      <span>{label}</span>
      <span className="min-w-0 truncate text-right font-mono text-[13px] text-muted">{value}</span>
    </div>
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
          <Row label="ccrc" value={info.brokerVersion ?? "-"} />
          <Row label="VS Code 래퍼" value={wrapperText(info.wrapper)} />
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
                {c.ok ? <Icon.check className="mt-0.5 size-4 shrink-0 text-ok" /> : <Icon.x className="mt-0.5 size-4 shrink-0 text-danger" />}
                <span className="shrink-0">{CHECK_LABEL[c.name] ?? c.name}</span>
                {c.detail && <span className="min-w-0 flex-1 text-right break-words text-muted">{detailText(c)}</span>}
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
    </section>
  );
}
