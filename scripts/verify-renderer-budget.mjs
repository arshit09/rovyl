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
 * Raise the budgets deliberately when a real feature needs the room — never to make a build pass.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(root, "dist");

/** Ceiling for all statically loaded JS, in bytes. It sat at ~561 kB when this guard was written. */
const CRITICAL_JS_BUDGET = 620 * 1024;

/**
 * Lucide glyphs allowed in the critical path. `CURATED_ICON_MAP` holds 282; the margin is there so
 * adding a wheel glyph does not need this file edited, while pulling the whole set still fails.
 */
const MAX_CRITICAL_ICONS = 320;

/**
 * `createLucideIcon("Activity", [["path", …]])`, after minification: an identifier, the glyph name
 * as a string literal, then the array-of-arrays of SVG children. Counting definitions rather than
 * grepping for names is what keeps this honest — a bare `includes("Disc")` would also match
 * `Disc3`, `"Discord"` and the Italian `"Disconnetti"` sitting in the same chunk.
 */
const LUCIDE_ICON_DEFINITION = /\(["'`]([A-Z][A-Za-z0-9]*)["'`]\s*,\s*\[\[/g;

const problems = [];

let html;
try {
  html = readFileSync(join(distDir, "index.html"), "utf8");
} catch {
  console.error(`verify-renderer-budget: no build output at ${distDir} — run 'vite build' first`);
  process.exit(1);
}

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

if (totalIcons > MAX_CRITICAL_ICONS) {
  problems.push(
    `${totalIcons} Lucide glyphs are in the critical path (${iconsByChunk.join(", ")}), over the ${MAX_CRITICAL_ICONS} allowed — keep the barrel out of the static graph and add wheel glyphs to CURATED_ICON_MAP one at a time`,
  );
}

/**
 * The lazy set must still exist, and must still be lazy. Without both halves a build could pass
 * the checks above by dropping the icon picker's glyphs altogether, or by preloading them anyway.
 */
const lazyIconChunk = readdirSync(join(distDir, "assets")).find((name) =>
  name.startsWith("_virtual_lucide-icon-set"),
);
if (!lazyIconChunk) {
  problems.push(
    "no _virtual_lucide-icon-set-*.js chunk was emitted — the icon picker's glyph set is no longer code-split",
  );
} else if (html.includes(lazyIconChunk)) {
  problems.push(
    `${lazyIconChunk} is referenced from dist/index.html — it is meant to be fetched on demand, not preloaded`,
  );
}

if (problems.length) {
  console.error("verify-renderer-budget: FAILED");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `verify-renderer-budget: OK (${(totalBytes / 1024).toFixed(1)} kB critical JS in ${uniqueScripts.length} chunks, ${totalIcons} Lucide glyphs)`,
);
