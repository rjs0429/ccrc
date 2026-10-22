import { useEffect, useState } from "react";
import type { McpAuthStart, McpServerInfo } from "../../../../broker/src/protocol.ts";
import { k, t } from "../../i18n/index.ts";
import { errorText } from "../../labels.ts";
import { call } from "../../state.ts";
import { Sheet, Spinner } from "../ui.tsx";
import { Failed, SmallButton, Waiting } from "./parts.tsx";
import type { SheetProps } from "./types.ts";

// Turning a server on or reconnecting it waits until the server has connected.
const CHANGE_WAIT_MS = 90_000;
// Claude Code connects a server again on its own once a sign-in is done; the list is read again meanwhile.
const AFTER_AUTH_MS = [1500, 3000, 6000, 10_000];
// A sign-in under way outlasts the app being closed while its page is open elsewhere, for as long as Claude Code is
// likely to wait for its redirect.
const AUTH_KEEP_MS = 10 * 60_000;
type AuthUnderWay = { server: string; start: McpAuthStart; at: number };
const authKey = (sessionId: string) => `ccrc.mcpAuth.${sessionId}`;

function savedAuth(sessionId: string): AuthUnderWay | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(authKey(sessionId)) ?? "null") as AuthUnderWay | null;
    return v && typeof v.server === "string" && typeof v.at === "number" && Date.now() - v.at < AUTH_KEEP_MS ? v : undefined;
  } catch {
    return undefined;
  }
}

function keepAuth(sessionId: string, auth: AuthUnderWay | undefined): void {
  try {
    if (auth) localStorage.setItem(authKey(sessionId), JSON.stringify(auth));
    else localStorage.removeItem(authKey(sessionId));
  } catch {}
}

const STATUS: Record<string, [label: string, dot: string]> = {
  connected: [k("연결됨"), "bg-ok"],
  pending: [k("연결 중"), "bg-info"],
  failed: [k("실패"), "bg-danger"],
  "needs-auth": [k("인증 필요"), "bg-warn"],
  disabled: [k("꺼짐"), "border border-muted"],
};

const SCOPE_LABEL: Record<string, string> = {
  user: k("사용자"),
  project: k("프로젝트"),
  local: k("로컬"),
  claudeai: "claude.ai",
  managed: k("관리자 설정"),
  enterprise: k("관리자 설정"),
  dynamic: k("세션"),
  plugin: k("플러그인"),
  agent: k("에이전트"),
};

// Inside the sign-in panel a button stands apart from the panel's own colour and keeps a full 44px tap target.
function PanelButton({ children, onClick, disabled, primary }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; primary?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`min-h-11 shrink-0 rounded-lg px-4 text-sm font-medium disabled:opacity-40 ${primary ? "bg-accent text-white" : "border border-line bg-surface"}`}
    >
      {children}
    </button>
  );
}

// A sign-in under way: the page to open, then the address it ended on, pasted back while Claude Code waits for it.
function AuthPanel({ server, start, busy, onSend, onCancel }: { server: string; start: McpAuthStart; busy: boolean; onSend: (url: string) => void; onCancel: () => void }) {
  const [url, setUrl] = useState("");
  const paste = async () => {
    try {
      setUrl((await navigator.clipboard.readText()).trim());
    } catch {}
  };
  return (
    <div className="mt-2 space-y-2 rounded-xl bg-surface-2 p-3 text-sm" data-mcp-auth={server}>
      {start.url ? (
        <a href={start.url} target="_blank" rel="noopener noreferrer" className="flex min-h-11 items-center justify-center rounded-lg bg-accent px-3 font-medium text-white">
          {t("로그인 페이지 열기")}
        </a>
      ) : (
        <div className="text-muted">{t("Claude Code가 로그인 주소를 주지 않았습니다.")}</div>
      )}
      {start.callback ? (
        <>
          <p className="text-muted">
            {t(
              "로그인을 마치면 열리지 않는 페이지(localhost)로 넘어갑니다. 그 페이지의 주소를 통째로 복사해 붙여 넣으세요. 노트북의 Claude Code가 그 주소로 인증을 마칩니다.",
            )}
          </p>
          <div className="flex gap-2">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://localhost:…/callback?code=…"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              inputMode="url"
              className="min-h-11 min-w-0 flex-1 rounded-lg border border-line bg-bg px-2.5 py-2 text-[16px] outline-none focus:border-accent"
            />
            {typeof navigator.clipboard?.readText === "function" && (
              <PanelButton onClick={() => void paste()} disabled={busy}>
                {t("붙여넣기")}
              </PanelButton>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <PanelButton onClick={onCancel} disabled={busy}>
              {t("그만두기")}
            </PanelButton>
            <PanelButton onClick={() => onSend(url.trim())} disabled={busy || !url.trim()} primary>
              {busy ? t("인증 중…") : t("보내기")}
            </PanelButton>
          </div>
        </>
      ) : (
        <>
          <p className="text-muted">{t("로그인과 연결을 마친 뒤 ‘다시 연결’을 누르세요.")}</p>
          <div className="flex justify-end">
            <PanelButton onClick={onCancel}>{t("닫기")}</PanelButton>
          </div>
        </>
      )}
    </div>
  );
}

function ServerRow(props: {
  server: McpServerInfo;
  working: boolean;
  locked: boolean;
  error?: string;
  onToggle: () => void;
  onReconnect: () => void;
  onAuth: () => void;
  children?: React.ReactNode;
}) {
  const { server, working, locked, error } = props;
  const [label, dot] = Object.hasOwn(STATUS, server.status) ? STATUS[server.status] : [server.status, "border border-muted"];
  const off = server.status === "disabled";
  const signIn = Boolean(server.auth) && (server.status === "needs-auth" || server.status === "failed");
  const meta = [
    server.scope ? (Object.hasOwn(SCOPE_LABEL, server.scope) ? t(SCOPE_LABEL[server.scope]) : server.scope) : "",
    server.tools !== undefined ? t("도구 {n}개", { n: server.tools }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="border-b border-line px-3 py-2.5 last:border-0">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{server.name}</span>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted">
          <span className={`size-2 rounded-full ${dot}`} />
          {t(label)}
        </span>
      </div>
      {meta && <div className="mt-0.5 text-xs text-muted">{meta}</div>}
      {server.error && <div className="mt-1 line-clamp-3 text-xs text-danger">{server.error}</div>}
      {server.status === "needs-auth" && !server.auth && <div className="mt-1 text-xs text-muted">{t("이 서버는 VS Code나 터미널의 /mcp에서 인증하세요")}</div>}
      <div className="mt-2 flex items-center gap-2">
        {signIn && (
          <SmallButton onClick={props.onAuth} disabled={locked} tone="text-accent">
            {t("인증")}
          </SmallButton>
        )}
        <SmallButton onClick={props.onToggle} disabled={locked}>
          {off ? t("켜기") : t("끄기")}
        </SmallButton>
        {!off && (
          <SmallButton onClick={props.onReconnect} disabled={locked}>
            {t("다시 연결")}
          </SmallButton>
        )}
        {working && <Spinner className="size-4 text-muted" />}
      </div>
      {props.children}
      {error && error !== server.error && <div className="mt-1.5 text-xs text-danger">{error}</div>}
    </div>
  );
}

export function McpSheet({ sessionId, onClose }: SheetProps) {
  const [servers, setServers] = useState<McpServerInfo[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [round, setRound] = useState(0);
  const [working, setWorking] = useState<string>();
  const [failed, setFailed] = useState<{ server: string; text: string }>();
  const [auth, setAuthState] = useState<AuthUnderWay | undefined>(() => savedAuth(sessionId));
  const setAuth = (a: AuthUnderWay | undefined) => {
    keepAuth(sessionId, a?.start.callback ? a : undefined);
    setAuthState(a);
  };

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(undefined);
    call(sessionId, "mcp_status")
      .then(
        (list) => live && setServers(list),
        (e: Error) => live && setError(errorText(e.message)),
      )
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [sessionId, round]);

  // A change that fails can still change the server (one that cannot start is left on, as failed).
  const act = (server: string, run: () => Promise<McpServerInfo[]>) => {
    setWorking(server);
    setFailed(undefined);
    run()
      .then(setServers, (e: Error) => {
        setFailed({ server, text: errorText(e.message) });
        setRound((r) => r + 1);
      })
      .finally(() => setWorking(undefined));
  };

  const authenticate = (server: string) => {
    setWorking(server);
    setFailed(undefined);
    setAuth(undefined);
    call(sessionId, "mcp_authenticate", { server }, CHANGE_WAIT_MS)
      .then(
        (start) => {
          if (start.done) setRound((r) => r + 1);
          else setAuth({ server, start, at: Date.now() });
        },
        (e: Error) => setFailed({ server, text: errorText(e.message) }),
      )
      .finally(() => setWorking(undefined));
  };

  const finish = (server: string, url: string) => {
    setWorking(server);
    setFailed(undefined);
    call(sessionId, "mcp_oauth_callback", { server, url }, CHANGE_WAIT_MS)
      .then(
        (list) => {
          setServers(list);
          setAuth(undefined);
          for (const ms of AFTER_AUTH_MS) setTimeout(() => setRound((r) => r + 1), ms);
        },
        (e: Error) => setFailed({ server, text: errorText(e.message) }),
      )
      .finally(() => setWorking(undefined));
  };

  return (
    <Sheet title={t("MCP 서버")} onClose={onClose}>
      {servers && servers.length > 0 && (
        <>
          <div className="overflow-hidden rounded-xl border border-line">
            {servers.map((s) => (
              <ServerRow
                key={s.name}
                server={s}
                working={working === s.name}
                locked={working !== undefined || loading}
                error={failed?.server === s.name ? failed.text : undefined}
                onToggle={() => act(s.name, () => call(sessionId, "mcp_toggle", { server: s.name, enabled: s.status === "disabled" }, CHANGE_WAIT_MS))}
                onReconnect={() => act(s.name, () => call(sessionId, "mcp_reconnect", { server: s.name }, CHANGE_WAIT_MS))}
                onAuth={() => authenticate(s.name)}
              >
                {auth?.server === s.name && (
                  <AuthPanel server={s.name} start={auth.start} busy={working === s.name} onSend={(url) => finish(s.name, url)} onCancel={() => setAuth(undefined)} />
                )}
              </ServerRow>
            ))}
          </div>
          <div className="mt-2 px-1 text-xs text-muted">{t("켜고 끈 상태는 이 프로젝트 설정에 저장됩니다")}</div>
        </>
      )}
      {servers?.length === 0 && !loading && <div className="px-1 py-3 text-sm text-muted">{t("설정된 MCP 서버가 없습니다")}</div>}
      {loading && <Waiting text={t("서버 상태를 불러오는 중입니다")} />}
      {error && !loading && <Failed text={error} onRetry={() => setRound((r) => r + 1)} />}
      {servers && !loading && (
        <div className="mt-3 flex justify-end">
          <SmallButton onClick={() => setRound((r) => r + 1)} disabled={working !== undefined}>
            {t("새로고침")}
          </SmallButton>
        </div>
      )}
    </Sheet>
  );
}
