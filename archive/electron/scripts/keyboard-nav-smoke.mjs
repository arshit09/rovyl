import assert from "node:assert/strict";

function resolveNearestSliceForDirection(count, targetAngleDeg) {
  let bestIndex = 0;
  let minDiff = 360;
  for (let i = 0; i < count; i++) {
    const sliceAngleDeg = (i * (360 / count) - 90 + 360) % 360;
    const diff = Math.abs(((sliceAngleDeg - targetAngleDeg + 180) % 360) - 180);
    if (diff < minDiff) {
      minDiff = diff;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function clampRadialCenter(targetDisplay, cursorPoint, viewportSize) {
  const margin = Math.min(180, Math.floor(viewportSize / 4));
  return {
    x: Math.round(Math.max(targetDisplay.bounds.x + margin, Math.min(cursorPoint.x, targetDisplay.bounds.x + targetDisplay.bounds.width - margin))),
    y: Math.round(Math.max(targetDisplay.bounds.y + margin, Math.min(cursorPoint.y, targetDisplay.bounds.y + targetDisplay.bounds.height - margin))),
  };
}

assert.equal(resolveNearestSliceForDirection(8, 270), 0, "ArrowUp on 8 items resolves to North (0)");
assert.equal(resolveNearestSliceForDirection(8, 0), 2, "ArrowRight on 8 items resolves to East (2)");
assert.equal(resolveNearestSliceForDirection(8, 90), 4, "ArrowDown on 8 items resolves to South (4)");
assert.equal(resolveNearestSliceForDirection(8, 180), 6, "ArrowLeft on 8 items resolves to West (6)");

assert.equal(resolveNearestSliceForDirection(4, 270), 0, "ArrowUp on 4 items resolves to North (0)");
assert.equal(resolveNearestSliceForDirection(4, 0), 1, "ArrowRight on 4 items resolves to East (1)");
assert.equal(resolveNearestSliceForDirection(4, 90), 2, "ArrowDown on 4 items resolves to South (2)");
assert.equal(resolveNearestSliceForDirection(4, 180), 3, "ArrowLeft on 4 items resolves to West (3)");

const secondaryDisplay = {
  bounds: { x: 1920, y: 0, width: 1920, height: 1080 }
};

const clamped = clampRadialCenter(secondaryDisplay, { x: 3830, y: 10 }, 800);
assert.ok(clamped.x <= secondaryDisplay.bounds.x + secondaryDisplay.bounds.width - 180, "clamped inside right boundary");
assert.ok(clamped.x >= secondaryDisplay.bounds.x + 180, "clamped inside left boundary");
assert.ok(clamped.y >= secondaryDisplay.bounds.y + 180, "clamped inside top boundary");

console.log("keyboard-nav-smoke: OK (11 assertions passed)");
