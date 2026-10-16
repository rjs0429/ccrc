import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Transcripts are read from ~/.claude, so the test runs against an empty home of its own.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccrc-home-"));
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
after(() => fs.rmSync(home, { recursive: true, force: true }));

const { currentMessages, forkPoint, loadHistory, projectDirName, turnPoint } = await import("../src/sessions/history.ts");
const { ItemBuilder } = await import("../src/sessions/items.ts");

const cwd = path.join(home, "ws");
const project = path.join(home, ".claude", "projects", projectDirName(cwd));
fs.mkdirSync(project, { recursive: true });

type Row = Record<string, unknown>;

// A conversation of three exchanges in the shape Claude Code 2.1.300 writes, with the ids of its rows.
function conversation(sid: string) {
  const ids = { u1: randomUUID(), a1: randomUUID(), u2: randomUUID(), a2: randomUUID(), u3: randomUUID(), a3: randomUUID() };
  const base = { sessionId: sid, cwd, isSidechain: false, userType: "external", version: "2.1.300", gitBranch: "", entrypoint: "sdk-ts" };
  let n = 0;
  const at = () => `2026-10-16T08:00:${String(n++).padStart(2, "0")}.000Z`;
  const user = (uuid: string, parentUuid: string | null, text: string): Row => ({ ...base, parentUuid, uuid, timestamp: at(), type: "user", message: { role: "user", content: text } });
  const reply = (uuid: string, parentUuid: string, text: string): Row => ({
    ...base,
    parentUuid,
    uuid,
    timestamp: at(),
    type: "assistant",
    message: { id: `msg_${uuid.slice(0, 8)}`, type: "message", role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } },
  });
  const rows: Row[] = [
    user(ids.u1, null, "first"),
    reply(ids.a1, ids.u1, "reply to first"),
    user(ids.u2, ids.a1, "second"),
    reply(ids.a2, ids.u2, "reply to second"),
    user(ids.u3, ids.a2, "third"),
    reply(ids.a3, ids.u3, "reply to third"),
  ];
  return { ids, rows, base, at, user, reply };
}

function write(sid: string, rows: Row[]): void {
  fs.writeFileSync(path.join(project, `${sid}.jsonl`), rows.map((r) => JSON.stringify(r) + "\n").join(""));
}

const shown = (items: { kind: string; id: string; text?: string }[]) => items.map((i) => `${i.kind}:${i.text ?? ""}`);

test("a conversation rewound in place loads as Claude Code resumes it, whatever was written after", async () => {
  const sid = randomUUID();
  const { ids, rows } = conversation(sid);
  const rewind = { type: "last-prompt", leafUuid: ids.a1, explicit: true, rewound: true, sessionId: sid };
  write(sid, [...rows, { type: "custom-title", customTitle: "t", sessionId: sid }, rewind, { type: "queue-operation", operation: "dequeue" }]);
  assert.deepEqual(shown(await loadHistory(sid, cwd)), ["user:first", "assistant:reply to first"]);
  assert.deepEqual(
    (await currentMessages(sid, cwd)).map((m) => m.uuid),
    [ids.u1, ids.a1],
  );
  // Claude Code names the same row again, without "explicit", as it ends.
  write(sid, [...rows, rewind, { type: "last-prompt", leafUuid: ids.a1, sessionId: sid }]);
  assert.deepEqual(shown(await loadHistory(sid, cwd)), ["user:first", "assistant:reply to first"]);
  // A last-prompt row of another row, or one Claude Code writes as a prompt goes out, is no rewind.
  write(sid, [...rows, rewind, { type: "last-prompt", leafUuid: ids.a3, sessionId: sid }]);
  assert.equal((await loadHistory(sid, cwd)).length, 6);
  write(sid, [...rows, { type: "last-prompt", lastPrompt: "third", leafUuid: ids.a2, sessionId: sid }]);
  assert.equal((await loadHistory(sid, cwd)).length, 6);
});

test("a rewind to the first message empties the conversation until the next one starts a new root", async () => {
  const sid = randomUUID();
  const { rows, base, at } = conversation(sid);
  const rewind = { type: "last-prompt", leafUuid: null, explicit: true, rewound: true, sessionId: sid };
  write(sid, [...rows, rewind]);
  assert.deepEqual(await loadHistory(sid, cwd), []);
  assert.deepEqual(await currentMessages(sid, cwd), []);
  const fresh = randomUUID();
  write(sid, [...rows, rewind, { ...base, parentUuid: null, uuid: fresh, timestamp: at(), type: "user", message: { role: "user", content: "again" } }]);
  assert.deepEqual(shown(await loadHistory(sid, cwd)), ["user:again"]);
});

test("a message after the rewind continues from where it left the conversation", async () => {
  const sid = randomUUID();
  const { ids, rows, user, reply } = conversation(sid);
  const next = randomUUID();
  write(sid, [...rows, { type: "last-prompt", leafUuid: ids.a1, explicit: true, rewound: true, sessionId: sid }, user(next, ids.a1, "second, again"), reply(randomUUID(), next, "a new reply")]);
  assert.deepEqual(shown(await loadHistory(sid, cwd)), ["user:first", "assistant:reply to first", "user:second, again", "assistant:a new reply"]);
});

test("a rewind kept at a local command keeps the command's result card; a stand-in row shows nothing", async () => {
  const sid = randomUUID();
  const { ids, rows, base, at, user, reply } = conversation(sid);
  const caveat = randomUUID();
  const command = randomUUID();
  const result = randomUUID();
  const u2 = randomUUID();
  const a2 = randomUUID();
  const named: Row[] = [
    rows[0],
    rows[1],
    { ...base, parentUuid: ids.a1, uuid: caveat, timestamp: at(), type: "user", isMeta: true, message: { role: "user", content: "<local-command-caveat>The command below was run directly in Claude Code.</local-command-caveat>" } },
    { ...base, parentUuid: caveat, uuid: command, timestamp: at(), type: "user", message: { role: "user", content: "<command-name>/rename</command-name>\n<command-message>rename</command-message>\n<command-args>x (fork)</command-args>" } },
    { ...base, parentUuid: command, uuid: result, timestamp: at(), type: "system", subtype: "local_command", content: "<local-command-stdout>Session renamed to: x (fork)</local-command-stdout>", level: "info", isMeta: false, commandRun: { command: "rename", args: "x (fork)" } },
    user(u2, result, "after the command"),
    reply(a2, u2, "a reply"),
  ];
  write(sid, [...named, { type: "last-prompt", leafUuid: command, explicit: true, rewound: true, sessionId: sid }]);
  const items = await loadHistory(sid, cwd);
  assert.deepEqual(
    items.map((i) => i.kind),
    ["user", "assistant", "note", "command"],
  );
  assert.equal(items.at(-1)?.kind === "command" && items.at(-1)?.id, result);
  // Claude Code 2.1.300 stands a row in for a message it took in without one; it is no message to show.
  write(sid, [...rows, { ...base, parentUuid: ids.a3, uuid: randomUUID(), timestamp: at(), type: "system", subtype: "rewind_stand_in", source_uuid: randomUUID(), content: "", level: "info" }]);
  assert.equal((await loadHistory(sid, cwd)).length, 6);
});

test("a rewind kept at a message sent while Claude worked keeps that message", async () => {
  const sid = randomUUID();
  const { ids, rows, base, at, reply } = conversation(sid);
  const queued = randomUUID();
  const sent = randomUUID();
  const after = randomUUID();
  write(sid, [
    rows[0],
    rows[1],
    rows[2],
    { ...base, parentUuid: ids.u2, uuid: queued, timestamp: at(), type: "attachment", attachment: { type: "queued_command", prompt: "also this", source_uuid: sent, commandMode: "prompt" } },
    reply(after, queued, "took both"),
    { ...base, parentUuid: after, uuid: randomUUID(), timestamp: at(), type: "user", message: { role: "user", content: "later" } },
    { type: "last-prompt", leafUuid: queued, explicit: true, rewound: true, sessionId: sid },
  ]);
  assert.deepEqual(shown(await loadHistory(sid, cwd)), ["user:first", "assistant:reply to first", "user:second", "user:also this"]);
});

test("a fork leaves out the message and all after it, ending at the row the message hangs from", async () => {
  const sid = randomUUID();
  const { ids, rows, base, at } = conversation(sid);
  write(sid, rows);
  assert.deepEqual(await forkPoint(sid, cwd, ids.u2), { at: ids.a1 });
  assert.deepEqual(await forkPoint(sid, cwd, ids.u3), { at: ids.a2 });
  assert.deepEqual(await forkPoint(sid, cwd, ids.u1), {}, "the first message has nothing before it");
  assert.equal(await forkPoint(sid, cwd, randomUUID()), undefined);
  // A message sent while Claude worked, by its queued_command row; one Claude Code stood a row in for; a local command
  // with the caveat row in front of it.
  const sent = randomUUID();
  const queued = randomUUID();
  const stood = randomUUID();
  const caveat = randomUUID();
  const command = randomUUID();
  write(sid, [
    ...rows,
    { ...base, parentUuid: ids.a3, uuid: queued, timestamp: at(), type: "attachment", attachment: { type: "queued_command", prompt: "more", source_uuid: sent } },
    { ...base, parentUuid: queued, uuid: randomUUID(), timestamp: at(), type: "system", subtype: "rewind_stand_in", source_uuid: stood, content: "", level: "info" },
    { ...base, parentUuid: ids.a3, uuid: caveat, timestamp: at(), type: "user", isMeta: true, message: { role: "user", content: [{ type: "text", text: "<local-command-caveat>Caveat.</local-command-caveat>" }] } },
    { ...base, parentUuid: caveat, uuid: command, timestamp: at(), type: "user", message: { role: "user", content: "<command-name>/rename</command-name>" } },
  ]);
  assert.deepEqual(await forkPoint(sid, cwd, sent), { at: ids.a3 });
  assert.deepEqual(await forkPoint(sid, cwd, stood), { at: queued });
  assert.deepEqual(await forkPoint(sid, cwd, command), { at: ids.a3 });
});

test("a fork that leaves out the turn running now ends above the row that started it", async () => {
  const sid = randomUUID();
  const { ids, rows, base, at, user, reply } = conversation(sid);
  const tool = (uuid: string, parentUuid: string, id: string): Row => ({ ...reply(uuid, parentUuid, ""), message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: {} }] } });
  const result = (uuid: string, parentUuid: string, id: string): Row => ({ ...user(uuid, parentUuid, ""), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
  assert.equal(await turnPoint(sid, cwd), undefined, "no transcript");
  // A message sent during the turn joins it.
  const [call, done, queued, more] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  write(sid, [
    ...rows.slice(0, 5),
    tool(call, ids.u3, "toolu_1"),
    result(done, call, "toolu_1"),
    { ...base, parentUuid: done, uuid: queued, timestamp: at(), type: "attachment", attachment: { type: "queued_command", prompt: "also this", source_uuid: randomUUID(), commandMode: "prompt" } },
    tool(more, queued, "toolu_2"),
  ]);
  assert.deepEqual(await turnPoint(sid, cwd), { at: ids.a2 });
  // A command started it, the prompt it stands for following as a meta row.
  const [command, prompt] = [randomUUID(), randomUUID()];
  write(sid, [
    ...rows.slice(0, 4),
    user(command, ids.a2, "<command-message>review is running…</command-message>\n<command-name>/review</command-name>\n<command-args>src</command-args>"),
    { ...user(prompt, command, "Review the code in src."), isMeta: true },
    tool(randomUUID(), prompt, "toolu_3"),
  ]);
  assert.deepEqual(await turnPoint(sid, cwd), { at: ids.a2 });
  // A notice of a finished task or a message from another session that came while Claude Code waited starts one too.
  const notice = randomUUID();
  write(sid, [...rows, { ...user(notice, ids.a3, "<task-notification>\n<status>completed</status>\n</task-notification>"), origin: { kind: "task-notification" } }, tool(randomUUID(), notice, "toolu_4")]);
  assert.deepEqual(await turnPoint(sid, cwd), { at: ids.a3 });
  const peer = randomUUID();
  write(sid, [...rows, { ...user(peer, ids.a3, "Another Claude session sent a message"), isMeta: true, origin: { kind: "peer" } }, tool(randomUUID(), peer, "toolu_5")]);
  assert.deepEqual(await turnPoint(sid, cwd), { at: ids.a3 });
  // A local command and its output, then the turn; a local command running with its caveat row.
  const [caveat, local, printed, asked] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const commandRows: Row[] = [
    { ...user(caveat, ids.a3, "<local-command-caveat>Caveat.</local-command-caveat>"), isMeta: true },
    user(local, caveat, "<command-name>/context</command-name>"),
    user(printed, local, "<local-command-stdout>Context</local-command-stdout>"),
  ];
  write(sid, [...rows, ...commandRows, user(asked, printed, "fourth"), tool(randomUUID(), asked, "toolu_6")]);
  assert.deepEqual(await turnPoint(sid, cwd), { at: printed });
  write(sid, [...rows, ...commandRows.slice(0, 2)]);
  assert.deepEqual(await turnPoint(sid, cwd), { at: ids.a3 });
  // A turn Claude Code compacted the conversation in reaches back across the boundary.
  const [boundary, summary] = [randomUUID(), randomUUID()];
  write(sid, [
    ...rows.slice(0, 5),
    tool(call, ids.u3, "toolu_7"),
    { ...base, parentUuid: null, logicalParentUuid: call, uuid: boundary, timestamp: at(), type: "system", subtype: "compact_boundary", content: "Conversation compacted" },
    { ...user(summary, boundary, "This session is being continued from a previous conversation."), isCompactSummary: true },
    tool(randomUUID(), summary, "toolu_8"),
  ]);
  assert.deepEqual(await turnPoint(sid, cwd), { at: ids.a2 });
  // The turn running is the conversation's first.
  write(sid, [rows[0], tool(randomUUID(), ids.u1, "toolu_9")]);
  assert.deepEqual(await turnPoint(sid, cwd), {});
});

test("cutting the conversation at an item leaves out it and everything after it", () => {
  const b = new ItemBuilder(cwd);
  const msg = (uuid: string, content: unknown[]) => ({ type: "assistant", uuid, message: { content } }) as never;
  b.add({ type: "user", uuid: "u1", message: { content: "one" } });
  b.add(msg("a1", [{ type: "text", text: "two" }]));
  b.add({ type: "user", uuid: "u2", message: { content: "three" } });
  b.add(msg("a2", [{ type: "tool_use", id: "toolu_agent", name: "Agent", input: { description: "look" } }]));
  b.add({ type: "assistant", uuid: "s1", parent_tool_use_id: "toolu_agent", message: { content: [{ type: "tool_use", id: "toolu_inner", name: "Read", input: { file_path: "x" } }] } });
  assert.equal(b.cut("nope"), false);
  assert.equal(b.cut("u2"), true);
  assert.deepEqual(
    b.items.map((i) => i.id),
    ["u1", "a1:0"],
  );
  assert.equal(b.has("toolu_agent"), false);
  // What comes next lands after what stayed.
  b.add({ type: "user", uuid: "u3", message: { content: "again" } });
  assert.deepEqual(
    b.items.map((i) => i.id),
    ["u1", "a1:0", "u3"],
  );
});
