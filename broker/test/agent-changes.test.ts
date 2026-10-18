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

const { projectDirName } = await import("../src/sessions/history.ts");
const { agentChanges } = await import("../src/sessions/subagents.ts");
const { fileChange } = await import("../src/sessions/items.ts");

const SID = "6e3c9d2f-8a4b-4f7c-8d1e-2b3c4d5e6f70";
const cwd = path.join(home, "ws");
const project = path.join(home, ".claude", "projects", projectDirName(cwd));
const subagents = path.join(project, SID, "subagents");

type Row = Record<string, unknown>;

const at = (n: number) => new Date(Date.UTC(2026, 9, 18, 3, 0, n)).toISOString();
const call = (n: number, id: string, name: string, input: Row): Row => ({
  type: "assistant",
  uuid: `c${n}`,
  timestamp: at(n),
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
});
const result = (n: number, id: string, output: unknown): Row => ({
  type: "user",
  uuid: `r${n}`,
  timestamp: at(n),
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "done" }] },
  toolUseResult: output,
});
const edit = (file: string, before: string, after: string) => ({
  filePath: file,
  oldString: before,
  newString: after,
  structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: [`-${before}`, `+${after}`] }],
});

function write(file: string, rows: Row[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify({ isSidechain: true, sessionId: SID, cwd, ...r })).join("\n") + "\n");
}

function setup(): void {
  write(path.join(project, `${SID}.jsonl`), [{ type: "user", uuid: "m1", timestamp: at(0), message: { role: "user", content: "Fix the parser" } }]);
  write(path.join(subagents, "agent-a1.jsonl"), [
    { type: "user", uuid: "p1", timestamp: at(1), message: { role: "user", content: "Fix it" } },
    call(2, "toolu_e1", "Edit", { file_path: `${cwd}/src/parse.ts` }),
    result(3, "toolu_e1", edit(`${cwd}/src/parse.ts`, "let x = 1;", "let x = 2;")),
    call(4, "toolu_r1", "Read", { file_path: `${cwd}/src/parse.ts` }),
    result(5, "toolu_r1", { type: "text", file: { filePath: `${cwd}/src/parse.ts`, content: "..." } }),
    call(6, "toolu_w1", "Write", { file_path: `${cwd}/NOTES.md` }),
    result(7, "toolu_w1", { type: "create", filePath: `${cwd}/NOTES.md`, content: "# Notes\nfixed\n", structuredPatch: [] }),
    call(8, "toolu_bad", "Edit", { file_path: `${cwd}/x.ts` }),
    result(9, "toolu_bad", "Error: String to replace not found"),
  ]);
  fs.writeFileSync(path.join(subagents, "agent-a1.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "Fix the parser" }));
  const run = path.join(subagents, "workflows", "wf_run-1");
  write(path.join(run, "agent-aw1.jsonl"), [
    call(10, "toolu_nb", "NotebookEdit", { notebook_path: `${cwd}/a.ipynb` }),
    result(11, "toolu_nb", { notebook_path: `${cwd}/a.ipynb`, new_source: "x = 2\nprint(x)", old_source: "x = 1\nprint(x)", cell_id: "c1", cell_type: "code", language: "python", edit_mode: "replace", original_file: "{}", updated_file: "{}" }),
  ]);
  fs.writeFileSync(path.join(run, "agent-aw1.meta.json"), JSON.stringify({ agentType: "workflow-subagent" }));
  fs.writeFileSync(path.join(subagents, "agent-..evil.jsonl"), "");
}
setup();

test("the subagents' file changes come from their transcripts, oldest first, with what each subagent is for", async () => {
  const list = await agentChanges(SID, cwd);
  assert.deepEqual(
    list.map((c) => [c.id, c.agentId, c.agent, c.name, c.file]),
    [
      ["toolu_e1", "a1", "Fix the parser", "Edit", `${cwd}/src/parse.ts`],
      ["toolu_w1", "a1", "Fix the parser", "Write", `${cwd}/NOTES.md`],
      ["toolu_nb", "aw1", "workflow-subagent", "NotebookEdit", `${cwd}/a.ipynb`],
    ],
  );
  assert.equal(list[0].ts, at(3));
  assert.deepEqual(list[0].patch, [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ["-let x = 1;", "+let x = 2;"] }]);
  assert.deepEqual(list[1].patch, [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ["+# Notes", "+fixed"] }]);
  assert.deepEqual(list[2].patch, [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ["-x = 1", "+x = 2", " print(x)"] }]);
});

test("a transcript is read again only once it changed", async () => {
  const file = path.join(subagents, "agent-a1.jsonl");
  const first = await agentChanges(SID, cwd);
  fs.appendFileSync(file, JSON.stringify(call(20, "toolu_e2", "Edit", { file_path: `${cwd}/b.ts` })) + "\n" + JSON.stringify(result(21, "toolu_e2", edit(`${cwd}/b.ts`, "a", "b"))) + "\n");
  const second = await agentChanges(SID, cwd);
  assert.equal(second.length, first.length + 1);
  assert.equal(second.at(-1)?.id, "toolu_e2");
});

test("a session without subagents has no changes from them", async () => {
  assert.deepEqual(await agentChanges("7f4d0e3a-9b5c-4a8d-9e2f-3c4d5e6f7a81", cwd), []);
});

test("a notebook edit shows as the cell's change only when Claude Code reported the cell as it was", () => {
  const base = { notebook_path: "/w/a.ipynb", cell_type: "code", language: "python", original_file: "{}", updated_file: "{}" };
  assert.deepEqual(fileChange({ ...base, new_source: "y", cell_id: "c1", edit_mode: "insert" }).patch, [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ["+y"] }]);
  assert.deepEqual(fileChange({ ...base, new_source: "", old_source: "z", cell_id: "c1", edit_mode: "delete" }).patch, [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ["-z"] }]);
  assert.deepEqual(fileChange({ ...base, new_source: "y", cell_id: "c1", edit_mode: "replace" }), {}, "without the old source nothing shows");
  assert.deepEqual(fileChange({ ...base, new_source: "same", old_source: "same", edit_mode: "replace" }), {}, "nothing changed");
  assert.deepEqual(fileChange({ ...base, new_source: "y", old_source: "x", error: "Cell not found" }), {});
});
