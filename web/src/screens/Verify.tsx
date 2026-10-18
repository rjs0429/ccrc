import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api.ts";
import { Button, Spinner } from "../components/ui.tsx";
import { passkeyError, passkeysSupported, assertPasskey } from "../passkey.ts";
import { loggedOut, startSession } from "../state.ts";

// The broker's challenge is good for five minutes; one older than this is asked for again before the tap.
const OPTIONS_MS = 4 * 60_000;

function failureText(e: unknown): string {
  if (!(e instanceof ApiError)) return passkeyError(e);
  switch (e.body.error) {
    case "none_here":
      return "이 주소로 등록된 패스키가 없습니다. 패스키를 등록한 주소로 여세요.";
    case "challenge_expired":
      return "확인 시간이 지났습니다. 다시 시도하세요.";
    case "passkey_invalid":
      return "패스키로 확인하지 못했습니다. 다시 시도하세요.";
    case "insecure_origin":
      return "이 주소에서는 패스키를 쓸 수 없습니다. tailnet HTTPS 주소로 여세요.";
    default:
      return e.message;
  }
}

// Shown in place of the app while a passkey has to confirm the login: when it starts, and each passkeyHours after.
export function Verify() {
  const [options, setOptions] = useState<{ at: number; options: Record<string, unknown> }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState(0);
  const fetched = useRef(0);

  useEffect(() => {
    const seq = ++fetched.current;
    setError(undefined);
    api.passkeyVerifyOptions().then(
      (r) => seq === fetched.current && setOptions({ at: Date.now(), options: r.options }),
      (e: unknown) => {
        if (seq !== fetched.current) return;
        if (e instanceof ApiError && e.status === 401) return loggedOut("expired");
        setError(failureText(e));
      },
    );
  }, [round]);

  const confirm = async () => {
    if (!options || Date.now() - options.at > OPTIONS_MS) {
      setOptions(undefined);
      setRound((r) => r + 1);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const credential = await assertPasskey(options.options);
      await api.passkeyVerify(credential);
      startSession();
    } catch (e) {
      setError(failureText(e));
      setOptions(undefined);
      setRound((r) => r + 1);
    } finally {
      setBusy(false);
    }
  };

  const supported = passkeysSupported();
  return (
    <div className="pt-safe pb-safe flex min-h-dvh items-center justify-center px-safe-6" data-verify>
      <div className="w-full max-w-sm space-y-3">
        <div className="mb-6 text-center">
          <img src="/icon-192.png" alt="" className="mx-auto mb-3 size-14 rounded-2xl" />
          <div className="text-xl font-semibold">패스키로 확인</div>
          <div className="mt-1 text-sm text-balance text-muted">로그인을 이어 가려면 이 휴대폰의 패스키(Face ID)로 확인하세요.</div>
        </div>
        {!supported && <div className="rounded-xl bg-surface-2 p-3 text-sm">이 브라우저는 패스키를 지원하지 않습니다.</div>}
        {error && <div className="text-sm text-danger" data-verify-error>{error}</div>}
        <Button kind="primary" className="w-full" disabled={busy || !supported} onClick={() => void confirm()}>
          {busy ? (
            <span className="inline-flex items-center gap-2">
              <Spinner className="size-4" /> 확인 중…
            </span>
          ) : options ? (
            "패스키로 확인"
          ) : error ? (
            "다시 시도"
          ) : (
            "준비 중…"
          )}
        </Button>
        <Button
          kind="ghost"
          className="w-full"
          onClick={async () => {
            await api.logout().catch(() => {});
            loggedOut("logout");
          }}
        >
          로그아웃
        </Button>
        <p className="px-1 pt-2 text-xs text-balance text-muted">
          패스키를 잃었다면 노트북 터미널에서 <span className="font-mono">ccrc passkey reset</span> 을 실행한 뒤 비밀번호로 다시 로그인하세요.
        </p>
      </div>
    </div>
  );
}
