import type { SentRef } from "../../../../broker/src/protocol.ts";

// The largest image or PDF the viewer shows; a larger one only downloads.
export const PREVIEW_MAX_BYTES = 10_000_000;

// The viewer's view of a file Claude sent, or its bytes.
export function sentUrl(sessionId: string, ref: SentRef, raw = false, download = false): string {
  const q = new URLSearchParams({ ...(ref.agent ? { agent: ref.agent } : {}), ...(download ? { download: "1" } : {}) }).toString();
  return `/api/sessions/${encodeURIComponent(sessionId)}/sent/${encodeURIComponent(ref.call)}/${ref.n}${raw ? "/raw" : ""}${q ? `?${q}` : ""}`;
}

export const SENT_ERROR_TEXT: Record<string, string> = {
  gone: "지워진 파일입니다",
  denied: "비밀 파일이라 열 수 없습니다",
  not_sent: "보내지 못한 파일입니다",
  not_found: "보낸 파일 기록을 찾을 수 없습니다",
  too_large: "너무 커서(50MB 초과) 받을 수 없습니다",
};
