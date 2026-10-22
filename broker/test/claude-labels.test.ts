import assert from "node:assert/strict";
import { test } from "node:test";
import type { EffortName, ModelOption } from "../src/protocol.ts";
import { setLang } from "../../web/src/i18n/index.ts";
import { PROBLEM, choiceLabels, effortModels, failureText, inheritedEffort, valueText } from "../../web/src/screens/settings/claudeLabels.ts";

const ALL: EffortName[] = ["low", "medium", "high", "xhigh", "max"];
const MODELS: ModelOption[] = [
  { value: "default", resolved: "claude-opus-5-5", label: "Default (recommended)", efforts: ALL },
  { value: "opus", resolved: "claude-opus-5-5", label: "Opus", efforts: ALL },
  { value: "fable", resolved: "claude-fable-5-1", label: "Fable", efforts: ALL },
  { value: "sonnet", resolved: "claude-sonnet-5-5", label: "Sonnet", efforts: ALL },
  { value: "haiku", resolved: "claude-haiku-5-5", label: "Haiku", efforts: ALL },
  { value: "claude-haiku-4-5-20251001", resolved: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];

test("a model older than per-model effort and without its own takes the top-level effortLevel; the 5.5 models do not", () => {
  assert.deepEqual(
    effortModels(MODELS, { "modelSettings.claude-opus-5.effortLevel": "high" }).map((r) => r.model),
    ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5"],
  );
  assert.equal(inheritedEffort("claude-fable-5-1", undefined, "low"), "low");
  assert.equal(inheritedEffort("claude-opus-5", undefined, "xhigh"), "xhigh");
  for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]) assert.equal(inheritedEffort(model, undefined, "low"), undefined, model);
  assert.equal(inheritedEffort("claude-fable-5-1", "high", "low"), undefined, "its own level wins");
  assert.equal(inheritedEffort("claude-fable-5-1", undefined, "max"), undefined, "a level Claude Code does not keep reaches no model");
  assert.equal(inheritedEffort("claude-fable-5-1", undefined, undefined), undefined);
});

test("a model setting of \"default\" shows as written, not as Claude Code's default entry", () => {
  assert.equal(valueText("model", "default", MODELS), "default");
  assert.equal(valueText("model", "Default", MODELS), "Default");
  assert.equal(valueText("model", "opus", MODELS), "Opus");
  assert.equal(valueText("model", undefined, MODELS), "기본값");
  assert.equal(valueText("effortLevel", "high", MODELS), "High");
});

test("why a save failed is told in Korean, a file that keeps changing included", () => {
  assert.equal(failureText("changed", 409), "설정 파일이 계속 바뀌고 있습니다");
  assert.equal(failureText("invalid", 400), "값이 올바르지 않습니다");
  assert.equal(failureText("not_json", 422), PROBLEM.not_json);
  assert.equal(failureText("not_object"), PROBLEM.not_object);
  assert.equal(failureText("Internal Server Error", 500), "노트북에서 설정 파일을 쓰지 못했습니다");
  assert.equal(failureText("", 403), "노트북이 요청을 받지 않았습니다 (HTTP 403)");
  assert.equal(failureText("bad_origin", 403), "노트북이 요청을 받지 않았습니다 (bad_origin)");
  assert.equal(failureText("", 0), "노트북에 연결하지 못했습니다");
  assert.equal(failureText("boom"), "알 수 없는 오류입니다 (boom)");
});

test("the settings' values and failures read in English once English is chosen", () => {
  assert.equal(valueText("theme", "dark-daltonized", MODELS), "어둡게 (색각 보정)");
  setLang("en", ["en-US"]);
  try {
    assert.equal(valueText("model", undefined, MODELS), "Default");
    assert.equal(valueText("alwaysThinkingEnabled", false, MODELS), "Off");
    assert.equal(valueText("theme", "dark-daltonized", MODELS), "Dark mode (colorblind-friendly)");
    assert.equal(valueText("permissions.defaultMode", "acceptEdits", MODELS), "Edit automatically");
    assert.equal(choiceLabels("theme").auto, "Auto (match terminal)");
    assert.deepEqual(choiceLabels("language"), {});
    assert.equal(failureText("changed", 409), "The settings file keeps changing");
    assert.equal(failureText("", 403), "The laptop refused the request (HTTP 403)");
    assert.equal(failureText("", 0), "Couldn't reach the laptop");
    assert.equal(failureText("boom"), "Unknown error (boom)");
  } finally {
    setLang("ko");
  }
  assert.equal(failureText("changed", 409), "설정 파일이 계속 바뀌고 있습니다");
});
