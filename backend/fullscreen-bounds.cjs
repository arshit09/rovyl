"use strict";

/**
 * The geometry half of game mode's "is the foreground window fullscreen?" question.
 *
 * It lives here because it is the half that can be wrong silently. The window rect arrives from
 * Win32 in PHYSICAL pixels, while Electron reports every display in DIP, and on a display scaled
 * above 100% those are different units for the same screen. Comparing them directly does not fail
 * loudly — it just starts answering "fullscreen" for windows that are merely maximized, and game
 * mode refuses to open the wheel over an ordinary maximized window.
 *
 * Nothing in here touches Electron, so `scripts/fullscreen-bounds-smoke.mjs` can walk a whole
 * matrix of scale factors and monitor layouts that no single development machine has.
 */

/**
 * DIP, not pixels — every comparison below happens after the rect has been converted.
 *
 * Ten was the original tolerance and it stays ten: at 100% the conversion is the identity, so the
 * verdict for every unscaled display is bit-for-bit what it was before the units were fixed.
 */
const FULLSCREEN_SLACK_DIP = 10;

/**
 * Windows never hands out a window smaller than this as a fullscreen surface, and rejecting it
 * early keeps a tooltip or a splash from being measured against a monitor.
 */
const MIN_FULLSCREEN_DIP = { width: 320, height: 240 };

function isFiniteRect(rect) {
  return (
    !!rect &&
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height)
  );
}

/**
 * `screen.getDisplayNearestPoint`, reimplemented so the pick can be tested against layouts this
 * machine does not have: the display containing the point, else the one it is least far from.
 *
 * The point matters as much as the units did. Feeding it a centre computed from physical pixels
 * puts it somewhere off in the coordinate space — on a 4K monitor at 200% the centre of a window
 * filling that monitor lands on the *next* display along — so the comparison that follows is
 * against the wrong monitor's bounds before it has even begun.
 */
function displayNearestPoint(displays, point) {
  if (!Array.isArray(displays) || displays.length === 0) return null;
  for (const display of displays) {
    const b = display && display.bounds;
    if (!isFiniteRect(b)) continue;
    if (point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height) {
      return display;
    }
  }

  let nearest = null;
  let nearestDistance = Infinity;
  for (const display of displays) {
    const b = display && display.bounds;
    if (!isFiniteRect(b)) continue;
    const dx = Math.max(b.x - point.x, 0, point.x - (b.x + b.width));
    const dy = Math.max(b.y - point.y, 0, point.y - (b.y + b.height));
    const distance = dx * dx + dy * dy;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = display;
    }
  }
  return nearest;
}

/**
 * Physical pixels to DIP, for when `screen.screenToDipRect` is not there to do it properly.
 *
 * Electron's converter is the real answer — it is win32-only, but so is every caller — because it
 * knows where each monitor actually sits in physical space. This does not: it assumes a display's
 * physical origin is its DIP origin times its own scale factor, which is exact for a single
 * monitor and for the primary one, and drifts on a multi-monitor layout that mixes scale factors.
 * Good enough as a floor, never the preferred path.
 */
function scaleRectToDip(rect, displays) {
  if (!isFiniteRect(rect)) return null;
  const list = Array.isArray(displays) ? displays.filter((d) => isFiniteRect(d && d.bounds)) : [];
  if (list.length === 0) return { ...rect };

  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  let host = null;
  let hostDistance = Infinity;
  for (const display of list) {
    const scale = Number(display.scaleFactor) > 0 ? Number(display.scaleFactor) : 1;
    const b = display.bounds;
    // The display's guessed physical footprint.
    const px = b.x * scale;
    const py = b.y * scale;
    const dx = Math.max(px - center.x, 0, center.x - (px + b.width * scale));
    const dy = Math.max(py - center.y, 0, center.y - (py + b.height * scale));
    const distance = dx * dx + dy * dy;
    if (distance < hostDistance) {
      hostDistance = distance;
      host = display;
    }
  }

  const scale = Number(host && host.scaleFactor) > 0 ? Number(host.scaleFactor) : 1;
  if (scale === 1) return { ...rect };
  const originX = host.bounds.x * scale;
  const originY = host.bounds.y * scale;
  return {
    x: Math.round(host.bounds.x + (rect.x - originX) / scale),
    y: Math.round(host.bounds.y + (rect.y - originY) / scale),
    width: Math.round(rect.width / scale),
    height: Math.round(rect.height / scale),
  };
}

/**
 * The verdict, given a rect and a display list that are finally in the same units.
 *
 * Two questions, in order. A rect that matches the work area is a maximized window and is let
 * through immediately; anything that reaches all four edges of the monitor is fullscreen. The
 * order is what makes the units load-bearing: with a physical rect the first test can never match
 * a DIP work area, so it was being skipped, and the second then passed on nothing more than a
 * physical width being a larger number than a DIP one.
 *
 * @param {{x:number,y:number,width:number,height:number}} dipRect
 * @param {Array<{bounds:object, workArea:object}>} displays
 */
function isDipRectFullscreen(dipRect, displays, slack = FULLSCREEN_SLACK_DIP) {
  if (!isFiniteRect(dipRect)) return false;
  const { x, y, width, height } = dipRect;
  if (width < MIN_FULLSCREEN_DIP.width || height < MIN_FULLSCREEN_DIP.height) return false;

  const display = displayNearestPoint(displays, {
    x: Math.round(x + width / 2),
    y: Math.round(y + height / 2),
  });
  if (!display) return false;

  const db = display.bounds;
  const wa = isFiniteRect(display.workArea) ? display.workArea : db;
  if (!isFiniteRect(db)) return false;

  const matchesWorkArea =
    Math.abs(x - wa.x) <= slack &&
    Math.abs(y - wa.y) <= slack &&
    Math.abs(width - wa.width) <= slack &&
    Math.abs(height - wa.height) <= slack;
  if (matchesWorkArea) return false;

  return (
    x <= db.x + slack &&
    y <= db.y + slack &&
    x + width >= db.x + db.width - slack &&
    y + height >= db.y + db.height - slack
  );
}

/**
 * The whole decision from a physical rect: convert, then judge.
 *
 * @param {object} rect physical pixels, straight off GetWindowRect
 * @param {Array<object>} displays Electron's display list (DIP bounds + scaleFactor)
 * @param {(rect: object) => object | null} [toDip] `screen.screenToDipRect`, bound by the caller
 */
function isPhysicalRectFullscreen(rect, displays, toDip) {
  if (!isFiniteRect(rect)) return false;
  let dipRect = null;
  if (typeof toDip === "function") {
    try {
      const converted = toDip(rect);
      if (isFiniteRect(converted)) dipRect = converted;
    } catch (_) {
      /* fall through to the arithmetic below */
    }
  }
  if (!dipRect) dipRect = scaleRectToDip(rect, displays);
  return isDipRectFullscreen(dipRect, displays);
}

module.exports = {
  FULLSCREEN_SLACK_DIP,
  MIN_FULLSCREEN_DIP,
  displayNearestPoint,
  scaleRectToDip,
  isDipRectFullscreen,
  isPhysicalRectFullscreen,
};
