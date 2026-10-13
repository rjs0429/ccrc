import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { after, test } from "node:test";
import { LineSplitter, parseLine } from "../src/link/lines.ts";
import { LinkServer, type Link } from "../src/link/server.ts";
import type { PendingRequest } from "../src/protocol.ts";
import { WrappedSession } from "../src/sessions/wrapped.ts";
import { tempDir } from "./helpers.ts";

type Msg = Record<string, unknown>;
const SID = "0b7cf2a4-2f5e-4c39-9a51-3f1c2a9d8e11";

// Plays the wrapper side of one link.
class FakeWrapper {
  sock: net.Socket;
  frames: Msg[] = [];
  private waiters: { pred: (f: Msg) => boolean; resolve: (f: Msg) => void }[] = [];

  constructor(sock: net.Socket) {
    this.sock = sock;
    const split = new LineSplitter((line) => {
      const f = parseLine(line);
      if (!f) return;
      this.frames.push(f);
      for (const w of [...this.waiters]) {
        if (w.pred(f)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(f);
        }
      }
    });
    sock.on("data", (c: Buffer) => split.push(c));
  }

  send(frame: Msg): void {
    this.sock.write(JSON.stringify(frame) + "\n");
  }

  out(m: Msg): void {
    this.send({ m, t: "out" });
  }

  wait(pred: (f: Msg) => boolean, label: string): Promise<Msg> {
    const hit = this.frames.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`timed out waiting for ${label}`)), 3000);
      this.waiters.push({ pred, resolve: (f) => (clearTimeout(timer), resolve(f)) });
    });
  }

  // Answers broker control requests the way Claude Code would.
  autoReply(fn: (request: Msg) => Msg | Error): void {
    const handled = new Set<unknown>();
    this.sock.on("data", () => {
      for (const f of this.frames) {
        const m = f.m as Msg | undefined;
        if (f.t !== "to_cli" || m?.type !== "control_request" || handled.has(m.request_id)) continue;
        handled.add(m.request_id);
        const r = fn(m.request as Msg);
        const response =
          r instanceof Error
            ? { subtype: "error", request_id: m.request_id, error: r.message }
            : { subtype: "success", request_id: m.request_id, response: r };
        this.send({ m: { type: "control_response", response }, t: "reply" });
      }
    });
  }
}

const servers: LinkServer[] = [];
after(async () => {
  for (const s of servers) await s.close();
});

async function connect(): Promise<{ link: Link; wrapper: FakeWrapper }> {
  const server = new LinkServer(path.join(tempDir(), "link.sock"));
  servers.push(server);
  await server.listen();
  const linked = new Promise<Link>((resolve) => server.once("link", resolve));
  const sock = net.createConnection(server.socketPath);
  await new Promise((r) => sock.once("connect", r));
  const wrapper = new FakeWrapper(sock);
  const link = await linked;
  const hello = new Promise((r) => link.once("hello", r));
  wrapper.send({ t: "hello", v: 1, wpid: 4242, cwd: "/tmp/project", args: ["--resume", SID], sessionId: SID });
  await hello;
  return { link, wrapper };
}

async function session(opts: { seed?: boolean } = {}) {
  const { link, wrapper } = await connect();
  const s = new WrappedSession(link, SID, "/tmp/project");
  link.on("out", (m: Msg) => s.onOut(m));
  link.on("in", (m: Msg) => s.onIn(m));
  link.on("settled", (id: unknown) => s.onSettled(id));
  if (opts.seed !== false) s.seed([]);
  const events: [string, unknown[]][] = [];
  for (const ev of ["item", "pending_add", "pending_remove", "state", "models", "closed"]) {
    s.on(ev, (...a: unknown[]) => events.push([ev, a]));
  }
  const next = (ev: string) => new Promise<unknown[]>((resolve) => s.once(ev, (...a: unknown[]) => resolve(a)));
  return { s, link, wrapper, events, next };
}

const ask = (id: string, extra: Msg = {}) => ({
  type: "control_request",
  request_id: id,
  request: { subtype: "can_use_tool", tool_name: "Write", input: { file_path: "a.txt", content: "hi" }, tool_use_id: `toolu_${id}`, ...extra },
});

test("a line naming a new session is announced once per session", async () => {
  const { link, wrapper } = await connect();
  const seen: string[] = [];
  link.on("session", (id: string) => seen.push(id));
  const outs = new Promise((r) => {
    let n = 0;
    link.on("out", () => ++n === 3 && r(n));
  });
  wrapper.out({ type: "system", subtype: "init", session_id: SID });
  wrapper.out({ type: "system", subtype: "init", session_id: "other-session" });
  wrapper.out({ type: "assistant", session_id: "other-session" });
  await outs;
  assert.deepEqual(seen, ["other-session"]);
});

test("init and status lines set model and mode; VS Code's own changes are tracked", async () => {
  const { s, wrapper, next } = await session();
  const st = next("state");
  wrapper.out({ type: "system", subtype: "init", session_id: SID, model: "claude-haiku-5-5", permissionMode: "default" });
  await st;
  assert.equal(s.model, "claude-haiku-5-5");
  assert.equal(s.permissionMode, "default");
  const st2 = next("state");
  wrapper.send({ m: { type: "control_request", request_id: "vs-1", request: { subtype: "set_model", model: "sonnet" } }, t: "in" });
  await st2;
  assert.equal(s.model, "sonnet");
  const st3 = next("state");
  wrapper.out({ type: "system", subtype: "status", status: null, permissionMode: "plan", session_id: SID });
  await st3;
  assert.equal(s.state().permissionMode, "plan");
  assert.equal(s.state().state, "attached");
  assert.equal(s.state().host, "VS Code");
});

test("a prompt answered remotely goes back as VS Code would answer it", async () => {
  const { s, wrapper, next } = await session();
  const added = next("pending_add");
  wrapper.out(ask("p1", { permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] }));
  const [request] = (await added) as [PendingRequest];
  assert.equal(request.kind, "permission");
  assert.equal(request.allowAlways, true);
  await s.answer("p1", { kind: "permission", decision: "allow_always" });
  const f = await wrapper.wait((x) => x.t === "to_cli" && (x.m as Msg).type === "control_response", "answer frame");
  const response = (f.m as Msg).response as Msg;
  assert.equal(response.request_id, "p1");
  assert.deepEqual(response.response, {
    behavior: "allow",
    updatedInput: { file_path: "a.txt", content: "hi" },
    updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    toolUseID: "toolu_p1",
  });
  assert.equal(s.pending.size, 0);
});

test("a prompt answered in VS Code disappears remotely", async () => {
  const { s, wrapper, next } = await session();
  const added = next("pending_add");
  wrapper.out(ask("p2"));
  await added;
  const removed = next("pending_remove");
  wrapper.send({ t: "settled", id: "p2", by: "host" });
  assert.deepEqual(await removed, ["p2"]);
  await assert.rejects(s.answer("p2", { kind: "permission", decision: "allow" }), /no longer pending/);
});

test("a withdrawn prompt disappears", async () => {
  const { s, wrapper, next } = await session();
  const added = next("pending_add");
  wrapper.out(ask("p3"));
  await added;
  const removed = next("pending_remove");
  wrapper.out({ type: "control_cancel_request", request_id: "p3" });
  await removed;
  assert.equal(s.pending.size, 0);
});

test("questions are answered with the chosen labels", async () => {
  const { s, wrapper, next } = await session();
  const added = next("pending_add");
  wrapper.out({
    type: "control_request",
    request_id: "q1",
    request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [{ question: "Color?" }] }, tool_use_id: "toolu_q", requires_user_interaction: true },
  });
  const [request] = (await added) as [PendingRequest];
  assert.equal(request.kind, "question");
  assert.equal(request.localOnly, undefined);
  await s.answer("q1", { kind: "question", answers: { "Color?": "Blue" } });
  const f = await wrapper.wait((x) => x.t === "to_cli" && (x.m as Msg).type === "control_response", "answer frame");
  const r = ((f.m as Msg).response as Msg).response as Msg;
  assert.deepEqual((r.updatedInput as Msg).answers, { "Color?": "Blue" });
});

test("plan approval switches the mode first, falling back from auto to acceptEdits", async () => {
  const { s, wrapper, next } = await session();
  const modes: string[] = [];
  wrapper.autoReply((r) => {
    if (r.subtype !== "set_permission_mode") return {};
    modes.push(String(r.mode));
    return r.mode === "auto" ? Error("auto mode is unavailable") : {};
  });
  const added = next("pending_add");
  wrapper.out({
    type: "control_request",
    request_id: "plan1",
    request: { subtype: "can_use_tool", tool_name: "ExitPlanMode", input: { plan: "1. do it" }, tool_use_id: "toolu_plan", requires_user_interaction: true },
  });
  await added;
  await s.answer("plan1", { kind: "plan", decision: "auto" });
  assert.deepEqual(modes, ["auto", "acceptEdits"]);
  assert.equal(s.permissionMode, "acceptEdits");
  const f = await wrapper.wait((x) => x.t === "to_cli" && (x.m as Msg).type === "control_response", "plan answer");
  assert.equal((((f.m as Msg).response as Msg).response as Msg).behavior, "allow");
});

test("a prompt Claude Code shows only locally cannot be answered remotely", async () => {
  const { s, wrapper, next } = await session();
  const added = next("pending_add");
  wrapper.out(ask("p4", { requires_user_interaction: true }));
  const [request] = (await added) as [PendingRequest];
  assert.equal(request.localOnly, true);
  await assert.rejects(s.answer("p4", { kind: "permission", decision: "allow" }), /only be answered where the session is open/);
});

test("remote input goes in as a VS Code user message and shows at once", async () => {
  const { s, wrapper, next } = await session();
  const item = next("item");
  s.send("hello from the phone");
  const [shown] = (await item) as [{ kind: string; id: string; text: string }];
  assert.equal(shown.kind, "user");
  const f = await wrapper.wait((x) => x.t === "to_cli" && (x.m as Msg).type === "user", "user frame");
  const m = f.m as Msg;
  assert.equal(m.uuid, shown.id);
  assert.equal(m.session_id, "");
  assert.equal(m.parent_tool_use_id, null);
  assert.deepEqual(m.origin, { kind: "human" });
  assert.deepEqual(m.message, { role: "user", content: [{ type: "text", text: "hello from the phone" }] });
  assert.equal(s.busy, true);
});

test("control requests resolve with Claude Code's reply and fail on errors", async () => {
  const { s, wrapper } = await session();
  wrapper.autoReply((r) => (r.subtype === "set_model" && r.model === "bad" ? Error("unknown model") : {}));
  await s.setModel("sonnet");
  assert.equal(s.model, "sonnet");
  await assert.rejects(s.setModel("bad"), /unknown model/);
  await s.setEffort("high");
  assert.equal(s.effort, "high");
  await assert.rejects(s.setMode("bypassPermissions" as never), /not available remotely/);
});

test("turn state follows session_state_changed and result", async () => {
  const { s, wrapper, next } = await session();
  wrapper.autoReply((r) => (r.subtype === "get_context_usage" ? { percentage: 41.6 } : {}));
  let st = next("state");
  wrapper.out({ type: "system", subtype: "session_state_changed", state: "running", session_id: SID });
  await st;
  assert.equal(s.busy, true);
  wrapper.out({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.25, session_id: SID });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.busy, false);
  assert.equal(s.costUsd, 0.25);
  assert.equal(s.contextPercent, 42);
  st = next("state");
  wrapper.out({ type: "system", subtype: "session_state_changed", state: "requires_action", session_id: SID });
  await st;
  assert.equal(s.busy, true);
});

test("lines that arrive while the history loads are applied after it", async () => {
  const { s, wrapper, next } = await session({ seed: false });
  const arrived = new Promise((r) => s.link.once("out", r));
  wrapper.out({ type: "assistant", uuid: "live-1", session_id: SID, message: { content: [{ type: "text", text: "live" }] } });
  await arrived;
  assert.equal(s.builder.items.length, 0);
  const item = next("item");
  s.seed([{ kind: "user", id: "old-1", text: "earlier" }]);
  await item;
  assert.deepEqual(
    s.builder.items.map((i) => i.id),
    ["old-1", "live-1:0"],
  );
});

test("the models in VS Code's initialize answer are offered", async () => {
  const { wrapper, next } = await session();
  const models = next("models");
  wrapper.out({ type: "control_response", response: { subtype: "success", request_id: "init-1", response: { models: [{ value: "default" }], current_permission_mode: "auto" } } });
  const [list] = (await models) as [unknown[]];
  assert.equal(list.length, 1);
});

test("a prompt VS Code answers while the history loads does not reappear", async () => {
  const { s, wrapper } = await session({ seed: false });
  const arrived = new Promise((r) => s.link.once("settled", r));
  wrapper.out(ask("p9"));
  wrapper.send({ t: "settled", id: "p9", by: "host" });
  await arrived;
  s.seed([]);
  assert.equal(s.pending.size, 0);
});

test("VS Code settings that arrive while the history loads apply in order", async () => {
  const { s, wrapper } = await session({ seed: false });
  const arrived = new Promise((r) => s.link.once("in", r));
  wrapper.out({ type: "system", subtype: "init", session_id: SID, model: "model-a" });
  wrapper.send({ m: { type: "control_request", request_id: "vs-2", request: { subtype: "set_model", model: "model-b" } }, t: "in" });
  await arrived;
  s.seed([]);
  assert.equal(s.model, "model-b");
});

test("dialogs show remotely but are answered only in VS Code", async () => {
  const { s, wrapper, next } = await session();
  const added = next("pending_add");
  wrapper.out({ type: "control_request", request_id: "d1", request: { subtype: "request_user_dialog", dialog_kind: "fable_overage_consent_prompt", payload: { a: 1 } } });
  const [request] = (await added) as [PendingRequest];
  assert.equal(request.kind, "dialog");
  assert.equal(request.localOnly, true);
  assert.equal(request.toolName, "fable_overage_consent_prompt");
  await assert.rejects(s.answer("d1", { kind: "permission", decision: "allow" }), /only be answered where the session is open/);
  const removed = next("pending_remove");
  wrapper.send({ t: "settled", id: "d1", by: "host" });
  await removed;
});

test("approving a plan with manual or edit approval sends the mode with the answer", async () => {
  const { s, wrapper, next } = await session();
  const added = next("pending_add");
  wrapper.out({
    type: "control_request",
    request_id: "plan2",
    request: { subtype: "can_use_tool", tool_name: "ExitPlanMode", input: { plan: "x" }, tool_use_id: "toolu_p2", requires_user_interaction: true },
  });
  await added;
  await s.answer("plan2", { kind: "plan", decision: "acceptEdits" });
  const f = await wrapper.wait((x) => x.t === "to_cli" && (x.m as Msg).type === "control_response", "plan answer");
  const r = ((f.m as Msg).response as Msg).response as Msg;
  assert.deepEqual(r.updatedPermissions, [{ type: "setMode", mode: "acceptEdits", destination: "session" }]);
  assert.ok(!wrapper.frames.some((x) => x.t === "to_cli" && (x.m as Msg).type === "control_request"), "no separate mode request");
  assert.equal(s.permissionMode, "acceptEdits");
});

test("a plan approved to auto after VS Code already answered reports the loss", async () => {
  const { s, wrapper, next } = await session();
  wrapper.autoReply(() => {
    wrapper.send({ t: "settled", id: "plan3", by: "host" });
    return {};
  });
  const added = next("pending_add");
  wrapper.out({
    type: "control_request",
    request_id: "plan3",
    request: { subtype: "can_use_tool", tool_name: "ExitPlanMode", input: { plan: "x" }, tool_use_id: "toolu_p3", requires_user_interaction: true },
  });
  await added;
  await assert.rejects(s.answer("plan3", { kind: "plan", decision: "auto" }), /no longer pending/);
  assert.ok(!wrapper.frames.some((x) => x.t === "to_cli" && (x.m as Msg).type === "control_response"), "no answer sent");
});

test("a queued turn shows as running from its init until its result", async () => {
  const { s, wrapper, next } = await session();
  let st = next("state");
  wrapper.out({ type: "result", subtype: "success", is_error: false, session_id: SID });
  await st;
  assert.equal(s.busy, false);
  st = next("state");
  wrapper.out({ type: "system", subtype: "init", session_id: SID, model: "m" });
  await st;
  assert.equal(s.busy, true);
});
