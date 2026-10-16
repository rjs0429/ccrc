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

const { loadHistory, projectDirName } = await import("../src/sessions/history.ts");

const SID = "3c1f7a52-8d4e-4b6a-9f20-1e5d7c9b2a41";
const cwd = path.join(home, "ws");

// Rows in the shape Claude Code 2.1.296 writes them, trimmed to what the reader needs.
function transcript(): string {
  const base = { isSidechain: false, userType: "external", cwd, sessionId: SID, version: "2.1.296", gitBranch: "HEAD" };
  const rows = [
    {
      ...base,
      parentUuid: null,
      type: "user",
      uuid: "u1",
      timestamp: "2026-10-14T02:11:43.690Z",
      message: { role: "user", content: [{ type: "text", text: "Fix line two" }] },
    },
    {
      ...base,
      parentUuid: "u1",
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-10-14T02:11:48.240Z",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_edit", name: "Edit", input: { file_path: `${cwd}/edit_me.txt`, old_string: "line two", new_string: "line 2" } },
        ],
      },
    },
    {
      ...base,
      parentUuid: "a1",
      type: "user",
      uuid: "u2",
      timestamp: "2026-10-14T02:11:48.291Z",
      message: { role: "user", content: [{ tool_use_id: "toolu_edit", type: "tool_result", content: "The file has been updated successfully." }] },
      toolUseResult: {
        filePath: `${cwd}/edit_me.txt`,
        oldString: "line two",
        newString: "line 2",
        originalFile: "line one\nline two\nline three\n",
        structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" line one", "-line two", "+line 2", " line three"] }],
        userModified: false,
        replaceAll: false,
      },
      sourceToolAssistantUUID: "a1",
    },
    {
      ...base,
      parentUuid: "u2",
      type: "assistant",
      uuid: "a2",
      timestamp: "2026-10-14T02:11:49.650Z",
      message: { role: "assistant", content: [{ type: "text", text: "DONE" }] },
    },
  ];
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

test("a loaded conversation keeps the patches its transcript recorded", async () => {
  const dir = path.join(home, ".claude", "projects", projectDirName(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${SID}.jsonl`), transcript());
  const items = await loadHistory(SID, cwd);
  assert.deepEqual(
    items.map((i) => [i.kind, i.id]),
    [
      ["user", "u1"],
      ["tool", "toolu_edit"],
      ["assistant", "a2:0"],
    ],
  );
  const tool = items[1];
  assert.ok(tool.kind === "tool");
  assert.equal(tool.ts, "2026-10-14T02:11:48.240Z");
  assert.equal(tool.file, `${cwd}/edit_me.txt`);
  assert.deepEqual(tool.patch?.[0].lines, [" line one", "-line two", "+line 2", " line three"]);
});

test("a loaded conversation keeps local command results with their card data", async () => {
  const sid = "7d2e9b14-5c3a-4f81-b6d0-2a9e8c1f4b37";
  const base = { isSidechain: false, userType: "external", cwd, sessionId: sid, version: "2.1.296", gitBranch: "HEAD" };
  const rows = [
    { ...base, parentUuid: null, type: "user", uuid: "c1", timestamp: "2026-10-14T03:00:00.000Z", isMeta: true, message: { role: "user", content: "<local-command-caveat>Caveat</local-command-caveat>" } },
    { ...base, parentUuid: "c1", type: "user", uuid: "c2", timestamp: "2026-10-14T03:00:00.001Z", message: { role: "user", content: "<command-name>/usage</command-name>\n<command-message>usage</command-message>\n<command-args></command-args>" } },
    {
      ...base,
      parentUuid: "c2",
      type: "system",
      subtype: "local_command",
      uuid: "c3",
      timestamp: "2026-10-14T03:00:01.000Z",
      level: "info",
      isMeta: false,
      content: "<local-command-stdout>Current session: 32% used</local-command-stdout>",
      commandRun: { command: "usage", args: "" },
      usageReport: {
        session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 1496, total_lines_added: 0, total_lines_removed: 0, model_usage: [] },
        rate_limits: { limits: [{ kind: "weekly_all", group: "weekly", percent: 91, resets_at: "2026-10-17T12:59:59Z", scope: null, severity: "critical", is_active: true }] },
      },
    },
    { ...base, parentUuid: "c3", type: "user", uuid: "c4", timestamp: "2026-10-14T03:00:02.000Z", message: { role: "user", content: "<command-name>/context</command-name>\n<command-message>context</command-message>\n<command-args></command-args>" } },
    {
      ...base,
      parentUuid: "c4",
      type: "system",
      subtype: "local_command",
      uuid: "c5",
      timestamp: "2026-10-14T03:00:03.000Z",
      level: "info",
      isMeta: false,
      content: "<local-command-stdout>## Context Usage</local-command-stdout>",
      commandRun: { command: "context", args: "" },
      contextUsage: { model: "claude-haiku-5-5", total_tokens: 27623, raw_max_tokens: 1000000, percentage: 3, categories: [{ name: "Messages", tokens: 9777, kind: "used" }], mcp_tools: [], memory_files: [], agents: [] },
    },
  ];
  const dir = path.join(home, ".claude", "projects", projectDirName(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const items = await loadHistory(sid, cwd);
  assert.deepEqual(items, [
    { kind: "note", id: "c2", ts: "2026-10-14T03:00:00.001Z", code: "command", text: "/usage" },
    {
      kind: "command",
      id: "c3",
      ts: "2026-10-14T03:00:01.000Z",
      name: "usage",
      text: "Current session: 32% used",
      usage: {
        limits: [{ kind: "weekly_all", percent: 91, resetsAt: "2026-10-17T12:59:59Z", severity: "critical", active: true }],
        session: { costUsd: 0, durationMs: 1496, apiDurationMs: 0, linesAdded: 0, linesRemoved: 0 },
      },
    },
    { kind: "note", id: "c4", ts: "2026-10-14T03:00:02.000Z", code: "command", text: "/context" },
    {
      kind: "command",
      id: "c5",
      ts: "2026-10-14T03:00:03.000Z",
      name: "context",
      text: "## Context Usage",
      context: { percentage: 3, totalTokens: 27623, maxTokens: 1000000, model: "claude-haiku-5-5", categories: [{ name: "Messages", tokens: 9777, kind: "used" }] },
    },
  ]);
});

test("a message queued during a turn loads where Claude Code took it in, as the live view shows it", async () => {
  const sid = "6d0b2a1e-4f3c-4b8a-9e7d-2c5f1a8b3e90";
  const base = { isSidechain: false, userType: "external", cwd, sessionId: sid, version: "2.1.296", gitBranch: "HEAD" };
  const queued = "16da89e9-61c1-4cad-a567-74aa7b51081e";
  // Rows as Claude Code 2.1.296 wrote them for a message sent while a Bash call ran.
  const rows = [
    { ...base, parentUuid: null, type: "user", uuid: "q1", timestamp: "2026-10-14T12:24:06.494Z", message: { role: "user", content: [{ type: "text", text: "Run sleep 12" }] } },
    {
      ...base,
      parentUuid: "q1",
      type: "assistant",
      uuid: "q2",
      timestamp: "2026-10-14T12:24:08.195Z",
      message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_sleep", name: "Bash", input: { command: "sleep 12" } }] },
    },
    { type: "queue-operation", operation: "enqueue", timestamp: "2026-10-14T12:24:09.793Z", sessionId: sid },
    {
      ...base,
      parentUuid: "q2",
      type: "user",
      uuid: "q3",
      timestamp: "2026-10-14T12:24:20.241Z",
      message: { role: "user", content: [{ tool_use_id: "toolu_sleep", type: "tool_result", content: "first", is_error: false }] },
    },
    {
      ...base,
      parentUuid: "q3",
      type: "attachment",
      uuid: "q4",
      timestamp: "2026-10-14T12:24:09.793Z",
      attachment: {
        type: "queued_command",
        prompt: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
          { type: "text", text: "Also, end your reply with the word banana." },
        ],
        source_uuid: queued,
        delivery_id: "70cbfef1-d235-4b07-9a77-2f9d8bbd37f6",
        commandMode: "prompt",
        origin: { kind: "human" },
        timestamp: "2026-10-14T12:24:09.793Z",
        humanTurn: true,
      },
    },
    {
      type: "queue-operation",
      operation: "remove",
      reason: "absorbed_mid_turn",
      commandUuid: queued,
      deliveryId: "70cbfef1-d235-4b07-9a77-2f9d8bbd37f6",
      timestamp: "2026-10-14T12:24:20.246Z",
      sessionId: sid,
      content: "Also, end your reply with the word banana.",
    },
    {
      ...base,
      parentUuid: "q4",
      type: "assistant",
      uuid: "q5",
      timestamp: "2026-10-14T12:24:22.734Z",
      message: { role: "assistant", content: [{ type: "text", text: "Done, banana." }] },
    },
  ];
  const dir = path.join(home, ".claude", "projects", projectDirName(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const items = await loadHistory(sid, cwd);
  assert.deepEqual(
    items.map((i) => i.id),
    ["q1", "toolu_sleep", queued, "q5:0"],
  );
  const shown = items[2];
  assert.equal(shown.kind, "user");
  assert.equal(shown.kind === "user" && shown.text, "Also, end your reply with the word banana.");
  assert.deepEqual(shown.kind === "user" && shown.attachments, [{ kind: "image", mediaType: "image/png", size: 8 }]);
  assert.equal(shown.ts, "2026-10-14T12:24:09.793Z", "it keeps the time it was sent");
});

test("messages Claude Code passed on load as the live view showed them, never as the user's", async () => {
  const { ItemBuilder } = await import("../src/sessions/items.ts");
  const sid = "4e8a1c27-9b3d-4f60-8a15-7c2e9d0b6f43";
  const base = { isSidechain: false, userType: "external", entrypoint: "sdk-ts", cwd, sessionId: sid, version: "2.1.296", gitBranch: "HEAD" };
  const agent = "ac5f0af9a81a32d8e";
  const src = "80be5f87-e313-4b59-bcc5-346bc007fde8";
  const notice = "[Subagent hand-back] The text below is the final report of a subagent this session delegated to. The report follows:";
  const prompt = `<agent-message from="${agent}">\n${notice}\n  Saved the report.\n  \n  - two files\n</agent-message>`;
  const origin = { kind: "peer", from: agent, senderTaskId: agent, name: "general-purpose", body: `${notice}\n  Saved the report.\n  \n  - two files`, handback: true };
  const peerText =
    'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/peer.sock" from-name="리뷰 세션" from-mode="prompting">\n검토를 마쳤습니다.\n</cross-session-message>\n\nThis came from another Claude session — not typed by your user.';
  const peerOrigin = { kind: "peer", from: "uds:/tmp/peer.sock", verifiedPeerPid: 4242, msg_id: "m1", name: "리뷰 세션", fromMode: "prompting", body: "검토를 마쳤습니다." };
  const taskText =
    '<task-notification>\n<task-id>b7</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<output-file>/tmp/b7.output</output-file>\n<status>completed</status>\n<summary>Background command "npm test" completed (exit code 0)</summary>\n</task-notification>';
  const taskOrigin = { kind: "task-notification", producer: "session-task" };
  const say = (uuid: string, parentUuid: string, timestamp: string, text: string) => ({
    ...base,
    parentUuid,
    type: "assistant",
    uuid,
    timestamp,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
  const agentResult = "  This agent's report was delivered to you as a message from \"ac5f0af9a81a32d8e\" (its SubagentHandback call). Read it there; it is not repeated here.";
  const resultMessage = { role: "user", content: [{ tool_use_id: "toolu_ag", type: "tool_result", content: [{ type: "text", text: agentResult }] }] };
  const resultOutput = { status: "completed", agentId: agent, agentType: "general-purpose", handback: "send", totalToolUseCount: 30, content: [{ type: "text", text: agentResult }] };
  // Rows as Claude Code 2.1.296 writes them when a subagent's report arrives during a turn, another session
  // writes while the session waits, and a background shell ends.
  const rows = [
    { ...base, parentUuid: null, type: "user", uuid: "p1", timestamp: "2026-10-14T13:00:00.000Z", origin: { kind: "human" }, promptId: "pr1", message: { role: "user", content: "Research it" } },
    {
      ...base,
      parentUuid: "p1",
      type: "assistant",
      uuid: "p2",
      timestamp: "2026-10-14T13:00:01.000Z",
      message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_ag", name: "Agent", input: { description: "Research", subagent_type: "general-purpose", prompt: "go", run_in_background: false } }] },
    },
    { type: "queue-operation", operation: "enqueue", timestamp: "2026-10-14T13:42:02.418Z", sessionId: sid, content: prompt },
    {
      ...base,
      parentUuid: "p2",
      type: "user",
      uuid: "p3",
      timestamp: "2026-10-14T13:42:02.439Z",
      promptId: "pr1",
      message: resultMessage,
      toolUseResult: resultOutput,
      sourceToolAssistantUUID: "p2",
    },
    {
      ...base,
      parentUuid: "p3",
      type: "attachment",
      uuid: "p4",
      timestamp: "2026-10-14T13:42:02.418Z",
      attachment: { type: "queued_command", prompt, source_uuid: src, delivery_id: "d0185b25-5327-471d-a674-6c0481d40c58", commandMode: "prompt", origin, timestamp: "2026-10-14T13:42:02.418Z", isMeta: true, reminderId: "d5213b46e88459b1" },
      rendered: [{ content: `<system-reminder id="d5213b46e88459b1">\nAnother Claude session sent a message while you were working:\n${prompt}\n</system-reminder id="d5213b46e88459b1">` }],
      renderedRole: "system",
    },
    {
      ...base,
      parentUuid: "p4",
      type: "attachment",
      uuid: "p5",
      timestamp: "2026-10-14T13:42:02.467Z",
      attachment: { type: "hook_additional_context", content: ["context"], hookName: "UserPromptSubmit", toolUseID: "hook-1", hookEvent: "UserPromptSubmit" },
      rendered: [{ content: "context" }],
      renderedRole: "system",
    },
    { type: "queue-operation", operation: "remove", timestamp: "2026-10-14T13:42:02.473Z", sessionId: sid, content: prompt, reason: "absorbed_mid_turn", commandUuid: src, deliveryId: "d0185b25-5327-471d-a674-6c0481d40c58" },
    say("p6", "p5", "2026-10-14T13:42:05.000Z", "Got the report."),
    { ...base, parentUuid: "p6", type: "user", uuid: "p7", timestamp: "2026-10-14T13:50:00.000Z", isMeta: true, origin: peerOrigin, promptId: "pr2", message: { role: "user", content: peerText } },
    say("p8", "p7", "2026-10-14T13:50:02.000Z", "Noted."),
    { ...base, parentUuid: "p8", type: "user", uuid: "p9", timestamp: "2026-10-14T14:00:00.000Z", origin: taskOrigin, promptId: "pr3", message: { role: "user", content: taskText } },
    say("p10", "p9", "2026-10-14T14:00:02.000Z", "Tests pass."),
  ];
  const dir = path.join(home, ".claude", "projects", projectDirName(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const loaded = await loadHistory(sid, cwd);

  // The same conversation as Claude Code streams it with --replay-user-messages.
  const live = new ItemBuilder(cwd);
  for (const m of [
    { type: "user", uuid: "p1", isReplay: true, timestamp: "2026-10-14T13:00:00.000Z", origin: { kind: "human" }, message: { role: "user", content: "Research it" } },
    { ...rows[1], session_id: sid },
    { type: "user", uuid: "p3", timestamp: "2026-10-14T13:42:02.439Z", message: resultMessage, tool_use_result: resultOutput },
    { type: "user", uuid: src, isReplay: true, isSynthetic: true, timestamp: "2026-10-14T13:42:02.418Z", origin, message: { role: "user", content: prompt } },
    rows[7],
    { type: "user", uuid: "p7", isSynthetic: true, timestamp: "2026-10-14T13:50:00.000Z", origin: peerOrigin, message: { role: "user", content: peerText } },
    rows[9],
    { type: "user", uuid: "p9", timestamp: "2026-10-14T14:00:00.000Z", origin: taskOrigin, message: { role: "user", content: taskText } },
    rows[11],
  ]) {
    live.add(m as Parameters<typeof live.add>[0]);
  }

  assert.deepEqual(
    loaded.map((i) => [i.kind, i.id]),
    [
      ["user", "p1"],
      ["tool", "toolu_ag"],
      ["message", src],
      ["assistant", "p6:0"],
      ["message", "p7"],
      ["assistant", "p8:0"],
      ["task", "p9"],
      ["assistant", "p10:0"],
    ],
  );
  assert.deepEqual(loaded, live.items, "a reload shows what the live view showed");
  assert.deepEqual(loaded[2], { kind: "message", id: src, ts: "2026-10-14T13:42:02.418Z", from: "agent", name: "general-purpose", text: "Saved the report.\n\n- two files" });
  assert.deepEqual(loaded[4], { kind: "message", id: "p7", ts: "2026-10-14T13:50:00.000Z", from: "session", name: "리뷰 세션", text: "검토를 마쳤습니다." });
  assert.deepEqual(loaded[6], { kind: "task", id: "p9", ts: "2026-10-14T14:00:00.000Z", status: "completed", summary: 'Background command "npm test" completed (exit code 0)' });
});

test("a compacted conversation's summary is not shown as the user's message", async () => {
  const sid = "9c3b7e15-2a4d-4e88-b1f0-5d6a8c2e7f19";
  const base = { isSidechain: false, userType: "external", cwd, sessionId: sid, version: "2.1.296", gitBranch: "HEAD" };
  const rows = [
    { ...base, parentUuid: null, logicalParentUuid: "old", type: "system", subtype: "compact_boundary", uuid: "k1", timestamp: "2026-10-14T15:00:00.000Z", content: "Conversation compacted", isMeta: false, level: "info", compactMetadata: { trigger: "manual", preTokens: 1000 } },
    {
      ...base,
      parentUuid: "k1",
      type: "user",
      uuid: "k2",
      timestamp: "2026-10-14T15:00:00.100Z",
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
      message: { role: "user", content: "This session is being continued from a previous conversation that ran out of context." },
    },
    { ...base, parentUuid: "k2", type: "user", uuid: "k3", timestamp: "2026-10-14T15:01:00.000Z", origin: { kind: "human" }, message: { role: "user", content: "Go on" } },
    { ...base, parentUuid: "k3", type: "assistant", uuid: "k4", timestamp: "2026-10-14T15:01:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "On it." }] } },
  ];
  const dir = path.join(home, ".claude", "projects", projectDirName(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const { getSessionMessages } = await import("@anthropic-ai/claude-agent-sdk");
  const read = await getSessionMessages(sid, { includeSystemMessages: true });
  assert.ok(read.some((m) => m.uuid === "k2"), "the reader returns the summary, marked as Claude Code's own");
  const items = await loadHistory(sid, cwd);
  assert.deepEqual(
    items.map((i) => [i.kind, i.id]),
    [
      ["user", "k3"],
      ["assistant", "k4:0"],
    ],
  );
});

test("a reload keeps the transcript ids of a background subagent and a workflow run", async () => {
  const sid = "4f8a2c6e-1b3d-4e5f-9a7b-0c2d4e6f8a1b";
  const base = { isSidechain: false, userType: "external", cwd, sessionId: sid, version: "2.1.296", gitBranch: "HEAD" };
  const rows = [
    { ...base, parentUuid: null, type: "user", uuid: "q1", timestamp: "2026-10-16T05:00:00.000Z", message: { role: "user", content: "Start both" } },
    {
      ...base,
      parentUuid: "q1",
      type: "assistant",
      uuid: "q2",
      timestamp: "2026-10-16T05:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_bg", name: "Agent", input: { description: "Watch", prompt: "go", run_in_background: true } },
          { type: "tool_use", id: "toolu_wf", name: "Workflow", input: { script: "export const meta = { name: 'review' }" } },
        ],
      },
    },
    {
      ...base,
      parentUuid: "q2",
      type: "user",
      uuid: "q3",
      timestamp: "2026-10-16T05:00:02.000Z",
      message: { role: "user", content: [{ tool_use_id: "toolu_bg", type: "tool_result", content: [{ type: "text", text: "Async agent launched successfully." }] }] },
      toolUseResult: { isAsync: true, status: "async_launched", agentId: "aec1e95a753adddd3", description: "Watch", prompt: "go" },
    },
    {
      ...base,
      parentUuid: "q3",
      type: "user",
      uuid: "q4",
      timestamp: "2026-10-16T05:00:03.000Z",
      message: { role: "user", content: [{ tool_use_id: "toolu_wf", type: "tool_result", content: "Workflow launched in background. Task ID: w1" }] },
      toolUseResult: { status: "async_launched", taskId: "w1", runId: "wf_5ef7f2d2-0c4", transcriptDir: "/somewhere/subagents/workflows/wf_5ef7f2d2-0c4" },
    },
  ];
  const dir = path.join(home, ".claude", "projects", projectDirName(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const items = await loadHistory(sid, cwd);
  const sub = (id: string) => items.find((i) => i.id === id && i.kind === "tool") as Extract<(typeof items)[number], { kind: "tool" }>;
  assert.equal(sub("toolu_bg").sub?.agentId, "aec1e95a753adddd3");
  assert.equal(sub("toolu_wf").sub?.runId, "wf_5ef7f2d2-0c4");
});
