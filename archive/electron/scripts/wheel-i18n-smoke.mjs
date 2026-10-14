/**
 * The wheel's own string packs — the ones the radial window paints from.
 *
 * `scripts/i18n-smoke.mjs` covers the settings tables and cannot cover these: they are a separate
 * system, on purpose (see `src/i18n/wheel/types.ts`), and the property that matters most about them
 * is one `tsc` cannot express. The packs carry slots — `{shown}`, `{total}`, and the `%s` that the
 * direction hint swaps for a `<kbd>Esc</kbd>` element. A translation that drops one still compiles,
 * still passes every parity check, and renders a sentence with the key missing from it.
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
const langOut = mkdtempSync(join(tmpdir(), "rovyl-wheel-langs-"));

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
  const { LANGUAGES } = await bundle("src/i18n/languages.ts", langOut);
  const { DEFAULT_WHEEL_STRINGS, loadWheelStrings, formatWheelString } = wheel;

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

  console.log(`wheel-i18n-smoke: OK (${n} assertions, ${codes.length} packs x ${englishKeys.length} keys)`);
} finally {
  rmSync(wheelOut, { recursive: true, force: true });
  rmSync(langOut, { recursive: true, force: true });
}
