import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { DisplayItem } from "../src/protocol.ts";

// Transcripts are read from ~/.claude, so the test runs against an empty home of its own.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccrc-home-"));
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
after(() => fs.rmSync(home, { recursive: true, force: true }));

const { projectDirName } = await import("../src/sessions/history.ts");
const { agentItem, agentTranscript, workflowAgents } = await import("../src/sessions/subagents.ts");

const SID = "5d2b8c1e-7f3a-4e6b-9c0d-1a2b3c4d5e6f";
const cwd = path.join(home, "ws");
const project = path.join(home, ".claude", "projects", projectDirName(cwd));
const subagents = path.join(project, SID, "subagents");

type Row = Record<string, unknown>;

// Rows in the shape Claude Code 2.1.296 writes a subagent's transcript, each after the one before unless it names
// its parent.
function rows(agentId: string, list: Row[]): Row[] {
  const base = { isSidechain: true, agentId, userType: "external", cwd, sessionId: SID, version: "2.1.296", gitBranch: "HEAD" };
  let parent: unknown = null;
  return list.map((r, n) => {
    const row: Row = { ...base, parentUuid: parent, timestamp: new Date(Date.UTC(2026, 9, 16, 3, 0, n)).toISOString(), ...r };
    parent = row.uuid;
    return row;
  });
}

const prompt = (uuid: string, text: string): Row => ({ type: "user", uuid, promptId: "p", message: { role: "user", content: text } });
const say = (uuid: string, text: string): Row => ({ type: "assistant", uuid, message: { role: "assistant", content: [{ type: "text", text }] } });
const call = (uuid: string, id: string, name: string, input: Row): Row => ({ type: "assistant", uuid, message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
const result = (uuid: string, id: string, text: string, extra: Row = {}): Row => ({
  type: "user",
  uuid,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] },
  ...extra,
});

function write(file: string, list: Row[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, list.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function setup(): void {
  write(path.join(project, `${SID}.jsonl`), [{ type: "user", uuid: "m1", parentUuid: null, sessionId: SID, cwd, timestamp: "2026-10-16T03:00:00.000Z", message: { role: "user", content: "Look around" } }]);
  // Two calls made side by side: the first one's result hangs off the chain on a branch of its own.
  const a1 = rows("a1", [
    prompt("s1", "Find where the config is read"),
    { type: "attachment", uuid: "s2", attachment: { type: "skill_listing" } },
    say("s3", "Looking."),
    call("s4", "toolu_read", "Read", { file_path: `${cwd}/src/config.ts` }),
    call("s5", "toolu_grep", "Grep", { pattern: "loadConfig" }),
    result("s7", "toolu_grep", "src/a.ts"),
    call("s8", "toolu_nested", "Agent", { description: "Check the fixtures", prompt: "go", subagent_type: "Explore" }),
    result("s9", "toolu_nested", "Fixtures are fine.", { toolUseResult: { status: "completed", agentId: "anest", totalToolUseCount: 3 } }),
    say("s10", "Config is read in two places."),
  ]);
  a1.splice(5, 0, { ...rows("a1", [result("s6", "toolu_read", "export const config = {}")])[0], parentUuid: "s4" });
  write(path.join(subagents, "agent-a1.jsonl"), a1);
  fs.writeFileSync(path.join(subagents, "agent-a1.meta.json"), JSON.stringify({ agentType: "Explore", description: "Find config readers", toolUseId: "toolu_a1", spawnDepth: 1 }));
  write(path.join(subagents, "agent-anest.jsonl"), rows("anest", [prompt("n1", "go"), say("n2", "Fine.")]));
  fs.writeFileSync(path.join(subagents, "agent-anest.meta.json"), JSON.stringify({ agentType: "Explore", toolUseId: "toolu_nested", spawnDepth: 2 }));
  const run = path.join(subagents, "workflows", "wf_run-1");
  write(path.join(run, "agent-aw1.jsonl"), rows("aw1", [prompt("w1", "Review the parser"), say("w2", "Reviewed.")]));
  fs.writeFileSync(path.join(run, "agent-aw1.meta.json"), JSON.stringify({ agentType: "workflow-subagent", description: "parser review", workflowPhase: "review" }));
  fs.writeFileSync(path.join(run, "agent-aw0.meta.json"), JSON.stringify({ agentType: "workflow-subagent", spawnDepth: 1 }));
  fs.writeFileSync(path.join(run, "agent-aw4.meta.json"), JSON.stringify({ agentType: "workflow-subagent", description: "late check" }));
  fs.writeFileSync(
    path.join(run, "journal.jsonl"),
    [
      { type: "launched" },
      { type: "started", key: "k0", agentId: "aw0" },
      { type: "started", key: "k1", agentId: "aw1", label: "parser review", phase: "review" },
      { type: "started", key: "k2", agentId: "aw2", label: "lexer review", phase: "review" },
      { type: "result", key: "k1", agentId: "aw1", result: "ok" },
      { type: "failed", key: "k2", agentId: "aw2" },
      { type: "started", key: "k3", agentId: "aw3", label: "join", phase: "join" },
      { type: "result", key: "k0", agentId: "aw0", result: "ok" },
      { type: "started", key: "k4", agentId: "aw4" },
      { type: "started", key: "k5", agentId: "../escape", label: "bad" },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\nnot json\n",
  );
  write(path.join(subagents, "agent-abig.jsonl"), rows("abig", [prompt("b0", "Count"), ...Array.from({ length: 300 }, (_, n) => say(`b${n + 1}`, `step ${n + 1}`))]));
}
setup();

const kinds = (items: DisplayItem[]) => items.map((i) => [i.kind, i.id]);

test("a subagent's transcript reads as a conversation of its own, with the results of calls made side by side", async () => {
  const r = await agentTranscript(SID, cwd, { agentId: "a1" });
  assert.deepEqual(kinds(r.items), [
    ["user", "s1"],
    ["assistant", "s3:0"],
    ["tool", "toolu_read"],
    ["tool", "toolu_grep"],
    ["tool", "toolu_nested"],
    ["assistant", "s10:0"],
  ]);
  assert.equal(r.from, 0);
  assert.equal(r.total, 6);
  assert.equal(r.promptId, "s1");
  assert.equal(r.agentType, "Explore");
  assert.equal(r.description, "Find config readers");
  const tool = (id: string) => r.items.find((i): i is Extract<DisplayItem, { kind: "tool" }> => i.kind === "tool" && i.id === id)!;
  assert.equal(tool("toolu_read").result?.text, "export const config = {}", "the result off the chain is found by its call");
  assert.equal(tool("toolu_read").summary, "src/config.ts");
  assert.equal(tool("toolu_grep").result?.text, "src/a.ts");
  assert.deepEqual(tool("toolu_nested").sub, { tools: 3, recent: [], agentId: "anest" }, "a nested agent's call names its transcript");
  assert.equal(r.items[0].ts, "2026-10-16T03:00:00.000Z");
});

test("calls made side by side show in the order written while the transcript grows and once it is done", async () => {
  const file = path.join(subagents, "agent-apar.jsonl");
  // As Claude Code writes them: each call after the one before, each result hanging off its own call, and the
  // conversation going on from the result written last.
  const all = rows("apar", [
    prompt("p0", "Check both"),
    say("p1", "Running two commands."),
    call("p2", "toolu_quick", "Bash", { command: "ls" }),
    call("p3", "toolu_slow", "Bash", { command: "make" }),
    result("p4", "toolu_quick", "a b c", { parentUuid: "p2" }),
    result("p5", "toolu_slow", "built", { parentUuid: "p3" }),
    say("p6", "Both done. Two more."),
    call("p7", "toolu_first", "Bash", { command: "git status" }),
    call("p8", "toolu_second", "Bash", { command: "git log -1" }),
    result("p9", "toolu_second", "commit 1", { parentUuid: "p8" }),
    result("p10", "toolu_first", "clean", { parentUuid: "p7" }),
    say("p11", "All checked."),
  ]);
  const tools = (items: DisplayItem[]) => items.flatMap((i) => (i.kind === "tool" ? [`${i.id}${i.result ? "+" : ""}`] : []));
  const grow = (n: number, at: string) => {
    write(file, all.slice(0, n));
    fs.utimesSync(file, new Date(at), new Date(at));
  };
  grow(4, "2026-10-16T05:00:00Z");
  const held = await agentTranscript(SID, cwd, { agentId: "apar" });
  assert.deepEqual(tools(held.items), ["toolu_quick", "toolu_slow"]);
  grow(5, "2026-10-16T05:00:01Z");
  const running = await agentTranscript(SID, cwd, { agentId: "apar" });
  assert.equal(running.total, 4, "the quick result written last leaves the slow call in place");
  assert.deepEqual(tools(running.items), ["toolu_quick+", "toolu_slow"]);
  const next = await agentTranscript(SID, cwd, { agentId: "apar", after: { count: 4, lastId: "toolu_slow", open: ["toolu_quick", "toolu_slow"] } });
  assert.equal(next.reset, undefined);
  assert.deepEqual([next.items, tools(next.changed ?? [])], [[], ["toolu_quick+"]]);
  grow(all.length, "2026-10-16T05:00:02Z");
  const done = await agentTranscript(SID, cwd, { agentId: "apar" });
  assert.deepEqual(kinds(done.items), [
    ["user", "p0"],
    ["assistant", "p1:0"],
    ["tool", "toolu_quick"],
    ["tool", "toolu_slow"],
    ["assistant", "p6:0"],
    ["tool", "toolu_first"],
    ["tool", "toolu_second"],
    ["assistant", "p11:0"],
  ]);
  assert.deepEqual(tools(done.items), ["toolu_quick+", "toolu_slow+", "toolu_first+", "toolu_second+"], "a call off the chain shows with its result");
});

test("what the main agent sends a running subagent shows as a message to it", async () => {
  write(
    path.join(subagents, "agent-aask.jsonl"),
    rows("aask", [
      prompt("q0", "Write the report"),
      say("q1", "Writing."),
      { type: "attachment", uuid: "q2", attachment: { type: "queued_command", prompt: "Add a section on hooks", source_uuid: "q-sent", origin: { kind: "coordinator" }, isMeta: true } },
      say("q3", "Adding the hooks section."),
    ]),
  );
  const r = await agentTranscript(SID, cwd, { agentId: "aask" });
  assert.deepEqual(kinds(r.items), [
    ["user", "q0"],
    ["assistant", "q1:0"],
    ["user", "q-sent"],
    ["assistant", "q3:0"],
  ]);
  assert.equal(r.items[2].kind === "user" && r.items[2].text, "Add a section on hooks");
  assert.equal(r.promptId, "q0");
});

test("an Agent call finds its subagent's transcript by the call when its id is not known, and a workflow agent in its run's folder", async () => {
  const r = await agentTranscript(SID, cwd, { toolUseId: "toolu_nested" });
  assert.equal(r.agentId, "anest");
  assert.deepEqual(kinds(r.items), [
    ["user", "n1"],
    ["assistant", "n2:0"],
  ]);
  assert.deepEqual(await agentTranscript(SID, cwd, { toolUseId: "toolu_unknown" }), { agentId: "", items: [], from: 0, total: 0, missing: true });
  const w = await agentTranscript(SID, cwd, { agentId: "aw1" });
  assert.equal(w.description, "parser review");
  assert.equal(w.items.length, 2);
  assert.deepEqual(await agentTranscript(SID, cwd, { agentId: "a404" }), { agentId: "a404", items: [], from: 0, total: 0, missing: true });
  assert.deepEqual(await agentTranscript("6e3c9d2f-8a4b-4f7c-8d1e-2b3c4d5e6f70", cwd, { agentId: "a1" }), { agentId: "a1", items: [], from: 0, total: 0, missing: true });
});

test("only ids are taken and nothing outside the session's subagents folder is read", async () => {
  for (const args of [{}, { agentId: "../a1" }, { agentId: "a".repeat(129) }, { agentId: "a/1" }, { toolUseId: "toolu x" }, { agentId: 7 }, { agentId: "a1", before: -1 }, { agentId: "a1", after: { count: 1 } }]) {
    await assert.rejects(agentTranscript(SID, cwd, args), /invalid request/, JSON.stringify(args));
  }
  const outside = path.join(home, "secret.jsonl");
  write(outside, rows("aleak", [prompt("x1", "secret")]));
  fs.symlinkSync(outside, path.join(subagents, "agent-aleak.jsonl"));
  fs.mkdirSync(path.join(home, "elsewhere"));
  write(path.join(home, "elsewhere", "agent-afar.jsonl"), rows("afar", [prompt("x2", "far")]));
  fs.symlinkSync(path.join(home, "elsewhere"), path.join(subagents, "linked"));
  assert.equal((await agentTranscript(SID, cwd, { agentId: "aleak" })).missing, true, "a linked file is not read");
  assert.equal((await agentTranscript(SID, cwd, { agentId: "afar" })).missing, true, "a linked folder is not entered");
  await assert.rejects(workflowAgents(SID, cwd, "../wf_run-1"), /invalid request/);
});

test("a long transcript comes a page at a time, latest first", async () => {
  const latest = await agentTranscript(SID, cwd, { agentId: "abig" });
  assert.equal(latest.total, 301);
  assert.equal(latest.from, 151);
  assert.equal(latest.items.length, 150);
  assert.equal(latest.items.at(-1)?.id, "b300:0");
  assert.equal(latest.promptId, "b0");
  const earlier = await agentTranscript(SID, cwd, { agentId: "abig", before: 151 });
  assert.equal(earlier.from, 1);
  assert.equal(earlier.items.length, 150);
  assert.equal(earlier.items[0].id, "b1:0");
  const first = await agentTranscript(SID, cwd, { agentId: "abig", before: 1 });
  assert.deepEqual(kinds(first.items), [["user", "b0"]]);
  assert.equal((await agentTranscript(SID, cwd, { agentId: "abig", before: 900 })).from, 151, "a page before the end is the latest page");
});

test("following a growing transcript brings what came after, the results that arrived, and the latest page when the items no longer line up", async () => {
  const file = path.join(subagents, "agent-agrow.jsonl");
  const all = rows("agrow", [prompt("g1", "Run it"), call("g2", "toolu_sleep", "Bash", { command: "sleep 1", description: "Wait" }), result("g3", "toolu_sleep", "done"), say("g4", "Finished.")]);
  write(file, all.slice(0, 2));
  const first = await agentTranscript(SID, cwd, { agentId: "agrow" });
  assert.deepEqual(kinds(first.items), [
    ["user", "g1"],
    ["tool", "toolu_sleep"],
  ]);
  write(file, all);
  const later = await agentTranscript(SID, cwd, { agentId: "agrow", after: { count: 2, lastId: "toolu_sleep", open: ["toolu_sleep", "nope"] } });
  assert.deepEqual(kinds(later.items), [["assistant", "g4:0"]]);
  assert.equal(later.from, 2);
  assert.equal(later.total, 3);
  assert.equal(later.reset, undefined);
  assert.deepEqual(
    later.changed?.map((i) => [i.id, i.kind === "tool" && i.result?.text]),
    [["toolu_sleep", "done"]],
  );
  const same = await agentTranscript(SID, cwd, { agentId: "agrow", after: { count: 3, lastId: "g4:0" } });
  assert.deepEqual([same.items, same.changed, same.reset], [[], undefined, undefined]);
  const off = await agentTranscript(SID, cwd, { agentId: "agrow", after: { count: 2, lastId: "something else" } });
  assert.equal(off.reset, true);
  assert.equal(off.from, 0);
  assert.equal(off.items.length, 3);
  assert.equal((await agentTranscript(SID, cwd, { agentId: "agrow", after: { count: 9, lastId: "g4:0" } })).reset, true);
  assert.equal((await agentTranscript(SID, cwd, { agentId: "agrow", after: { count: 0, lastId: "" } })).reset, true);
});

test("a transcript is read again only when its size or time changed", async () => {
  const file = path.join(subagents, "agent-acache.jsonl");
  write(file, rows("acache", [prompt("c1", "Say it"), say("c2", "alpha")]));
  const t = new Date("2026-10-16T04:00:00Z");
  fs.utimesSync(file, t, t);
  assert.equal((await agentTranscript(SID, cwd, { agentId: "acache" })).items[1].kind === "assistant" && "alpha", "alpha");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("alpha", "omega"));
  fs.utimesSync(file, t, t);
  const kept = (await agentTranscript(SID, cwd, { agentId: "acache" })).items[1];
  assert.equal(kept.kind === "assistant" && kept.text, "alpha", "same size and time: the transcript read before");
  fs.utimesSync(file, t, new Date("2026-10-16T04:00:01Z"));
  const fresh = (await agentTranscript(SID, cwd, { agentId: "acache" })).items[1];
  assert.equal(fresh.kind === "assistant" && fresh.text, "omega");
});

test("a transcript that grew is read on from where the last read stopped", async () => {
  const file = path.join(subagents, "agent-aon.jsonl");
  const all = rows("aon", [prompt("o1", "Go on"), say("o2", "alpha one"), call("o3", "toolu_on", "Bash", { command: "ls" }), result("o4", "toolu_on", "a.txt"), say("o5", "done")]);
  write(file, all.slice(0, 3));
  const first = await agentTranscript(SID, cwd, { agentId: "aon" });
  assert.deepEqual(kinds(first.items), [
    ["user", "o1"],
    ["assistant", "o2:0"],
    ["tool", "toolu_on"],
  ]);
  // A change well before where reading stopped is seen only by a read from the start.
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("alpha one", "omega one"));
  fs.appendFileSync(file, all.slice(3).map((r) => JSON.stringify(r)).join("\n") + "\n");
  const later = await agentTranscript(SID, cwd, { agentId: "aon", after: { count: 3, lastId: "toolu_on", open: ["toolu_on"] } });
  assert.deepEqual(kinds(later.items), [["assistant", "o5:0"]]);
  assert.deepEqual(later.changed?.map((i) => i.kind === "tool" && i.result?.text), ["a.txt"]);
  const whole = await agentTranscript(SID, cwd, { agentId: "aon" });
  assert.equal(whole.items[1].kind === "assistant" && whole.items[1].text, "alpha one", "the lines read before are not read again");
  assert.equal(whole.total, 4);
});

test("a line still being written waits for its end, and a change just before where reading stopped, a shorter file or a line off the conversation is read whole", async () => {
  const file = path.join(subagents, "agent-aend.jsonl");
  const all = rows("aend", [prompt("e1", "Write"), say("e2", "last words"), say("e3", "more"), say("e4", "and more")]);
  const line = (n: number) => JSON.stringify(all[n]);
  write(file, all.slice(0, 2));
  assert.equal((await agentTranscript(SID, cwd, { agentId: "aend" })).total, 2);
  fs.appendFileSync(file, line(2).slice(0, 40));
  assert.equal((await agentTranscript(SID, cwd, { agentId: "aend" })).total, 2, "half a line is not read");
  fs.appendFileSync(file, line(2).slice(40) + "\n");
  assert.deepEqual(kinds((await agentTranscript(SID, cwd, { agentId: "aend" })).items).at(-1), ["assistant", "e3:0"]);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"more"', '"MORE"') + line(3) + "\n");
  const changed = await agentTranscript(SID, cwd, { agentId: "aend" });
  assert.deepEqual(
    changed.items.slice(-2).map((i) => i.kind === "assistant" && i.text),
    ["MORE", "and more"],
    "the bytes just before where reading stopped changed, so it is read whole",
  );
  write(file, all.slice(0, 2));
  assert.equal((await agentTranscript(SID, cwd, { agentId: "aend" })).total, 2, "a shorter file is read whole");
  const compacted = [
    { ...rows("aend", [{ type: "user", uuid: "r1", isCompactSummary: true, message: { role: "user", content: "Summary of the work" } }])[0], parentUuid: null },
    { ...rows("aend", [say("r2", "Going on from the summary.")])[0], parentUuid: "r1" },
  ];
  fs.appendFileSync(file, compacted.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const after = await agentTranscript(SID, cwd, { agentId: "aend", after: { count: 2, lastId: "e2:0" } });
  assert.equal(after.reset, true, "a line off the conversation read so far starts it over");
  assert.deepEqual(kinds(after.items), [["assistant", "r2:0"]]);
});

test("a transcript over 64MB is refused, and an answer stays within its budget", async () => {
  const huge = path.join(subagents, "agent-ahuge.jsonl");
  fs.writeFileSync(huge, "");
  fs.truncateSync(huge, 64 * 1024 * 1024 + 1);
  await assert.rejects(agentTranscript(SID, cwd, { agentId: "ahuge" }), /transcript too large/);
  fs.rmSync(huge);
  const long = "가".repeat(3000);
  write(path.join(subagents, "agent-awide.jsonl"), rows("awide", [prompt("v0", "Write"), ...Array.from({ length: 150 }, (_, n) => say(`v${n + 1}`, `${n} ${long}`))]));
  const r = await agentTranscript(SID, cwd, { agentId: "awide" });
  const bytes = Buffer.byteLength(JSON.stringify(r.items));
  assert.ok(bytes <= 900 * 1024 + r.items.length + 1 && bytes > 800 * 1024, String(bytes));
  assert.equal(r.from + r.items.length, 151);
  assert.ok(r.from > 1);
  assert.equal(r.items.at(-1)?.id, "v150:0");
});

test("a workflow run's agents come from its journal, with their labels, phases and how they ended", async () => {
  const w = await workflowAgents(SID, cwd, "wf_run-1");
  assert.deepEqual(w, {
    phases: ["review", "join"],
    agents: [
      { label: "aw0", id: "aw0", state: "done" },
      { label: "parser review", id: "aw1", phase: 0, state: "done" },
      { label: "lexer review", id: "aw2", phase: 0, state: "failed" },
      { label: "join", id: "aw3", phase: 1, state: "running" },
      { label: "late check", id: "aw4", state: "running" },
    ],
    total: 5,
    running: 2,
    done: 2,
    failed: 1,
  });
  assert.deepEqual(await workflowAgents(SID, cwd, "wf_none"), { phases: [], agents: [], total: 0, running: 0, done: 0, failed: 0 });
});

test("a file a subagent sent is found in its transcript by the call, with the files its result kept", async () => {
  const attachments = [{ path: "/tmp/out/plot.png", size: 512, isImage: true, media_type: "image/png", pathValidated: true }];
  write(
    path.join(subagents, "agent-asend.jsonl"),
    rows("asend", [
      prompt("f1", "Draw the plot and send it"),
      call("f2", "toolu_plot", "SendUserFile", { files: ["/tmp/out/plot.png"], status: "proactive" }),
      result("f3", "toolu_plot", "1 file delivered to user.", { toolUseResult: { attachments } }),
      say("f4", "Sent."),
    ]),
  );
  const item = await agentItem(SID, cwd, "asend", "toolu_plot");
  assert.deepEqual(item?.kind === "tool" && item.sent, [{ name: "plot.png", path: "/tmp/out/plot.png", size: 512, mediaType: "image/png", image: true }]);
  assert.equal(item?.ts, "2026-10-16T03:00:01.000Z");
  assert.equal(await agentItem(SID, cwd, "asend", "toolu_other"), undefined);
  assert.equal(await agentItem(SID, cwd, "anone", "toolu_plot"), undefined);
  assert.equal(await agentItem(SID, cwd, "../asend", "toolu_plot"), undefined, "an id that could leave the folder finds nothing");
});
