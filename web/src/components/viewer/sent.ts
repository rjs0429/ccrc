import type { SentRef } from "../../../../broker/src/protocol.ts";
import { k } from "../../i18n/index.ts";

// The largest image or PDF the viewer shows; a larger one only downloads.
export const PREVIEW_MAX_BYTES = 10_000_000;

// The viewer's view of a file Claude sent, or its bytes.
export function sentUrl(sessionId: string, ref: SentRef, raw = false, download = false): string {
  const q = new URLSearchParams({ ...(ref.agent ? { agent: ref.agent } : {}), ...(download ? { download: "1" } : {}) }).toString();
  return `/api/sessions/${encodeURIComponent(sessionId)}/sent/${encodeURIComponent(ref.call)}/${ref.n}${raw ? "/raw" : ""}${q ? `?${q}` : ""}`;
}

// Why a file Claude sent does not open, by the broker's error; handed to t() where it is shown.
export const SENT_ERROR_TEXT: Record<string, string> = {
  gone: k("지워진 파일입니다"),
  denied: k("비밀 파일이라 열 수 없습니다"),
  not_sent: k("보내지 못한 파일입니다"),
  not_found: k("보낸 파일 기록을 찾을 수 없습니다"),
  too_large: k("너무 커서(50MB 초과) 받을 수 없습니다"),
};
