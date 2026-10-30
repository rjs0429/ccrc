import { useState } from "react";
import { api, ApiError } from "../api.ts";
import { CopyButton } from "../components/CopyButton.tsx";
import { ScrollArea } from "../components/ScrollArea.tsx";
import { Button, Icon, Row } from "../components/ui.tsx";
import { k, t } from "../i18n/index.ts";
import { nav } from "../nav.ts";
import { forgetCopies } from "../offline.ts";
import { getPrefs } from "../prefs.ts";
import { loadDevice, turnOff } from "../push.ts";
import { loggedOut, meAgain, refreshAll, toast, useApp, type SettingsPage, type SettingsPart } from "../state.ts";
import { AuditSection } from "./settings/Audit.tsx";
import { ClaudeSettingsSection, reloadClaudeSettings } from "./settings/ClaudeSettings.tsx";
import { CopySection } from "./settings/Copy.tsx";
import { HealthSection, ReloadSection } from "./settings/Health.tsx";
import { LanguageRow } from "./settings/Language.tsx";
import { NotificationsSection } from "./settings/Notifications.tsx";
import { PasskeySection } from "./settings/Passkeys.tsx";
import { ChatSection, ListSection, PrefsSection } from "./settings/Prefs.tsx";

const PAGES: { page: SettingsPage; title: string }[] = [
  { page: "claude", title: "Claude Code" },
  { page: "alerts", title: k("알림과 입력") },
  { page: "account", title: k("계정과 보안") },
  { page: "status", title: k("상태와 점검") },
];

export function Settings({ page, part }: { page?: SettingsPage; part?: SettingsPart }) {
  const me = useApp((s) => s.me);
  const device = me?.device === "local" ? t("노트북") : me?.device;
  const known = PAGES.find((p) => p.page === page)?.title;
  const title = known ? t(known) : t("설정");
  // A pull reads the laptop's side again: the sections that show it are drawn anew, Claude Code's settings are read
  // again in place, and what is typed elsewhere stays.
  const [round, setRound] = useState(0);
  const refresh = () => {
    setRound((n) => n + 1);
    return Promise.all([refreshAll(), page === "claude" ? reloadClaudeSettings() : undefined]);
  };

  return (
    <div className="flex h-dvh flex-col">
      <header className="screen-header pt-safe border-b border-line bg-bg">
        <div className="flex items-center gap-1 px-safe-2 py-2 short:py-0.5">
          <button onClick={nav.back} aria-label={t("뒤로")} className="-m-1 rounded-lg p-3">
            <Icon.back />
          </button>
          <div className="flex-1 text-[15px] font-semibold">{title}</div>
        </div>
      </header>
      <ScrollArea className="pb-safe px-safe-0" onRefresh={refresh}>
        <div className="mx-auto max-w-md space-y-6 px-4 py-5">
          {!page && (
            <>
              <div>
                {PAGES.map((p) => (
                  <Row key={p.page} label={t(p.title)} value={p.page === "account" ? device : undefined} onClick={() => nav.open({ name: "settings", page: p.page })} />
                ))}
                <LanguageRow />
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
                {t("로그아웃")}
              </Button>
            </>
          )}
          {page === "claude" && <ClaudeSettingsSection part={part} />}
          {page === "alerts" && (
            <>
              <NotificationsSection key={round} />
              <PrefsSection />
              <ChatSection />
              <ListSection />
            </>
          )}
          {page === "account" && (
            <>
              <section className="space-y-2">
                <div className="text-sm font-semibold text-muted">{t("이 기기")}</div>
                <div className="flex min-h-13 items-center gap-2 rounded-xl bg-surface py-1 pr-1 pl-3.5 text-[15px] font-medium" data-device-name>
                  <span className="min-w-0 flex-1 break-words">{device}</span>
                  {device && <CopyButton text={device} label={t("기기 이름 복사")} done={t("기기 이름을 복사했습니다")} />}
                </div>
              </section>
              <PasskeySection key={`p${round}`} />
              <PasswordSection />
              <CopySection key={`c${round}`} />
              <AuditSection key={`a${round}`} />
            </>
          )}
          {page === "status" && (
            <>
              <HealthSection key={round} />
              <ReloadSection />
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function PasswordSection() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);

  const change = async () => {
    if (next !== again) return toast(t("새 비밀번호가 서로 다릅니다"));
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setCurrent("");
      setNext("");
      setAgain("");
      const kept = getPrefs().keepCopies;
      await forgetCopies();
      void api.me().then(meAgain, () => {});
      toast(kept ? t("비밀번호를 바꿨습니다. 휴대폰에 저장한 대화는 지웠습니다") : t("비밀번호를 바꿨습니다"));
    } catch (e) {
      const err = e instanceof ApiError ? e.body.error : "";
      toast(
        err === "invalid"
          ? t("현재 비밀번호가 맞지 않습니다")
          : err === "weak_password"
            ? t("새 비밀번호는 10자 이상이어야 합니다")
            : err === "locked"
              ? t("시도가 많아 잠시 잠겼습니다")
              : String(e),
      );
    } finally {
      setBusy(false);
    }
  };

  const input = "w-full rounded-xl border border-line bg-surface px-3.5 py-3 text-[16px] outline-none focus:border-accent";

  return (
    <section className="space-y-2">
      <div className="text-sm font-semibold text-muted">{t("비밀번호 바꾸기")}</div>
      <input type="password" autoComplete="current-password" placeholder={t("현재 비밀번호")} value={current} onChange={(e) => setCurrent(e.target.value)} className={input} />
      <input type="password" autoComplete="new-password" placeholder={t("새 비밀번호 (10자 이상)")} value={next} onChange={(e) => setNext(e.target.value)} className={input} />
      <input type="password" autoComplete="new-password" placeholder={t("새 비밀번호 확인")} value={again} onChange={(e) => setAgain(e.target.value)} className={input} />
      <Button kind="primary" className="w-full" disabled={busy || !current || next.length < 10} onClick={() => void change()}>
        {t("바꾸기")}
      </Button>
    </section>
  );
}
