// Stands in for Claude Code in relay tests. Reads stream-json lines and answers in a fixed way:
// a user message is replayed and answered; "ASK" opens a permission prompt; "CANCEL" opens one and
// withdraws it; "BIG" answers with a very long line. Control requests get a success response, and
// each control_response it receives is reported back as {"type":"answered"}.
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const value = (name) => {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1];
    if (args[i].startsWith(name + "=")) return args[i].slice(name.length + 1);
  }
};
const sid = value("--session-id") || value("--resume") || randomUUID();
const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
let asks = 0;

out({ type: "system", subtype: "init", session_id: sid, model: "fake-model", permissionMode: "default" });

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
process.stdin.on("end", () => process.exit(Number(process.env.FAKE_EXIT_CODE ?? 0)));

function handle(m) {
  if (m.type === "user") {
    const content = m.message.content;
    const text = typeof content === "string" ? content : content.map((c) => c.text).join("");
    out({ ...m, session_id: sid, uuid: m.uuid ?? randomUUID(), isReplay: true });
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
    const extra = m.request.subtype === "initialize" ? { models: [{ value: "default", displayName: "Default" }], current_permission_mode: "default" } : {};
    out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { subtype: m.request.subtype, ...extra } } });
    if (m.request.subtype === "set_permission_mode") out({ type: "system", subtype: "status", permissionMode: m.request.mode, session_id: sid });
    return;
  }
  if (m.type === "control_response") {
    out({ type: "answered", request_id: m.response.request_id, behavior: m.response.response?.behavior });
  }
}
