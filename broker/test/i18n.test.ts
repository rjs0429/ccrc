import assert from "node:assert/strict";
import { test } from "node:test";
import { clock, dateTime, dayLabel, fullTime, monthDay, num, shortDateTime } from "../../web/src/i18n/format.ts";
import { deviceLang, fill, k, lang, langKey, locale, localeOf, onLang, resolveLang, setLang, t } from "../../web/src/i18n/index.ts";
import { allowAlwaysLabel, duration, errorText, fastReasonText, hostLabel, idleText, noteText, relTime, sessionTitle, usageResetText } from "../../web/src/labels.ts";

// Some ICU versions put a narrow no-break space before AM/PM.
const plain = (s: string) => s.replace(/[\u202f\u00a0]/g, " ");

function english(fn: () => void): void {
  setLang("en", ["en-US"]);
  try {
    fn();
  } finally {
    setLang("ko");
  }
}

test("placeholders take their values, and a plural form follows its number", () => {
  assert.equal(fill("{a} and {b}", { a: 1, b: "x" }), "1 and x");
  assert.equal(fill("{n|# file|# files}", { n: 1 }), "1 file");
  assert.equal(fill("{n|# file|# files}", { n: 0 }), "0 files");
  assert.equal(fill("{n} file{n||s}", { n: 2 }), "2 files");
  assert.equal(fill("{n|# item|# items}", { n: "1,234" }), "1,234 items", "a number already written with separators");
  assert.equal(fill("{n|# item|# items}", { n: "1" }), "1 item");
  assert.equal(fill("{missing} stays, {n}", { n: 3 }), "{missing} stays, 3");
  assert.equal(fill("{n}", undefined), "{n}");
  assert.equal(fill("a {constructor} b", { n: 1 }), "a {constructor} b", "only the names given count");
});

test("the screens read Korean until English is chosen; a sentence without English stays Korean", () => {
  assert.equal(lang(), "ko");
  assert.equal(t("로그아웃"), "로그아웃");
  assert.equal(t("{n}분 전", { n: 5 }), "5분 전");
  assert.equal(k("로그아웃"), "로그아웃");
  english(() => {
    assert.equal(lang(), "en");
    assert.equal(t("로그아웃"), "Log out");
    assert.equal(t("{n}분 전", { n: 5 }), "5m ago");
    assert.equal(t("아직 영어가 없는 문장 {n}", { n: 2 }), "아직 영어가 없는 문장 2");
    assert.equal(t("constructor"), "constructor");
  });
  assert.equal(t("로그아웃"), "로그아웃");
});

test("auto takes Korean only when the device's first language is Korean", () => {
  assert.equal(deviceLang(["ko-KR", "en-US"]), "ko");
  assert.equal(deviceLang(["ko"]), "ko");
  assert.equal(deviceLang(["KO-kr"]), "ko");
  assert.equal(deviceLang(["en-US", "ko-KR"]), "en");
  assert.equal(deviceLang(["ja-JP", "ko-KR"]), "en");
  assert.equal(deviceLang([]), "en");
  assert.equal(resolveLang("auto", ["ko-KR"]), "ko");
  assert.equal(resolveLang("en", ["ko-KR"]), "en");
  assert.equal(resolveLang("ko", ["en-US"]), "ko");
  assert.equal(resolveLang("fr", ["en-US"]), "en", "an unknown saved choice counts as auto");
  assert.equal(resolveLang(undefined, ["ko-KR"]), "ko");
});

test("English dates follow the device's own English, else en-US", () => {
  assert.equal(localeOf("ko", ["en-GB"]), "ko-KR");
  assert.equal(localeOf("en", ["ko-KR", "en-GB"]), "en-GB");
  assert.equal(localeOf("en", ["ko-KR"]), "en-US");
  assert.equal(localeOf("en", ["en-x-"]), "en-US", "a tag Intl cannot read");
  setLang("en", ["en-GB"]);
  try {
    assert.equal(locale(), "en-GB");
    assert.equal(clock(new Date(2026, 9, 15, 16, 7)), "16:07");
  } finally {
    setLang("ko");
  }
});

test("a change of language is told once, and not when nothing changes", () => {
  let calls = 0;
  const off = onLang(() => calls++);
  setLang("ko");
  assert.equal(calls, 0);
  setLang("en", ["en-US"]);
  setLang("en", ["en-US"]);
  assert.equal(calls, 1);
  setLang("ko");
  assert.equal(calls, 2);
  off();
  setLang("en");
  setLang("ko");
  assert.equal(calls, 2);
});

test("a change of the English locale alone is told and changes what the screens are drawn for", () => {
  let calls = 0;
  const off = onLang(() => calls++);
  try {
    setLang("en", ["en-US"]);
    const us = langKey();
    setLang("en", ["en-GB"]);
    assert.equal(calls, 2);
    assert.equal(lang(), "en");
    assert.notEqual(langKey(), us);
    setLang("en", ["en-GB", "ko-KR"]);
    assert.equal(calls, 2);
  } finally {
    off();
    setLang("ko");
  }
});

test("dates, times and numbers in each language", () => {
  const at = new Date(2026, 9, 15, 16, 7, 5);
  const now = new Date(2026, 9, 18, 9, 0);
  assert.equal(clock(at), "16:07");
  assert.equal(clock("not a time"), "");
  assert.equal(clock(undefined), "");
  assert.equal(monthDay(at), "10월 15일");
  assert.equal(dayLabel(at, now), "10월 15일 (목)");
  assert.equal(dayLabel(at, new Date(2027, 0, 2)), "2026년 10월 15일 (목)");
  assert.equal(fullTime(at), "2026년 10월 15일 (목) 16:07:05");
  assert.equal(dateTime(at), "10월 15일 16:07");
  assert.equal(shortDateTime(at), "10/15 16:07");
  assert.equal(num(1234567), "1,234,567");
  english(() => {
    assert.equal(plain(clock(at)), "4:07 PM");
    assert.equal(monthDay(at), "Oct 15");
    assert.equal(dayLabel(at, now), "Thu, Oct 15");
    assert.equal(dayLabel(at, new Date(2027, 0, 2)), "Thu, Oct 15, 2026");
    assert.equal(plain(fullTime(at)), "Thu, Oct 15, 2026, 4:07:05 PM");
    assert.equal(plain(dateTime(at)), "Oct 15, 4:07 PM");
    assert.equal(plain(shortDateTime(at)), "10/15, 4:07 PM");
    assert.equal(num(1234567), "1,234,567");
  });
});

test("labels read in English once English is chosen", () => {
  const now = Date.now();
  english(() => {
    assert.equal(errorText("unknown session"), "Session not found");
    assert.equal(errorText("session is open in Terminal"), "It's open in Terminal, so it can't run remotely");
    assert.equal(errorText("rewind refused: turn_running"), "Can't rewind while Claude is working. Stop it first");
    assert.equal(errorText("rewind refused: brand_new"), "Can't rewind right now (brand_new)");
    assert.equal(errorText("Claude Code process exited with code 3. stderr: boom"), "Claude Code exited (code 3): boom");
    assert.equal(errorText("push_failed 0"), "Couldn't reach the push service");
    assert.equal(errorText("fork failed: unknown session"), "Couldn't fork: Session not found");
    assert.equal(errorText("something new"), "something new");
    assert.equal(noteText("unsent", "hi", 1), "Message Claude Code did not receive (1 attachment): hi");
    assert.equal(noteText("unsent", undefined, 3), "Message Claude Code did not receive (3 attachments)");
    assert.equal(noteText("fast", "free"), "Couldn't turn on Fast mode. Needs a paid plan or usage credits");
    assert.equal(fastReasonText("brand_new"), "Not available right now (brand_new)");
    assert.equal(hostLabel("Terminal"), "Terminal");
    assert.equal(hostLabel("ccrc"), "Remote");
    assert.equal(sessionTitle({ title: " " }), "(Untitled)");
    assert.equal(relTime(now - 30_000, now), "just now");
    assert.equal(relTime(now - 5 * 60_000, now), "5m ago");
    assert.equal(relTime(now - 3 * 3600_000, now), "3h ago");
    assert.equal(relTime(now - 2 * 86400_000, now), "2d ago");
    assert.equal(relTime(new Date(2026, 0, 2).getTime(), new Date(2026, 9, 18).getTime()), "Jan 2");
    assert.equal(duration(12_000), "12s");
    assert.equal(duration(184_000), "3m 4s");
    assert.equal(duration(3_720_000), "1h 2m");
    assert.equal(idleText(2 * 86400_000 + 5 * 3600_000), "2d 5h");
    assert.equal(plain(usageResetText(new Date(2026, 9, 18, 16, 0).toISOString(), new Date(2026, 9, 18, 9, 0))), "Resets today at 4:00 PM");
    assert.equal(plain(usageResetText(new Date(2026, 9, 20, 16, 0).toISOString(), new Date(2026, 9, 18, 9, 0))), "Resets Oct 20 at 4:00 PM");
    assert.equal(
      allowAlwaysLabel([
        { type: "setMode", mode: "acceptEdits", destination: "session" },
        { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }], destination: "localSettings" },
      ]),
      "Allow all edits for this session · Always allow for this project (just you): Bash(npm test)",
    );
  });
  assert.equal(relTime(now - 5 * 60_000, now), "5분 전");
  assert.equal(usageResetText(new Date(2026, 9, 20, 16, 0).toISOString(), new Date(2026, 9, 18, 9, 0)), "10월 20일 16:00 초기화");
});
