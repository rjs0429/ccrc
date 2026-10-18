import assert from "node:assert/strict";
import { test } from "node:test";
import type { DisplayItem } from "../src/protocol.ts";
import { EXPORT_MAX, exportMarkdown, exportName, timeZone } from "../src/sessions/export.ts";

const at = new Date("2026-10-18T01:40:00Z");
const base = { title: "파서 고치기", cwd: "/home/user/app", sessionId: "9a1b2c3d-1111-4111-8111-111111111111", at, tz: "Asia/Seoul", tools: true };

const items: DisplayItem[] = [
  { kind: "user", id: "u1", ts: "2026-10-17T14:59:00Z", text: "파서를 고쳐 줘", attachments: [{ kind: "image", mediaType: "image/png", size: 10 }, { kind: "document", mediaType: "application/pdf", size: 5, name: "spec.pdf" }] },
  { kind: "thinking", id: "a1:0", ts: "2026-10-17T15:01:00Z", text: "secret thoughts" },
  { kind: "assistant", id: "a1:1", ts: "2026-10-17T15:01:00Z", text: "먼저 읽겠습니다.\n\n```ts\nconst a = 1;\n```\n" },
  { kind: "tool", id: "t1", ts: "2026-10-17T15:01:00Z", name: "Read", summary: "src/parse.ts", input: {} },
  { kind: "tool", id: "t2", ts: "2026-10-17T15:01:00Z", name: "Bash", summary: "npm test", input: {}, result: { text: "fail", isError: true, truncated: false } },
  { kind: "assistant", id: "a2:0", ts: "2026-10-17T15:02:00Z", text: "고쳤습니다." },
  { kind: "tool", id: "q1", ts: "2026-10-17T15:02:00Z", name: "AskUserQuestion", summary: "", input: { questions: [{ question: "테스트도 고칠까요?" }] }, reply: { kind: "answered", answers: { "테스트도 고칠까요?": "네" } } },
  { kind: "tool", id: "p1", ts: "2026-10-17T15:03:00Z", name: "ExitPlanMode", summary: "", input: { plan: "1. 파서\n2. 테스트" }, reply: { kind: "kept_planning", feedback: "줄 2: 빼 주세요" } },
  { kind: "note", id: "n1", ts: "2026-10-17T15:04:00Z", code: "compacted" },
  { kind: "note", id: "n2", ts: "2026-10-17T15:05:00Z", code: "command", text: "/compact keep tests" },
  { kind: "command", id: "c1", ts: "2026-10-17T15:05:00Z", name: "usage", text: "Current session: 3%\n``` fence inside" },
  { kind: "message", id: "m1", ts: "2026-10-17T15:06:00Z", from: "agent", name: "Explore", text: "report" },
  { kind: "message", id: "m2", ts: "2026-10-17T15:06:00Z", from: "session", name: "other", text: "hello from another session" },
  { kind: "task", id: "k1", ts: "2026-10-17T15:07:00Z", status: "completed", summary: "Listed the folders" },
  { kind: "shell", id: "s1", ts: "2026-10-18T00:10:00Z", command: "ls", output: "a\nb" },
  { kind: "assistant", id: "a3:0", ts: "2026-10-18T00:11:00Z", text: "끝" },
];

test("a conversation becomes Markdown: turns under headings with their local time, Claude's text as written, tools one per line", () => {
  const x = exportMarkdown(items, base);
  const t = x.text;
  assert.ok(t.startsWith("# 파서 고치기\n\n- 작업 폴더: `/home/user/app`\n- 세션 ID: `9a1b2c3d-1111-4111-8111-111111111111`\n- 내보낸 때: 2026-10-18 10:40 (Asia/Seoul)\n\n---\n"), t.slice(0, 200));
  assert.ok(t.includes("### 사용자 · 2026-10-17 23:59\n\n파서를 고쳐 줘\n\n*첨부: 이미지 1개, spec.pdf*"), "the user's message, in the phone's time zone, with its attachments");
  assert.ok(t.includes("### Claude · 2026-10-18 00:01\n\n먼저 읽겠습니다.\n\n```ts\nconst a = 1;\n```\n\n- 도구 `Read` · src/parse.ts\n- 도구 `Bash` · npm test (오류)\n\n고쳤습니다."), "a new day's first heading names the day; tool lines stay one list");
  assert.ok(!t.includes("secret thoughts"), "thinking is left out");
  assert.ok(t.includes("- 질문: 테스트도 고칠까요? → 답: 네"));
  assert.ok(t.includes("**계획**\n\n> 1. 파서\n> 2. 테스트\n\n*계속 계획하기: 줄 2: 빼 주세요*"));
  assert.ok(t.includes("\n*이전 대화를 요약했습니다*\n"));
  assert.ok(t.includes("### 사용자 · 00:05\n\n`/compact keep tests`"), "the same day's later headings name the time only");
  assert.ok(t.includes("### 명령 출력 · /usage · 00:05\n\n````text\nCurrent session: 3%\n``` fence inside\n````"), "a fence longer than any run of backticks inside");
  assert.ok(t.includes("### 에이전트 보고 · @Explore · 00:06\n\n> report"));
  assert.ok(t.includes("### 다른 세션 메시지 · @other · 00:06\n\n> hello from another session"));
  assert.ok(t.includes("### Claude · 00:07\n\n- 백그라운드 작업 완료 · Listed the folders"));
  assert.ok(t.includes("### 사용자 · 09:10\n\n```\n! ls\na\nb\n```"));
  assert.ok(t.endsWith("### Claude · 09:11\n\n끝\n"));
  assert.equal(x.messages, 4);
  assert.equal(x.name, "파서 고치기-20261018-1040.md");
  assert.equal(x.cut, undefined);
});

test("without tools only the talk stays: questions, plans, commands and messages from other sessions too", () => {
  const t = exportMarkdown(items, { ...base, tools: false }).text;
  for (const gone of ["`Read`", "`Bash`", "백그라운드 작업", "에이전트 보고"]) assert.ok(!t.includes(gone), gone);
  for (const kept of ["- 질문:", "**계획**", "/usage", "다른 세션 메시지", "먼저 읽겠습니다."]) assert.ok(t.includes(kept), kept);
  assert.ok(t.includes("```\n\n고쳤습니다."), "Claude's texts of one turn stay under one heading");
});

test("a file over the limit leaves out the last items and says how many", () => {
  const big = "x".repeat(EXPORT_MAX / 2 + 10);
  const x = exportMarkdown(
    [
      { kind: "user", id: "u1", text: big },
      { kind: "assistant", id: "a1", text: big },
      { kind: "assistant", id: "a2", text: "short" },
    ],
    { ...base, tz: undefined },
  );
  assert.equal(x.cut, 2);
  assert.equal(x.messages, 1);
  assert.ok(x.text.length <= EXPORT_MAX + 200);
  assert.ok(x.text.trimEnd().endsWith("*파일이 너무 커서 마지막 항목 2개는 뺐습니다*"));
});

test("file names keep the title's words without characters files cannot have, and the time zone falls back", () => {
  assert.equal(exportName('a/b\\c:*?"<>|#% d\n e', at, "UTC"), "a b c d e-20261018-0140.md");
  assert.equal(exportName("", at, "UTC"), "대화-20261018-0140.md");
  assert.equal(exportName("가".repeat(100) + ".", at, "UTC"), `${"가".repeat(60)}-20261018-0140.md`);
  assert.equal(timeZone("Asia/Seoul"), "Asia/Seoul");
  for (const bad of ["Mars/Base", "", 3, "x".repeat(65), undefined]) assert.equal(timeZone(bad), undefined, String(bad));
});
