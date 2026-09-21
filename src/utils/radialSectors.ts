/**
 * The wheel's plane, cut into equal shares — the geometry BOTH the aim and the drawing read.
 *
 * It lives away from `RadialMenu` for the reason `radialScrim.ts` does: the wheel must never hold
 * two opinions about where a target is. The index the pointer resolves to and the wedge painted
 * under it are the same arithmetic here, so "it lit one thing and opened another" is not a defect
 * this code can have — and the arithmetic can be proved without mounting React
 * (see scripts/radial-sectors-smoke.mjs).
 *
 * Conventions, once, for everything below:
 *  - Degrees, screen coordinates: x right, y DOWN. Increasing degrees therefore run clockwise,
 *    which is also SVG's positive sweep — hence the `1` on the outer arc.
 *  - Item `i` is centred on `i * (360 / count) - 90`, so item 0 sits at twelve o'clock.
 */

/** Half-open [start, end) in degrees: the share of the plane item `index` owns. */
export function sectorBoundsDeg(index: number, count: number): { startDeg: number; endDeg: number } {
  const sliceAngle = 360 / count;
  const centreDeg = index * sliceAngle - 90;
  return { startDeg: centreDeg - sliceAngle / 2, endDeg: centreDeg + sliceAngle / 2 };
}

/** The direction item `index` is aimed at — the bisector its highlight runs along. */
export function sectorCentreDeg(index: number, count: number): number {
  return index * (360 / count) - 90;
}

/**
 * Which item a displacement from the centre points at. `count` must be > 0.
 *
 * This is the wheel's targeting, full stop — direction and area both call it, and pointer mode
 * calls it too, for the candidate it then distance-tests against the icon.
 */
export function sectorIndexForDelta(deltaX: number, deltaY: number, count: number): number | null {
  if (count <= 0) return null;
  const sliceAngle = 360 / count;
  let angle = Math.atan2(deltaY, deltaX) * (180 / Math.PI) + 90;
  if (angle < 0) angle += 360;
  const index = Math.floor(((angle + sliceAngle / 2) % 360) / sliceAngle);
  return index >= 0 && index < count ? index : null;
}

/**
 * One wedge, as an SVG path, in a box of side `radiusOuter * 2` whose centre is the wheel's.
 *
 * A single item owns the whole plane, and an arc whose two ends coincide draws nothing at all —
 * SVG collapses it. That ring is stitched from two halves so the one-item wheel still gets an area.
 */
export function annularSectorPath(
  radiusInner: number,
  radiusOuter: number,
  startDeg: number,
  endDeg: number,
): string {
  const point = (deg: number, radius: number) => {
    const rad = deg * (Math.PI / 180);
    return `${(radiusOuter + radius * Math.cos(rad)).toFixed(2)} ${(radiusOuter + radius * Math.sin(rad)).toFixed(2)}`;
  };

  if (endDeg - startDeg >= 359.999) {
    return [
      `M ${point(0, radiusOuter)}`,
      `A ${radiusOuter} ${radiusOuter} 0 1 1 ${point(180, radiusOuter)}`,
      `A ${radiusOuter} ${radiusOuter} 0 1 1 ${point(360, radiusOuter)}`,
      `M ${point(0, radiusInner)}`,
      `A ${radiusInner} ${radiusInner} 0 1 0 ${point(180, radiusInner)}`,
      `A ${radiusInner} ${radiusInner} 0 1 0 ${point(360, radiusInner)}`,
      'Z',
    ].join(' ');
  }

  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  return [
    `M ${point(startDeg, radiusInner)}`,
    `L ${point(startDeg, radiusOuter)}`,
    `A ${radiusOuter} ${radiusOuter} 0 ${largeArc} 1 ${point(endDeg, radiusOuter)}`,
    `L ${point(endDeg, radiusInner)}`,
    `A ${radiusInner} ${radiusInner} 0 ${largeArc} 0 ${point(startDeg, radiusInner)}`,
    'Z',
  ].join(' ');
}

/** A point on the wheel's plane, for the seams drawn between wedges. */
export function polarPoint(
  centre: number,
  radius: number,
  deg: number,
): { x: number; y: number } {
  const rad = deg * (Math.PI / 180);
  return { x: centre + radius * Math.cos(rad), y: centre + radius * Math.sin(rad) };
}

/**
 * Where the fade samples sit, as a fraction of the way from the plateau's end to the rim.
 *
 * Seventeen, not two, and for the reason `radialScrimGradient` gives about its own nine: a long
 * band between two stops is interpolated in 8-bit, and the steps that produces read as banding —
 * concentric rings in something that is supposed to be a dissolve. The wedge fades over hundreds
 * of pixels, several times the scrim's span, so it is sampled several times as densely.
 */
const FALLOFF_SAMPLES = [
  0, 0.06, 0.12, 0.19, 0.25, 0.32, 0.38, 0.44, 0.5, 0.56, 0.62, 0.69, 0.75, 0.82, 0.88, 0.94, 1,
];

/** Where the hold ends and the dissolve begins. Everything that fades has to agree on it. */
export function sectorPlateauStop(innerStop: number, falloffStop: number): number {
  return Math.min(0.98, Math.max(innerStop + 0.01, falloffStop));
}

/**
 * The stops of one wedge gradient: hold, then dissolve.
 *
 * Two regions. From the dead zone out to `falloffStop` the wedge holds near full strength, ramping
 * gently from `nearAlpha` to `farAlpha` — that is the part with the icon in it, and it has to read
 * as a lit SECTION. Past it the alpha falls as `(1 - t)²` all the way to the rim.
 *
 * The square matters twice. Its slope is zero at the end, so the wedge arrives at nothing instead
 * of stopping at something — there is no radius at which a boundary appears. And it is steep at
 * the START, which is what keeps the highlight attached to its icon: a wedge widens as it goes out,
 * so a constant alpha puts most of the lit AREA far from the target and the eye reads the glow as
 * a separate object floating off in that direction.
 */
export function sectorGradientStops(
  innerStop: number,
  falloffStop: number,
  nearAlpha: number,
  farAlpha: number,
): { offset: number; opacity: number }[] {
  const plateau = sectorPlateauStop(innerStop, falloffStop);
  return [
    { offset: innerStop, opacity: nearAlpha },
    ...FALLOFF_SAMPLES.map((t) => ({
      offset: plateau + t * (1 - plateau),
      opacity: farAlpha * (1 - t) * (1 - t),
    })),
  ];
}

/**
 * The wedge's light, as two things multiplied — which is the only way it can be both.
 *
 * A wedge has to say a DIRECTION, and it has to arrive at nothing on a circle: the rim is where
 * the window cuts, and alpha still standing there is drawn as a hard edge across the desktop. One
 * gradient cannot do both. A gradient running straight out along the wedge holds its value on
 * lines ACROSS that direction, and such a line meets the rim — so its fade would have to be over
 * by the time it reached the wedge's far corners, which on a wide wedge is barely half way out.
 * That is the three-item wheel: a short bright triangle near the hub, cut off by a straight chord,
 * with the two lit sides carrying on past it to the rim on their own. It reads as an outline that
 * lost its fill, because that is what it is.
 *
 * So the fade is split in two and multiplied by a mask:
 *  - The BEAM is the straight one, per wedge, along its bisector. It carries the colour, and it
 *    falls on the same square as ever but lands on `lean` instead of on nothing.
 *  - The REACH is the ring, drawn once for the whole plane. It is whatever is left over — the
 *    quotient that makes the product come out at exactly `(1 - t)²` — and since it depends on
 *    nothing but the distance from the hub, it is zero on the entire rim in every direction.
 *
 * The point of splitting it that way: ALONG the bisector the wedge is painted exactly as it was
 * before any of this, the calibrated fade unchanged. The direction is bought entirely off-axis,
 * where a straight gradient leaves the sides of a wedge a little ahead of its middle.
 */
function beamCurve(t: number, lean: number): number {
  return lean + (1 - lean) * (1 - t) * (1 - t);
}

/**
 * How much of the run a full lean wants after the hold has ended.
 *
 * A lean is a slope, and a slope needs distance. Where the hold reaches almost to the rim — a dead
 * zone squeezed against a window edge — what is left is a sliver, and the same drop crammed into
 * it stops being a direction and becomes a step at one radius, with the wedge's own sides landing
 * on the near side of that step and reading as a bulge. Below this much room the lean is taken in
 * proportion to what there is.
 */
const SECTOR_BEAM_RUN = 0.5;

function leanWithRoom(lean: number, plateau: number): number {
  return 1 - (1 - lean) * Math.min(1, (1 - plateau) / SECTOR_BEAM_RUN);
}

/**
 * How much of its own strength the beam still has at the rim: the sine of the wedge's half-slice.
 *
 * A straight gradient holds its value across the beam, so at any distance from the hub the parts
 * of a wedge off to the sides are always a little ahead of the part on the axis — nearer the start
 * of the run, and therefore brighter. That is what makes the light read as going somewhere. Past a
 * point it instead reads as the highlight spilling sideways out of the slice it belongs to, and
 * the point is decided by one thing: how far off-axis the wedge's own sides are.
 *
 * Which is what the sine is. It is small on a crowded wheel, where the sides are nearly parallel
 * to the beam and almost the whole fade can be spent on the lean; it is most of the way to 1 on a
 * three-item wheel, where they are 60° out and there is almost nothing to spend. Across every size
 * of wheel it holds the sides to within about a fifth of the axis at the same radius — a beam,
 * rather than a bulge.
 *
 * One and two items get no lean at all, which is correct rather than a special case: a half-plane
 * has no direction a straight gradient can point in that its own flat side does not lie across.
 * `Math.max(count, 2)` is what folds the single-item wheel — a reflex wedge, with no axis to lean
 * along — in with the two-item one.
 */
export function sectorBeamLean(count: number): number {
  return Math.sin(Math.PI / Math.max(count, 2));
}

/**
 * The beam's own ramp: the hold, then the square landing on `lean` rather than on nothing.
 *
 * It starts at the centre rather than at the dead zone, and that is not laziness about a region
 * nothing is drawn in. The wedge's inner CORNERS are foreshortened onto this axis like everything
 * else — they sit at `innerStop · cos(half slice)` along it — so a first stop at `innerStop` would
 * leave them in front of it, on a flat strip of the near alpha instead of on the ramp.
 */
export function sectorBeamStops(
  innerStop: number,
  falloffStop: number,
  nearAlpha: number,
  farAlpha: number,
  lean: number,
): { offset: number; opacity: number }[] {
  const plateau = sectorPlateauStop(innerStop, falloffStop);
  const reached = leanWithRoom(lean, plateau);
  return [
    { offset: 0, opacity: nearAlpha },
    ...FALLOFF_SAMPLES.map((t) => ({
      offset: plateau + t * (1 - plateau),
      opacity: farAlpha * beamCurve(t, reached),
    })),
  ];
}

/**
 * The reach: what the beam did not do, so that the two together come out at `(1 - t)²`.
 *
 * White, and used as a mask rather than as paint — it is a factor, not a colour. It holds at 1
 * through the section with the icons in it and is zero at the rim, which is the whole of what the
 * wedges need from it: whatever the beam is still holding out there, this takes to nothing, in
 * every direction at once and therefore on the window's edge wherever that edge happens to be.
 */
export function sectorReachStops(
  innerStop: number,
  falloffStop: number,
  lean: number,
): { offset: number; opacity: number }[] {
  const plateau = sectorPlateauStop(innerStop, falloffStop);
  const reached = leanWithRoom(lean, plateau);
  return [
    { offset: innerStop, opacity: 1 },
    ...FALLOFF_SAMPLES.map((t) => ({
      offset: plateau + t * (1 - plateau),
      opacity: ((1 - t) * (1 - t)) / beamCurve(t, reached),
    })),
  ];
}

/**
 * The wheel these alphas were calibrated on, in items.
 *
 * What the eye weighs is not the alpha, it is the LIGHT — and a wedge's share of the plane is
 * `1 / count`, so the same alpha on a three-item wheel puts nearly three times as much of it on
 * the desktop. At that width the highlight stops reading as a lit section and becomes a wash with
 * two hard rails on it, which is the whole of what a three-item wheel looks wrong for.
 */
const SECTOR_ALPHA_COUNT = 8;

/**
 * The same light, spread over however much plane this wheel gives a wedge.
 *
 * The square root rather than the share itself: matching the area exactly would take a three-item
 * wedge down to a third and leave nothing to see, and the eye does not add brightness over an area
 * linearly anyway. Halfway between "the same alpha" and "the same total light" is where a wide
 * wedge stops shouting without going quiet. Never above 1 — past eight items the wedges are narrow
 * and the numbers below are already what they were tuned to be.
 */
export function sectorBeamAlphas(
  alphas: readonly [number, number],
  count: number,
): [number, number] {
  /**
   * One item is tempered as two: its ring is bent towards the icon by `sectorSoloFadeMask`, which
   * leaves it lighting roughly half the plane — a two-item wedge's share, not the whole of it.
   */
  const temper = Math.min(1, Math.sqrt(Math.max(count, 2) / SECTOR_ALPHA_COUNT));
  return [alphas[0] * temper, alphas[1] * temper];
}

/**
 * How tightly a one-item wheel's light gathers towards its icon: the fade round the ring is
 * `((1 + cos φ) / 2)^power`, with φ the angle away from the icon. At 1.5 the sides at a quarter
 * turn keep about a third, and the far side has nothing.
 */
const SECTOR_SOLO_FALLOFF_POWER = 1.5;
/** Stops round the whole turn — one every 10°, so the curve bends rather than kinks. */
const SECTOR_SOLO_SAMPLES = 36;

/**
 * A one-item wheel's light, bent round the ring towards its icon — a CSS `mask-image`.
 *
 * One item owns the whole plane, so its wedge is a full ring, and a ring lit evenly is a halo: it
 * glows in every direction at once and points at nothing, which is the one thing a highlight is
 * for. This fades it by ANGLE instead: brightest straight out through the icon, dimming smoothly
 * both ways round the wheel, and gone on the far side. Both ends of the curve are flat, so there
 * is no angle at which the fade starts or stops.
 *
 * A conic gradient, because SVG has none; it masks the whole `<svg>`, which on a one-item wheel
 * holds nothing else — there are no seams to take with it.
 */
export function sectorSoloFadeMask(centreDeg: number): string {
  const stops = Array.from({ length: SECTOR_SOLO_SAMPLES + 1 }, (_, index) => {
    const turn = index / SECTOR_SOLO_SAMPLES;
    const weight = ((1 + Math.cos(turn * 2 * Math.PI)) / 2) ** SECTOR_SOLO_FALLOFF_POWER;
    return `rgba(0, 0, 0, ${weight.toFixed(4)}) ${(turn * 360).toFixed(1)}deg`;
  });
  /** CSS measures from twelve o'clock; these degrees measure from three. */
  return `conic-gradient(from ${centreDeg + 90}deg at 50% 50%, ${stops.join(', ')})`;
}

/**
 * The alphas each of the three gradients runs between — [at the dead zone, at the plateau's end].
 *
 * Calibrated against the DEFAULT hover colour, which is white. A ramp tuned on a saturated colour
 * blows out when it is white, and white is what most wheels are drawing: the same numbers that
 * read as a confident blue wedge read as a headlight.
 */
export const SECTOR_FILL_ALPHA = [0.46, 0.38] as const;
export const SECTOR_EDGE_ALPHA = [0.68, 0.55] as const;
export const SECTOR_SEAM_ALPHA = [0.16, 0.11] as const;

/**
 * How far the seams run, as a fraction of the wedge's reach, and where they start fading.
 *
 * Shorter than the wedges on purpose. A seam is structure — it answers "where does this one end",
 * which is a question about the part of the wheel being aimed AT. Run to full length they stopped
 * being furniture and became a giant X drawn across the desktop, competing with the thing they are
 * there to explain.
 */
export const SECTOR_SEAM_REACH = 0.55;
export const SECTOR_SEAM_FALLOFF_SCALE = 1.1;
