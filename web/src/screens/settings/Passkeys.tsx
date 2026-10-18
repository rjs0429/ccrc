import { useEffect, useState } from "react";
import { api, ApiError, type PasskeyList, type PasskeyView } from "../../api.ts";
import { Button, Sheet, Spinner } from "../../components/ui.tsx";
import { createPasskey, passkeyError, passkeysSupported } from "../../passkey.ts";
import { toast } from "../../state.ts";
import { SectionTitle, dateTime, showError } from "./common.tsx";

const INPUT = "w-full rounded-xl border border-line bg-surface px-3.5 py-3 text-[16px] outline-none focus:border-accent";

const FAILURE: Record<string, string> = {
  wrong_password: "비밀번호가 맞지 않습니다",
  locked: "시도가 많아 잠시 잠겼습니다",
  local: "노트북 화면에서는 패스키를 쓰지 않습니다",
  insecure_origin: "이 주소에서는 패스키를 쓸 수 없습니다. tailnet HTTPS 주소로 여세요",
  too_many: "패스키는 10개까지 등록할 수 있습니다",
  already_registered: "이미 등록된 패스키입니다",
  challenge_expired: "시간이 지났습니다. 다시 시도하세요",
  passkey_invalid: "패스키 응답을 확인하지 못했습니다. 다시 시도하세요",
  not_found: "이미 지워진 패스키입니다",
};

function failure(e: unknown): string {
  if (e instanceof ApiError && typeof e.body.error === "string") return FAILURE[e.body.error] ?? e.message;
  return passkeyError(e);
}

const when = (ms: number) => dateTime(new Date(ms).toISOString());

// Registering takes two taps: the password goes first, so the second tap can call WebAuthn at once, as Safari asks.
function AddSheet({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [password, setPassword] = useState("");
  const [options, setOptions] = useState<Record<string, unknown>>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const next = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setOptions((await api.passkeyRegisterOptions(password)).options);
      setPassword("");
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  };

  const register = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.passkeyRegister(await createPasskey(options!));
      toast("패스키를 등록했습니다");
      onAdded();
    } catch (e) {
      setError(failure(e));
      setOptions(undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title="패스키 등록" onClose={onClose}>
      <div className="space-y-3 px-1" data-passkey-add={options ? "create" : "password"}>
        {!options ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void next();
            }}
          >
            <p className="text-[15px]">먼저 ccrc 비밀번호를 입력하세요.</p>
            <input type="password" autoComplete="current-password" placeholder="비밀번호" value={password} onChange={(e) => setPassword(e.target.value)} className={INPUT} />
            {error && <div className="text-sm text-danger">{error}</div>}
            <Button kind="primary" className="w-full" disabled={busy || !password}>
              {busy ? "확인 중…" : "다음"}
            </Button>
          </form>
        ) : (
          <>
            <p className="text-[15px]">이 휴대폰에 패스키를 만듭니다. Face ID(또는 휴대폰 암호)로 확인하세요.</p>
            {error && <div className="text-sm text-danger">{error}</div>}
            <Button kind="primary" className="w-full" disabled={busy} onClick={() => void register()}>
              {busy ? "등록 중…" : "Face ID로 등록"}
            </Button>
          </>
        )}
      </div>
    </Sheet>
  );
}

function RemoveSheet({ passkey, onClose, onRemoved }: { passkey: PasskeyView; onClose: () => void; onRemoved: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.passkeyRemove(passkey.id, password);
      toast("패스키를 지웠습니다");
      onRemoved();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title="패스키 지우기" onClose={onClose}>
      <form
        className="space-y-3 px-1"
        data-passkey-remove
        onSubmit={(e) => {
          e.preventDefault();
          void remove();
        }}
      >
        <p className="text-[15px]">
          {passkey.device}에서 {when(passkey.createdAt)}에 등록한 패스키를 지웁니다. 남은 패스키가 없으면 다시 확인하지 않습니다.
        </p>
        <input type="password" autoComplete="current-password" placeholder="비밀번호" value={password} onChange={(e) => setPassword(e.target.value)} className={INPUT} />
        {error && <div className="text-sm text-danger">{error}</div>}
        <Button kind="danger" className="w-full" disabled={busy || !password}>
          {busy ? "지우는 중…" : "지우기"}
        </Button>
      </form>
    </Sheet>
  );
}

// The passkeys that confirm a remote login, on the account page.
export function PasskeySection() {
  const [list, setList] = useState<PasskeyList>();
  const [round, setRound] = useState(0);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<PasskeyView>();

  useEffect(() => {
    let live = true;
    api.passkeys().then(
      (r) => live && setList(r),
      (e: unknown) => live && showError(e),
    );
    return () => {
      live = false;
    };
  }, [round]);

  const reload = () => {
    setAdding(false);
    setRemoving(undefined);
    setRound((r) => r + 1);
  };
  const supported = passkeysSupported();

  return (
    <section className="space-y-2" data-passkeys>
      <SectionTitle>패스키 (Face ID)</SectionTitle>
      {!list ? (
        <div className="flex items-center gap-2 px-1 py-2 text-sm text-muted">
          <Spinner className="size-4" /> 불러오는 중…
        </div>
      ) : (
        <>
          <p className="px-1 text-sm text-muted">
            패스키를 등록하면 노트북 밖에서 로그인할 때와 그 뒤 {list.hours}시간마다 패스키로 다시 확인합니다. 노트북에서 연 화면은 묻지 않습니다.
          </p>
          {list.passkeys.length > 0 && (
            <div className="overflow-hidden rounded-xl bg-surface">
              {list.passkeys.map((p) => (
                <div key={p.id} className="flex items-center gap-3 border-b border-line px-3.5 py-2.5 last:border-0" data-passkey={p.id.slice(0, 12)}>
                  <div className="min-w-0 flex-1">
                    <div className="text-[15px] font-medium">{p.device}</div>
                    <div className="text-xs text-muted">
                      {when(p.createdAt)} 등록{p.lastUsedAt ? ` · 마지막 사용 ${when(p.lastUsedAt)}` : ""}
                      {p.backedUp ? " · 동기화됨" : ""}
                      {p.here ? "" : " · 다른 주소용"}
                    </div>
                  </div>
                  <button onClick={() => setRemoving(p)} className="min-h-11 shrink-0 rounded-lg px-3 text-sm font-medium text-danger">
                    지우기
                  </button>
                </div>
              ))}
            </div>
          )}
          {list.local ? (
            <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-sm">노트북에서 연 화면에서는 패스키를 등록하지 않습니다. 휴대폰의 ccrc에서 등록하세요.</p>
          ) : !supported ? (
            <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-sm">이 브라우저는 패스키를 지원하지 않습니다.</p>
          ) : (
            <Button className="w-full" onClick={() => setAdding(true)}>
              {list.passkeys.length ? "패스키 하나 더 등록" : "패스키 등록"}
            </Button>
          )}
          <p className="px-1 text-xs text-muted">
            패스키를 잃었다면 노트북 터미널에서 <span className="font-mono">ccrc passkey reset</span> 으로 풉니다.
          </p>
        </>
      )}
      {adding && <AddSheet onClose={() => setAdding(false)} onAdded={reload} />}
      {removing && <RemoveSheet passkey={removing} onClose={() => setRemoving(undefined)} onRemoved={reload} />}
    </section>
  );
}
