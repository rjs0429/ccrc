import { useState } from "react";
import { api, ApiError } from "../api.ts";
import { Button, Icon } from "../components/ui.tsx";
import { loggedOut, navigate, toast, useApp } from "../state.ts";

export function Settings() {
  const me = useApp((s) => s.me);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);

  const change = async () => {
    if (next !== again) return toast("새 비밀번호가 서로 다릅니다");
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setCurrent("");
      setNext("");
      setAgain("");
      toast("비밀번호를 바꿨습니다");
    } catch (e) {
      const err = e instanceof ApiError ? e.body.error : "";
      toast(err === "invalid" ? "현재 비밀번호가 맞지 않습니다" : err === "weak_password" ? "새 비밀번호는 10자 이상이어야 합니다" : err === "locked" ? "시도가 많아 잠시 잠겼습니다" : String(e));
    } finally {
      setBusy(false);
    }
  };

  const input = "w-full rounded-xl border border-line bg-surface px-3.5 py-3 text-[16px] outline-none focus:border-accent";

  return (
    <div className="flex h-dvh flex-col">
      <header className="pt-safe border-b border-line bg-bg">
        <div className="flex items-center gap-1 px-2 py-2">
          <button onClick={() => navigate({ name: "home" })} aria-label="뒤로" className="rounded-lg p-2">
            <Icon.back />
          </button>
          <div className="flex-1 text-[15px] font-semibold">설정</div>
        </div>
      </header>
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-md space-y-6 px-4 py-5">
          <section className="space-y-2">
            <div className="text-sm font-semibold text-muted">접속</div>
            <div className="rounded-xl bg-surface p-3.5 text-[15px]">
              이 기기: <span className="font-medium">{me?.device === "local" ? "노트북" : me?.device}</span>
            </div>
            <Button
              kind="danger"
              className="w-full"
              onClick={async () => {
                await api.logout().catch(() => {});
                loggedOut("logout");
              }}
            >
              로그아웃
            </Button>
          </section>
          <section className="space-y-2">
            <div className="text-sm font-semibold text-muted">비밀번호 바꾸기</div>
            <input type="password" autoComplete="current-password" placeholder="현재 비밀번호" value={current} onChange={(e) => setCurrent(e.target.value)} className={input} />
            <input type="password" autoComplete="new-password" placeholder="새 비밀번호 (10자 이상)" value={next} onChange={(e) => setNext(e.target.value)} className={input} />
            <input type="password" autoComplete="new-password" placeholder="새 비밀번호 확인" value={again} onChange={(e) => setAgain(e.target.value)} className={input} />
            <Button kind="primary" className="w-full" disabled={busy || !current || next.length < 10} onClick={() => void change()}>
              바꾸기
            </Button>
          </section>
        </div>
      </main>
    </div>
  );
}
