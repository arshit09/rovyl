/**
 * `autoWorkspaces` on its way off disk — `src/configHydration.ts`.
 * Run: node scripts/auto-workspaces-config-smoke.mjs
 *
 * A config saved before the feature has no such key, and one saved by hand can have half of it.
 * Either way the answer is "as shipped, except what the file actually says".
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "rovyl-auto-ws-config-"));

try {
  await build({
    root,
    logLevel: "warn",
    build: {
      ssr: join(root, "src", "configHydration.ts"),
      outDir,
      emptyOutDir: true,
      target: "node20",
      minify: false,
      rollupOptions: { output: { format: "es", entryFileNames: "entry.mjs" } },
    },
    ssr: { noExternal: true },
  });
  const { normalizeStoredConfig } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

  const allOn = { apps: true, games: true, sources: { desktop: true, steam: true, lutris: true, heroic: true } };

  assert.deepEqual(normalizeStoredConfig({}).autoWorkspaces, allOn, "no key: everything on");
  assert.deepEqual(normalizeStoredConfig(null).autoWorkspaces, allOn, "no config: everything on");
  assert.deepEqual(
    normalizeStoredConfig({ autoWorkspaces: { games: false } }).autoWorkspaces,
    { ...allOn, games: false },
    "a partial block keeps the rest on",
  );
  assert.deepEqual(
    normalizeStoredConfig({ autoWorkspaces: { sources: { steam: "no", heroic: false } } }).autoWorkspaces.sources,
    { desktop: true, steam: true, lutris: true, heroic: false },
    "a non-boolean falls back to the default, a boolean is believed",
  );
  assert.deepEqual(normalizeStoredConfig({ autoWorkspaces: 7 }).autoWorkspaces, allOn, "junk is no block");

  console.log("auto-workspaces-config smoke: ok");
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
