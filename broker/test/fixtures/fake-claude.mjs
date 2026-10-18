// Stands in for Claude Code in relay tests. Reads stream-json lines and answers in a fixed way:
// a user message is replayed and answered; "ASK" opens a permission prompt; "CANCEL" opens one and
// withdraws it; "ELICIT" asks for MCP input and "ELICIT_CANCEL" withdraws that shortly after; "MCP" sends VS Code an MCP request; "BIG" answers with a very long line; "HOLD" leaves
// the turn running; "CRASH" exits with code 1 mid-turn; "FAIL" and "LIMIT" end the turn on an API error and on a usage
// limit as Claude Code reports them. Its init line reports whether it was asked to continue a cut-off turn. Control
// requests get a success response, and each control_response it receives is reported back as
// {"type":"answered"}. FAKE_BURST=1 writes a long line and an error result at start and exits at once;
// FAKE_LINGER_MS keeps it running that long after its input ends. "COMMANDS" announces two changes of the command list.
// The answer to initialize lists models and a few of the commands Claude Code lists; FAKE_NO_INIT=1 leaves initialize unanswered.
// While a "HOLD" turn runs, user messages are queued with command_lifecycle lines as Claude Code reports them;
// cancel_async_message drops one and "interrupt" ends the turn after taking the queued ones in, as a stop the user made.
// "/usage" answers as Claude Code answers a local command, with a synthetic message carrying its data, and
// "/status" the same way with text only; "/help" as a command headless Claude Code cannot open, with no name; get_usage fails while the working folder holds a file named .fake-no-usage,
// and answers the causes of usage unless asked to skip them.
// The output style starts from .claude/settings.local.json and update_settings writes it there.
// FAKE_REQUESTS=<file> gets a line with its arguments, environment and sign-in variables and then one per control request or user message it receives.
// "PUSH <text>" calls PushNotification as Claude Code 2.1.301 runs it: the PreToolUse and PostToolUse hooks initialize
// registered are asked over hook_callback, a deny becomes Claude Code's hook error, an updatedToolOutput replaces the
// output, and without either the result says no Remote Control was there to push. "VSHOOK" asks VS Code's own hook "hook_0".
// get_settings reports a --model starting with "claude-" as the model; one naming "no-ultracode" does not offer Ultracode, which
// --settings {"ultracode":true} asks for. get_task_output answers with a coloured line naming the task.
// "FGBASH" starts a Bash call (toolu_fg) that runs in the foreground until background_tasks names it, which moves it to the
// background as Claude Code does.
// side_question sends a control_request_progress line and answers with the question and the size of its history; "SLOW"
// waits until a control_cancel_request for it. get_workspace_diff answers with one changed file.
// --version prints a version and exits.
// rename_session is checked and saved as Claude Code saves a name (custom-title and agent-name rows when the transcript
// under CLAUDE_CONFIG_DIR exists, the title file beside it) and announced with session_title_changed, which a resume
// of a named session also sends before its init line.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("2.1.296 (Claude Code)");
  process.exit(0);
}
const value = (name) => {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1];
    if (args[i].startsWith(name + "=")) return args[i].slice(name.length + 1);
  }
};
const flagSettings = (() => {
  const v = value("--settings");
  try {
    return v ? JSON.parse(v.trim().startsWith("{") ? v : fs.readFileSync(v, "utf8")) : {};
  } catch {
    return {};
  }
})();
// The commands Claude Code lists for a session it runs headless, a few of them.
const COMMANDS = [
  { name: "compact", description: "Compact the conversation", argumentHint: "" },
  { name: "context", description: "Show current context usage", argumentHint: "" },
  { name: "usage", description: "Show plan usage limits", argumentHint: "" },
  { name: "mcp", description: "Manage MCP servers", argumentHint: "" },
  { name: "model", description: "Set the AI model for Claude Code", argumentHint: "[model]" },
  { name: "effort", description: "Set effort level", argumentHint: "[low|medium|high|xhigh|max|auto]" },
  { name: "config", description: "Open config panel", argumentHint: "" },
  { name: "output-style", description: "Set the output style", argumentHint: "" },
];
const modelArg = value("--model") ?? "";
const appliedModel = modelArg.startsWith("claude-") ? modelArg : "claude-haiku-5-5";
const ultracodeAvailable = !modelArg.includes("no-ultracode");
const sid = value("--session-id") || (args.includes("--fork-session") ? undefined : value("--resume")) || randomUUID();
const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const record = (m) => process.env.FAKE_REQUESTS && fs.appendFileSync(process.env.FAKE_REQUESTS, JSON.stringify(m) + "\n");
const { CLAUDE_CODE_ENTRYPOINT, CLAUDE_AGENT_SDK_CLIENT_APP, CLAUDE_CODE_ARTIFACT, CLAUDE_CODE_SEND_FEEDBACK, ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN } = process.env;
record({
  args,
  env: { CLAUDE_CODE_ENTRYPOINT, CLAUDE_AGENT_SDK_CLIENT_APP, CLAUDE_CODE_ARTIFACT, CLAUDE_CODE_SEND_FEEDBACK },
  auth: { apiKey: ANTHROPIC_API_KEY ?? null, oauthToken: CLAUDE_CODE_OAUTH_TOKEN !== undefined },
});
let asks = 0;
let holding = false;
const foreground = new Set();
const sides = new Set();
const queue = [];
let hooks = {};
const hookWaits = new Map();

// Asks each hook registered for the event and tool; a hook unanswered for 5s counts as no answer.
function hookCall(event, input, toolUseId) {
  const ids = (hooks[event] ?? []).filter((h) => !h.matcher || new RegExp(`^(?:${h.matcher})$`).test(input.tool_name)).flatMap((h) => h.hookCallbackIds ?? []);
  return Promise.all(
    ids.map(
      (callback_id) =>
        new Promise((resolve) => {
          const request_id = `hook-${randomUUID().slice(0, 8)}`;
          const timer = setTimeout(() => resolve({}), 5000);
          hookWaits.set(request_id, (r) => (clearTimeout(timer), resolve(r ?? {})));
          out({ type: "control_request", request_id, request: { subtype: "hook_callback", callback_id, input: { hook_event_name: event, session_id: sid, ...input }, tool_use_id: toolUseId } });
        }),
    ),
  );
}

function pushText(o) {
  if (o.disabledReason === "user_present") return "Not sent \u2014 this terminal is active, so your output here already reaches the user; a separate notification would be redundant.";
  if (o.disabledReason === "no_transport") return o.localSent ? "Terminal notification sent. Mobile push not sent (Remote Control inactive)." : "Mobile push not sent (Remote Control inactive).";
  return o.localSent ? "Terminal notification sent. Mobile push requested." : "Mobile push requested.";
}

async function pushNotification(message) {
  const id = `toolu_push_${randomUUID().slice(0, 8)}`;
  const tool_input = { message, status: "proactive" };
  out({ type: "assistant", session_id: sid, uuid: randomUUID(), parent_tool_use_id: null, message: { content: [{ type: "tool_use", id, name: "PushNotification", input: tool_input }] } });
  const pre = await hookCall("PreToolUse", { tool_name: "PushNotification", tool_input, tool_use_id: id }, id);
  const deny = pre.map((r) => r.hookSpecificOutput).find((o) => o?.permissionDecision === "deny");
  let output;
  let block;
  if (deny) {
    const text = `PreToolUse:PushNotification hook error: ${deny.permissionDecisionReason}`;
    output = `Error: ${text}`;
    block = { type: "tool_result", tool_use_id: id, content: text, is_error: true };
  } else {
    output = { message, pushSent: false, localSent: false, disabledReason: "no_transport", sentAt: new Date().toISOString() };
    const post = await hookCall("PostToolUse", { tool_name: "PushNotification", tool_input, tool_response: output, tool_use_id: id }, id);
    output = post.map((r) => r.hookSpecificOutput?.updatedToolOutput).find((v) => v !== undefined) ?? output;
    block = { type: "tool_result", tool_use_id: id, content: pushText(output) };
  }
  out({ type: "user", session_id: sid, uuid: randomUUID(), parent_tool_use_id: null, message: { role: "user", content: [block] }, tool_use_result: output });
  out({ type: "assistant", session_id: sid, uuid: randomUUID(), message: { content: [{ type: "text", text: `told: ${block.content}` }] } });
  out({ type: "result", subtype: "success", session_id: sid, is_error: false, total_cost_usd: 0.001 });
}
const lifecycle = (id, state) => out({ type: "command_lifecycle", command_uuid: id, state, uuid: randomUUID(), session_id: sid });
const STYLES = ["default", "Proactive", "Concise", "Explanatory", "Learning"];
const LOCAL_SETTINGS = ".claude/settings.local.json";
let style;
try {
  style = JSON.parse(fs.readFileSync(LOCAL_SETTINGS, "utf8")).outputStyle;
} catch {}

const transcript = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"), `${sid}.jsonl`);
const cleanTitle = (raw) => [...raw.trim().replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")].slice(0, 200).join("").trim();
const savedTitle = () => {
  try {
    const rows = fs.readFileSync(transcript(), "utf8").split("\n").filter((l) => l.includes('"custom-title"'));
    return rows.length ? JSON.parse(rows.at(-1)).customTitle : undefined;
  } catch {
    return undefined;
  }
};
const named = value("--resume") ? savedTitle() : undefined;
if (named) out({ type: "system", subtype: "session_title_changed", title: named, uuid: randomUUID(), session_id: sid });
out({ type: "system", subtype: "init", session_id: sid, model: "fake-model", permissionMode: value("--permission-mode") || "default", output_style: style ?? "default", args, continueTurn: process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN ?? null });
if (process.env.FAKE_BURST) {
  out({ type: "user", session_id: sid, message: { content: [{ type: "tool_result", content: "y".repeat(3_000_000) }] } });
  process.stdout.write(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sid }) + "\n", () => process.exit(1));
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => setTimeout(() => process.exit(Number(process.env.FAKE_EXIT_CODE ?? 0)), Number(process.env.FAKE_LINGER_MS ?? 0)));

function handle(m) {
  if (m.type === "user") {
    const content = m.message.content;
    const text = typeof content === "string" ? content : content.map((c) => c.text).join("");
    const blocks = Array.isArray(content) ? content.filter((c) => c.type !== "text").map((c) => c.type) : [];
    record({ user: text, ...(blocks.length ? { blocks } : {}) });
    if (holding) {
      queue.push(m);
      if (m.uuid) lifecycle(m.uuid, "queued");
      return;
    }
    if (text === "/status") {
      const shown = "Version: 2.1.296 (fake)\nModel: fake-model";
      out({
        type: "assistant",
        session_id: sid,
        uuid: randomUUID(),
        parent_tool_use_id: null,
        message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: shown }] },
        local_command_source: `<local-command-stdout>${shown}</local-command-stdout>`,
        local_command_run: { command: "status", args: "" },
      });
      const replay = "<command-name>/status</command-name>\n<command-message>status</command-message>\n<command-args></command-args>";
      out({ type: "user", session_id: sid, uuid: m.uuid ?? randomUUID(), isReplay: true, message: { role: "user", content: replay } });
      out({ type: "result", subtype: "success", session_id: sid, is_error: false, result: shown, num_turns: 0, local_command: "status", total_cost_usd: 0 });
      return;
    }
    if (text === "/help") {
      const shown = "/help isn't available in this environment.";
      out({ type: "user", session_id: sid, uuid: m.uuid ?? randomUUID(), isReplay: true, message: { role: "user", content: "/help" } });
      out({
        type: "assistant",
        session_id: sid,
        uuid: randomUUID(),
        parent_tool_use_id: null,
        message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: shown }] },
        local_command_source: `<local-command-stdout>${shown}</local-command-stdout>`,
        local_command_outcome: { kind: "unavailable_headless" },
      });
      out({ type: "result", subtype: "success", session_id: sid, is_error: false, result: shown, num_turns: 0, total_cost_usd: 0 });
      return;
    }
    if (text === "/usage") {
      const shown = "Current session: 32% used\nCurrent week (all models): 91% used";
      out({
        type: "assistant",
        session_id: sid,
        uuid: randomUUID(),
        parent_tool_use_id: null,
        message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: shown }] },
        local_command_source: `<local-command-stdout>${shown}</local-command-stdout>`,
        local_command_run: { command: "usage", args: "" },
        usage_report: {
          session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 1200, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
          rate_limits: {
            limits: [
              { kind: "session", group: "session", percent: 32, resets_at: "2026-10-14T05:19:59Z", scope: null, severity: "normal", is_active: false },
              { kind: "weekly_all", group: "weekly", percent: 91, resets_at: "2026-10-17T12:59:59Z", scope: null, severity: "critical", is_active: true },
            ],
          },
        },
      });
      const replay = "<command-name>/usage</command-name>\n<command-message>usage</command-message>\n<command-args></command-args>";
      out({ type: "user", session_id: sid, uuid: m.uuid ?? randomUUID(), isReplay: true, message: { role: "user", content: replay } });
      out({ type: "result", subtype: "success", session_id: sid, is_error: false, result: shown, num_turns: 0, local_command: "usage", total_cost_usd: 0 });
      return;
    }
    out({ ...m, session_id: sid, uuid: m.uuid ?? randomUUID(), isReplay: true });
    if (text.startsWith("PUSH ")) {
      void pushNotification(text.slice(5));
      return;
    }
    if (text === "VSHOOK") {
      out({ type: "control_request", request_id: "hook-vs", request: { subtype: "hook_callback", callback_id: "hook_0", input: { hook_event_name: "PreToolUse", tool_name: "Edit" }, tool_use_id: "toolu_e" } });
      return;
    }
    if (text === "HOLD") {
      holding = true;
      return;
    }
    if (text === "CRASH") {
      setTimeout(() => process.exit(1), 50);
      return;
    }
    if (text === "FAIL" || text === "LIMIT") {
      const limit = text === "LIMIT";
      if (limit) out({ type: "rate_limit_event", session_id: sid, uuid: randomUUID(), rate_limit_info: { status: "rejected", resetsAt: 1792095600, rateLimitType: "five_hour" } });
      const said = limit ? "You've hit your limit" : "API Error: 529 Overloaded";
      out({ type: "assistant", session_id: sid, uuid: randomUUID(), parent_tool_use_id: null, error: limit ? "rate_limit" : "overloaded", message: { model: "<synthetic>", content: [{ type: "text", text: said }] } });
      out({ type: "result", subtype: "success", session_id: sid, is_error: true, terminal_reason: "api_error", api_error_status: limit ? 429 : 529, result: said, total_cost_usd: 0 });
      return;
    }
    if (text === "COMPACTING") {
      out({ type: "system", subtype: "status", status: "compacting", session_id: sid });
      return;
    }
    if (text === "FGBASH") {
      foreground.add("toolu_fg");
      out({ type: "assistant", session_id: sid, uuid: randomUUID(), message: { content: [{ type: "tool_use", id: "toolu_fg", name: "Bash", input: { command: "npm test" } }] } });
      out({ type: "system", subtype: "task_started", task_id: "bfg", task_type: "local_bash", tool_use_id: "toolu_fg", description: "npm test", is_backgrounded: false, session_id: sid });
      holding = true;
      return;
    }
    if (text === "BGTASKS") {
      out({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "a1", run_id: "r1", task_type: "local_agent", description: "Find the tests" }], session_id: sid });
      out({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "a1", run_id: "r1", task_type: "local_agent", description: "Find the tests" }, { task_id: "b2", task_type: "local_bash", description: "npm test" }], session_id: sid });
      return;
    }
    if (text === "MCP") {
      out({ type: "control_request", request_id: "mcp-1", request: { subtype: "mcp_message", server_name: "claude-vscode", message: { method: "x" } } });
      return;
    }
    if (text === "COMMANDS") {
      for (const n of [1, 2]) {
        const commands = [...COMMANDS, { name: `skill-${n}`, description: `Skill ${n}`, argumentHint: "" }];
        out({ type: "system", subtype: "commands_changed", commands, uuid: randomUUID(), session_id: sid });
      }
      return;
    }
    if (text === "ELICIT" || text === "ELICIT_CANCEL") {
      const request_id = `elicit-${++asks}`;
      const requested_schema = { type: "object", properties: { name: { type: "string", title: "Name" } }, required: ["name"] };
      out({ type: "control_request", request_id, request: { subtype: "elicitation", mcp_server_name: "demo", message: "Who are you?", mode: "form", requested_schema } });
      if (text === "ELICIT_CANCEL") setTimeout(() => out({ type: "control_cancel_request", request_id }), 300);
      return;
    }
    if (text === "ASK" || text === "CANCEL") {
      const request_id = `perm-${++asks}`;
      out({ type: "control_request", request_id, request: { subtype: "can_use_tool", tool_name: "Write", input: { file_path: "x.txt" }, tool_use_id: `toolu_${asks}` } });
      if (text === "CANCEL") out({ type: "control_cancel_request", request_id });
      return;
    }
    const reply = text === "BIG" ? "x".repeat(3_000_000) : `echo: ${text}`;
    out({ type: "assistant", session_id: sid, uuid: randomUUID(), message: { content: [{ type: "text", text: reply }] } });
    out({ type: "result", subtype: "success", session_id: sid, is_error: false, total_cost_usd: 0.001 });
    return;
  }
  if (m.type === "control_request") {
    record({ request: m.request });
    const init = m.request.subtype === "initialize";
    if (init && m.request.hooks) hooks = m.request.hooks;
    if (m.request.subtype === "cancel_async_message") {
      const at = queue.findIndex((q) => q.uuid === m.request.message_uuid);
      if (at !== -1) {
        queue.splice(at, 1);
        lifecycle(m.request.message_uuid, "cancelled");
      }
      out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { cancelled: at !== -1 } } });
      return;
    }
    if (m.request.subtype === "interrupt" && holding) {
      holding = false;
      for (const q of queue.splice(0)) {
        out({ ...q, session_id: sid, isReplay: true });
        if (q.uuid) lifecycle(q.uuid, "started");
      }
      out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } });
      out({ type: "user", session_id: sid, uuid: randomUUID(), parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
      out({ type: "result", subtype: "error_during_execution", session_id: sid, is_error: true, terminal_reason: "aborted_streaming", errors: [], total_cost_usd: 0.001, queued_turn_count: 0 });
      return;
    }
    if (init && process.env.FAKE_NO_INIT) return;
    if (m.request.subtype === "rename_session") return rename(m.request_id, m.request);
    if (m.request.subtype === "read_file") {
      const r = m.request;
      const answer = (body) => out({ type: "control_response", response: { request_id: m.request_id, ...body } });
      const abs = path.resolve(process.cwd(), r.path);
      let real;
      try {
        real = fs.realpathSync(abs);
      } catch {
        return answer({ subtype: "error", error: `File does not exist: ${r.path}` });
      }
      const rel = path.relative(fs.realpathSync(process.cwd()), real);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return answer({ subtype: "error", error: `read denied: ${r.path}` });
      const data = fs.readFileSync(real);
      const max = r.max_bytes ?? 1_000_000;
      const part = data.subarray(0, max);
      const base64 = r.encoding === "base64";
      return answer({
        subtype: "success",
        response: { contents: part.toString(base64 ? "base64" : "utf8"), absPath: abs, truncated: data.length > max, ...(base64 ? { encoding: "base64" } : {}) },
      });
    }
    if (m.request.subtype === "background_tasks") {
      const id = m.request.tool_use_id;
      const moved = typeof id === "string" && foreground.delete(id);
      out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: id === undefined ? {} : { backgrounded: moved } } });
      if (!moved) return;
      out({ type: "system", subtype: "task_updated", task_id: "bfg", patch: { is_backgrounded: true }, session_id: sid });
      out({ type: "user", session_id: sid, uuid: randomUUID(), parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "Command was manually backgrounded by user with ID: bfg." }] } });
      return;
    }
    if (m.request.subtype === "side_question") {
      const { question, history = [] } = m.request;
      out({ type: "system", subtype: "control_request_progress", request_id: m.request_id, status: "started", uuid: randomUUID(), session_id: sid });
      if (question === "SLOW") {
        sides.add(m.request_id);
        return;
      }
      const response = { response: `side: ${question} (history ${history.length})`, synthetic: false };
      setTimeout(() => out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response } }), 30);
      return;
    }
    if (m.request.subtype === "get_workspace_diff") {
      const diff = {
        stats: { filesCount: 1, linesAdded: 1, linesRemoved: 1 },
        perFileStats: [{ path: "a.txt", added: 1, removed: 1, isBinary: false, isUntracked: false, status: "modified" }],
        hunks: [{ path: "a.txt", hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] }] }],
        skippedLarge: [],
        restricted: [],
        source: { kind: "working-tree" },
      };
      out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { diff } } });
      return;
    }
    if (m.request.subtype === "get_task_output") {
      const output = `\u001b[32m${m.request.task_id}\u001b[0m "applied": {"rate_limits": 1}\n`;
      out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { output, total_bytes: Buffer.byteLength(output), truncated: false } } });
      return;
    }
    if (m.request.subtype === "get_usage" && fs.existsSync(".fake-no-usage")) {
      out({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: "usage unavailable" } });
      return;
    }
    if (m.request.subtype === "update_settings" && typeof m.request.settings?.outputStyle === "string") {
      style = m.request.settings.outputStyle;
      fs.mkdirSync(".claude", { recursive: true });
      fs.writeFileSync(LOCAL_SETTINGS, JSON.stringify({ outputStyle: style }));
    }
    const extra = init
      ? { models: [{ value: "default", displayName: "Default" }], commands: COMMANDS, current_permission_mode: "default", output_style: style ?? "default", available_output_styles: STYLES }
      : m.request.subtype === "get_settings"
        ? {
            effective: { env: { SECRET_TOKEN: "s3cret" }, hooks: { Stop: [{ command: "hook-cmd" }] }, ...(style ? { outputStyle: style } : {}) },
            sources: [{ source: "userSettings", settings: { env: { SECRET_TOKEN: "s3cret" } } }],
            applied: {
              model: appliedModel,
              effort: "medium",
              advisor: { secret: "s3cret" },
              ultracode: flagSettings.ultracode === true && ultracodeAvailable,
              ultracodeRequested: flagSettings.ultracode === true,
              ultracodeAvailable,
            },
          }
        : m.request.subtype === "get_usage"
          ? {
              session: { total_cost_usd: 0.25, total_api_duration_ms: 900, total_duration_ms: 4000, total_lines_added: 3, total_lines_removed: 1, model_usage: { "claude-haiku-5-5": { inputTokens: 10 } } },
              subscription_type: "max",
              rate_limits_available: true,
              rate_limits: {
                five_hour: { utilization: 32, resets_at: "2026-10-14T05:19:59Z", note: "s3cret" },
                seven_day: { utilization: 91, resets_at: "2026-10-17T12:59:59Z" },
                seven_day_opus: null,
                model_scoped: [{ display_name: "Fable", utilization: 0, resets_at: "2026-10-17T13:00:00Z", id: "s3cret" }],
                extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1200, utilization: 24, currency: "USD" },
              },
              behaviors:
                m.request.skip_behaviors === true
                  ? null
                  : {
                      day: {
                        request_count: 12,
                        session_count: 2,
                        project: "s3cret",
                        behaviors: [
                          { key: "cache_miss", pct: 34, count: 5, prompt: "s3cret" },
                          { key: "brand_new_trait", pct: 12, count: 1 },
                          { key: "<b>not a key</b>", pct: 50, count: 9 },
                        ],
                        agents: [{ name: "general-purpose", pct: 40, transcript: "s3cret" }],
                        skills: [],
                        plugins: [],
                        mcp_servers: [{ name: "github", pct: 11 }],
                      },
                      week: { request_count: 80, session_count: 9, behaviors: [{ key: "long_context", pct: 61, count: 40 }], agents: [], skills: [{ name: "dataviz", pct: 3 }], plugins: [], mcp_servers: [] },
                    },
            }
          : {};
    out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { subtype: m.request.subtype, ...extra } } });
    if (m.request.subtype === "set_permission_mode") out({ type: "system", subtype: "status", permissionMode: m.request.mode, session_id: sid });
    return;
  }
  if (m.type === "control_cancel_request") {
    record({ cancel: m.request_id });
    if (sides.delete(m.request_id)) out({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: "Side question cancelled" } });
    return;
  }
  if (m.type === "control_response") {
    const wait = hookWaits.get(m.response.request_id);
    if (wait) {
      hookWaits.delete(m.response.request_id);
      record({ hookAnswer: m.response.response ?? null });
      return wait(m.response.response);
    }
    const r = m.response.response;
    out({ type: "answered", request_id: m.response.request_id, behavior: r?.behavior, ...(r?.action ? { action: r.action, content: r.content, keys: Object.keys(r) } : {}) });
  }
}

function rename(request_id, r) {
  const fail = (error) => out({ type: "control_response", response: { subtype: "error", request_id, error } });
  if (typeof r.title !== "string") return fail("rename_session: title must be a string");
  if (r.source != null && r.source !== "remote" && r.source !== "host") return fail("rename_session: source must be 'remote' or 'host'");
  const title = cleanTitle(r.title);
  if (!title) return fail("title must be non-empty");
  if (r.session_id !== undefined && r.session_id !== sid) return fail("session_id is not the current session");
  const file = transcript();
  if (fs.existsSync(file)) {
    fs.appendFileSync(file, [{ type: "custom-title", customTitle: title, sessionId: sid }, { type: "agent-name", agentName: title, sessionId: sid }].map((row) => JSON.stringify(row) + "\n").join(""));
    fs.mkdirSync(path.join(path.dirname(file), sid), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(path.dirname(file), sid, "custom-title.json"), JSON.stringify({ customTitle: title }), { mode: 0o600 });
  }
  out({ type: "system", subtype: "session_title_changed", title, uuid: randomUUID(), session_id: sid });
  out({ type: "control_response", response: { subtype: "success", request_id, response: {} } });
}
