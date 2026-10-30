import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { DisplayItem, LiveState, ModelOption } from "../src/protocol.ts";

// Transcripts are read from ~/.claude, so the test runs against an empty home of its own.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccrc-home-"));
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
after(() => fs.rmSync(home, { recursive: true, force: true }));

const { loadHistory, projectDirName } = await import("../src/sessions/history.ts");
const { ItemBuilder, modelFacts } = await import("../src/sessions/items.ts");
const { noticeText } = await import("../../web/src/components/notices.ts");
const { modelMark } = await import("../../web/src/components/composer/modelMark.ts");
const { setLang } = await import("../../web/src/i18n/index.ts");

const SID = "6a2e9c41-3b7d-4f08-9e15-2c8d4a7b1f63";
const cwd = path.join(home, "ws");
const FALLBACK_TEXT =
  "Opus 5.5's safeguards flagged this session. Opus 4.8 is answering instead, or you can edit and retry with Opus 5.5. Send feedback with /feedback.";
const WHY = "This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy.";
const STOPPED = "Opus 5.5 (1M context)'s safeguards stopped the response above · continuing once with that noted";
const IDLE = 'Compacted using a summary written while you were away · turn off with "idleCompaction": false in settings.json';
const notices = (items: DisplayItem[]) => items.filter((i) => i.kind === "notice");

// Rows in the shape Claude Code 2.1.304–2.1.310 writes them, ids and paths made up.
function transcript(): string {
  const base = { isSidechain: false, userType: "external", entrypoint: "claude-vscode", cwd, sessionId: SID, version: "2.1.310", gitBranch: "main" };
  const rows: Record<string, unknown>[] = [];
  let parent: string | null = null;
  let n = 0;
  const add = (row: Record<string, unknown>) => {
    const uuid = (row.uuid as string | undefined) ?? `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    rows.push({ ...base, parentUuid: parent, uuid, timestamp: new Date(Date.UTC(2026, 9, 26, 1, rows.length + 1)).toISOString(), ...row });
    parent = uuid;
  };
  const reply = (model: string, text: string) =>
    add({ type: "assistant", message: { id: `msg_${n}`, role: "assistant", model, type: "message", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } });
  add({ type: "user", message: { role: "user", content: "Check the scanner" } });
  reply("claude-opus-5-5", "Looking at it.");
  add({ type: "user", message: { role: "user", content: "Go on with the port list" } });
  add({
    type: "system",
    subtype: "model_refusal_fallback",
    uuid: "f0000000-0000-4000-8000-000000000001",
    direction: "retry",
    scope: "session",
    content: FALLBACK_TEXT,
    level: "warning",
    trigger: "refusal",
    originalModel: "claude-opus-5-5[1m]",
    fallbackModel: "claude-opus-4-8",
    requestId: "req_example",
    apiRefusalCategory: "cyber",
    apiRefusalExplanation: WHY,
    retractedMessageUuids: [],
    refusedUserMessageUuid: "00000000-0000-4000-8000-000000000003",
    isMeta: false,
  });
  reply("claude-opus-4-8", "Here is the port list.");
  add({ type: "system", subtype: "informational", uuid: "f0000000-0000-4000-8000-000000000002", content: STOPPED, level: "notice", isMeta: false });
  add({ type: "system", subtype: "informational", content: "Started in the background: a scan", level: "info", isMeta: false });
  add({ type: "system", subtype: "informational", uuid: "f0000000-0000-4000-8000-000000000003", content: IDLE, level: "notice", isMeta: false });
  add({ type: "user", message: { role: "user", content: "And the other host?" } });
  add({
    type: "system",
    subtype: "model_refusal_no_fallback",
    uuid: "f0000000-0000-4000-8000-000000000004",
    content: "",
    level: "warning",
    originalModel: "claude-opus-5-5",
    apiRefusalCategory: "reasoning_extraction",
    apiRefusalExplanation: "This request was blocked.",
    isMeta: false,
  });
  reply("claude-opus-4-8", "I can't continue that.");
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

test("a transcript's safeguard and notice rows load as notices in place, a line at level info left out", async () => {
  const dir = path.join(home, ".claude", "projects", projectDirName(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${SID}.jsonl`), transcript());
  const items = await loadHistory(SID, cwd);
  assert.deepEqual(
    items.map((i) => (i.kind === "notice" ? `notice:${i.notice}` : i.kind)),
    ["user", "assistant", "user", "notice:fallback", "assistant", "notice:line", "notice:line", "user", "notice:refusal", "assistant"],
  );
  assert.deepEqual(notices(items), [
    {
      kind: "notice",
      id: "f0000000-0000-4000-8000-000000000001",
      ts: "2026-10-26T01:04:00.000Z",
      notice: "fallback",
      text: FALLBACK_TEXT,
      model: "claude-opus-5-5[1m]",
      category: "cyber",
      detail: WHY,
      fallback: "claude-opus-4-8",
    },
    { kind: "notice", id: "f0000000-0000-4000-8000-000000000002", ts: "2026-10-26T01:06:00.000Z", notice: "line", text: STOPPED, level: "notice" },
    { kind: "notice", id: "f0000000-0000-4000-8000-000000000003", ts: "2026-10-26T01:08:00.000Z", notice: "line", text: IDLE, level: "notice" },
    {
      kind: "notice",
      id: "f0000000-0000-4000-8000-000000000004",
      ts: "2026-10-26T01:10:00.000Z",
      notice: "refusal",
      text: "",
      model: "claude-opus-5-5",
      category: "reasoning_extraction",
      detail: "This request was blocked.",
    },
  ]);
  assert.deepEqual(
    items.filter((i) => i.kind === "assistant").map((i) => i.kind === "assistant" && i.model),
    ["claude-opus-5-5", "claude-opus-4-8", "claude-opus-4-8"],
    "each reply names the model that wrote it",
  );
  assert.deepEqual(modelFacts(items), { answered: "claude-opus-4-8", swapped: { from: "claude-opus-5-5[1m]", to: "claude-opus-4-8" } });
});

test("live notices come by their SDK names and show as the transcript's do", () => {
  const b = new ItemBuilder(cwd);
  b.add({
    type: "system",
    subtype: "model_refusal_fallback",
    uuid: "s1",
    direction: "retry",
    scope: "session",
    content: FALLBACK_TEXT,
    trigger: "refusal",
    original_model: "claude-opus-5-5",
    fallback_model: "claude-opus-4-8",
    request_id: null,
    api_refusal_category: "cyber",
    api_refusal_explanation: null,
    retracted_message_uuids: ["x"],
    refused_user_message_uuid: null,
  } as never);
  b.add({ type: "system", subtype: "model_refusal_fallback", uuid: "s2", scope: "local", content: "local", original_model: "claude-opus-5-5", fallback_model: "claude-opus-4-8" } as never);
  b.add({ type: "system", subtype: "informational", uuid: "s3", content: "  A hook says: hold on  ", level: "warning" } as never);
  b.add({ type: "system", subtype: "informational", uuid: "s4", content: "Status: compacting", level: "info" } as never);
  b.add({ type: "system", subtype: "informational", uuid: "s5", content: "", level: "notice" } as never);
  b.add({ type: "system", subtype: "informational", uuid: "s6", content: "Hook running for Bash", level: "notice", tool_use_id: "toolu_1" } as never);
  b.add({ type: "system", subtype: "informational", uuid: "s7", content: "Hook done for Bash", level: "notice", tool_use_id: "toolu_1" } as never);
  b.add({ type: "system", subtype: "informational", uuid: "s8", content: "Odd level", level: "loud" } as never);
  assert.deepEqual(
    notices(b.items).map((i) => i.kind === "notice" && [i.id, i.notice, i.text, i.level ?? "", i.local ?? false, i.fallback ?? ""]),
    [
      ["s1", "fallback", FALLBACK_TEXT, "", false, "claude-opus-4-8"],
      ["s2", "fallback", "local", "", true, "claude-opus-4-8"],
      ["s3", "line", "A hook says: hold on", "warning", false, ""],
      ["notice:toolu_1", "line", "Hook done for Bash", "notice", false, ""],
      ["s8", "line", "Odd level", "notice", false, ""],
    ],
    "an empty line and one at level info show nothing; a later line about the same call takes the earlier one's place",
  );
});

test("a reply names its model, one Claude Code wrote itself none", () => {
  const b = new ItemBuilder(cwd);
  b.add({ type: "assistant", uuid: "a1", message: { model: "claude-opus-5-5", content: [{ type: "text", text: "Hi" }] } });
  b.add({ type: "assistant", uuid: "a2", message: { model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] } });
  b.add({ type: "assistant", uuid: "a3", message: { content: [{ type: "text", text: "From an older reader" }] } });
  assert.deepEqual(
    b.items.map((i) => i.kind === "assistant" && (i.model ?? null)),
    ["claude-opus-5-5", null, null],
  );
});

test("the session counts as moved by the safeguards while every reply since came from the fallback model", () => {
  const b = new ItemBuilder(cwd);
  const reply = (id: string, model: string) => b.add({ type: "assistant", uuid: id, message: { model, content: [{ type: "text", text: id }] } });
  const fallback = (id: string, scope: string) =>
    b.add({ type: "system", subtype: "model_refusal_fallback", uuid: id, scope, content: "x", original_model: "claude-opus-5-5[1m]", fallback_model: "claude-opus-4-8" } as never);
  assert.deepEqual(b.modelFacts(), {});
  reply("a1", "claude-opus-5-5");
  assert.deepEqual(b.modelFacts(), { answered: "claude-opus-5-5" });
  fallback("f1", "local");
  assert.deepEqual(b.modelFacts(), { answered: "claude-opus-5-5" }, "a subagent's fallback leaves the session's model");
  fallback("f2", "session");
  assert.deepEqual(b.modelFacts(), { answered: "claude-opus-5-5", swapped: { from: "claude-opus-5-5[1m]", to: "claude-opus-4-8" } });
  reply("a2", "claude-opus-4-8");
  reply("a3", "claude-opus-4-8");
  assert.deepEqual(b.modelFacts(), { answered: "claude-opus-4-8", swapped: { from: "claude-opus-5-5[1m]", to: "claude-opus-4-8" } });
  reply("a4", "claude-opus-5-5");
  assert.deepEqual(b.modelFacts(), { answered: "claude-opus-5-5" }, "a reply from another model since ends the move");
  b.seed(b.items.slice(0, 5));
  assert.deepEqual(b.modelFacts(), { answered: "claude-opus-4-8", swapped: { from: "claude-opus-5-5[1m]", to: "claude-opus-4-8" } }, "seeded items count afresh");
});

const MODELS: ModelOption[] = [
  { value: "default", resolved: "claude-opus-5-5[1m]", label: "Default (recommended)" },
  { value: "opus", resolved: "claude-opus-5-5", label: "Opus 5.5" },
  { value: "claude-opus-4-8", resolved: "claude-opus-4-8", label: "Opus 4.8" },
];
const NOTICE = { notice: "fallback", text: FALLBACK_TEXT, model: "claude-opus-5-5[1m]", fallback: "claude-opus-4-8", detail: WHY } as const;

test("notices read in the app's words with Claude Code's own behind them", () => {
  setLang("ko");
  assert.deepEqual(noticeText(NOTICE, MODELS), { text: "Opus 5.5 (1M) 모델의 안전장치에 걸려 이 세션은 Opus 4.8 모델로 바뀌었습니다", more: `${FALLBACK_TEXT}\n\n${WHY}` });
  assert.equal(noticeText({ ...NOTICE, local: true }, MODELS).text, "Opus 5.5 (1M) 모델의 안전장치에 걸려 서브에이전트나 곁질문의 답 하나를 Opus 4.8 모델이 했습니다");
  assert.deepEqual(noticeText({ notice: "refusal", text: "", model: "claude-opus-5-5" }, MODELS), { text: "Opus 5.5 모델의 안전장치가 응답을 막았습니다", more: undefined });
  assert.deepEqual(noticeText({ notice: "line", text: STOPPED, level: "notice" }, []), {
    text: "Opus 5.5 (1M context) 모델의 안전장치가 위 응답을 멈췄습니다 · 이를 알리고 한 번 이어 갑니다",
    more: STOPPED,
  });
  assert.match(noticeText({ notice: "line", text: IDLE }, []).text, /^자리를 비운 사이/);
  assert.deepEqual(noticeText({ notice: "line", text: "A hook says: hold on", level: "warning" }, []), { text: "A hook says: hold on" }, "a line the app does not know stays as written");
  assert.equal(noticeText({ notice: "fallback", text: "" }, []).text, "Claude 모델의 안전장치에 걸려 이 세션은 Claude 모델로 바뀌었습니다");
  setLang("en");
  assert.deepEqual(noticeText({ notice: "line", text: STOPPED }, []), { text: STOPPED }, "in English the line is Claude Code's own, with nothing behind it");
  assert.equal(noticeText(NOTICE, MODELS).text, "Opus 5.5 (1M)'s safeguards flagged a message, so this session switched to Opus 4.8");
  setLang("ko");
});

test("the model chip is marked when another model answered or the safeguards moved the session", () => {
  setLang("ko");
  const state = (s: Partial<LiveState>): LiveState => ({ sessionId: SID, cwd, state: "attached", busy: false, ...s });
  assert.equal(modelMark(MODELS, undefined), undefined);
  assert.equal(modelMark(MODELS, state({ model: "claude-opus-5-5[1m]", answered: "claude-opus-5-5" })), undefined, "the 1M window is the same model");
  assert.equal(modelMark(MODELS, state({ model: "claude-opus-4-8", answered: "claude-opus-4-8-20260101" })), undefined, "so is a dated id");
  assert.equal(modelMark(MODELS, state({ model: "claude-opus-4-8", answered: "us.anthropic.claude-opus-4-8-v1:0" })), undefined, "an id of another form is never told apart");
  assert.equal(modelMark(MODELS, state({ model: "default", answered: "claude-opus-5-5" })), undefined, "a name the list resolves");
  assert.equal(modelMark(MODELS, state({ model: "sonnet", answered: "claude-opus-4-8" })), undefined, "a name it cannot tell is never marked");
  assert.equal(modelMark([], state({ model: "opus", answered: "claude-opus-4-8" })), undefined, "nor before the list has come");
  assert.equal(modelMark(MODELS, state({ model: "opus", answered: "claude-opus-4-8" })), "마지막 답은 Opus 4.8 모델이 했습니다.");
  const swapped = { from: "claude-opus-5-5[1m]", to: "claude-opus-4-8" };
  assert.equal(
    modelMark(MODELS, state({ model: "claude-opus-5-5", answered: "claude-opus-4-8", swapped })),
    "마지막 답은 Opus 4.8 모델이 했습니다. Opus 5.5 (1M) 모델의 안전장치가 메시지를 막아 이 세션을 Opus 4.8 모델로 바꿨습니다.",
  );
  assert.equal(
    modelMark(MODELS, state({ model: "claude-opus-4-8", answered: "claude-opus-4-8", swapped })),
    "Opus 5.5 (1M) 모델의 안전장치가 메시지를 막아 이 세션을 Opus 4.8 모델로 바꿨습니다. 다른 모델을 고르면 다음 답부터 바뀝니다.",
    "the chip names the fallback model Claude Code switched to",
  );
  assert.equal(modelMark(MODELS, state({ answered: "claude-opus-4-8", swapped })), modelMark(MODELS, state({ model: "claude-opus-4-8", answered: "claude-opus-4-8", swapped })));
  assert.equal(modelMark(MODELS, state({ model: "claude-opus-4-8", answered: "claude-opus-4-8" })), undefined, "a model chosen by hand");
});
