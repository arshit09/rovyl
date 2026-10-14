/**
 * Guards the JS the radial wheel has to parse before it can paint.
 *
 * That is `dist/radial.html` — the wheel's own document since it moved into its own window. It
 * loads the entry chunk plus everything it modulepreloads (react-vendor, the rolldown runtime, the
 * shared component chunk), all statically imported, all parsed before the first frame.
 *
 * Which file this reads is the load-bearing part. When one document served both surfaces, keeping
 * the settings shell out of the wheel's critical path was a discipline enforced by `React.lazy` and
 * by this script, and a single careless value import could undo it. Now they are separate rollup
 * entries, so the settings shell, the icon picker and the locale tables are not merely deferred —
 * they are unreachable from this graph. Pointing this check back at `index.html` would silently
 * start measuring Settings instead, and the number would look fine while saying nothing.
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
 * Lastly it guards where the locale tables live — not whether they exist. They are allowed to ship
 * now that there is a picker; they are not allowed in front of first paint.
 *
 * Raise the budgets deliberately when a real feature needs the room — never to make a build pass.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(root, "dist");

/**
 * Ceiling for all statically loaded JS, in bytes.
 *
 * It sits at ~284 kB; it was 288 kB when one document served both windows, and 806 kB before §3.
 * The split is worth less here than it looks, and that is the honest reading: the wheel's critical
 * path had already been cut to what it genuinely needs, so what separating the entries bought was
 * not bytes but the guarantee that nobody can add them back by accident.
 *
 * The corner docks are what took it from ~267 kB: they are drawn beside the wheel, so `ScreenDocks`
 * and the seven glyphs its readouts use are genuinely eager. The list that EDITS a dock is not —
 * `DockShortcuts.tsx` is reachable only from the settings entry, which is why it is a module of its
 * own rather than part of the component that draws them.
 */
const CRITICAL_JS_BUDGET = 300 * 1024;

/**
 * Lucide glyphs allowed in the critical path. `CURATED_ICON_MAP` holds 282; the margin is there so
 * adding a wheel glyph does not need this file edited, while pulling the whole set still fails.
 */
const MAX_CRITICAL_ICONS = 320;

/** Ceiling for all shipped font files, in bytes. Latin + latin-ext of three families is ~211 kB. */
const FONT_BUDGET = 240 * 1024;

/**
 * Subsets `src/fonts.css` deliberately leaves out — still left out now that the UI translates.
 *
 * Cyrillic is the one this costs something: Russian settings text falls back down the stack to
 * Segoe UI, which is the system face Windows uses for its own Russian UI, so it reads correctly
 * and natively — it simply is not Inter. Same for Arabic and Chinese, which Fontsource does not
 * subset for these families at all. 92 kB of webfont, downloaded by every user in every language,
 * to restyle text most of them will never display, is the wrong trade; if it ever becomes the
 * right one, the fix is a per-script subset loaded when that language is picked, not this list.
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
 * One string per shipped locale of `src/i18n/translations.ts`, each chosen because it appears
 * nowhere else in `src/` — so a hit means that table is in the chunk, not that someone happened to
 * write a word in Portuguese.
 *
 * The check inverted when the language selector landed, and the inversion is the point. The old
 * rule was "no translated text anywhere", because ten locales sat in the chunk the wheel waits on
 * for a UI that overwrote `config.language` with `'en'` on every hydration — 167 kB nobody could
 * ever see. The rule now is about WHERE: the tables are a real, reachable feature, so they may
 * ship, but only from the lazy settings chunk. `src/i18n/languages.ts` holds the codes so that
 * `App.tsx` can validate a stored language without importing a single translated string, and this
 * is what keeps that separation from quietly eroding — a `useTranslation` import added to
 * `App.tsx` or `RadialMenu` would put every locale back in front of first paint.
 */
const LOCALES_THAT_MUST_STAY_LAZY = {
  Spanish: "Buscar ajustes",
  Chinese: "搜索设置",
  Japanese: "設定を検索",
  Portuguese: "Buscar configurações",
  Russian: "Поиск по настройкам",
  German: "Einstellungen durchsuchen",
  Arabic: "البحث في الإعدادات",
};

const problems = [];

/** The wheel's document — what the gesture waits on. */
let html;
try {
  html = readFileSync(join(distDir, "radial.html"), "utf8");
} catch {
  console.error(
    `verify-renderer-budget: no build output at ${distDir}/radial.html — run 'vite build' first`,
  );
  process.exit(1);
}

/** Settings' document, checked only for the things that must not ship at all. */
let settingsHtml;
try {
  settingsHtml = readFileSync(join(distDir, "index.html"), "utf8");
} catch {
  console.error(`verify-renderer-budget: no build output at ${distDir}/index.html`);
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
  console.error("verify-renderer-budget: found no module scripts in dist/radial.html");
  process.exit(1);
}

/**
 * The two documents have to stay two.
 *
 * Rollup emits one entry chunk per input, and if the wheel's document ever preloads the settings
 * entry it means something in `RadialApp`'s graph reached `App.tsx` — the whole panel, in front of
 * a gesture. The check is cheap and the failure it catches is invisible in every other way.
 */
const settingsEntry = [...settingsHtml.matchAll(/<script[^>]+type="module"[^>]+src="([^"]+)"/g)]
  .map((match) => match[1].replace(/^\.?\//, ""))
  .find((name) => name.includes("/index-"));
if (settingsEntry && uniqueScripts.includes(settingsEntry)) {
  problems.push(
    `dist/radial.html loads the settings entry (${settingsEntry}) — the wheel's graph now reaches App.tsx`,
  );
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
 * Every emitted chunk, not only the preloaded ones — this is what answers "did this table ship at
 * all", as opposed to "did it ship too early", which reads the critical scripts alone below.
 */
const bundleSources = assetNames
  .filter((name) => name.endsWith(".js"))
  .map((name) => readFileSync(join(distDir, "assets", name), "utf8"));

/** Same read, restricted to the critical path: where a locale table must never appear. */
const criticalSources = uniqueScripts.map((script) => {
  try {
    return readFileSync(join(distDir, script), "utf8");
  } catch {
    return "";
  }
});

const localesInCriticalPath = Object.entries(LOCALES_THAT_MUST_STAY_LAZY)
  .filter(([, probe]) => criticalSources.some((source) => source.includes(probe)))
  .map(([language]) => language);
if (localesInCriticalPath.length) {
  problems.push(
    `locale tables are in the critical path (${localesInCriticalPath.join(", ")}) — something outside the lazy settings chunk now imports src/i18n/translations.ts; import src/i18n/languages.ts for codes, and reach text only through useTranslation`,
  );
}

/**
 * And the other half: a locale that ships nowhere at all is a language the picker offers and
 * cannot render. Dropping a table is then a one-line change that fails no test and shows up only
 * as a settings panel that stays English after the user picks Deutsch.
 */
const missingLocales = Object.entries(LOCALES_THAT_MUST_STAY_LAZY)
  .filter(([, probe]) => !bundleSources.some((source) => source.includes(probe)))
  .map(([language]) => language);
if (missingLocales.length) {
  problems.push(
    `locales the picker offers were not emitted at all (${missingLocales.join(", ")}) — src/i18n/translations.ts lost a table, or a probe string in this file no longer matches it`,
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
} else if (html.includes(lazyIconChunk) || settingsHtml.includes(lazyIconChunk)) {
  problems.push(
    `${lazyIconChunk} is referenced from a document's <head> — it is meant to be fetched on demand, not preloaded`,
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

/**
 * Controls that state their own typography have to outrank the shell's own reset.
 *
 * `.zs-shell button, input, textarea, select { font: inherit }` is a class-plus-type selector, so a
 * bare `.zs-select-trigger { font-size: 12px }` loses to it — and loses silently, because the
 * declaration is right there in the stylesheet looking correct while the button renders at the
 * inherited 16px. That shipped once, on the language picker. Every control below states its own
 * font and renders as one of those reset elements, so each must stay `.zs-shell`-scoped; the fix
 * is to write `.zs-shell .zs-thing`, never to delete the name from this list.
 */
const SHELL_SCOPED_CONTROLS = [".zs-btn", ".zs-select-trigger"];

for (const styleSheet of assetNames.filter((name) => name.endsWith(".css"))) {
  const css = readFileSync(join(distDir, "assets", styleSheet), "utf8");
  for (const control of SHELL_SCOPED_CONTROLS) {
    const name = control.replace(/\./g, "\\.");
    /** The rule carrying the typography is the one declaring the `font` shorthand. */
    const scoped = new RegExp(`\\.zs-shell\\s+${name}\\{[^}]*font:`);
    const unscoped = new RegExp(`(^|[,}])${name}\\{[^}]*font:`);
    if (!scoped.test(css) && unscoped.test(css)) {
      problems.push(
        `${control} sets its own font with no .zs-shell scope in ${styleSheet} — the shell's "font: inherit" reset outranks a bare class, so it renders at the inherited base size`,
      );
    }
  }
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
  `verify-renderer-budget: OK (radial.html ${(totalBytes / 1024).toFixed(1)} kB critical JS in ${uniqueScripts.length} chunks, ${totalIcons} Lucide glyphs, ${(fontBytes / 1024).toFixed(1)} kB fonts in ${fontFiles.length} files, ${Object.keys(LOCALES_THAT_MUST_STAY_LAZY).length + 1} locales all lazy)`,
);
