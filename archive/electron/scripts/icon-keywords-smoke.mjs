/**
 * The icon picker's semantic search, in both languages it now speaks.
 *
 * The index is English by construction — its keys are words like `work` and `time` — and a Japanese
 * query used to return nothing from it at all. Not because the icons were missing: 仕事 is simply
 * not a prefix of `work`, and one-character tokens were rejected outright, which is most of what a
 * Japanese user types first.
 *
 * So the query is translated and the index is left alone. What that buys has to be checked from
 * both ends: the Japanese token has to reach the same icons its English counterpart does, and the
 * English path has to behave exactly as it did before — including the single-letter rule, which is
 * still right for Latin and was never right for kanji.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const englishOut = mkdtempSync(join(tmpdir(), "rovyl-icon-keywords-en-"));
const japaneseOut = mkdtempSync(join(tmpdir(), "rovyl-icon-keywords-ja-"));

const bundle = async (entry, outDir) => {
  await build({
    root,
    logLevel: "warn",
    build: {
      ssr: join(root, entry),
      outDir,
      emptyOutDir: true,
      target: "node20",
      minify: false,
      rollupOptions: { output: { format: "es", entryFileNames: "entry.mjs" } },
    },
    ssr: { noExternal: true },
  });
  return import(pathToFileURL(join(outDir, "entry.mjs")).href);
};

try {
  const {
    ENGLISH_KEYWORD_TO_ICONS,
    buildResolvedEnglishKeywordMap,
    collectIconsForEnglishTokens,
    keywordMatchesSearchTerm,
  } = await bundle("src/utils/iconPickerEnglishKeywords.ts", englishOut);

  const { englishTokensForJapanese, isJapaneseToken } = await bundle(
    "src/utils/iconPickerJapaneseKeywords.ts",
    japaneseOut,
  );

  let n = 0;
  const check = (fn) => { fn(); n += 1; };

  /** Every name the index mentions counts as valid here: this is about the words, not the glyphs. */
  const validNames = new Set(Object.values(ENGLISH_KEYWORD_TO_ICONS).flat());
  const index = buildResolvedEnglishKeywordMap(validNames);
  const iconsFor = (token) => collectIconsForEnglishTokens([token], index);

  check(() => {
    assert.ok(index.size > 50, `the keyword index looks truncated: ${index.size} entries`);
  });

  /* ── the English path is untouched ─────────────────────────────────────── */

  check(() => {
    assert.ok(iconsFor("work").size > 0, "'work' must still reach the office glyphs");
    assert.ok(iconsFor("time").size > 0, "'time' must still reach the clock glyphs");
  });

  check(() => {
    /** One Latin letter matches half the index; rejecting it is the rule that keeps search useful. */
    assert.equal(keywordMatchesSearchTerm("work", "w"), false, "a single Latin letter must not expand");
    assert.equal(keywordMatchesSearchTerm("work", "wo"), true, "two letters prefix-match");
  });

  /* ── and Japanese now arrives at the same place ────────────────────────── */

  check(() => {
    assert.equal(isJapaneseToken("仕事"), true);
    assert.equal(isJapaneseToken("カメラ"), true);
    assert.equal(isJapaneseToken("work"), false, "Latin must not take the Japanese path");
  });

  check(() => {
    assert.deepEqual(englishTokensForJapanese("仕事"), ["work"]);
    assert.ok(englishTokensForJapanese("時").includes("time"), "one kanji is a whole word");
    /** No spaces in Japanese: a compound arrives as one token and still has to resolve. */
    assert.ok(englishTokensForJapanese("音楽アプリ").includes("music"), "a compound must still match");
    assert.deepEqual(englishTokensForJapanese("work"), [], "an English token is not expanded here");
  });

  check(() => {
    /** The point of the whole change: the same icons, reached in either language. */
    assert.deepEqual([...iconsFor("仕事")].sort(), [...iconsFor("work")].sort());
    assert.deepEqual([...iconsFor("設定")].sort(), [...iconsFor("settings")].sort());
  });

  check(() => {
    /** The case that returned nothing before: a single kanji. */
    for (const token of ["時", "家", "音", "星", "本"]) {
      assert.ok(iconsFor(token).size > 0, `${token} should surface icons by meaning`);
    }
  });

  check(() => {
    /** A word nobody mapped degrades to no expansion — never to a throw, never to everything. */
    assert.equal(englishTokensForJapanese("猫").length, 0);
    assert.equal(iconsFor("猫").size, 0);
  });

  console.log(`icon-keywords-smoke: OK (${n} assertions, ${index.size} English keywords)`);
} finally {
  rmSync(englishOut, { recursive: true, force: true });
  rmSync(japaneseOut, { recursive: true, force: true });
}
