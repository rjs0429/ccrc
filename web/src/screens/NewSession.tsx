import { useEffect, useMemo, useState } from "react";
import { commandName } from "../../../broker/src/dialog-commands.ts";
import type { EffortName, ModelOption, StartSettings } from "../../../broker/src/protocol.ts";
import { Composer, saveDraft } from "../components/Composer.tsx";
import { commandSheet } from "../components/commandSheets.ts";
import { NEW_SESSION_SCOPE, takeAttachments } from "../components/composer/attachments.ts";
import { UsageSheet } from "../components/sheets/Usage.tsx";
import { Icon, Sheet, Spinner } from "../components/ui.tsx";
import { baseName, shortPath } from "../labels.ts";
import { rememberSent } from "../sentPreviews.ts";
import { navigate, onDraftStarted, openSettingsFrom, startNewSession, toast, useApp } from "../state.ts";

const EFFORTS: EffortName[] = ["low", "medium", "high", "xhigh", "max"];
const NO_MODELS: ModelOption[] = [];
// Commands whose screen needs a running session, and what to say about them before it starts.
const AFTER_START: Record<string, string> = {
  context: "Context는 세션이 시작되면 보입니다.",
  mcp: "MCP 서버는 세션이 시작된 뒤 보고 켜고 끌 수 있습니다.",
  outputStyle: "출력 스타일은 세션이 시작된 뒤 고를 수 있습니다.",
};

// The folder and start settings chosen here last a visit to the settings page and a reload, like the message the
// composer keeps.
const KEPT_KEY = "ccrc.newSession";
type Kept = { cwd: string | null; start: StartSettings };

function loadKept(): Kept {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEPT_KEY) ?? "null") as Partial<Kept> | null;
    if (v && typeof v === "object") return { cwd: typeof v.cwd === "string" ? v.cwd : null, start: v.start && typeof v.start === "object" ? v.start : {} };
  } catch {}
  return { cwd: null, start: {} };
}

function saveKept(k: Kept | null): void {
  try {
    if (k && (k.cwd || Object.keys(k.start).length)) sessionStorage.setItem(KEPT_KEY, JSON.stringify(k));
    else sessionStorage.removeItem(KEPT_KEY);
  } catch {}
}

let kept = loadKept();

onDraftStarted((sessionId, text) => {
  rememberSent(sessionId, text, takeAttachments(NEW_SESSION_SCOPE));
  saveDraft(NEW_SESSION_SCOPE, "");
  kept = { cwd: null, start: {} };
  saveKept(null);
});

// Opens the new-session screen on a folder with a message to start with, as a fork from a conversation's first message
// stands in for a copy that would hold nothing.
export function openNewSession(cwd: string, text: string, start: StartSettings = {}): void {
  kept = { cwd, start };
  saveKept(kept);
  saveDraft(NEW_SESSION_SCOPE, text);
  navigate({ name: "new" });
}

function modelNamed(models: ModelOption[], name: string): ModelOption | undefined {
  const n = name.toLowerCase();
  return models.find((m) => [m.value, m.resolved, m.label].some((v) => v?.toLowerCase() === n));
}

export function NewSession() {
  const options = useApp((s) => s.options);
  const sessions = useApp((s) => s.sessions);
  const starting = useApp((s) => Boolean(s.starting));
  const models = options?.models ?? NO_MODELS;
  const [chosen, setChosen] = useState<string | null>(kept.cwd);
  const [query, setQuery] = useState("");
  const [start, setStart] = useState<StartSettings>(kept.start);
  const [composerSheet, setComposerSheet] = useState<{ name: "model" | "effort"; at: number }>();
  const [usage, setUsage] = useState(false);
  const [later, setLater] = useState<{ title: string; text: string } | null>(null);

  const all = useMemo(() => {
    const last = new Map<string, number>();
    for (const s of sessions ?? []) last.set(s.cwd, Math.max(last.get(s.cwd) ?? 0, s.lastModified));
    return [...new Set([...(options?.folders ?? []), ...last.keys()])].filter(Boolean).sort((a, b) => (last.get(b) ?? 0) - (last.get(a) ?? 0));
  }, [options, sessions]);
  const folders = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((f) => !q || f.toLowerCase().includes(q));
  }, [all, query]);
  // The most recent folder is the default once the sessions are known, and stays it while the screen is open.
  const [fallback, setFallback] = useState<string | null>(null);
  useEffect(() => {
    if (!fallback && sessions && all[0]) setFallback(all[0]);
  }, [fallback, sessions, all]);
  const cwd = chosen ?? fallback ?? all[0] ?? null;

  useEffect(() => {
    kept = { cwd: chosen, start };
    saveKept(kept);
  }, [chosen, start]);

  const change = (p: StartSettings) => setStart((s) => ({ ...s, ...p }));
  const reset = (key: keyof StartSettings) =>
    setStart((s) => {
      const next = { ...s };
      delete next[key];
      return next;
    });

  // "/model x" and "/effort x" become start settings; another command with a screen of its own opens it or says it
  // waits for the session. Any other command goes as the first message.
  const openCommand = (name: string, args?: string): boolean | "kept" => {
    const n = commandName(name);
    const target = commandSheet(name);
    if (args) {
      const v = args.trim();
      if (n === "model") {
        const m = v.toLowerCase() === "default" ? undefined : modelNamed(models, v);
        if (!m && v.toLowerCase() !== "default") {
          toast("목록에 없는 모델입니다");
          return "kept";
        }
        if (m) change({ model: m.value });
        else reset("model");
      } else if (n === "effort") {
        const e = v.toLowerCase();
        if (e === "ultracode") change({ ultracode: true });
        else if (e === "auto") reset("effort");
        else if (EFFORTS.includes(e as EffortName)) change({ effort: e as EffortName });
        else {
          toast("알 수 없는 Effort입니다");
          return "kept";
        }
      } else if (target) {
        toast("이 명령은 세션이 시작된 뒤 보내세요");
        return "kept";
      } else return false;
      toast("시작 설정을 바꿨습니다");
      return true;
    }
    if (!target) return false;
    switch (target.sheet) {
      case "model":
      case "effort":
        setComposerSheet({ name: target.sheet, at: Date.now() });
        return true;
      case "usage":
        setUsage(true);
        return true;
      case "config":
        openSettingsFrom("claude");
        return true;
      case "permissions":
        openSettingsFrom("claude", "permissions");
        return true;
      case "context":
      case "mcp":
      case "outputStyle":
        setLater({ title: target.title, text: AFTER_START[target.sheet] });
        return true;
      default:
        toast("세션이 시작된 뒤 쓸 수 있습니다");
        return "kept";
    }
  };

  const send = (text: string, attachments: string[]) =>
    Boolean(cwd) &&
    startNewSession({
      t: "new_session",
      cwd: cwd!,
      text,
      model: start.model,
      mode: start.mode,
      effort: start.effort,
      ...(start.ultracode ? { ultracode: true } : {}),
      ...(start.fast ? { fast: true } : {}),
      ...(start.thinking === false ? { thinking: false } : {}),
      ...(attachments.length ? { attachments } : {}),
    });

  return (
    <div className="flex h-dvh flex-col">
      <header className="pt-safe border-b border-line bg-bg">
        <div className="flex items-center gap-1 px-safe-2 py-2 short:py-0.5">
          <button onClick={() => navigate({ name: "home" })} aria-label="뒤로" className="-m-1 rounded-lg p-3">
            <Icon.back />
          </button>
          <div className="min-w-0 flex-1 short:flex short:items-baseline short:gap-2">
            <div className="text-[15px] font-semibold">새 세션</div>
            <div className="truncate text-xs text-muted" data-new-folder>
              {cwd ? `${baseName(cwd)} · ${shortPath(cwd)}` : "폴더를 고르세요"}
            </div>
            {starting && (
              <div className="flex items-center gap-1.5 text-xs text-accent" data-start-note>
                <Spinner className="size-3" /> 시작하는 중…
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto overscroll-contain px-safe-0">
        <div className="mx-auto max-w-2xl px-4 py-4 short:py-2">
          <div className="mb-2 text-sm font-semibold text-muted">폴더</div>
          <div className="mb-2 flex items-center gap-2 rounded-xl border border-line bg-surface px-3">
            <Icon.search className="size-4 text-muted" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="폴더 찾기" className="w-full bg-transparent py-2.5 text-[16px] outline-none" />
          </div>
          <div className="rounded-xl border border-line bg-surface">
            {folders.map((f) => (
              <button
                key={f}
                onClick={() => setChosen(f)}
                disabled={starting}
                data-folder={f}
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
        </div>
      </main>

      <Composer
        draft={{ cwd: cwd ?? undefined, start }}
        models={models}
        controllable={false}
        starting={starting}
        disabledReason={cwd ? undefined : "폴더를 고르세요"}
        placeholder="무엇을 할까요?"
        onSend={send}
        onStop={() => {}}
        onMode={(mode) => change({ mode })}
        onModel={(model) => change({ model })}
        onEffort={(effort) => change({ effort })}
        onUltracode={(on) => (on ? change({ ultracode: true }) : reset("ultracode"))}
        onFast={(on) => (on ? change({ fast: true }) : reset("fast"))}
        onThinking={(on) => (on ? reset("thinking") : change({ thinking: false }))}
        onReset={reset}
        onCommand={openCommand}
        openSheet={composerSheet}
      />

      {usage && cwd && <UsageSheet cwd={cwd} onClose={() => setUsage(false)} />}
      {later && (
        <Sheet title={later.title} onClose={() => setLater(null)}>
          <p className="px-1 text-sm text-muted" data-after-start>
            {later.text}
          </p>
        </Sheet>
      )}
    </div>
  );
}
