import { useState } from "react";
import { api, ApiError } from "../api.ts";
import { Button, Icon, Row } from "../components/ui.tsx";
import { loadDevice, turnOff } from "../push.ts";
import { leaveSettings, loggedOut, navigate, toast, useApp, type SettingsPage, type SettingsPart } from "../state.ts";
import { AuditSection } from "./settings/Audit.tsx";
import { ClaudeSettingsSection } from "./settings/ClaudeSettings.tsx";
import { HealthSection } from "./settings/Health.tsx";
import { NotificationsSection } from "./settings/Notifications.tsx";
import { PrefsSection } from "./settings/Prefs.tsx";

const PAGES: { page: SettingsPage; title: string }[] = [
  { page: "claude", title: "Claude Code" },
  { page: "alerts", title: "알림과 입력" },
  { page: "account", title: "계정과 보안" },
  { page: "status", title: "상태와 점검" },
];

export function Settings({ page, part }: { page?: SettingsPage; part?: SettingsPart }) {
  const me = useApp((s) => s.me);
  const device = me?.device === "local" ? "노트북" : me?.device;
  const title = PAGES.find((p) => p.page === page)?.title ?? "설정";

  return (
    <div className="flex h-dvh flex-col">
      <header className="pt-safe border-b border-line bg-bg">
        <div className="flex items-center gap-1 px-safe-2 py-2 short:py-0.5">
          <button onClick={() => leaveSettings(page)} aria-label="뒤로" className="rounded-lg p-2">
            <Icon.back />
          </button>
          <div className="flex-1 text-[15px] font-semibold">{title}</div>
        </div>
      </header>
      <main className="pb-safe flex-1 overflow-y-auto px-safe-0">
        <div className="mx-auto max-w-md space-y-6 px-4 py-5">
          {!page && (
            <>
              <div>
                {PAGES.map((p) => (
                  <Row key={p.page} label={p.title} value={p.page === "account" ? device : undefined} onClick={() => navigate({ name: "settings", page: p.page })} />
                ))}
              </div>
              <Button
                kind="danger"
                className="w-full"
                onClick={async () => {
                  await Promise.race([loadDevice().then(turnOff), new Promise((r) => setTimeout(r, 3000))]).catch(() => {});
                  await api.logout().catch(() => {});
                  loggedOut("logout");
                }}
              >
                로그아웃
              </Button>
            </>
          )}
          {page === "claude" && <ClaudeSettingsSection part={part} />}
          {page === "alerts" && (
            <>
              <NotificationsSection />
              <PrefsSection />
            </>
          )}
          {page === "account" && (
            <>
              <section className="space-y-2">
                <div className="text-sm font-semibold text-muted">이 기기</div>
                <div className="rounded-xl bg-surface p-3.5 text-[15px] font-medium">{device}</div>
              </section>
              <PasswordSection />
              <AuditSection />
            </>
          )}
          {page === "status" && <HealthSection />}
        </div>
      </main>
    </div>
  );
}

function PasswordSection() {
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
    <section className="space-y-2">
      <div className="text-sm font-semibold text-muted">비밀번호 바꾸기</div>
      <input type="password" autoComplete="current-password" placeholder="현재 비밀번호" value={current} onChange={(e) => setCurrent(e.target.value)} className={input} />
      <input type="password" autoComplete="new-password" placeholder="새 비밀번호 (10자 이상)" value={next} onChange={(e) => setNext(e.target.value)} className={input} />
      <input type="password" autoComplete="new-password" placeholder="새 비밀번호 확인" value={again} onChange={(e) => setAgain(e.target.value)} className={input} />
      <Button kind="primary" className="w-full" disabled={busy || !current || next.length < 10} onClick={() => void change()}>
        바꾸기
      </Button>
    </section>
  );
}
