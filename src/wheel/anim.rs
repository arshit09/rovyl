//! Easing and the animation clock.
//!
//! The Electron build expressed every transition as a CSS variable and let the compositor
//! interpolate, so that "no per-frame work on the main thread" — one commit per open, instead of a
//! spring per icon per frame. Here the frame loop IS the main thread and the interpolation is three
//! multiplications, so the trade does not exist: every animation below is sampled from a clock at
//! paint time.
//!
//! What that buys is the thing the original could not have. A committed CSS transition runs to its
//! end; it cannot be redirected mid-flight by a hand that changed its mind. Sampling means the
//! bloom can be interrupted on any frame — a workspace switched 80 ms into an open re-targets from
//! wherever the tiles currently are, instead of either snapping or finishing a motion toward a
//! layout that is no longer on screen.

use std::time::Instant;

/// `cubic-bezier(x1, y1, x2, y2)`, solved for `y` at `x = t`.
///
/// Newton's method with a bisection fallback, which is what browsers do. Four iterations is enough
/// for a curve this shallow: the residual is under a thousandth of a pixel at any size the wheel is
/// drawn at, and the cost is paid a dozen times a frame rather than per pixel.
pub fn cubic_bezier(x1: f32, y1: f32, x2: f32, y2: f32, t: f32) -> f32 {
    if t <= 0.0 {
        return 0.0;
    }
    if t >= 1.0 {
        return 1.0;
    }

    // The parametric cubic with P0 = (0,0) and P3 = (1,1).
    let bezier = |a: f32, b: f32, u: f32| {
        let v = 1.0 - u;
        3.0 * v * v * u * a + 3.0 * v * u * u * b + u * u * u
    };
    let slope = |a: f32, b: f32, u: f32| {
        let v = 1.0 - u;
        3.0 * v * v * a + 6.0 * v * u * (b - a) + 3.0 * u * u * (1.0 - b)
    };

    let mut u = t;
    for _ in 0..4 {
        let dx = bezier(x1, x2, u) - t;
        if dx.abs() < 1e-5 {
            break;
        }
        let d = slope(x1, x2, u);
        if d.abs() < 1e-6 {
            // A flat segment: Newton cannot move, so finish by bisection.
            let (mut lo, mut hi) = (0.0f32, 1.0f32);
            for _ in 0..12 {
                u = (lo + hi) / 2.0;
                if bezier(x1, x2, u) < t {
                    lo = u;
                } else {
                    hi = u;
                }
            }
            break;
        }
        u -= dx / d;
        u = u.clamp(0.0, 1.0);
    }
    bezier(y1, y2, u)
}

/// `cubic-bezier(.16, .86, .24, 1)` — the slices' entry.
///
/// Progressive expansion with a deceleration long enough that swapping workspace or folder does not
/// look like a hard cut.
pub fn slice_ease(t: f32) -> f32 {
    cubic_bezier(0.16, 0.86, 0.24, 1.0, t)
}

/// `cubic-bezier(.2, .82, .28, 1)` — the shared default for the hub, the pill and the gear.
pub fn ease_out(t: f32) -> f32 {
    cubic_bezier(0.2, 0.82, 0.28, 1.0, t)
}

/// `cubic-bezier(.22, 1, .36, 1)` — the product's standard ease, used by everything in a window.
pub fn standard(t: f32) -> f32 {
    cubic_bezier(0.22, 1.0, 0.36, 1.0, t)
}

/// `cubic-bezier(0.16, 1, 0.3, 1)` — the scrim's fade, which is slower out of the gate than the
/// slices' so the dimming is already under way before anything moves.
pub fn scrim_ease(t: f32) -> f32 {
    cubic_bezier(0.16, 1.0, 0.3, 1.0, t)
}

/// `ease-out`, as CSS defines it: `cubic-bezier(0, 0, .58, 1)`. The opacity channel everywhere.
pub fn css_ease_out(t: f32) -> f32 {
    cubic_bezier(0.0, 0.0, 0.58, 1.0, t)
}

/// A value that moves toward a target over a fixed duration, sampled rather than stepped.
///
/// Holding the START value rather than the elapsed time is what makes an interruption continuous:
/// re-targeting mid-flight restarts the clock from where the value actually is, so there is no jump.
#[derive(Debug, Clone, Copy)]
pub struct Tween {
    from: f32,
    to: f32,
    started: Instant,
    duration_ms: f32,
}

impl Tween {
    pub fn held(value: f32) -> Self {
        Self {
            from: value,
            to: value,
            started: Instant::now(),
            duration_ms: 0.0,
        }
    }

    /// Aim at a new value. A target that is already the current one is left alone, so a frame that
    /// re-asserts the same state does not restart the motion.
    pub fn retarget(&mut self, to: f32, duration_ms: f32, ease: fn(f32) -> f32) {
        if (self.to - to).abs() < 1e-6 {
            return;
        }
        self.from = self.sample(ease);
        self.to = to;
        self.started = Instant::now();
        self.duration_ms = duration_ms.max(0.0);
    }

    /// Jump, with no motion. For a state change the user must not see travel through — a level
    /// swap resets the tiles' positions rather than sliding them from the old layout to the new.
    pub fn set(&mut self, value: f32) {
        self.from = value;
        self.to = value;
        self.duration_ms = 0.0;
    }

    pub fn sample(&self, ease: fn(f32) -> f32) -> f32 {
        if self.duration_ms <= 0.0 {
            return self.to;
        }
        let elapsed = self.started.elapsed().as_secs_f32() * 1000.0;
        if elapsed >= self.duration_ms {
            return self.to;
        }
        self.from + (self.to - self.from) * ease(elapsed / self.duration_ms)
    }

    pub fn target(&self) -> f32 {
        self.to
    }

    /// Whether this still needs frames. The render loop stops asking for them when nothing does.
    pub fn animating(&self) -> bool {
        self.duration_ms > 0.0
            && self.started.elapsed().as_secs_f32() * 1000.0 < self.duration_ms
            && (self.from - self.to).abs() > 1e-6
    }
}

// ─── Durations ──────────────────────────────────────────────────────────────
//
// One place for every number, because several of them have to agree with each other and the
// agreement is not visible at the call sites. The launch echo in particular is both an animation
// and a DELAY before a command is dispatched, and those two cannot drift apart.

/// The slices' entry.
pub const SLICE_IN_MS: f32 = 220.0;
pub const SLICE_IN_OPACITY_MS: f32 = 165.0;
/// The hub's, which is quicker: it is already at the centre and only grows.
pub const HUB_IN_MS: f32 = 160.0;
pub const SCRIM_IN_MS: f32 = 200.0;

/// Leaving. Shorter than entering in every case — a wheel that lingers on the way out reads as
/// lag, because by then the user has already chosen and is waiting for the thing they chose.
pub const EXIT_MS: f32 = 120.0;

/// A switch's knob, and the colour change under it.
///
/// Two clocks for one gesture, because the two channels are eased differently — `standard` for a
/// position, `css_ease_out` for a colour, which is the division everything else in the product
/// already makes. Sampled together they run very nearly in lockstep, with the knob a few per cent
/// AHEAD of the tint the whole way across. That ordering is the one worth keeping: a knob that
/// leads reads as dragging the colour along behind it, where a track that filled first would read
/// as the knob arriving into a change that had already happened without it.
///
/// 160 ms is the travel. Short enough that nobody waits for it, long enough that the eye follows
/// the thing it is holding; both channels are past nine tenths inside 70 ms, and what is left is a
/// pixel or two of creep. The tint is given the shorter clock so that it is FINISHED by then — a
/// switch that went on changing colour under a knob that had stopped would be two events again.
///
/// Keep the tint short if these are ever retuned. The knob's two colours are deliberately opposite
/// polarities — light on the dark track, dark on the solid one — so on the way between them it
/// passes through the colour of the track it is sitting on and is briefly invisible. At 90 ms that
/// crossing is about 4 ms wide in either theme, a quarter of a frame; it widens in proportion to
/// this number, and somewhere past a few hundred milliseconds it becomes a blink.
pub const TOGGLE_KNOB_MS: f32 = 160.0;
pub const TOGGLE_TINT_MS: f32 = 90.0;

/// Launch echo — the only window in which the user sees what they chose.
///
/// Confirming used to be a CUT: the wheel vanished on the same frame the command was dispatched,
/// and what followed was the bare desktop for as long as the app took to open — half a second on a
/// warm app, several on a cold one. Nothing in that gap said which of the icons had been caught, or
/// even that any had: a successful launch and a click that hit nothing were, to the eye, the same
/// event.
///
/// The echo holds the confirmed icon where it already was, fades everything around it and sends a
/// wave out of it. The delay PRECEDES the dispatch rather than running over it: the overlay is
/// always-on-top and the app that opens steals the foreground, so animating afterwards left the
/// wave competing with the new window, or hidden behind it.
///
/// The cost is real and it is this number: the command leaves `ECHO_MS` later. Kept short on
/// purpose — long enough for the eye to register WHICH icon, short enough not to read as the
/// launcher being slow.
pub const ECHO_MS: f32 = 520.0;

/// How long the direction-mode hint has to stay on screen before it counts as read.
///
/// The hint leaves the moment the hand moves, so an open that began with the mouse already in
/// motion flashes it for a frame or two. Without this floor that flash would spend the single
/// showing, and the person who never got to read it is exactly the person who needed it.
pub const DIRECTION_HINT_SEEN_MS: f32 = 900.0;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn beziers_are_pinned_at_both_ends() {
        for ease in [slice_ease, ease_out, standard, scrim_ease, css_ease_out] {
            assert_eq!(ease(0.0), 0.0);
            assert_eq!(ease(1.0), 1.0);
            assert_eq!(ease(-0.5), 0.0);
            assert_eq!(ease(1.5), 1.0);
        }
    }

    #[test]
    fn beziers_are_monotonic() {
        // A non-monotonic solve shows up as a tile that moves backwards mid-flight.
        for ease in [slice_ease, ease_out, standard, scrim_ease, css_ease_out] {
            let mut previous = 0.0;
            for step in 0..=100 {
                let value = ease(step as f32 / 100.0);
                assert!(value >= previous - 1e-4, "went backwards at {step}: {previous} -> {value}");
                previous = value;
            }
        }
    }

    #[test]
    fn an_ease_out_front_loads_the_motion() {
        // Most of the distance in the first third is what makes the wheel feel immediate.
        assert!(slice_ease(0.33) > 0.6, "got {}", slice_ease(0.33));
        assert!(ease_out(0.33) > 0.6, "got {}", ease_out(0.33));
    }

    #[test]
    fn a_zero_duration_tween_is_already_there() {
        let mut t = Tween::held(0.0);
        t.retarget(1.0, 0.0, standard);
        assert_eq!(t.sample(standard), 1.0);
        assert!(!t.animating());
    }

    #[test]
    fn retargeting_the_same_value_does_not_restart() {
        let mut t = Tween::held(0.0);
        t.retarget(1.0, 500.0, standard);
        let first = t.sample(standard);
        t.retarget(1.0, 500.0, standard);
        // Same target: the motion continues rather than beginning again from here.
        assert!(t.sample(standard) >= first);
        assert!(t.animating());
    }

    #[test]
    fn set_jumps_without_travelling() {
        // A level swap must not slide the tiles from the old layout to the new one.
        let mut t = Tween::held(0.0);
        t.retarget(1.0, 500.0, standard);
        t.set(0.0);
        assert_eq!(t.sample(standard), 0.0);
        assert!(!t.animating());
    }

    #[test]
    fn a_switch_settles_its_colour_before_it_stops_moving() {
        // The knob spends its last stretch creeping a pixel or two. A colour still crossing under
        // it then would turn one gesture back into two events.
        assert!(TOGGLE_TINT_MS < TOGGLE_KNOB_MS);
        // Both inside the window where motion still reads as the press rather than as lag.
        assert!(TOGGLE_KNOB_MS < SLICE_IN_MS);
    }

    #[test]
    fn leaving_is_quicker_than_arriving() {
        // A wheel that lingers on the way out reads as lag.
        assert!(EXIT_MS < SLICE_IN_MS);
        assert!(EXIT_MS < HUB_IN_MS);
        assert!(EXIT_MS < SCRIM_IN_MS);
    }
}
