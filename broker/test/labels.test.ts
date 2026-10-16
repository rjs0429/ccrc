import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelOption } from "../src/protocol.ts";
import { effortLevels, errorText, fastReasonText, findModel, modelLabel, modelOffers, noteText } from "../../web/src/labels.ts";

test("the errors a stopped session's chips can meet read in Korean", () => {
  for (const message of ["session is starting", "session started meanwhile", "unknown model"]) assert.match(errorText(message), /[가-힣]/, message);
  assert.equal(errorText("something new"), "something new");
});

test("Fast mode's notes and reasons read in Korean; a broker session's opt-in is no reason", () => {
  assert.equal(noteText("fast", "credits"), "Fast 모드: 사용 크레딧이 다 떨어져 표준 속도로 보냅니다");
  assert.equal(noteText("fast", "extra_usage_disabled"), "Fast 모드를 켜지 못했습니다. 사용 크레딧이 꺼져 있습니다 (claude.ai 설정 > 사용량)");
  assert.equal(noteText("fast", "sdk_opt_in_required"), "Fast 모드를 켜지 못했습니다. 지금은 쓸 수 없습니다");
  assert.equal(fastReasonText("sdk_opt_in_required"), undefined);
  assert.equal(fastReasonText(undefined), undefined);
  assert.equal(fastReasonText("brand_new"), "지금은 쓸 수 없습니다 (brand_new)");
  for (const reason of ["free", "preference", "model_not_allowed", "network_error", "not_first_party", "disabled_by_env", "unknown", "pending"]) {
    assert.match(fastReasonText(reason) ?? "", /[가-힣]/, reason);
  }
});

test("a model's entry says whether it runs in Fast mode, can turn Thinking off, and holds Effort at High with Thinking off", () => {
  const models: ModelOption[] = [
    { value: "default", resolved: "claude-opus-5-5", label: "Default", fast: true, thinkingOff: false },
    { value: "claude-opus-5", resolved: "claude-opus-5", label: "Opus 5", fast: true, thinkingOff: true },
  ];
  assert.deepEqual(modelOffers(models, "default"), { fast: true, thinkingOff: false, capped: false });
  assert.deepEqual(modelOffers(models, "claude-opus-5[1m]"), { fast: true, thinkingOff: true, capped: true });
  assert.deepEqual(modelOffers(models, "claude-other-1"), { fast: false, thinkingOff: undefined, capped: false });
  assert.deepEqual(modelOffers(models), { fast: false, thinkingOff: undefined, capped: false });
});

const ALL = ["low", "medium", "high", "xhigh", "max"] as const;
const MODELS: ModelOption[] = [
  { value: "default", resolved: "claude-opus-5-5", label: "Default (recommended)", efforts: [...ALL] },
  { value: "opus", resolved: "claude-opus-5-5", label: "Opus 5.5", efforts: [...ALL] },
  { value: "sonnet", resolved: "claude-sonnet-5-5", label: "Sonnet 5.5", efforts: ["low", "medium", "high"] },
  { value: "claude-haiku-4-5-20251001", resolved: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];

test("a 1M context model the list does not name takes its base model's name and Effort levels", () => {
  assert.equal(findModel(MODELS, "claude-opus-5-5[1m]"), undefined);
  assert.equal(modelLabel(MODELS, "claude-opus-5-5[1m]"), "Opus 5.5 (1M)");
  assert.deepEqual(effortLevels(MODELS, "claude-opus-5-5[1m]"), [...ALL]);
  assert.deepEqual(effortLevels(MODELS, "claude-sonnet-5-5[1m]"), ["low", "medium", "high"]);
  assert.equal(modelLabel(MODELS, "claude-fable-5-1[1m]"), "Fable 5.1 (1M)");
  assert.deepEqual(effortLevels(MODELS, "claude-fable-5-1[1m]"), [...ALL]);
});

test("a 1M context entry of its own wins over the base model", () => {
  const own: ModelOption = { value: "opus[1m]", resolved: "claude-opus-5-5[1m]", label: "Opus 5.5 (1M context)", efforts: ["high", "max"] };
  assert.equal(findModel([...MODELS, own], "claude-opus-5-5[1m]"), own);
  assert.equal(modelLabel([...MODELS, own], "claude-opus-5-5[1m]"), "Opus 5.5 (1M context)");
  assert.deepEqual(effortLevels([...MODELS, own], "claude-opus-5-5[1m]"), ["high", "max"]);
});

test("Effort is left out only for a known model without levels and no level set", () => {
  assert.equal(effortLevels(MODELS, "claude-haiku-4-5-20251001"), undefined);
  assert.deepEqual(effortLevels(MODELS, "claude-haiku-4-5-20251001", "high"), [...ALL]);
  assert.deepEqual(effortLevels(MODELS, undefined), [...ALL]);
  assert.deepEqual(effortLevels([], "claude-opus-5-5[1m]"), [...ALL]);
  assert.equal(modelLabel(MODELS, "claude-opus-5-5"), "Opus 5.5");
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
  assert.equal(noteText("unsent", "이 사진도 봐줘", 2), "Claude Code가 받지 못한 메시지 (첨부 2개): 이 사진도 봐줘");
  assert.equal(noteText("unsent", undefined, 1), "Claude Code가 받지 못한 메시지 (첨부 1개)");
});

test("taking back a message VS Code's wrapper no longer holds reads as already received", () => {
  for (const message of ["rejected by the wrapper: message not allowed", "message is no longer queued"]) {
    assert.equal(errorText(message), "Claude Code가 이미 받은 메시지라 되돌릴 수 없습니다", message);
  }
});
