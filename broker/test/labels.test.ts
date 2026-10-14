import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelOption } from "../src/protocol.ts";
import { effortLevels, errorText, findModel, modelLabel } from "../../web/src/labels.ts";

test("the errors a stopped session's chips can meet read in Korean", () => {
  for (const message of ["session is starting", "session started meanwhile", "unknown model"]) assert.match(errorText(message), /[가-힣]/, message);
  assert.equal(errorText("something new"), "something new");
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
