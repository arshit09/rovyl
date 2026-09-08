/**
 * Guards the JS the radial wheel has to parse before it can paint.
 *
 * That is not one file. `dist/index.html` loads the entry chunk plus everything it modulepreloads
 * — react-vendor, motion, the rolldown runtime — all statically imported, all parsed before the
 * first frame. Settings and the full Lucide set are the async chunks, and they are excluded.
 *
 * It has regressed silently before: a single `import * as icons from "lucide-react"` in
 * `src/iconMap.ts` put ~1,350 glyphs (4,059 exports, once Lucide's aliases are counted) in the
 * critical path and took the entry chunk alone to 672 kB. This fails the build if that, or
 * anything like it, comes back — including via `manualChunks`, which can move the same bytes into
 * a sibling chunk that is still statically imported.
 *
 * It also guards the shipped web fonts. Same shape of failure, opposite direction: importing a
 * whole `@fontsource-variable` package is one line and silently brings back subsets for scripts
 * this UI does not use, while a `url()` Vite cannot resolve is not an error at all — it warns,
 * leaves the specifier verbatim and exits 0, shipping a stylesheet that 404s. So the fonts are
 * checked from both ends: nothing extra, and nothing missing.
 *
 * Raise the budgets deliberately when a real feature needs the room — never to make a build pass.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(root, "dist");

/** Ceiling for all statically loaded JS, in bytes. It sits at ~385 kB; it was 806 kB before §3. */
const CRITICAL_JS_BUDGET = 440 * 1024;

/**
 * Lucide glyphs allowed in the critical path. `CURATED_ICON_MAP` holds 282; the margin is there so
 * adding a wheel glyph does not need this file edited, while pulling the whole set still fails.
 */
const MAX_CRITICAL_ICONS = 320;

/** Ceiling for all shipped font files, in bytes. Latin + latin-ext of three families is ~211 kB. */
const FONT_BUDGET = 240 * 1024;

/**
 * Subsets `src/fonts.css` deliberately leaves out. The UI is English and every font stack ends in a
 * generic that Windows resolves to a face covering all scripts, so these buy a nicer glyph for a
 * case that does not arise, at 92 kB.
 */
const UNSHIPPED_FONT_SUBSETS = ["cyrillic", "greek", "vietnamese"];

/**
 * Faces `src/fonts.css` and `src/fonts-display.css` declare, by pre-hash basename. Keep in step
 * with those files. A face that stops resolving — a Fontsource rename, or a build run without
 * devDependencies installed — makes the output *smaller*, so the ceiling above would wave it
 * through. Naming them is what turns that into a failed build.
 */
/**
 * Ceiling for a single static asset in `dist/`, in bytes.
 *
 * `folder.svg` was 596 kB: a 500x500 PNG of random noise, inlined as base64 for a 12%-opacity grain
 * overlay. Noise is exactly what a compressor cannot shrink, so nothing downstream could have saved
 * it — only noticing it could. The biggest asset now is `icon.png` at 59 kB.
 */
const MAX_STATIC_ASSET_BYTES = 120 * 1024;

const REQUIRED_FONT_FACES = [
  "inter-latin-wght-normal",
  "inter-latin-ext-wght-normal",
  "instrument-sans-latin-wght-normal",
  "instrument-sans-latin-ext-wght-normal",
  "space-grotesk-latin-wght-normal",
  "space-grotesk-latin-ext-wght-normal",
];

/**
 * `createLucideIcon("Activity", [["path", …]])`, after minification: an identifier, the glyph name
 * as a string literal, then the array-of-arrays of SVG children. Counting definitions rather than
 * grepping for names is what keeps this honest — a bare `includes("Disc")` would also match
 * `Disc3`, `"Discord"` and the Italian `"Disconnetti"` sitting in the same chunk.
 */
const LUCIDE_ICON_DEFINITION = /\(["'`]([A-Z][A-Za-z0-9]*)["'`]\s*,\s*\[\[/g;

/**
 * One string per locale of `src/translations.ts`, each chosen because it appears nowhere else in
 * `src/` — so a hit means that table is in the bundle, not that someone wrote a word in Portuguese.
 *
 * The table is ten languages of UI text for an app that overwrites `config.language` with `'en'` on
 * every hydration and has no language selector, and it cannot be tree-shaken because
 * `getTranslation` indexes it by a runtime key. Importing it anywhere brings all ten.
 */
const LOCALE_TEXT_THAT_MUST_NOT_SHIP = {
  Portuguese: "Núcleo",
  Spanish: "Buscar icono…",
  French: "Système",
  German: "Speichern und Schließen",
  Italian: "Gestisci la tua identità digitale.",
  Japanese: "アプリとスペース",
  Chinese: "选择应用...",
  Korean: "앱 및 공간",
  Russian: "Приложения и Пространства",
};

const problems = [];

let html;
try {
  html = readFileSync(join(distDir, "index.html"), "utf8");
} catch {
  console.error(`verify-renderer-budget: no build output at ${distDir} — run 'vite build' first`);
  process.exit(1);
}

/** Everything the build emitted. Some checks want only the critical path, some want all of it. */
const assetNames = readdirSync(join(distDir, "assets"));

/** Entry script plus every modulepreload: exactly the JS the browser fetches before first paint. */
const criticalScripts = [
  ...html.matchAll(/<script[^>]+type="module"[^>]+src="([^"]+)"/g),
  ...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g),
].map((match) => match[1].replace(/^\.?\//, ""));

const uniqueScripts = [...new Set(criticalScripts)];

if (!uniqueScripts.length) {
  console.error("verify-renderer-budget: found no module scripts in dist/index.html");
  process.exit(1);
}

let totalBytes = 0;
let totalIcons = 0;
const iconsByChunk = [];

for (const script of uniqueScripts) {
  const scriptPath = join(distDir, script);
  let source;
  try {
    source = readFileSync(scriptPath, "utf8");
  } catch {
    problems.push(`dist/index.html references ${script}, which is not in the build output`);
    continue;
  }
  totalBytes += statSync(scriptPath).size;

  LUCIDE_ICON_DEFINITION.lastIndex = 0;
  const icons = new Set();
  let match;
  while ((match = LUCIDE_ICON_DEFINITION.exec(source))) icons.add(match[1]);
  if (icons.size) iconsByChunk.push(`${script} (${icons.size})`);
  totalIcons += icons.size;
}

if (totalBytes > CRITICAL_JS_BUDGET) {
  problems.push(
    `critical JS is ${(totalBytes / 1024).toFixed(1)} kB across ${uniqueScripts.length} chunks, over the ${(CRITICAL_JS_BUDGET / 1024).toFixed(0)} kB budget`,
  );
}

/**
 * Every emitted chunk, not only the preloaded ones. The byte and icon budgets are rightly about
 * what the wheel waits on, but `PrecisionSettings` — the live settings panel, and the obvious place
 * a language selector would land — is a lazy chunk, so a critical-path-only probe would have been
 * blind to exactly the regression it is here to catch.
 */
const bundleSources = assetNames
  .filter((name) => name.endsWith(".js"))
  .map((name) => readFileSync(join(distDir, "assets", name), "utf8"));

const shippedLocales = Object.entries(LOCALE_TEXT_THAT_MUST_NOT_SHIP)
  .filter(([, probe]) => bundleSources.some((source) => source.includes(probe)))
  .map(([language]) => language);
if (shippedLocales.length) {
  problems.push(
    `translated UI text is back in the bundle (${shippedLocales.join(", ")}) — the live UI is English-only (src/strings.ts); importing src/translations.ts anywhere ships all ten locales`,
  );
}

if (totalIcons > MAX_CRITICAL_ICONS) {
  problems.push(
    `${totalIcons} Lucide glyphs are in the critical path (${iconsByChunk.join(", ")}), over the ${MAX_CRITICAL_ICONS} allowed — keep the barrel out of the static graph and add wheel glyphs to CURATED_ICON_MAP one at a time`,
  );
}

/**
 * The lazy set must still exist, and must still be lazy. Without both halves a build could pass
 * the checks above by dropping the icon picker's glyphs altogether, or by preloading them anyway.
 */
const lazyIconChunk = assetNames.find((name) => name.startsWith("_virtual_lucide-icon-set"));

if (!lazyIconChunk) {
  problems.push(
    "no _virtual_lucide-icon-set-*.js chunk was emitted — the icon picker's glyph set is no longer code-split",
  );
} else if (html.includes(lazyIconChunk)) {
  problems.push(
    `${lazyIconChunk} is referenced from dist/index.html — it is meant to be fetched on demand, not preloaded`,
  );
}

const fontFiles = assetNames.filter((name) => name.endsWith(".woff2"));
const fontBytes = fontFiles.reduce(
  (total, name) => total + statSync(join(distDir, "assets", name)).size,
  0,
);

if (fontBytes > FONT_BUDGET) {
  problems.push(
    `shipped fonts total ${(fontBytes / 1024).toFixed(1)} kB across ${fontFiles.length} files, over the ${(FONT_BUDGET / 1024).toFixed(0)} kB budget`,
  );
}

const unwantedSubsets = fontFiles.filter((name) =>
  UNSHIPPED_FONT_SUBSETS.some((subset) => name.includes(subset)),
);
if (unwantedSubsets.length) {
  problems.push(
    `font subsets this UI does not use are being shipped (${unwantedSubsets.join(", ")}) — declare faces in src/fonts.css rather than importing a whole @fontsource-variable package`,
  );
}

const missingFaces = REQUIRED_FONT_FACES.filter(
  (face) => !fontFiles.some((name) => new RegExp(`^${face}-[A-Za-z0-9_-]+\.woff2$`).test(name)),
);
if (missingFaces.length) {
  problems.push(
    `faces declared in src/fonts.css were not emitted (${missingFaces.join(", ")}) — a url() no longer resolves to a file in node_modules, most likely a Fontsource rename or a build without devDependencies`,
  );
}

/** The same failure seen from the other side: an unresolved specifier left verbatim in the output. */
for (const styleSheet of assetNames.filter((name) => name.endsWith(".css"))) {
  const css = readFileSync(join(distDir, "assets", styleSheet), "utf8");
  if (css.includes("@fontsource-variable") || css.includes("node_modules")) {
    problems.push(
      `${styleSheet} still points at node_modules — a url() in src/fonts.css or src/fonts-display.css did not resolve, and Vite only warned about it`,
    );
  }
}

/** Everything Vite copies from `public/` verbatim, where an oversized asset hides most easily. */
const staticAssets = readdirSync(distDir)
  .filter((name) => /\.(svg|png|jpg|jpeg|gif|webp|ico|json|txt)$/i.test(name))
  .map((name) => ({ name, size: statSync(join(distDir, name)).size }))
  .filter((entry) => entry.size > MAX_STATIC_ASSET_BYTES);
if (staticAssets.length) {
  problems.push(
    `static assets over the ${(MAX_STATIC_ASSET_BYTES / 1024).toFixed(0)} kB ceiling: ${staticAssets
      .map((a) => `${a.name} (${(a.size / 1024).toFixed(1)} kB)`)
      .join(", ")}`,
  );
}

if (problems.length) {
  console.error("verify-renderer-budget: FAILED");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `verify-renderer-budget: OK (${(totalBytes / 1024).toFixed(1)} kB critical JS in ${uniqueScripts.length} chunks, ${totalIcons} Lucide glyphs, ${(fontBytes / 1024).toFixed(1)} kB fonts in ${fontFiles.length} files, English-only)`,
);
