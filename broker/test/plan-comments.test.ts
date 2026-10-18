import assert from "node:assert/strict";
import { test } from "node:test";
import { planFeedback } from "../../web/src/components/planComments.ts";

test("keep-planning feedback puts each comment under its line and that line's text, after what the user wrote", () => {
  const comments = [
    { line: 3, end: 3, quote: "2. Update the parser", text: "파서는 그대로 두세요" },
    { line: 7, end: 9, quote: "```ts", text: "이 코드는 빼 주세요" },
  ];
  assert.equal(planFeedback("  테스트를 먼저  ", comments), '테스트를 먼저\n\n계획에 단 코멘트:\n줄 3 "2. Update the parser": 파서는 그대로 두세요\n줄 7–9 "```ts": 이 코드는 빼 주세요');
  assert.equal(planFeedback("", comments.slice(0, 1)), '계획에 단 코멘트:\n줄 3 "2. Update the parser": 파서는 그대로 두세요');
  assert.equal(planFeedback(" 그냥 다시 ", []), "그냥 다시");
  assert.equal(planFeedback("", [{ line: 1, end: 1, quote: "", text: "빈 줄" }]), "계획에 단 코멘트:\n줄 1: 빈 줄");
});
