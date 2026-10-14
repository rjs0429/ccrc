import { test } from "node:test";
import assert from "node:assert/strict";
import { ItemBuilder, summarizeTool } from "../src/sessions/items.ts";

const cwd = "/work/project";

test("a turn becomes user text, thinking, a tool with its result, and the answer", () => {
  const b = new ItemBuilder(cwd);
  b.add({ type: "user", uuid: "u1", message: { content: "Fix the build" } }, "2026-10-13T00:00:00Z");
  b.add({
    type: "assistant",
    uuid: "a1",
    message: {
      content: [
        { type: "thinking", thinking: "Look at the error first." },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm run build\n# twice", description: "Build" } },
      ],
    },
  });
  b.add({ type: "user", uuid: "u2", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false }] } });
  b.add({ type: "assistant", uuid: "a2", message: { content: [{ type: "text", text: "Fixed." }] } });

  assert.deepEqual(
    b.items.map((i) => [i.kind, i.id]),
    [
      ["user", "u1"],
      ["thinking", "a1:0"],
      ["tool", "t1"],
      ["assistant", "a2:0"],
    ],
  );
  const tool = b.items[2];
  assert.equal(tool.kind === "tool" && tool.summary, "Build");
  assert.deepEqual(tool.kind === "tool" && tool.result, { text: "ok", isError: false, truncated: false });
  assert.equal(b.items[0].ts, "2026-10-13T00:00:00Z");
});

test("editor context and harness wrappers are not shown as user text", () => {
  const b = new ItemBuilder(cwd);
  b.add({
    type: "user",
    uuid: "u1",
    message: {
      content: [
        { type: "text", text: "<ide_opened_file>The user opened a.ts</ide_opened_file>" },
        { type: "text", text: "Explain this file" },
      ],
    },
  });
  b.add({ type: "user", uuid: "u2", message: { content: "<local-command-caveat>Caveat</local-command-caveat>" } });
  b.add({ type: "user", uuid: "u3", message: { content: "<command-name>/model</command-name>\n<command-args>sonnet</command-args>" } });
  b.add({ type: "user", uuid: "u4", message: { content: "<local-command-stdout>Set model to sonnet</local-command-stdout>" } });
  b.add({ type: "user", uuid: "u5", isSynthetic: true, message: { content: "summary of earlier turns" } });
  b.add({ type: "user", uuid: "u6", message: { content: "<task-notification>\n<task-id>x</task-id>\n</task-notification>" } });
  assert.deepEqual(
    b.items.map((i) => (i.kind === "note" ? `${i.code}:${i.text}` : i.kind === "user" || i.kind === "command" ? `${i.kind}:${i.text}` : i.kind)),
    ["user:Explain this file", "command:/model sonnet", "command:Set model to sonnet"],
  );
});

const USAGE_REPORT = {
  session: { total_cost_usd: 0.5, total_api_duration_ms: 0, total_duration_ms: 1496, total_lines_added: 2, total_lines_removed: 0, model_usage: { "claude-haiku-5-5": {} } },
  rate_limits: {
    limits: [
      { kind: "session", group: "session", percent: 32, resets_at: "2026-10-14T05:19:59.650837+00:00", scope: null, severity: "normal", is_active: false },
      { kind: "weekly_all", group: "weekly", percent: 91, resets_at: "2026-10-17T12:59:59.650860+00:00", scope: null, severity: "critical", is_active: true },
      { kind: "weekly_scoped", group: "weekly", percent: 0, resets_at: null, scope: { model: { display_name: "Fable" }, surface: null }, severity: "normal", is_active: false },
      { kind: "broken", percent: "x" },
    ],
    extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 100, utilization: 2, currency: "USD" },
  },
};

const CONTEXT_USAGE = {
  model: "claude-haiku-5-5",
  total_tokens: 27623,
  raw_max_tokens: 1000000,
  percentage: 3,
  categories: [
    { name: "System prompt", tokens: 3180, kind: "used" },
    { name: "System tools (deferred)", tokens: 11198, kind: "deferred" },
    { name: "Free space", tokens: 939377, kind: "free" },
  ],
  mcp_tools: [{ name: "mcp__x__y", server_name: "x", tokens: 10 }],
  memory_files: [{ path: "/home/u/.claude/CLAUDE.md", type: "User", tokens: 2237 }],
  agents: [],
};

const USAGE_ITEM = {
  kind: "command",
  name: "usage",
  text: "Current session: 32% used",
  usage: {
    limits: [
      { kind: "session", percent: 32, resetsAt: "2026-10-14T05:19:59.650837+00:00", severity: "normal" },
      { kind: "weekly_all", percent: 91, resetsAt: "2026-10-17T12:59:59.650860+00:00", severity: "critical", active: true },
      { kind: "weekly_scoped", percent: 0, scope: "Fable", severity: "normal" },
    ],
    session: { costUsd: 0.5, durationMs: 1496, apiDurationMs: 0, linesAdded: 2, linesRemoved: 0 },
  },
};

const CONTEXT_ITEM = {
  kind: "command",
  name: "context",
  text: "## Context Usage",
  context: {
    percentage: 3,
    totalTokens: 27623,
    maxTokens: 1000000,
    model: "claude-haiku-5-5",
    categories: [
      { name: "System prompt", tokens: 3180, kind: "used" },
      { name: "System tools (deferred)", tokens: 11198, kind: "deferred" },
      { name: "Free space", tokens: 939377, kind: "free" },
    ],
  },
};

test("a local command's live result becomes a command item with its card data", () => {
  const b = new ItemBuilder(cwd);
  b.userText("u1", "/usage");
  b.add({
    type: "assistant",
    uuid: "a1",
    message: { content: [{ type: "text", text: "Current session: 32% used" }] },
    local_command_source: "<local-command-stdout>Current session: 32% used</local-command-stdout>",
    local_command_run: { command: "usage", args: "" },
    usage_report: USAGE_REPORT,
  });
  b.add({ type: "user", uuid: "u1", message: { content: "<command-name>/usage</command-name>\n<command-message>usage</command-message>\n<command-args></command-args>" } });
  b.add({
    type: "assistant",
    uuid: "a2",
    message: { content: [{ type: "text", text: "## Context Usage" }] },
    local_command_source: "<local-command-stdout>## Context Usage</local-command-stdout>",
    local_command_run: { command: "context", args: "" },
    context_usage: CONTEXT_USAGE,
  });
  b.add({ type: "assistant", uuid: "a3", message: { content: [{ type: "text", text: "Set model to sonnet" }] }, local_command_run: { command: "model", args: " sonnet " } });
  assert.deepEqual(
    b.items.map(({ ts: _ts, ...i }) => i),
    [
      { kind: "note", id: "u1", code: "command", text: "/usage" },
      { id: "a1", ...USAGE_ITEM },
      { id: "a2", ...CONTEXT_ITEM },
      { kind: "command", id: "a3", name: "model", args: "sonnet", text: "Set model to sonnet" },
    ],
  );
});

test("a transcript's local command row and live command output become command items", () => {
  const b = new ItemBuilder(cwd);
  b.add({ type: "system", subtype: "local_command", uuid: "s1", content: "<local-command-stdout>Current session: 32% used</local-command-stdout>", local_command_run: { command: "usage", args: "" }, usage_report: USAGE_REPORT });
  b.add({ type: "system", subtype: "local_command", uuid: "s2", content: "<local-command-stdout></local-command-stdout>", local_command_run: { command: "model", args: "" } });
  b.add({ type: "system", subtype: "local_command_output", uuid: "s3", content: "Voice mode on" });
  assert.deepEqual(
    b.items.map(({ ts: _ts, ...i }) => i),
    [
      { id: "s1", ...USAGE_ITEM },
      { kind: "command", id: "s3", text: "Voice mode on" },
    ],
  );
});

test("an interruption is noted once", () => {
  const b = new ItemBuilder(cwd);
  b.add({ type: "user", uuid: "u1", message: { content: "[Request interrupted by user]" } });
  b.add({ type: "result", subtype: "error_during_execution", is_error: true });
  assert.deepEqual(
    b.items.map((i) => i.kind === "note" && i.code),
    ["interrupted"],
  );
});

test("subagent messages stay out of the main conversation", () => {
  const b = new ItemBuilder(cwd);
  b.add({ type: "assistant", uuid: "a1", parent_tool_use_id: "task-1", message: { content: [{ type: "text", text: "inner" }] } });
  assert.equal(b.items.length, 0);
});

test("a replayed message replaces the local copy with the same id", () => {
  const b = new ItemBuilder(cwd);
  b.userText("u1", "hello", "2026-10-13T00:00:00Z");
  b.add({ type: "user", uuid: "u1", timestamp: "2026-10-13T00:00:01Z", message: { content: [{ type: "text", text: "hello" }] } });
  assert.equal(b.items.length, 1);
  assert.equal(b.items[0].ts, "2026-10-13T00:00:01Z");
});

test("tool summaries name the target", () => {
  assert.equal(summarizeTool("Edit", { file_path: "/work/project/src/a.ts" }, cwd), "src/a.ts");
  assert.equal(summarizeTool("Grep", { pattern: "TODO", path: "/work/project/src" }, cwd), "TODO · src");
  assert.equal(summarizeTool("AskUserQuestion", { questions: [{ question: "Which one?" }] }, cwd), "Which one?");
  assert.equal(summarizeTool("mcp__x__y", { q: "first\nsecond" }, cwd), "first");
});

// An Edit call and its result as Claude Code 2.1.296 reports them.
const EDIT_USE = {
  type: "assistant",
  uuid: "a1",
  message: {
    content: [
      { type: "tool_use", id: "toolu_edit", name: "Edit", input: { file_path: `${cwd}/edit_me.txt`, old_string: "line two", new_string: "line 2" } },
    ],
  },
};
const EDIT_OUTPUT = {
  filePath: `${cwd}/edit_me.txt`,
  oldString: "line two",
  newString: "line 2",
  originalFile: "line one\nline two\nline three\n",
  structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" line one", "-line two", "+line 2", " line three"] }],
  userModified: false,
  replaceAll: false,
};
const EDIT_RESULT = {
  type: "user",
  uuid: "u2",
  message: { content: [{ type: "tool_result", tool_use_id: "toolu_edit", content: "The file has been updated successfully." }] },
};

function toolItem(b: ItemBuilder, id: string) {
  const item = b.items.find((i) => i.id === id);
  assert.ok(item?.kind === "tool", `tool item ${id}`);
  return item;
}

test("an edit takes its file and patch from the live tool_use_result", () => {
  const b = new ItemBuilder(cwd);
  b.add(EDIT_USE);
  const [item] = b.add({ ...EDIT_RESULT, tool_use_result: EDIT_OUTPUT });
  assert.equal(item.id, "toolu_edit");
  const tool = toolItem(b, "toolu_edit");
  assert.equal(tool.file, `${cwd}/edit_me.txt`);
  assert.deepEqual(tool.patch, EDIT_OUTPUT.structuredPatch);
  assert.equal(tool.patchCut, undefined);
  assert.equal(b.items.length, 1);
});

test("a transcript row's toolUseResult gives the same patch", () => {
  const live = new ItemBuilder(cwd);
  live.add(EDIT_USE);
  live.add({ ...EDIT_RESULT, tool_use_result: EDIT_OUTPUT });
  const loaded = new ItemBuilder(cwd);
  loaded.add(EDIT_USE);
  loaded.add({ ...EDIT_RESULT, toolUseResult: EDIT_OUTPUT });
  assert.deepEqual(loaded.items, live.items);
});

test("a failed or held edit has no patch", () => {
  const b = new ItemBuilder(cwd);
  b.add(EDIT_USE);
  const failed = { ...EDIT_RESULT, message: { content: [{ ...EDIT_RESULT.message.content[0], is_error: true }] } };
  b.add({ ...failed, tool_use_result: "Error: String to replace not found in file." });
  assert.equal(toolItem(b, "toolu_edit").patch, undefined);
  b.add({ ...EDIT_RESULT, tool_use_result: { ...EDIT_OUTPUT, staged: true } });
  assert.equal(toolItem(b, "toolu_edit").patch, undefined);
});

test("a newly written file becomes one added hunk", () => {
  const b = new ItemBuilder(cwd);
  const input = { file_path: `${cwd}/new.md`, content: "# Title\n\nBody\n" };
  b.add({ type: "assistant", uuid: "a1", message: { content: [{ type: "tool_use", id: "toolu_w", name: "Write", input }] } });
  b.add({
    type: "user",
    uuid: "u2",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_w", content: "File created successfully" }] },
    toolUseResult: { type: "create", filePath: `${cwd}/new.md`, content: "# Title\n\nBody\n", structuredPatch: [], originalFile: null },
  });
  const tool = toolItem(b, "toolu_w");
  assert.equal(tool.file, `${cwd}/new.md`);
  assert.deepEqual(tool.patch, [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3, lines: ["+# Title", "+", "+Body"] }]);
});

test("a long patch keeps its first lines, clips long ones, and counts what it left out", () => {
  const b = new ItemBuilder(cwd);
  const first = Array.from({ length: 700 }, (_, n) => `+line ${n}`);
  const second = [`+${"x".repeat(2000)}`, ...Array.from({ length: 199 }, (_, n) => `+more ${n}`)];
  const third = ["-gone", "+here"];
  b.add({
    type: "user",
    uuid: "u1",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_big", content: "ok" }] },
    tool_use_result: {
      type: "update",
      filePath: `${cwd}/big.txt`,
      structuredPatch: [
        { oldStart: 1, oldLines: 0, newStart: 1, newLines: 700, lines: first },
        { oldStart: 10, oldLines: 0, newStart: 710, newLines: 200, lines: second },
        { oldStart: 50, oldLines: 1, newStart: 950, newLines: 1, lines: third },
      ],
    },
  });
  const tool = toolItem(b, "toolu_big");
  assert.equal(tool.patch?.length, 2);
  assert.equal(tool.patch?.reduce((n, h) => n + h.lines.length, 0), 800);
  assert.deepEqual(tool.patch?.[1].lines.slice(1, 2), ["+more 0"]);
  assert.equal(tool.patch?.[1].newLines, 200, "hunk headers keep their full counts");
  assert.ok(tool.patch![1].lines[0].length < 600 && tool.patch![1].lines[0].endsWith("…"));
  assert.equal(tool.patchCut, 102);
});

test("attached documents are listed by name on the user item", () => {
  const b = new ItemBuilder(cwd);
  b.add({
    type: "user",
    uuid: "u1",
    message: {
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "" } },
        { type: "document", title: "notes.txt", source: { type: "text", media_type: "text/plain", data: "hi" } },
        { type: "text", text: "Look at these" },
      ],
    },
  });
  const pdf = { type: "document", title: "spec.pdf", source: { type: "base64", media_type: "application/pdf", data: "" } };
  b.add({ type: "user", uuid: "u2", message: { content: [pdf] } });
  assert.deepEqual(
    b.items.map((i) => i.kind === "user" && [i.text, i.images, i.files]),
    [
      ["Look at these", 1, ["notes.txt"]],
      ["", undefined, ["spec.pdf"]],
    ],
  );
});

function agentTurn(b: ItemBuilder) {
  b.add({ type: "user", uuid: "u1", message: { content: "Survey the repo" } });
  b.add({
    type: "assistant",
    uuid: "a1",
    message: {
      content: [{ type: "tool_use", id: "toolu_agent", name: "Agent", input: { description: "Survey files", prompt: "List the files", subagent_type: "Explore" } }],
    },
  });
}

const subTool = (id: string, name: string, input: unknown) => ({
  type: "assistant",
  uuid: `s-${id}`,
  parent_tool_use_id: "toolu_agent",
  message: { content: [{ type: "tool_use", id, name, input }] },
});

test("a subagent's work folds into the Agent call that started it", () => {
  const b = new ItemBuilder(cwd);
  agentTurn(b);
  const before = b.items.map((i) => i.id);
  for (let n = 1; n <= 7; n++) {
    const [parent] = b.add(subTool(`toolu_s${n}`, "Read", { file_path: `${cwd}/src/f${n}.ts` }));
    assert.equal(parent.id, "toolu_agent", "the updated Agent item is returned for live clients");
    b.add({
      type: "user",
      uuid: `r-${n}`,
      parent_tool_use_id: "toolu_agent",
      message: { content: [{ type: "tool_result", tool_use_id: `toolu_s${n}`, content: "..." }] },
      tool_use_result: { type: "text", file: { filePath: `${cwd}/src/f${n}.ts` } },
    });
  }
  const long = `Found ${"many ".repeat(80)}files`;
  const [withText] = b.add({ type: "assistant", uuid: "s-text", parent_tool_use_id: "toolu_agent", message: { content: [{ type: "text", text: long }] } });
  assert.deepEqual(
    b.items.map((i) => i.id),
    before,
    "subagent messages make no top-level items",
  );
  const sub = toolItem(b, "toolu_agent").sub;
  assert.equal(withText.kind === "tool" && withText.sub, sub);
  assert.equal(sub?.tools, 7);
  assert.deepEqual(
    sub?.recent.map((r) => `${r.name} ${r.summary}`),
    ["Read src/f3.ts", "Read src/f4.ts", "Read src/f5.ts", "Read src/f6.ts", "Read src/f7.ts"],
  );
  assert.equal(sub?.text?.length, 201);
  assert.ok(sub?.text?.startsWith("Found many") && sub.text.endsWith("…"));
});

test("a nested subagent counts toward the outer call and a repeated call is counted once", () => {
  const b = new ItemBuilder(cwd);
  agentTurn(b);
  b.add(subTool("toolu_inner", "Agent", { description: "Look deeper" }));
  b.add({ ...subTool("toolu_deep", "Grep", { pattern: "TODO" }), parent_tool_use_id: "toolu_inner" });
  b.add({ ...subTool("toolu_deep", "Grep", { pattern: "TODO" }), parent_tool_use_id: "toolu_inner" });
  assert.equal(b.add({ ...subTool("toolu_x", "Read", {}), parent_tool_use_id: "toolu_unknown" }).length, 0);
  const sub = toolItem(b, "toolu_agent").sub;
  assert.equal(sub?.tools, 2);
  assert.deepEqual(
    sub?.recent.map((r) => r.name),
    ["Agent", "Grep"],
  );
  assert.equal(b.items.length, 2);
});

test("seeing a tool call again keeps what its result and subagent added", () => {
  const b = new ItemBuilder(cwd);
  b.add(EDIT_USE);
  b.add({ ...EDIT_RESULT, tool_use_result: EDIT_OUTPUT });
  b.add({ ...EDIT_USE, timestamp: "2026-10-14T02:11:48.240Z" });
  const edit = toolItem(b, "toolu_edit");
  assert.equal(edit.ts, "2026-10-14T02:11:48.240Z");
  assert.ok(edit.result && edit.patch && edit.file);
  agentTurn(b);
  b.add(subTool("toolu_s1", "Bash", { command: "ls", description: "List files" }));
  agentTurn(b);
  assert.deepEqual(toolItem(b, "toolu_agent").sub, { tools: 1, recent: [{ name: "Bash", summary: "List files" }] });
});

test("task events and the final result raise the subagent's tool count", () => {
  const b = new ItemBuilder(cwd);
  agentTurn(b);
  b.add(subTool("toolu_s1", "Read", { file_path: `${cwd}/a.ts` }));
  const [progress] = b.add({ type: "system", subtype: "task_progress", tool_use_id: "toolu_agent", usage: { tool_uses: 4 } });
  assert.equal(progress.kind === "tool" && progress.sub?.tools, 4);
  assert.equal(b.add({ type: "system", subtype: "task_progress", tool_use_id: "toolu_agent", usage: { tool_uses: 3 } }).length, 0);
  b.add({
    type: "user",
    uuid: "u2",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_agent", content: [{ type: "text", text: "Done." }] }] },
    tool_use_result: { status: "completed", agentId: "a1", totalToolUseCount: 9, content: [{ type: "text", text: "Done." }] },
  });
  const tool = toolItem(b, "toolu_agent");
  assert.equal(tool.sub?.tools, 9);
  assert.deepEqual(
    tool.sub?.recent.map((r) => r.summary),
    ["a.ts"],
  );
  assert.equal(tool.result?.text, "Done.");
});

test("a background subagent's end notice in the transcript gives its tool count and answer", () => {
  const b = new ItemBuilder(cwd);
  agentTurn(b);
  b.add({
    type: "user",
    uuid: "u2",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_agent", content: [{ type: "text", text: "Async agent launched successfully." }] }] },
    toolUseResult: { isAsync: true, status: "async_launched", agentId: "a1" },
  });
  const notice = (body: string) => ({ type: "user", uuid: "u3", message: { content: `<task-notification>\n<task-id>a1</task-id>\n${body}\n</task-notification>` } });
  const [item] = b.add(
    notice(
      "<tool-use-id>toolu_agent</tool-use-id>\n<status>completed</status>\n<result>Three files:\na.ts</result>\n<usage><subagent_tokens>17723</subagent_tokens><tool_uses>2</tool_uses><duration_ms>7813</duration_ms></usage>",
    ),
  );
  assert.deepEqual(item.kind === "tool" && item.sub, { tools: 2, recent: [], text: "Three files:\na.ts" });
  assert.deepEqual(
    b.items.map((i) => i.kind),
    ["user", "tool"],
  );
  assert.equal(b.add(notice("<tool-use-id>toolu_agent</tool-use-id>\n<status>killed</status>")).length, 0, "a notice without usage changes nothing");
  assert.equal(b.add(notice("<tool-use-id>toolu_other</tool-use-id>\n<usage><tool_uses>5</tool_uses></usage>")).length, 0);
  assert.equal(toolItem(b, "toolu_agent").sub?.tools, 2);
});

test("task tool summaries name the task", () => {
  assert.equal(summarizeTool("TaskCreate", { subject: "Run tests", description: "All of them" }, cwd), "Run tests");
  assert.equal(summarizeTool("TaskUpdate", { taskId: "2", status: "completed" }, cwd), "#2 completed");
});
