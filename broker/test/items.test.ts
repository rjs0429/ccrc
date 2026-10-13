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
  assert.deepEqual(
    b.items.map((i) => (i.kind === "note" ? `${i.code}:${i.text}` : i.kind === "user" ? `user:${i.text}` : i.kind)),
    ["user:Explain this file", "command:/model sonnet", "command_output:Set model to sonnet"],
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
