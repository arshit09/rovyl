//! The peek's geometry: where a hovered workspace's shortcuts sit, outside the picker's own ring.
//!
//! Its own module for the reason [`super::sectors`] is one. The peek adds a SECOND set of targets
//! to a wheel that previously had exactly one, and the thing that must not happen is the hit test
//! and the paint disagreeing about where they are — on a ring the user never clicked their way
//! into, that would mean launching an app they did not point at. There is one [`Shape`]; `aim`
//! resolves against it and `render` draws from it.
//!
//! Three rules, and each one is about a tempting shortcut that does not work.
//!
//! 1. **The band, not the ring, decides whose target a point is.** The peek's tiles are a ring of
//!    their own, but the region that belongs to them starts halfway between the two rings and runs
//!    outward forever. Testing "is the point near a peek tile" instead leaves a corridor between
//!    the rings that belongs to neither, and in area mode — where a slice owns its whole share of
//!    the plane out to the screen edge — it would also hand everything past the peek ring back to
//!    the workspace underneath it.
//!
//! 2. **The fan's arc is allowed to be empty of the band.** Outside the arc, past the band, the
//!    point falls THROUGH to the picker's own slice. That is what lets a hand that pushed outward
//!    in the wrong direction retarget to the workspace it is actually pointing at, instead of
//!    being stuck in a fan it has left.
//!
//! 3. **The ring style wraps; the fan does not.** A full ring's first and last tile are
//!    neighbours, so the angle has to be taken modulo the turn. A fan's are not: beyond its ends
//!    there is no tile, and pretending otherwise would make the shortcut at one end of the arc
//!    answer for a point at the other.

use super::sectors;
use crate::config::PeekStyle;
use std::f32::consts::PI;

/// Angular room the fan is allowed to take, at most.
///
/// Half the plane. Wider and the arc wraps far enough around the wheel that it stops reading as
/// belonging to one direction, which is the only thing the fan is for — at which point the ring
/// style is the honest choice and is one switch away.
const FAN_MAX_SPAN_DEG: f32 = 170.0;

/// Clearance between the picker's tiles and the peek's, before either tile's own half-size.
const RING_GAP_PX: f32 = 18.0;

/// How much more of that clearance the full ring takes.
///
/// A fan sits outside ONE slice, so its tiles are a cluster in one direction and read as belonging
/// to the workspace they point away from. A full ring passes outside every slice at once, and at a
/// fan's clearance the two rings interleave into a single crowded field: the eye has to work out
/// which orbit each icon is on before it can choose. The extra air is what makes them two rings.
const RING_CLEARANCE: f32 = 2.4;

/// Smallest the peek's tiles are allowed to be shrunk to, as a fraction of the picker's.
///
/// A crowded workspace on a small screen cannot have everything: the room is fixed, and the choice
/// is between tiles that overlap and tiles that are small. The floor is what stops "small" turning
/// into "not an icon".
const MIN_ICON_SCALE: f32 = 0.56;

pub struct Input {
    pub style: PeekStyle,
    pub item_count: usize,
    /// The direction the peeked workspace sits in, in the renderer's degrees.
    pub anchor_deg: f32,
    /// The picker's ring radius, and its tile size.
    pub ring_radius: f32,
    pub ring_icon: f32,
    /// `app_spacing`, in pixels.
    pub min_gap: f32,
    pub viewport: (f32, f32),
}

/// Where the peek's tiles are, and which region of the plane is theirs.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Shape {
    pub radius: f32,
    pub icon_size: f32,
    /// The first tile's direction. Tile `i` sits at `start_deg + i * step_deg`.
    pub start_deg: f32,
    pub step_deg: f32,
    pub count: usize,
    /// Whether the last tile and the first are neighbours. See rule 3.
    pub wrap: bool,
    /// Radius past which a point is the peek's rather than the picker's. See rule 1.
    pub band: f32,
}

/// The shape for a peek of this many items, or `None` when there is nothing to lay out.
pub fn shape(input: &Input) -> Option<Shape> {
    let Input {
        style,
        item_count,
        anchor_deg,
        ring_radius,
        ring_icon,
        min_gap,
        viewport,
    } = *input;
    if item_count == 0 {
        return None;
    }

    // The peek's tiles are a little smaller than the picker's: the workspace being pointed at has
    // to stay the larger thing on screen, or the ring that appeared reads as having replaced it.
    let nominal = (ring_icon * 0.86).round();
    let gap = min_gap.max(RING_GAP_PX);
    let clearance = match style {
        PeekStyle::Ring => gap * RING_CLEARANCE,
        PeekStyle::Fan => gap,
    };
    // The floor: clear of the picker's tiles, whatever the packing then asks for.
    let floor = ring_radius + ring_icon / 2.0 + clearance + nominal / 2.0;
    // The ceiling: the same share of the screen the picker's own ring is held to, plus the room
    // one tile needs to sit inside it.
    let ceiling = (viewport.0.min(viewport.1) * 0.52).max(floor);

    let turn = match style {
        PeekStyle::Ring => 360.0,
        PeekStyle::Fan => FAN_MAX_SPAN_DEG,
    };
    // How many steps the tiles have to be spread over. A full ring closes on itself, so `n` tiles
    // make `n` steps; a fan's ends are open, so they make `n - 1`.
    let steps = match style {
        PeekStyle::Ring => item_count as f32,
        PeekStyle::Fan => (item_count as f32 - 1.0).max(1.0),
    };

    // One pass, in the one direction that has a free variable. The spacing a tile needs is an
    // ANGLE at a given radius, so pushing the ring out buys angular room without shrinking
    // anything — that is tried first, and only what the screen refuses to give is taken out of the
    // icons.
    let mut icon = nominal;
    let mut radius = floor;
    for _ in 0..4 {
        // The angle between neighbours' centres that keeps `gap` of air between their edges.
        let needed = step_for(icon + gap, radius);
        let available = turn / steps;
        if needed <= available {
            break;
        }
        // Grow the ring until that angle fits, if the screen allows it.
        let wanted = radius_for(icon + gap, available);
        if wanted <= ceiling {
            radius = wanted;
            break;
        }
        radius = ceiling;
        // Nowhere left to grow: the room comes out of the tiles, bounded.
        let possible = chord(available, radius) - gap;
        let shrunk = (possible / nominal).clamp(MIN_ICON_SCALE, 1.0);
        let next = (nominal * shrunk).round();
        if next >= icon {
            break;
        }
        icon = next;
    }

    let step = (turn / steps).min(step_for(icon + gap, radius));
    let (start_deg, step_deg, wrap) = match style {
        // The workspace's own wheel, drawn outside the picker: item 0 at twelve o'clock and the
        // rest clockwise, exactly as `sectors` lays out every other level. Entering the workspace
        // for real then finds the shortcuts where the peek just showed them.
        PeekStyle::Ring => (sectors::centre_deg(0, item_count), 360.0 / item_count as f32, true),
        // Centred on the workspace, so the arc's middle is the direction the hand is already
        // travelling in.
        PeekStyle::Fan => {
            let span = step * (item_count as f32 - 1.0);
            (anchor_deg - span / 2.0, step, false)
        }
    };

    Some(Shape {
        radius,
        icon_size: icon,
        start_deg,
        step_deg,
        count: item_count,
        wrap,
        // Halfway between the two rings' near edges. See rule 1.
        band: ((ring_radius + ring_icon / 2.0) + (radius - icon / 2.0)) / 2.0,
    })
}

impl Shape {
    /// The direction tile `index` sits in.
    pub fn angle_of(&self, index: usize) -> f32 {
        self.start_deg + index as f32 * self.step_deg
    }

    /// Where tile `index` is drawn, around this centre.
    pub fn point_of(&self, center: (f32, f32), index: usize) -> (f32, f32) {
        let rad = self.angle_of(index) * (PI / 180.0);
        (
            center.0 + self.radius * rad.cos(),
            center.1 + self.radius * rad.sin(),
        )
    }

    /// How far the drawn peek reaches from the centre, tile included.
    pub fn reach(&self) -> f32 {
        self.radius + self.icon_size
    }

    /// Whether a displacement from the centre is in the peek's region at all. See rule 1.
    pub fn in_band(&self, dx: f32, dy: f32) -> bool {
        dx * dx + dy * dy >= self.band * self.band
    }

    /// Which tile a displacement from the centre points at, or `None` when it points past the ends
    /// of a fan. Callers test [`Shape::in_band`] first; this is only the angle.
    pub fn index_for(&self, dx: f32, dy: f32) -> Option<usize> {
        if self.count == 0 {
            return None;
        }
        if self.count == 1 {
            // One tile, and a fan of one has no span to fall outside of. Its share is the half of
            // the band that faces it — never the whole plane, which would make every outward push
            // land on it.
            let delta = signed_delta(dx, dy, self.start_deg);
            return (delta.abs() <= 90.0).then_some(0);
        }
        if self.wrap {
            let turn = self.step_deg * self.count as f32;
            let mut delta = signed_delta(dx, dy, self.start_deg);
            // Into `[0, turn)`, so the tile at one end answers for a point just past the other.
            delta = (delta % turn + turn) % turn;
            let index = ((delta + self.step_deg / 2.0) % turn / self.step_deg).floor() as usize;
            return Some(index.min(self.count - 1));
        }
        let delta = signed_delta(dx, dy, self.start_deg);
        let span = self.step_deg * (self.count - 1) as f32;
        // Rule 2: outside the arc the point is not the peek's, and the picker gets it back.
        if delta < -self.step_deg / 2.0 || delta > span + self.step_deg / 2.0 {
            return None;
        }
        let index = ((delta + self.step_deg / 2.0) / self.step_deg).floor() as isize;
        Some((index.max(0) as usize).min(self.count - 1))
    }
}

/// The widest peek any workspace in this config could ask for, for the window's own sizing.
///
/// The overlay's box and the clamp that keeps the wheel on screen are both fixed when the wheel
/// opens, before any hover has happened. If they were sized for the picker alone, the first peek
/// would be drawn into a window that is not there — clipped tiles, and in a corner, tiles that
/// cannot be aimed at. So the room is reserved for the largest workspace, whether or not that one
/// is the one that gets hovered.
pub fn max_reach(input: &Input, counts: impl Iterator<Item = usize>) -> f32 {
    let mut reach: f32 = 0.0;
    for count in counts {
        let probe = Input { item_count: count, ..*input };
        if let Some(shape) = shape(&probe) {
            reach = reach.max(shape.reach());
        }
    }
    reach
}

/// Degrees from `from_deg` to the direction of `(dx, dy)`, in `(-180, 180]`.
fn signed_delta(dx: f32, dy: f32, from_deg: f32) -> f32 {
    let angle = dy.atan2(dx) * (180.0 / PI);
    let mut delta = angle - from_deg;
    while delta <= -180.0 {
        delta += 360.0;
    }
    while delta > 180.0 {
        delta -= 360.0;
    }
    delta
}

/// The angle two points `width` apart subtend at `radius`.
fn step_for(width: f32, radius: f32) -> f32 {
    if radius <= 0.0 {
        return 360.0;
    }
    let half = (width / 2.0 / radius).clamp(-1.0, 1.0);
    half.asin() * 2.0 * (180.0 / PI)
}

/// The radius at which `width` subtends `step` degrees — [`step_for`] the other way round.
fn radius_for(width: f32, step_deg: f32) -> f32 {
    let half = (step_deg / 2.0) * (PI / 180.0);
    let sin = half.sin();
    if sin <= 1e-4 {
        return f32::MAX / 4.0;
    }
    width / 2.0 / sin
}

/// How wide a tile may be to subtend `step` degrees at `radius`.
fn chord(step_deg: f32, radius: f32) -> f32 {
    2.0 * radius * ((step_deg / 2.0) * (PI / 180.0)).sin()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(style: PeekStyle, count: usize, anchor: f32) -> Input {
        Input {
            style,
            item_count: count,
            anchor_deg: anchor,
            ring_radius: 170.0,
            ring_icon: 56.0,
            min_gap: 10.0,
            viewport: (1920.0, 1080.0),
        }
    }

    fn polar(deg: f32, radius: f32) -> (f32, f32) {
        let rad = deg * (PI / 180.0);
        (radius * rad.cos(), radius * rad.sin())
    }

    #[test]
    fn the_peek_clears_the_pickers_own_tiles() {
        // The two rings must not touch: a tile of one overlapping a tile of the other is two
        // targets in one place, whichever of them the hit test prefers.
        for style in [PeekStyle::Fan, PeekStyle::Ring] {
            for count in 1..24 {
                let s = shape(&input(style, count, -90.0)).unwrap();
                let air = (s.radius - s.icon_size / 2.0) - (170.0 + 56.0 / 2.0);
                assert!(air >= RING_GAP_PX, "{style:?} {count}: {air}");
                // And the ring, which crosses every slice, takes more of it than the fan.
                if matches!(style, PeekStyle::Ring) {
                    assert!(air >= RING_GAP_PX * RING_CLEARANCE, "{count}: {air}");
                }
            }
        }
    }

    #[test]
    fn the_band_sits_between_the_two_rings() {
        let s = shape(&input(PeekStyle::Fan, 6, -90.0)).unwrap();
        // A point on the picker's own tile is not the peek's.
        assert!(!s.in_band(0.0, -170.0));
        // A point on a peek tile is.
        assert!(s.in_band(0.0, -s.radius));
    }

    #[test]
    fn a_fan_is_centred_on_the_workspace_it_belongs_to() {
        let s = shape(&input(PeekStyle::Fan, 5, 30.0)).unwrap();
        let middle = s.angle_of(2);
        assert!((middle - 30.0).abs() < 0.001, "{middle}");
    }

    #[test]
    fn a_fan_of_one_hangs_straight_out_from_its_workspace() {
        let s = shape(&input(PeekStyle::Fan, 1, 30.0)).unwrap();
        assert!((s.angle_of(0) - 30.0).abs() < 0.001);
    }

    #[test]
    fn the_fan_never_takes_more_than_its_span() {
        for count in 2..40 {
            let s = shape(&input(PeekStyle::Fan, count, -90.0)).unwrap();
            let span = s.step_deg * (count - 1) as f32;
            assert!(span <= FAN_MAX_SPAN_DEG + 0.01, "{count}: {span}");
        }
    }

    #[test]
    fn a_fan_hands_a_point_past_its_ends_back_to_the_picker() {
        // Rule 2. Without this a hand that pushed outward in the wrong direction is stuck in a fan
        // it has already left.
        let s = shape(&input(PeekStyle::Fan, 4, -90.0)).unwrap();
        // The workspace's own direction is inside the fan, on one of its middle tiles.
        let (dx, dy) = polar(-90.0, s.radius);
        assert!(matches!(s.index_for(dx, dy), Some(1) | Some(2)));
        // Straight down: the opposite side of the wheel, far outside a fan that points up.
        let (dx, dy) = polar(90.0, s.radius);
        assert_eq!(s.index_for(dx, dy), None);
    }

    #[test]
    fn a_fan_resolves_every_one_of_its_own_tiles() {
        for count in 1..20 {
            let s = shape(&input(PeekStyle::Fan, count, -90.0)).unwrap();
            for index in 0..count {
                let (dx, dy) = polar(s.angle_of(index), s.radius);
                assert_eq!(s.index_for(dx, dy), Some(index), "count={count}");
            }
        }
    }

    #[test]
    fn a_ring_resolves_every_one_of_its_own_tiles() {
        for count in 1..20 {
            let s = shape(&input(PeekStyle::Ring, count, -90.0)).unwrap();
            for index in 0..count {
                let (dx, dy) = polar(s.angle_of(index), s.radius);
                assert_eq!(s.index_for(dx, dy), Some(index), "count={count}");
            }
        }
    }

    #[test]
    fn a_ring_wraps_the_short_way() {
        // Rule 3: the first tile answers for a point just anticlockwise of twelve o'clock.
        let s = shape(&input(PeekStyle::Ring, 8, -90.0)).unwrap();
        let (dx, dy) = polar(-91.0, s.radius);
        assert_eq!(s.index_for(dx, dy), Some(0));
        let (dx, dy) = polar(-89.0, s.radius);
        assert_eq!(s.index_for(dx, dy), Some(0));
    }

    #[test]
    fn a_ring_lays_its_shortcuts_out_where_the_workspace_itself_will() {
        // The peek is a preview: entering the workspace for real has to find the icons in the same
        // places, or the preview taught the wrong thing.
        let s = shape(&input(PeekStyle::Ring, 7, 140.0)).unwrap();
        for index in 0..7 {
            let expected = sectors::centre_deg(index, 7);
            assert!((s.angle_of(index) - expected).abs() < 0.001, "{index}");
        }
    }

    #[test]
    fn a_ring_owns_the_whole_band_and_a_fan_does_not() {
        // The difference is the point of having two styles, so it is pinned here.
        let ring = shape(&input(PeekStyle::Ring, 6, -90.0)).unwrap();
        let fan = shape(&input(PeekStyle::Fan, 6, -90.0)).unwrap();
        let mut ring_misses = 0;
        let mut fan_misses = 0;
        for degrees in 0..360 {
            let (dx, dy) = polar(degrees as f32, 2000.0);
            ring_misses += ring.index_for(dx, dy).is_none() as i32;
            fan_misses += fan.index_for(dx, dy).is_none() as i32;
        }
        assert_eq!(ring_misses, 0);
        assert!(fan_misses > 0);
    }

    #[test]
    fn a_crowded_workspace_shrinks_rather_than_overlaps() {
        // Forty shortcuts on a small screen: whatever the layout does, neighbours must not collide.
        let mut small = input(PeekStyle::Ring, 40, -90.0);
        small.viewport = (900.0, 700.0);
        let s = shape(&small).unwrap();
        let a = s.point_of((0.0, 0.0), 0);
        let b = s.point_of((0.0, 0.0), 1);
        let distance = ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt();
        assert!(distance >= s.icon_size * 0.95, "{distance} vs {}", s.icon_size);
    }

    #[test]
    fn the_reserved_room_covers_every_workspace() {
        // What the window is sized for has to be at least what the largest workspace then draws.
        let probe = input(PeekStyle::Ring, 1, -90.0);
        let reach = max_reach(&probe, [3usize, 9, 21].into_iter());
        for count in [3usize, 9, 21] {
            let s = shape(&input(PeekStyle::Ring, count, -90.0)).unwrap();
            assert!(s.reach() <= reach + 0.01, "{count}");
        }
    }

    #[test]
    fn an_empty_workspace_has_no_shape() {
        assert!(shape(&input(PeekStyle::Fan, 0, -90.0)).is_none());
    }
}
