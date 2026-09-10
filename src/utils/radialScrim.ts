/**
 * The dimming scale: what the "Background dimming" slider stores, and the two things it paints.
 *
 * It lives on its own, away from the wheel that draws it, because the main process needs one of
 * the answers too — whether the radial window may stay a box — and because arithmetic this easy to
 * get subtly wrong deserves a test that does not need React. See scripts/backdrop-dim-smoke.mjs.
 */

/** Where the pool starts filling out into a sheet. Below this the scrim is the pool it always was. */
const SCRIM_FLATTEN_FROM = 0.7;

/**
 * The two alphas "Background dimming" moves. `backdropOpacity` is the slider, 0..1.
 *
 * `peak` is what sits under the wheel. It never reaches nothing — 0.22 at 0%, because the wheel
 * still has to separate from the desktop — and it now reaches a true 1 at 100%. It is squared so
 * the bottom of the slider keeps the gentle range it has always had and the whole of the new reach
 * is spent above it: 0.6 lands on 0.5, which is exactly where the old scale ENDED. That is also
 * why configs written before this are rescaled on read (see `legacyBackdropOpacityToDim`) — the
 * same number means a much darker screen now, and nobody asked for that.
 *
 * `floor` is what is left at the far edge of the pool, and for most of the slider it is zero: a
 * scrim is a pool, not a sheet. Past `SCRIM_FLATTEN_FROM` it lifts until, at 100%, floor equals
 * peak — no falloff at all, an opaque fill, the desktop gone. A pool with a bright rim around it
 * is not a blacked-out screen, and "100%" is only worth having if it means the screen.
 */
export function radialScrimAlphas(backdropOpacity: number): { peak: number; floor: number } {
  /** Fallback is DEFAULT_UI_CONFIG's value: a config that lost the key must not black the screen out. */
  const dim = Number.isFinite(backdropOpacity)
    ? Math.min(1, Math.max(0, backdropOpacity))
    : 0.6;
  const peak = 0.22 + 0.78 * dim * dim;
  const flatten = Math.max(0, (dim - SCRIM_FLATTEN_FROM) / (1 - SCRIM_FLATTEN_FROM));
  return { peak, floor: peak * flatten * flatten };
}

/**
 * Whether the scrim still has visible alpha where the WINDOW ends.
 *
 * The radial normally opens in a box around the wheel rather than over the monitor (see
 * `radialModeBounds` in the main process — it keeps the DWM off a full-screen layered surface).
 * That box is invisible for as long as the pool fades to nothing inside it. The moment it does
 * not, the box has to become the monitor, or the dimming is a dark rectangle sitting on a bright
 * desktop with four hard edges. Main is told through `setRadialViewport`, before the wheel opens.
 */
export function radialScrimNeedsFullBleed(backdropOpacity: number): boolean {
  /** ~1% alpha: below it the edge is not visible on any desktop, so the cheap box still wins. */
  return radialScrimAlphas(backdropOpacity).floor > 0.008;
}

/**
 * Radial scrim: a radial pool in smoothstep across 9 stops (2 stops that wide band at 8-bit, and
 * banding reads as blur). Shared with the licence gate.
 */
export function radialScrimGradient(
  position: { x: number; y: number },
  backdropOpacity: number,
  backdropRadius: number,
): string {
  const { peak, floor } = radialScrimAlphas(backdropOpacity);
  /** Nothing left to fall off to. A flat fill rasterises far cheaper than nine identical stops. */
  if (floor >= peak) {
    const flat = `rgba(4,5,7,${peak.toFixed(3)})`;
    return `linear-gradient(${flat}, ${flat})`;
  }
  const scrimRadius = Math.round(backdropRadius * 2);
  const stops = [0, 0.12, 0.25, 0.38, 0.5, 0.62, 0.75, 0.88, 1]
    .map((t) => {
      const falloff = 1 - (3 * t * t - 2 * t * t * t);
      /** Past the last stop CSS holds its colour, so `floor` is what the rest of the window gets. */
      return `rgba(4,5,7,${(floor + (peak - floor) * falloff).toFixed(3)}) ${Math.round(t * scrimRadius)}px`;
    })
    .join(', ');
  return `radial-gradient(circle at ${Math.round(position.x)}px ${Math.round(position.y)}px, ${stops})`;
}

/**
 * Which scale a saved `backdropOpacity` is written on.
 *
 * Scale 1 (unmarked, everything shipped up to 1.6.0) topped out at 0.52 alpha under the wheel and
 * fell to nothing well inside the radial's window — "100%" was half a pool. Scale 2 reaches an
 * opaque, monitor-wide fill at 1, which means the SAME stored number now paints something far
 * darker. So the number is converted once on read rather than reinterpreted, and the marker says
 * which side of the change a config was written on. Its absence is the whole test: nobody's screen
 * may go black because they upgraded.
 */
export const BACKDROP_DIM_SCALE = 2;

/**
 * A scale-1 `backdropOpacity` as the scale-2 value that paints exactly the same pixels.
 *
 * Scale 1: alpha = 0.22 + 0.30·v. Scale 2: alpha = 0.22 + 0.78·v². Equate and solve for v.
 */
export function legacyBackdropOpacityToDim(legacy: number): number {
  const v = Number.isFinite(legacy) ? Math.min(1, Math.max(0, legacy)) : 1;
  return Math.round(Math.sqrt((0.3 * v) / 0.78) * 100) / 100;
}

/** The alpha the pre-scale-2 code painted under the wheel. Kept so the conversion has a test. */
export function legacyScrimPeak(legacy: number): number {
  return 0.22 + Math.min(1, Math.max(0, legacy)) * 0.3;
}
