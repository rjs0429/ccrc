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
  | "reattach"
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
  | "side_question"
  | "export"
  | "config"
  | "passkey_registered"
  | "passkey_verified"
  | "passkey_failed"
  | "passkey_removed"
  | "passkey_reset";

const ROTATE_BYTES = 5 * 1024 * 1024;

// The file the log moves to once it grows past ROTATE_BYTES, replacing the one moved before.
export const rotatedAudit = (file: string) => `${file}.1`;

// Records who did what; message text and tool input are not recorded.
export class Audit {
  readonly file: string;
  private size: number;
  private rotateBytes: number;

  constructor(file = paths.auditFile, rotateBytes = ROTATE_BYTES) {
    this.file = file;
    this.rotateBytes = rotateBytes;
    ensureDir(path.dirname(file));
    this.size = fileSize(file);
  }

  log(event: AuditEvent, detail: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...detail }) + "\n";
    const bytes = Buffer.byteLength(line);
    if (this.size + bytes > this.rotateBytes) {
      try {
        fs.renameSync(this.file, rotatedAudit(this.file));
      } catch {}
      this.size = 0;
    }
    this.size += bytes;
    try {
      fs.appendFileSync(this.file, line, { mode: 0o600 });
    } catch {}
  }
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}
