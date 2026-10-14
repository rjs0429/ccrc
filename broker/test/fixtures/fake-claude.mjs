// Stands in for Claude Code in relay tests. Reads stream-json lines and answers in a fixed way:
// a user message is replayed and answered; "ASK" opens a permission prompt; "CANCEL" opens one and
// withdraws it; "MCP" sends VS Code an MCP request; "BIG" answers with a very long line; "HOLD" leaves
// the turn running. Its init line reports whether it was asked to continue a cut-off turn. Control
// requests get a success response, and each control_response it receives is reported back as
// {"type":"answered"}. FAKE_BURST=1 writes a long line and an error result at start and exits at once;
// FAKE_LINGER_MS keeps it running that long after its input ends.
// The answer to initialize lists models and commands; FAKE_NO_INIT=1 leaves initialize unanswered.
// --version prints a version and exits.
import { randomUUID } from "node:crypto";

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
const sid = value("--session-id") || (args.includes("--fork-session") ? undefined : value("--resume")) || randomUUID();
const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
let asks = 0;

out({ type: "system", subtype: "init", session_id: sid, model: "fake-model", permissionMode: "default", args, continueTurn: process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN ?? null });
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
    out({ ...m, session_id: sid, uuid: m.uuid ?? randomUUID(), isReplay: true });
    if (text === "HOLD") return;
    if (text === "MCP") {
      out({ type: "control_request", request_id: "mcp-1", request: { subtype: "mcp_message", server_name: "claude-vscode", message: { method: "x" } } });
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
    const init = m.request.subtype === "initialize";
    if (init && process.env.FAKE_NO_INIT) return;
    const extra = init
      ? { models: [{ value: "default", displayName: "Default" }], commands: [{ name: "compact", description: "Compact the conversation", argumentHint: "" }], current_permission_mode: "default" }
      : {};
    out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { subtype: m.request.subtype, ...extra } } });
    if (m.request.subtype === "set_permission_mode") out({ type: "system", subtype: "status", permissionMode: m.request.mode, session_id: sid });
    return;
  }
  if (m.type === "control_response") {
    out({ type: "answered", request_id: m.response.request_id, behavior: m.response.response?.behavior });
  }
}
