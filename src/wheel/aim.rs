//! Resolving a pointer into a target — the one function the highlight and the confirmation share.
//!
//! They used to be separate copies of the same trigonometry, and any divergence between them means
//! lighting up one icon and opening another: the worst defect available to a launcher. There is one
//! `resolve` and both call it.
//!
//! Two rules here cost a long debugging session in the original and are preserved by construction:
//!
//! 1. **Confirmation resolves from the LIVE pointer**, never from retained highlight state.
//!    `Aim` is a value, computed on demand from a point; nothing caches "the slice that is lit" and
//!    then launches it. Releasing mid-move used to confirm the slice the pointer had already left.
//! 2. **A slice's hit area matches its paint.** `resolve` is the only hit test — there are no
//!    per-tile rectangles that could disagree with where the tile was drawn.

use super::peek;
use super::sectors;
use crate::config::SelectionMode;
use std::f32::consts::PI;

/// What the pointer is on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Aim {
    /// Inside the dead zone: the hub. Releasing here cancels, or activates the centre button.
    Center,
    /// A slice, by index into the level on screen.
    Slice(usize),
    /// A shortcut on the peeked workspace's own ring, by index into it. A level the wheel is not
    /// standing on: resolving one does not change which level is.
    Peek(usize),
    /// Past the dead zone but on nothing — only reachable in pointer mode, where releasing away
    /// from every icon cancels.
    Nothing,
}

impl Aim {
    pub fn slice(self) -> Option<usize> {
        match self {
            Aim::Slice(i) => Some(i),
            _ => None,
        }
    }

    pub fn peek(self) -> Option<usize> {
        match self {
            Aim::Peek(i) => Some(i),
            _ => None,
        }
    }

    pub fn is_center(self) -> bool {
        matches!(self, Aim::Center)
    }
}

pub struct AimContext {
    /// The wheel's centre, in the window's client coordinates.
    pub center: (f32, f32),
    pub item_count: usize,
    pub radius: f32,
    pub icon_size: f32,
    pub mode: SelectionMode,
    /// Radius past which the aim stops being "centre" and becomes a slice.
    ///
    /// By direction, what rules is the SENSITIVITY and not the cancel zone: the dead zone is the
    /// size of the middle BUTTON — it measures a click target, and in a clickless gesture there is
    /// not even a pointer to hit it with. Keeping the dead zone here made high sensitivity
    /// indistinguishable from medium, because nothing would light before the hub's ~60px.
    pub aim_gate: f32,
    /// Whether the pointer is hidden and parked at the centre, so the aim comes from the VECTOR the
    /// hand drew rather than from a position.
    pub direction_mode: bool,
    /// The peeked workspace's ring, when one is up. Present means there is a second set of targets
    /// on the plane, and that is the only thing that makes `Aim::Peek` reachable.
    pub peek: Option<peek::Shape>,
}

/// The target for a point, or `None` when there is no point yet.
///
/// A missing point resolves to `Center`, that is, to cancelling — the only safe default. On a fresh
/// open the previous gesture's position is stale and sits far from the new centre, so believing it
/// would confirm a slice for somebody who never moved the mouse.
pub fn resolve(ctx: &AimContext, point: Option<(f32, f32)>) -> Aim {
    let Some((px, py)) = point else {
        return Aim::Center;
    };

    let dx = px - ctx.center.0;
    let dy = py - ctx.center.1;
    if dx * dx + dy * dy < ctx.aim_gate * ctx.aim_gate {
        return Aim::Center;
    }

    // The peek is tested FIRST, and only inside its band. Its region starts outside the picker's
    // own tiles, so there is no point this can take away from them — and in area mode, where a
    // slice owns its share of the plane all the way to the screen edge, this is the only thing
    // that stops the workspace underneath answering for a shortcut drawn beyond it.
    if let Some(shape) = ctx.peek {
        if shape.in_band(dx, dy) {
            if let Some(index) = shape.index_for(dx, dy) {
                // Pointer mode asks the same question of a peek tile that it asks of a slice: is
                // the pointer ON the icon? A band that launched on direction alone would be a
                // different targeting rule for the two rings of one wheel.
                if matches!(ctx.mode, SelectionMode::Cursor) && !ctx.direction_mode {
                    let hit = (shape.icon_size * 0.85).max(22.0);
                    let (tx, ty) = shape.point_of((0.0, 0.0), index);
                    let (ddx, ddy) = (dx - tx, dy - ty);
                    if ddx * ddx + ddy * ddy > hit * hit {
                        return Aim::Nothing;
                    }
                }
                return Aim::Peek(index);
            }
            // Past the ends of a fan: rule 2 in `peek`. The point falls through to the picker,
            // which is what lets a hand pushed out in the wrong direction retarget.
        }
    }
    if ctx.item_count == 0 {
        // An empty level has no slice to launch, and nothing to light either.
        return Aim::Nothing;
    }

    // The same function the wedges are drawn from. It used to be this arithmetic written out at
    // both sites, which is the one bug a launcher cannot afford.
    let candidate = sectors::index_for_delta(dx, dy, ctx.item_count);

    // Pointer mode: the target is the icon UNDER the pointer, not the direction it lies in. The
    // sector gives an O(1) candidate; a single distance check against that one icon decides.
    if matches!(ctx.mode, SelectionMode::Cursor) && !ctx.direction_mode {
        let Some(index) = candidate else {
            return Aim::Nothing;
        };
        let hit_radius = (ctx.icon_size * 0.85).max(22.0);
        let rad = sectors::centre_deg(index, ctx.item_count) * (PI / 180.0);
        let tx = ctx.radius * rad.cos();
        let ty = ctx.radius * rad.sin();
        let (ddx, ddy) = (dx - tx, dy - ty);
        return if ddx * ddx + ddy * ddy <= hit_radius * hit_radius {
            Aim::Slice(index)
        } else {
            Aim::Nothing
        };
    }

    // Direction / area: aiming is giving a direction, and the slice stays the target with the
    // cursor anywhere in the sector — including far outside the ring.
    match candidate {
        Some(index) => Aim::Slice(index),
        None => Aim::Nothing,
    }
}

/// Circular distance in slices from the aimed one, for the presence of every other tile.
pub fn angular_distance(index: usize, active: Option<usize>, count: usize) -> Option<usize> {
    let active = active?;
    let raw = index.abs_diff(active);
    Some(raw.min(count.saturating_sub(raw)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(count: usize, mode: SelectionMode) -> AimContext {
        AimContext {
            center: (500.0, 500.0),
            item_count: count,
            radius: 170.0,
            icon_size: 56.0,
            mode,
            aim_gate: 60.0,
            direction_mode: false,
            peek: None,
        }
    }

    #[test]
    fn no_point_cancels() {
        // The only safe default: a fresh open must not confirm a slice for a hand that never moved.
        assert_eq!(resolve(&ctx(8, SelectionMode::Area), None), Aim::Center);
    }

    #[test]
    fn the_dead_zone_is_the_hub() {
        let c = ctx(8, SelectionMode::Area);
        assert_eq!(resolve(&c, Some((500.0, 520.0))), Aim::Center);
        assert_eq!(resolve(&c, Some((500.0, 559.0))), Aim::Center);
        // Just past it, the direction takes over.
        assert_eq!(resolve(&c, Some((500.0, 580.0))), Aim::Slice(4));
    }

    #[test]
    fn area_mode_reaches_past_the_ring() {
        // The share of the plane has no distance limit: that is what makes one throw in any
        // direction reach every shortcut.
        let c = ctx(8, SelectionMode::Area);
        assert_eq!(resolve(&c, Some((500.0, 100.0))), Aim::Slice(0));
        assert_eq!(resolve(&c, Some((500.0, -4000.0))), Aim::Slice(0));
    }

    #[test]
    fn pointer_mode_only_lights_the_icon_under_it() {
        let c = ctx(8, SelectionMode::Cursor);
        // Straight up at exactly the ring radius: that is item 0's tile.
        assert_eq!(resolve(&c, Some((500.0, 500.0 - 170.0))), Aim::Slice(0));
        // The same direction, far beyond the ring: nothing, and releasing there cancels.
        assert_eq!(resolve(&c, Some((500.0, 100.0))), Aim::Nothing);
    }

    #[test]
    fn direction_mode_ignores_pointer_hit_testing() {
        // With the pointer hidden and parked, the lit slice follows the gesture's vector — the
        // physical pointer is no longer the aim, so the icon-distance test must not apply.
        let mut c = ctx(8, SelectionMode::Cursor);
        c.direction_mode = true;
        assert_eq!(resolve(&c, Some((500.0, 100.0))), Aim::Slice(0));
    }

    #[test]
    fn an_empty_level_has_nothing_to_launch() {
        let c = ctx(0, SelectionMode::Area);
        assert_eq!(resolve(&c, Some((500.0, 100.0))), Aim::Nothing);
        // The hub is still the hub, so the gesture can still be cancelled.
        assert_eq!(resolve(&c, Some((500.0, 500.0))), Aim::Center);
    }

    #[test]
    fn the_gate_is_the_sensitivity_by_direction() {
        // At high sensitivity the slice must light well inside the hub's 60px click target.
        let mut c = ctx(8, SelectionMode::Area);
        c.direction_mode = true;
        c.aim_gate = 18.0;
        assert_eq!(resolve(&c, Some((500.0, 475.0))), Aim::Slice(0));
    }

    fn peek_ctx(count: usize, mode: SelectionMode, style: crate::config::PeekStyle) -> AimContext {
        let mut c = ctx(4, mode);
        c.peek = peek::shape(&peek::Input {
            style,
            item_count: count,
            // Item 0 of a four-item picker: twelve o'clock.
            anchor_deg: sectors::centre_deg(0, 4),
            ring_radius: c.radius,
            ring_icon: c.icon_size,
            min_gap: 10.0,
            viewport: (1920.0, 1080.0),
        });
        c
    }

    #[test]
    fn the_picker_keeps_everything_inside_the_band() {
        // The peek must not take a single point away from the ring it hangs off.
        let c = peek_ctx(6, SelectionMode::Area, crate::config::PeekStyle::Fan);
        assert_eq!(resolve(&c, Some((500.0, 500.0 - 170.0))), Aim::Slice(0));
        assert_eq!(resolve(&c, Some((500.0, 500.0 - 100.0))), Aim::Slice(0));
    }

    #[test]
    fn past_the_band_the_peek_answers() {
        let c = peek_ctx(6, SelectionMode::Area, crate::config::PeekStyle::Fan);
        let shape = c.peek.unwrap();
        for index in 0..6 {
            let (dx, dy) = shape.point_of((0.0, 0.0), index);
            let aim = resolve(&c, Some((500.0 + dx, 500.0 + dy)));
            assert_eq!(aim, Aim::Peek(index), "index={index}");
        }
    }

    #[test]
    fn a_fan_gives_the_far_side_of_the_wheel_back_to_the_picker() {
        // The fan points up; a hand thrown straight down is choosing a workspace, not one of the
        // peeked shortcuts.
        let c = peek_ctx(6, SelectionMode::Area, crate::config::PeekStyle::Fan);
        assert_eq!(resolve(&c, Some((500.0, 1400.0))), Aim::Slice(2));
    }

    #[test]
    fn a_ring_keeps_the_whole_band() {
        // The difference between the two styles, at the one place it decides what launches.
        let c = peek_ctx(6, SelectionMode::Area, crate::config::PeekStyle::Ring);
        assert!(matches!(resolve(&c, Some((500.0, 1400.0))), Aim::Peek(_)));
    }

    #[test]
    fn pointer_mode_still_wants_the_pointer_on_the_peeked_icon() {
        // One targeting rule for both rings: in pointer mode a near miss is a miss on either.
        let c = peek_ctx(6, SelectionMode::Cursor, crate::config::PeekStyle::Ring);
        let shape = c.peek.unwrap();
        let (dx, dy) = shape.point_of((0.0, 0.0), 0);
        assert_eq!(resolve(&c, Some((500.0 + dx, 500.0 + dy))), Aim::Peek(0));
        assert_eq!(resolve(&c, Some((500.0, 500.0 - 2000.0))), Aim::Nothing);
    }

    #[test]
    fn the_hub_outranks_the_peek() {
        // Cancelling has to stay reachable with a ring of shortcuts on screen.
        let c = peek_ctx(6, SelectionMode::Area, crate::config::PeekStyle::Ring);
        assert_eq!(resolve(&c, Some((500.0, 500.0))), Aim::Center);
    }

    #[test]
    fn angular_distance_wraps_the_short_way() {
        assert_eq!(angular_distance(0, Some(0), 8), Some(0));
        assert_eq!(angular_distance(7, Some(0), 8), Some(1));
        assert_eq!(angular_distance(4, Some(0), 8), Some(4));
        assert_eq!(angular_distance(3, None, 8), None);
    }
}
