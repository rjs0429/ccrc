import { useEffect, useState } from "react";
import type { ContextDetail, LiveState, SessionState, UsageInfo } from "../../../../broker/src/protocol.ts";
import { errorText, hostLabel } from "../../labels.ts";
import { call } from "../../state.ts";
import { Ring, compactLeft } from "../ContextRing.tsx";
import { Button, Icon, Sheet } from "../ui.tsx";
import { ContextGroups, tokens } from "./Context.tsx";
import { Failed, SmallButton, Waiting } from "./parts.tsx";
import { UsageView } from "./Usage.tsx";

// The broker gives Claude Code up to a minute to count every category, and starts a short-lived process
// for the plan limits when no session can say.
const DETAIL_WAIT_MS = 75_000;
const USAGE_WAIT_MS = 60_000;

interface Props {
  sessionId: string;
  state?: LiveState;
  kind: SessionState;
  starting: boolean;
  onClose: () => void;
  onStart: () => void;
  // Sends the message; false when it could not go out.
  onCompact: (text: string) => boolean;
}

function Section({ name, title, children }: { name: string; title: string; children: React.ReactNode }) {
  return (
    <section data-section={name} className="mt-5 first:mt-0">
      <div className="mb-2 px-1 text-xs font-semibold text-muted">{title}</div>
      {children}
    </section>
  );
}

// Context, plan limits and Compact in one sheet, the way the ring next to the model chip opens it. The gauge
// comes with the session's state; the categories are counted when asked for.
export function ContextUsageSheet({ sessionId, state, kind, starting, onClose, onStart, onCompact }: Props) {
  const controllable = kind === "owned" || kind === "attached";
  const g = state?.context;
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<ContextDetail>();
  const [detailError, setDetailError] = useState<string>();
  const [counting, setCounting] = useState(false);
  const [usage, setUsage] = useState<UsageInfo>();
  const [usageError, setUsageError] = useState<string>();
  const [usageRound, setUsageRound] = useState(0);
  const [keep, setKeep] = useState("");

  useEffect(() => {
    if (controllable) call(sessionId, "context", { summary: true }).catch(() => {});
  }, [sessionId, controllable]);

  const count = () => {
    setCounting(true);
    setDetailError(undefined);
    call(sessionId, "context", {}, DETAIL_WAIT_MS)
      .then(setDetail, (e: Error) => setDetailError(errorText(e.message)))
      .finally(() => setCounting(false));
  };

  useEffect(() => {
    if (open && controllable && !detail && !counting && !detailError) count();
  }, [open, controllable]);

  useEffect(() => {
    let live = true;
    setUsageError(undefined);
    call(sessionId, "usage", {}, USAGE_WAIT_MS).then(
      (u) => live && setUsage(u),
      (e: Error) => live && setUsageError(errorText(e.message)),
    );
    return () => {
      live = false;
    };
  }, [sessionId, usageRound]);

  const left = g ? compactLeft(g) : undefined;
  const leftText = left !== undefined ? `자동 압축까지 ${left}% 남음` : g && !g.last ? "Auto-compact 꺼짐" : undefined;
  const busy = Boolean(state?.busy);
  const stopped = kind === "inactive";
  const blocked = kind === "live" ? `${hostLabel(state?.host)}에서 열려 있어 여기서는 할 수 없습니다` : busy ? "작업이 끝난 뒤에 할 수 있습니다" : undefined;
  const compact = () => {
    if (blocked) return;
    const text = keep.trim().replace(/\s+/g, " ");
    if (onCompact(text ? `/compact ${text}` : "/compact")) onClose();
  };

  return (
    <Sheet title="Context와 사용량" onClose={onClose}>
      <Section name="context" title="Context">
        <div className="flex items-center gap-3 px-1">
          <Ring gauge={g} className="size-12 shrink-0" />
          {g ? (
            <div className="min-w-0">
              <div className="text-2xl font-semibold tabular-nums">{g.percent}%</div>
              <div className="text-xs text-muted tabular-nums" data-context-tokens>
                {tokens(g.tokens)} / {tokens(g.max)} 토큰
              </div>
            </div>
          ) : (
            <div className="text-sm text-muted">아직 Context 사용량을 알 수 없습니다</div>
          )}
        </div>
        {leftText && (
          <div className="mt-2 px-1 text-sm" data-compact-left>
            {leftText}
          </div>
        )}
        {g?.last && <div className="mt-1 px-1 text-xs text-muted">마지막 기록 기준입니다</div>}
        {controllable && (
          <div className="mt-3">
            <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex items-center gap-1 px-1 text-sm font-medium text-accent">
              분류별 보기
              <Icon.chevronDown className={`size-4 transition-transform ${open ? "rotate-180" : ""}`} />
            </button>
            {open && (
              <div data-context-groups>
                {detail && <ContextGroups detail={detail} />}
                {counting && <Waiting text="분류별로 세는 중입니다. 1분까지 걸릴 수 있습니다" />}
                {detailError && !counting && <Failed text={detailError} onRetry={count} />}
              </div>
            )}
          </div>
        )}
        {stopped && (
          <div className="mt-3 px-1">
            <SmallButton
              disabled={starting}
              onClick={() => {
                setOpen(true);
                onStart();
              }}
            >
              {starting ? "시작하는 중…" : "세션을 시작하고 자세히 보기"}
            </SmallButton>
          </div>
        )}
      </Section>

      <Section name="plan" title="요금제">
        {usage && <UsageView usage={{ limits: usage.limits }} />}
        {!usage && !usageError && <Waiting text="요금제 사용량을 불러오는 중입니다" />}
        {usageError && !usage && <Failed text={usageError} onRetry={() => setUsageRound((r) => r + 1)} />}
      </Section>

      <Section name="compact" title="Compact">
        <p className="px-1 text-xs text-muted">대화를 요약해 Context를 비웁니다. 요약에 꼭 남길 내용을 적을 수 있습니다.</p>
        <input
          value={keep}
          onChange={(e) => setKeep(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) compact();
          }}
          placeholder="남길 내용(선택)"
          enterKeyHint="send"
          aria-label="남길 내용(선택)"
          className="mt-2 w-full rounded-xl border border-line bg-bg px-3 py-2.5 text-[16px] outline-none focus:border-accent"
        />
        {blocked && <div className="mt-2 px-1 text-xs text-muted">{blocked}</div>}
        <Button kind="primary" className="mt-3 w-full" disabled={Boolean(blocked)} onClick={compact}>
          {stopped ? "시작하고 Compact" : "Compact"}
        </Button>
      </Section>
    </Sheet>
  );
}
