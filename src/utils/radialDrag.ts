import type { Coordinates } from '../types';

/**
 * Carrying the wheel by its middle button.
 *
 * Two numbers decide whether a drag feels like moving an object or like fighting one, and both are
 * pure arithmetic — which is why they live here and not inside the component that listens to the
 * mouse. `scripts/radial-drag-smoke.mjs` is what holds them still.
 *
 * This is NOT the old `fixedPosition` coming back. Nothing here is written to disk, and the wheel
 * is born wherever `radialPlacement` says on the next open: a drag moves the wheel that is on
 * screen, for as long as it is on screen, and that is all it does.
 */

/**
 * How far the hand has to travel before a press on the hub stops being a click.
 *
 * Small on purpose. The hub's own action (back, or whatever the centre button is set to) fires on
 * the CLICK, so every pixel of slop is a pixel of lag on a control the user presses constantly —
 * and a genuine drag crosses four pixels in the first frame of the movement.
 */
export const HUB_DRAG_SLOP_PX = 4;

/**
 * Where the wheel's centre may go.
 *
 * The clamp is by the RING — radius plus half a tile — and not by the hub, because a wheel whose
 * far side is off the monitor is a wheel with shortcuts that cannot be aimed at. The user asked to
 * move it, not to lose half of it. The labels, which hang further out still, are allowed to be cut:
 * a clipped label is legible from its icon, a clipped icon is gone.
 *
 * On a viewport too small to hold the ring at all — a wheel with a huge radius on a short screen —
 * the reach is given up rather than inverted, and the centre is pinned to the middle of that axis.
 * An inverted clamp (`min > max`) is the bug that pins the wheel to a corner and will not let go.
 */
export function clampWheelCenter(
  point: Coordinates,
  viewport: { width: number; height: number },
  ringReach: number,
): Coordinates {
  return {
    x: clampAxis(point.x, viewport.width, ringReach),
    y: clampAxis(point.y, viewport.height, ringReach),
  };
}

function clampAxis(value: number, extent: number, reach: number): number {
  if (!Number.isFinite(value)) return Math.round(extent / 2);
  const margin = Math.min(Math.max(reach, 0), extent / 2);
  const min = margin;
  const max = extent - margin;
  if (!(max > min)) return Math.round(extent / 2);
  return Math.round(Math.min(Math.max(value, min), max));
}

/**
 * The same point on the screen, after main has moved this window's top-left corner.
 *
 * A drag that starts inside the compact box makes main grow the overlay to the whole display, and
 * the growth moves the origin — usually up and to the left by a few hundred pixels. Client
 * coordinates are measured from that origin, so the wheel's centre has to be re-expressed or it
 * jumps by exactly the distance the window moved, in the middle of a gesture the hand is still
 * making. Every subsequent `mousemove` already arrives in the new frame and needs nothing.
 */
export function remapClientPoint(
  point: Coordinates,
  fromOrigin: Coordinates | null,
  toOrigin: Coordinates | null,
): Coordinates {
  if (!fromOrigin || !toOrigin) return point;
  return {
    x: Math.round(point.x + (fromOrigin.x - toOrigin.x)),
    y: Math.round(point.y + (fromOrigin.y - toOrigin.y)),
  };
}
