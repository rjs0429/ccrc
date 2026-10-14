import assert from "node:assert/strict";
import { test } from "node:test";
import { errorText, noteText } from "../../web/src/labels.ts";

test("the errors a stopped session's chips can meet read in Korean", () => {
  for (const message of ["session is starting", "session started meanwhile", "unknown model"]) assert.match(errorText(message), /[가-힣]/, message);
  assert.equal(errorText("something new"), "something new");
});

test("a start refused for a missing folder and Claude Code's spawn failures read in Korean", () => {
  assert.equal(errorText("working folder is missing: /home/someone/tmp/x"), "작업 폴더가 없어 세션을 시작할 수 없습니다: ~/tmp/x");
  const launch =
    "Claude Code native binary at /home/u/.local/bin/claude exists but failed to launch. This usually means the binary does not match this system's libc — e.g. spawning a musl-linked binary on a glibc Linux host fails because the musl dynamic loader (/lib/ld-musl-*) is missing. Specify a matching binary with options.pathToClaudeCodeExecutable.";
  assert.match(errorText(launch), /^Claude Code를 실행하지 못했습니다/);
  assert.doesNotMatch(errorText(launch), /musl/);
  assert.equal(
    errorText("Claude Code native binary not found at /opt/claude. Please ensure Claude Code is installed via native installer or specify a valid path with options.pathToClaudeCodeExecutable."),
    "Claude Code 실행 파일을 찾을 수 없습니다: /opt/claude",
  );
  assert.equal(errorText("Claude Code executable not found at /opt/cli.js. Is options.pathToClaudeCodeExecutable set?"), "Claude Code 실행 파일을 찾을 수 없습니다: /opt/cli.js");
  assert.equal(errorText("Failed to spawn Claude Code process: spawn EACCES"), "Claude Code를 실행하지 못했습니다 (spawn EACCES)");
  assert.equal(errorText("Claude Code process exited with code 1. stderr: No conversation found with session ID: abc"), "대화 기록을 찾지 못해 이 세션을 이어서 실행할 수 없습니다");
  assert.equal(errorText("Claude Code process exited with code 2"), "Claude Code가 종료되었습니다 (코드 2)");
  assert.equal(errorText("Claude Code process exited with code 3. stderr: boom"), "Claude Code가 종료되었습니다 (코드 3): boom");
  assert.equal(errorText("Claude Code process terminated by signal SIGKILL"), "Claude Code가 강제로 종료되었습니다 (SIGKILL)");
  assert.equal(noteText("error", "Claude Code process exited with code 2"), "오류: Claude Code가 종료되었습니다 (코드 2)");
  assert.equal(noteText("error", "API Error: 529"), "오류: API Error: 529");
});
