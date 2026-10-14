import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Transcripts are read from ~/.claude, so the test runs against an empty home of its own.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccrc-home-"));
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
after(() => fs.rmSync(home, { recursive: true, force: true }));

const { ItemBuilder } = await import("../src/sessions/items.ts");
const { loadHistory, projectDirName } = await import("../src/sessions/history.ts");
const { toolReply } = await import("../src/sessions/replies.ts");

const cwd = path.join(home, "ws");
const Q1 = "Which library should we use?";
const Q2 = "Which features do you want?";
const QUESTIONS = [
  {
    question: Q1,
    header: "Library",
    multiSelect: false,
    options: [
      { label: "date-fns", description: "Small and modular", preview: "import { format } from 'date-fns'" },
      { label: "dayjs", description: "Moment-like API" },
    ],
  },
  {
    question: Q2,
    header: "Features",
    multiSelect: true,
    options: [
      { label: "Search", description: "Full text" },
      { label: "Tags, labels", description: "Grouping" },
      { label: "Export", description: "CSV" },
    ],
  },
];
const ASK = { type: "assistant", uuid: "a1", message: { content: [{ type: "tool_use", id: "toolu_q", name: "AskUserQuestion", input: { questions: QUESTIONS } }] } };
const ANSWERED_TEXT = `Your questions have been answered: "${Q1}"="date-fns" selected preview:\nimport { format } from 'date-fns' notes: keep it small, "${Q2}"="Search, Tags, labels, Vim keys". You can now continue with these answers in mind.`;
const OUTPUT = {
  questions: QUESTIONS,
  answers: { [Q1]: "date-fns", [Q2]: "Search, Tags, labels, Vim keys" },
  annotations: { [Q1]: { preview: "import { format } from 'date-fns'", notes: "keep it small" } },
};
const EXPECTED = {
  kind: "answered",
  answers: { [Q1]: "date-fns", [Q2]: "Search, Tags, labels, Vim keys" },
  notes: { [Q1]: "keep it small" },
  previews: { [Q1]: "import { format } from 'date-fns'" },
};

function result(content: string, extra: Record<string, unknown> = {}, isError = false) {
  return { type: "user", uuid: "u2", message: { content: [{ type: "tool_result", tool_use_id: "toolu_q", content, is_error: isError }] }, ...extra };
}

function replyOf(b: InstanceType<typeof ItemBuilder>, id = "toolu_q") {
  const item = b.items.find((i) => i.id === id);
  assert.ok(item?.kind === "tool");
  return item.reply;
}

test("a question's answers come from the live tool_use_result, and nothing else of it", () => {
  const b = new ItemBuilder(cwd);
  b.add(ASK);
  b.add(result(ANSWERED_TEXT, { tool_use_result: { ...OUTPUT, extra: "dropped", answers: { ...OUTPUT.answers, Odd: { x: 1 } } } }));
  assert.deepEqual(replyOf(b), EXPECTED);
});

test("a transcript without structured output gives the same answers from the result text", () => {
  const live = new ItemBuilder(cwd);
  live.add(ASK);
  live.add(result(ANSWERED_TEXT, { tool_use_result: OUTPUT }));
  const old = new ItemBuilder(cwd);
  old.add(ASK);
  old.add(result(ANSWERED_TEXT));
  assert.deepEqual(old.items, live.items);
});

test("result texts: other wording, no option with notes, unanswered, a response, declined and interrupted", () => {
  const input = { questions: QUESTIONS };
  const reply = (text: string, isError = false, output?: unknown) => toolReply("AskUserQuestion", input, text, isError, output);
  assert.deepEqual(
    reply(`The user answered: "${Q1}"="Something "quoted"", "${Q2}"=(no option selected) notes: none fit. Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.`),
    { kind: "answered", answers: { [Q1]: 'Something "quoted"' }, notes: { [Q2]: "none fit" } },
  );
  assert.deepEqual(reply("The user did not answer the questions."), { kind: "unanswered" });
  assert.deepEqual(reply("The user responded: Let's talk first"), { kind: "answered", answers: {}, response: "Let's talk first" });
  assert.equal(reply("Something Claude Code may say later"), undefined);
  assert.deepEqual(
    reply(
      "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). The user provided the following reason for the rejection: not now",
      true,
    ),
    { kind: "declined", reason: "not now" },
  );
  assert.deepEqual(reply("The user doesn't want to proceed with this tool use. The tool use was rejected.", true), { kind: "declined" });
  assert.equal(reply("<tool_use_error>InputValidationError</tool_use_error>", true), undefined);
  assert.deepEqual(reply("[Request interrupted by user for tool use]", true), { kind: "interrupted" });
  assert.deepEqual(reply("", false, { questions: QUESTIONS, answers: { [Q1]: "(notes only)" } }), { kind: "unanswered" });
  assert.deepEqual(reply("", false, { questions: QUESTIONS, answers: { [Q2]: ["Search", "Export"] }, followUp: true }), {
    kind: "answered",
    answers: { [Q2]: "Search, Export" },
    followUp: true,
  });
  assert.equal(toolReply("Bash", input, "The user did not answer the questions.", false, undefined), undefined);
});

test("a plan's outcome: approved, approved as edited, kept planning with or without feedback", () => {
  const plan = (text: string, isError = false, output?: unknown) => toolReply("ExitPlanMode", { plan: "# Plan" }, text, isError, output);
  assert.deepEqual(plan("User has approved your plan. You can now start coding.\n\n## Approved Plan:\n# Plan"), { kind: "approved" });
  assert.deepEqual(plan("User has approved your plan.\n\n## Approved Plan (edited by user):\n# Better plan"), { kind: "approved", plan: "# Better plan" });
  assert.deepEqual(plan("User has approved your plan.", false, { plan: "# Edited", isAgent: false, planWasEdited: true }), { kind: "approved", plan: "# Edited" });
  assert.deepEqual(plan("Use a queue instead", true), { kind: "kept_planning", feedback: "Use a queue instead" });
  assert.deepEqual(plan("The user wants to keep planning.", true), { kind: "kept_planning" });
  assert.deepEqual(
    plan("The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). The user provided the following reason for the rejection: split step 2", true),
    { kind: "kept_planning", feedback: "split step 2" },
  );
  assert.deepEqual(plan("[Request interrupted by user for tool use]", true), { kind: "interrupted" });
  assert.equal(plan("<tool_use_error>You are not in plan mode.</tool_use_error>", true), undefined);
  assert.equal(plan("Your plan has been submitted to the team lead for approval."), undefined);
});

test("a long plan keeps more of its text than other tool input", () => {
  const b = new ItemBuilder(cwd);
  const long = "x".repeat(6000);
  b.add({ type: "assistant", uuid: "a1", message: { content: [{ type: "tool_use", id: "p1", name: "ExitPlanMode", input: { plan: long } }] } });
  b.add({ type: "assistant", uuid: "a2", message: { content: [{ type: "tool_use", id: "w1", name: "Write", input: { file_path: "/x", content: long } }] } });
  const input = (id: string) => (b.items.find((i) => i.id === id) as { input: Record<string, string> }).input;
  assert.equal(input("p1").plan, long);
  assert.ok(input("w1").content.length < long.length);
});

test("a loaded conversation keeps question answers and an edited plan from the transcript", async () => {
  const sid = "5b7e2c91-4d3a-4e8f-a1b6-9c0d2e4f6a83";
  const base = { isSidechain: false, userType: "external", cwd, sessionId: sid, version: "2.1.296", gitBranch: "HEAD" };
  const rows = [
    { ...base, parentUuid: null, type: "user", uuid: "u1", timestamp: "2026-10-14T03:00:00.000Z", message: { role: "user", content: "Ask me" } },
    { ...base, parentUuid: "u1", type: "assistant", uuid: "a1", timestamp: "2026-10-14T03:00:01.000Z", message: { role: "assistant", content: ASK.message.content } },
    {
      ...base,
      parentUuid: "a1",
      type: "user",
      uuid: "u2",
      timestamp: "2026-10-14T03:00:02.000Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_q", content: ANSWERED_TEXT }] },
      toolUseResult: OUTPUT,
    },
    {
      ...base,
      parentUuid: "u2",
      type: "assistant",
      uuid: "a2",
      timestamp: "2026-10-14T03:00:03.000Z",
      message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_p", name: "ExitPlanMode", input: { plan: "# Plan" } }] },
    },
    {
      ...base,
      parentUuid: "a2",
      type: "user",
      uuid: "u3",
      timestamp: "2026-10-14T03:00:04.000Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_p", content: "User has approved your plan." }] },
      toolUseResult: { plan: "# Plan, edited", isAgent: false, filePath: "/p.md", planWasEdited: true },
    },
  ];
  const dir = path.join(home, ".claude", "projects", projectDirName(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const items = await loadHistory(sid, cwd);
  const reply = (id: string) => {
    const item = items.find((i) => i.id === id);
    assert.ok(item?.kind === "tool");
    return item.reply;
  };
  assert.deepEqual(reply("toolu_q"), EXPECTED);
  assert.deepEqual(reply("toolu_p"), { kind: "approved", plan: "# Plan, edited" });
});
