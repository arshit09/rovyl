/**
 * The rect the wheel opens at when it reaches the screen edge — `backend/full-bleed-bounds.cjs`.
 *
 * Two properties carry the whole feature, and both are about a bar the wheel is not allowed to sit
 * on: whatever the monitor and wherever its taskbar, the rect must not overlap the strip the shell
 * reserved, and it must not cover the monitor exactly (the shape Explorer reads as a fullscreen app
 * before it takes the taskbar away itself). Everything else here guards the price: the rect stays
 * the screen for all practical purposes, and a display described oddly never squeezes the wheel.
 *
 * Worth a test rather than a glance because both failures are invisible from the code. A rect one
 * DIP too generous looks perfect in review and only misbehaves on a desktop, where the taskbar goes
 * dark under a scrim and nothing in the app says why.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  FULLSCREEN_ESCAPE_DIP,
  fullBleedBounds,
  coversMonitor,
  overlaps,
} = require("../backend/full-bleed-bounds.cjs");

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

/**
 * A monitor with a taskbar on one edge, in DIP — the two rects Electron reports for a display, plus
 * the strip itself so a test can ask whether the wheel landed on it. `strip: 0` is the auto-hiding
 * taskbar and the second screen that has none: work area and bounds are the same rect.
 */
function panel({ x = 0, y = 0, width = 1920, height = 1080, edge = "bottom", strip = 40 } = {}) {
  const bounds = { x, y, width, height };
  const workArea = { ...bounds };
  let taskbar = null;
  if (strip > 0) {
    if (edge === "bottom") {
      workArea.height -= strip;
      taskbar = { x, y: y + height - strip, width, height: strip };
    }
    if (edge === "top") {
      workArea.y += strip;
      workArea.height -= strip;
      taskbar = { x, y, width, height: strip };
    }
    if (edge === "right") {
      workArea.width -= strip;
      taskbar = { x: x + width - strip, y, width: strip, height };
    }
    if (edge === "left") {
      workArea.x += strip;
      workArea.width -= strip;
      taskbar = { x, y, width: strip, height };
    }
  }
  return { bounds, workArea, taskbar };
}

const EDGES = ["bottom", "top", "left", "right"];
const LAYOUTS = [
  { edge: "bottom" },
  { edge: "top" },
  { edge: "left" },
  { edge: "right" },
  // A second monitor, left of and above the primary: negative origins are ordinary on Windows.
  { edge: "bottom", x: -1920, y: -120 },
  // A 1440p panel, and a taskbar made thick by large icons.
  { edge: "bottom", width: 2560, height: 1440, strip: 72 },
];

check("the wheel never lands on the taskbar", () => {
  for (const spec of LAYOUTS) {
    const { bounds, workArea, taskbar } = panel(spec);
    const rect = fullBleedBounds(bounds, workArea);
    assert.equal(overlaps(rect, taskbar), false, `${spec.edge} @ ${bounds.x},${bounds.y}`);
  }
});

check("and takes everything else on the monitor", () => {
  // The other side of the same coin: this rect is what the scrim is painted on, so anything it
  // gives up beyond the reserved strip is a band of undimmed screen at the edge of a dimmed one.
  for (const spec of LAYOUTS) {
    const { bounds, workArea } = panel(spec);
    assert.deepEqual(fullBleedBounds(bounds, workArea), workArea, `${spec.edge}`);
  }
});

check("no monitor is covered exactly, whatever it reserves", () => {
  for (const spec of [...LAYOUTS, { strip: 0 }, { strip: 0, x: 1920, width: 2560, height: 1440 }]) {
    const { bounds, workArea } = panel(spec);
    assert.equal(coversMonitor(fullBleedBounds(bounds, workArea), bounds), false, JSON.stringify(spec));
  }
});

check("a panel that reserves nothing gives up one DIP and no more", () => {
  // An auto-hiding taskbar leaves work area == bounds. There is no bar on screen to dodge, so the
  // rect is the monitor bar the single DIP that keeps Explorer from calling it a fullscreen app.
  const { bounds, workArea } = panel({ strip: 0 });
  for (const wa of [workArea, undefined, null, {}, { x: 0, y: 0, width: NaN, height: 1080 }]) {
    const rect = fullBleedBounds(bounds, wa);
    assert.deepEqual(rect, { x: 0, y: 0, width: 1920, height: 1080 - FULLSCREEN_ESCAPE_DIP });
  }
  assert.equal(FULLSCREEN_ESCAPE_DIP, 1);
});

check("a work area that makes no sense is not trusted", () => {
  // A work area larger than its own monitor, or on another one entirely, would otherwise become a
  // window hanging off the screen — or a sliver of one, which is a wheel opened invisible that takes
  // the mouse anyway: the one outcome worse than a covered taskbar.
  const { bounds } = panel();
  for (const wa of [
    { x: -500, y: -500, width: 4000, height: 3000 },
    { x: 5000, y: 0, width: 1920, height: 1040 },
    { x: 0, y: 0, width: 100, height: 100 },
    { x: 0, y: 0, width: 1920, height: 300 },
  ]) {
    const rect = fullBleedBounds(bounds, wa);
    assert.deepEqual(rect, { x: 0, y: 0, width: 1920, height: 1079 }, JSON.stringify(wa));
  }
});

check("the rect is whole pixels, and a rect at all", () => {
  // `setBounds` takes DIP integers; a fractional display bound (a scaled panel whose DIP size does
  // not divide evenly) must not reach it as a float.
  const rect = fullBleedBounds({ x: 0, y: 0, width: 1536.5, height: 864.5 }, { x: 0, y: 0, width: 1536.5, height: 832.5 });
  for (const key of ["x", "y", "width", "height"]) {
    assert.equal(Number.isInteger(rect[key]), true, `${key} = ${rect[key]}`);
  }
  for (const bad of [undefined, null, {}, { x: 0, y: 0, width: "1920", height: 1080 }]) {
    assert.equal(fullBleedBounds(bad, undefined), null, "a rect that is not one is refused, not guessed");
  }
});

let failed = 0;
for (const { name, fn } of checks) {
  try {
    fn();
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}: ${error.message}`);
  }
}
if (failed) {
  console.error(`full-bleed-bounds-smoke: ${failed} failed`);
  process.exit(1);
}
console.log(`full-bleed-bounds-smoke: OK (${checks.length} checks)`);
