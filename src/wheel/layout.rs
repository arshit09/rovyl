//! Wheel calibration: how big the ring is and how big the tiles on it are.
//!
//! Pulled out of the renderer because the settings panel's live preview paints the SAME wheel at a
//! smaller viewport — radius, tile size and breathing room have to come from here, never from
//! parallel constants. A preview that lays out differently from the thing it previews is worse than
//! no preview.

use std::f32::consts::PI;

pub struct LayoutInput {
    pub item_count: usize,
    pub icon_size: f32,
    /// `app_spacing` from the config.
    pub min_gap: f32,
    pub menu_radius: f32,
    pub activation_threshold: f32,
    pub viewport: (f32, f32),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Layout {
    pub radius: f32,
    pub icon_size: f32,
}

/// The ring's radius and the tiles' size, for this many items in this much room.
pub fn compute(input: &LayoutInput) -> Layout {
    let LayoutInput {
        item_count,
        icon_size,
        min_gap,
        menu_radius,
        activation_threshold,
        viewport,
    } = *input;

    // Allow the wheel to occupy up to 52% of the smallest screen dimension.
    let max_screen_radius = viewport.0.min(viewport.1) * 0.52;
    let sin_half_slice = if item_count > 1 {
        (PI / item_count as f32).sin()
    } else {
        0.0
    };

    // Icon size ramps continuously with the item count rather than stepping at 4 and 6 items: a
    // sparse wheel reads better slightly compact, a dense one wants the configured size, and
    // adding one app should not resize the rest.
    let density = (((item_count as f32) - 3.0) / 6.0).clamp(0.0, 1.0);
    let mut current_icon = (icon_size * (0.82 + 0.18 * density)).round();

    // The ring grows only as fast as the icons need to keep a constant edge gap between neighbours.
    let neighbour_gap = min_gap + 14.0;
    let packed_radius = |size: f32| -> f32 {
        if item_count > 1 {
            (size + neighbour_gap) / 2.0 / sin_half_slice
        } else {
            0.0
        }
    };

    // Floor: clear of the central hub, clear of the centre dead zone that cancels selection.
    let floor_radius = |size: f32| -> f32 {
        (size * 1.1 + min_gap + 12.0) // hub is size * 1.2 wide
            .max(activation_threshold + size / 2.0 + 8.0) // stay outside the dead zone
            .max(92.0)
    };

    // The saved radius scales the WHOLE ring, not just its floor.
    //
    // Scaling only the floor made the setting inert wherever packing won, which on any wheel of
    // nine or more is the entire lower half of the slider: twelve shortcuts sat at the same 170px
    // from 90px through 220px, so the one control named after the wheel's size could not change
    // it. The divisor is 150 and the defaults are 140 + 10, so a default wheel comes out exactly
    // where it always did; every other value now moves it.
    let radius_scale = (menu_radius + min_gap) / 150.0;
    let natural_radius = |size: f32| floor_radius(size).max(packed_radius(size));

    let mut target_radius = natural_radius(current_icon) * radius_scale;

    // A ring asked to come in tighter than its own packing has to take it out of the icons — there
    // is nowhere else for the room to come from, and neighbours that overlap are worse than tiles
    // that are small. Bounded at half size, the same floor the screen clamp below uses; past that
    // the ring simply stops shrinking.
    if target_radius < packed_radius(current_icon) && item_count > 1 {
        let possible = (2.0 * target_radius * sin_half_slice - neighbour_gap) / current_icon;
        current_icon = (current_icon * possible.clamp(0.5, 1.0)).round();
        target_radius = target_radius.max(packed_radius(current_icon));
    }

    // If the ring outgrows the screen, shrink the icons instead of overlapping.
    if target_radius > max_screen_radius && item_count > 1 {
        let possible = (2.0 * max_screen_radius * sin_half_slice - neighbour_gap) / current_icon;
        current_icon = (current_icon * possible.clamp(0.5, 1.0)).round();
        target_radius = natural_radius(current_icon).max(target_radius.min(max_screen_radius));
    }

    Layout {
        radius: target_radius,
        icon_size: current_icon,
    }
}

/// The hub's diameter, for this wheel.
///
/// The density ramp (0.82 → 1.0) is reserved for the slices; the centre does not grow with the item
/// count, or the same button ends up with one size per workspace. The result is forced even,
/// because centring an odd number lands the circle on a half pixel and jags it.
pub fn hub_diameter(config_icon_size: f32, layout: &Layout) -> f32 {
    let floor = (config_icon_size * 0.82 * 1.2).round();
    let ceiling = ((layout.radius - layout.icon_size / 2.0 - 10.0) * 2.0).round();
    let value = floor.min(ceiling).max(24.0);
    // `& ~1` on the integer: an even side keeps the disc's centre on a whole pixel.
    ((value as i32) & !1) as f32
}

/// Cancel zone — it has to cover the hub's BOX, not the circle.
///
/// The hub is a square whose corners are rounded away, and a rounded corner clips the hit test
/// too: a press on the box's corner falls outside the circle and becomes a direction. Except that
/// corner is `r·√2` from the centre (41% further than the circle's edge) and the user reads it as
/// "inside the button" — hence pressing the top-left corner of the back button and launching a
/// slice. The `× 1.06` follows the scale the hub gains when it is active, which is exactly the
/// state this press happens in.
pub fn dead_zone_radius(activation_threshold: f32, hub_diameter: f32) -> f32 {
    activation_threshold.max(((hub_diameter / 2.0) * 1.06 * std::f32::consts::SQRT_2).ceil() + 4.0)
}

/// The square target over the hub, slightly larger than the disc itself.
pub fn hub_hit_size(hub_diameter: f32) -> f32 {
    (hub_diameter * 1.06).round() + 4.0
}

/// How far the drawn wheel reaches from its own centre.
///
/// Only `placement: cursor` uses it, to keep the ring on the screen when the pointer is in a
/// corner. The window's own size has the gesture margin baked in and is several hundred pixels
/// wider than anything visible, so it cannot answer this.
pub fn ring_reach(layout: &Layout) -> f32 {
    layout.radius + layout.icon_size
}

/// Labels sit OUTSIDE the wheel, on the side the slice points to, so a dense wheel never stacks a
/// pill over the neighbouring icon (the old below-the-icon placement did).
///
/// Returns the offset from the tile's centre and the anchor the pill is aligned by, as fractions of
/// its own width and height.
pub fn label_placement(angle_deg: f32, icon_size: f32) -> ((f32, f32), (f32, f32)) {
    let rad = angle_deg * (PI / 180.0);
    let (cos, sin) = (rad.cos(), rad.sin());
    let edge = icon_size / 2.0 + 10.0;

    if cos > 0.35 {
        ((edge, 0.0), (0.0, -0.5))
    } else if cos < -0.35 {
        ((-edge, 0.0), (-1.0, -0.5))
    } else if sin < 0.0 {
        ((0.0, -edge), (-0.5, -1.0))
    } else {
        ((0.0, edge), (-0.5, 0.0))
    }
}

/// Binary highlight: the aimed slice lights up and every other one looks the same as the rest.
///
/// Varying presence by angular distance made the neighbours look partly selected.
///
/// Container opacity is NOT the "not selected" channel. Each slice carries its own background, and
/// alpha multiplies that background too: at 0.5 the tile stopped being an object and became a
/// smudge over the desktop — worse still with a monochrome glyph and a light wallpaper, where the
/// white stroke at half alpha disappears. Here opacity only gives the minimum remove; selection
/// reads through colour, ring and scale, which are signals that do not destroy the contrast of
/// what sits underneath.
pub fn slice_presence(angular_distance: Option<usize>) -> (f32, f32) {
    match angular_distance {
        None => (0.96, 1.0),
        Some(0) => (1.0, 1.06),
        Some(_) => (0.9, 1.0),
    }
}

/// The scale the confirmed slice STAYS at during the launch echo — the same as the aimed slice, not
/// a new value. Confirming by aim already had it there: changing the number would make the slice
/// take a sideways step at the very moment the user is reading it.
pub const FIRED_SLICE_SCALE: f32 = 1.06;

/// Where the wheel's centre may go while it is being carried.
///
/// The clamp is by the RING — radius plus a tile — and not by the hub, because a wheel whose far
/// side is off the monitor is a wheel with shortcuts that cannot be aimed at. The user asked to
/// move it, not to lose half of it. The labels, which hang further out still, are allowed to be
/// cut: a clipped label is legible from its icon, a clipped icon is gone.
///
/// On a viewport too small to hold the ring at all — a wheel with a huge radius on a short screen —
/// the reach is given up rather than inverted, and the centre is pinned to the middle of that axis.
/// An inverted clamp is the bug that pins the wheel to a corner and will not let go.
pub fn clamp_wheel_center(point: (f32, f32), viewport: (f32, f32), reach: f32) -> (f32, f32) {
    (
        clamp_axis(point.0, viewport.0, reach),
        clamp_axis(point.1, viewport.1, reach),
    )
}

fn clamp_axis(value: f32, extent: f32, reach: f32) -> f32 {
    if !value.is_finite() {
        return (extent / 2.0).round();
    }
    let margin = reach.max(0.0).min(extent / 2.0);
    let (min, max) = (margin, extent - margin);
    if !(max > min) {
        return (extent / 2.0).round();
    }
    value.clamp(min, max).round()
}

/// How far the hand has to travel before a press on the hub stops being a click.
///
/// Small on purpose. The hub's own action (back, or whatever the centre button is set to) fires on
/// the CLICK, so every pixel of slop is a pixel of lag on a control the user presses constantly —
/// and a genuine drag crosses four pixels in the first frame of the movement.
pub const HUB_DRAG_SLOP_PX: f32 = 4.0;

/// Whether a workspace has more shortcuts than the wheel can be aimed at.
///
/// The ring divides 360° by the item count and nothing caps it, so the geometry degrades quietly:
/// eight shortcuts are 45° each and effortless, twenty are 18° and a coin toss. The thresholds come
/// from the slice, not from taste. A flick of the wrist lands within roughly ±15° of where it was
/// aimed, so a 30° slice — twelve items — is the last one whose whole width is inside that error.
pub fn crowding(item_count: usize, by_direction: bool) -> Option<(Severity, String)> {
    if item_count <= 12 {
        return None;
    }
    let degrees = (360.0 / item_count as f32).round() as i32;
    let severity = if item_count > 18 {
        Severity::Warning
    } else {
        Severity::Caution
    };
    // "is Nº wide" and not "is a Nº slice": 8, 11 and 18 are all reachable, and all take "an".
    let cost = if by_direction {
        format!("each target is only {degrees}\u{b0} wide")
    } else {
        "each icon has to shrink to keep the ring on screen".to_string()
    };
    let advice = match severity {
        Severity::Warning => {
            "Group related shortcuts into a folder — a group is one slice, and opens a ring of its own."
        }
        Severity::Caution => {
            "Adding many more will make them hard to hit; a folder keeps several behind one slice."
        }
    };
    Some((
        severity,
        format!("{item_count} shortcuts on the wheel, so {cost}. {advice}"),
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Caution,
    Warning,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(count: usize) -> LayoutInput {
        LayoutInput {
            item_count: count,
            icon_size: 64.0,
            min_gap: 10.0,
            menu_radius: 140.0,
            activation_threshold: 60.0,
            viewport: (1920.0, 1080.0),
        }
    }

    #[test]
    fn neighbours_never_overlap() {
        // The packing rule is the whole job: two tiles whose edges meet is a wheel you cannot aim
        // at. Chord between adjacent centres must clear the tile plus its gap.
        for count in 2..=30 {
            let l = compute(&input(count));
            let chord = 2.0 * l.radius * (PI / count as f32).sin();
            assert!(
                chord >= l.icon_size - 0.51,
                "count={count} chord={chord} icon={}",
                l.icon_size
            );
        }
    }

    #[test]
    fn the_ring_clears_the_dead_zone() {
        // A tile inside the cancel zone is a tile that cannot be selected by pointing at it.
        for count in 1..=24 {
            let l = compute(&input(count));
            let hub = hub_diameter(64.0, &l);
            let dead = dead_zone_radius(60.0, hub);
            assert!(
                l.radius - l.icon_size / 2.0 >= dead - 9.0,
                "count={count} radius={} dead={dead}",
                l.radius
            );
        }
    }

    #[test]
    fn the_radius_slider_moves_a_crowded_wheel() {
        // The defect this replaced: on twelve items, packing won and the whole lower half of the
        // slider was inert.
        let small = compute(&LayoutInput { menu_radius: 90.0, ..input(12) });
        let large = compute(&LayoutInput { menu_radius: 220.0, ..input(12) });
        assert!(large.radius > small.radius + 20.0, "{small:?} {large:?}");
    }

    #[test]
    fn a_default_wheel_lands_where_it_always_did() {
        // Divisor 150 with defaults 140 + 10 means scale exactly 1.
        let l = compute(&input(8));
        let unscaled = compute(&LayoutInput { menu_radius: 140.0, min_gap: 10.0, ..input(8) });
        assert_eq!(l.radius, unscaled.radius);
    }

    #[test]
    fn the_ring_stays_on_a_small_screen() {
        // Shrink the icons rather than run the ring off the edge.
        let l = compute(&LayoutInput { viewport: (800.0, 600.0), ..input(20) });
        assert!(l.radius <= 600.0 * 0.52 + 1.0, "radius={}", l.radius);
    }

    #[test]
    fn hub_side_is_even() {
        // An odd side lands the centred disc on a half pixel and jags the circle.
        for count in 1..=20 {
            let l = compute(&input(count));
            let hub = hub_diameter(64.0, &l);
            assert_eq!(hub as i32 % 2, 0, "count={count} hub={hub}");
        }
    }

    #[test]
    fn an_impossible_viewport_pins_the_centre_rather_than_inverting() {
        // The bug this guards: an inverted clamp pins the wheel to a corner and will not let go.
        let c = clamp_wheel_center((10.0, 10.0), (200.0, 200.0), 500.0);
        assert_eq!(c, (100.0, 100.0));
    }

    #[test]
    fn crowding_speaks_only_past_twelve() {
        assert!(crowding(12, true).is_none());
        let (sev, msg) = crowding(13, true).unwrap();
        assert_eq!(sev, Severity::Caution);
        assert!(msg.contains("28\u{b0}"), "{msg}");
        assert_eq!(crowding(19, true).unwrap().0, Severity::Warning);
        // Pointer mode fails differently and says so.
        assert!(crowding(20, false).unwrap().1.contains("shrink"));
    }

    #[test]
    fn labels_dodge_to_the_side_the_slice_points() {
        // Right-hand slices get the pill on their right, and so on: a dense wheel must never stack
        // a label over the neighbouring icon.
        assert_eq!(label_placement(0.0, 64.0).0, (42.0, 0.0));
        assert_eq!(label_placement(180.0, 64.0).0, (-42.0, 0.0));
        assert_eq!(label_placement(-90.0, 64.0).0, (0.0, -42.0));
        assert_eq!(label_placement(90.0, 64.0).0, (0.0, 42.0));
    }
}
