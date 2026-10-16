import assert from "node:assert/strict";
import { test } from "node:test";
import type { DisplayItem } from "../src/protocol.ts";
import { bareCommandSheet, commandSheet } from "../../web/src/components/commandSheets.ts";
import { actionable, excerpt, filesBack, filesDone, filesError, lastSeen } from "../../web/src/components/messageActions.ts";
import { errorText } from "../../web/src/labels.ts";

const U1 = "8f0c1a52-3d4e-4b6a-9f20-1e5d7c9b2a41";
const U2 = "1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9";
const C1 = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

test("/fork and /branch open the fork sheet, /rewind the rewind sheet whatever runs the session", () => {
  assert.equal(commandSheet("fork")?.sheet, "fork");
  assert.equal(commandSheet("/branch")?.sheet, "fork");
  assert.equal(bareCommandSheet("/fork"), "fork");
  assert.equal(bareCommandSheet("/fork 다른 방법"), undefined, "with a task it goes through the chat, which keeps the task");
  assert.deepEqual(commandSheet("undo"), { sheet: "rewind", title: "되돌리기" });
});

test("the latest turn the phone shows starting is a message or a command with Claude Code's uuid", () => {
  const items: DisplayItem[] = [
    { kind: "user", id: U1, text: "첫째" },
    { kind: "assistant", id: `${U1}:0`, text: "답" },
    { kind: "note", id: C1, code: "command", text: "/rename x" },
    { kind: "command", id: "c-1", text: "Session renamed to: x" },
    { kind: "note", id: "note-3", code: "interrupted" },
    { kind: "tool", id: "toolu_1", name: "Read", summary: "", input: {} },
  ];
  assert.equal(lastSeen(items), C1);
  assert.equal(lastSeen([...items, { kind: "user", id: U2, text: "둘째" }]), U2);
  assert.equal(lastSeen([{ kind: "user", id: "user-3", text: "uuid 없음" }]), undefined);
  assert.equal(actionable({ kind: "user", id: U1, text: "" }), true);
  assert.equal(actionable({ kind: "user", id: "user-3", text: "" }), false);
  assert.equal(excerpt({ kind: "user", id: U1, text: "\n  첫 줄\n둘째 줄" }), "첫 줄");
  assert.equal(excerpt({ kind: "user", id: U1, text: "", attachments: [{ kind: "image", mediaType: "image/png", size: 1 }] }), "이미지 1개");
});

test("why a rewind or a fork did not happen reads in Korean", () => {
  assert.equal(errorText("rewind refused: unseen_later_turn"), "그사이 대화가 바뀌었습니다. 새로고침한 뒤 다시 하세요");
  assert.equal(errorText("rewind refused: turn_running"), "작업 중에는 되돌릴 수 없습니다. 먼저 멈추세요");
  assert.equal(errorText("rewind refused: usage_limited"), "지금은 되돌릴 수 없습니다 (usage_limited)");
  assert.equal(errorText("cannot rewind files while open in Terminal"), "터미널에서 열려 있어 파일은 되돌릴 수 없습니다");
  assert.equal(
    errorText("fork failed: Claude Code process exited with code 1. stderr: No conversation found with session ID: x"),
    "갈래를 만들지 못했습니다: 대화 기록을 찾지 못해 이 세션을 이어서 실행할 수 없습니다",
  );
  assert.equal(errorText("fork failed: Claude Code did not run /rename"), "갈래를 만들지 못했습니다: 갈래에 이름을 붙이지 못했습니다");
});

test("what a rewind did to the files reads once, with the files it left as links", () => {
  assert.equal(filesError({ canRewind: false, error: "Failed to rewind: EACCES: permission denied, open 'src/a.txt'" }), "EACCES: permission denied, open 'src/a.txt'");
  assert.equal(filesError({ canRewind: false, error: "No file checkpoint found for this message." }), "이 메시지 시점의 파일 기록이 없습니다");
  assert.equal(filesError({ canRewind: false, error: "request not allowed" }), errorText("request not allowed"));
  assert.equal(filesDone({ canRewind: true }, 2), " · 파일 2개");
  assert.equal(filesDone({ canRewind: true, skippedLinks: 1 }, 2), " · 링크라서 건너뛴 파일 1개");
  assert.equal(filesBack({ canRewind: true }, 2), "파일 2개를 되돌렸습니다");
  assert.equal(filesBack({ canRewind: true, skippedLinks: 1 }, 2), "파일을 되돌렸습니다 · 링크라서 건너뛴 파일 1개");
});
