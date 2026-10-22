import assert from "node:assert/strict";
import { test } from "node:test";
import { en } from "../../web/src/i18n/en/index.ts";
import { g1 } from "../../web/src/i18n/en/g1.ts";
import { g2 } from "../../web/src/i18n/en/g2.ts";
import { g3 } from "../../web/src/i18n/en/g3.ts";
import { g4 } from "../../web/src/i18n/en/g4.ts";
import { g5 } from "../../web/src/i18n/en/g5.ts";
import { byFile, missing, placeholders, scanFiles } from "./i18n-scan.ts";

// Every screen is in English too: LIMIT holds both at 0, so new Korean goes through t() with its English (a limit left
// out is counted and reported only). node broker/test/i18n-scan.ts lists each one.
const BASELINE = { outside: 0, missing: 0 };
const LIMIT: { outside?: number; missing?: number } = { outside: 0, missing: 0 };

const scan = scanFiles();

test("Korean left outside t() and sentences without English are counted", (t) => {
  const lack = missing(scan);
  t.diagnostic(`Korean outside t()/k(): ${scan.outside.length} (baseline ${BASELINE.outside})`);
  t.diagnostic(`sentences without English: ${lack.length} (baseline ${BASELINE.missing})`);
  for (const [file, n] of byFile(scan.outside)) t.diagnostic(`  ${file}: ${n}`);
  if (LIMIT.outside !== undefined) assert.ok(scan.outside.length <= LIMIT.outside, `Korean outside t(): ${scan.outside.length} > ${LIMIT.outside}`);
  if (LIMIT.missing !== undefined) assert.deepEqual(lack, [], "sentences without English");
});

test("t() runs where its text is shown, never at module level", () => {
  assert.deepEqual(scan.moduleLevel, []);
});

test("an English sentence keeps the Korean's placeholders and no Korean, and sits in one group's file", () => {
  const where = new Map<string, string>();
  for (const [group, dict] of Object.entries({ g1, g2, g3, g4, g5 })) {
    for (const [ko, text] of Object.entries(dict)) {
      assert.ok(text.trim(), `${group}: no English for ${ko}`);
      assert.doesNotMatch(text, /[ㄱ-ㆎ가-힣]/, `${group}: Korean in the English of ${ko}`);
      assert.deepEqual(placeholders(text), placeholders(ko), `${group}: placeholders of ${ko}`);
      assert.equal(where.get(ko), undefined, `${ko} is in ${where.get(ko)} and ${group}`);
      where.set(ko, group);
    }
  }
  assert.equal(Object.keys(en).length, where.size);
});

test("the dictionary holds only sentences the screens hand to t()", () => {
  assert.deepEqual(
    Object.keys(en).filter((ko) => !scan.keys.has(ko)),
    [],
  );
});

test("the scan finds Korean in strings, templates and JSX, and keys in t(), k(), tNode() and tc()", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "i18n-scan-"));
  const file = path.join(dir, "Sample.tsx");
  fs.writeFileSync(
    file,
    [
      'import { k, t } from "./i18n/index.ts";',
      'const LABEL = k("표의 문장");',
      'const early = t("모듈에서 부른 문장");',
      "// 주석의 한글은 세지 않는다",
      'export function A({ n }: { n: number }) {',
      '  const s = `${n}개 남음`;',
      '  return <div title="제목">본문 {t("열쇠 {n}", { n })} {tNode("요소 {x}", { x: <b /> })} {tc("자리", "같은 문장")}</div>;',
      "}",
    ].join("\n"),
  );
  try {
    const s = scanFiles([file]);
    assert.deepEqual([...s.keys.keys()].sort(), ["모듈에서 부른 문장", "열쇠 {n}", "요소 {x}", "자리|같은 문장", "표의 문장"].sort());
    assert.deepEqual(
      s.outside.map((f) => f.text),
      ["`${n}개 남음`", "제목", "본문"],
    );
    assert.deepEqual(
      s.moduleLevel.map((f) => f.line),
      [3],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
