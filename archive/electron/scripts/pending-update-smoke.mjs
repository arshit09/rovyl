/**
 * Smoke test for backend/pending-update.cjs (no Electron, no installer, no network).
 * Run: node scripts/pending-update-smoke.mjs
 *
 * This is the code that decides whether a launch opens the app or hands the machine to an
 * installer, and every branch of it is a way to end up with a launcher that does not launch. The
 * cases below are the ones that are painful to reach by hand: an installer already running, one
 * that has failed twice, a note left behind by a version that is already installed.
 */
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { decidePendingUpdate, isNewerVersion, PENDING_UPDATE_MAX_ATTEMPTS } = require(
  "../backend/pending-update.cjs",
);

const never = () => {
  throw new Error("this branch must not ask");
};
const decide = (pending, currentVersion, overrides = {}) =>
  decidePendingUpdate({
    pending,
    currentVersion,
    installerExists: () => true,
    installerRunning: () => false,
    ...overrides,
  });

const note = (extra = {}) => ({
  version: "1.12.0",
  installerPath: "C:\\cache\\Rovyl-Setup-1.12.0.exe",
  ...extra,
});

/** Double digits are where a string comparison would quietly pick the wrong version. */
assert.equal(isNewerVersion("1.11.0", "1.9.0"), true);
assert.equal(isNewerVersion("1.9.0", "1.11.0"), false);
assert.equal(isNewerVersion("1.11.0", "1.11.0"), false);
assert.equal(isNewerVersion("2.0.0", "1.99.99"), true);
/** A pre-release tag is not a version bump of its own. */
assert.equal(isNewerVersion("1.12.0-beta.1", "1.12.0"), false);

/** Nothing waiting: the overwhelmingly common launch, and it must not touch the disk at all. */
assert.equal(
  decidePendingUpdate({
    pending: null,
    currentVersion: "1.11.0",
    installerExists: never,
    installerRunning: never,
  }).action,
  "start",
);

/** A note missing its fields is not a reason to refuse to start. */
assert.equal(decide({ version: "1.12.0" }, "1.11.0", { installerExists: never }).action, "start");

/** The ordinary case this whole change exists for: exit, relaunch, install, reopen. */
assert.equal(decide(note(), "1.11.0").action, "install");

/**
 * The relaunch the installer itself performs. The app comes back as 1.12.0, so the note is spent —
 * and it has to be deleted, or the next launch installs 1.12.0 over 1.12.0 forever.
 */
assert.equal(decide(note(), "1.12.0").action, "clear");
/** Same for a note left behind by a version the user has since moved past. */
assert.equal(decide(note(), "1.13.0").action, "clear");

/** Deleted cache, cleaned temp folder: start, do not spawn a path that is not there. */
assert.equal(decide(note(), "1.11.0", { installerExists: () => false }).action, "clear");

/** Second click while the first installer works — one install over one folder, never two. */
assert.equal(decide(note(), "1.11.0", { installerRunning: () => true }).action, "start");

/** The check costs a `tasklist`, so the cheap disqualifiers have to come first. */
assert.equal(decide(note(), "1.12.0", { installerRunning: never }).action, "clear");
assert.equal(
  decide(note(), "1.11.0", { installerExists: () => false, installerRunning: never }).action,
  "clear",
);

/** Attempts are spent before the app gives up, not after. */
assert.equal(decide(note({ attempts: 1 }), "1.11.0").action, "install");
assert.equal(decide(note({ attempts: PENDING_UPDATE_MAX_ATTEMPTS }), "1.11.0").action, "give-up");
assert.equal(
  decide(note({ attempts: 99 }), "1.11.0", { installerRunning: never }).action,
  "give-up",
);

/**
 * And once it has given up, it stays given up. The flag is what stops `update-downloaded` — which
 * electron-updater re-emits from its cache in every later session — from handing a broken
 * installer a fresh pair of attempts on every single launch.
 */
assert.equal(
  decide(note({ attempts: 2, gaveUp: true }), "1.11.0", {
    installerExists: never,
    installerRunning: never,
  }).action,
  "start",
);

/** A genuinely newer version makes the flagged note stale, and the app tries again. */
assert.equal(
  decide({ version: "1.13.0", installerPath: "C:\\cache\\Rovyl-Setup-1.13.0.exe" }, "1.11.0")
    .action,
  "install",
);

console.log("pending-update smoke: OK");
