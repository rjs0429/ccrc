import assert from "node:assert/strict";
import { test } from "node:test";
import { BROKER_DIALOGS, answerable, dialogAnswer, dialogInfo, dialogResult } from "../src/dialogs.ts";
import { creditsText, errorText, refusalText } from "../../web/src/labels.ts";

test("the phone answers the refusal and auto mode dialogs, never the credits consent; broker sessions declare the refusal alone", () => {
  assert.deepEqual(BROKER_DIALOGS, ["refusal_fallback_prompt"]);
  assert.ok(answerable("refusal_fallback_prompt"));
  assert.ok(answerable("auto_mode_server_fallback"));
  assert.ok(!answerable("fable_overage_consent_prompt"));
  assert.ok(!answerable("toString"));
  assert.deepEqual(dialogResult("refusal_fallback_prompt", "retry_fallback"), { behavior: "completed", result: "retry_fallback" });
  assert.deepEqual(dialogResult("refusal_fallback_prompt", "edit_prompt"), { behavior: "completed", result: "edit_prompt" });
  assert.deepEqual(dialogResult("auto_mode_server_fallback", "interrupt"), { behavior: "completed", result: "interrupt" });
  assert.deepEqual(dialogResult("auto_mode_server_fallback", "cancel"), { behavior: "cancelled" });
  for (const [kind, choice] of [
    ["refusal_fallback_prompt", "continue"],
    ["auto_mode_server_fallback", "retry_fallback"],
    ["fable_overage_consent_prompt", "consent"],
    ["fable_overage_consent_prompt", "cancel"],
    ["refusal_fallback_prompt", 1],
    ["refusal_fallback_prompt", "cancelled"],
  ] as const) {
    assert.equal(dialogResult(kind, choice), undefined, `${kind} ${choice}`);
  }
});

test("a remote answer is taken only in Claude Code's own shapes and rebuilt", () => {
  assert.deepEqual(dialogAnswer("auto_mode_server_fallback", { behavior: "completed", result: "continue" }), { behavior: "completed", result: "continue" });
  assert.deepEqual(dialogAnswer("auto_mode_server_fallback", { behavior: "cancelled" }), { behavior: "cancelled" });
  for (const bad of [
    { behavior: "completed", result: "continue", extra: 1 },
    { behavior: "completed", result: "cancel" },
    { behavior: "completed" },
    { behavior: "cancelled", result: "continue" },
    { behavior: "allow" },
    null,
    "continue",
  ]) {
    assert.equal(dialogAnswer("auto_mode_server_fallback", bad), undefined, JSON.stringify(bad));
  }
  assert.equal(dialogAnswer("fable_overage_consent_prompt", { behavior: "cancelled" }), undefined);
});

test("payloads are reduced to what the phone shows, and one without what it needs is none", () => {
  assert.deepEqual(dialogInfo("refusal_fallback_prompt", { originalModel: " claude-opus-5-5 ", fallbackModel: "claude-sonnet-5", apiRefusalCategory: null, guidanceText: "x" }), {
    kind: "refusal_fallback_prompt",
    model: "claude-opus-5-5",
    fallback: "claude-sonnet-5",
  });
  assert.equal(dialogInfo("refusal_fallback_prompt", { originalModel: "a" }), undefined);
  assert.equal(dialogInfo("refusal_fallback_prompt", { originalModel: "a", fallbackModel: "b".repeat(201) }), undefined);
  const notice = dialogInfo("auto_mode_server_fallback", {
    title: "Billed",
    paragraphs: ["One", "", 3, "Two", ...Array(20).fill("More")],
    helpUrl: "https://docs.claude.com/x",
    gatewayHost: "gateway.example.com",
  });
  assert.deepEqual(notice, { kind: "auto_mode_server_fallback", title: "Billed", paragraphs: ["One", "Two", ...Array(8).fill("More")], helpUrl: "https://docs.claude.com/x", gateway: "gateway.example.com" });
  for (const url of ["http://claude.com/x", "https://claude.com.evil.example/x", "javascript:alert(1)"]) {
    assert.equal((dialogInfo("auto_mode_server_fallback", { helpUrl: url }) as { helpUrl?: string }).helpUrl, undefined, url);
  }
  assert.deepEqual(dialogInfo("fable_overage_consent_prompt", { overagesEnabled: false, modelName: "Fable", balanceCents: Infinity }), {
    kind: "fable_overage_consent_prompt",
    enabled: false,
    model: "Fable",
  });
  assert.equal(dialogInfo("fable_overage_consent_prompt", { modelName: "Fable" }), undefined);
  assert.equal(dialogInfo("auto_mode_outside_reads", {}), undefined);
});

test("the phone tells the dialogs and the MCP sign-in errors in Korean", () => {
  assert.equal(
    refusalText("Opus 5.5", "Sonnet 5", "cyber"),
    "Opus 5.5의 안전장치가 이 메시지를 막았습니다. 안전장치를 넓게 잡아 정상적인 코딩·보안 작업도 가끔 걸립니다. Sonnet 5 모델로 계속하거나, 메시지를 고쳐 Opus 5.5 모델로 다시 보내세요.",
  );
  assert.match(refusalText("Opus 5.5", "Sonnet 5"), /평범한 대화에서도/);
  assert.match(creditsText({ model: "Fable", enabled: true, balanceCents: 1200, currency: "USD" }), /US\$12\.00|\$12\.00/);
  assert.match(creditsText({ enabled: false }), /^Fable 모델은 .*아직 사용 크레딧이 없습니다/);
  assert.match(creditsText({ enabled: true, balanceCents: 500, currency: "KRW" }), /500/);
  assert.equal(errorText("No active OAuth flow for server: linear"), "진행 중인 인증이 없습니다. '인증'을 다시 누르세요");
  assert.match(errorText("Callback URL not accepted: it belongs to a different sign-in attempt (OAuth state mismatch)"), /다른 로그인 시도/);
  assert.match(errorText("invalid callback URL"), /localhost/);
  assert.match(errorText('Server type "stdio" does not support OAuth authentication'), /인증할 수 없습니다/);
  assert.equal(errorText("invalid answer"), "이 요청에 맞지 않는 답입니다");
});
