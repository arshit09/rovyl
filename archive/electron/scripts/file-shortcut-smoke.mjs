/**
 * The contract behind "a shortcut can point at a file".
 *
 * The load-bearing one is the ladder. A file gets `shell.openPath` and nothing else, because that
 * is the call that asks Windows which program owns the extension. `exec_direct`, the last rung of
 * the app ladder, wraps the line in `<terminal> /c` — so falling through there would not merely
 * look wrong for a `.pdf`. For a `.ps1`, `.bat` or `.reg` someone only meant to OPEN, it RUNS it.
 * That is the regression this file exists to make loud, and assertions 2 and 4 are about keeping a
 * file's failures inside the file branch so it never needs to.
 *
 * Assertion 1 is a smaller claim, and deliberately not overstated. A file target is a PATH while
 * every other launch here is a command LINE, and the preamble in `runExecuteCommand` rewrites
 * lines: `canonicalizeWin32LaunchCommand` quotes any token with a space, so
 * `D:\Reports\Q3 plan.xlsx` really does come back as `"D:\Reports\Q3 plan.xlsx"` — that part is
 * measured below. What it does NOT do is break the launch; `ShellExecuteEx` under `shell.openPath`
 * tolerates a quoted `lpFile` (checked against Electron 28, both forms opened). The skip is
 * therefore hygiene rather than a fix, and the assertion is written to say which is which: if the
 * canonicalizer ever stops quoting, the premise is gone and the guard can go with it.
 *
 * Like its neighbours this reads source: the ladder lives inside a closure in `runExecuteCommand`
 * and there is no way to call it from plain node.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const mainSource = read("backend", "electron-main.js");
const preloadSource = read("backend", "electron-preload.js");
const settingsSource = read("src", "components", "PrecisionSettings.tsx");
const typesSource = read("src", "types.ts");
const win32Launch = require(join(root, "backend", "win32-launch.js"));

// ── 1. The rewrite does fire on a path, so the guard has something to guard ─────────────────────────────
if (process.platform === "win32") {
  const scratch = mkdtempSync(join(tmpdir(), "rovyl-file-shortcut-smoke-"));
  try {
    const withSpace = join(scratch, "Q3 plan.xlsx");
    writeFileSync(withSpace, "x");
    const folderWithSpace = join(scratch, "My Projects");
    mkdirSync(folderWithSpace, { recursive: true });

    assert.strictEqual(
      win32Launch.canonicalizeWin32LaunchCommand(withSpace),
      `"${withSpace}"`,
      "This test's premise is gone: the canonicalizer no longer quotes a file path with a space. " +
        "That is not a failure of the app — a quoted path opens fine — so if the change is " +
        "deliberate, delete this assertion and the !isBarePathTarget guards it protects.",
    );
    assert.ok(
      !win32Launch.canonicalizeWin32LaunchCommand(folderWithSpace).includes('"'),
      "A folder escapes the quoting only because the splitter requires isFile() before claiming a " +
        "token whole. Safe by accident is not safe on purpose — hence the guard covering both.",
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

assert.match(
  mainSource,
  /const isBarePathTarget = commandType === "file" \|\| commandType === "folder";/,
  "Files and folders are bare paths: the line-rewriting preamble must not touch them.",
);
for (const rewrite of [
  "normalizeAumidIdeCommands",
  "addIdeNewWindowFlag",
  "canonicalizeWin32LaunchCommand",
]) {
  const at = mainSource.indexOf(rewrite, mainSource.indexOf("const isBarePathTarget"));
  assert.notStrictEqual(at, -1, `${rewrite} left the preamble: this smoke test needs updating`);
  assert.ok(
    mainSource.slice(at - 400, at).includes("!isBarePathTarget"),
    `${rewrite} must be guarded by !isBarePathTarget — it rewrites command lines, and a file ` +
      "target is a path.",
  );
}

// ── 2. One rung, and it is the shell's own opener ─────────────────────────────────────────────────
const fileBranchStart = mainSource.indexOf('if (commandType === "file") {');
assert.notStrictEqual(fileBranchStart, -1, "The explicit file branch is gone.");
const fileBranch = mainSource.slice(
  fileBranchStart,
  mainSource.indexOf("let methodsToTry = [];", fileBranchStart),
);
assert.ok(fileBranch.length > 0, "The file branch moved: this smoke test needs updating.");
assert.match(
  fileBranch,
  /tryExecution\("shell\.openPath", resolvedCommand\)/,
  "A file is opened with shell.openPath, which asks Windows which program owns the extension.",
);
for (const forbidden of ["exec_direct", "exec_start", "exec_explorer_shell", "methodsToTry"]) {
  assert.ok(
    !fileBranch.includes(forbidden),
    `The file branch must not reach ${forbidden}: those build a command line, and a .ps1 or .bat ` +
      "the user only meant to open would be executed instead.",
  );
}
assert.match(
  fileBranch,
  /return launchFailed\(/,
  "The branch has to answer with its own failure. Falling through to the app ladder is the " +
    "execution hazard above; falling out of the try is the 'Something went wrong' card.",
);
assert.match(
  fileBranch,
  /missingTargetFailure\(trimmedCommand, resolvedCommand, commandType\)/,
  "A deleted target must be probed before the shell sees it. A missing document came back as a " +
    "plain rejection when measured, but a missing .exe is what raised the modal dialog this whole " +
    "pre-flight exists for — and a file shortcut may point at one. The probe also produces the " +
    "error card that names the path, instead of Electron's bare 'Failed to open path'.",
);

// ── 3. The probe treats a file as a path, not as a line ──────────────────────────────────────────
assert.match(
  mainSource,
  /commandType === "folder" \|\| commandType === "file"\s*\n\s*\? line\.replace/,
  "missingTargetFailure must only unquote a file target. Splitting it like a command line probes " +
    "`D:\\Reports\\Q3` and calls a document that is present missing.",
);

// ── 4. A document is classified as a document when it fails ──────────────────────────────────────
const failureSource = read("src", "launchFailure.ts");
assert.match(
  failureSource,
  /if \(commandType === 'file'\) \{/,
  "A file failure must be classified before the executable copy, which sends the user to " +
    "Application → Choose file. There is no .exe behind a spreadsheet.",
);
assert.ok(
  failureSource.indexOf("if (commandType === 'file')") <
    failureSource.indexOf("const looksLikePath ="),
  "The file branch has to come before the path-like/executable classification, or it never runs.",
);

// ── 5. The picker opens on documents, not on executables ────────────────────────────────────────
assert.match(
  mainSource,
  /const anyFile = options && options\.mode === "any";/,
  "select-file must accept the mode the File picker sends.",
);
assert.match(
  preloadSource,
  /selectFile: \(options\) => ipcRenderer\.invoke\("select-file", options\)/,
  "The bridge has to forward the mode, or the dialog silently keeps the executable filter.",
);
assert.match(
  settingsSource,
  /selectFile\?\.\(\{ mode: 'any' \}\)/,
  "The File picker asks for every file: the .exe/.lnk filter hides every document in the folder.",
);
assert.ok(
  settingsSource.includes("commandType: 'file', description: 'File shortcut'"),
  "Adding a file must store commandType 'file'. Stored as 'app' it goes down the ladder above.",
);

// ── 6. The type exists everywhere the value travels ─────────────────────────────────────────────
assert.match(
  typesSource,
  /commandType\?: "app" \| "url" \| "folder" \| "file"(?: \| "[a-z]+")*;/,
  "AppItem must admit the file type.",
);
assert.match(
  typesSource,
  /commandType: "app" \| "url" \| "folder" \| "file"(?: \| "[a-z]+")*,/,
  "The executeCommand signature must admit it too, or the renderer cannot send it.",
);

console.log("file-shortcut-smoke: ok");
