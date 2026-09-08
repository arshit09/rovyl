/**
 * Runtime contract of `src/iconMap.ts`, checked against a real Vite build.
 *
 * The wheel's glyphs are split into a curated set that ships in the critical chunk and a lazy set
 * fetched on demand, and three things about that split are easy to break without any type or build
 * error showing it:
 *
 *  - a name that collides with an `Object.prototype` member must fall back, not become the icon
 *    component — the curated map is an object literal, so `getIcon("constructor")` would otherwise
 *    hand React the `Object` function and take the whole overlay down;
 *  - Lucide's alias spellings (`GlobeIcon`, `LucideGlobe`, `Grid3X3`) must resolve out of the
 *    curated map, because every release before the split let users pick and save them, and missing
 *    them means fetching the whole set on every launch for a glyph that is already loaded;
 *  - a config that names only curated glyphs must never fetch the lazy chunk at all.
 *
 * `scripts/verify-renderer-budget.mjs` guards the bundling half of the same change.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "rovyl-icon-map-smoke-"));

try {
  await build({
    root,
    logLevel: "warn",
    build: {
      ssr: join(root, "scripts", "icon-map-smoke.entry.tsx"),
      outDir,
      emptyOutDir: true,
      target: "node20",
      minify: false,
      rollupOptions: { output: { format: "es", entryFileNames: "entry.mjs" } },
    },
    // Bundle React and Lucide in, so the built module runs under plain node with no resolution.
    ssr: { noExternal: true },
  });

  const { collect } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);
  const actual = await collect();

  const expected = {
    mapHasNullPrototype: true,

    constructorFallsBackToBox: true,
    protoFallsBackToBox: true,
    toStringFallsBackToBox: true,
    hasOwnPropertyFallsBackToBox: true,
    unknownNameFallsBackToBox: true,
    emptyNameFallsBackToBox: true,

    iconSuffixAlias: true,
    lucidePrefixAlias: true,
    humanAliasGrid: true,
    humanAliasSidebar: true,
    humanAliasStars: true,
    curatedIconOnGarbage: true,
    curatedIconOnBareIconSuffix: true,
    curatedIconOnBareLucidePrefix: true,

    fullSetNotLoadedYet: true,
    aliasOnlyConfigSkipsChunk: true,
    uncuratedNameLoadsChunk: true,
    pickableHasNoAffixedAliases: true,
    uncuratedResolvesAfterLoad: true,
    aliasStillPrefersCuratedAfterLoad: true,
  };

  const failures = Object.entries(expected)
    .filter(([key, want]) => actual[key] !== want)
    .map(([key, want]) => `  - ${key}: expected ${want}, got ${actual[key]}`);

  if (failures.length) {
    console.error("icon-map-smoke: FAILED");
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }

  // Sanity on the two counts, so a collapse in either direction is visible rather than silent.
  assert.ok(
    actual.curatedCount >= 200 && actual.curatedCount <= 400,
    `curated map holds ${actual.curatedCount} glyphs — expected roughly 200-400`,
  );
  assert.ok(
    actual.pickableCount > 1000,
    `icon picker would list ${actual.pickableCount} glyphs — expected the full set`,
  );

  console.log(
    `icon-map-smoke: OK (${actual.curatedCount} curated glyphs, ${actual.pickableCount} pickable, ${Object.keys(expected).length} assertions)`,
  );
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
