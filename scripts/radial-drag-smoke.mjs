/**
 * Carrying the wheel — `src/utils/radialDrag.ts`.
 *
 * Dragging is two pieces of arithmetic and a great deal of event plumbing. The plumbing is visible
 * the first time it is wrong; the arithmetic is not, because both failures look like "the wheel
 * moved, roughly". So the two numbers are pinned here:
 *
 * 1. The clamp keeps the whole RING on screen, in both axes, from anywhere the hand can point —
 *    including far outside the window, which is where a fast drag genuinely ends up. And it never
 *    inverts: a viewport too small to hold the ring gives the reach up rather than pinning the
 *    wheel into a corner it cannot be dragged out of.
 * 2. The remap is exact. Main grows the overlay in the middle of the gesture, which moves the
 *    window's origin by a few hundred pixels; a remap that is off by one is a wheel that jumps
 *    under the hand at the one moment the user is holding it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "rovyl-radial-drag-"));

/** Monitors the wheel is actually dragged on, plus the box it is born in before main grows it. */
const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 3840, height: 2160 },
  { width: 1366, height: 768 },
  { width: 988, height: 988 },
];

try {
  await build({
    root,
    logLevel: "warn",
    build: {
      ssr: join(root, "src", "utils", "radialDrag.ts"),
      outDir,
      emptyOutDir: true,
      target: "node20",
      minify: false,
      rollupOptions: { output: { format: "es", entryFileNames: "entry.mjs" } },
    },
    ssr: { noExternal: true },
  });

  const { HUB_DRAG_SLOP_PX, clampWheelCenter, remapClientPoint } = await import(
    pathToFileURL(join(outDir, "entry.mjs")).href
  );

  let n = 0;
  const check = (fn) => { fn(); n += 1; };

  /**
   * The slop is what separates a drag from a press on the middle button, which has an action of its
   * own. Zero makes every click a one-pixel drag; anything large is lag on a control pressed all
   * day.
   */
  check(() => {
    assert.ok(
      HUB_DRAG_SLOP_PX > 0 && HUB_DRAG_SLOP_PX <= 8,
      "the drag slop has to separate a drag from a click without delaying the click",
    );
  });

  /** Wherever the hand points, the ring lands on the screen. */
  check(() => {
    for (const viewport of VIEWPORTS) {
      for (const reach of [204, 320, 460]) {
        for (const point of [
          { x: -5000, y: -5000 },
          { x: 5000, y: 5000 },
          { x: 0, y: viewport.height / 2 },
          { x: viewport.width, y: 0 },
          { x: viewport.width / 2, y: viewport.height },
        ]) {
          const centre = clampWheelCenter(point, viewport, reach);
          const margin = Math.min(reach, viewport.width / 2, viewport.height / 2);
          assert.ok(
            centre.x >= Math.min(reach, viewport.width / 2) - 0.5 &&
              centre.x <= viewport.width - Math.min(reach, viewport.width / 2) + 0.5,
            `ring off the left or right edge at ${JSON.stringify({ viewport, reach, point })}`,
          );
          assert.ok(
            centre.y >= Math.min(reach, viewport.height / 2) - 0.5 &&
              centre.y <= viewport.height - Math.min(reach, viewport.height / 2) + 0.5,
            `ring off the top or bottom edge at ${JSON.stringify({ viewport, reach, point })}`,
          );
          assert.ok(margin >= 0, "a negative margin is an inverted clamp");
        }
      }
    }
  });

  /** Inside the allowed area the clamp is the identity — the wheel goes exactly where it is put. */
  check(() => {
    const viewport = { width: 1920, height: 1080 };
    for (const point of [
      { x: 300, y: 300 },
      { x: 960, y: 540 },
      { x: 1600, y: 800 },
    ]) {
      assert.deepEqual(clampWheelCenter(point, viewport, 204), point);
    }
  });

  /**
   * A viewport that cannot hold the ring at all: the wheel goes to the middle of that axis rather
   * than to a corner. `min > max` is the bug where the wheel sticks and will not be dragged back.
   */
  check(() => {
    const centre = clampWheelCenter({ x: 0, y: 0 }, { width: 300, height: 260 }, 400);
    assert.deepEqual(centre, { x: 150, y: 130 });
  });

  /** A point the hand never moved stays where it was on the SCREEN when the window grew under it. */
  check(() => {
    const before = { x: 494, y: 494 };
    const grown = remapClientPoint(before, { x: 466, y: 46 }, { x: 0, y: 0 });
    assert.deepEqual(grown, { x: 960, y: 540 });
    /** Same screen point, both ways round. */
    assert.deepEqual(remapClientPoint(grown, { x: 0, y: 0 }, { x: 466, y: 46 }), before);
  });

  /** An origin main could not report leaves the point alone — better still than moved by a guess. */
  check(() => {
    const point = { x: 120, y: 240 };
    assert.deepEqual(remapClientPoint(point, null, { x: 0, y: 0 }), point);
    assert.deepEqual(remapClientPoint(point, { x: 0, y: 0 }, null), point);
  });

  /** A negative origin is an ordinary second monitor to the left of the primary one. */
  check(() => {
    assert.deepEqual(
      remapClientPoint({ x: 494, y: 494 }, { x: -1454, y: 46 }, { x: -1920, y: 0 }),
      { x: 960, y: 540 },
    );
  });

  console.log(`radial-drag-smoke: OK (${n} assertions)`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
