import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  displayNearestPoint,
  scaleRectToDip,
  isDipRectFullscreen,
  isPhysicalRectFullscreen,
} = require("../backend/fullscreen-bounds.cjs");

/**
 * A synthetic monitor layout, in both units at once.
 *
 * Every spec is a real panel — physical size, the scale the user picked, the taskbar height
 * Windows reserves on it — laid out left to right from an explicit physical origin. From that we
 * can build both the display list Electron would report (DIP) and a stand-in for
 * `screen.screenToDipRect`, which is the only way to exercise 125%, 150% and a mixed-scale
 * multi-monitor desktop from a development machine that has two 1080p panels at 100%.
 */
function layout(specs) {
  let dipCursor = null;
  const displays = specs.map((spec, index) => {
    const { physW, physH, scale, taskbarDip = 40, physX = 0, physY = 0 } = spec;
    const dipW = Math.round(physW / scale);
    const dipH = Math.round(physH / scale);
    // Windows keeps the DIP layout connected; mirror the physical ordering.
    const dipX = dipCursor === null ? Math.round(physX / scale) : dipCursor;
    dipCursor = dipX + dipW;
    const dipY = Math.round(physY / scale);
    return {
      id: index + 1,
      label: spec.label || `#${index + 1}`,
      scaleFactor: scale,
      bounds: { x: dipX, y: dipY, width: dipW, height: dipH },
      workArea: { x: dipX, y: dipY, width: dipW, height: dipH - taskbarDip },
      phys: { x: physX, y: physY, width: physW, height: physH, taskbarDip },
    };
  });

  /** `screen.screenToDipRect(null, rect)`: scaled relative to the display nearest the rect. */
  const toDip = (rect) => {
    const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    let host = displays[0];
    let best = Infinity;
    for (const d of displays) {
      const p = d.phys;
      const dx = Math.max(p.x - center.x, 0, center.x - (p.x + p.width));
      const dy = Math.max(p.y - center.y, 0, center.y - (p.y + p.height));
      const distance = dx * dx + dy * dy;
      if (distance < best) {
        best = distance;
        host = d;
      }
    }
    const s = host.scaleFactor;
    return {
      x: Math.round(host.bounds.x + (rect.x - host.phys.x) / s),
      y: Math.round(host.bounds.y + (rect.y - host.phys.y) / s),
      width: Math.round(rect.width / s),
      height: Math.round(rect.height / s),
    };
  };

  return { displays, toDip };
}

/** The invisible resize border a maximized window overhangs the work area by, per side. */
const BORDER_DIP = 8;

/** A maximized ordinary window, in physical pixels, on the given display. */
function maximizedPhys(display) {
  const scale = display.scaleFactor;
  const overhang = Math.round(BORDER_DIP * scale);
  return {
    x: display.phys.x - overhang,
    y: display.phys.y - overhang,
    width: display.phys.width + 2 * overhang,
    height: display.phys.height - Math.round(display.phys.taskbarDip * scale) + 2 * overhang,
  };
}

/** A window filling the whole panel — a true-fullscreen game and a borderless one look identical. */
function fullscreenPhys(display) {
  const { x, y, width, height } = display.phys;
  return { x, y, width, height };
}

const checks = [];
const check = (name, run) => checks.push([name, run]);

// ---------------------------------------------------------------------------
// The matrix: one panel, every scale factor people actually run.
// ---------------------------------------------------------------------------
for (const scale of [1, 1.25, 1.5, 1.75, 2]) {
  const pct = `${scale * 100}%`;
  const { displays, toDip } = layout([{ physW: 1920, physH: 1080, scale }]);
  const [panel] = displays;

  check(`maximized ordinary window is not fullscreen @ ${pct}`, () => {
    // The bug this module exists for. Before the units were fixed, a physical rect could never
    // match a DIP work area, so the maximized early-return was skipped — and coversFullDisplay
    // then passed on nothing but a physical width being a bigger number than a DIP one.
    assert.equal(isPhysicalRectFullscreen(maximizedPhys(panel), displays, toDip), false);
  });

  check(`true fullscreen is fullscreen @ ${pct}`, () => {
    assert.equal(isPhysicalRectFullscreen(fullscreenPhys(panel), displays, toDip), true);
  });

  check(`borderless fullscreen is fullscreen @ ${pct}`, () => {
    // Borderless covers the panel exactly like the exclusive-mode one; no geometry separates them,
    // and game mode wants to block both.
    const borderless = { x: 0, y: 0, width: 1920, height: 1080 };
    assert.equal(isPhysicalRectFullscreen(borderless, displays, toDip), true);
  });

  check(`a half-screen window is not fullscreen @ ${pct}`, () => {
    const half = { x: 0, y: 0, width: 960, height: 1080 };
    assert.equal(isPhysicalRectFullscreen(half, displays, toDip), false);
  });
}

check("4K at 200%: maximized is not fullscreen, fullscreen is", () => {
  const { displays, toDip } = layout([{ physW: 3840, physH: 2160, scale: 2 }]);
  assert.equal(isPhysicalRectFullscreen(maximizedPhys(displays[0]), displays, toDip), false);
  assert.equal(isPhysicalRectFullscreen(fullscreenPhys(displays[0]), displays, toDip), true);
});

// ---------------------------------------------------------------------------
// Multi-monitor, mixed scale factors — where the display lookup itself went wrong.
// ---------------------------------------------------------------------------
check("a window on a 200% primary is measured against that primary, not its neighbour", () => {
  // A 4K primary at 200% is 1920 DIP wide, so the DIP origin of the 1080p panel beside it is 1920
  // — which is exactly the physical centre of a window filling the primary. Feeding that physical
  // centre to getDisplayNearestPoint picks the *secondary*, and the comparison is against the
  // wrong monitor before it has begun.
  const { displays, toDip } = layout([
    { physW: 3840, physH: 2160, scale: 2, label: "4K@200%" },
    { physW: 1920, physH: 1080, scale: 1, physX: 3840, label: "1080p@100%" },
  ]);
  const [primary, secondary] = displays;

  assert.equal(displayNearestPoint(displays, { x: 1920, y: 1060 }).label, "1080p@100%");
  assert.equal(displayNearestPoint(displays, { x: 960, y: 530 }).label, "4K@200%");

  assert.equal(isPhysicalRectFullscreen(maximizedPhys(primary), displays, toDip), false);
  assert.equal(isPhysicalRectFullscreen(fullscreenPhys(primary), displays, toDip), true);
  assert.equal(isPhysicalRectFullscreen(maximizedPhys(secondary), displays, toDip), false);
  assert.equal(isPhysicalRectFullscreen(fullscreenPhys(secondary), displays, toDip), true);
});

check("a 150% panel to the left of the primary, at negative coordinates", () => {
  const { displays, toDip } = layout([
    { physW: 1920, physH: 1080, scale: 1.5, physX: -1920, label: "left@150%" },
    { physW: 1920, physH: 1080, scale: 1, physX: 0, label: "primary@100%" },
  ]);
  for (const display of displays) {
    assert.equal(isPhysicalRectFullscreen(maximizedPhys(display), displays, toDip), false, display.label);
    assert.equal(isPhysicalRectFullscreen(fullscreenPhys(display), displays, toDip), true, display.label);
  }
});

check("three panels at three different scale factors", () => {
  const { displays, toDip } = layout([
    { physW: 1920, physH: 1080, scale: 1, physX: 0, label: "a@100%" },
    { physW: 2560, physH: 1440, scale: 1.25, physX: 1920, label: "b@125%" },
    { physW: 3840, physH: 2160, scale: 1.5, physX: 4480, label: "c@150%" },
  ]);
  for (const display of displays) {
    assert.equal(isPhysicalRectFullscreen(maximizedPhys(display), displays, toDip), false, display.label);
    assert.equal(isPhysicalRectFullscreen(fullscreenPhys(display), displays, toDip), true, display.label);
  }
});

// ---------------------------------------------------------------------------
// What used to happen, pinned so the regression cannot come back quietly.
// ---------------------------------------------------------------------------
check("comparing a physical rect against DIP displays is what over-blocked", () => {
  const { displays } = layout([{ physW: 1920, physH: 1080, scale: 1.5 }]);
  const maximized = maximizedPhys(displays[0]);
  // Straight in, unconverted — the old code path. A merely maximized window reads as fullscreen.
  assert.equal(isDipRectFullscreen(maximized, displays), true);
  // Converted first, it does not.
  assert.equal(isDipRectFullscreen(scaleRectToDip(maximized, displays), displays), false);
});

check("at 100% the conversion is the identity, so unscaled displays are unaffected", () => {
  const { displays, toDip } = layout([{ physW: 1920, physH: 1080, scale: 1 }]);
  // Straight off this development host: maximized Chrome on a 1080p panel at 100%.
  const chromeMaximized = { x: -8, y: -8, width: 1936, height: 1056 };
  assert.deepEqual(toDip(chromeMaximized), chromeMaximized);
  assert.deepEqual(scaleRectToDip(chromeMaximized, displays), chromeMaximized);
  assert.equal(isPhysicalRectFullscreen(chromeMaximized, displays, toDip), false);
});

// ---------------------------------------------------------------------------
// The arithmetic fallback, for when screenToDipRect is not available.
// ---------------------------------------------------------------------------
check("the fallback divides by the scale factor when there is no converter", () => {
  for (const scale of [1, 1.25, 1.5, 2]) {
    const { displays } = layout([{ physW: 1920, physH: 1080, scale }]);
    const panel = displays[0];
    assert.equal(isPhysicalRectFullscreen(maximizedPhys(panel), displays, undefined), false, `max ${scale}`);
    assert.equal(isPhysicalRectFullscreen(fullscreenPhys(panel), displays, undefined), true, `fs ${scale}`);
  }
});

check("a converter that throws or answers nonsense falls back instead of blocking", () => {
  const { displays } = layout([{ physW: 1920, physH: 1080, scale: 1.5 }]);
  const panel = displays[0];
  const throwing = () => {
    throw new Error("no screenToDipRect on this platform");
  };
  assert.equal(isPhysicalRectFullscreen(maximizedPhys(panel), displays, throwing), false);
  assert.equal(isPhysicalRectFullscreen(fullscreenPhys(panel), displays, throwing), true);
  assert.equal(isPhysicalRectFullscreen(fullscreenPhys(panel), displays, () => null), true);
  assert.equal(isPhysicalRectFullscreen(fullscreenPhys(panel), displays, () => ({ x: 0 })), true);
});

// ---------------------------------------------------------------------------
// Degenerate input fails open: no verdict must never mean "block the wheel".
// ---------------------------------------------------------------------------
check("nothing to measure means not fullscreen", () => {
  const { displays, toDip } = layout([{ physW: 1920, physH: 1080, scale: 1 }]);
  for (const rect of [null, undefined, {}, { x: 0, y: 0, width: NaN, height: 100 }]) {
    assert.equal(isPhysicalRectFullscreen(rect, displays, toDip), false, JSON.stringify(rect));
  }
  assert.equal(isPhysicalRectFullscreen({ x: 0, y: 0, width: 1920, height: 1080 }, [], undefined), false);
  assert.equal(displayNearestPoint([], { x: 0, y: 0 }), null);
});

check("a display with no workArea is measured against its bounds", () => {
  const bare = [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }];
  assert.equal(isDipRectFullscreen({ x: 0, y: 0, width: 1920, height: 1080 }, bare), false);
  assert.equal(isDipRectFullscreen({ x: 0, y: 0, width: 900, height: 500 }, bare), false);
});

// ---------------------------------------------------------------------------
// A known limitation, recorded rather than fixed: unrelated to DPI, present at every scale.
// ---------------------------------------------------------------------------
check("KNOWN: on a panel with no reserved taskbar, maximized still reads as fullscreen", () => {
  // With workArea == bounds there is no uncovered strip left to tell the two apart, and the
  // maximized early-return misses because the invisible resize border makes the rect 16 DIP wider
  // than the work area while the slack is 10. Identical verdict at 100% and at 150%, so this is
  // not the DPI bug — it is the slack being narrower than the frame overhang.
  for (const scale of [1, 1.5]) {
    const { displays, toDip } = layout([{ physW: 1920, physH: 1080, scale, taskbarDip: 0 }]);
    assert.equal(isPhysicalRectFullscreen(maximizedPhys(displays[0]), displays, toDip), true, `${scale}`);
  }
});

let failed = 0;
for (const [name, run] of checks) {
  try {
    run();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}: ${error.message}`);
  }
}
if (failed) {
  console.error(`fullscreen-bounds-smoke: ${failed} failed`);
  process.exit(1);
}
console.log(`fullscreen-bounds-smoke: OK (${checks.length} checks)`);
