/**
 * Sustained-aim limits, shared by the wheel and by the settings.
 *
 * They live outside `RadialMenu.tsx` because the settings panel is loaded separately (lazy) and
 * importing the whole wheel just to read three numbers dragged it into that chunk. Having a single
 * home also prevents the classic drift: the slider offering a range the engine clamps.
 */
export const DWELL_MS_DEFAULT = 400;
/**
 * Zero is a legitimate value, not an accidental floor: the wait is optional. At zero, the direction
 * fires the instant it commits — the gesture becomes a shove and the aim time gets out of the
 * way. Anyone who wants a safety net raises the number; the top end gives two whole seconds of
 * "point and think" before the wheel does anything at all.
 */
export const DWELL_MS_MIN = 0;
export const DWELL_MS_MAX = 2000;
export const DWELL_MS_STEP = 50;

/**
 * A hand-edited `config-v2.json` (the app points the user there in the hydration error message)
 * or a backup from another source can hand anything to this.
 *
 * Do NOT use `Number(value)` to decide it. Lowering the minimum to zero changed what coercion
 * means: `Number(null)`, `Number('')`, `Number(false)` and `Number([])` are all `0`, which
 * stopped being "out of range, raise to the minimum" and became the most aggressive choice
 * the wheel has — launch on the first shove. A broken file must not arm the product's fastest
 * trigger on its own; only a number (or a string that really is a number) counts,
 * and everything else falls back to the middle ground of `DWELL_MS_DEFAULT`.
 */
export function clampDwellMs(value: unknown): number {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric)) return DWELL_MS_DEFAULT;
  return Math.min(DWELL_MS_MAX, Math.max(DWELL_MS_MIN, Math.round(numeric)));
}

/**
 * Aim sensitivity per direction.
 *
 * With click-free execution on, the pointer is hidden and parked at the centre of the wheel: the
 * gesture stops being "where the cursor is" and becomes "where the hand went". These numbers are
 * the travel accumulated from the centre that a direction needs to stop being tremor and
 * become a choice — nothing lights up below them, and that is what gives the neutral start.
 *
 * They live next to the aim times because they are the other half of the same gesture, and the
 * settings panel (separate chunk) already imports this file without dragging the wheel along.
 */
export const DIRECTION_SENSITIVITIES = ['low', 'medium', 'high'] as const;

export type DirectionSensitivity = (typeof DIRECTION_SENSITIVITIES)[number];

export const DIRECTION_SENSITIVITY_DEFAULT: DirectionSensitivity = 'medium';

/**
 * High is short on purpose — but not below ~16px: a gaming mouse at 1600 DPI produces a dozen
 * pixels just from the hand settling, and a wheel that chooses on that chooses by itself.
 *
 * Low and medium used to sit at 84 and 42, and both fired on a flick. The numbers are read in CSS
 * pixels of CURSOR travel, not of hand travel: Windows pointer acceleration multiplies a fast push,
 * so 84px of cursor is a few centimetres of desk at most — "Low" felt indistinguishable from the
 * hair trigger it is supposed to be the opposite of. These are the distances that actually make Low
 * a deliberate shove and Medium a decision rather than a twitch, with High left alone as the
 * hair trigger it advertises.
 *
 * Ceiling: they have to stay clear of the re-park radius (`PARK_STRAY_MARGIN_PX` in `RadialMenu`,
 * ~354px inside the 988px radial box), or the direction could never commit before the cursor is
 * warped back to the centre.
 */
const DIRECTION_COMMIT_PX: Record<DirectionSensitivity, number> = {
  high: 18,
  medium: 96,
  low: 200,
};

export function clampDirectionSensitivity(value: unknown): DirectionSensitivity {
  if (value === 1 || value === '1' || value === 'low') return 'low';
  if (value === 2 || value === '2' || value === 'medium') return 'medium';
  if (value === 3 || value === '3' || value === 'high') return 'high';
  return DIRECTION_SENSITIVITIES.includes(value as DirectionSensitivity)
    ? (value as DirectionSensitivity)
    : DIRECTION_SENSITIVITY_DEFAULT;
}

/** Pixels of travel the current direction needs to light up a slice. */
export function directionCommitPx(value: unknown): number {
  return DIRECTION_COMMIT_PX[clampDirectionSensitivity(value)];
}
