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
