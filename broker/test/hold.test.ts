import assert from "node:assert/strict";
import { test } from "node:test";
import { setLang } from "../../web/src/i18n/index.ts";
import { closedText } from "../../web/src/labels.ts";
import { PUSH_TEXT } from "../src/push/text.ts";
import { copyTitle } from "../src/sessions/copies.ts";
import { HOLD_TEXT, envLang, holderKind } from "../src/wrapper/hold.ts";

test("a copy is named after the first line of the original's name, cut short, and a copy of a copy counts on", () => {
  assert.equal(copyTitle("Fix the invoice export", "ko"), "(복사본) Fix the invoice export");
  assert.equal(copyTitle("(복사본) Fix the invoice export", "ko"), "(복사본 2) Fix the invoice export");
  assert.equal(copyTitle("(복사본 2) Fix the invoice export", "ko"), "(복사본 3) Fix the invoice export");
  assert.equal(copyTitle("(copy 2) Fix the invoice export", "ko"), "(복사본 3) Fix the invoice export", "either language's mark counts");
  assert.equal(copyTitle("Fix the invoice export", "en"), "(copy) Fix the invoice export");
  assert.equal(copyTitle("(복사본) Fix the invoice export", "en"), "(copy 2) Fix the invoice export");
  assert.equal(copyTitle("\n\n  Fix the export\nthen the tests", "ko"), "(복사본) Fix the export");
  assert.equal(copyTitle("Fix the\texport", "ko"), "(복사본) Fix the export", "a tab becomes a space, as Claude Code keeps names");
  assert.equal(copyTitle("가".repeat(300), "ko"), `(복사본) ${"가".repeat(120)}`);
  assert.equal(copyTitle("😀".repeat(130), "en"), `(copy) ${"😀".repeat(120)}`, "cut by characters, not UTF-16 units");
  assert.equal(copyTitle("   ", "ko"), undefined);
  assert.equal(copyTitle("", "en"), undefined);
  assert.equal(copyTitle("(복사본) ", "ko"), "(복사본) (복사본)", "a mark alone is a name like any other");
});

test("the wrapper alone writes in its environment's language", () => {
  assert.equal(envLang({ LANG: "ko_KR.UTF-8" }), "ko");
  assert.equal(envLang({ LANG: "ko" }), "ko");
  assert.equal(envLang({ LANG: "en_US.UTF-8" }), "en");
  assert.equal(envLang({ LC_ALL: "ko_KR.UTF-8", LANG: "en_US.UTF-8" }), "ko");
  assert.equal(envLang({ LC_MESSAGES: "ko_KR.UTF-8", LANG: "en_US.UTF-8" }), "ko");
  assert.equal(envLang({ LC_ALL: "C.UTF-8", LANG: "ko_KR.UTF-8" }), "en", "LC_ALL wins as the C library has it");
  assert.equal(envLang({ LANG: "kok_IN" }), "en", "Konkani is not Korean");
  assert.equal(envLang({}), "en");
});

test("the notices name the kind of process that keeps the original, in both languages", () => {
  assert.deepEqual(["VS Code", "Terminal", "Background", "SDK", "ccrc", undefined].map(holderKind), ["vscode", "terminal", "background", "other", "other", "other"]);
  const ko = HOLD_TEXT.ko;
  assert.equal(
    ko.copy(ko.holder.terminal, false),
    "이 대화는 터미널에서 열려 있어 복사본으로 열었습니다. 여기서 보내는 메시지는 원본에 들어가지 않습니다. 원본을 이으려면 이 탭을 닫고 터미널에서 이어 가세요.",
  );
  assert.ok(ko.copy(ko.holder.vscode, true).startsWith("이 대화는 VS Code의 다른 탭에서 답하는 중이라 복사본으로 열었습니다."));
  const en = HOLD_TEXT.en;
  assert.equal(
    en.copy(en.holder.background, false),
    "This conversation is open in a background session, so it opened here as a copy. Messages sent here don't go to the original. To continue the original, close this tab and go on in a background session.",
  );
  assert.ok(en.copy(en.holder.vscode, true).startsWith("Another VS Code tab is still answering in this conversation, so it opened here as a copy."));
  for (const words of [ko, en]) {
    assert.ok(words.moved && words.stopped);
    assert.notEqual(words.copyPrefix(1), words.copyPrefix(2));
  }
  assert.equal(PUSH_TEXT.ko.original(ko.holder.vscode), "원본은 VS Code의 다른 탭에 그대로 있습니다");
  assert.equal(PUSH_TEXT.en.original(en.holder.terminal), "the original is still open in a terminal");
});

test("the phone says a session moved to another VS Code tab, in its language", () => {
  assert.equal(closedText("moved"), "VS Code의 다른 탭으로 옮겼습니다.");
  setLang("en", ["en-US"]);
  try {
    assert.equal(closedText("moved"), "Moved to another VS Code tab.");
  } finally {
    setLang("ko");
  }
});
