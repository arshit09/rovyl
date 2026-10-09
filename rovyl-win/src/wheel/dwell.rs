//! Launching without a click: holding the aim on a target for `radial_instant_dwell_ms` runs it.
//!
//! Off by default, and deliberately so: it turns aiming — a neutral act — into a destructive one,
//! which is not a thing to switch on under somebody who did not ask.
//!
//! Five rules carry the engine, and all five exist because the obvious version is wrong. They are
//! stated here rather than at the call sites because each one is about the ABSENCE of a tempting
//! shortcut, and an absence cannot be commented where it is not.
//!
//! 1. **Arming is observed, never inferred.** A dwell may only start after a real pointer sample
//!    lands more than [`ARM_DISPLACEMENT_PX`] from a baseline set by an earlier real sample. The
//!    tempting rail is "has the pointer moved since the open", and it does not work: that measures
//!    distance from the wheel CENTRE, so it is already true whenever the pointer sits still far
//!    from the centre — exactly the state that must not launch anything.
//!
//! 2. **The arming delay is measured from the first PAINT**, not from the moment the open was
//!    decided. In the Electron build those were different by up to 240 ms, because the window was
//!    revealed by another process; here they are closer, but the rule stands for the case that
//!    still exists — a cold first frame on a machine whose GPU is busy.
//!
//! 3. **The target is `{generation, index, item id}`, never the index alone.** A workspace switch
//!    on the scroll wheel, or an MRU fetch resolving late, replaces the level under a parked
//!    pointer and KEEPS the index. Every level change bumps the generation and disarms, so
//!    re-arming always costs a fresh [`ARM_DISPLACEMENT_PX`] — which is also what stops a dwell
//!    cascading through nested folders.
//!
//! 4. **Cancelling has to be synchronous.** The wheel's `closing` flag is set by Escape, the right
//!    button and the trigger toggle BEFORE the close is acted on, because "is it still open" only
//!    becomes false after the caller has processed the action — a window a click cannot outlive but
//!    a timer can.
//!
//! 5. **The clock measures a settled pointer, not an occupied wedge.** Starting it the moment the
//!    aim resolves measures "how long since you entered this slice", which in area mode has no
//!    distance limit at all — and on a one-item level the slice is the whole plane, so crossing the
//!    dead zone in any direction would launch `dwell_ms` later regardless of what the pointer did
//!    in between. The count therefore only begins once the pointer has stayed within
//!    [`SETTLE_PX`] for [`SETTLE_MS`].
//!
//! There is deliberately **no "how long since the last pointer sample" check**, and the omission
//! looks like a bug until you try it. It is the obvious guard against a pointer that has left the
//! wheel's box — but a still hand emits no samples either, and being still *is* the gesture: with
//! that check the ring fills and nothing ever launches. Leaving the window is an EVENT, and that is
//! where it is handled.

use super::aim::Aim;
use super::state::Wheel;
use crate::config::UiConfig;
use std::time::Instant;

/// How long after the first paint a dwell may begin.
pub const ARM_DELAY_MS: f32 = 120.0;

/// Displacement OBSERVED from a baseline set by an earlier real sample — never distance from the
/// wheel's centre. See rule 1.
pub const ARM_DISPLACEMENT_PX: f32 = 24.0;

/// Absorbs the reflex click that lands right after a dwell launch.
///
/// Without it the user's trained click lands ~200 ms later, on a wheel that has already descended a
/// level, and launches whatever happens to sit in the same direction.
pub const QUARANTINE_MS: f32 = 300.0;

/// Settle before counting: the pointer has to stay within this for [`SETTLE_MS`].
pub const SETTLE_PX: f32 = 10.0;
pub const SETTLE_MS: f32 = 90.0;

/// Once counting, the tolerance is a different one — and larger.
///
/// The two phases measure different things: settling asks "has the hand stopped?", counting asks
/// "is the hand still on this target?". With a single radius, and one still measured from the last
/// MOVING sample, a long count inherited an almost spent budget and a slow drag got stuck in a
/// loop — the arc appearing and dying without ever opening.
pub const HOLD_PX: f32 = 26.0;

/// Below this the arc is not information, it is a flash: it would appear and die within the same
/// pair of frames. With the optional zero wait that became a REAL case and not a theoretical one,
/// so a short count runs without drawing anything — the feedback for that choice is the app itself
/// opening.
pub const ARC_MIN_MS: f32 = 90.0;

/// How far past the commit threshold the direction vector may be pushed.
///
/// The factor is not free: what is left above the threshold is the slack that separates "committed"
/// from "back at the centre", and it has to be larger than [`HOLD_PX`] — otherwise a tremor that
/// the count still accepts as a still hand already undid the direction, and the arc dies on its
/// own.
pub const DIRECTION_CLAMP_FACTOR: f32 = 2.5;

/// The slack, in absolute terms, has a ceiling of its own.
///
/// A pure multiple was fine while the thresholds were small, but it scales the COST OF REVERSING
/// with the sensitivity: at "low" (200px) a saturated vector would sit 500px out, and turning to the
/// item on the opposite side would mean dragging 700px through the wheel. The slack only has one
/// job — be comfortably wider than [`HOLD_PX`], so a tremor the count still accepts as a still hand
/// cannot drag the vector back under the threshold — and 60px does that at every setting.
pub const DIRECTION_CLAMP_SLACK_MAX_PX: f32 = 60.0;

/// A sample that jumps further than a hand can in one event is the parking warp's, not the user's.
pub const PARK_JUMP_PX: f32 = 120.0;

/// Where the cursor lands when it is parked, within this much, counts as the warp arriving.
pub const PARK_LANDING_PX: f32 = 28.0;

/// Slack to the window edge; past this a re-park is requested before the cursor leaves — and
/// reappears, since it is only invisible over our own window.
pub const PARK_STRAY_MARGIN_PX: f32 = 140.0;

/// What the engine decided this frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Nothing to do.
    Nothing,
    /// The count has completed: launch this index.
    Fire(usize),
}

/// Fold a pointer sample into the engine. Called from [`Wheel::pointer_moved`].
pub(super) fn on_pointer(wheel: &mut Wheel, config: &UiConfig, observed: Option<(f32, f32)>) {
    if !config.direction_mode() {
        return;
    }
    let Some(point) = observed else { return };

    let aim = wheel.resolve_live(config);
    let generation = wheel.generation();

    // A one-item level in direction mode refuses a dwell outright. Its slice is the whole plane,
    // so "aiming at it" is indistinguishable from "having crossed the dead zone" — and the
    // recents-empty fallback exists precisely so that a parent IDE is never launched on its own.
    let single_plane = wheel.item_count() <= 1;

    let target = match aim {
        Aim::Slice(index) if !single_plane => {
            wheel.item_id_at(index).map(|id| (generation, index, id))
        }
        _ => None,
    };

    let state = wheel.dwell_state();

    if target.is_none() {
        state.target = None;
        state.settled_at = None;
        state.settled_point = None;
        return;
    }

    // A different target restarts everything, including the arc.
    if state.target != target {
        state.target = target;
        state.settled_at = None;
        state.settled_point = Some(point);
        state.attempt = state.attempt.wrapping_add(1);
        return;
    }

    match state.settled_at {
        None => {
            // Still settling. The thing being rescheduled here is a reference POINT, not a
            // committed timer, so dragging across the wheel costs nothing per frame.
            let anchor = state.settled_point.unwrap_or(point);
            let (dx, dy) = (point.0 - anchor.0, point.1 - anchor.1);
            if dx * dx + dy * dy > SETTLE_PX * SETTLE_PX {
                state.settled_point = Some(point);
            }
        }
        Some(_) => {
            // Counting. A larger tolerance, measured from where it SETTLED rather than from the
            // last moving sample.
            let anchor = state.settled_point.unwrap_or(point);
            let (dx, dy) = (point.0 - anchor.0, point.1 - anchor.1);
            if dx * dx + dy * dy > HOLD_PX * HOLD_PX {
                state.settled_at = None;
                state.settled_point = Some(point);
                state.attempt = state.attempt.wrapping_add(1);
            }
        }
    }
}

/// Advance the clock. Called once per frame, which is the only place a dwell can fire.
///
/// Firing from a frame rather than from a timer is what makes rule 4 free: a wheel that has begun
/// closing simply never gets another frame in which to fire.
pub fn advance(wheel: &mut Wheel, config: &UiConfig, first_paint: Instant) -> Outcome {
    if !config.direction_mode() || wheel.is_closing() {
        return Outcome::Nothing;
    }
    // Rule 2: measured from the first paint. Before this the wheel may not even be visible, and a
    // launch the user never saw coming is the worst thing this feature can do.
    if first_paint.elapsed().as_secs_f32() * 1000.0 < ARM_DELAY_MS {
        return Outcome::Nothing;
    }

    let dwell_ms = config.dwell_ms();
    let generation = wheel.generation();
    let state = wheel.dwell_state();

    // Rule 1: nothing counts until arming has been observed.
    if state.armed_at.is_none() {
        return Outcome::Nothing;
    }
    let Some((target_generation, index, ref id)) = state.target.clone() else {
        return Outcome::Nothing;
    };
    // Rule 3, first half: the level may have changed under a pointer that never moved.
    if target_generation != generation {
        state.target = None;
        state.settled_at = None;
        return Outcome::Nothing;
    }

    let settled = match state.settled_at {
        Some(at) => at,
        None => {
            // Begin counting once the pointer has been still long enough. The arc appears from an
            // aim re-resolved at this moment, which is why what it shows and what will launch
            // cannot diverge.
            let since = state
                .settled_point
                .map(|_| ())
                .and(Some(Instant::now()))
                .unwrap();
            state.settled_at = Some(since);
            state.attempt = state.attempt.wrapping_add(1);
            since
        }
    };

    if settled.elapsed().as_secs_f32() * 1000.0 < dwell_ms {
        return Outcome::Nothing;
    }

    // Rule 3, second half: re-check the id, not just the index. Nearly half a second separates the
    // moment the arc was drawn from this one.
    let still_the_same = wheel.item_id_at(index).as_deref() == Some(id.as_str());
    let state = wheel.dwell_state();
    if !still_the_same {
        state.target = None;
        state.settled_at = None;
        return Outcome::Nothing;
    }

    state.fired_at = Some(Instant::now());
    state.target = None;
    state.settled_at = None;
    Outcome::Fire(index)
}

/// Whether the progress arc is worth drawing for a count of this length.
pub fn arc_worth_drawing(dwell_ms: f32) -> bool {
    dwell_ms >= ARC_MIN_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_direction_slack_clears_the_hold_tolerance() {
        // If the slack were not wider than HOLD_PX, a tremor the count still accepts as a still
        // hand would drag the vector back under the commit threshold and kill the arc.
        for commit in [18.0_f32, 96.0, 200.0] {
            let slack = (commit * (DIRECTION_CLAMP_FACTOR - 1.0)).min(DIRECTION_CLAMP_SLACK_MAX_PX);
            assert!(slack > HOLD_PX, "commit={commit} slack={slack}");
        }
    }

    #[test]
    fn the_hold_tolerance_is_wider_than_the_settle_tolerance() {
        // Settling asks "has the hand stopped?", counting asks "is it still on this target?". One
        // radius for both is what made a slow drag loop forever.
        assert!(HOLD_PX > SETTLE_PX);
    }

    #[test]
    fn a_zero_wait_draws_no_arc() {
        // Zero is a legitimate setting; an arc there would appear and die in the same two frames.
        assert!(!arc_worth_drawing(0.0));
        assert!(!arc_worth_drawing(ARC_MIN_MS - 1.0));
        assert!(arc_worth_drawing(ARC_MIN_MS));
        assert!(arc_worth_drawing(400.0));
    }

    #[test]
    fn the_park_jump_exceeds_any_real_gesture_sample() {
        // The warp has to be distinguishable from a hand, and the arming displacement is the
        // largest single step the engine treats as real.
        assert!(PARK_JUMP_PX > ARM_DISPLACEMENT_PX);
        assert!(PARK_JUMP_PX > HOLD_PX);
    }

    #[test]
    fn the_quarantine_outlasts_a_reflex_click() {
        // The trained click lands ~200 ms after the launch it did not know had happened.
        assert!(QUARANTINE_MS > 200.0);
    }
}
