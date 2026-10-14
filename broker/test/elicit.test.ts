import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { Audit } from "../src/audit.ts";
import { elicitContent, elicitFields, elicitInfo, elicitResult, fieldProblem } from "../src/elicit.ts";
import { Hub } from "../src/hub.ts";
import type { Leases } from "../src/lease.ts";
import type { ElicitInfo, PendingRequest } from "../src/protocol.ts";
import { BrokerSession } from "../src/sessions/broker-session.ts";
import type { SessionManager } from "../src/sessions/manager.ts";
import { Uploads } from "../src/uploads.ts";
import { tempDir } from "./helpers.ts";

const SID = "3e7c9a10-5b2d-4f8e-9c1a-2d3e4f5a6b7c";

const SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", title: "Name", minLength: 2, maxLength: 5 },
    email: { type: "string", format: "email" },
    site: { type: "string", format: "uri" },
    day: { type: "string", format: "date" },
    at: { type: "string", format: "date-time" },
    age: { type: "integer", minimum: 0, maximum: 150, default: 30 },
    ratio: { type: "number", maximum: 1 },
    ok: { type: "boolean", default: true },
    size: { type: "string", enum: ["s", "m"], enumNames: ["Small", "Medium"] },
    color: { type: "string", oneOf: [{ const: "r", title: "Red" }, { const: "g", title: "Green" }], default: "g" },
    tags: { type: "array", items: { type: "string", enum: ["a", "b", "c"] }, minItems: 1, maxItems: 2 },
  },
  required: ["name", "age", "size"],
};

test("a requested schema becomes the fields the phone draws", () => {
  const { fields, unsupported } = elicitFields(SCHEMA);
  assert.equal(unsupported, undefined);
  assert.deepEqual(
    fields.map((f) => [f.key, f.type, f.required]),
    [
      ["name", "string", true],
      ["email", "string", false],
      ["site", "string", false],
      ["day", "string", false],
      ["at", "string", false],
      ["age", "integer", true],
      ["ratio", "number", false],
      ["ok", "boolean", false],
      ["size", "choice", true],
      ["color", "choice", false],
      ["tags", "multi", false],
    ],
  );
  assert.deepEqual(fields[0], { key: "name", title: "Name", required: true, type: "string", minLength: 2, maxLength: 5 });
  assert.deepEqual(fields[5], { key: "age", required: true, type: "integer", minimum: 0, maximum: 150, default: 30 });
  assert.deepEqual(fields[8], { key: "size", required: true, type: "choice", options: [{ value: "s", title: "Small" }, { value: "m", title: "Medium" }] });
  assert.deepEqual(fields[9], { key: "color", required: false, type: "choice", options: [{ value: "r", title: "Red" }, { value: "g", title: "Green" }], default: "g" });
  assert.deepEqual(fields[10], { key: "tags", required: false, type: "multi", options: ["a", "b", "c"].map((v) => ({ value: v, title: v })), minItems: 1, maxItems: 2 });
});

test("a form with a field the phone cannot fill is marked unsupported", () => {
  for (const schema of [
    { type: "object", properties: { x: { type: "object" } } },
    { type: "object", properties: { x: { type: "string", format: "ipv4" } } },
    { type: "object", properties: { x: { type: "string", enum: [1, 2] } } },
    { type: "object", properties: { x: { type: "string" } }, required: ["y"] },
    { type: "object", properties: [] },
    "nope",
  ]) {
    assert.equal(elicitFields(schema).unsupported, true, JSON.stringify(schema));
  }
  assert.deepEqual(elicitFields(undefined), { fields: [] });
  assert.deepEqual(elicitFields({ type: "object", properties: {} }), { fields: [] });
});

test("a request keeps the server, the message and, for a page, its address", () => {
  const form = elicitInfo({ serverName: "github", message: "Pick a repo", requestedSchema: SCHEMA, displayName: "GitHub" });
  assert.equal(form.server, "github");
  assert.equal(form.title, "GitHub");
  assert.equal(form.mode, "form");
  assert.equal(form.fields?.length, 11);
  const page = elicitInfo({ serverName: "auth", message: "Sign in", mode: "url", url: "https://example.com/login", elicitationId: "e1" } as never);
  assert.deepEqual(page, { server: "auth", message: "Sign in", mode: "url", url: "https://example.com/login" });
  assert.equal(elicitInfo({ serverName: "auth", message: "", mode: "url" }).unsupported, true);
});

test("each value is checked against its field", () => {
  const f = Object.fromEntries(elicitFields(SCHEMA).fields.map((x) => [x.key, x]));
  assert.equal(fieldProblem(f.name, undefined), "required");
  assert.equal(fieldProblem(f.name, ""), "required");
  assert.equal(fieldProblem(f.name, "a"), "short");
  assert.equal(fieldProblem(f.name, "abcdef"), "long");
  assert.equal(fieldProblem(f.name, "가나다"), undefined);
  assert.equal(fieldProblem(f.name, 5), "type");
  assert.equal(fieldProblem(f.email, undefined), undefined);
  assert.equal(fieldProblem(f.email, "a@b.co"), undefined);
  assert.equal(fieldProblem(f.email, "a@b"), "format");
  assert.equal(fieldProblem(f.site, "https://x.dev/a?b=1"), undefined);
  assert.equal(fieldProblem(f.site, "not a url"), "format");
  assert.equal(fieldProblem(f.day, "2026-02-28"), undefined);
  assert.equal(fieldProblem(f.day, "2026-02-30"), "format");
  assert.equal(fieldProblem(f.at, "2026-10-14T09:30:00Z"), undefined);
  assert.equal(fieldProblem(f.at, "2026-10-14T09:30:00.5+09:00"), undefined);
  assert.equal(fieldProblem(f.at, "2026-10-14T09:30"), "format");
  assert.equal(fieldProblem(f.age, 30), undefined);
  assert.equal(fieldProblem(f.age, 1.5), "type");
  assert.equal(fieldProblem(f.age, -1), "small");
  assert.equal(fieldProblem(f.age, 151), "large");
  assert.equal(fieldProblem(f.age, "30"), "type");
  assert.equal(fieldProblem(f.ratio, 0.5), undefined);
  assert.equal(fieldProblem(f.ratio, Number.NaN), "type");
  assert.equal(fieldProblem(f.ok, "true"), "type");
  assert.equal(fieldProblem(f.size, "m"), undefined);
  assert.equal(fieldProblem(f.size, "Medium"), "choice");
  assert.equal(fieldProblem(f.tags, ["a", "c"]), undefined);
  assert.equal(fieldProblem(f.tags, []), "few");
  assert.equal(fieldProblem(f.tags, ["a", "b", "c"]), "many");
  assert.equal(fieldProblem(f.tags, ["a", "a"]), "choice");
  assert.equal(fieldProblem(f.tags, ["z"]), "choice");
});

test("an answer goes back only with the form's own fields, each valid", () => {
  const info = elicitInfo({ serverName: "s", message: "m", requestedSchema: SCHEMA });
  assert.deepEqual(elicitContent(info, { name: "abc", age: 3, size: "s", ok: false, email: "" }), { name: "abc", age: 3, size: "s", ok: false });
  assert.throws(() => elicitContent(info, { name: "abc", age: 3 }), /size required/);
  assert.throws(() => elicitContent(info, { name: "abc", age: 3, size: "s", extra: 1 }), /unknown field extra/);
  assert.throws(() => elicitContent(info, [1]), /invalid answer/);
  const named = elicitInfo({ serverName: "s", message: "m", requestedSchema: { type: "object", properties: { constructor: { type: "string" } } } });
  assert.deepEqual(elicitContent(named, {}), {});
  assert.deepEqual(elicitContent(named, { constructor: "x" }), { constructor: "x" });
  assert.deepEqual(elicitResult(info, "decline", { name: "ignored" }), { action: "decline" });
  assert.deepEqual(elicitResult(info, "cancel", undefined), { action: "cancel" });
  assert.throws(() => elicitResult(info, "allow", {}), /invalid answer/);
  const page: ElicitInfo = { server: "s", message: "m", mode: "url", url: "https://e.x" };
  assert.deepEqual(elicitResult(page, "accept", { a: 1 }), { action: "accept" });
  const odd: ElicitInfo = { server: "s", message: "m", mode: "form", fields: [], unsupported: true };
  assert.throws(() => elicitResult(odd, "accept", {}), /cannot be filled/);
  assert.deepEqual(elicitResult(odd, "decline", {}), { action: "decline" });
});

type Elicit = (request: Record<string, unknown>, opts: { signal: AbortSignal; requestId: string }) => Promise<unknown>;

function session() {
  const s = new BrokerSession(SID, "/tmp/project");
  const events: string[] = [];
  s.on("pending_add", (r: PendingRequest) => events.push(`add ${r.id} ${r.kind} ${r.toolName}`));
  s.on("pending_remove", (id: string) => events.push(`remove ${id}`));
  (s as unknown as { q: unknown }).q = { interrupt: async () => void events.push("interrupt"), close: () => {} };
  const elicit = (id: string, request: Record<string, unknown> = { serverName: "srv", message: "Who?", requestedSchema: SCHEMA }) => {
    const ac = new AbortController();
    const p = ((s as unknown as { onElicitation: Elicit }).onElicitation)(request, { signal: ac.signal, requestId: id });
    return { p, ac };
  };
  return { s, events, elicit };
}

test("an MCP input request waits as a pending request and is answered once", async () => {
  const { s, events, elicit } = session();
  const { p } = elicit("r1");
  const req = s.pending.get("r1")!.request;
  assert.equal(req.kind, "elicitation");
  assert.equal(req.elicitation?.server, "srv");
  await assert.rejects(s.answer("r1", { kind: "elicitation", action: "accept", content: { name: "x" } }), /name short/);
  assert.ok(s.pending.has("r1"));
  await assert.rejects(s.answer("r1", { kind: "permission", decision: "allow" }), /does not match/);
  await s.answer("r1", { kind: "elicitation", action: "accept", content: { name: "Kim", age: 40, size: "m" } });
  assert.deepEqual(await p, { action: "accept", content: { name: "Kim", age: 40, size: "m" } });
  await assert.rejects(s.answer("r1", { kind: "elicitation", action: "decline" }), /no longer pending/);
  assert.deepEqual(events, ["add r1 elicitation srv", "remove r1"]);
});

test("an MCP input request ends with a cancel when Claude Code drops it, the turn is interrupted or time runs out", async () => {
  const { s, events, elicit } = session();
  const a = elicit("a");
  a.ac.abort();
  assert.deepEqual(await a.p, { action: "cancel" });
  const b = elicit("b");
  await s.interrupt();
  assert.deepEqual(await b.p, { action: "cancel" });
  s.elicitMs = 20;
  const c = elicit("c");
  const hold = setTimeout(() => {}, 1000);
  assert.deepEqual(await c.p, { action: "cancel" });
  clearTimeout(hold);
  assert.equal(s.pending.size, 0);
  assert.deepEqual(events, ["add a elicitation srv", "remove a", "add b elicitation srv", "interrupt", "remove b", "add c elicitation srv", "remove c"]);
});

test("closing the session cancels its MCP input requests", async () => {
  const { s, elicit } = session();
  const { p } = elicit("r1", { serverName: "auth", message: "Sign in", mode: "url", url: "https://example.com" });
  assert.equal(s.pending.get("r1")!.request.elicitation?.mode, "url");
  await s.close("test");
  assert.deepEqual(await p, { action: "cancel" });
  assert.equal(s.pending.size, 0);
});

test("the audit log keeps the server and the action of an MCP input answer, never the values", async () => {
  const logged: unknown[] = [];
  const answered: unknown[] = [];
  const manager = Object.assign(new EventEmitter(), {
    setViewed() {},
    pendingRequest: (_s: string, id: string) => (id === "r1" ? { elicitation: { server: "srv" } } : undefined),
    answer: async (...a: unknown[]) => void answered.push(a),
  });
  const leases = Object.assign(new EventEmitter(), { validate: () => true }) as unknown as Leases;
  const audit = { log: (event: string, detail: unknown) => logged.push([event, detail]) } as unknown as Audit;
  const hub = new Hub(manager as unknown as SessionManager, leases, audit, new Uploads(tempDir()));
  const ws = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, send() {}, ping() {}, close() {}, terminate() {} });
  hub.attach(ws as never, "phone", "token");
  const answer = { kind: "elicitation", action: "accept", content: { password: "hunter2" } };
  ws.emit("message", JSON.stringify({ t: "answer", sessionId: SID, requestId: "r1", answer }));
  await new Promise((r) => setTimeout(r, 10));
  hub.close();
  assert.deepEqual(logged, [["answer", { device: "phone", sessionId: SID, kind: "elicitation", action: "accept", server: "srv" }]]);
  assert.ok(!JSON.stringify(logged).includes("hunter2"));
  assert.equal(answered.length, 1);
});
