"use strict";

/**
 * The rect the wheel opens at when it has to reach the screen edge: the monitor, less whatever the
 * shell has reserved on it. In practice that means the taskbar stays where it is.
 *
 * The wheel's window is transparent, topmost and takes the foreground, and at anything past a light
 * dim its scrim is a near-opaque sheet. A window like that sitting on the monitor rect does not
 * cover the desktop, it covers the TASKBAR — the bar is topmost too, but the foreground window wins
 * among topmost windows, so it goes dark and stays dark until the wheel comes down. Reported as
 * "opening the wheel hides my taskbar", and the reporter is right.
 *
 * Which is not a dock feature, a dim feature or a corner-gear feature, even though all three ask for
 * this rect (a deep scrim, the settings gear and either screen dock each need the window to reach
 * the edge). It is a property of the rect, so it is fixed once, here, and every switch that asks for
 * a full-bleed wheel gets a wheel that leaves the taskbar alone.
 *
 * Stopping at the work area also means the window never covers its monitor exactly, which is the
 * shape Explorer reads as a fullscreen app (`rc.left <= mon.left && … && rc.bottom >= mon.bottom`,
 * no slack in it) before it puts the shell into fullscreen mode. That was the second way the bar
 * could go missing, and it is closed by the same rect — except on a display that reserves nothing,
 * where one DIP is given up on purpose to keep it closed.
 *
 * Nothing in here touches Electron, so `scripts/full-bleed-bounds-smoke.mjs` can walk monitor
 * layouts (taskbar on each edge, auto-hidden, absent, on a second screen) that no single machine
 * has at once.
 */

/**
 * What to give up when the shell has reserved nothing — an auto-hiding taskbar, or a panel the bar
 * is not on. There is no bar on screen to protect there, so the only job left is failing Explorer's
 * covers-the-monitor test, and that test has no slack to clear: one DIP is enough, and every DIP
 * past it is a visible strip of undimmed screen bought for nothing.
 */
const FULLSCREEN_ESCAPE_DIP = 1;

/**
 * Below this the work area is not a work area — it is a display Windows described oddly, or an
 * appbar that has swallowed the screen. Half the monitor in each axis: a real taskbar takes a tenth
 * of one, so nothing legitimate comes close, and the wheel is never squeezed into a sliver.
 */
const MIN_WORK_AREA_FRACTION = 0.5;

function isFiniteRect(rect) {
  return (
    !!rect &&
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height)
  );
}

function roundRect(rect) {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

/** The monitor with one DIP given up at the bottom — the fallback whenever there is no strip to dodge. */
function monitorLessOneDip(bounds) {
  const rect = roundRect(bounds);
  if (rect.height > FULLSCREEN_ESCAPE_DIP) rect.height -= FULLSCREEN_ESCAPE_DIP;
  return rect;
}

/**
 * The part of the work area that is actually on this monitor.
 *
 * Electron reports both rects per display and they agree, but this is arithmetic on numbers that
 * arrive from the OS: a work area that came back larger than its own monitor, or somewhere else
 * entirely, must not turn into a window hanging off the screen.
 */
function intersect(bounds, workArea) {
  const left = Math.max(bounds.x, workArea.x);
  const top = Math.max(bounds.y, workArea.y);
  const right = Math.min(bounds.x + bounds.width, workArea.x + workArea.width);
  const bottom = Math.min(bounds.y + bounds.height, workArea.y + workArea.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Where the wheel opens when it reaches the edge.
 *
 * @param {{x:number,y:number,width:number,height:number}} bounds the display's bounds, in DIP
 * @param {{x:number,y:number,width:number,height:number}} [workArea] the same display's work area
 * @returns {{x:number,y:number,width:number,height:number} | null} null only for a bounds rect that
 *   is not a rect, which the caller answers with its own geometry rather than a guess
 */
function fullBleedBounds(bounds, workArea) {
  if (!isFiniteRect(bounds)) return null;
  const monitor = roundRect(bounds);
  if (monitor.width <= 0 || monitor.height <= 0) return monitor;
  if (!isFiniteRect(workArea)) return monitorLessOneDip(monitor);

  const usable = roundRect(intersect(monitor, workArea));
  if (
    usable.width < monitor.width * MIN_WORK_AREA_FRACTION ||
    usable.height < monitor.height * MIN_WORK_AREA_FRACTION
  ) {
    return monitorLessOneDip(monitor);
  }

  /** Nothing reserved: the work area IS the monitor, and the one DIP is what keeps it from being read as fullscreen. */
  if (
    usable.x === monitor.x &&
    usable.y === monitor.y &&
    usable.width === monitor.width &&
    usable.height === monitor.height
  ) {
    return monitorLessOneDip(monitor);
  }

  return usable;
}

/**
 * Explorer's own question, so the smoke test can ask it of the rect above instead of restating the
 * rule in its assertions — a rule restated is a rule that can drift.
 */
function coversMonitor(rect, monitor) {
  if (!isFiniteRect(rect) || !isFiniteRect(monitor)) return false;
  return (
    rect.x <= monitor.x &&
    rect.y <= monitor.y &&
    rect.x + rect.width >= monitor.x + monitor.width &&
    rect.y + rect.height >= monitor.y + monitor.height
  );
}

/** Does this rect cover any of that one? The smoke test's way of asking "is the taskbar under it?" */
function overlaps(rect, other) {
  if (!isFiniteRect(rect) || !isFiniteRect(other)) return false;
  const hit = intersect(rect, other);
  return hit.width > 0 && hit.height > 0;
}

module.exports = {
  FULLSCREEN_ESCAPE_DIP,
  MIN_WORK_AREA_FRACTION,
  fullBleedBounds,
  coversMonitor,
  overlaps,
};
