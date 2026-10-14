import { useMemo, useState } from "react";
import type { EffortName, PermissionModeName } from "../../../broker/src/protocol.ts";
import { Button, Choice, Icon, Sheet } from "../components/ui.tsx";
import { EFFORT_LABEL, MODE_HINT, MODE_LABEL, baseName, shortPath } from "../labels.ts";
import { navigate, send, toast, useApp } from "../state.ts";

const MODES: PermissionModeName[] = ["default", "acceptEdits", "plan", "auto"];
const EFFORTS: EffortName[] = ["low", "medium", "high", "xhigh", "max"];

function Row({ label, value, onClick }: { label: string; value: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center justify-between border-b border-line px-1 py-3 text-left">
      <span className="text-[15px]">{label}</span>
      <span className="flex items-center gap-1 text-sm text-muted">
        {value}
        <Icon.chevronRight className="size-4" />
      </span>
    </button>
  );
}

export function NewSession() {
  const options = useApp((s) => s.options);
  const sessions = useApp((s) => s.sessions);
  const [cwd, setCwd] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [model, setModel] = useState<string | undefined>();
  const [mode, setMode] = useState<PermissionModeName | undefined>();
  const [effort, setEffort] = useState<EffortName | undefined>();
  const [text, setText] = useState("");
  const [sheet, setSheet] = useState<"model" | "mode" | "effort" | null>(null);
  const [starting, setStarting] = useState(false);

  const folders = useMemo(() => {
    const last = new Map<string, number>();
    for (const s of sessions ?? []) last.set(s.cwd, Math.max(last.get(s.cwd) ?? 0, s.lastModified));
    const all = [...new Set([...(options?.folders ?? []), ...last.keys()])].filter(Boolean);
    const q = query.trim().toLowerCase();
    return all.filter((f) => !q || f.toLowerCase().includes(q)).sort((a, b) => (last.get(b) ?? 0) - (last.get(a) ?? 0));
  }, [options, sessions, query]);

  const models = options?.models ?? [];
  const start = () => {
    if (!cwd || !text.trim()) return;
    if (!send({ t: "new_session", cwd, text: text.trim(), model, mode, effort })) return toast("연결되어 있지 않습니다. 다시 연결된 뒤 시작하세요");
    setStarting(true);
    setTimeout(() => setStarting(false), 15000);
  };

  return (
    <div className="flex h-dvh flex-col">
      <header className="pt-safe border-b border-line bg-bg">
        <div className="flex items-center gap-1 px-2 py-2">
          <button onClick={() => navigate({ name: "home" })} aria-label="뒤로" className="rounded-lg p-2">
            <Icon.back />
          </button>
          <div className="flex-1 text-[15px] font-semibold">새 세션</div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-5 px-4 py-4">
          <section>
            <div className="mb-2 text-sm font-semibold text-muted">폴더</div>
            <div className="mb-2 flex items-center gap-2 rounded-xl border border-line bg-surface px-3">
              <Icon.search className="size-4 text-muted" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="폴더 찾기" className="w-full bg-transparent py-2.5 text-[16px] outline-none" />
            </div>
            <div className="max-h-64 overflow-y-auto rounded-xl border border-line bg-surface">
              {folders.map((f) => (
                <button
                  key={f}
                  onClick={() => setCwd(f)}
                  className={`flex w-full items-center gap-3 border-b border-line px-3 py-2.5 text-left last:border-0 ${cwd === f ? "bg-accent-soft" : ""}`}
                >
                  <Icon.folder className="size-4 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px]">{baseName(f)}</span>
                    <span className="block truncate text-xs text-muted">{shortPath(f)}</span>
                  </span>
                  {cwd === f && <Icon.check className="size-4 text-accent" />}
                </button>
              ))}
              {folders.length === 0 && <div className="px-3 py-4 text-center text-sm text-muted">폴더가 없습니다</div>}
            </div>
          </section>

          <section>
            <Row label="모델" value={models.find((m) => m.value === model)?.label ?? "기본값"} onClick={() => setSheet("model")} />
            <Row label="권한 모드" value={mode ? MODE_LABEL[mode] : "기본값"} onClick={() => setSheet("mode")} />
            <Row label="노력 수준" value={effort ? EFFORT_LABEL[effort] : "기본값"} onClick={() => setSheet("effort")} />
          </section>

          <section>
            <div className="mb-2 text-sm font-semibold text-muted">첫 메시지</div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={4}
              placeholder="무엇을 할까요?"
              className="w-full rounded-xl border border-line bg-surface p-3 text-[16px] leading-relaxed outline-none focus:border-accent"
            />
          </section>

          <Button kind="primary" className="w-full" disabled={!cwd || !text.trim() || starting} onClick={start}>
            {starting ? "시작하는 중…" : "시작"}
          </Button>
        </div>
      </main>

      {sheet === "model" && (
        <Sheet title="모델" onClose={() => setSheet(null)}>
          <Choice label="기본값" hint="Claude Code 설정을 따릅니다" selected={!model} onClick={() => (setModel(undefined), setSheet(null))} />
          {models.map((m) => (
            <Choice key={m.value} label={m.label} hint={m.description} selected={model === m.value} onClick={() => (setModel(m.value), setSheet(null))} />
          ))}
        </Sheet>
      )}
      {sheet === "mode" && (
        <Sheet title="권한 모드" onClose={() => setSheet(null)}>
          <Choice label="기본값" hint="Claude Code 설정을 따릅니다" selected={!mode} onClick={() => (setMode(undefined), setSheet(null))} />
          {MODES.map((m) => (
            <Choice key={m} label={MODE_LABEL[m]} hint={MODE_HINT[m]} selected={mode === m} onClick={() => (setMode(m), setSheet(null))} />
          ))}
        </Sheet>
      )}
      {sheet === "effort" && (
        <Sheet title="노력 수준" onClose={() => setSheet(null)}>
          <Choice label="기본값" selected={!effort} onClick={() => (setEffort(undefined), setSheet(null))} />
          {EFFORTS.map((e) => (
            <Choice key={e} label={EFFORT_LABEL[e]} selected={effort === e} onClick={() => (setEffort(e), setSheet(null))} />
          ))}
        </Sheet>
      )}
    </div>
  );
}
