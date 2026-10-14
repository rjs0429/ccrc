import { useRef, useState } from "react";
import type { EffortName, LiveState, ModelOption, PermissionModeName } from "../../../broker/src/protocol.ts";
import { EFFORT_LABEL, MODE_HINT, MODE_LABEL } from "../labels.ts";
import { Choice, Icon, Sheet } from "./ui.tsx";

const MODES: PermissionModeName[] = ["default", "acceptEdits", "plan", "auto"];
const EFFORTS: EffortName[] = ["low", "medium", "high", "xhigh", "max"];

export function modelLabel(models: ModelOption[], model?: string): string {
  if (!model) return "모델";
  const known = models.find((m) => m.resolved === model || m.value === model);
  if (known) return known.label;
  const m = model.match(/^claude-([a-z]+)-(\d+)-(\d+)/);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : model;
}

function Chip({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex shrink-0 items-center gap-0.5 rounded-lg px-2 py-1 text-[13px] text-muted hover:bg-surface-2 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

interface Props {
  // Absent on the new-session screen.
  sessionId?: string;
  state?: LiveState;
  models: ModelOption[];
  controllable: boolean;
  disabledReason?: string;
  placeholder: string;
  onSend: (text: string) => void;
  onStop: () => void;
  onMode: (mode: PermissionModeName) => void;
  onModel: (model: string) => void;
  onEffort: (effort: EffortName) => void;
}

export function Composer({ state, models, controllable, disabledReason, placeholder, onSend, onStop, onMode, onModel, onEffort }: Props) {
  const [text, setText] = useState("");
  const [sheet, setSheet] = useState<"mode" | "model" | "effort" | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const busy = Boolean(state?.busy);
  const current = models.find((m) => m.resolved === state?.model || m.value === state?.model);
  const efforts = current?.efforts?.length ? current.efforts : EFFORTS;

  const submit = () => {
    const t = text.trim();
    if (!t || disabledReason) return;
    onSend(t);
    setText("");
    if (ref.current) ref.current.style.height = "auto";
  };

  if (disabledReason) {
    return <div className="pb-safe border-t border-line bg-bg px-4 pt-3 text-center text-sm text-muted">{disabledReason}</div>;
  }

  return (
    <div className="pb-safe border-t border-line bg-bg px-3 pt-2">
      <div className="rounded-2xl border border-line bg-surface px-3 pt-2.5 pb-1.5 focus-within:border-accent">
        <textarea
          ref={ref}
          value={text}
          rows={1}
          placeholder={busy ? "대기열에 추가할 메시지…" : placeholder}
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 168)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          className="block max-h-42 w-full resize-none bg-transparent text-[16px] leading-relaxed outline-none placeholder:text-muted"
        />
        <div className="mt-1 flex items-center gap-1">
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
            <Chip disabled={!controllable} onClick={() => setSheet("model")}>
              {modelLabel(models, state?.model)}
              <Icon.chevronDown className="size-3.5" />
            </Chip>
            <Chip disabled={!controllable} onClick={() => setSheet("mode")}>
              {MODE_LABEL[state?.permissionMode ?? ""] ?? "권한 모드"}
              <Icon.chevronDown className="size-3.5" />
            </Chip>
            <Chip disabled={!controllable} onClick={() => setSheet("effort")}>
              {state?.effort ? `노력 ${EFFORT_LABEL[state.effort] ?? state.effort}` : controllable ? "노력 기본" : "노력"}
              <Icon.chevronDown className="size-3.5" />
            </Chip>
            {state?.contextPercent !== undefined && <span className="shrink-0 px-1 text-[12px] text-muted">문맥 {state.contextPercent}%</span>}
          </div>
          {busy && (
            <button onClick={onStop} aria-label="중지" className="flex size-9 items-center justify-center rounded-full bg-surface-2 text-fg">
              <Icon.stop />
            </button>
          )}
          <button
            onClick={submit}
            disabled={!text.trim()}
            aria-label="보내기"
            className="flex size-9 items-center justify-center rounded-full bg-accent text-white disabled:opacity-30"
          >
            <Icon.send className="size-5" />
          </button>
        </div>
      </div>

      {sheet === "mode" && (
        <Sheet title="권한 모드" onClose={() => setSheet(null)}>
          {MODES.map((m) => (
            <Choice key={m} label={MODE_LABEL[m]} hint={MODE_HINT[m]} selected={state?.permissionMode === m} onClick={() => (onMode(m), setSheet(null))} />
          ))}
        </Sheet>
      )}
      {sheet === "model" && (
        <Sheet title="모델" onClose={() => setSheet(null)}>
          {models.length === 0 && <div className="px-3 py-2 text-sm text-muted">모델 목록을 불러오는 중입니다</div>}
          {models.map((m) => (
            <Choice key={m.value} label={m.label} hint={m.description} selected={m === current} onClick={() => (onModel(m.value), setSheet(null))} />
          ))}
        </Sheet>
      )}
      {sheet === "effort" && (
        <Sheet title="노력 수준" onClose={() => setSheet(null)}>
          {efforts.map((e) => (
            <Choice key={e} label={EFFORT_LABEL[e] ?? e} selected={state?.effort === e} onClick={() => (onEffort(e), setSheet(null))} />
          ))}
        </Sheet>
      )}
    </div>
  );
}
