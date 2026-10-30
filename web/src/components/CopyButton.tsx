import { copyText } from "./clipboard.ts";
import { Icon } from "./ui.tsx";

// Copies a value shown where a finger does not select text. label names the value's copy, done is the toast after it.
export function CopyButton({ text, label, done }: { text: string; label: string; done: string }) {
  return (
    <button
      onClick={() => copyText(text, done)}
      aria-label={label}
      className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted active:bg-surface-2"
      data-copy-value
    >
      <Icon.copy className="size-[18px]" />
    </button>
  );
}
