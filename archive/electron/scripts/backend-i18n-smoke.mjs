/**
 * The main process's string table — the tray, the native dialogs, the error boxes.
 *
 * It is a second table, separate from the renderer's, because there is no honest way to share one:
 * `src/i18n/` is TypeScript behind a Vite build and `backend/` is CommonJS that Electron loads off
 * disk. The duplication is the accepted cost; this file is what stops it rotting, since nothing
 * else looks at these strings until someone right-clicks a tray icon in a language nobody on the
 * project reads.
 *
 * No build step here on purpose: the module is plain CJS, so the test loads exactly what ships.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const i18n = require(join(root, "backend", "i18n.cjs"));

const { LANGS, TABLES, setLanguage, getLanguage, t } = i18n;

let n = 0;
const check = (fn) => { fn(); n += 1; };

const englishKeys = Object.keys(TABLES.en);

check(() => {
  assert.ok(englishKeys.length > 25, `the English table looks truncated: ${englishKeys.length} keys`);
  assert.deepEqual([...LANGS].sort(), ["ar", "de", "en", "es", "ja", "pt", "ru", "zh"]);
  assert.equal(LANGS[0], "en", "English leads, as it does in the renderer's registry");
});

for (const code of LANGS) {
  check(() => {
    assert.deepEqual(
      Object.keys(TABLES[code]).sort(),
      [...englishKeys].sort(),
      `${code} is not at key parity with English`,
    );
    const empty = englishKeys.filter((key) => !String(TABLES[code][key]).trim());
    assert.deepEqual(empty, [], `${code} has empty strings: ${empty.join(", ")}`);
    const leaked = englishKeys.filter((key) => TABLES[code][key] === key);
    assert.deepEqual(leaked, [], `${code} renders raw keys as text: ${leaked.join(", ")}`);
  });
}

/**
 * The slots are the half a reviewer cannot check by eye. `Paused — {minutes} min left` has to keep
 * its number in every language, and a tray label that lost `{version}` would announce an update to
 * nothing at all.
 */
const markersOf = (value) => [...(String(value).match(/\{\w+\}/g) ?? [])].sort();

for (const code of LANGS.filter((value) => value !== "en")) {
  check(() => {
    for (const key of englishKeys) {
      const expected = markersOf(TABLES.en[key]);
      if (!expected.length) continue;
      assert.deepEqual(
        markersOf(TABLES[code][key]),
        expected,
        `${code}.${key} does not carry the same slots as English (${expected.join(" ")})`,
      );
    }
    const shared = englishKeys.filter((key) => TABLES[code][key] === TABLES.en[key]);
    assert.ok(
      shared.length / englishKeys.length < 0.2,
      `${code} matches English on ${shared.length}/${englishKeys.length} keys — looks like an untranslated copy`,
    );
  });
}

check(() => {
  setLanguage("ja");
  assert.equal(getLanguage(), "ja");
  assert.equal(t("trayQuit"), TABLES.ja.trayQuit);
  /** Japanese has no plural agreement, so the same template serves one minute and twelve. */
  assert.ok(t("trayPausedLeft", { minutes: 12 }).includes("12"));
  assert.ok(t("trayPausedLeft", { minutes: 1 }).includes("1"));
});

check(() => {
  /** A stored language no table covers, and plain junk: both land on English rather than blank. */
  for (const junk of ["fr", "it", "ko", "", "EN", "en-GB", undefined, null, 7, {}]) {
    assert.equal(setLanguage(junk), "en", `${JSON.stringify(junk)} should fall back to English`);
    assert.equal(t("trayQuit"), "Quit");
  }
});

check(() => {
  setLanguage("en");
  /** An unknown key is a programming error; it must not throw over a tray menu. */
  assert.equal(t("nope.not.a.key"), "nope.not.a.key");
  /** An unknown slot stays visible — a bug someone reports beats a gap nobody sees. */
  assert.equal(t("trayPauseFor", {}), "For {minutes} minutes");
});

check(() => {
  /**
   * These two are compared whole by `src/launchFailure.ts` to classify a failure, so they are NOT
   * in this table and must never be: translating them makes the fault card fall through to its
   * generic answer in every language but English.
   */
  const values = LANGS.flatMap((code) => Object.values(TABLES[code]));
  assert.ok(!values.includes("Empty or invalid command"));
  assert.ok(!values.includes("Failed to start key simulator"));
});

console.log(`backend-i18n-smoke: OK (${n} assertions, ${LANGS.length} languages x ${englishKeys.length} keys)`);
