//! The wheel's plane, cut into equal shares — the geometry BOTH the aim and the drawing read.
//!
//! It lives away from the renderer for the reason `scrim.rs` does: the wheel must never hold two
//! opinions about where a target is. The index the pointer resolves to and the wedge painted under
//! it are the same arithmetic here, so "it lit one thing and opened another" is not a defect this
//! code can have — and the arithmetic can be proved without a device.
//!
//! Conventions, once, for everything below:
//!  - Degrees, screen coordinates: x right, y DOWN. Increasing degrees therefore run clockwise.
//!  - Item `i` is centred on `i * (360 / count) - 90`, so item 0 sits at twelve o'clock.

use std::f32::consts::PI;

/// Half-open `[start, end)` in degrees: the share of the plane item `index` owns.
pub fn bounds_deg(index: usize, count: usize) -> (f32, f32) {
    let slice = 360.0 / count as f32;
    let centre = index as f32 * slice - 90.0;
    (centre - slice / 2.0, centre + slice / 2.0)
}

/// The direction item `index` is aimed at — the bisector its highlight runs along.
pub fn centre_deg(index: usize, count: usize) -> f32 {
    index as f32 * (360.0 / count as f32) - 90.0
}

/// Which item a displacement from the centre points at.
///
/// This is the wheel's targeting, full stop — direction and area both call it, and pointer mode
/// calls it too, for the candidate it then distance-tests against the icon.
pub fn index_for_delta(dx: f32, dy: f32, count: usize) -> Option<usize> {
    if count == 0 {
        return None;
    }
    let slice = 360.0 / count as f32;
    let mut angle = dy.atan2(dx) * (180.0 / PI) + 90.0;
    if angle < 0.0 {
        angle += 360.0;
    }
    let index = (((angle + slice / 2.0) % 360.0) / slice).floor() as isize;
    if index >= 0 && (index as usize) < count {
        Some(index as usize)
    } else {
        None
    }
}

/// A point on the wheel's plane, for the seams drawn between wedges.
pub fn polar_point(centre: f32, radius: f32, deg: f32) -> (f32, f32) {
    let rad = deg * (PI / 180.0);
    (centre + radius * rad.cos(), centre + radius * rad.sin())
}

/// Where the fade samples sit, as a fraction of the way from the plateau's end to the rim.
///
/// Seventeen, not two, and for the reason `scrim::gradient_stops` gives about its own nine: a long
/// band between two stops is interpolated in 8-bit, and the steps that produces read as banding —
/// concentric rings in something that is supposed to be a dissolve. The wedge fades over hundreds
/// of pixels, several times the scrim's span, so it is sampled several times as densely.
const FALLOFF_SAMPLES: [f32; 17] = [
    0.0, 0.06, 0.12, 0.19, 0.25, 0.32, 0.38, 0.44, 0.5, 0.56, 0.62, 0.69, 0.75, 0.82, 0.88, 0.94,
    1.0,
];

/// Where the hold ends and the dissolve begins. Everything that fades has to agree on it.
pub fn plateau_stop(inner_stop: f32, falloff_stop: f32) -> f32 {
    falloff_stop.max(inner_stop + 0.01).min(0.98)
}

/// One gradient stop: a fraction of the run, and the alpha there.
#[derive(Debug, Clone, Copy)]
pub struct Stop {
    pub offset: f32,
    pub opacity: f32,
}

/// The stops of one wedge gradient: hold, then dissolve.
///
/// Two regions. From the dead zone out to `falloff_stop` the wedge holds near full strength,
/// ramping gently from `near_alpha` to `far_alpha` — that is the part with the icon in it, and it
/// has to read as a lit SECTION. Past it the alpha falls as `(1 - t)²` all the way to the rim.
///
/// The square matters twice. Its slope is zero at the end, so the wedge arrives at nothing instead
/// of stopping at something — there is no radius at which a boundary appears. And it is steep at
/// the START, which is what keeps the highlight attached to its icon: a wedge widens as it goes
/// out, so a constant alpha puts most of the lit AREA far from the target and the eye reads the
/// glow as a separate object floating off in that direction.
pub fn gradient_stops(
    inner_stop: f32,
    falloff_stop: f32,
    near_alpha: f32,
    far_alpha: f32,
) -> Vec<Stop> {
    let plateau = plateau_stop(inner_stop, falloff_stop);
    let mut out = Vec::with_capacity(1 + FALLOFF_SAMPLES.len());
    out.push(Stop {
        offset: inner_stop,
        opacity: near_alpha,
    });
    for &t in &FALLOFF_SAMPLES {
        out.push(Stop {
            offset: plateau + t * (1.0 - plateau),
            opacity: far_alpha * (1.0 - t) * (1.0 - t),
        });
    }
    out
}

/// The wedge's light, as two things multiplied — which is the only way it can be both.
///
/// A wedge has to say a DIRECTION, and it has to arrive at nothing on a circle: the rim is where
/// the window cuts, and alpha still standing there is drawn as a hard edge across the desktop. One
/// gradient cannot do both. A gradient running straight out along the wedge holds its value on
/// lines ACROSS that direction, and such a line meets the rim — so its fade would have to be over
/// by the time it reached the wedge's far corners, which on a wide wedge is barely half way out.
/// That is the three-item wheel: a short bright triangle near the hub, cut off by a straight chord,
/// with the two lit sides carrying on past it to the rim on their own. It reads as an outline that
/// lost its fill, because that is what it is.
///
/// So the fade is split in two and multiplied by a mask:
///  - The BEAM is the straight one, per wedge, along its bisector. It carries the colour, and it
///    falls on the same square as ever but lands on `lean` instead of on nothing.
///  - The REACH is the ring, drawn once for the whole plane. It is whatever is left over — the
///    quotient that makes the product come out at exactly `(1 - t)²` — and since it depends on
///    nothing but the distance from the hub, it is zero on the entire rim in every direction.
///
/// The point of splitting it that way: ALONG the bisector the wedge is painted exactly as it was
/// before any of this, the calibrated fade unchanged. The direction is bought entirely off-axis,
/// where a straight gradient leaves the sides of a wedge a little ahead of its middle.
fn beam_curve(t: f32, lean: f32) -> f32 {
    lean + (1.0 - lean) * (1.0 - t) * (1.0 - t)
}

/// How much of the run a full lean wants after the hold has ended.
///
/// A lean is a slope, and a slope needs distance. Where the hold reaches almost to the rim — a dead
/// zone squeezed against a window edge — what is left is a sliver, and the same drop crammed into
/// it stops being a direction and becomes a step at one radius, with the wedge's own sides landing
/// on the near side of that step and reading as a bulge. Below this much room the lean is taken in
/// proportion to what there is.
const BEAM_RUN: f32 = 0.5;

fn lean_with_room(lean: f32, plateau: f32) -> f32 {
    1.0 - (1.0 - lean) * ((1.0 - plateau) / BEAM_RUN).min(1.0)
}

/// How much of its own strength the beam still has at the rim: the sine of the wedge's half-slice.
///
/// A straight gradient holds its value across the beam, so at any distance from the hub the parts
/// of a wedge off to the sides are always a little ahead of the part on the axis — nearer the start
/// of the run, and therefore brighter. That is what makes the light read as going somewhere. Past a
/// point it instead reads as the highlight spilling sideways out of the slice it belongs to, and
/// the point is decided by one thing: how far off-axis the wedge's own sides are.
///
/// Which is what the sine is. It is small on a crowded wheel, where the sides are nearly parallel
/// to the beam and almost the whole fade can be spent on the lean; it is most of the way to 1 on a
/// three-item wheel, where they are 60° out and there is almost nothing to spend. Across every size
/// of wheel it holds the sides to within about a fifth of the axis at the same radius — a beam,
/// rather than a bulge.
///
/// One and two items get no lean at all, which is correct rather than a special case: a half-plane
/// has no direction a straight gradient can point in that its own flat side does not lie across.
/// `max(count, 2)` is what folds the single-item wheel — a reflex wedge, with no axis to lean
/// along — in with the two-item one.
pub fn beam_lean(count: usize) -> f32 {
    (PI / count.max(2) as f32).sin()
}

/// The beam's own ramp: the hold, then the square landing on `lean` rather than on nothing.
///
/// It starts at the centre rather than at the dead zone, and that is not laziness about a region
/// nothing is drawn in. The wedge's inner CORNERS are foreshortened onto this axis like everything
/// else — they sit at `inner_stop · cos(half slice)` along it — so a first stop at `inner_stop`
/// would leave them in front of it, on a flat strip of the near alpha instead of on the ramp.
pub fn beam_stops(
    inner_stop: f32,
    falloff_stop: f32,
    near_alpha: f32,
    far_alpha: f32,
    lean: f32,
) -> Vec<Stop> {
    let plateau = plateau_stop(inner_stop, falloff_stop);
    let reached = lean_with_room(lean, plateau);
    let mut out = Vec::with_capacity(1 + FALLOFF_SAMPLES.len());
    out.push(Stop {
        offset: 0.0,
        opacity: near_alpha,
    });
    for &t in &FALLOFF_SAMPLES {
        out.push(Stop {
            offset: plateau + t * (1.0 - plateau),
            opacity: far_alpha * beam_curve(t, reached),
        });
    }
    out
}

/// The reach: what the beam did not do, so that the two together come out at `(1 - t)²`.
///
/// White, and used as a mask rather than as paint — it is a factor, not a colour. It holds at 1
/// through the section with the icons in it and is zero at the rim, which is the whole of what the
/// wedges need from it: whatever the beam is still holding out there, this takes to nothing, in
/// every direction at once and therefore on the window's edge wherever that edge happens to be.
pub fn reach_stops(inner_stop: f32, falloff_stop: f32, lean: f32) -> Vec<Stop> {
    let plateau = plateau_stop(inner_stop, falloff_stop);
    let reached = lean_with_room(lean, plateau);
    let mut out = Vec::with_capacity(1 + FALLOFF_SAMPLES.len());
    out.push(Stop {
        offset: inner_stop,
        opacity: 1.0,
    });
    for &t in &FALLOFF_SAMPLES {
        out.push(Stop {
            offset: plateau + t * (1.0 - plateau),
            opacity: ((1.0 - t) * (1.0 - t)) / beam_curve(t, reached),
        });
    }
    out
}

/// The wheel these alphas were calibrated on, in items.
///
/// What the eye weighs is not the alpha, it is the LIGHT — and a wedge's share of the plane is
/// `1 / count`, so the same alpha on a three-item wheel puts nearly three times as much of it on
/// the desktop. At that width the highlight stops reading as a lit section and becomes a wash with
/// two hard rails on it, which is the whole of what a three-item wheel looks wrong for.
const ALPHA_COUNT: f32 = 8.0;

/// The same light, spread over however much plane this wheel gives a wedge.
///
/// The square root rather than the share itself: matching the area exactly would take a three-item
/// wedge down to a third and leave nothing to see, and the eye does not add brightness over an area
/// linearly anyway. Halfway between "the same alpha" and "the same total light" is where a wide
/// wedge stops shouting without going quiet. Never above 1 — past eight items the wedges are narrow
/// and the numbers below are already what they were tuned to be.
///
/// One item is tempered as two: its ring is bent towards the icon by `solo_fade_weight`, which
/// leaves it lighting roughly half the plane — a two-item wedge's share, not the whole of it.
pub fn beam_alphas(alphas: (f32, f32), count: usize) -> (f32, f32) {
    let temper = ((count.max(2) as f32) / ALPHA_COUNT).sqrt().min(1.0);
    (alphas.0 * temper, alphas.1 * temper)
}

/// How tightly a one-item wheel's light gathers towards its icon.
const SOLO_FALLOFF_POWER: f32 = 1.5;

/// A one-item wheel's light, bent round the ring towards its icon.
///
/// One item owns the whole plane, so its wedge is a full ring, and a ring lit evenly is a halo: it
/// glows in every direction at once and points at nothing, which is the one thing a highlight is
/// for. This fades it by ANGLE instead: brightest straight out through the icon, dimming smoothly
/// both ways round the wheel, and gone on the far side. Both ends of the curve are flat, so there
/// is no angle at which the fade starts or stops.
///
/// `turn` is 0..1 away from the icon's direction. At 1.5 the sides at a quarter turn keep about a
/// third, and the far side has nothing.
pub fn solo_fade_weight(turn: f32) -> f32 {
    (((1.0 + (turn * 2.0 * PI).cos()) / 2.0) as f32).powf(SOLO_FALLOFF_POWER)
}

/// The alphas each of the three gradients runs between — `[at the dead zone, at the plateau's end]`.
///
/// Calibrated against the DEFAULT hover colour, which is white. A ramp tuned on a saturated colour
/// blows out when it is white, and white is what most wheels are drawing: the same numbers that
/// read as a confident blue wedge read as a headlight.
pub const FILL_ALPHA: (f32, f32) = (0.46, 0.38);
pub const EDGE_ALPHA: (f32, f32) = (0.68, 0.55);
pub const SEAM_ALPHA: (f32, f32) = (0.16, 0.11);

/// How far the seams run, as a fraction of the wedge's reach, and where they start fading.
///
/// Shorter than the wedges on purpose. A seam is structure — it answers "where does this one end",
/// which is a question about the part of the wheel being aimed AT. Run to full length they stopped
/// being furniture and became a giant X drawn across the desktop, competing with the thing they are
/// there to explain.
pub const SEAM_REACH: f32 = 0.55;
pub const SEAM_FALLOFF_SCALE: f32 = 1.1;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn item_zero_sits_at_twelve_oclock() {
        assert_eq!(centre_deg(0, 8), -90.0);
        // Straight up is item 0 on every wheel size.
        for count in 1..=20 {
            assert_eq!(index_for_delta(0.0, -100.0, count), Some(0));
        }
    }

    #[test]
    fn a_single_item_owns_the_whole_plane() {
        // Whatever direction the hand goes, the one item is the target: there is nothing else.
        for (dx, dy) in [(1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.7, -0.7)] {
            assert_eq!(index_for_delta(dx, dy, 1), Some(0));
        }
    }

    #[test]
    fn the_aim_and_the_drawing_agree_on_every_boundary() {
        // The one defect a launcher cannot afford: lighting one target and opening another. Sample
        // just inside each wedge's own bounds and check the aim resolves to that wedge.
        for count in 1..=24 {
            for index in 0..count {
                let (start, end) = bounds_deg(index, count);
                for frac in [0.02_f32, 0.5, 0.98] {
                    let deg = start + (end - start) * frac;
                    let rad = deg * PI / 180.0;
                    let hit = index_for_delta(rad.cos() * 300.0, rad.sin() * 300.0, count);
                    assert_eq!(hit, Some(index), "count={count} index={index} deg={deg}");
                }
            }
        }
    }

    #[test]
    fn clockwise_from_the_top() {
        // Screen coordinates have y running down, so increasing degrees must run clockwise.
        assert_eq!(index_for_delta(100.0, 0.0, 4), Some(1)); // right
        assert_eq!(index_for_delta(0.0, 100.0, 4), Some(2)); // down
        assert_eq!(index_for_delta(-100.0, 0.0, 4), Some(3)); // left
    }

    #[test]
    fn beam_and_reach_multiply_back_to_the_calibrated_fade() {
        // The whole reason the fade is split in two: along the bisector it has to be *exactly* the
        // curve it was before the lean existed, or the wedge is no longer the one that was tuned.
        let (inner, falloff) = (0.2_f32, 0.6_f32);
        for count in [3usize, 8, 16] {
            let lean = beam_lean(count);
            let beam = beam_stops(inner, falloff, 1.0, 1.0, lean);
            let reach = reach_stops(inner, falloff, lean);
            let plain = gradient_stops(inner, falloff, 1.0, 1.0);
            // Skip the leading stop: beam starts at 0 and the other two at `inner`.
            for i in 1..plain.len() {
                let product = beam[i].opacity * reach[i].opacity;
                assert!(
                    (product - plain[i].opacity).abs() < 1e-4,
                    "count={count} i={i} product={product} expected={}",
                    plain[i].opacity
                );
            }
        }
    }

    #[test]
    fn the_reach_is_zero_on_the_rim() {
        // Alpha standing at the window's edge is a hard line drawn across the desktop.
        for count in [1usize, 3, 8, 20] {
            let stops = reach_stops(0.2, 0.6, beam_lean(count));
            let last = stops.last().unwrap();
            assert!((last.offset - 1.0).abs() < 1e-6);
            assert!(last.opacity.abs() < 1e-6, "count={count}");
        }
    }

    #[test]
    fn wide_wedges_are_tempered() {
        // A three-item wedge covers nearly three times the plane of an eight-item one.
        let (near_3, _) = beam_alphas(FILL_ALPHA, 3);
        let (near_8, _) = beam_alphas(FILL_ALPHA, 8);
        assert!(near_3 < near_8);
        // Past the calibration count nothing is scaled up.
        let (near_20, _) = beam_alphas(FILL_ALPHA, 20);
        assert!((near_20 - FILL_ALPHA.0).abs() < 1e-6);
    }

    #[test]
    fn one_and_two_items_get_no_lean() {
        // A half-plane has no direction a straight gradient can point in that its own flat side
        // does not lie across.
        assert!((beam_lean(1) - 1.0).abs() < 1e-6);
        assert!((beam_lean(2) - 1.0).abs() < 1e-6);
        assert!(beam_lean(8) < 0.5);
    }

    #[test]
    fn solo_fade_is_flat_at_both_ends() {
        assert!((solo_fade_weight(0.0) - 1.0).abs() < 1e-6);
        assert!(solo_fade_weight(0.5).abs() < 1e-6);
        // Symmetric both ways round the wheel.
        assert!((solo_fade_weight(0.25) - solo_fade_weight(0.75)).abs() < 1e-6);
    }
}
