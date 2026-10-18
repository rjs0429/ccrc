import { useState } from "react";
import { api, ApiError } from "../api.ts";
import { Button, Sheet } from "../components/ui.tsx";
import { k, t } from "../i18n/index.ts";
import { loggedOutText, relTime } from "../labels.ts";
import { startSession, useApp } from "../state.ts";

const NOT_CONFIGURED = k("로그인 정보가 아직 없습니다. 노트북 터미널에서 ccrc passwd 를 실행해 설정하세요.");

function failureText(e: unknown): string {
  if (!(e instanceof ApiError)) return t("서버에 연결할 수 없습니다.");
  switch (e.body.error) {
    case "invalid":
      return t("ID 또는 비밀번호가 맞지 않습니다.");
    case "locked":
      return t("로그인 시도가 많아 잠겼습니다. {n}분 뒤에 다시 시도하세요.", { n: Math.ceil(Number(e.body.retryAfterSec ?? 60) / 60) });
    case "not_configured":
      return t(NOT_CONFIGURED);
    default:
      return e.message;
  }
}

export function Login() {
  const me = useApp((s) => s.me);
  const reason = useApp((s) => s.loggedOutReason);
  const [id, setId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<{ device: string; lastSeen: number } | null>(null);

  const submit = async (takeover: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      await api.login(id.trim(), password, takeover);
      setPassword("");
      setConflict(null);
      startSession();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflict({ device: String(e.body.device), lastSeen: Number(e.body.lastSeen) });
      else setError(failureText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pt-safe pb-safe flex min-h-dvh items-center justify-center px-safe-6">
      <form
        className="w-full max-w-sm space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(false);
        }}
      >
        <div className="mb-6 text-center">
          <img src="/icon-192.png" alt="" className="mx-auto mb-3 size-14 rounded-2xl" />
          <div className="text-xl font-semibold">ccrc</div>
          <div className="mt-1 text-sm text-muted">{t("노트북의 Claude Code 세션")}</div>
        </div>
        {!me?.configured && <div className="rounded-xl bg-surface-2 p-3 text-sm">{t(NOT_CONFIGURED)}</div>}
        {loggedOutText(reason) && <div className="rounded-xl bg-surface-2 p-3 text-sm">{loggedOutText(reason)}</div>}
        <input
          value={id}
          onChange={(e) => setId(e.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          placeholder="ID"
          className="w-full rounded-xl border border-line bg-surface px-3.5 py-3 text-[16px] outline-none focus:border-accent"
        />
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          autoComplete="current-password"
          placeholder={t("비밀번호")}
          className="w-full rounded-xl border border-line bg-surface px-3.5 py-3 text-[16px] outline-none focus:border-accent"
        />
        {error && <div className="text-sm text-danger">{error}</div>}
        <Button kind="primary" className="w-full" disabled={busy || !id.trim() || !password}>
          {busy ? t("확인 중…") : t("로그인")}
        </Button>
      </form>

      {conflict && (
        <Sheet title={t("다른 곳에서 사용 중")} onClose={() => setConflict(null)}>
          <p className="px-1 text-[15px]">
            {t("{device}에서 접속해 있습니다 (마지막 활동 {when}). 그 접속을 끊고 여기서 접속할까요?", {
              device: conflict.device === "local" ? t("노트북") : conflict.device,
              when: relTime(conflict.lastSeen),
            })}
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Button onClick={() => setConflict(null)}>{t("취소")}</Button>
            <Button kind="primary" disabled={busy} onClick={() => void submit(true)}>
              {t("여기서 접속")}
            </Button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
