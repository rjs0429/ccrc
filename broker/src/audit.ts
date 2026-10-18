import fs from "node:fs";
import path from "node:path";
import { ensureDir, paths } from "./config.ts";

export type AuditEvent =
  | "login"
  | "login_failed"
  | "logout"
  | "lease_revoked"
  | "password_changed"
  | "window_taken"
  | "device_denied"
  | "send"
  | "new_session"
  | "answer"
  | "interrupt"
  | "set_mode"
  | "set_model"
  | "set_effort"
  | "set_ultracode"
  | "set_fast"
  | "set_thinking"
  | "start_settings"
  | "release"
  | "attach"
  | "handoff"
  | "upload"
  | "file_read"
  | "agent_transcript"
  | "call"
  | "archive"
  | "worktree_remove"
  | "folder_index"
  | "folder_denied"
  | "claude_settings"
  | "push_subscribe"
  | "push_unsubscribe"
  | "doctor"
  | "fork"
  | "rewind_conversation"
  | "git_changes"
  | "agent_changes"
  | "side_question";

// Records who did what; message text and tool input are not recorded.
export class Audit {
  readonly file: string;

  constructor(file = paths.auditFile) {
    this.file = file;
    ensureDir(path.dirname(file));
  }

  log(event: AuditEvent, detail: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...detail }) + "\n";
    fs.appendFile(this.file, line, { mode: 0o600 }, () => {});
  }
}
