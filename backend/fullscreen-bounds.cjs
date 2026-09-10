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
 * The other silent trap is that a maximized window's rect is not the work area: Windows fits its
 * *visible* area there and lets the invisible resize border hang off all four edges. What separates
 * maximized from fullscreen is that overhang, not size — see `isMaximizedOnWorkArea`.
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
 * How far a maximized window's rect hangs off each edge of the work area.
 *
 * Windows maximizes a window by fitting its *visible* area to the work area, so the rect itself
 * comes out one invisible resize border larger on every side — SM_CXSIZEFRAME + SM_CXPADDEDBORDER,
 * 8 DIP on the default Windows 10/11 themes, and 8 in DIP at every scale factor because both
 * metrics scale with the DPI. Twelve rather than eight leaves room for a rounded conversion and for
 * a theme that pads its borders differently, while staying far below the thinnest taskbar anyone
 * docks, so this tolerance can never be mistaken for a reserved strip.
 *
 * Deliberately not folded into FULLSCREEN_SLACK_DIP: widening the global slack to 16 would also
 * widen how far short of the monitor a window may fall and still count as covering it, which is the
 * one direction that must stay tight — that test is what catches real fullscreen.
 */
const MAX_FRAME_OVERHANG_DIP = 12;

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
 * How far a rect extends past each edge of a work area: `[left, top, right, bottom]`, positive
 * outwards. A rect sitting entirely inside the work area answers with four negative numbers.
 */
function workAreaOverhang(rect, wa) {
  return [
    wa.x - rect.x,
    wa.y - rect.y,
    rect.x + rect.width - (wa.x + wa.width),
    rect.y + rect.height - (wa.y + wa.height),
  ];
}

/**
 * Is this a maximized window rather than a fullscreen one?
 *
 * The honest signal is the invisible resize border. A maximized window hangs off all four edges of
 * the work area by it; a fullscreen window is flush with the *monitor*, so measured against the work
 * area at least one of its edges sits exactly on the boundary — and the edge a taskbar is docked on
 * overhangs by the whole reserved strip, far more than a border. "Covers the work area and overhangs
 * every edge of it, by no more than a frame" is therefore a shape only maximizing produces.
 *
 * That test is what the flush comparison below cannot do alone. On a panel that reserves a taskbar
 * the flush test misses every real maximized window — the rect is ~16 DIP larger than the work area
 * in each axis, wider than any sane slack — and the reserved strip quietly covers for it, because
 * the fullscreen test behind it fails anyway: the rect does not reach the edge the taskbar sits on.
 * On a panel that reserves nothing there is no strip to cover for it, and both halves of the verdict
 * came out wrong — a maximized window read as fullscreen, and a real fullscreen game read as
 * maximized, since with workArea == bounds a flush fullscreen rect matches the work area exactly.
 *
 * Hence the flush test now only speaks when the work area is genuinely inset from the monitor. A
 * window maximized *without* a resize frame is flush with the work area, and on a taskbar-less panel
 * that rect is indistinguishable from a borderless-fullscreen one — same origin, same size, no
 * geometry left to tell them apart. Such a tie is called fullscreen, because interrupting a game is
 * the costlier of the two mistakes.
 */
function isMaximizedOnWorkArea(rect, wa, db, slack) {
  const overhang = workAreaOverhang(rect, wa);
  if (overhang.every((gap) => gap > 0 && gap <= MAX_FRAME_OVERHANG_DIP)) return true;

  const reservesStrip =
    Math.abs(wa.width - db.width) > slack || Math.abs(wa.height - db.height) > slack;
  if (!reservesStrip) return false;

  return (
    Math.abs(rect.x - wa.x) <= slack &&
    Math.abs(rect.y - wa.y) <= slack &&
    Math.abs(rect.width - wa.width) <= slack &&
    Math.abs(rect.height - wa.height) <= slack
  );
}

/**
 * The verdict, given a rect and a display list that are finally in the same units.
 *
 * Two questions, in order. A rect shaped like a maximized window is let through immediately;
 * anything else that reaches all four edges of the monitor is fullscreen. The order is what makes
 * the units load-bearing: with a physical rect neither shape can be recognized against a DIP work
 * area, so the first test was being skipped, and the second then passed on nothing more than a
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
  if (!isFiniteRect(db)) return false;
  const wa = isFiniteRect(display.workArea) ? display.workArea : db;

  if (isMaximizedOnWorkArea(dipRect, wa, db, slack)) return false;

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
  MAX_FRAME_OVERHANG_DIP,
  MIN_FULLSCREEN_DIP,
  displayNearestPoint,
  scaleRectToDip,
  workAreaOverhang,
  isMaximizedOnWorkArea,
  isDipRectFullscreen,
  isPhysicalRectFullscreen,
};
