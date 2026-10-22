import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { after, test } from "node:test";
import { LineSplitter, parseLine } from "../src/link/lines.ts";
import { LinkServer, type Link } from "../src/link/server.ts";
import type { Answer, DisplayItem, PendingRequest } from "../src/protocol.ts";
import type { TurnEnd } from "../src/sessions/outcome.ts";
import { WrappedSession, thinkingArg } from "../src/sessions/wrapped.ts";
import { tempDir } from "./helpers.ts";

type Msg = Record<string, unknown>;
const SID = "0b7cf2a4-2f5e-4c39-9a51-3f1c2a9d8e11";
// The command lists sessions remember go to a folder of the test's own.
process.env.CCRC_STATE_DIR = path.join(tempDir(), "state");

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

async function connect(caps?: string[]): Promise<{ link: Link; wrapper: FakeWrapper }> {
  const server = new LinkServer(path.join(tempDir(), "link.sock"));
  servers.push(server);
  await server.listen();
  const linked = new Promise<Link>((resolve) => server.once("link", resolve));
  const sock = net.createConnection(server.socketPath);
  await new Promise((r) => sock.once("connect", r));
  const wrapper = new FakeWrapper(sock);
  const link = await linked;
  const hello = new Promise((r) => link.once("hello", r));
  wrapper.send({ t: "hello", v: 1, wpid: 4242, cwd: "/tmp/project", args: ["--resume", SID], sessionId: SID, ...(caps ? { caps } : {}) });
  await hello;
  return { link, wrapper };
}

async function session(opts: { seed?: boolean; caps?: string[] } = {}) {
  const { link, wrapper } = await connect(opts.caps);
  const s = new WrappedSession(link, SID, "/tmp/project");
  link.on("out", (m: Msg) => s.onOut(m));
  link.on("in", (m: Msg) => s.onIn(m));
  link.on("settled", (id: unknown) => s.onSettled(id));
  link.on("held", (id: unknown) => s.onHeld(id));
  link.on("rejected", (id: unknown, reason: unknown) => s.onRejected(id, reason));
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

test("remote input goes in as a VS Code user message and shows at once as queued", async () => {
  const { s, wrapper } = await session();
  s.send("hello from the phone");
  const [shown] = s.state().queued ?? [];
  assert.equal(shown?.text, "hello from the phone");
  assert.equal(shown?.from, "remote");
  assert.equal(s.builder.items.length, 0);
  const f = await wrapper.wait((x) => x.t === "to_cli" && (x.m as Msg).type === "user", "user frame");
  const m = f.m as Msg;
  assert.equal(m.uuid, shown.id);
  assert.equal(m.session_id, "");
  assert.equal(m.parent_tool_use_id, null);
  assert.deepEqual(m.origin, { kind: "human" });
  assert.deepEqual(m.message, { role: "user", content: [{ type: "text", text: "hello from the phone" }] });
  assert.equal(s.busy, true);
});

test("a message with attachments lists them while queued and on its item, sent from here or echoed from VS Code", async () => {
  const { s, wrapper, next } = await session();
  const png = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };
  const txt = { type: "document", title: "a.txt", source: { type: "text", media_type: "text/plain", data: "abc" } };
  const listed = [
    { kind: "image", mediaType: "image/png", size: 8 },
    { kind: "document", mediaType: "text/plain", size: 3, name: "a.txt" },
  ];
  s.send("see", [png, txt]);
  const [queued] = s.state().queued ?? [];
  assert.deepEqual(queued?.attachments, listed);
  const sent = next("item");
  wrapper.out({ type: "command_lifecycle", command_uuid: queued.id, state: "started", uuid: "lc-started", session_id: SID });
  const [item] = (await sent) as [DisplayItem];
  assert.deepEqual(item.kind === "user" && [item.id, item.attachments], [queued.id, listed]);
  const echoed = next("item");
  wrapper.out({ type: "user", uuid: "8f9a0b1c-0000-4000-8000-000000000001", message: { role: "user", content: [png, { type: "text", text: "from VS Code" }] } });
  const [vs] = (await echoed) as [DisplayItem];
  assert.deepEqual(vs.kind === "user" && [vs.text, vs.attachments], ["from VS Code", [{ kind: "image", mediaType: "image/png", size: 8 }]]);
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

// A VS Code session behind a wrapper whose hello carries these fields.
async function helloSession(hello: Msg) {
  const server = new LinkServer(path.join(tempDir(), "link.sock"));
  servers.push(server);
  await server.listen();
  const linked = new Promise<Link>((resolve) => server.once("link", resolve));
  const sock = net.createConnection(server.socketPath);
  await new Promise((r) => sock.once("connect", r));
  const wrapper = new FakeWrapper(sock);
  const link = await linked;
  const said = new Promise((r) => link.once("hello", r));
  wrapper.send({ t: "hello", v: 1, wpid: 4242, cwd: "/tmp/project", args: ["--resume", SID], sessionId: SID, ...hello });
  await said;
  const s = new WrappedSession(link, SID, "/tmp/project");
  link.on("out", (m: Msg) => s.onOut(m));
  link.on("in", (m: Msg) => s.onIn(m));
  s.seed([]);
  const until = async (fn: () => boolean) => {
    for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
  };
  return { s, wrapper, until };
}
const CAPS = ["fast_mode", "thinking"];
const optionRequest = (f: Msg) => {
  const r = (f.m as Msg | undefined)?.request as Msg | undefined;
  return f.t === "to_cli" && (r?.subtype === "set_max_thinking_tokens" || (r?.subtype === "apply_flag_settings" && "fastMode" in (r.settings as Msg)));
};

test("Thinking starts as VS Code launched Claude Code", () => {
  assert.equal(thinkingArg(["--max-thinking-tokens=31999"]), true);
  assert.equal(thinkingArg(["--max-thinking-tokens", "0"]), false);
  assert.equal(thinkingArg(["--thinking=disabled"]), false);
  assert.equal(thinkingArg(["--thinking", "adaptive"]), true);
  assert.equal(thinkingArg(["--resume", SID]), true);
  assert.equal(thinkingArg([1, null, "--thinking=disabled"]), false, "what is no string counts for nothing");
});

test("Thinking follows VS Code's own changes and the ones made here; Fast mode settles from VS Code's reports", async () => {
  const { s, wrapper, until } = await helloSession({ caps: CAPS, args: ["--thinking=disabled", "--resume", SID] });
  assert.equal(s.state().thinking, false);
  assert.equal(s.state().optionsUnknown, undefined);
  const think = (v: unknown) => wrapper.send({ m: { type: "control_request", request_id: "vs-t", request: { subtype: "set_max_thinking_tokens", max_thinking_tokens: v, thinking_display: "summarized" } }, t: "in" });
  think(31999);
  await until(() => s.thinking === true);
  assert.equal(s.state().thinking, true);
  think(null);
  await until(() => s.thinking === false);
  assert.equal(s.state().thinking, false, "null goes back to how it started");
  const seen: Msg[] = [];
  wrapper.autoReply((r) => (seen.push(r), {}));
  await s.setThinking(true);
  await s.setFast(true);
  assert.deepEqual(seen, [
    { subtype: "set_max_thinking_tokens", max_thinking_tokens: 31999 },
    { subtype: "apply_flag_settings", settings: { fastMode: true } },
  ]);
  assert.equal(s.state().thinking, true);
  assert.equal(s.state().fastWanted, true);
  wrapper.out({ type: "control_response", response: { subtype: "success", request_id: "init", response: { models: [{ value: "default" }], fast_mode_state: "on" } } });
  await until(() => s.fastWanted === undefined);
  assert.equal(s.state().fastMode, "on");
  assert.equal(s.state().fastWanted, undefined);
});

test("a wrapper that predates Fast mode and Thinking changes keeps Thinking as VS Code started it and is asked nothing", async () => {
  const { s, wrapper, until } = await helloSession({ args: ["--thinking=disabled", "--resume", SID] });
  assert.equal(s.state().optionsUnknown, true);
  assert.equal(s.state().thinking, false);
  wrapper.out({ type: "system", subtype: "init", session_id: SID, fast_mode_state: "on" });
  await until(() => s.fastMode === "on");
  assert.equal(s.state().fastMode, "on", "its state still shows");
  await assert.rejects(s.setFast(false), /^Error: rejected by the wrapper: request not allowed$/);
  await assert.rejects(s.setThinking(false), /request not allowed/);
  assert.ok(!wrapper.frames.some(optionRequest));
});

test("a wrapper that refuses a change after all marks Fast mode and Thinking as not to be changed here", async () => {
  const { s, wrapper } = await helloSession({ caps: CAPS });
  wrapper.sock.on("data", () => {
    for (const f of wrapper.frames) {
      const m = f.m as Msg | undefined;
      if (f.t === "to_cli" && m?.type === "control_request" && !f.answered) {
        f.answered = true;
        wrapper.send({ t: "rejected", id: m.request_id, reason: "setting not allowed" });
      }
    }
  });
  assert.equal(s.state().thinking, true);
  await assert.rejects(s.setFast(true), /request not allowed/);
  assert.equal(s.state().optionsUnknown, true);
  assert.equal(s.state().thinking, true, "Thinking stays as last known");
  assert.equal(s.state().fastWanted, undefined);
});

test("a hello whose caps or arguments are of another shape leaves the changes to VS Code", async () => {
  const { s, wrapper, until } = await helloSession({ caps: 1, args: [1, "--thinking=disabled", "--resume", SID] });
  assert.equal(s.state().optionsUnknown, true);
  assert.equal(s.state().thinking, false);
  const other = await helloSession({ caps: [1, "fast_mode"] });
  assert.equal(other.s.state().optionsUnknown, true);
  wrapper.out({ type: "system", subtype: "init", session_id: SID, fast_mode_state: "on" });
  await until(() => s.fastMode === "on");
  assert.equal(s.state().fastMode, "on", "the session goes on");
});

test("in a VS Code session the usage credits notice is noted and turning Fast mode off is left to VS Code", async () => {
  const { s, wrapper, until } = await helloSession({ caps: CAPS });
  const notes: DisplayItem[] = [];
  s.on("item", (i: DisplayItem) => i.kind === "note" && notes.push(i));
  wrapper.out({ type: "system", subtype: "init", session_id: SID, fast_mode_state: "on" });
  wrapper.out({ type: "system", subtype: "notification", key: "fast-mode-overage-rejected", text: "Fast mode disabled", session_id: SID });
  await until(() => notes.length > 0);
  assert.deepEqual(
    notes.map((n) => n.kind === "note" && [n.code, n.text]),
    [["fast", "credits"]],
  );
  assert.equal(s.state().fastCredits, true);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!wrapper.frames.some(optionRequest));
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

test("a live reply has Claude Code's time, or the time the broker received it when it comes without one", async () => {
  const { wrapper, next } = await session();
  const before = Date.now();
  let item = next("item");
  wrapper.out({ type: "assistant", uuid: "live-1", session_id: SID, message: { content: [{ type: "text", text: "no time" }] } });
  const [plain] = (await item) as [DisplayItem];
  const received = Date.parse(plain.ts ?? "");
  assert.ok(received >= before && received <= Date.now(), plain.ts);
  item = next("item");
  wrapper.out({ type: "assistant", uuid: "live-2", session_id: SID, timestamp: "2026-10-14T23:59:58.000Z", message: { content: [{ type: "text", text: "own time" }] } });
  assert.equal(((await item) as [DisplayItem])[0].ts, "2026-10-14T23:59:58.000Z");
});

test("a reply held while the history loads keeps the time it arrived", async () => {
  const { s, wrapper, next } = await session({ seed: false });
  const arrived = new Promise((r) => s.link.once("out", r));
  wrapper.out({ type: "assistant", uuid: "live-1", session_id: SID, message: { content: [{ type: "text", text: "live" }] } });
  await arrived;
  const received = Date.now();
  await new Promise((r) => setTimeout(r, 50));
  const item = next("item");
  s.seed([]);
  const [shown] = (await item) as [DisplayItem];
  assert.ok(Date.parse(shown.ts ?? "") <= received, shown.ts);
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
    memoryFiles: [{ path: "/home/u/CLAUDE.md", tokens: 10 }],
  });
  assert.equal(s.state().context?.percent, 3);
});

test("each result ends a turn, told with how it ended: a local command's, a finished one, a stopped one", async () => {
  const { s, wrapper } = await session();
  wrapper.autoReply(() => ({}));
  const ends: TurnEnd[] = [];
  s.on("turn_end", (e: TurnEnd) => ends.push(e));
  wrapper.out({ type: "result", subtype: "success", is_error: false, num_turns: 0, local_command: "compact", session_id: SID });
  wrapper.out({ type: "system", subtype: "init", session_id: SID });
  wrapper.out({ type: "result", subtype: "success", is_error: false, terminal_reason: "completed", duration_ms: 60_000, queued_turn_count: 1, session_id: SID });
  wrapper.out({ type: "system", subtype: "init", session_id: SID });
  wrapper.out({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] }, session_id: SID });
  wrapper.out({ type: "result", subtype: "error_during_execution", is_error: true, session_id: SID });
  for (let i = 0; i < 50 && ends.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(
    ends.map((e) => [e.outcome, e.attached, e.queued ?? false]),
    [
      ["local", true, false],
      ["done", true, true],
      ["interrupted", true, false],
    ],
  );
  assert.ok(Math.abs(ends[1].startedAt - (Date.now() - 60_000)) < 1000, "the start is the result's duration counted back");
});

test("the time VS Code last wrote a message goes with the turn's end; a message from here does not count", async () => {
  const { s, wrapper } = await session();
  wrapper.autoReply(() => ({}));
  const ends: TurnEnd[] = [];
  s.on("turn_end", (e: TurnEnd) => ends.push(e));
  wrapper.out({ type: "result", subtype: "success", is_error: false, session_id: SID });
  const at = "2026-10-16T01:02:03.000Z";
  wrapper.send({ m: { type: "user", uuid: "vs-1", timestamp: at, message: { role: "user", content: [{ type: "text", text: "from VS Code" }] } }, t: "in" });
  wrapper.send({ m: { type: "user", uuid: "ph-1", remote: true, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "from the phone" }] } }, t: "in" });
  wrapper.out({ type: "result", subtype: "success", is_error: false, session_id: SID });
  for (let i = 0; i < 50 && ends.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(ends[0].hostInputAt, undefined);
  assert.equal(ends[1].hostInputAt, Date.parse(at));
});

test("Claude Code ending on its own during a turn is a crash; VS Code closing it, or a wrapper that does not say, is not", async () => {
  const cases: [unknown[], string][] = [
    [[1, null, false, true], "crashed"],
    [[null, "SIGKILL", false, true], "crashed"],
    [[1, null, true, true], "vscode_closed"],
    [[null, "SIGTERM", true, true], "vscode_closed"],
    [[1, null, false, false], "vscode_closed"],
    [[0, null, false, true], "vscode_closed"],
    [[1, null], "vscode_closed"],
  ];
  for (const [[code, signal, hostLeft, running], reason] of cases) {
    const { s, wrapper } = await session();
    const ends: TurnEnd[] = [];
    s.on("turn_end", (e: TurnEnd) => ends.push(e));
    wrapper.out({ type: "system", subtype: "init", session_id: SID });
    for (let i = 0; i < 50 && !s.busy; i++) await new Promise((r) => setTimeout(r, 10));
    s.exited(code, signal, hostLeft, running);
    const label = JSON.stringify([code, signal, hostLeft, running]);
    assert.equal(s.closedReason, reason, label);
    assert.deepEqual(
      ends.map((e) => [e.outcome, e.attached]),
      reason === "crashed" ? [["crashed", true]] : [],
      label,
    );
  }
});

test("a call the auto-mode classifier handed to a person is answered here by allow or deny; other asks VS Code must answer stay there", async () => {
  const { s, wrapper } = await session();
  const added: PendingRequest[] = [];
  s.on("pending_add", (r: PendingRequest) => added.push(r));
  const suggestions = [{ type: "addRules", rules: [{ toolName: "mcp__chrome__navigate" }], behavior: "allow", destination: "localSettings" }];
  wrapper.out(
    ask("c1", { requires_user_interaction: true, decision_reason_type: "classifier", suppress_always_allow_rule: true, default_to_no: true, permission_suggestions: suggestions }),
  );
  wrapper.out(ask("c2", { requires_user_interaction: true, decision_reason_type: "classifier", permission_suggestions: suggestions }));
  wrapper.out(ask("c3", { requires_user_interaction: true, decision_reason_type: "safetyCheck" }));
  wrapper.out(ask("c4", { requires_user_interaction: true }));
  wrapper.out(ask("c5", { decision_reason_type: "classifier" }));
  for (let i = 0; i < 50 && added.length < 5; i++) await new Promise((r) => setTimeout(r, 10));
  const shown = Object.fromEntries(added.map((r) => [r.id, [r.localOnly ?? false, r.personOnly ?? false, r.defaultToNo ?? false, r.allowAlways]]));
  assert.deepEqual(shown, {
    c1: [false, true, true, false],
    c2: [false, true, false, false],
    c3: [true, false, false, false],
    c4: [true, false, false, false],
    c5: [false, false, false, false],
  });
  await assert.rejects(s.answer("c3", { kind: "permission", decision: "allow" }), /only be answered where the session is open/);
  await s.answer("c2", { kind: "permission", decision: "allow_always" });
  const f = await wrapper.wait((x) => x.t === "to_cli" && ((x.m as Msg).response as Msg | undefined)?.request_id === "c2", "answer to c2");
  assert.deepEqual(((f.m as Msg).response as Msg).response, { behavior: "allow", updatedInput: { file_path: "a.txt", content: "hi" }, toolUseID: "toolu_c2" }, "never a lasting rule");
  await s.answer("c1", { kind: "permission", decision: "deny", message: "no" });
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
    { name: "github", status: "connected", scope: "user", tools: 2, auth: "oauth" },
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
  s.tasks.keepMs = 150;
  const states = () => events.filter(([e]) => e === "state").length;
  const out = async (m: Msg) => {
    const st = next("state");
    wrapper.out({ type: "system", session_id: SID, ...m });
    await st;
  };
  const shown = () => s.state().tasks?.map(({ ms: _ms, ...t }) => t);
  await out({
    subtype: "task_started",
    task_id: "a1",
    tool_use_id: "toolu_a",
    description: "Find the tests",
    subagent_type: "Explore",
    task_type: "local_agent",
    is_backgrounded: true,
    spawn_depth: 1,
  });
  await out({ subtype: "task_started", task_id: "b2", description: "npm test", task_type: "local_bash", parent_task_id: "a1" });
  assert.deepEqual(shown(), [
    { id: "a1", description: "Find the tests", type: "Explore", kind: "local_agent", agentType: "Explore", status: "running", toolUseId: "toolu_a", depth: 1, background: true },
    { id: "b2", description: "npm test", type: "local_bash", kind: "local_bash", status: "running", parentId: "a1" },
  ]);

  const before = states();
  wrapper.out({
    type: "system",
    subtype: "task_progress",
    task_id: "a1",
    tool_use_id: "toolu_a",
    description: "Running Grep loadConfig",
    usage: { total_tokens: 5, tool_uses: 1, duration_ms: 9 },
    last_tool_name: "Grep",
    session_id: SID,
  });
  wrapper.out({ type: "system", subtype: "task_notification", task_id: "zz", status: "completed", output_file: "", summary: "", session_id: SID });
  await out({ subtype: "task_progress", task_id: "c3", description: "Watch the build", usage: { total_tokens: 0, tool_uses: 0, duration_ms: 0 } });
  assert.equal(states(), before + 1, "a new task goes out at once and carries the progress before it");
  assert.equal(s.tasks.get("c3")?.status, "running");
  assert.equal(s.tasks.has("zz"), false);
  const a1 = s.tasks.get("a1")!;
  assert.equal(a1.description, "Find the tests", "the name stays as the task started");
  assert.equal(a1.activity, "Running Grep loadConfig");
  assert.deepEqual([a1.tokens, a1.tools], [5, 1]);

  await out({ subtype: "task_updated", task_id: "b2", patch: { status: "killed", end_time: 1 } });
  assert.equal(s.tasks.get("b2")?.status, "stopped");
  await out({
    subtype: "task_notification",
    task_id: "a1",
    tool_use_id: "toolu_a",
    status: "completed",
    output_file: "/tmp/out",
    summary: "Found them",
    usage: { total_tokens: 900, tool_uses: 4, duration_ms: 61_000 },
  });
  assert.deepEqual([s.tasks.get("a1")?.status, s.tasks.get("a1")?.summary, s.tasks.get("a1")?.ms, s.tasks.get("a1")?.tokens], ["completed", "Found them", 61_000, 900]);
  await out({ subtype: "task_updated", task_id: "c3", patch: { status: "failed", error: "boom" } });
  assert.equal(s.tasks.get("c3")?.error, "boom");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(s.state().tasks, undefined);
});

test("a permission request from a subagent names it", async () => {
  const { s, wrapper, next } = await session();
  const added = next("pending_add");
  wrapper.out({
    type: "control_request",
    request_id: "perm-sub",
    request: { subtype: "can_use_tool", tool_name: "Write", input: { file_path: "/tmp/project/note.txt", content: "hi" }, tool_use_id: "toolu_w", agent_id: "a9eb6f7189f57f617" },
  });
  await added;
  assert.equal(s.pending.get("perm-sub")?.request.agentId, "a9eb6f7189f57f617");
});

test("the wrapper's replayed list of background tasks restores them after a reconnect", async () => {
  const { s, wrapper, next } = await session();
  let st = next("state");
  wrapper.out({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: [
      { task_id: "wf1", run_id: "r1", task_type: "local_workflow", description: "Review the code" },
      { task_id: "w0", task_type: "local_bash", description: "watch", ambient: true },
    ],
    session_id: SID,
  });
  await st;
  assert.deepEqual(s.state().tasks?.map((t) => [t.id, t.kind, t.status, t.background]), [["wf1", "local_workflow", "running", true]]);
  st = next("state");
  wrapper.out({ type: "system", subtype: "task_progress", task_id: "wf1", run_id: "r1", description: "x", usage: { total_tokens: 1, tool_uses: 0, duration_ms: 120_000 }, session_id: SID });
  await st;
  assert.ok((s.tasks.get("wf1")?.ms ?? 0) >= 120_000, "its first progress tells how long it has run");
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

test("a VS Code session reads a listed shell's output through the wrapper; an old wrapper's refusal comes back as it is", async () => {
  const { s, wrapper, next } = await session();
  const seen: Msg[] = [];
  let old = false;
  // A wrapper from before get_task_output was allowed refuses it by id.
  wrapper.sock.on("data", () => {
    for (const f of wrapper.frames) {
      const m = f.m as Msg | undefined;
      if (f.t !== "to_cli" || m?.type !== "control_request" || f.handled) continue;
      f.handled = true;
      seen.push(m.request as Msg);
      if (old) wrapper.send({ t: "rejected", id: m.request_id, reason: "request not allowed" });
      else wrapper.send({ m: { type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { output: "line1\n", total_bytes: 6, truncated: false } } }, t: "reply" });
    }
  });
  const st = next("state");
  wrapper.out({ type: "system", subtype: "task_started", task_id: "b7", description: "npm run dev", task_type: "local_bash", session_id: SID });
  await st;
  assert.deepEqual(await s.taskOutput("b7"), { text: "line1\n", totalBytes: 6, truncated: false });
  await assert.rejects(s.taskOutput("b8"), /not a shell task/);
  old = true;
  await assert.rejects(s.taskOutput("b7"), /rejected by the wrapper: request not allowed/);
  assert.deepEqual(seen, [
    { subtype: "get_task_output", task_id: "b7" },
    { subtype: "get_task_output", task_id: "b7" },
  ]);
  assert.equal(s.closed, false, "the session goes on");
});

test("a call running in the foreground moves to the background through a wrapper that passes it on, named by its call", async () => {
  const { s, wrapper, next } = await session({ caps: ["fast_mode", "thinking", "background_tasks"] });
  const seen: Msg[] = [];
  let refuse: string | undefined;
  wrapper.sock.on("data", () => {
    for (const f of wrapper.frames) {
      const m = f.m as Msg | undefined;
      if (f.t !== "to_cli" || m?.type !== "control_request" || f.handled) continue;
      f.handled = true;
      seen.push(m.request as Msg);
      if (refuse) wrapper.send({ t: "rejected", id: m.request_id, reason: refuse });
      else wrapper.send({ m: { type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { backgrounded: true } } }, t: "reply" });
    }
  });
  assert.equal(s.state().backgroundUnknown, undefined);
  let st = next("state");
  wrapper.out({ type: "system", subtype: "task_started", task_id: "b7", task_type: "local_bash", tool_use_id: "toolu_7", description: "npm test", is_backgrounded: false, session_id: SID });
  await st;
  await assert.rejects(s.background("toolu_8"), /not running in the foreground/);
  assert.equal(await s.background("toolu_7"), true);
  refuse = "not running";
  assert.equal(await s.background("toolu_7"), false, "a call the wrapper no longer sees running is not moved");
  assert.deepEqual(seen, [
    { subtype: "background_tasks", tool_use_id: "toolu_7" },
    { subtype: "background_tasks", tool_use_id: "toolu_7" },
  ]);
  st = next("state");
  wrapper.out({ type: "system", subtype: "task_updated", task_id: "b7", patch: { is_backgrounded: true }, session_id: SID });
  await st;
  await assert.rejects(s.background("toolu_7"), /not running in the foreground/);
  assert.equal(seen.length, 2);
  st = next("state");
  wrapper.out({ type: "system", subtype: "task_started", task_id: "a2", task_type: "local_agent", tool_use_id: "toolu_9", description: "look", is_backgrounded: false, session_id: SID });
  await st;
  refuse = "request not allowed";
  await assert.rejects(s.background("toolu_9"), /^Error: rejected by the wrapper: request not allowed$/);
  assert.equal(s.state().backgroundUnknown, true, "a wrapper that refuses it after all is not asked again");
  await assert.rejects(s.background("toolu_9"), /request not allowed/);
  assert.equal(seen.length, 3);
});

test("a wrapper that does not name background_tasks in its hello is asked nothing, and the state says so", async () => {
  const { s, wrapper, next } = await session();
  const seen: Msg[] = [];
  wrapper.autoReply((r) => (seen.push(r), {}));
  assert.equal(s.state().backgroundUnknown, true);
  const st = next("state");
  wrapper.out({ type: "system", subtype: "task_started", task_id: "b7", task_type: "local_bash", tool_use_id: "toolu_7", description: "npm test", is_backgrounded: false, session_id: SID });
  await st;
  await assert.rejects(s.background("toolu_7"), /request not allowed/);
  assert.equal(seen.length, 0);
  s.end("vscode_closed");
  assert.equal(s.state().backgroundUnknown, undefined, "a closed session offers nothing to move");
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

const elicit = (id: string, request: Msg = {}) => ({
  type: "control_request",
  request_id: id,
  request: {
    subtype: "elicitation",
    mcp_server_name: "demo",
    message: "Who are you?",
    mode: "form",
    requested_schema: { type: "object", properties: { name: { type: "string", title: "Name", minLength: 2 } }, required: ["name"] },
    ...request,
  },
});
const sent = (wrapper: FakeWrapper, pred: (f: Msg) => boolean) => wrapper.frames.filter(pred);
const decided = (id: string) => (f: Msg) => (f.t === "take" || f.t === "pass") && f.id === id;
const elicitAnswerFrame = (id: string) => (f: Msg) => f.t === "to_cli" && ((f.m as Msg).response as Msg | undefined)?.request_id === id;

test("a held MCP input request is taken while a phone can be reached and answered with the form", async () => {
  const { s, wrapper, next } = await session();
  s.reachable = () => true;
  const added = next("pending_add");
  wrapper.out(elicit("e1"));
  wrapper.send({ t: "held", id: "e1" });
  assert.equal((await wrapper.wait(decided("e1"), "decision")).t, "take");
  const [request] = (await added) as [PendingRequest];
  assert.equal(request.kind, "elicitation");
  assert.equal(request.elicitation?.server, "demo");
  assert.equal(request.elicitation?.fields?.[0].key, "name");
  await assert.rejects(s.answer("e1", { kind: "elicitation", action: "accept", content: { name: "K" } }), /name short/);
  assert.ok(s.pending.has("e1"), "a refused answer leaves the request");
  await s.answer("e1", { kind: "elicitation", action: "accept", content: { name: "Kim" } });
  const f = await wrapper.wait(elicitAnswerFrame("e1"), "answer frame");
  assert.deepEqual(((f.m as Msg).response as Msg).response, { action: "accept", content: { name: "Kim" } });
  assert.equal(s.pending.size, 0);
});

test("a held MCP input request goes to VS Code when no phone can be reached or the form cannot be drawn", async () => {
  const { s, wrapper } = await session();
  wrapper.out(elicit("e2"));
  wrapper.send({ t: "held", id: "e2" });
  assert.equal((await wrapper.wait(decided("e2"), "decision")).t, "pass");
  s.reachable = () => true;
  wrapper.out(elicit("e3", { requested_schema: { type: "object", properties: { file: { type: "object" } } } }));
  wrapper.send({ t: "held", id: "e3" });
  assert.equal((await wrapper.wait(decided("e3"), "decision")).t, "pass");
  assert.equal(s.pending.size, 0);
});

test("an MCP input request the wrapper does not hold is not shown", async () => {
  const { s, wrapper, next } = await session();
  s.reachable = () => true;
  wrapper.out(elicit("e4"));
  const st = next("state");
  wrapper.out({ type: "system", subtype: "status", status: null, permissionMode: "plan", session_id: SID });
  await st;
  assert.equal(s.pending.size, 0);
  assert.equal(sent(wrapper, decided("e4")).length, 0);
});

test("a taken MCP input request is cancelled when it waits too long, and dropped when withdrawn or given to VS Code", async () => {
  const { s, wrapper, next } = await session();
  s.reachable = () => true;
  s.elicitMs = 150;
  let added = next("pending_add");
  wrapper.out(elicit("e5"));
  wrapper.send({ t: "held", id: "e5" });
  await added;
  const f = await wrapper.wait(elicitAnswerFrame("e5"), "cancel after the wait");
  assert.deepEqual(((f.m as Msg).response as Msg).response, { action: "cancel" });
  assert.equal(s.pending.size, 0);

  added = next("pending_add");
  wrapper.out(elicit("e6"));
  wrapper.send({ t: "held", id: "e6" });
  await added;
  let removed = next("pending_remove");
  wrapper.out({ type: "control_cancel_request", request_id: "e6" });
  assert.deepEqual(await removed, ["e6"]);

  added = next("pending_add");
  wrapper.out(elicit("e7"));
  wrapper.send({ t: "held", id: "e7" });
  await added;
  removed = next("pending_remove");
  wrapper.send({ t: "rejected", id: "e7", reason: "not held" });
  assert.deepEqual(await removed, ["e7"]);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(sent(wrapper, (x) => elicitAnswerFrame("e6")(x) || elicitAnswerFrame("e7")(x)).length, 0, "nothing is sent for them");
});

test("a taken MCP input request waits the short window unless the app is open on a phone", async () => {
  const { s, wrapper, next } = await session();
  let watched = false;
  s.reachable = () => true;
  s.watched = () => watched;
  s.elicitMs = 600;
  s.unwatchedMs = 100;
  let added = next("pending_add");
  wrapper.out(elicit("e11"));
  wrapper.send({ t: "held", id: "e11" });
  await added;
  const started = Date.now();
  await wrapper.wait(elicitAnswerFrame("e11"), "cancel after the short window");
  assert.ok(Date.now() - started < 500, "nobody opened the app");

  added = next("pending_add");
  wrapper.out(elicit("e12"));
  wrapper.send({ t: "held", id: "e12" });
  await added;
  watched = true;
  await new Promise((r) => setTimeout(r, 250));
  assert.ok(s.pending.has("e12"), "the app opened, so the full wait holds");
  assert.equal(sent(wrapper, elicitAnswerFrame("e12")).length, 0);
  const f = await wrapper.wait(elicitAnswerFrame("e12"), "cancel after the full wait");
  assert.deepEqual(((f.m as Msg).response as Msg).response, { action: "cancel" });
});

test("the session's end cancels nothing on the user's behalf and clears its timers", async () => {
  const { s, wrapper, next } = await session();
  s.reachable = () => true;
  s.elicitMs = 150;
  const added = next("pending_add");
  wrapper.out(elicit("e8"));
  wrapper.send({ t: "held", id: "e8" });
  await added;
  s.end("vscode_closed");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(s.pending.size, 0);
  assert.equal(sent(wrapper, elicitAnswerFrame("e8")).length, 0);
});

test("a taken MCP input request goes back to VS Code when the session ends while Claude Code runs on", async () => {
  const { s, wrapper, next } = await session();
  s.reachable = () => true;
  const added = next("pending_add");
  wrapper.out(elicit("e9"));
  wrapper.send({ t: "held", id: "e9" });
  await added;
  s.end("switched");
  const passes = () => sent(wrapper, (f) => f.t === "pass" && f.id === "e9").length;
  for (let i = 0; i < 50 && !passes(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(passes(), 1);
});

test("an answer the wrapper refuses is followed by a cancel, not left waiting", async () => {
  const { s, wrapper, next } = await session();
  s.reachable = () => true;
  const added = next("pending_add");
  wrapper.out(elicit("e10"));
  wrapper.send({ t: "held", id: "e10" });
  await added;
  await s.answer("e10", { kind: "elicitation", action: "accept", content: { name: "Kim" } });
  await wrapper.wait(elicitAnswerFrame("e10"), "answer frame");
  wrapper.send({ t: "rejected", id: "e10", reason: "invalid answer" });
  const answers = () => sent(wrapper, elicitAnswerFrame("e10"));
  for (let i = 0; i < 50 && answers().length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(((answers()[1]?.m as Msg).response as Msg).response, { action: "cancel" });
});

const until = async (ok: () => boolean, label: string) => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ok(), label);
};
const lifecycle = (id: string, state: string) => ({ type: "command_lifecycle", command_uuid: id, state, uuid: `lc-${id}-${state}`, session_id: SID });
const replay = (id: string, text: string, timestamp: string) => ({
  type: "user",
  uuid: id,
  session_id: SID,
  parent_tool_use_id: null,
  isReplay: true,
  timestamp,
  message: { role: "user", content: [{ type: "text", text }] },
});
const toolUse = (uuid: string, id: string) => ({ type: "assistant", uuid, session_id: SID, message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "sleep 5" } }] } });
const toolResult = (uuid: string, id: string) => ({ type: "user", uuid, session_id: SID, message: { content: [{ type: "tool_result", tool_use_id: id, content: "done" }] } });

test("a message sent during a turn waits below the conversation and lands where Claude Code takes it in", async () => {
  const { s, wrapper } = await session();
  wrapper.out({ type: "system", subtype: "init", session_id: SID });
  wrapper.out(toolUse("a1", "t1"));
  await until(() => s.builder.items.length === 1, "the tool call shows");
  s.send("also check the tests");
  const id = s.state().queued![0].id;
  wrapper.out(lifecycle(id, "queued"));
  wrapper.out({ type: "assistant", uuid: "a2", session_id: SID, message: { content: [{ type: "text", text: "still working" }] } });
  await until(() => s.builder.items.length === 2, "the answer goes on");
  assert.equal(s.state().queued?.length, 1, "still queued while the tool runs");
  wrapper.out(toolResult("u2", "t1"));
  wrapper.out(replay(id, "also check the tests", "2026-10-14T12:00:00.000Z"));
  wrapper.out(lifecycle(id, "started"));
  await until(() => !s.state().queued, "taken in");
  assert.deepEqual(
    s.builder.items.map((i) => i.id),
    ["t1", "a2:0", id],
    "it sits after the tool result, not where it was sent",
  );
  const item = s.builder.items.at(-1)!;
  assert.equal(item.kind === "user" && item.text, "also check the tests");
  assert.equal(item.ts, "2026-10-14T12:00:00.000Z");
});

test("a message that starts a turn shows when Claude Code starts it and its echo updates it in place", async () => {
  const { s, wrapper } = await session();
  s.send("first");
  const id = s.state().queued![0].id;
  wrapper.out(lifecycle(id, "queued"));
  wrapper.out(lifecycle(id, "started"));
  await until(() => s.builder.items.length === 1, "it moves into the conversation");
  assert.equal(s.state().queued, undefined);
  wrapper.out({ type: "system", subtype: "init", session_id: SID });
  wrapper.out(replay(id, "first", "2026-10-14T12:00:00.000Z"));
  wrapper.out({ type: "assistant", uuid: "a1", session_id: SID, message: { content: [{ type: "text", text: "hi" }] } });
  await until(() => s.builder.items.length === 2, "the answer follows");
  assert.deepEqual(
    s.builder.items.map((i) => i.id),
    [id, "a1:0"],
  );
});

test("messages from VS Code show as queued at once, in Claude Code's order with the phone's", async () => {
  const { s, wrapper } = await session();
  s.send("from the phone");
  const phone = s.state().queued![0].id;
  wrapper.send({ m: { type: "user", uuid: "vs-1", timestamp: "2026-10-14T12:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "from VS Code" }, { type: "image" }] } }, t: "in" });
  await until(() => s.state().queued?.length === 2, "the VS Code message is queued");
  assert.deepEqual(
    s.state().queued!.map((q) => [q.id, q.from]),
    [
      [phone, "remote"],
      ["vs-1", "host"],
    ],
  );
  assert.deepEqual(s.state().queued![1].attachments, [{ kind: "image", mediaType: "", size: 0 }]);
  // Claude Code got VS Code's line first.
  wrapper.out(lifecycle("vs-1", "queued"));
  await until(() => s.state().queued![0].id === "vs-1", "Claude Code's order wins");
  wrapper.out(lifecycle(phone, "queued"));
  wrapper.send({ m: { type: "user", uuid: "vs-2", message: { role: "user", content: "later" } }, t: "in" });
  await until(() => s.state().queued?.length === 3, "a third one");
  assert.deepEqual(
    s.state().queued!.map((q) => q.id),
    ["vs-1", phone, "vs-2"],
  );
  await assert.rejects(s.unqueue("vs-1"), /only a message sent from here/);
  const snap = s.state();
  assert.deepEqual(
    snap.queued!.map((q) => q.text),
    ["from VS Code", "from the phone", "later"],
    "a reconnecting phone gets the queue with the state",
  );
});

test("a queued message sent from here is taken back with cancel_async_message", async () => {
  const { s, wrapper } = await session();
  const asked: Msg[] = [];
  let early: string | undefined;
  wrapper.autoReply((r) => {
    asked.push(r);
    // Claude Code may report the cancel before it answers.
    if (r.message_uuid === early) wrapper.out(lifecycle(early!, "cancelled"));
    return { cancelled: r.message_uuid !== "gone" };
  });
  s.send("never mind");
  const id = s.state().queued![0].id;
  wrapper.out(lifecycle(id, "queued"));
  await s.unqueue(id);
  assert.deepEqual(asked, [{ subtype: "cancel_async_message", message_uuid: id }]);
  assert.equal(s.state().queued, undefined);
  wrapper.out(lifecycle(id, "cancelled"));
  await assert.rejects(s.unqueue(id), /no longer queued/);
  s.send("this one too");
  early = s.state().queued![0].id;
  await s.unqueue(early);
  assert.equal(s.builder.items.length, 0, "nothing lands in the conversation");
});

test("Claude Code dropping a message clears it, and a message still held stays queued across a result", async () => {
  const { s, wrapper } = await session();
  s.send("one");
  s.send("two");
  s.send("three");
  const [one, two, three] = s.state().queued!.map((q) => q.id);
  wrapper.out(lifecycle(one, "queued"));
  wrapper.out(lifecycle(two, "queued"));
  wrapper.out(lifecycle(one, "refused"));
  await until(() => s.state().queued?.length === 2, "a refused message leaves the queue");
  assert.deepEqual(s.builder.items.map((i) => [i.kind, i.id, "text" in i ? i.text : undefined]), [["note", `unsent-${one}`, "one"]], "and is noted");
  // Claude Code 2.1.296 reports queued_turn_count 0 while a message it holds waits for the next turn.
  wrapper.out({ type: "result", subtype: "success", is_error: false, session_id: SID, queued_turn_count: 0 });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(s.state().queued?.map((q) => q.id), [two, three]);
  wrapper.out(lifecycle(two, "started"));
  await until(() => s.state().queued?.length === 1, "the held message lands when Claude Code takes it in");
  assert.deepEqual(s.builder.items.map((i) => i.id), [`unsent-${one}`, two]);
  assert.equal(s.state().queued![0].id, three, "one it has not seen yet stays");
  const noted: string[] = [];
  s.on("item", (i: { id: string }) => noted.push(i.id));
  const closed = new Promise((r) => s.once("closed", r));
  s.end("vscode_closed");
  await closed;
  assert.equal(s.state().queued, undefined);
  assert.deepEqual(noted, [`unsent-${three}`], "a message left queued at the end is noted");
});

test("messages Claude Code passes on never queue or show as the user's, and leave a queued message waiting", async () => {
  const { s, wrapper } = await session();
  const handBack = '<agent-message from="ac5f0af9a81a32d8e">\n[Subagent hand-back] The report follows:\n  Done.\n</agent-message>';
  wrapper.out({ type: "system", subtype: "init", session_id: SID });
  wrapper.out(toolUse("a1", "t1"));
  await until(() => s.builder.items.length === 1, "the tool call shows");
  s.send("also check the tests");
  const id = s.state().queued![0].id;
  wrapper.out(lifecycle(id, "queued"));
  wrapper.send({ m: { type: "user", uuid: "vs-agent", message: { role: "user", content: [{ type: "text", text: handBack }] } }, t: "in" });
  wrapper.out(toolResult("u2", "t1"));
  wrapper.out({
    type: "user",
    uuid: "src-1",
    session_id: SID,
    parent_tool_use_id: null,
    isReplay: true,
    isSynthetic: true,
    timestamp: "2026-10-14T13:42:02.418Z",
    origin: { kind: "peer", from: "ac5f0af9a81a32d8e", senderTaskId: "ac5f0af9a81a32d8e", name: "general-purpose", body: "...", handback: true },
    message: { role: "user", content: handBack },
  });
  wrapper.out({
    type: "user",
    uuid: "src-2",
    session_id: SID,
    parent_tool_use_id: null,
    isReplay: true,
    origin: { kind: "task-notification" },
    message: { role: "user", content: "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command \"ls\" completed (exit code 0)</summary>\n</task-notification>" },
  });
  await until(() => s.builder.items.length === 3, "both show");
  assert.deepEqual(
    s.state().queued?.map((q) => q.id),
    [id],
    "only the user's message waits",
  );
  assert.equal(s.busy, true, "the turn runs on");
  wrapper.out(replay(id, "also check the tests", "2026-10-14T13:42:03.000Z"));
  wrapper.out(lifecycle(id, "started"));
  await until(() => !s.state().queued, "the user's message is taken in");
  assert.deepEqual(
    s.builder.items.map((i) => [i.kind, i.id]),
    [
      ["tool", "t1"],
      ["message", "src-1"],
      ["task", "src-2"],
      ["user", id],
    ],
  );
});

test("a rename goes to Claude Code as the user's own, and only this session's announced name is taken", async () => {
  const { s, wrapper } = await session();
  const asked: Msg[] = [];
  wrapper.autoReply((r) => (asked.push(r), r.title === "old wrapper" ? Error("rejected by the wrapper: request not allowed") : {}));
  const titles: string[] = [];
  s.on("title", () => titles.push(s.title ?? ""));
  await s.rename("새 이름");
  assert.deepEqual(asked, [{ subtype: "rename_session", title: "새 이름", source: "host", session_id: SID }]);
  assert.equal(s.title, "새 이름");
  assert.equal(s.state().title, "새 이름");
  await assert.rejects(s.rename("old wrapper"), /request not allowed/);
  assert.equal(s.title, "새 이름");
  wrapper.out({ type: "system", subtype: "session_title_changed", title: "다른 세션", session_id: "0b7cf2a4-0000-4000-8000-000000000000" });
  wrapper.out({ type: "system", subtype: "session_title_changed", title: ` VS Code에서${String.fromCodePoint(0x200b)}바꾼 이름 `, session_id: SID });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.title, "VS Code에서 바꾼 이름");
  assert.deepEqual(titles, ["새 이름", "VS Code에서 바꾼 이름"]);
  assert.deepEqual(s.builder.items, [], "the announcements add nothing to the conversation");
});

test("a VS Code session asks Claude Code for its git changes only through a wrapper that passes them", async () => {
  const old = await session();
  assert.equal(old.s.workspaceDiff(), undefined, "an older wrapper is not asked");
  const { s, wrapper } = await session({ caps: ["fast_mode", "thinking", "workspace_diff", "side_question"] });
  wrapper.autoReply((r) => (r.subtype === "get_workspace_diff" ? { diff: null } : Error("unexpected")));
  assert.deepEqual(await s.workspaceDiff(), { diff: null });
  const sent = wrapper.frames.find((f) => f.t === "to_cli" && ((f.m as Msg).request as Msg | undefined)?.subtype === "get_workspace_diff");
  assert.deepEqual(((sent?.m as Msg).request as Msg), { subtype: "get_workspace_diff" });
});

test("a VS Code side question goes through the wrapper with its thread, hears its progress, and can be given up", async () => {
  const { s, wrapper } = await session({ caps: ["fast_mode", "thinking", "workspace_diff", "side_question"] });
  assert.equal(s.state().sideUnknown, undefined);
  const heard: unknown[] = [];
  const asked = s.sideQuestion("what now?", [{ question: "before?", answer: "yes", notice: "n" }], (p) => heard.push(p));
  const sent = await wrapper.wait((f) => f.t === "to_cli" && ((f.m as Msg).request as Msg | undefined)?.subtype === "side_question", "side question sent");
  const id = (sent.m as Msg).request_id as string;
  assert.deepEqual((sent.m as Msg).request, { subtype: "side_question", question: "what now?", history: [{ question: "before?", response: "yes", fallback_notice: "n" }] });
  await assert.rejects(s.sideQuestion("again", []), /a side question is under way/);
  wrapper.out({ type: "system", subtype: "control_request_progress", request_id: id, status: "started", uuid: "u1", session_id: SID });
  wrapper.out({ type: "system", subtype: "control_request_progress", request_id: id, status: "api_retry", attempt: 2, max_retries: 10, retry_delay_ms: 500, uuid: "u2", session_id: SID });
  wrapper.out({ type: "system", subtype: "control_request_progress", request_id: "ccrc-someone-else", status: "started", uuid: "u3", session_id: SID });
  await new Promise((r) => setTimeout(r, 50));
  wrapper.send({ m: { type: "control_response", response: { subtype: "success", request_id: id, response: { response: "Working on the tests.", synthetic: false } } }, t: "reply" });
  assert.deepEqual(await asked, { answer: "Working on the tests." });
  assert.deepEqual(heard, [{ status: "started" }, { status: "retry", attempt: 2, maxRetries: 10, retryInMs: 500 }]);
  assert.equal(s.builder.items.length, 0, "progress lines are not conversation");

  const slow = s.sideQuestion("slow one", []);
  const second = await wrapper.wait((f) => f.t === "to_cli" && ((f.m as Msg).request as Msg | undefined)?.question === "slow one", "second side question sent");
  s.cancelSideQuestion();
  await assert.rejects(slow, /side question cancelled/);
  await wrapper.wait((f) => f.t === "to_cli" && (f.m as Msg).type === "control_cancel_request" && (f.m as Msg).request_id === (second.m as Msg).request_id, "cancel sent");

  s.sideMs = 50;
  await assert.rejects(s.sideQuestion("too slow", []), /side question timed out/);
});

test("a wrapper too old for side questions is not asked, and the phone is told", async () => {
  const { s, wrapper } = await session({ caps: ["fast_mode", "thinking"] });
  assert.equal(s.state().sideUnknown, true);
  await assert.rejects(s.sideQuestion("hi", []), /rejected by the wrapper: request not allowed/);
  assert.ok(!wrapper.frames.some((f) => f.t === "to_cli"), "nothing went to the wrapper");
});

test("the command list follows Claude Code's initialize answer and every list it pushes; each turn's init only takes out the terminal's", async () => {
  const { s, wrapper } = await session();
  const settled = (pred: () => boolean) =>
    new Promise<void>((resolve) => {
      const check = () => pred() && (s.off("state", check), resolve());
      s.on("state", check);
      check();
    });
  const states: (string | undefined)[] = [];
  s.on("state", () => states.at(-1) !== s.state().commands && states.push(s.state().commands));
  const init = { name: "compact", description: "Compact the conversation", argumentHint: "" };
  const color = { name: "color", description: "Set the color", argumentHint: "" };
  // A skill synced from claude.ai: the list shows its short name and keeps the full one, which init uses, as an alias.
  const docx = { name: "docx", description: "Use this skill for Word documents (claude.ai)", argumentHint: "", aliases: ["anthropic-skills:docx"] };
  wrapper.out({ type: "control_response", response: { subtype: "success", request_id: "init-1", response: { models: [], commands: [init, color, docx] } } });
  await settled(() => s.commands?.length === 3);
  const first = s.state().commands;
  assert.ok(first, "the state names the list");
  const names = ["compact", "color", "anthropic-skills:docx", "skill-turned-off"];
  wrapper.out({ type: "system", subtype: "init", session_id: SID, model: "m", slash_commands: names, terminal_slash_commands: ["color"] });
  await settled(() => s.commands?.length === 2);
  const compact = { name: "compact", description: "Compact the conversation" };
  const shortDocx = { name: "docx", description: "Use this skill for Word documents (claude.ai)" };
  assert.deepEqual(s.commands, [compact, shortDocx], "the terminal's leave the phone's menu; init's other names change nothing");
  const second = s.state().commands;
  assert.notEqual(second, first);
  const pushed = [init, color, docx, { name: "gamma", description: "Gamma skill (project)", argumentHint: "" }];
  wrapper.out({ type: "system", subtype: "commands_changed", commands: pushed, session_id: SID, uuid: "u1" });
  await settled(() => s.commands?.some((c) => c.name === "gamma") === true);
  assert.deepEqual(s.commands, [compact, shortDocx, { name: "gamma", description: "Gamma skill (project)" }]);
  assert.ok(!s.builder.items.length, "the push is not a conversation item");
  const third = s.state().commands;
  assert.notEqual(third, second);
  wrapper.out({ type: "control_response", response: { subtype: "success", request_id: "init-2", response: { models: [], commands: [init] } } });
  wrapper.out({ type: "system", subtype: "init", session_id: SID, model: "m", slash_commands: [...names, "gamma"], terminal_slash_commands: ["color"] });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(s.commands?.map((c) => c.name), ["compact", "docx", "gamma"], "an initialize answer after a push leaves the pushed list, and the next turn's init changes it no more");
  assert.equal(s.state().commands, third, "the same list keeps its name");
  assert.deepEqual(states, [first, second, third], "the phone is told of each list once");
  wrapper.out({ type: "system", subtype: "init", session_id: SID, model: "m", slash_commands: names });
  await settled(() => s.commands?.some((c) => c.name === "color") === true);
  assert.deepEqual(s.commands?.map((c) => c.name), ["compact", "color", "docx", "gamma"], "an init that names no terminal commands has none");
});

test("the prompt cache follows the main conversation's requests and responses, and a compaction", async () => {
  const { s, wrapper } = await session();
  const cached = () => new Promise<void>((resolve) => s.once("state", () => resolve()));
  const usage = { input_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 900, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 900 }, output_tokens: 10 };
  const before = Date.now();
  wrapper.out({ type: "user", session_id: SID, uuid: "u-1", message: { role: "user", content: "hi" }, isReplay: true });
  await new Promise((r) => setTimeout(r, 30));
  wrapper.out({ type: "assistant", session_id: SID, uuid: "a-sub", parent_tool_use_id: "toolu_x", message: { id: "msg_sub", model: "m", content: [], usage: { ...usage, cache_creation: { ephemeral_5m_input_tokens: 900 } } } });
  const st = cached();
  wrapper.out({ type: "assistant", session_id: SID, uuid: "a-1", message: { id: "msg_1", model: "claude-opus-5-5", content: [{ type: "text", text: "hello" }], usage } });
  await st;
  const c = s.state().cache!;
  assert.equal(c.ttl, "1h", "a subagent's 5m cache is its own");
  assert.equal(c.tokens, 903);
  assert.ok(c.at! >= before && c.at! < Date.now() - 20, "the time of the request: the user's message, not the reply");
  const compacted = cached();
  wrapper.out({ type: "system", subtype: "compact_boundary", session_id: SID, uuid: "cb", compact_metadata: { trigger: "manual", pre_tokens: 1 } });
  await compacted;
  assert.ok(typeof s.state().cache?.compactedAt === "number");
});

test("the causes of usage are asked of a wrapper that passes them on, without skip_behaviors and with time to read a week of transcripts", async () => {
  const old = await session();
  await assert.rejects(old.s.usageCauses(), /not available/);
  const { s, wrapper } = await session({ caps: ["fast_mode", "thinking", "claude_push", "usage_causes"] });
  const asked: Msg[] = [];
  wrapper.autoReply((r) => {
    asked.push(r);
    return { behaviors: { day: { request_count: 3, session_count: 1, behaviors: [{ key: "cache_miss", pct: 40, count: 2 }], agents: [], skills: [], plugins: [], mcp_servers: [] } } };
  });
  const c = await s.usageCauses();
  assert.deepEqual(asked, [{ subtype: "get_usage" }]);
  assert.deepEqual(c.day?.traits, [{ key: "cache_miss", pct: 40, count: 2 }]);
  assert.equal(c.week, undefined);
});

const DIALOG_CAPS = ["fast_mode", "thinking", "claude_push", "background_tasks", "workspace_diff", "side_question", "user_dialogs", "mcp_auth"];
const dialog = (id: string, dialog_kind: string, payload: Msg) => ({ type: "control_request", request_id: id, request: { subtype: "request_user_dialog", dialog_kind, payload } });

test("a refusal or auto mode dialog is answered from the phone through a wrapper that passes dialogs", async () => {
  const { s, wrapper, next } = await session({ caps: DIALOG_CAPS });
  let added = next("pending_add");
  wrapper.out(dialog("d1", "refusal_fallback_prompt", { originalModel: "claude-opus-5-5", fallbackModel: "claude-sonnet-5", apiRefusalCategory: "cyber", retractedMessageUuids: ["x"] }));
  const [request] = (await added) as [PendingRequest];
  assert.equal(request.kind, "dialog");
  assert.equal(request.localOnly, undefined);
  assert.deepEqual(request.dialog, { kind: "refusal_fallback_prompt", model: "claude-opus-5-5", fallback: "claude-sonnet-5", category: "cyber" });
  await assert.rejects(s.answer("d1", { kind: "dialog", choice: "consent" }), /invalid answer/);
  await assert.rejects(s.answer("d1", { kind: "permission", decision: "allow" }), /does not match/);
  const removed = next("pending_remove");
  await s.answer("d1", { kind: "dialog", choice: "edit_prompt" });
  await removed;
  const f = await wrapper.wait((x) => x.t === "to_cli" && ((x.m as Msg).response as Msg | undefined)?.request_id === "d1", "dialog answer");
  assert.deepEqual(((f.m as Msg).response as Msg).response, { behavior: "completed", result: "edit_prompt" });

  added = next("pending_add");
  wrapper.out(dialog("d2", "auto_mode_server_fallback", { title: "Billed", paragraphs: ["One", 7, ""], helpUrl: "https://evil.example/x" }));
  const [notice] = (await added) as [PendingRequest];
  assert.deepEqual(notice.dialog, { kind: "auto_mode_server_fallback", title: "Billed", paragraphs: ["One"] });
  await s.answer("d2", { kind: "dialog", choice: "cancel" });
  const c = await wrapper.wait((x) => x.t === "to_cli" && ((x.m as Msg).response as Msg | undefined)?.request_id === "d2", "dialog closed");
  assert.deepEqual(((c.m as Msg).response as Msg).response, { behavior: "cancelled" });
});

test("the credits consent, a dialog without what it needs, and every dialog of an older wrapper stay with VS Code", async () => {
  const { s, wrapper, next } = await session({ caps: DIALOG_CAPS });
  let added = next("pending_add");
  wrapper.out(dialog("c1", "fable_overage_consent_prompt", { overagesEnabled: true, modelName: "Fable", balanceCents: 1200, currency: "USD" }));
  let [request] = (await added) as [PendingRequest];
  assert.equal(request.localOnly, true);
  assert.deepEqual(request.dialog, { kind: "fable_overage_consent_prompt", enabled: true, model: "Fable", balanceCents: 1200, currency: "USD" });
  await assert.rejects(s.answer("c1", { kind: "dialog", choice: "cancel" }), /only be answered where the session is open/);
  added = next("pending_add");
  wrapper.out(dialog("c2", "refusal_fallback_prompt", { originalModel: "claude-opus-5-5" }));
  [request] = (await added) as [PendingRequest];
  assert.equal(request.localOnly, true);
  assert.equal(request.dialog, undefined);
  added = next("pending_add");
  wrapper.out(dialog("c3", "auto_mode_outside_reads", {}));
  [request] = (await added) as [PendingRequest];
  assert.equal(request.localOnly, true);

  const old = await session();
  added = old.next("pending_add");
  old.wrapper.out(dialog("o1", "refusal_fallback_prompt", { originalModel: "a", fallbackModel: "b" }));
  [request] = (await added) as [PendingRequest];
  assert.equal(request.localOnly, true);
});

test("an MCP sign-in goes through a wrapper that passes it, by a server Claude Code reported and a redirect to this machine; the server connects again after", async () => {
  const { s, wrapper } = await session({ caps: DIALOG_CAPS });
  const seen: Msg[] = [];
  wrapper.autoReply((r) => {
    seen.push(r);
    if (r.subtype === "mcp_status") return { mcpServers: [{ name: "linear", status: "needs-auth", scope: "user", config: { type: "http", url: "https://mcp.example.com" } }] };
    if (r.subtype === "mcp_authenticate") return { authUrl: "https://auth.example.com/authorize?state=s1", requiresUserAction: true, callbackExpected: true };
    return {};
  });
  assert.deepEqual(await s.mcpAuthenticate("linear"), { url: "https://auth.example.com/authorize?state=s1", callback: true });
  assert.deepEqual(seen.at(-1), { subtype: "mcp_authenticate", serverName: "linear" });
  await assert.rejects(s.mcpAuthenticate("other"), /unknown MCP server/);
  await assert.rejects(s.mcpOAuthCallback("linear", "https://evil.example/cb?code=1"), /invalid callback URL/);
  seen.length = 0;
  const url = "http://localhost:43123/callback?code=abc&state=s1";
  assert.deepEqual(await s.mcpOAuthCallback("linear", url), [{ name: "linear", status: "needs-auth", scope: "user", auth: "oauth" }]);
  assert.deepEqual(seen, [
    { subtype: "mcp_status" },
    { subtype: "mcp_oauth_callback_url", serverName: "linear", callbackUrl: url },
    { subtype: "mcp_reconnect", serverName: "linear" },
    { subtype: "mcp_status" },
  ]);

  const old = await session();
  old.wrapper.autoReply((r) => (r.subtype === "mcp_status" ? { mcpServers: [{ name: "linear", status: "needs-auth" }] } : {}));
  await assert.rejects(old.s.mcpAuthenticate("linear"), /request not allowed/);
});

test("a resting tab whose wrapper can hand over is asked, says yes once, and its session then ends as moved", async () => {
  const { s, link, wrapper, events } = await session({ caps: ["hand_over"] });
  wrapper.send({ t: "spawned", cpid: 5150 });
  await new Promise((r) => setTimeout(r, 50));
  const holder = { pid: 5150, sessionId: SID, cwd: "/tmp/project", host: "VS Code", status: "idle", procStart: "1" };
  assert.equal(s.restsIn(holder), true);
  assert.equal(s.restsIn({ ...holder, status: "busy" }), false, "the registry says it answers");
  assert.equal(s.restsIn({ ...holder, pid: 5151 }), false, "another process of the session");
  assert.equal(s.restsIn({ ...holder, host: "Terminal" }), false);
  wrapper.out(ask("p1"));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.restsIn(holder), false, "a request waits in the tab");
  wrapper.send({ t: "settled", id: "p1", by: "host" });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.restsIn(holder), true);

  const refused = s.handOver("멈췄습니다.", 1000);
  const first = await wrapper.wait((f) => f.t === "hand_over", "asked");
  assert.equal(first.notice, "멈췄습니다.");
  wrapper.send({ t: "rejected", id: first.id, reason: "turn running" });
  assert.equal(await refused, false);
  assert.equal(link.usable, true);
  assert.equal(await s.handOver("멈췄습니다.", 100), false, "no answer in time");

  const asked = s.handOver("멈췄습니다.", 1000);
  const again = await wrapper.wait((f) => f.t === "hand_over" && f.id !== first.id && wrapper.frames.filter((x) => x.t === "hand_over").length === 3, "asked again");
  wrapper.send({ t: "handed_over", id: again.id });
  wrapper.send({ t: "exit", code: 0, signal: null, hostLeft: false, running: false });
  assert.equal(await asked, true);
  assert.equal(link.usable, false);
  assert.equal(s.restsIn(holder), false);
  assert.throws(() => s.send("늦은 메시지"), /session is opening in VS Code/, "the phone sends to the tab it moves to");
  s.exited(0, null, false, false);
  assert.deepEqual(events.filter(([ev]) => ev === "closed").map(([, a]) => a[0]), ["moved"]);
});

test("a tab that hands over after the broker stopped waiting has let go all the same", async () => {
  const { s, link, wrapper, events } = await session({ caps: ["hand_over"] });
  wrapper.send({ t: "spawned", cpid: 5153 });
  await new Promise((r) => setTimeout(r, 50));
  const late = s.handOver("멈췄습니다.", 50);
  const asked = await wrapper.wait((f) => f.t === "hand_over", "asked");
  assert.equal(await late, false, "no answer in time");
  assert.equal(link.usable, true);
  wrapper.send({ t: "handed_over", id: asked.id });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(link.usable, false);
  assert.throws(() => s.send("늦은 메시지"), /session is opening in VS Code/, "the phone sends to the tab it moves to");
  s.exited(0, null, false, false);
  assert.deepEqual(events.filter(([ev]) => ev === "closed").map(([, a]) => a[0]), ["moved"]);
});

test("a tab under a wrapper that cannot hand over is never asked", async () => {
  const { s, wrapper } = await session({ caps: ["fast_mode", "thinking"] });
  wrapper.send({ t: "spawned", cpid: 5152 });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.restsIn({ pid: 5152, sessionId: SID, cwd: "/tmp/project", host: "VS Code", status: "idle", procStart: "1" }), false);
});
