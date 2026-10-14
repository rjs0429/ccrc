import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { after, test } from "node:test";
import { LineSplitter, parseLine } from "../src/link/lines.ts";
import { LinkServer, type Link } from "../src/link/server.ts";
import type { Answer, PendingRequest } from "../src/protocol.ts";
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

test("model, effort and ultracode follow the applied settings, and effort changes keep ultracode on", async () => {
  const { s, wrapper, next } = await session();
  const seen: Msg[] = [];
  let applied: Msg = { model: "claude-opus-5-5", effort: "xhigh", ultracode: true, ultracodeAvailable: true };
  wrapper.autoReply((r) => (seen.push(r), r.subtype === "get_settings" ? { applied } : {}));
  const st = next("state");
  wrapper.out({ type: "control_response", response: { subtype: "success", request_id: "vs-1", response: { applied } } });
  await st;
  assert.equal(s.model, "claude-opus-5-5");
  assert.equal(s.effort, "xhigh");
  assert.equal(s.state().ultracode, true);
  assert.equal(s.state().ultracodeAvailable, true);
  await s.setEffort("high");
  assert.deepEqual(seen.find((r) => r.subtype === "apply_flag_settings")?.settings, { effortLevel: "high", ultracode: true });
  applied = { model: "claude-opus-5-5", effort: "high", ultracode: false, ultracodeAvailable: true };
  await s.setUltracode(false);
  for (let i = 0; i < 50 && s.state().ultracode; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen.filter((r) => r.subtype === "apply_flag_settings").at(-1)?.settings, { ultracode: null });
  assert.equal(s.state().ultracode, false);
  seen.length = 0;
  await s.setEffort("low");
  assert.deepEqual(seen.find((r) => r.subtype === "apply_flag_settings")?.settings, { effortLevel: "low" });
  applied = { model: "claude-haiku-4-5", effort: null, ultracode: false, ultracodeAvailable: false };
  await s.setModel("haiku");
  for (let i = 0; i < 50 && (s.model as string) === "haiku"; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.model, "claude-haiku-4-5");
  assert.equal(s.effort, undefined, "a model without effort levels has no effort");
  await assert.rejects(s.setUltracode(true), /not available/);
});

test("a wrapper too old for get_settings marks the applied state unknown until VS Code's answer passes", async () => {
  const { s, wrapper } = await session();
  wrapper.sock.on("data", () => {
    for (const f of wrapper.frames) {
      const m = f.m as Msg | undefined;
      if (f.t === "to_cli" && m?.type === "control_request" && !f.answered) {
        f.answered = true;
        wrapper.send({ t: "rejected", id: m.request_id, reason: "request not allowed" });
      }
    }
  });
  wrapper.out({ type: "control_response", response: { subtype: "success", request_id: "init", response: { models: [{ value: "default" }] } } });
  for (let i = 0; i < 50 && !s.state().appliedUnknown; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.state().appliedUnknown, true);
  assert.equal(s.state().ultracodeAvailable, undefined);
  wrapper.out({ type: "control_response", response: { subtype: "success", request_id: "vs-1", response: { applied: { effort: "high", ultracode: false, ultracodeAvailable: true } } } });
  for (let i = 0; i < 50 && s.state().appliedUnknown; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.state().appliedUnknown, undefined);
  assert.equal(s.state().ultracodeAvailable, true);
});

test("turn state follows session_state_changed and result", async () => {
  const { s, wrapper, next } = await session();
  wrapper.autoReply((r) =>
    r.subtype === "get_context_usage" ? { percentage: 41.6, totalTokens: 416, maxTokens: 1000, autoCompactThreshold: 967, isAutoCompactEnabled: true } : {},
  );
  let st = next("state");
  wrapper.out({ type: "system", subtype: "session_state_changed", state: "running", session_id: SID });
  await st;
  assert.equal(s.busy, true);
  wrapper.out({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.25, session_id: SID });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.busy, false);
  assert.equal(s.costUsd, 0.25);
  assert.deepEqual(s.context, { percent: 42, tokens: 416, max: 1000, autoCompactAt: 967 });
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

test("approving a plan never switches to a mode the remote side may not pick", async () => {
  const { s, wrapper, next } = await session();
  const added = next("pending_add");
  wrapper.out({
    type: "control_request",
    request_id: "plan4",
    request: { subtype: "can_use_tool", tool_name: "ExitPlanMode", input: { plan: "x" }, tool_use_id: "toolu_p4", requires_user_interaction: true },
  });
  await added;
  for (const decision of ["bypassPermissions", "dontAsk", "plan"]) {
    await assert.rejects(s.answer("plan4", { kind: "plan", decision } as unknown as Answer), /invalid answer/, decision);
  }
  await s.answer("plan4", { kind: "plan", decision: "default" });
  const f = await wrapper.wait((x) => x.t === "to_cli" && (x.m as Msg).type === "control_response", "plan answer");
  assert.deepEqual((((f.m as Msg).response as Msg).response as Msg).updatedPermissions, [{ type: "setMode", mode: "default", destination: "session" }]);
  assert.equal(s.permissionMode, "default");
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

const MSG = "6a1f3c2e-8b4d-4e5f-9a0b-1c2d3e4f5a6b";

test("context details ask for the full count and map Claude Code's answer", async () => {
  const { s, wrapper } = await session();
  const seen: Msg[] = [];
  wrapper.autoReply((r) => {
    seen.push(r);
    return {
      categories: [
        { name: "System prompt", tokens: 3178, color: "promptBorder", kind: "used" },
        { name: "System tools (deferred)", tokens: 22048, color: "inactive", isDeferred: true, kind: "deferred" },
        { name: "Autocompact buffer", tokens: 33000, color: "inactive", kind: "buffer" },
        { name: "Free space", tokens: 938439, color: "promptBorder", kind: "free" },
        { name: "Old CLI row", tokens: 5, isDeferred: true },
      ],
      totalTokens: 28561,
      maxTokens: 1_000_000,
      rawMaxTokens: 1_000_000,
      percentage: 2.9,
      model: "claude-haiku-5-5",
      gridRows: [[{ color: "x" }]],
      memoryFiles: [{ path: "/home/u/CLAUDE.md", type: "User", tokens: 10 }],
    };
  });
  const detail = await s.contextDetail();
  assert.deepEqual(seen, [{ subtype: "get_context_usage", detail: "full" }]);
  assert.deepEqual(detail, {
    percentage: 2.9,
    totalTokens: 28561,
    maxTokens: 1_000_000,
    model: "claude-haiku-5-5",
    categories: [
      { name: "System prompt", tokens: 3178, kind: "used" },
      { name: "System tools (deferred)", tokens: 22048, kind: "deferred" },
      { name: "Autocompact buffer", tokens: 33000, kind: "buffer" },
      { name: "Free space", tokens: 938439, kind: "free" },
      { name: "Old CLI row", tokens: 5, kind: "deferred" },
    ],
  });
  assert.equal(s.state().context?.percent, 3);
});

test("a local command's result marks the turn as local until a model turn ends", async () => {
  const { s, wrapper } = await session();
  wrapper.autoReply(() => ({}));
  wrapper.out({ type: "result", subtype: "success", is_error: false, num_turns: 0, local_command: "compact", session_id: SID });
  for (let i = 0; i < 50 && !s.localTurn; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.localTurn, true);
  wrapper.out({ type: "result", subtype: "success", is_error: false, session_id: SID });
  for (let i = 0; i < 50 && s.localTurn; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.localTurn, false);
});

test("MCP servers are listed without VS Code's own and changed only by a name Claude Code reported", async () => {
  const { s, wrapper } = await session();
  const seen: Msg[] = [];
  wrapper.autoReply((r) => {
    seen.push(r);
    if (r.subtype !== "mcp_status") return {};
    return {
      mcpServers: [
        { name: "claude-vscode", status: "connected", scope: "dynamic", tools: [{ name: "getDiagnostics" }] },
        { name: "github", status: "connected", scope: "user", tools: [{ name: "a" }, { name: "b" }], config: { type: "http", url: "https://example.com" } },
        { name: "db", status: "failed", scope: "project", error: "spawn db-server ENOENT" },
        { name: "claude.ai Drive", status: "needs-auth", source: "claudeai" },
      ],
    };
  });
  const servers = [
    { name: "github", status: "connected", scope: "user", tools: 2 },
    { name: "db", status: "failed", error: "spawn db-server ENOENT", scope: "project" },
    { name: "claude.ai Drive", status: "needs-auth", scope: "claudeai" },
  ];
  assert.deepEqual(await s.mcpStatus(), servers);
  seen.length = 0;
  assert.deepEqual(await s.mcpToggle("github", false), servers);
  assert.deepEqual(seen, [{ subtype: "mcp_status" }, { subtype: "mcp_toggle", serverName: "github", enabled: false }, { subtype: "mcp_status" }]);
  seen.length = 0;
  await s.mcpReconnect("claude.ai Drive");
  assert.deepEqual(seen[1], { subtype: "mcp_reconnect", serverName: "claude.ai Drive" });
  seen.length = 0;
  await assert.rejects(s.mcpToggle("claude-vscode", false), /unknown MCP server/);
  await assert.rejects(s.mcpReconnect("other"), /unknown MCP server/);
  await assert.rejects(s.mcpToggle("", true), /unknown MCP server/);
  await assert.rejects(s.mcpToggle("x".repeat(300), true), /unknown MCP server/);
  assert.deepEqual(
    seen.map((r) => r.subtype),
    ["mcp_status", "mcp_status"],
  );
});

test("file rewind previews and applies only for a message of this session", async () => {
  const { s, wrapper, next } = await session({ seed: false });
  s.seed([{ kind: "user", id: MSG, text: "edit the file" }]);
  const seen: Msg[] = [];
  wrapper.autoReply((r) => {
    seen.push(r);
    return r.dry_run ? { canRewind: true, filesChanged: ["/tmp/project/a.txt"], insertions: 1, deletions: 2 } : { canRewind: true, skippedLinks: 0 };
  });
  assert.deepEqual(await s.rewind(MSG, true), { canRewind: true, filesChanged: ["/tmp/project/a.txt"], insertions: 1, deletions: 2 });
  assert.deepEqual(seen.at(-1), { subtype: "rewind_files", user_message_id: MSG, dry_run: true });
  assert.deepEqual(await s.rewind(MSG, false), { canRewind: true });
  assert.deepEqual(seen.at(-1), { subtype: "rewind_files", user_message_id: MSG, dry_run: false });
  await assert.rejects(s.rewind("6a1f3c2e-8b4d-4e5f-9a0b-000000000000", true), /unknown message/);
  await assert.rejects(s.rewind("not-a-message", true), /unknown message/);
  const st = next("state");
  wrapper.out({ type: "system", subtype: "session_state_changed", state: "running", session_id: SID });
  await st;
  await assert.rejects(s.rewind(MSG, false), /session is busy/);
  await s.rewind(MSG, true);
  assert.equal(seen.length, 3);
});

test("a dry run Claude Code cannot apply comes back with its reason", async () => {
  const { s, wrapper } = await session({ seed: false });
  s.seed([{ kind: "user", id: MSG, text: "hi" }]);
  wrapper.autoReply(() => ({ canRewind: false, error: "No file checkpoint found for this message." }));
  assert.deepEqual(await s.rewind(MSG, true), { canRewind: false, error: "No file checkpoint found for this message." });
});

test("tasks follow Claude Code's task messages and leave the list a while after they end", async () => {
  const { s, wrapper, events, next } = await session();
  s.taskKeepMs = 150;
  const states = () => events.filter(([e]) => e === "state").length;
  const out = async (m: Msg) => {
    const st = next("state");
    wrapper.out({ type: "system", session_id: SID, ...m });
    await st;
  };
  await out({
    subtype: "task_started",
    task_id: "a1",
    tool_use_id: "toolu_a",
    description: "Find the tests",
    subagent_type: "Explore",
    task_type: "local_agent",
  });
  await out({ subtype: "task_started", task_id: "b2", description: "npm test", task_type: "local_bash" });
  assert.deepEqual(s.state().tasks, [
    { id: "a1", description: "Find the tests", type: "Explore", status: "running", toolUseId: "toolu_a" },
    { id: "b2", description: "npm test", type: "local_bash", status: "running" },
  ]);

  const before = states();
  wrapper.out({
    type: "system",
    subtype: "task_progress",
    task_id: "a1",
    tool_use_id: "toolu_a",
    description: "Find the tests",
    usage: { total_tokens: 5, tool_uses: 1, duration_ms: 9 },
    session_id: SID,
  });
  wrapper.out({ type: "system", subtype: "task_notification", task_id: "zz", status: "completed", output_file: "", summary: "", session_id: SID });
  await out({ subtype: "task_progress", task_id: "c3", description: "Watch the build", usage: { total_tokens: 0, tool_uses: 0, duration_ms: 0 } });
  assert.equal(states(), before + 1, "only the task first seen through its progress changed the state");
  assert.equal(s.tasks.get("c3")?.status, "running");
  assert.equal(s.tasks.has("zz"), false);

  await out({ subtype: "task_updated", task_id: "b2", patch: { status: "killed", end_time: 1 } });
  assert.equal(s.tasks.get("b2")?.status, "stopped");
  await out({ subtype: "task_notification", task_id: "a1", tool_use_id: "toolu_a", status: "completed", output_file: "/tmp/out", summary: "Found them" });
  assert.equal(s.tasks.get("a1")?.status, "completed");
  await out({ subtype: "task_updated", task_id: "c3", patch: { status: "failed", error: "boom" } });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(s.state().tasks, undefined);
});

test("Claude Code's own ambient watchers are not listed as tasks", async () => {
  const { s, wrapper, next } = await session();
  wrapper.out({ type: "system", subtype: "task_started", task_id: "w1", description: "watch", task_type: "local_bash", ambient: true, session_id: SID });
  wrapper.out({ type: "system", subtype: "task_progress", task_id: "w1", description: "watch", usage: { total_tokens: 0, tool_uses: 0, duration_ms: 0 }, session_id: SID });
  const st = next("state");
  wrapper.out({ type: "system", subtype: "task_started", task_id: "u1", description: "npm test", task_type: "local_bash", session_id: SID });
  await st;
  assert.deepEqual(s.state().tasks?.map((t) => t.id), ["u1"]);
});

test("only a running task of this session can be stopped", async () => {
  const { s, wrapper, next } = await session();
  const seen: Msg[] = [];
  wrapper.autoReply((r) => (seen.push(r), {}));
  let st = next("state");
  wrapper.out({ type: "system", subtype: "task_started", task_id: "b7", description: "sleep 100", task_type: "local_bash", session_id: SID });
  await st;
  await s.stopTask("b7");
  assert.deepEqual(seen, [{ subtype: "stop_task", task_id: "b7" }]);
  await assert.rejects(s.stopTask("b8"), /task is not running/);
  st = next("state");
  wrapper.out({ type: "system", subtype: "task_notification", task_id: "b7", status: "stopped", output_file: "", summary: "", session_id: SID });
  await st;
  await assert.rejects(s.stopTask("b7"), /task is not running/);
  assert.equal(seen.length, 1);
  st = next("closed");
  s.end("vscode_closed");
  await st;
  assert.equal(s.tasks.size, 0);
  await assert.rejects(s.contextDetail(), /session closed/);
});

test("the output style follows VS Code's answers and is set only to a listed style", async () => {
  const { s, wrapper } = await session();
  const seen: Msg[] = [];
  let effective: string | undefined;
  wrapper.autoReply((r) => {
    seen.push(r);
    if (r.subtype === "update_settings") effective = (r.settings as Msg).outputStyle as string;
    return r.subtype === "get_settings" ? { applied: {}, ...(effective ? { outputStyle: effective } : {}), outputStyles: ["default", "Explanatory", "Mine"] } : {};
  });
  wrapper.out({
    type: "control_response",
    response: { subtype: "success", request_id: "init", response: { models: [], commands: [], output_style: "default", available_output_styles: ["default", "Explanatory"] } },
  });
  for (let i = 0; i < 50 && !s.outputStyles; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.state().outputStyle, "default");
  assert.deepEqual(await s.outputStyleInfo(), { current: "default", available: ["default", "Explanatory", "Mine"] });
  await assert.rejects(s.setOutputStyle("Pirate"), /unknown output style/);
  assert.ok(!seen.some((r) => r.subtype === "update_settings"), "an unlisted style is not sent");
  assert.deepEqual(await s.setOutputStyle("Mine"), { current: "Mine", available: ["default", "Explanatory", "Mine"] });
  assert.deepEqual(
    seen.filter((r) => r.subtype === "update_settings"),
    [{ subtype: "update_settings", source: "localSettings", settings: { outputStyle: "Mine" } }],
  );
  assert.equal(s.state().outputStyle, "Mine");
  wrapper.out({ type: "control_response", response: { subtype: "success", request_id: "vs-2", response: { applied: {}, outputStyle: "Explanatory" } } });
  for (let i = 0; i < 50 && s.outputStyle !== "Explanatory"; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.state().outputStyle, "Explanatory", "a change made in VS Code shows");
  wrapper.out({ type: "control_response", response: { subtype: "success", request_id: "vs-3", response: { applied: {} } } });
  for (let i = 0; i < 50 && s.outputStyle !== "default"; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.state().outputStyle, "default", "with no style in the settings the announced one holds");
});
