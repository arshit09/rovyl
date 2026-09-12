/**
 * What "hide the taskbar while the wheel is up" means, as data.
 *
 * It lives away from both the settings panel that edits it and the main process that enacts it,
 * because BOTH need the same answers — whether a given configuration changes anything at all, and
 * exactly what to say to the helper — and a second copy of that reasoning in JavaScript and in
 * PowerShell is how the two drift. See scripts/taskbar-overlay-smoke.mjs.
 */

/**
 * The switches, as stored.
 *
 * `show*` are POSITIVE on purpose: the settings rows read "Start button — shown / hidden", and a
 * row whose label and whose stored boolean disagree is the kind of thing that gets inverted during
 * a refactor and ships as "turning it on hides it".
 */
export interface TaskbarOverlayFlags {
  /** Master switch. Nothing below is read while this is false. */
  enabled: boolean;
  /**
   * Paint the bar's own background through to the desktop, leaving whatever stayed visible on top.
   *
   * Off by default, and it is the one part of this feature that cannot be undone exactly: Windows
   * offers no way to read back the accent explorer had, so what goes back afterwards is an
   * approximation of the stock look. Hiding elements has no such caveat.
   */
  transparent: boolean;
  showStart: boolean;
  showApps: boolean;
  showTray: boolean;
  showClock: boolean;
}

/**
 * Turning the feature on hides everything and leaves the plate alone.
 *
 * That is the least surprising "get out of the way": the bar stops competing with the wheel, and
 * nothing about the desktop's appearance is altered in a way that outlives the gesture.
 */
export const DEFAULT_TASKBAR_OVERLAY: TaskbarOverlayFlags = {
  enabled: false,
  transparent: false,
  showStart: false,
  showApps: false,
  showTray: false,
  showClock: false,
};

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * A stored blob as the shape the rest of the code may assume.
 *
 * Anything missing takes the default rather than `false`, so a config written before a switch
 * existed does not read as "the user turned that off".
 */
export function normalizeTaskbarOverlay(value: unknown): TaskbarOverlayFlags {
  const raw = (value ?? {}) as Partial<TaskbarOverlayFlags>;
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
 * Enabled with every element shown and no transparency is a no-op, and it has to be recognised as
 * one HERE: it is what decides that no helper is started and no command is sent, so leaving the
 * feature on with nothing selected costs exactly what leaving it off costs.
 */
export function taskbarOverlayIsActive(flags: TaskbarOverlayFlags): boolean {
  if (!flags.enabled) return false;
  return (
    flags.transparent ||
    !flags.showStart ||
    !flags.showApps ||
    !flags.showTray ||
    !flags.showClock
  );
}

/** The helper speaks lines of integers; `1` is on. */
function flag(value: boolean): string {
  return value ? '1' : '0';
}

/**
 * The APPLY line for a monitor.
 *
 * The monitor rect travels with every apply rather than being remembered, because the wheel can
 * open on either screen (`radialMonitor: 'cursor'`) and the taskbar that belongs to the gesture is
 * the one on the screen the wheel is dimming — not, in general, the primary.
 */
export function taskbarApplyCommand(
  flags: TaskbarOverlayFlags,
  monitor: { x: number; y: number; width: number; height: number },
): string {
  const rect = [monitor.x, monitor.y, monitor.width, monitor.height]
    .map((n) => Math.round(Number.isFinite(n) ? n : 0))
    .join(' ');
  return [
    'APPLY',
    rect,
    flag(flags.transparent),
    flag(flags.showStart),
    flag(flags.showApps),
    flag(flags.showTray),
    flag(flags.showClock),
  ].join(' ');
}
