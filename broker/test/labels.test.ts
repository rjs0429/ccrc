import assert from "node:assert/strict";
import { test } from "node:test";
import { errorText } from "../../web/src/labels.ts";

test("the errors a stopped session's chips can meet read in Korean", () => {
  for (const message of ["session is starting", "session started meanwhile", "unknown model"]) assert.match(errorText(message), /[가-힣]/, message);
  assert.equal(errorText("something new"), "something new");
});

test("taking back a message VS Code's wrapper no longer holds reads as already received", () => {
  for (const message of ["rejected by the wrapper: message not allowed", "message is no longer queued"]) {
    assert.equal(errorText(message), "Claude Code가 이미 받은 메시지라 되돌릴 수 없습니다", message);
  }
});
