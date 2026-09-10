/**
 * Contract of `src/launchFailure.ts`, driven from plain node against a real Vite build.
 *
 * A launch failure used to reach the user as whatever Windows printed: the main process glued the
 * whole PowerShell stderr onto the end of one sentence and the renderer put that string in a red
 * box with no `max-width`, so eight lines of `CommandNotFoundException` covered the Settings window.
 *
 * What is asserted here is the shape that makes that impossible rather than merely unlikely — the
 * body of the card is single-line, capped, and cannot contain stderr; the dump lives only in `raw`.
 * The per-case codes are asserted too, because a classifier that quietly degrades to "unknown"
 * still passes every structural check while telling the user nothing.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "rovyl-launch-failure-smoke-"));

try {
  await build({
    root,
    logLevel: "warn",
    build: {
      ssr: join(root, "scripts", "launch-failure-smoke.entry.tsx"),
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
    // A Start menu entry that is gone. `shell:AppsFolder\…` reads as a URL scheme, so without the
    // method taking precedence an uninstalled app was reported as a dead link.
    startMenuEntryGoneCode: "start-app-gone",
    startMenuEntryGoneNamesTheApp: true,
    startMenuEntryGoneSaysNothingAboutLinks: true,

    // The screenshot: an AppUserModelID stored as a launch command.
    telegramCode: "unlaunchable-app-id",
    telegramTitle: "Could not open Telegram",
    telegramKeepsRawForDetails: true,

    // Same failure, main process still sending only the string.
    telegramLegacyCode: "unlaunchable-app-id",
    telegramLegacySubjectFromCommand: true,

    uninstalledCode: "missing-file",
    presentButRefusedCode: "unknown",

    deniedPortugueseCode: "permission",
    uacCancelledCode: "cancelled",
    deadProtocolCode: "no-handler",
    deadProtocolNamesScheme: true,

    // A URL whose failure carries no usable signal still must not become "missing-file".
    deadUrlNoSignalCode: "no-handler",
    noUrlCaseMentionsAnExe: true,

    deletedFolderCode: "folder-missing",
    bareAliasCode: "not-found",
    dataFileCode: "not-found",
    keySimulatorCode: "key-simulator",
    emptyCommandCode: "empty-command",
    unknownCode: "unknown",

    versionedExeTitle: "python3.11 is no longer here",
    missingBrazilianCode: "missing-file",

    // The pre-flight probe: no shell wrote this text, so only `exeExists` can classify it.
    preflightMissingAppCode: "missing-file",
    preflightMissingAppTitle: "Zed is no longer here",
    preflightMatchesUninstalled: true,
    preflightMissingFolderCode: "folder-missing",

    bodyIsSingleLine: true,
    bodyExcludesStderr: true,
    bodyIsCapped: true,
    rawIsCapped: true,
    reportCarriesTheFacts: true,
  };

  const failures = Object.entries(expected)
    .filter(([key, want]) => actual[key] !== want)
    .map(([key, want]) => `  - ${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(actual[key])}`);

  if (failures.length) {
    console.error("launch-failure-smoke: FAILED");
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }

  assert.ok(true);
  console.log(`launch-failure-smoke: OK (${Object.keys(expected).length} assertions)`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
