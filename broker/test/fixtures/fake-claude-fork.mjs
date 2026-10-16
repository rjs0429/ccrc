// Stands in for Claude Code in fork and rewind tests. It keeps its transcript under CLAUDE_CONFIG_DIR as Claude Code does
// and resumes the conversation it holds, a rewind's explicit last-prompt row included. --resume X --fork-session
// --session-id Y [--resume-session-at Z] starts a copy of X up to Z under Y, written at the first input. "/rename <name>"
// runs as the local command it is; "HOLD" leaves its turn running until an interrupt; any other message is answered with
// "echo: <text>". rewind_conversation refuses or rewinds in place as Claude Code does, with its last-prompt row;
// FAKE_NO_REWIND=1 or a .fake-no-rewind file in the working folder is a Claude Code without it, and a .fake-unseen file
// there makes it refuse with unseen_later_turn. rewind_files answers from .fake-rewind.json there ({files, insertions,
// deletions, skippedLinks}); without it no checkpoint is found. FAKE_REQUESTS=<file> gets its arguments, then each
// request and message.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("2.1.300 (Claude Code)");
  process.exit(0);
}
const value = (name) => {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1];
    if (args[i].startsWith(name + "=")) return args[i].slice(name.length + 1);
  }
};
const forking = args.includes("--fork-session");
const source = value("--resume");
const sid = value("--session-id") || (forking ? undefined : source) || randomUUID();
const config = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const projects = path.join(config, "projects");
const cwd = process.cwd();
const file = path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sid}.jsonl`);
const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const record = (m) => process.env.FAKE_REQUESTS && fs.appendFileSync(process.env.FAKE_REQUESTS, JSON.stringify({ sid, ...m }) + "\n");
const append = (rows) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, rows.map((r) => JSON.stringify(r) + "\n").join(""));
};
const now = () => new Date().toISOString();
const base = () => ({ sessionId: sid, cwd, isSidechain: false, userType: "external", version: "2.1.300", gitBranch: "" });
record({ args });

function rowsOf(id) {
  let f;
  for (const dir of fs.existsSync(projects) ? fs.readdirSync(projects) : []) {
    const p = path.join(projects, dir, `${id}.jsonl`);
    if (fs.existsSync(p)) f = p;
  }
  if (!f) return undefined;
  return fs
    .readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const MESSAGE = new Set(["user", "assistant", "attachment", "system"]);

// The conversation as Claude Code resumes it: up to `at`, else where a rewind no message followed left it, else the
// last row written.
function chainOf(rows, at) {
  const byId = new Map();
  let leaf;
  let rewound;
  for (const r of rows) {
    if (r.type === "last-prompt") {
      if (r.leafUuid) rewound = r.explicit || rewound?.leaf === r.leafUuid ? { leaf: r.leafUuid } : undefined;
      else if (r.leafUuid === null && r.explicit) rewound = { leaf: null };
      continue;
    }
    if (!MESSAGE.has(r.type) || !r.uuid || r.isSidechain) continue;
    byId.set(r.uuid, r);
    leaf = r.uuid;
    rewound = undefined;
  }
  let id = at ?? (rewound ? rewound.leaf : leaf);
  const chain = [];
  while (id && byId.has(id)) {
    chain.unshift(byId.get(id));
    id = byId.get(id).parentUuid;
  }
  return chain;
}

let conv = [];
let pending;
if (forking) {
  const rows = rowsOf(source);
  if (!rows) {
    process.stderr.write(`No conversation found with session ID: ${source}\n`);
    process.exit(1);
  }
  pending = chainOf(rows, value("--resume-session-at"));
  conv = pending;
  fs.mkdirSync(path.join(config, "file-history", sid), { recursive: true });
  const named = rows.filter((r) => r.type === "custom-title").at(-1)?.customTitle;
  if (named) out({ type: "system", subtype: "session_title_changed", title: named, uuid: randomUUID(), session_id: sid });
} else if (source) {
  const rows = rowsOf(source);
  if (!rows) {
    process.stderr.write(`No conversation found with session ID: ${source}\n`);
    process.exit(1);
  }
  conv = chainOf(rows);
}
const leaf = () => conv.at(-1)?.uuid ?? null;
const add = (row) => {
  const full = { parentUuid: leaf(), ...base(), timestamp: now(), ...row };
  append([full]);
  conv.push(full);
  return full;
};
// The copy is written with the first input, as Claude Code writes a fork.
const flush = () => {
  if (!pending) return;
  append(pending.map((r) => ({ ...r, sessionId: sid })));
  pending = undefined;
};
const textOf = (r) => (typeof r.message?.content === "string" ? r.message.content : (r.message?.content ?? []).map((b) => b.text ?? "").join(""));
// A turn the user started: a message or a command, not a tool result, a note of Claude Code's or an interruption.
const prompt = (r) => r.type === "user" && !r.isMeta && !(Array.isArray(r.message?.content) && r.message.content.some((b) => b.type === "tool_result")) && !/^\[Request interrupted by user/.test(textOf(r));

let holding;
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
process.stdin.on("end", () => process.exit(0));

const done = (extra = {}) => out({ type: "result", subtype: "success", session_id: sid, is_error: false, num_turns: 1, total_cost_usd: 0.001, ...extra });
const answer = (m, response) => out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response } });

function handle(m) {
  if (m.type === "user") {
    const text = textOf(m);
    record({ user: text });
    flush();
    const uuid = m.uuid ?? randomUUID();
    out({ type: "command_lifecycle", command_uuid: uuid, state: "started", uuid: randomUUID(), session_id: sid });
    out({ type: "system", subtype: "init", session_id: sid, cwd, model: value("--model") ?? "claude-haiku-5-5", permissionMode: value("--permission-mode") ?? "default", args });
    const rename = /^\/rename (.+)$/s.exec(text);
    if (rename) {
      const name = rename[1].trim();
      const command = `<command-name>/rename</command-name>\n            <command-message>rename</command-message>\n            <command-args>${name}</command-args>`;
      const shown = `Session renamed to: ${name}`;
      add({ type: "user", uuid: randomUUID(), isMeta: true, message: { role: "user", content: "<local-command-caveat>The command below was run directly in Claude Code, not sent to the model.</local-command-caveat>" } });
      add({ type: "user", uuid, message: { role: "user", content: command } });
      add({ type: "system", subtype: "local_command", uuid: randomUUID(), content: `<local-command-stdout>${shown}</local-command-stdout>`, level: "info", isMeta: false, commandRun: { command: "rename", args: name } });
      append([
        { type: "custom-title", customTitle: name, sessionId: sid },
        { type: "agent-name", agentName: name, sessionId: sid },
      ]);
      out({ type: "system", subtype: "session_title_changed", title: name, uuid: randomUUID(), session_id: sid });
      out({ type: "assistant", session_id: sid, uuid: randomUUID(), parent_tool_use_id: null, message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: shown }] }, local_command_source: `<local-command-stdout>${shown}</local-command-stdout>`, local_command_run: { command: "rename", args: name } });
      out({ type: "user", session_id: sid, uuid, isReplay: true, parent_tool_use_id: null, message: { role: "user", content: command } });
      done({ num_turns: 0, result: shown, local_command: "rename" });
      out({ type: "command_lifecycle", command_uuid: uuid, state: "completed", uuid: randomUUID(), session_id: sid });
      return;
    }
    add({ type: "user", uuid, message: { role: "user", content: text } });
    out({ ...m, session_id: sid, uuid, isReplay: true });
    if (text === "HOLD") {
      holding = uuid;
      return;
    }
    const reply = add({ type: "assistant", uuid: randomUUID(), message: { id: `msg_${randomUUID()}`, role: "assistant", model: "claude-haiku-5-5", type: "message", content: [{ type: "text", text: `echo: ${text}` }], stop_reason: "end_turn" } });
    out({ type: "assistant", session_id: sid, uuid: reply.uuid, parent_tool_use_id: null, message: reply.message });
    done();
    out({ type: "command_lifecycle", command_uuid: uuid, state: "completed", uuid: randomUUID(), session_id: sid });
    return;
  }
  if (m.type !== "control_request") return;
  const r = m.request;
  record({ request: r });
  if (r.subtype === "initialize") {
    return answer(m, { commands: [{ name: "rename", description: "Rename the session", argumentHint: "<name>" }], models: [{ value: "default", displayName: "Default" }], current_permission_mode: value("--permission-mode") ?? "default", output_style: "default", available_output_styles: ["default"] });
  }
  if (r.subtype === "interrupt") {
    answer(m, {});
    if (!holding) return;
    holding = undefined;
    add({ type: "user", uuid: randomUUID(), message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
    out({ type: "result", subtype: "error_during_execution", session_id: sid, is_error: true, terminal_reason: "aborted_streaming", errors: [], total_cost_usd: 0 });
    return;
  }
  if (r.subtype === "rewind_conversation") {
    if (process.env.FAKE_NO_REWIND || fs.existsSync(".fake-no-rewind")) return out({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: `Unsupported control request subtype: ${r.subtype}` } });
    const refuse = (reason) => answer(m, { rewound: false, prefillText: null, precedingAssistantUuid: null, error: reason.replace(/_/g, " "), reason });
    if (holding) return refuse("turn_running");
    if (fs.existsSync(".fake-unseen")) return refuse("unseen_later_turn");
    const at = conv.findIndex((row) => row.uuid === r.target_message_uuid && prompt(row));
    if (at < 0) return refuse("target_not_found");
    const seen = r.last_seen_user_message_uuid ? conv.findIndex((row) => row.uuid === r.last_seen_user_message_uuid) : -1;
    const later = conv.slice(at + 1).filter(prompt);
    if (later.length && !r.last_seen_user_message_uuid) return refuse("stale_target");
    if (later.some((row) => conv.indexOf(row) > seen)) return refuse("unseen_later_turn");
    const target = conv[at];
    const before = conv.slice(0, at);
    const anchor = before.findLast((row) => row.type === "assistant" || prompt(row));
    conv = before;
    append([{ type: "last-prompt", leafUuid: anchor?.uuid ?? null, explicit: true, rewound: true, sessionId: sid }]);
    return answer(m, { rewound: true, targetMessageUuid: target.uuid, prefillText: textOf(target), precedingAssistantUuid: before.findLast((row) => row.type === "assistant")?.uuid ?? null });
  }
  if (r.subtype === "rewind_files") {
    let plan;
    try {
      plan = JSON.parse(fs.readFileSync(".fake-rewind.json", "utf8"));
    } catch {
      return answer(m, { canRewind: false, error: "No file checkpoint found for this message." });
    }
    const files = plan.files ?? [];
    return answer(m, r.dry_run ? { canRewind: true, filesChanged: files, insertions: plan.insertions ?? 0, deletions: plan.deletions ?? 0 } : { canRewind: true, filesChanged: files, skippedLinks: plan.skippedLinks ?? 0 });
  }
  if (r.subtype === "get_settings") return answer(m, { effective: {}, applied: { model: value("--model") ?? "claude-haiku-5-5", effort: value("--effort") ?? null, ultracode: false, ultracodeAvailable: false } });
  if (r.subtype === "get_context_usage") return answer(m, { categories: [], totalTokens: 1000, maxTokens: 200000, rawMaxTokens: 200000, percentage: 1, model: "claude-haiku-5-5" });
  answer(m, {});
}
