/**
 * The translation tables and the language registry that indexes them.
 *
 * `tsc` already proves the two agree in shape — `translations.ts` ends in a
 * `Record<SupportedLanguage, Record<TranslationKey, string>>` annotation, so a language declared in
 * `languages.ts` without a table, or a table missing a key, does not compile. What a type cannot
 * see is whether the strings are real. The ten-locale table this replaced (TODO §6.3) sat at
 * 429/281/257 keys across its locales and type-checked perfectly, because every gap was filled by a
 * `||` fallback at runtime that quietly rendered English — or, worse, the raw key.
 *
 * So this checks the parts that are about content: that a table is translated rather than cloned
 * from English, that the picker's metadata matches the tables it offers, and that a stored language
 * from an older config lands somewhere renderable instead of blanking the panel.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "rovyl-i18n-"));

try {
  await build({
    root,
    logLevel: "warn",
    build: {
      ssr: join(root, "src", "i18n", "translations.ts"),
      outDir,
      emptyOutDir: true,
      target: "node20",
      minify: false,
      rollupOptions: { output: { format: "es", entryFileNames: "entry.mjs" } },
    },
    ssr: { noExternal: true },
  });

  const { LANGUAGES, translations, t, normalizeLanguage, isSupportedLanguage, directionOf } =
    await import(pathToFileURL(join(outDir, "entry.mjs")).href);

  let n = 0;
  const check = (fn) => { fn(); n += 1; };

  const codes = LANGUAGES.map((entry) => entry.value);
  const englishKeys = Object.keys(translations.en);

  check(() => assert.ok(englishKeys.length > 100, `English table looks truncated: ${englishKeys.length} keys`));

  check(() => {
    assert.deepEqual(
      [...codes].sort(),
      Object.keys(translations).sort(),
      "LANGUAGES and the translation tables name different languages",
    );
  });

  check(() => {
    assert.equal(new Set(codes).size, codes.length, "a language code is listed twice in LANGUAGES");
  });

  check(() => {
    /** English first: it is the fallback, and a picker that buries it strands anyone who mis-picks. */
    assert.equal(codes[0], "en", "English should lead the picker");
  });

  for (const { value, label, english, dir } of LANGUAGES) {
    check(() => {
      assert.ok(label.trim(), `${value} has no endonym to show in the picker`);
      assert.ok(english.trim(), `${value} has no English name for the accessible label`);
      assert.ok(dir === "ltr" || dir === "rtl", `${value} has a nonsense direction: ${dir}`);
    });
  }

  for (const code of codes) {
    check(() => {
      assert.deepEqual(
        Object.keys(translations[code]).sort(),
        [...englishKeys].sort(),
        `${code} is not at key parity with English`,
      );
    });

    check(() => {
      const empty = englishKeys.filter((key) => !String(translations[code][key]).trim());
      assert.deepEqual(empty, [], `${code} has empty strings: ${empty.join(", ")}`);
    });

    check(() => {
      /**
       * A key leaking through as its own value — `bgDimmingDesc` rendered as UI text — is the
       * failure the old table actually shipped, and it reads as a bug to the user, not a gap.
       */
      const leaked = englishKeys.filter((key) => translations[code][key] === key);
      assert.deepEqual(leaked, [], `${code} renders raw keys as text: ${leaked.join(", ")}`);
    });
  }

  for (const code of codes.filter((value) => value !== "en")) {
    check(() => {
      /**
       * Not "every string differs" — `URL`, `Normal` and `Name` are genuinely the same word in
       * several of these. But a table that matches English nearly everywhere is a copy someone
       * meant to come back to, and it would otherwise ship looking finished.
       */
      const shared = englishKeys.filter((key) => translations[code][key] === translations.en[key]);
      const ratio = shared.length / englishKeys.length;
      assert.ok(
        ratio < 0.2,
        `${code} matches English on ${shared.length}/${englishKeys.length} keys — looks like an untranslated copy`,
      );
    });
  }

  check(() => {
    assert.equal(directionOf("ar"), "rtl", "Arabic has to lay out right-to-left");
    for (const code of codes.filter((value) => value !== "ar")) {
      assert.equal(directionOf(code), "ltr", `${code} should be left-to-right`);
    }
  });

  check(() => {
    /**
     * `UIConfig['language']` still types `fr`/`it`/`ko`, which older builds could write and no
     * table covers. They have to degrade to English — a config carrying one must not blank the
     * settings panel or hand `t()` an index that is not there.
     */
    for (const stale of ["fr", "it", "ko"]) {
      assert.equal(isSupportedLanguage(stale), false, `${stale} should not claim to be supported`);
      assert.equal(normalizeLanguage(stale), "en", `${stale} should fall back to English`);
      assert.equal(t("settings", stale), translations.en.settings, `t() should fall back for ${stale}`);
    }
  });

  check(() => {
    for (const junk of [undefined, null, "", "EN", "en-GB", 7, {}, []]) {
      assert.equal(normalizeLanguage(junk), "en", `${JSON.stringify(junk)} should fall back to English`);
    }
  });

  check(() => {
    for (const code of codes) {
      assert.equal(t("settings", code), translations[code].settings, `t() misses the table for ${code}`);
    }
  });

  check(() => {
    /** An unknown key is a programming error, but it must not throw in front of the user. */
    assert.equal(t("nope.not.a.key", "de"), "nope.not.a.key");
  });

  console.log(`i18n-smoke: OK (${n} assertions, ${codes.length} languages x ${englishKeys.length} keys)`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
