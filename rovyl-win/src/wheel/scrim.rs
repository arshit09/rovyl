//! The dimming scale: what the "Background dimming" slider stores, and the two things it paints.
//!
//! It lives on its own, away from the wheel that draws it, because the window code needs one of the
//! answers too — whether the overlay may stay a box — and because arithmetic this easy to get
//! subtly wrong deserves a test that needs no device context.

use crate::config::defaults::SCRIM_FLATTEN_FROM;

/// The two alphas "Background dimming" moves. `backdrop_opacity` is the slider, 0..1.
///
/// `peak` is what sits under the wheel. It never reaches nothing — 0.22 at 0%, because the wheel
/// still has to separate from the desktop — and it reaches a true 1 at 100%. It is squared so the
/// bottom of the slider keeps the gentle range it has always had and the whole of the new reach is
/// spent above it: 0.6 lands on 0.5, which is exactly where the old scale ENDED. That is also why
/// configs written before this are rescaled on read — the same number means a much darker screen
/// now, and nobody asked for that.
///
/// `floor` is what is left at the far edge of the pool, and for most of the slider it is zero: a
/// scrim is a pool, not a sheet. Past `SCRIM_FLATTEN_FROM` it lifts until, at 100%, floor equals
/// peak — no falloff at all, an opaque fill, the desktop gone. A pool with a bright rim around it
/// is not a blacked-out screen, and "100%" is only worth having if it means the screen.
pub fn alphas(backdrop_opacity: f32) -> (f32, f32) {
    // Fallback is the default config's value: a config that lost the key must not black the screen.
    let dim = if backdrop_opacity.is_finite() {
        backdrop_opacity.clamp(0.0, 1.0)
    } else {
        0.9
    };
    let peak = 0.22 + 0.78 * dim * dim;
    let flatten = ((dim - SCRIM_FLATTEN_FROM) / (1.0 - SCRIM_FLATTEN_FROM)).max(0.0);
    (peak, peak * flatten * flatten)
}

/// Whether the scrim still has visible alpha where the WINDOW ends.
///
/// The overlay normally opens in a box around the wheel rather than over the monitor, which is what
/// keeps the compositor off a screen-sized translucent surface. That box is invisible for as long
/// as the pool fades to nothing inside it. The moment it does not, the box has to become the
/// screen, or the dimming is a dark rectangle sitting on a bright desktop with four hard edges.
pub fn needs_full_bleed(backdrop_opacity: f32) -> bool {
    // ~1% alpha: below it the edge is not visible on any desktop, so the cheap box still wins.
    alphas(backdrop_opacity).1 > 0.008
}

/// Where the pool's gradient stops sit, and how opaque each is.
///
/// Nine stops in smoothstep, not two. A long band between two stops is interpolated in 8 bits, and
/// the steps that produces read as banding — concentric rings in something that is supposed to be
/// a dissolve.
///
/// Returns `(offset 0..1, alpha)`, where the offset is a fraction of `radius * 2`.
pub fn gradient_stops(backdrop_opacity: f32) -> Vec<(f32, f32)> {
    let (peak, floor) = alphas(backdrop_opacity);
    // Nothing left to fall off to. A flat fill rasterises far cheaper than nine identical stops.
    if floor >= peak {
        return vec![(0.0, peak), (1.0, peak)];
    }
    [0.0, 0.12, 0.25, 0.38, 0.5, 0.62, 0.75, 0.88, 1.0]
        .iter()
        .map(|&t| {
            let falloff = 1.0 - (3.0 * t * t - 2.0 * t * t * t);
            (t, floor + (peak - floor) * falloff)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_still_separates_the_wheel_from_the_desktop() {
        let (peak, floor) = alphas(0.0);
        assert!((peak - 0.22).abs() < 1e-6);
        assert_eq!(floor, 0.0);
    }

    #[test]
    fn one_is_an_opaque_sheet() {
        // "100%" is only worth having if it means the screen.
        let (peak, floor) = alphas(1.0);
        assert!((peak - 1.0).abs() < 1e-6);
        assert!((floor - peak).abs() < 1e-6);
        assert!(needs_full_bleed(1.0));
    }

    #[test]
    fn the_default_already_wants_the_whole_monitor() {
        // 0.9 is past SCRIM_FLATTEN_FROM, so a default profile opens monitor-wide. Anything that
        // assumes the cheap box is the common case is reasoning about a configuration nobody has.
        assert!(needs_full_bleed(0.9));
        assert!(!needs_full_bleed(0.6));
    }

    #[test]
    fn midpoint_of_the_old_scale_is_preserved() {
        // 0.6 on scale 2 lands on 0.5 alpha, which is where scale 1 ended.
        let (peak, _) = alphas(0.6);
        assert!((peak - 0.5008).abs() < 1e-3, "got {peak}");
    }

    #[test]
    fn a_flat_fill_collapses_to_two_stops() {
        assert_eq!(gradient_stops(1.0).len(), 2);
        assert_eq!(gradient_stops(0.5).len(), 9);
    }
}
