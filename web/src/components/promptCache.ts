import type { PromptCache } from "../../../broker/src/protocol.ts";
import { k, t } from "../i18n/index.ts";
import { clock, idleText } from "../labels.ts";

const TTL_MS: Record<NonNullable<PromptCache["ttl"]>, number> = { "5m": 5 * 60_000, "1h": 60 * 60_000 };
const WARM_HINT: Record<NonNullable<PromptCache["ttl"]>, string> = {
  "5m": k("5분 캐시, 마지막 요청 {time}. 그 안에 보내면 대화를 캐시에서 읽어 빠르고 사용량이 적게 듭니다."),
  "1h": k("1시간 캐시, 마지막 요청 {time}. 그 안에 보내면 대화를 캐시에서 읽어 빠르고 사용량이 적게 듭니다."),
};

export type CacheNow =
  | { kind: "warm"; ttl: NonNullable<PromptCache["ttl"]>; at: number; msLeft: number; minutes: number }
  | { kind: "cold"; reason: "expired" | "compacted"; idleMs: number; tokens?: number };

// The cache at `now` as VS Code reads it: warm until its time to live has passed since the request that last wrote or
// read it, and cold since a compaction.
export function cacheNow(c: PromptCache | undefined, now: number): CacheNow | undefined {
  if (!c) return undefined;
  if (c.compactedAt !== undefined) return { kind: "cold", reason: "compacted", idleMs: Math.max(0, now - c.compactedAt) };
  if (c.at === undefined || !c.ttl) return undefined;
  const ttl = TTL_MS[c.ttl];
  const left = Math.min(ttl, c.at + ttl - now);
  if (left > 0) return { kind: "warm", ttl: c.ttl, at: c.at, msLeft: left, minutes: Math.ceil(left / 60_000) };
  return { kind: "cold", reason: "expired", idleMs: now - c.at, ...(c.tokens ? { tokens: c.tokens } : {}) };
}

export function cacheLabel(s: CacheNow): string {
  if (s.kind === "warm") return t("프롬프트 캐시 {n}분 남음", { n: s.minutes });
  return s.reason === "compacted" ? t("프롬프트 캐시 없음 (대화를 요약함)") : t("프롬프트 캐시 만료");
}

// The sentence that explains the state, and what the next message costs.
export function cacheText(s: CacheNow, tokens: (n: number) => string): { head: string; hint: string } {
  if (s.kind === "warm") {
    return {
      head: t("캐시가 살아 있습니다 · 약 {n}분 남음", { n: s.minutes }),
      hint: t(WARM_HINT[s.ttl], { time: clock(new Date(s.at)) }),
    };
  }
  if (s.reason === "compacted") return { head: t("대화를 요약해 캐시가 없습니다"), hint: t("다음 메시지가 요약한 대화를 다시 캐시합니다.") };
  return {
    head: t("캐시가 만료되었을 수 있습니다 · 쉰 지 {idle}", { idle: idleText(s.idleMs) }),
    hint: s.tokens ? t("다음 메시지가 약 {tokens} 토큰을 다시 캐시합니다.", { tokens: tokens(s.tokens) }) : t("다음 메시지가 대화 전체를 다시 캐시합니다."),
  };
}
