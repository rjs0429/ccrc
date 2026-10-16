import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { PushPrefs, TurnEndMode } from "../../../../broker/src/push/types.ts";
import { ApiError } from "../../api.ts";
import { Button, Icon, Spinner } from "../../components/ui.tsx";
import { relTime } from "../../labels.ts";
import { isIos, loadDevice, pushBlock, pushErrorText, savePrefs, sendTest, turnOff, turnOn, type PushBlock, type PushDevice } from "../../push.ts";
import { loggedOut, toast } from "../../state.ts";

const BLOCKED: Record<PushBlock, string> = {
  insecure: "HTTPS 주소로 접속해야 알림을 받을 수 있습니다.",
  ios_install:
    "iPhone에서는 홈 화면에 추가한 앱에서만 알림을 받을 수 있습니다(iOS 16.4 이상). Safari 공유 버튼의 '홈 화면에 추가'로 앱을 만든 뒤 그 앱에서 켜세요.",
  ios_update: "알림을 받으려면 iOS 16.4 이상이 필요합니다.",
  unsupported: "이 브라우저는 푸시 알림을 지원하지 않습니다.",
};

const DELAYS: [number, string][] = [
  [0, "바로"],
  [30, "30초 뒤"],
  [120, "2분 뒤"],
];

const TURN_ENDS: [TurnEndMode, string, string][] = [
  ["remote", "휴대폰에서 보낸 세션", "최근 2시간 안에 휴대폰에서 보내거나 답한 세션만 알립니다"],
  ["all", "모든 세션", "VS Code에서 시킨 작업도 알립니다. 그 작업은 위에서 고른 시간만큼 기다렸다가 알립니다"],
  ["off", "끔", "작업이 끝나도 알리지 않습니다. 권한 요청과 질문은 그대로 알립니다"],
];

function Note({ children }: { children: ReactNode }) {
  return <p className="rounded-xl bg-surface p-3.5 text-sm text-muted">{children}</p>;
}

function Toggle({ label, hint, on, onChange }: { label: string; hint: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button role="switch" aria-checked={on} onClick={() => onChange(!on)} className="flex w-full items-center justify-between gap-3 px-3.5 py-3 text-left">
      <span className="min-w-0">
        <span className="block text-[15px]">{label}</span>
        <span className="block text-xs text-muted">{hint}</span>
      </span>
      <span className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${on ? "bg-accent" : "bg-surface-2"}`}>
        <span className={`absolute top-0.5 left-0 size-5 rounded-full bg-white shadow transition-transform ${on ? "translate-x-[18px]" : "translate-x-0.5"}`} />
      </span>
    </button>
  );
}

function TurnEndChoice({ value, onChange }: { value: TurnEndMode; onChange: (mode: TurnEndMode) => void }) {
  const id = useId();
  return (
    <div className="space-y-2 px-3.5 py-3">
      <div>
        <div className="text-[15px]">작업 완료 알림</div>
        <div className="text-xs text-muted">작업을 마치거나 오류로 멈추면 알립니다</div>
      </div>
      <div role="radiogroup" aria-label="작업 완료 알림" className="space-y-0.5">
        {TURN_ENDS.map(([mode, label, hint]) => (
          <button
            key={mode}
            role="radio"
            aria-checked={value === mode}
            aria-label={mode === "remote" ? `${label} (기본)` : label}
            aria-describedby={`${id}-${mode}`}
            onClick={() => onChange(mode)}
            className={`flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left ${value === mode ? "bg-accent-soft" : "active:bg-surface-2"}`}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[15px]">
                {label}
                {mode === "remote" && <span className="ml-1.5 text-xs text-muted">기본</span>}
              </span>
              <span id={`${id}-${mode}`} className="block text-xs break-keep text-pretty text-muted">{hint}</span>
            </span>
            <Icon.check className={`mt-0.5 size-4 shrink-0 text-accent ${value === mode ? "" : "invisible"}`} />
          </button>
        ))}
      </div>
    </div>
  );
}

function deviceName(device?: string): string {
  return device === "local" ? "노트북" : (device ?? "");
}

export function NotificationsSection() {
  const [block] = useState(pushBlock);
  const [device, setDevice] = useState<PushDevice>();
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const saves = useRef(0);

  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.status === 401) return loggedOut("expired");
    toast(pushErrorText(e));
  };

  useEffect(() => {
    if (block) return;
    let live = true;
    loadDevice().then(
      (d) => live && setDevice(d),
      (e) => {
        if (!live) return;
        setFailed(true);
        fail(e);
      },
    );
    return () => {
      live = false;
    };
  }, [block]);

  // The work starts in the same call, so turnOn asks for permission inside the tap.
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  let body: ReactNode;
  if (block) body = <Note>{BLOCKED[block]}</Note>;
  else if (failed) body = <Note>알림 상태를 확인하지 못했습니다.</Note>;
  else if (!device)
    body = (
      <div className="flex justify-center py-3 text-muted">
        <Spinner />
      </div>
    );
  else if (Notification.permission === "denied")
    body = <Note>알림 권한이 꺼져 있습니다. {isIos() ? "설정 앱 → 알림 → ccrc에서 허용하세요." : "브라우저의 사이트 설정에서 알림을 허용하세요."}</Note>;
  else if (!device.status.subscribed || !device.status.prefs)
    body = (
      <>
        <Note>권한 요청이나 질문이 오거나, 보낸 작업이 끝나거나 멈추면 이 기기로 알립니다.</Note>
        <Button kind="primary" className="w-full" disabled={busy} onClick={() => void run(async () => setDevice(await turnOn(device)))}>
          알림 켜기
        </Button>
      </>
    );
  else {
    const { prefs, lastSent, lastError } = device.status;
    // Shown at once; only the answer to the latest change is applied, since answers can arrive out of order.
    const update = (patch: Partial<PushPrefs>) => {
      const before = device;
      const seq = ++saves.current;
      setDevice({ ...device, status: { ...device.status, prefs: { ...prefs, ...patch } } });
      savePrefs(device, patch).then(
        (saved) => seq === saves.current && setDevice((d) => d && { ...d, status: { ...d.status, prefs: saved } }),
        (e) => {
          if (seq === saves.current) setDevice(before);
          fail(e);
        },
      );
    };
    const test = () =>
      void run(async () => {
        const error = await sendTest(device).then(
          () => undefined,
          (e: unknown) => e,
        );
        setDevice(await loadDevice());
        if (error) throw error;
        toast("테스트 알림을 보냈습니다");
      });
    body = (
      <>
        <div className="rounded-xl bg-surface p-3.5 text-[15px]">
          <div>
            알림 켜짐 <span className="text-muted">· {deviceName(device.status.device)}</span>
          </div>
          {lastError ? (
            <div className="mt-1 text-xs text-danger">
              마지막 전송 실패 ({lastError.status || "연결 안 됨"}) · {relTime(lastError.at)}
            </div>
          ) : lastSent ? (
            <div className="mt-1 text-xs text-muted">마지막 전송 {relTime(lastSent)}</div>
          ) : null}
        </div>
        <div className="divide-y divide-line rounded-xl bg-surface">
          <div className="space-y-2 px-3.5 py-3">
            <div>
              <div className="text-[15px]">VS Code 세션 알림</div>
              <div className="text-xs text-muted">노트북에서 먼저 답하거나 이어 할 수 있게 기다렸다가 알립니다</div>
            </div>
            <div role="radiogroup" aria-label="VS Code 세션 알림" className="flex gap-1 rounded-xl bg-surface-2 p-1">
              {DELAYS.map(([sec, label]) => (
                <button
                  key={sec}
                  role="radio"
                  aria-checked={prefs.vscodeDelaySec === sec}
                  onClick={() => update({ vscodeDelaySec: sec })}
                  className={`flex-1 rounded-lg py-1.5 text-sm ${prefs.vscodeDelaySec === sec ? "bg-surface font-medium shadow-sm" : "text-muted"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <TurnEndChoice value={prefs.turnEnd} onChange={(turnEnd) => update({ turnEnd })} />
          <Toggle label="도구 이름 표시" hint="권한 요청 알림에 도구 이름을, 입력 요청 알림에 MCP 서버 이름을 함께 보여 줍니다. 잠금 화면에도 보입니다" on={prefs.details} onChange={(on) => update({ details: on })} />
        </div>
        <div className="flex gap-2">
          <Button className="flex-1" disabled={busy} onClick={test}>
            테스트 알림 보내기
          </Button>
          <Button kind="danger" className="flex-1" disabled={busy} onClick={() => void run(async () => setDevice(await turnOff(device)))}>
            알림 끄기
          </Button>
        </div>
      </>
    );
  }

  return (
    <section className="space-y-2">
      <div className="text-sm font-semibold text-muted">알림</div>
      {body}
    </section>
  );
}
