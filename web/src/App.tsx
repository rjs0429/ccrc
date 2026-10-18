import { useEffect, useState } from "react";
import { Notice, Spinner } from "./components/ui.tsx";
import { errorText } from "./labels.ts";
import { Chat } from "./screens/Chat.tsx";
import { Home } from "./screens/Home.tsx";
import { Login } from "./screens/Login.tsx";
import { NewSession } from "./screens/NewSession.tsx";
import { OfflineChat, OfflineHome } from "./screens/Offline.tsx";
import { Settings } from "./screens/Settings.tsx";
import { takeWindow, useApp } from "./state.ts";

const TOAST_MS = 4000;
// A toast with a button stays long enough to reach for it.
const ACTION_TOAST_MS = 7000;

function Toast() {
  const toast = useApp((s) => s.toast);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (!toast) return;
    setHidden(false);
    const t = setTimeout(() => setHidden(true), toast.action ? ACTION_TOAST_MS : TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);
  const shown = hidden ? undefined : toast;
  const action = shown?.action;
  // The region stays on the page, so a screen reader reads out each toast that appears in it.
  return (
    <div role="status" aria-live="polite">
      {shown && (
        <div className="pointer-events-none fixed inset-x-0 bottom-[calc(6rem+var(--sab))] z-50 flex justify-center px-safe-6">
          <div className="flex items-center rounded-xl bg-fg text-sm text-bg shadow-lg" data-toast>
            <span className="px-4 py-2.5">{errorText(shown.text)}</span>
            {action && (
              <button
                onClick={() => {
                  setHidden(true);
                  action.run();
                }}
                className="pointer-events-auto -my-0.5 mr-1 min-h-11 shrink-0 border-l border-bg/25 px-4 font-semibold"
                data-toast-action
              >
                {action.label}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function App() {
  const me = useApp((s) => s.me);
  const offline = useApp((s) => s.offline);
  const route = useApp((s) => s.route);
  const conn = useApp((s) => s.conn);
  const shown = useApp((s) => s.route.name === "chat" && s.chat?.sessionId === s.route.sessionId && s.chat.loaded);

  if (!me) {
    if (offline) {
      return (
        <>
          {route.name === "chat" ? <OfflineChat key={route.sessionId} sessionId={route.sessionId} /> : <OfflineHome reason={offline} />}
          <Toast />
        </>
      );
    }
    return (
      <div className="flex h-dvh items-center justify-center text-muted">
        <Spinner className="size-6" />
      </div>
    );
  }
  if (!me.loggedIn) return <Login />;

  // A chat the page has not got while the connection is down shows from the phone's copy until it comes.
  return (
    <>
      {route.name === "chat" ? (
        shown || conn !== "offline" ? (
          <Chat key={route.sessionId} sessionId={route.sessionId} />
        ) : (
          <OfflineChat key={route.sessionId} sessionId={route.sessionId} />
        )
      ) : route.name === "new" ? (
        <NewSession />
      ) : route.name === "settings" ? (
        <Settings key={`${route.page ?? ""}/${route.part ?? ""}`} page={route.page} part={route.part} />
      ) : (
        <Home />
      )}
      {conn === "offline" && (
        <div className="pt-safe fixed inset-x-0 top-0 z-30 bg-warn/90 px-safe-4 py-1.5 text-center text-xs text-white">연결이 끊겼습니다. 다시 연결하는 중…</div>
      )}
      {conn === "conflict" && (
        <Notice title="다른 창에서 사용 중입니다" body="이 창에서 계속하면 다른 창의 연결은 끊깁니다." action="이 창에서 계속" onAction={takeWindow} />
      )}
      {conn === "taken" && <Notice title="다른 창에서 사용을 시작했습니다" body="이 창의 연결은 끊겼습니다." action="이 창에서 다시 사용" onAction={takeWindow} />}
      <Toast />
    </>
  );
}
