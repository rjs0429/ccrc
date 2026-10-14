import assert from "node:assert/strict";
import { test } from "node:test";
import { errorText } from "../../web/src/labels.ts";

test("the errors a stopped session's chips can meet read in Korean", () => {
  for (const message of ["session is starting", "session started meanwhile", "unknown model"]) assert.match(errorText(message), /[가-힣]/, message);
  assert.equal(errorText("something new"), "something new");
});
