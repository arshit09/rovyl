"use strict";

/**
 * When a downloaded update gets installed, decided in one place with no Electron underneath it.
 *
 * The rule the app follows now is "on the next launch, before anything else exists" — not "in the
 * background of the exit that came before it". The reason is in `backend/electron-main.js`, on
 * `installPendingUpdateAndExit`; what lives here is the branching, because the interesting cases
 * are the ones that are awkward to reach by hand: an installer that is already running, one that
 * has failed twice, a note left behind by a version that is already installed.
 *
 * `installerExists` and `installerRunning` are functions, not booleans, so the caller's `tasklist`
 * only runs on the branch that actually needs an answer.
 */

/**
 * Two goes at the same installer, then the app starts on whatever is on disk. A launcher that
 * refuses to launch is a worse outcome than a launcher one version behind — and the Settings row
 * still offers the install to anyone who wants to retry it by hand.
 */
const PENDING_UPDATE_MAX_ATTEMPTS = 2;

/** Field by field: `1.9.0` is not newer than `1.11.0`, however the two strings compare. */
function isNewerVersion(candidate, current) {
  const parts = (v) =>
    String(v == null ? "" : v)
      .split("-")[0]
      .split(".")
      .map((p) => parseInt(p, 10) || 0);
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * What this launch should do about the note left on disk.
 *
 * `start`    nothing to install — build the app
 * `clear`    the note is spent (already installed, or its installer is gone); delete it and start
 * `install`  spawn the installer and exit; it reopens the app when the files are replaced
 * `give-up`  the installer has had its attempts and has not taken; flag the note and start anyway
 *
 * @param {object} input
 * @param {{version: string, installerPath: string, attempts?: number, gaveUp?: boolean}|null} input.pending
 * @param {string} input.currentVersion
 * @param {() => boolean} input.installerExists
 * @param {() => boolean} input.installerRunning
 * @param {number} [input.maxAttempts]
 * @returns {{ action: "start"|"clear"|"install"|"give-up", reason: string }}
 */
function decidePendingUpdate({
  pending,
  currentVersion,
  installerExists,
  installerRunning,
  maxAttempts = PENDING_UPDATE_MAX_ATTEMPTS,
}) {
  if (!pending || typeof pending.version !== "string" || typeof pending.installerPath !== "string") {
    return { action: "start", reason: "no pending update" };
  }

  if (!isNewerVersion(pending.version, currentVersion)) {
    /** This IS the new version: the install worked, and the note has done its job. */
    return { action: "clear", reason: "already on this version or newer" };
  }

  /** Flagged as hopeless by an earlier launch. Kept on disk so the flag survives — see below. */
  if (pending.gaveUp === true) {
    return { action: "start", reason: "previously gave up on this installer" };
  }

  if (!installerExists()) {
    return { action: "clear", reason: "installer file is gone" };
  }

  const attempts = Number(pending.attempts) || 0;
  if (attempts >= maxAttempts) {
    /**
     * Flagged rather than deleted. A deleted note lets the next `update-downloaded` write a fresh
     * one with the counter back at zero, and every cold start would pay for two failed installs
     * again. A genuinely newer version clears the flag by making this note stale.
     */
    return { action: "give-up", reason: `${attempts} attempts without installing` };
  }

  if (installerRunning()) {
    /**
     * A second click while the first install is still working. Starting normally is the safe
     * answer: two NSIS installs over one folder is how an install ends up half-applied, and if the
     * running one succeeds it kills this process and reopens the new version anyway.
     */
    return { action: "start", reason: "installer already running" };
  }

  return { action: "install", reason: `attempt ${attempts + 1}` };
}

module.exports = {
  PENDING_UPDATE_MAX_ATTEMPTS,
  isNewerVersion,
  decidePendingUpdate,
};
