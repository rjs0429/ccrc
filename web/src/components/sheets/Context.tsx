import { Sheet } from "../ui.tsx";
import type { SheetProps } from "./types.ts";

export function ContextSheet({ onClose }: SheetProps) {
  return (
    <Sheet title="문맥 사용량" onClose={onClose}>
      <div className="px-3 py-2 text-sm text-muted">준비 중입니다</div>
    </Sheet>
  );
}
