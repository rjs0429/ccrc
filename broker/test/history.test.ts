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
