/**
 * Contract of `src/persistenceMirror.ts`, driven from plain node against a real Vite build.
 *
 * The mirror is a cache, but it used to be able to take the real save down with it: the debounced
 * effect wrote the three keys unguarded and only then called `saveFullConfig`, so a
 * `QuotaExceededError` on the cache skipped the write to disk. And a write that failed on the
 * third key left a torn mirror — a new `zenith_user` beside a stale `zenith_config` — which the
 * fallback hydration path would read as one coherent blob.
 *
 * Neither failure is visible without filling the quota, which is why they are asserted here.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "rovyl-mirror-smoke-"));

try {
  await build({
    root,
    logLevel: "warn",
    build: {
      ssr: join(root, "scripts", "persistence-mirror-smoke.entry.tsx"),
      outDir,
      emptyOutDir: true,
      target: "node20",
      minify: false,
      rollupOptions: { output: { format: "es", entryFileNames: "entry.mjs" } },
    },
    ssr: { noExternal: true },
  });

  const { collect } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);
  const actual = collect();

  const expected = {
    fittingPayloadWritesEverything: true,
    fittingPayloadKeys: "zenith_apps,zenith_config,zenith_user",

    oversizedPayloadIsDropped: true,
    oversizedPayloadLeavesNothing: true,

    clearingFreesRoomForTheRetry: true,
    retryStoredTheNewValue: true,

    partialWriteIsDropped: true,
    partialWriteLeavesNothing: true,

    unavailableStorageIsDropped: true,
  };

  const failures = Object.entries(expected)
    .filter(([key, want]) => actual[key] !== want)
    .map(([key, want]) => `  - ${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(actual[key])}`);

  if (failures.length) {
    console.error("persistence-mirror-smoke: FAILED");
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }

  assert.ok(true);
  console.log(`persistence-mirror-smoke: OK (${Object.keys(expected).length} assertions)`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
