import assert from "node:assert/strict";
import { test } from "node:test";
import { planFeedback, planQuote } from "../../web/src/components/planComments.ts";

test("keep-planning feedback puts each comment under its line and that line's text, after what the user wrote", () => {
  const comments = [
    { line: 3, end: 3, quote: "2. Update the parser", text: "파서는 그대로 두세요" },
    { line: 7, end: 9, quote: "parse(a);", text: "이 코드는 빼 주세요" },
  ];
  assert.equal(planFeedback("  테스트를 먼저  ", comments), '테스트를 먼저\n\n계획에 단 코멘트:\n줄 3 "2. Update the parser": 파서는 그대로 두세요\n줄 7–9 "parse(a);": 이 코드는 빼 주세요');
  assert.equal(planFeedback("", comments.slice(0, 1)), '계획에 단 코멘트:\n줄 3 "2. Update the parser": 파서는 그대로 두세요');
  assert.equal(planFeedback(" 그냥 다시 ", []), "그냥 다시");
  assert.equal(planFeedback("", [{ line: 1, end: 1, quote: "", text: "빈 줄" }]), "계획에 단 코멘트:\n줄 1: 빈 줄");
});

test("a comment quotes the first line that tells its block apart: a code block's code, not its fence", () => {
  const lines = ["# Plan", "", "## Step 1", "", "```ts", "parse(a);", "```", "", "## Step 2", "", "~~~ts", "", "  parse(b);", "~~~", "", ">", "> > ```", "> > quoted code", "", "- top", "  - nested", "", "```", "```"];
  assert.equal(planQuote(lines, 1), "# Plan");
  assert.equal(planQuote(lines, 5, 7), "parse(a);");
  assert.equal(planQuote(lines, 11, 14), "parse(b);", "a tilde fence and a blank line are passed over");
  assert.equal(planQuote(lines, 16, 18), "> > quoted code", "inside a quote too, keeping its marks");
  assert.equal(planQuote(lines, 21), "- nested");
  assert.equal(planQuote(lines, 23, 24), "", "an empty code block quotes nothing");
  assert.equal(planQuote(lines, 99), "");
  const long = `- ${"가".repeat(100)}`;
  assert.equal(planQuote([long], 1), `${long.slice(0, 80)}…`);
  const fed = planFeedback("", [
    { line: 5, end: 7, quote: planQuote(lines, 5, 7), text: "첫 코드 고침" },
    { line: 11, end: 14, quote: planQuote(lines, 11, 14), text: "둘째 코드 고침" },
  ]);
  assert.equal(fed, '계획에 단 코멘트:\n줄 5–7 "parse(a);": 첫 코드 고침\n줄 11–14 "parse(b);": 둘째 코드 고침');
});
