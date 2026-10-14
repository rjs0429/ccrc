import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { after, test } from "node:test";
import Fastify from "fastify";

// Transcripts are read from ~/.claude, so the test runs against an empty home of its own.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccrc-home-"));
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
after(() => fs.rmSync(home, { recursive: true, force: true }));

const { SessionSearch } = await import("../src/sessions/search.ts");
const { loadHistory, projectDirName, PROJECTS } = await import("../src/sessions/history.ts");
const { registerSearch } = await import("../src/routes/search.ts");
type Summary = import("../src/protocol.ts").SessionSummary;

const cwd = path.join(home, "ws");
let n = 0;
const sid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

function row(sessionId: string, type: "user" | "assistant", content: unknown, extra: Record<string, unknown> = {}, minute = 0): string {
  const uuid = `${sessionId.slice(-4)}-${type}-${++n}`;
  const message = type === "user" ? { role: "user", content } : { role: "assistant", model: "claude-haiku", content };
  const base = { parentUuid: null, isSidechain: false, userType: "external", cwd, sessionId, version: "2.1.296" };
  return JSON.stringify({ ...base, type, uuid, timestamp: new Date(Date.UTC(2026, 9, 14, 1, minute)).toISOString(), message, ...extra });
}

function write(sessionId: string, lines: string[], dir = projectDirName(cwd)): string {
  const file = path.join(PROJECTS, dir, `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => l + "\n").join(""));
  return file;
}

function summary(id: string, title: string, lastModified: number): Summary {
  return { id, title, cwd, lastModified, state: "inactive" };
}

test("only typed user text and assistant text are searched", async () => {
  const id = sid();
  write(id, [
    row(id, "user", "배포 스크립트를 고쳐 줘"),
    row(id, "assistant", [{ type: "thinking", thinking: "zebra thinking" }]),
    row(id, "assistant", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "echo zebra-input" } }]),
    row(id, "user", [{ type: "tool_result", tool_use_id: "t1", content: "zebra-output" }], { toolUseResult: { stdout: "zebra-output" } }),
    row(id, "user", [{ type: "text", text: "<system-reminder>zebra context</system-reminder>" }]),
    row(id, "user", "<command-name>/zebra</command-name>"),
    row(id, "user", "zebra meta", { isMeta: true }),
    row(id, "assistant", [{ type: "text", text: "스크립트의 경로 문제를 고쳤습니다." }]),
    JSON.stringify({ type: "system", subtype: "local_command", content: "zebra system", uuid: "s1", timestamp: "2026-10-14T01:00:00Z" }),
  ]);
  const s = new SessionSearch();
  const list = [summary(id, "배포", 1)];
  assert.equal((await s.search("zebra", list)).total, 0);
  const r = await s.search("경로", list);
  assert.equal(r.total, 1);
  assert.equal(r.results[0].snippets[0].role, "assistant");
  assert.equal((await s.search("스크립트", list)).results[0].hits, 2);
});

test("snippet item ids are the ids the chat view gives those messages", async () => {
  const id = sid();
  const u = row(id, "user", [{ type: "text", text: "찾을 질문 하나" }]);
  const a = row(id, "assistant", [{ type: "text", text: "찾을 대답 하나" }], { parentUuid: JSON.parse(u).uuid });
  write(id, [u, a]);
  const items = await loadHistory(id, cwd);
  const r = await new SessionSearch().search("찾을", [summary(id, "", 1)]);
  const ids = r.results[0].snippets.map((x) => x.itemId).sort();
  assert.deepEqual(ids, items.filter((i) => i.kind === "user" || i.kind === "assistant").map((i) => i.id).sort());
});

test("a message sent mid-turn is found under the chat view's id, and a row written again counts once", async () => {
  const id = sid();
  const u = row(id, "user", "alpha 질문");
  const a = row(id, "assistant", [{ type: "text", text: "alpha 대답" }], { parentUuid: JSON.parse(u).uuid });
  const q = JSON.stringify({
    parentUuid: JSON.parse(a).uuid,
    isSidechain: false,
    type: "attachment",
    uuid: "queued-row",
    timestamp: "2026-10-14T01:00:00Z",
    sessionId: id,
    cwd,
    attachment: { type: "queued_command", prompt: [{ type: "text", text: "alpha 중간에 보낸 말" }], source_uuid: "queued-src", commandMode: "prompt", origin: { kind: "human" } },
  });
  const b = row(id, "assistant", [{ type: "text", text: "끝" }], { parentUuid: "queued-row" });
  write(id, [u, a, q, b, u, a]);
  const items = await loadHistory(id, cwd);
  const r = await new SessionSearch().search("alpha", [summary(id, "", 1)]);
  assert.equal(r.results[0].hits, 3);
  const ids = r.results[0].snippets.map((x) => x.itemId);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes("queued-src"));
  for (const itemId of ids) assert.ok(items.some((i) => i.id === itemId), itemId);
});

test("messages before the last compaction are flagged, except those it kept", async () => {
  const id = sid();
  const u1 = row(id, "user", "beta old question");
  const a1 = row(id, "assistant", [{ type: "text", text: "beta old answer" }]);
  const a2 = row(id, "assistant", [{ type: "text", text: "beta kept answer" }]);
  const kept = JSON.parse(a2).uuid;
  const boundary = JSON.stringify({ parentUuid: null, logicalParentUuid: kept, type: "system", subtype: "compact_boundary", uuid: "cb-1", timestamp: "2026-10-14T01:00:00Z", compactMetadata: { preservedMessages: { allUuids: [kept] } } });
  const u2 = row(id, "user", "beta new question");
  const file = write(id, [u1, a1, a2]);
  const s = new SessionSearch();
  const list = [summary(id, "", 1)];
  const flags = async () => Object.fromEntries((await s.search("beta", list)).results[0].snippets.map((x) => [x.text, Boolean(x.earlier)]));
  assert.deepEqual(await flags(), { "beta old question": false, "beta old answer": false, "beta kept answer": false });
  fs.appendFileSync(file, [boundary, row(id, "user", "summary beta", { isCompactSummary: true }), u2].map((l) => l + "\n").join(""));
  assert.deepEqual(await flags(), { "beta new question": false, "beta kept answer": false, "beta old answer": true });
  assert.deepEqual(await new SessionSearch().search("beta", list).then((r) => r.results[0].snippets.map((x) => Boolean(x.earlier))), [false, false, true]);
});

test("a transcript that cannot be read does not keep the search pending", async () => {
  const id = sid();
  fs.mkdirSync(path.join(PROJECTS, projectDirName(cwd), `${id}.jsonl`), { recursive: true });
  const r = await new SessionSearch().search("gamma", [summary(id, "gamma title", 1)]);
  assert.equal(r.pending, 0);
  assert.equal(r.total, 1);
});

test("title matches come first, then content matches by recency", async () => {
  const [a, b, c, d] = [sid(), sid(), sid(), sid()];
  write(a, [row(a, "user", "kiwi in an old message")]);
  write(b, [row(b, "user", "nothing here")]);
  write(c, [row(c, "user", "kiwi again, newer")]);
  write(d, [row(d, "user", "nothing either")]);
  const list = [summary(a, "first", 10), summary(b, "Kiwi plans", 5), summary(c, "third", 30), summary(d, "unrelated", 40)];
  const r = await new SessionSearch().search("KIWI", list);
  assert.deepEqual(
    r.results.map((x) => x.id),
    [b, c, a],
  );
  assert.equal(r.results[0].titleMatch, true);
  assert.deepEqual(r.results[0].titleMarks, [[0, 4]]);
});

test("every word must appear, in the title or the conversation; Korean in any normal form matches", async () => {
  const [a, b] = [sid(), sid()];
  write(a, [row(a, "user", "휴대폰에서 검색"), row(a, "assistant", [{ type: "text", text: "Index ready" }])]);
  write(b, [row(b, "user", "휴대폰 화면만")]);
  const list = [summary(a, "세션 하나", 2), summary(b, "검색 세션", 1)];
  const s = new SessionSearch();
  assert.deepEqual(
    (await s.search("휴대폰 검색", list)).results.map((x) => x.id),
    [a, b],
  );
  assert.deepEqual(
    (await s.search("검색 index", list)).results.map((x) => x.id),
    [a],
  );
  assert.equal((await s.search("휴대폰 없는말", list)).total, 0);
  assert.equal((await s.search("휴대폰".normalize("NFD"), list)).total, 2);
  assert.deepEqual(await s.search("   ", list), { results: [], total: 0, pending: 0 });
});

test("a changed transcript is read again; an unchanged one is not", async () => {
  const id = sid();
  const file = write(id, [row(id, "user", "alpha first")]);
  const s = new SessionSearch();
  const list = [summary(id, "", 1)];
  assert.equal((await s.search("alpha", list)).total, 1);
  fs.appendFileSync(file, row(id, "assistant", [{ type: "text", text: "bravo appended" }]) + "\n");
  assert.equal((await s.search("bravo", list)).total, 1);
  assert.equal((await s.search("alpha", list)).total, 1);
  // Same size and time: the index keeps what it read.
  const st = fs.statSync(file);
  const same = fs.readFileSync(file, "utf8").replace("bravo", "delta");
  fs.writeFileSync(file, same);
  fs.utimesSync(file, st.atime, st.mtime);
  assert.equal((await s.search("delta", list)).total, 0);
  // Rewritten from the start: the old text is gone.
  write(id, [row(id, "user", "charlie only")]);
  assert.equal((await s.search("alpha", list)).total, 0);
  assert.equal((await s.search("charlie", list)).total, 1);
  // A partly written last line is read once it is complete.
  const line = row(id, "user", "echo split line");
  fs.appendFileSync(file, line.slice(0, 20));
  assert.equal((await s.search("echo", list)).total, 0);
  fs.appendFileSync(file, line.slice(20) + "\n");
  assert.equal((await s.search("echo", list)).total, 1);
});

test("snippets stay short, marks fall inside them, and cuts are flagged", async () => {
  const id = sid();
  const long = `${"앞".repeat(300)} needle ${"뒤".repeat(300)} 😀needle`;
  write(id, [row(id, "assistant", [{ type: "text", text: long }])]);
  const r = await new SessionSearch().search("needle", [summary(id, "", 1)]);
  const sn = r.results[0].snippets[0];
  assert.ok(sn.text.length <= 140);
  assert.ok(sn.cutStart && sn.cutEnd);
  assert.equal(sn.marks.length, 1);
  for (const [a, b] of sn.marks) assert.equal(sn.text.slice(a, b), "needle");
  assert.doesNotMatch(sn.text, /\n/);
  const many = sid();
  write(many, Array.from({ length: 10 }, (_, i) => row(many, "user", `needle ${i}`, {}, i)));
  const m = (await new SessionSearch().search("needle", [summary(many, "", 1)])).results[0];
  assert.equal(m.hits, 10);
  assert.equal(m.snippets.length, 3);
  assert.deepEqual(
    m.snippets.map((x) => x.text),
    ["needle 9", "needle 8", "needle 7"],
  );
});

test("results, words, query length and kept text are bounded", async () => {
  const list: Summary[] = [];
  for (let i = 0; i < 60; i++) {
    const id = sid();
    write(id, [row(id, "user", `common word ${i}`)]);
    list.push(summary(id, "", i));
  }
  const s = new SessionSearch();
  const r = await s.search("common", list);
  assert.equal(r.results.length, 30);
  assert.equal(r.total, 60);
  assert.equal((await s.search("common", list, 500)).results.length, 50);
  assert.equal((await s.search("common", list, 5)).results.length, 5);
  // Words past the eighth and text past the length limit are left out.
  const words = sid();
  write(words, [row(words, "user", "w1 w2 w3 w4 w5 w6 w7 w8")]);
  const w = [summary(words, "", 1)];
  assert.equal((await s.search("w1 zzz", w)).total, 0);
  assert.equal((await s.search("w1 w2 w3 w4 w5 w6 w7 w8 zzz", w)).total, 1);
  assert.equal((await s.search(`w1 ${" ".repeat(200)}zzz`, w)).total, 1);

  const id = sid();
  write(id, Array.from({ length: 20 }, (_, i) => row(id, "user", `msg${i} ${"x".repeat(90)}`, {}, i)));
  const small = new SessionSearch({ transcriptChars: 500, messageChars: 50 });
  const one = [summary(id, "", 1)];
  assert.equal((await small.search("msg19", one)).total, 1);
  assert.equal((await small.search("msg5", one)).total, 0);
  assert.ok(small.stats.chars <= 500);

  const tiny = new SessionSearch({ totalChars: 2000 });
  await tiny.search("common", list);
  assert.ok(tiny.stats.chars <= 2000);
});

test("a search past its time budget answers on titles and reads the rest afterwards", async () => {
  const [a, b] = [sid(), sid()];
  write(a, [row(a, "user", "lima content")]);
  write(b, [row(b, "user", "lima content too")]);
  const list = [summary(a, "lima title", 2), summary(b, "other", 1)];
  const s = new SessionSearch({ budgetMs: -1 });
  const first = await s.search("lima", list);
  assert.equal(first.pending, 2);
  assert.deepEqual(
    first.results.map((x) => x.id),
    [a],
  );
  for (let i = 0; i < 50 && s.stats.transcripts < 2; i++) await new Promise((r) => setTimeout(r, 10));
  const second = await s.search("lima", list);
  assert.equal(second.pending, 0);
  assert.equal(second.total, 2);
});

test("the route needs a session, checks the query and keeps it out of the log", async () => {
  const id = sid();
  write(id, [row(id, "user", "secretword in a message")]);
  const logged: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logged.push(String(chunk));
      cb();
    },
  });
  const app = Fastify({ logger: { level: "info", stream } });
  const deps = {
    manager: { list: async () => [summary(id, "", 1)] },
    requireAuth: async (req: { headers: Record<string, unknown> }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
      if (req.headers.authorization !== "ok") return reply.code(401).send({ error: "unauthorized" });
    },
  };
  await registerSearch(app, deps as never);
  const post = (payload: unknown, auth = "ok") => app.inject({ method: "POST", url: "/api/search", headers: { authorization: auth }, payload: payload as object });
  assert.equal((await post({ q: "secretword" }, "no")).statusCode, 401);
  assert.equal((await post({ q: 5 })).statusCode, 400);
  assert.equal((await post({ q: "x".repeat(201) })).statusCode, 400);
  assert.equal((await post({ q: "a", limit: "9" })).statusCode, 400);
  const ok = await post({ q: "secretword" });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().total, 1);
  assert.ok(logged.length > 0);
  assert.ok(logged.every((l) => !l.includes("secretword")));
  await app.close();
});

test("a snapshot reaches back to a focused item within a bound", async () => {
  const { tail } = await import("../src/sessions/manager.ts");
  const items = Array.from({ length: 3000 }, (_, i) => ({ kind: "user" as const, id: `i${i}`, text: "" }));
  const ids = (r: { items: { id: string }[] }) => [r.items[0].id, r.items.length];
  assert.deepEqual(ids(tail(items)), ["i2600", 400]);
  assert.deepEqual(ids(tail(items, "i2000")), ["i1980", 1020]);
  assert.deepEqual(ids(tail(items, "i2900")), ["i2600", 400]);
  assert.deepEqual(ids(tail(items, "i100")), ["i2600", 400]);
  assert.deepEqual(ids(tail(items, "missing")), ["i2600", 400]);
  assert.equal(tail(items, "i2000").hasMore, true);
  assert.deepEqual(ids(tail(items.slice(0, 50), "i10")), ["i0", 50]);
  assert.equal(tail(items.slice(0, 50), "i10").hasMore, false);
});
