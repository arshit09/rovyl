/**
 * The two string packs that are not the settings tables: the wheel's, and the fault card's.
 *
 * `scripts/i18n-smoke.mjs` covers the tables and cannot cover these — they are separate systems on
 * purpose (`src/i18n/wheel/types.ts`, `src/i18n/faults/types.ts`), each with an English default
 * that ships statically and seven siblings fetched on demand.
 *
 * The property that matters most about both is one `tsc` cannot express. The strings carry slots:
 * `{shown}` and `{total}` in the wheel's counter, `{subject}` and `{scheme}` in the fault
 * sentences, and the `%s` the direction hint swaps for a `<kbd>Esc</kbd>` element. A translation
 * that drops one still compiles, still passes every parity check, and renders a sentence with the
 * key name, the count or the app's name simply missing from it.
 *
 * Where the packs LIVE — English in the critical path, every other language in a chunk of its own —
 * is not checked here. That is `scripts/verify-renderer-budget.mjs`, which can see the build output.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wheelOut = mkdtempSync(join(tmpdir(), "rovyl-wheel-i18n-"));
const faultsOut = mkdtempSync(join(tmpdir(), "rovyl-faults-i18n-"));
const langOut = mkdtempSync(join(tmpdir(), "rovyl-pack-langs-"));

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
  const wheel = await bundle("src/i18n/wheel/index.ts", wheelOut);
  const faults = await bundle("src/i18n/faults/index.ts", faultsOut);
  const { LANGUAGES } = await bundle("src/i18n/languages.ts", langOut);
  const { DEFAULT_WHEEL_STRINGS, loadWheelStrings, formatWheelString } = wheel;
  const { DEFAULT_FAULT_STRINGS, loadFaultStrings } = faults;

  let n = 0;
  const check = (fn) => { fn(); n += 1; };

  const codes = LANGUAGES.map((entry) => entry.value);
  const englishKeys = Object.keys(DEFAULT_WHEEL_STRINGS);

  check(() => assert.ok(englishKeys.length >= 10, `the English pack looks truncated: ${englishKeys.length} keys`));

  check(() => {
    /** Every call is a promise, English included — one shape for the caller to hold. */
    assert.equal(loadWheelStrings("en") instanceof Promise, true, "loadWheelStrings always returns a promise");
  });

  const packs = Object.fromEntries(
    await Promise.all(codes.map(async (code) => [code, await loadWheelStrings(code)])),
  );

  check(() => {
    assert.equal(packs.en, DEFAULT_WHEEL_STRINGS, "English must resolve to the static default itself");
  });

  for (const code of codes) {
    check(() => {
      assert.deepEqual(
        Object.keys(packs[code]).sort(),
        [...englishKeys].sort(),
        `the ${code} pack is not at key parity with English`,
      );
    });

    check(() => {
      const empty = englishKeys.filter((key) => !String(packs[code][key]).trim());
      assert.deepEqual(empty, [], `${code} has empty strings: ${empty.join(", ")}`);
    });

    check(() => {
      const leaked = englishKeys.filter((key) => packs[code][key] === key);
      assert.deepEqual(leaked, [], `${code} renders raw keys as text: ${leaked.join(", ")}`);
    });
  }

  /**
   * The check this file exists for. A pack that loses `%s` drops the key name out of the sentence
   * telling the user which key closes the wheel, and a pack that loses `{total}` prints a count
   * with nothing to count against — both of which read as a bug, and neither of which is visible to
   * a type, to key parity, or to a reviewer who does not read that language.
   */
  const markersOf = (value) => [
    ...String(value).match(/\{\w+\}|%s/g) ?? [],
  ].sort();

  for (const code of codes.filter((value) => value !== "en")) {
    check(() => {
      for (const key of englishKeys) {
        const expected = markersOf(DEFAULT_WHEEL_STRINGS[key]);
        if (!expected.length) continue;
        assert.deepEqual(
          markersOf(packs[code][key]),
          expected,
          `${code}.${key} does not carry the same slots as English (${expected.join(" ")})`,
        );
      }
    });

    check(() => {
      const shared = englishKeys.filter((key) => packs[code][key] === DEFAULT_WHEEL_STRINGS[key]);
      assert.ok(
        shared.length / englishKeys.length < 0.2,
        `${code} matches English on ${shared.length}/${englishKeys.length} keys — looks like an untranslated copy`,
      );
    });
  }

  /**
   * Resolved BEFORE the assertion rather than inside it: `check` calls its function and moves on,
   * so an `async` body would have its failures land in an unhandled rejection after this file had
   * already printed OK.
   */
  const fallbacks = ["fr", "it", "ko", "", "EN", "en-GB", undefined, null, 7, {}];
  const fallbackPacks = await Promise.all(fallbacks.map((value) => loadWheelStrings(value)));
  check(() => {
    /** A stored language no table covers, and plain junk: both land on something renderable. */
    fallbacks.forEach((value, index) => {
      assert.equal(
        fallbackPacks[index],
        DEFAULT_WHEEL_STRINGS,
        `${JSON.stringify(value)} should fall back to English`,
      );
    });
  });

  check(() => {
    assert.equal(formatWheelString("{shown} of {total}", { shown: 3, total: 9 }), "3 of 9");
    /** Japanese reverses them — the template is what makes that possible. */
    assert.equal(formatWheelString("{total} 件中 {shown} 件", { shown: 3, total: 9 }), "9 件中 3 件");
    /** An unknown slot stays visible: it gets reported, an empty gap does not. */
    assert.equal(formatWheelString("{shown} of {total}", { shown: 3 }), "3 of {total}");
  });

  /* ── the fault card's pack, held to exactly the same rules ─────────────── */

  const faultPacks = Object.fromEntries(
    await Promise.all(codes.map(async (code) => [code, await loadFaultStrings(code)])),
  );
  const faultKeys = Object.keys(DEFAULT_FAULT_STRINGS);

  check(() => {
    assert.ok(faultKeys.length > 30, `the English fault pack looks truncated: ${faultKeys.length} keys`);
    assert.equal(faultPacks.en, DEFAULT_FAULT_STRINGS, "English must resolve to the static default itself");
  });

  for (const code of codes) {
    check(() => {
      assert.deepEqual(
        Object.keys(faultPacks[code]).sort(),
        [...faultKeys].sort(),
        `the ${code} fault pack is not at key parity with English`,
      );
      const empty = faultKeys.filter((key) => !String(faultPacks[code][key]).trim());
      assert.deepEqual(empty, [], `${code} fault pack has empty strings: ${empty.join(", ")}`);
      const leaked = faultKeys.filter((key) => faultPacks[code][key] === key);
      assert.deepEqual(leaked, [], `${code} fault pack renders raw keys as text: ${leaked.join(", ")}`);
    });
  }

  for (const code of codes.filter((value) => value !== "en")) {
    check(() => {
      for (const key of faultKeys) {
        const expected = markersOf(DEFAULT_FAULT_STRINGS[key]);
        if (!expected.length) continue;
        assert.deepEqual(
          markersOf(faultPacks[code][key]),
          expected,
          `${code}.${key} does not carry the same slots as English (${expected.join(" ")})`,
        );
      }
      const shared = faultKeys.filter((key) => faultPacks[code][key] === DEFAULT_FAULT_STRINGS[key]);
      assert.ok(
        shared.length / faultKeys.length < 0.2,
        `${code} fault pack matches English on ${shared.length}/${faultKeys.length} keys — looks like an untranslated copy`,
      );
    });
  }

  console.log(
    `i18n-packs-smoke: OK (${n} assertions, ${codes.length} languages x ${englishKeys.length} wheel + ${faultKeys.length} fault keys)`,
  );
} finally {
  rmSync(wheelOut, { recursive: true, force: true });
  rmSync(faultsOut, { recursive: true, force: true });
  rmSync(langOut, { recursive: true, force: true });
}
