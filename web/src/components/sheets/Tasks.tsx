import { Sheet } from "../ui.tsx";
import type { SheetProps } from "./types.ts";

export function TasksSheet({ onClose }: SheetProps) {
  return (
    <Sheet title="실행 중 작업" onClose={onClose}>
      <div className="px-3 py-2 text-sm text-muted">준비 중입니다</div>
    </Sheet>
  );
}
