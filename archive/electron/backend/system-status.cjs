"use strict";

/**
 * The live readings behind the system dock, as the main process needs them.
 *
 * The helper is `rovyl-helper.exe system-status` — a long-lived process spoken to over stdin,
 * exactly like the mouse hook, for the same reason: the dock is drawn at the instant the wheel
 * opens, and starting a process there would cost more than the whole gesture does. See the
 * `RovylSystemStatus` class comment in `backend/native-helper/rovyl-helper.cs`.
 *
 * Owning it here rather than inline in `electron-main.js` keeps two things testable without
 * booting Electron: the shape of a reading, and the parsing of the line that produces one.
 * `scripts/screen-docks-smoke.mjs` reads BOTH this file and the `.cs` to pin the field order of
 * `STATUS`, because getting that order wrong means the battery pill showing the volume.
 */

const { spawn } = require("child_process");
const { createLineSplitter } = require("./foreground-snapshot.cjs");

/**
 * What a reading is before one has arrived.
 *
 * Every number is its own "unknown" — `-1`, never 0. A desktop has no battery and a cable has no
 * signal quality, and a readout that cannot tell those from "empty" shows a flat battery to
 * somebody sitting at a machine that has none.
 */
const UNKNOWN_SYSTEM_STATUS = Object.freeze({
  volume: -1,
  muted: false,
  network: "none",
  signal: -1,
  battery: -1,
  charging: false,
});

const NETWORK_KINDS = new Set(["none", "ethernet", "wifi", "other"]);

/**
 * `STATUS <volume> <muted> <network> <signal> <battery> <charging>`.
 *
 * The field ORDER is the contract with `RovylSystemStatus.Reading.Line()`. Anything malformed
 * returns null rather than a partly-filled reading: a dock painting a 0% battery because one field
 * was missing is worse than a dock that keeps the reading it already had.
 */
function parseSystemStatusLine(line) {
  if (typeof line !== "string") return null;
  const parts = line.trim().split(/\s+/);
  if (parts.length !== 7 || parts[0] !== "STATUS") return null;

  const volume = Number(parts[1]);
  const muted = parts[2];
  const network = parts[3];
  const signal = Number(parts[4]);
  const battery = Number(parts[5]);
  const charging = parts[6];

  if (!Number.isInteger(volume) || !Number.isInteger(signal) || !Number.isInteger(battery)) return null;
  if (muted !== "0" && muted !== "1") return null;
  if (charging !== "0" && charging !== "1") return null;
  if (!NETWORK_KINDS.has(network)) return null;

  const clamp = (value) => (value < 0 ? -1 : Math.min(100, value));
  return {
    volume: clamp(volume),
    muted: muted === "1",
    network,
    signal: clamp(signal),
    battery: clamp(battery),
    charging: charging === "1",
  };
}

/** How often the readings are re-read while the wheel is up. */
const WATCH_INTERVAL_MS = 1000;

/**
 * The helper, its last reading, and the four things anyone wants to do with it.
 *
 * `setActive` follows the SETTING — a dock that is switched on keeps a process, so the first wheel
 * of the session does not pay for starting one. `setWatching` follows the WHEEL — nobody is
 * looking at a readout with no wheel on screen, so an idle session polls nothing at all.
 */
function createSystemStatusService({ resolveHelperPath, log = () => {}, onStatus = () => {} }) {
  let child = null;
  let ready = false;
  let watching = false;
  /** One slot, last write wins: a WATCH chasing another WATCH is the state we want to end in. */
  let pending = [];
  let status = { ...UNKNOWN_SYSTEM_STATUS };
  let active = false;

  function write(command) {
    if (!child || !ready || !child.stdin || !child.stdin.writable) {
      pending.push(command);
      return;
    }
    try {
      child.stdin.write(`${command}\n`);
    } catch (e) {
      log(`[SystemStatus] command failed: ${e.message}`);
    }
  }

  function start() {
    if (process.platform !== "win32" || child) return;
    const helper = resolveHelperPath();
    if (!helper) {
      log("[SystemStatus] no helper binary; the dock's readouts stay unknown");
      return;
    }
    ready = false;
    let spawned;
    try {
      spawned = spawn(helper, ["system-status", String(process.pid)], { windowsHide: true });
    } catch (e) {
      log(`[SystemStatus] spawn failed: ${e.message}`);
      return;
    }
    child = spawned;

    const read = createLineSplitter((line) => {
      if (line === "READY") {
        ready = true;
        const queued = pending;
        pending = [];
        /** Whatever the wheel asked for while the process was starting still applies. */
        if (watching) write(`WATCH ${WATCH_INTERVAL_MS}`);
        /**
         * One reading straight away, so the cache is real before any wheel opens. Without it the
         * first dock of the session paints four unknowns for the few milliseconds between the
         * open and the helper's first watched poll — the one moment it is most closely looked at.
         */
        else write("POLL");
        for (const command of queued) write(command);
        return;
      }
      const next = parseSystemStatusLine(line);
      if (!next) return;
      status = next;
      try {
        onStatus(status);
      } catch (e) {
        log(`[SystemStatus] listener threw: ${e.message}`);
      }
    });

    spawned.stdout.setEncoding("utf8");
    spawned.stdout.on("data", read);
    spawned.stderr.setEncoding("utf8");
    spawned.stderr.on("data", (data) => log(`[SystemStatus] ${String(data).trim()}`));
    spawned.on("exit", () => {
      if (child !== spawned) return;
      child = null;
      ready = false;
      pending = [];
      /**
       * The last reading is NOT cleared. It was true a moment ago and it is the best answer
       * available; wiping it would blank every readout the instant the helper is restarted, which
       * is exactly when the dock is most likely to be on screen.
       */
    });
  }

  function stop() {
    pending = [];
    if (!child) return;
    const spawned = child;
    child = null;
    ready = false;
    try {
      /** EXIT rather than a kill, so the read loop ends on its own terms. */
      if (spawned.stdin && spawned.stdin.writable) spawned.stdin.write("EXIT\n");
    } catch (e) {
      /* ignore */
    }
    setTimeout(() => {
      try {
        if (!spawned.killed) spawned.kill();
      } catch (e) {
        /* ignore */
      }
    }, 250);
  }

  return {
    /** The dock's switches changed. Only a dock that needs live readings keeps a process. */
    setActive(next) {
      const wanted = !!next;
      if (wanted === active) return;
      active = wanted;
      if (active) start();
      else stop();
    },
    /**
     * The wheel opened or closed.
     *
     * Deliberately does NOT start the helper: with the dock switched off there is nothing to read
     * for, and starting a process on the way into a gesture is the cost this design exists to
     * avoid paying.
     */
    setWatching(next) {
      const wanted = !!next;
      if (wanted === watching) return;
      watching = wanted;
      if (!child) return;
      write(watching ? `WATCH ${WATCH_INTERVAL_MS}` : "WATCH 0");
    },
    setVolume(percent) {
      const value = Math.round(Number(percent));
      if (!Number.isFinite(value)) return;
      write(`VOL ${Math.max(0, Math.min(100, value))}`);
    },
    setMuted(muted) {
      write(`MUTE ${muted ? 1 : 0}`);
    },
    /** The last reading. Never starts a helper to answer — an unknown answer is a valid one. */
    snapshot() {
      return status;
    },
    stop() {
      active = false;
      watching = false;
      stop();
    },
  };
}

module.exports = {
  UNKNOWN_SYSTEM_STATUS,
  WATCH_INTERVAL_MS,
  parseSystemStatusLine,
  createSystemStatusService,
};
