import { setPrefs, usePrefs } from "../../prefs.ts";
import { SectionTitle, Switch } from "./common.tsx";

export function PrefsSection() {
  const prefs = usePrefs();
  return (
    <section className="space-y-2">
      <SectionTitle>입력</SectionTitle>
      <button
        role="switch"
        aria-checked={prefs.enterToSend}
        onClick={() => setPrefs({ enterToSend: !prefs.enterToSend })}
        className="flex w-full items-center gap-3 rounded-xl bg-surface p-3.5 text-left"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-[15px]">Enter로 보내기</span>
          <span className="block text-xs text-muted">켜면 Shift+Enter로 줄을 바꿉니다. 끄면 ⌘/Ctrl+Enter로 보냅니다.</span>
        </span>
        <Switch on={prefs.enterToSend} />
      </button>
    </section>
  );
}
