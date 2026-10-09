/**
 * The contract behind "an app added from the search list launches".
 *
 * The picker lists Start menu entries, and what `Get-StartApps` hands back is an AppID — an
 * identifier. Measured on a live Windows 10 host:
 *
 *   com.squirrel.Figma.Figma                                       Figma
 *   c:.users.<me>.appdata.local.capcut.apps.9.5.0.4045.capcut.exe  CapCut
 *   zoom.us.Zoom Video Meetings                                    Zoom, with SPACES in the id
 *
 * Storing one of those as the command and handing it to `start` does not merely fail. It raises a
 * MODAL "Windows cannot find…" dialog owned by our own window: `exec` never calls back, the ladder
 * hangs behind it, and 151 of the entries on that host have this shape. That is the whole reported
 * bug — Discord worked only because its id was spelled out in a hard-coded list, and Figma's was
 * not.
 *
 * So the invariants here are about the two ways the fix can silently rot:
 *
 *  1. Someone "simplifies" `exec_explorer_shell` back to `cmd /c start ""`. It looks equivalent and
 *     restores the hang.
 *  2. Someone reinstates splitting the AppID at its first space to pass "arguments". AppsFolder
 *     activation takes none, and the split is what broke every id with a space in it.
 *
 * Neither is reachable from a unit test: the ladder lives inside a closure in `runExecuteCommand`.
 * Shapes and classification are unit-tested in `backend/win32-launch.test.cjs`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const mainSource = read("backend", "electron-main.js");
const settingsSource = read("src", "components", "PrecisionSettings.tsx");
const launchUtilSource = read("src", "utils", "windowsLaunchCommand.ts");
const appSource = read("src", "App.tsx");

/** The body of one `case "<name>":` arm of the `tryExecution` switch. */
function executionCaseBody(name) {
  const start = mainSource.indexOf(`case "${name}":`);
  assert.notStrictEqual(start, -1, `tryExecution lost its "${name}" arm`);
  const rest = mainSource.slice(start + `case "${name}":`.length);
  const end = rest.search(/\n\s{8}(?:case "|default:)/);
  return end === -1 ? rest : rest.slice(0, end);
}

const explorerArm = executionCaseBody("exec_explorer_shell");

// ── 1. The AppsFolder rung goes through explorer.exe, never through `start` ───────────────────────
assert.match(
  explorerArm,
  /spawn\(\s*"explorer\.exe"/,
  "exec_explorer_shell must launch through explorer.exe: `start \"\" \"shell:AppsFolder\\…\"` answers an " +
    "unresolvable AppID with a modal dialog that hangs the ladder instead of returning an error.",
);
assert.doesNotMatch(
  explorerArm,
  /start\s+""/,
  "exec_explorer_shell must not go back to `cmd /c start \"\"` — that is the hang this rung exists to avoid.",
);

// ── 2. The AppID is taken whole ───────────────────────────────────────────────────────────────────
assert.match(
  explorerArm,
  /appsFolderAppId\(/,
  "exec_explorer_shell must read the id with appsFolderAppId, which strips the prefix without splitting.",
);
assert.doesNotMatch(
  explorerArm,
  /indexOf\("\s"\)|split\(" "\)|firstSpace/,
  'exec_explorer_shell must not split the AppID at a space: "zoom.us.Zoom Video Meetings" is one id, ' +
    "and splitting it produced an id plus two bogus arguments.",
);

// ── 3. A known-folder GUID inside a moniker is an id, not a path ──────────────────────────────────
const resolveShellPathBody = mainSource.slice(
  mainSource.indexOf("const resolveShellPath = (cmd) => {"),
  mainSource.indexOf("/** Cursor from Windows Start Menu"),
);
assert.ok(resolveShellPathBody.length > 0, "resolveShellPath moved: this smoke test needs updating");
assert.match(
  resolveShellPathBody,
  /isAppsFolderCommand\(cmd\)\)\s*return cmd;/,
  "resolveShellPath must leave AppsFolder monikers alone. VLC is listed as " +
    "`{7C5A40EF-…}\\VideoLAN\\VLC\\vlc.exe`, and expanding that GUID inside the moniker yields an id " +
    "the shell has never heard of.",
);

// ── 4. The classifier is a shape test, not a list of app names ────────────────────────────────────
const isShellAppBody = mainSource.slice(
  mainSource.indexOf("const isShellApp = (cmd) => {"),
  mainSource.indexOf("const tryExecution = (method, cmd) => {"),
);
assert.ok(isShellAppBody.length > 0, "isShellApp moved: this smoke test needs updating");
assert.match(
  isShellAppBody,
  /looksLikeBareStartAppId\(/,
  "isShellApp must classify bare AppIDs by shape via looksLikeBareStartAppId.",
);
/** Only the code — the comment above the shape test names Discord and Figma to explain itself. */
const isShellAppCode = isShellAppBody
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");
for (const named of ['includes("discord")', 'includes("microsoft.")', 'includes("google.antigravity")']) {
  assert.ok(
    !isShellAppCode.includes(named),
    `isShellApp must not test for individual apps again (${named}). That list is why ` +
      "com.squirrel.Discord.Discord launched and com.squirrel.Figma.Figma did not — they are the " +
      "same kind of id, and only one of them was written down.",
  );
}

// ── 5. A dead entry is reported, not silently swallowed ───────────────────────────────────────────
assert.match(
  mainSource,
  /method: "start-apps-probe"/,
  "A command whose AppID the last Start menu scan did not contain must come back as a launch " +
    "failure. explorer.exe cannot report one: handed a dead id it opens a stray Explorer window and " +
    "exits 0, so without this check an app that updated its id (CapCut pins a version into its own) " +
    "would just do nothing.",
);
assert.match(
  mainSource,
  /if \(known === null\) warmInstalledAppsCache\(\);/,
  "A cold cache is not evidence that an app is gone: the launch must go ahead and the set fill in " +
    "behind it.",
);

// ── 6. The AppsFolder rung is tried FIRST for a Start menu entry ───────────────────────────────────
/**
 * Ordering is the fix. Every other rung reaches the shell through `start` or `spawn`, and an AppID
 * given to either is the modal-dialog hang — so the entry has to be recognised before the ladder is
 * chosen, not after `exec_start` has already blocked on a dialog.
 */
const appBranch = mainSource.slice(
  mainSource.indexOf("const explicitMoniker = win32Launch.appsFolderAppId(finalCommand);"),
  mainSource.indexOf("} else if (isIDE && finalCommand.includes(\" \")) {"),
);
assert.ok(appBranch.length > 0, "the Start menu branch moved: this smoke test needs updating");
assert.match(
  appBranch,
  /methodsToTry = \["exec_explorer_shell",/,
  "A Start menu entry must try exec_explorer_shell first; every later rung hands the AppID to the " +
    "shell as a command line, which is the hang.",
);
assert.match(
  appBranch,
  /looksLikeBareStartAppId\(finalCommand\)/,
  "The branch must also claim bare AppIDs, or shortcuts added before the picker wrote monikers stay " +
    "broken.",
);
assert.match(
  appBranch,
  /startAppCarriesPathArg/,
  "An id carrying a drive path is a launch line with an argument (recents open a project folder), " +
    "and AppsFolder activation has nowhere to put one — it must not be claimed here.",
);

// ── 7. The picker stores a launch line, not a raw AppID ───────────────────────────────────────────
assert.match(
  settingsSource,
  /onClick=\{\(\) => addAppPath\(startMenuAppIdToLaunchCommand\(item\.Path!\)/,
  "The installed-apps list must wrap the AppID before storing it as a command.",
);
assert.match(
  launchUtilSource,
  /export function startMenuAppIdToLaunchCommand/,
  "startMenuAppIdToLaunchCommand is the one place that decides moniker vs. path.",
);
assert.match(
  launchUtilSource,
  /isWinAbs\) return normalizeWindowsExecutablePickerPath\(id\)/,
  "An AppID that is already an absolute path must stay a path — many are, and a real path carries " +
    "arguments and can be probed on disk before launching.",
);
/**
 * First-run discovery reads the same `Get-StartApps` AppIDs, so it has the same bug if it stores
 * them raw — and it picks Figma by name, which means the very first workspace someone is offered
 * would be built out of shortcuts that cannot launch.
 */
assert.match(
  appSource,
  /const cmd = startMenuAppIdToLaunchCommand\(appId\);/,
  "Start Menu discovery must wrap its AppIDs the same way the picker does.",
);

// ── 8. Icons follow the command ───────────────────────────────────────────────────────────────────
assert.match(
  mainSource,
  /win32Launch\.appsFolderAppId\(filePath\) \|\| resolveShellPath\(filePath\)/,
  "extract-icon.ps1 matches a target by exact equality against Get-StartApps, so the icon lookup " +
    "must hand it the bare AppID; `shell:AppsFolder\\…` matches no AppID, no name and no file, and a " +
    "monikered shortcut would sit there with no icon.",
);

console.log("start-app-launch-smoke: ok");
