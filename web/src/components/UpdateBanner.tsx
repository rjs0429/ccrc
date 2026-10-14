import { useEffect, useState } from "react";
import type { HealthInfo } from "../../../broker/src/admin-protocol.ts";
import { request } from "../api.ts";
import { navigate } from "../state.ts";
import { Icon } from "./ui.tsx";

// One line on the home screen while the last check of the wrapper against Claude Code's update failed.
export function UpdateBanner() {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    request<HealthInfo>("GET", "/api/health").then(
      (h) => setFailed(h.last?.ok === false),
      () => {},
    );
  }, []);

  if (!failed) return null;
  return (
    <div className="border-b border-line bg-warn/10 px-safe-0">
      <button onClick={() => navigate({ name: "settings", page: "status" })} className="flex w-full items-center gap-2 px-4 py-2 text-left text-[13px] text-warn">
        <span className="min-w-0 flex-1 truncate">VS Code 확장이 바뀐 뒤 호환성 점검에 실패했습니다 · 설정에서 보기</span>
        <Icon.chevronRight className="size-4 shrink-0" />
      </button>
    </div>
  );
}
