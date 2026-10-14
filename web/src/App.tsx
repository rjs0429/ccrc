import { useEffect, useState } from "react";
import { Notice, Spinner } from "./components/ui.tsx";
import { errorText } from "./labels.ts";
import { Chat } from "./screens/Chat.tsx";
import { Home } from "./screens/Home.tsx";
import { Login } from "./screens/Login.tsx";
import { NewSession } from "./screens/NewSession.tsx";
import { Settings } from "./screens/Settings.tsx";
import { takeWindow, useApp } from "./state.ts";

const TOAST_MS = 4000;

function Toast() {
  const toast = useApp((s) => s.toast);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (!toast) return;
    setHidden(false);
    const t = setTimeout(() => setHidden(true), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);
  if (!toast || hidden) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-6">
      <div className="rounded-xl bg-fg px-4 py-2.5 text-sm text-bg shadow-lg">{errorText(toast.text)}</div>
    </div>
  );
}

export function App() {
  const me = useApp((s) => s.me);
  const route = useApp((s) => s.route);
  const conn = useApp((s) => s.conn);

  if (!me) {
    return (
      <div className="flex h-dvh items-center justify-center text-muted">
        <Spinner className="size-6" />
      </div>
    );
  }
  if (!me.loggedIn) return <Login />;

  return (
    <>
      {route.name === "chat" ? (
        <Chat key={route.sessionId} sessionId={route.sessionId} />
      ) : route.name === "new" ? (
        <NewSession />
      ) : route.name === "settings" ? (
        <Settings key={`${route.page ?? ""}/${route.part ?? ""}`} page={route.page} part={route.part} />
      ) : (
        <Home />
      )}
      {conn === "offline" && (
        <div className="pt-safe fixed inset-x-0 top-0 z-30 bg-warn/90 px-4 py-1.5 text-center text-xs text-white">연결이 끊겼습니다. 다시 연결하는 중…</div>
      )}
      {conn === "conflict" && (
        <Notice title="다른 창에서 사용 중입니다" body="이 창에서 계속하면 다른 창의 연결은 끊깁니다." action="이 창에서 계속" onAction={takeWindow} />
      )}
      {conn === "taken" && <Notice title="다른 창에서 사용을 시작했습니다" body="이 창의 연결은 끊겼습니다." action="이 창에서 다시 사용" onAction={takeWindow} />}
      <Toast />
    </>
  );
}
