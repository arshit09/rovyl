/**
 * The taskbar overlay switches, as the main process needs them.
 *
 * A second home for the same rules, and deliberately so: main is CommonJS and cannot import
 * `src/utils/taskbarOverlay.ts`, which the settings panel needs for its own types and defaults.
 * What keeps the two from drifting is not discipline, it is scripts/taskbar-overlay-smoke.mjs —
 * it loads BOTH and asserts they agree, and it also reads backend/taskbar-control.ps1 to pin the
 * field order of the line built here. Change one of the three and the test names the other two.
 */

/** Turning the feature on hides everything and leaves the bar's own background alone. */
const DEFAULT_TASKBAR_OVERLAY = {
  enabled: false,
  transparent: false,
  showStart: false,
  showApps: false,
  showTray: false,
  showClock: false,
};

function bool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

/** Anything missing takes its default, so a config written before a switch existed is not "off". */
function normalizeTaskbarOverlay(value) {
  const raw = value && typeof value === "object" ? value : {};
  return {
    enabled: bool(raw.enabled, DEFAULT_TASKBAR_OVERLAY.enabled),
    transparent: bool(raw.transparent, DEFAULT_TASKBAR_OVERLAY.transparent),
    showStart: bool(raw.showStart, DEFAULT_TASKBAR_OVERLAY.showStart),
    showApps: bool(raw.showApps, DEFAULT_TASKBAR_OVERLAY.showApps),
    showTray: bool(raw.showTray, DEFAULT_TASKBAR_OVERLAY.showTray),
    showClock: bool(raw.showClock, DEFAULT_TASKBAR_OVERLAY.showClock),
  };
}

/**
 * Whether this configuration would visibly do anything.
 *
 * This is what decides that no helper process is started and no command is sent, so "on, with
 * everything kept" costs exactly what "off" costs.
 */
function taskbarOverlayIsActive(flags) {
  if (!flags || !flags.enabled) return false;
  return (
    flags.transparent ||
    !flags.showStart ||
    !flags.showApps ||
    !flags.showTray ||
    !flags.showClock
  );
}

function flag(value) {
  return value ? "1" : "0";
}

/**
 * The APPLY line for one monitor.
 *
 * The rect travels with every apply rather than being remembered, because the wheel can open on
 * either screen (`radialMonitor: 'cursor'`) and the taskbar that belongs to the gesture is the one
 * on the screen the wheel is dimming — not, in general, the primary.
 */
function taskbarApplyCommand(flags, monitor) {
  const rect = [monitor.x, monitor.y, monitor.width, monitor.height]
    .map((n) => Math.round(Number.isFinite(n) ? n : 0))
    .join(" ");
  return [
    "APPLY",
    rect,
    flag(flags.transparent),
    flag(flags.showStart),
    flag(flags.showApps),
    flag(flags.showTray),
    flag(flags.showClock),
  ].join(" ");
}

module.exports = {
  DEFAULT_TASKBAR_OVERLAY,
  normalizeTaskbarOverlay,
  taskbarOverlayIsActive,
  taskbarApplyCommand,
};
