import { t } from "../i18n/index.ts";
import { toast } from "../state.ts";

// Copies within the tap that asked for it, the only time iOS lets a page write to the clipboard.
export function copyText(text: string, done: string): void {
  if (!navigator.clipboard) return toast(t("복사하지 못했습니다"));
  navigator.clipboard.writeText(text).then(
    () => toast(done),
    () => toast(t("복사하지 못했습니다")),
  );
}
