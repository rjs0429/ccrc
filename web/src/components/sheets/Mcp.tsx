import { useEffect, useState } from "react";
import type { McpServerInfo } from "../../../../broker/src/protocol.ts";
import { errorText } from "../../labels.ts";
import { call } from "../../state.ts";
import { Sheet, Spinner } from "../ui.tsx";
import { Failed, SmallButton, Waiting } from "./parts.tsx";
import type { SheetProps } from "./types.ts";

// Turning a server on or reconnecting it waits until the server has connected.
const CHANGE_WAIT_MS = 90_000;

const STATUS: Record<string, [label: string, dot: string]> = {
  connected: ["연결됨", "bg-ok"],
  pending: ["연결 중", "bg-info"],
  failed: ["실패", "bg-danger"],
  "needs-auth": ["인증 필요", "bg-warn"],
  disabled: ["꺼짐", "border border-muted"],
};

const SCOPE_LABEL: Record<string, string> = {
  user: "사용자",
  project: "프로젝트",
  local: "로컬",
  claudeai: "claude.ai",
  managed: "관리자 설정",
  enterprise: "관리자 설정",
  dynamic: "세션",
  plugin: "플러그인",
  agent: "에이전트",
};

function ServerRow(props: { server: McpServerInfo; working: boolean; locked: boolean; error?: string; onToggle: () => void; onReconnect: () => void }) {
  const { server, working, locked, error } = props;
  const [label, dot] = STATUS[server.status] ?? [server.status, "border border-muted"];
  const off = server.status === "disabled";
  const meta = [server.scope ? (SCOPE_LABEL[server.scope] ?? server.scope) : "", server.tools !== undefined ? `도구 ${server.tools}개` : ""]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="border-b border-line px-3 py-2.5 last:border-0">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{server.name}</span>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted">
          <span className={`size-2 rounded-full ${dot}`} />
          {label}
        </span>
      </div>
      {meta && <div className="mt-0.5 text-xs text-muted">{meta}</div>}
      {server.error && <div className="mt-1 line-clamp-3 text-xs text-danger">{server.error}</div>}
      {server.status === "needs-auth" && <div className="mt-1 text-xs text-muted">인증은 VS Code나 터미널의 /mcp에서 하세요</div>}
      <div className="mt-2 flex items-center gap-2">
        <SmallButton onClick={props.onToggle} disabled={locked}>
          {off ? "켜기" : "끄기"}
        </SmallButton>
        {!off && (
          <SmallButton onClick={props.onReconnect} disabled={locked}>
            다시 연결
          </SmallButton>
        )}
        {working && <Spinner className="size-4 text-muted" />}
      </div>
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

  return (
    <Sheet title="MCP 서버" onClose={onClose}>
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
              />
            ))}
          </div>
          <div className="mt-2 px-1 text-xs text-muted">켜고 끈 상태는 이 프로젝트 설정에 저장됩니다</div>
        </>
      )}
      {servers?.length === 0 && !loading && <div className="px-1 py-3 text-sm text-muted">설정된 MCP 서버가 없습니다</div>}
      {loading && <Waiting text="서버 상태를 불러오는 중입니다" />}
      {error && !loading && <Failed text={error} onRetry={() => setRound((r) => r + 1)} />}
      {servers && !loading && (
        <div className="mt-3 flex justify-end">
          <SmallButton onClick={() => setRound((r) => r + 1)} disabled={working !== undefined}>
            새로고침
          </SmallButton>
        </div>
      )}
    </Sheet>
  );
}
