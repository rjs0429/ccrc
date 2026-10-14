import { Sheet } from "../ui.tsx";
import type { SheetProps } from "./types.ts";

export function ChangesSheet({ onClose }: SheetProps) {
  return (
    <Sheet title="변경 사항" onClose={onClose}>
      <div className="px-3 py-2 text-sm text-muted">준비 중입니다</div>
    </Sheet>
  );
}
