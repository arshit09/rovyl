//! The wheel's state machine: which level is on screen, what is aimed at, and what a gesture does.
//!
//! Everything here is pure — it takes a config and events and produces a level and a target. It
//! never touches a window, a device or the shell, which is what lets the navigation rules be tested
//! as rules. The things it cannot do itself it RETURNS: a launch, a close, a workspace write. The
//! caller performs them.
//!
//! That split is not stylistic. In the original these decisions lived inside a 4,000-line React
//! component together with the painting and the IPC, and the comments on it describe the resulting
//! class of bug repeatedly: a level that changed under a parked pointer, a timer that fired against
//! a wheel already sent away, a confirmation that resolved from state rather than from the live
//! pointer. Each of those is a question about ordering between navigation and everything else, and
//! they are answerable here in a way they are not when the three are interleaved.

use super::aim::{self, Aim, AimContext};
use super::anim::{self, Tween};
use super::layout::{self, Layout};
use crate::config::{
    self, AppItem, CenterKind, ItemKind, SelectionMode, UiConfig, Workspace,
};
use std::time::Instant;

/// The prefix that marks a synthetic workspace-picker item. The real workspace index follows it.
const WS_PICK_PREFIX: &str = "__zenith_ws_pick__";

/// What the caller has to do as a result of an event.
///
/// Returned rather than performed, so that "what does this gesture mean" is decided in one place
/// and "how is it carried out" in another. A `Launch` is also the only way the wheel closes with
/// something chosen, which is what makes one launch path serve the ring, the docks and the keyboard.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    /// Nothing to do, but the frame changed.
    Redraw,
    /// Nothing changed at all; the caller need not even repaint.
    Idle,
    /// Take the wheel down with nothing chosen.
    Close,
    /// Run this item, then take the wheel down. The item is passed by value because it may not
    /// exist in the saved config — an MRU entry, or a dock icon.
    Launch(Box<AppItem>),
    /// The active workspace changed and has to be persisted.
    WorkspaceChanged(usize),
    /// Fetch this item's most-recently-used list. The answer arrives later, via
    /// [`Wheel::recents_arrived`].
    FetchRecents(Box<AppItem>),
    /// Put Settings up and take the wheel down.
    OpenSettings,
    /// The direction-mode hint has been read and does not come back.
    DirectionHintSeen,
}

/// One level of the wheel: a list of items and the name the pill shows for it.
#[derive(Debug, Clone)]
struct Level {
    label: String,
    items: Vec<AppItem>,
    /// The item this level was opened from, so a recents level can inherit its terminal settings.
    parent: Option<Box<AppItem>>,
}

/// Why the wheel is up, which decides what releasing the trigger means.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TriggerSource {
    /// A click of the mouse trigger: the wheel stays up and a second click or a release confirms.
    MouseClick,
    /// The mouse trigger held down: releasing it confirms whatever is aimed at.
    MouseHold,
    /// The global shortcut.
    Shortcut,
}

/// The launch echo: which slice was confirmed, and when.
#[derive(Debug, Clone, Copy)]
struct Echo {
    index: Option<usize>,
    center: bool,
    at: Instant,
}

pub struct Wheel {
    pub open: bool,
    /// The wheel's centre, in the overlay window's client pixels.
    pub center: (f32, f32),
    pub viewport: (f32, f32),
    /// The monitor's scale factor, for turning the config's DIP sizes into pixels.
    pub scale: f32,

    /// Folder stack. Empty means the root level.
    stack: Vec<Level>,
    /// The root, rebuilt whenever the workspace or the config changes.
    root: Level,
    /// What has been typed on the wheel.
    filter: String,

    active: Option<usize>,
    center_active: bool,
    /// The freshest pointer position, in client pixels. `None` on a fresh open: the previous
    /// gesture's position is stale and sits far from the new centre, so believing it would confirm
    /// a slice for somebody who never moved the mouse.
    pointer: Option<(f32, f32)>,

    pub source: TriggerSource,
    /// Set SYNCHRONOUSLY by every cancellation path before the close is acted on.
    ///
    /// It exists because "is the wheel still open" arrives late through any queue: a dwell timer
    /// survives the window between a cancel and the close, and would fire against a wheel the user
    /// has just sent away.
    closing: bool,
    exiting_since: Option<Instant>,
    echo: Option<Echo>,

    bloom: Tween,
    layout: Layout,
    hub_diameter: f32,
    /// Whether this gesture has already launched something. A second confirmation from the same
    /// hold would launch twice.
    consumed: bool,

    /// Which level generation the pointer's arming belongs to. Every level change bumps it, which
    /// disarms the clickless launch — and that is what stops a dwell cascading through nested
    /// folders.
    level_generation: u64,

    dwell: Dwell,
    direction: Direction,
    hint_shown_at: Option<Instant>,
    hint_reported: bool,
    /// A press on the hub that has not yet decided whether it is a click or a carry.
    hub_drag: Option<HubDrag>,
}

/// Carrying the wheel by its middle.
#[derive(Debug, Clone, Copy)]
struct HubDrag {
    /// The pointer's displacement from the centre at the moment of the press, held FIXED for the
    /// whole carry. That is what makes the wheel feel picked up rather than snapped to the cursor.
    ///
    /// A displacement, not a position — which is why it survives the overlay growing underneath
    /// it. Both the pointer and the centre are in client pixels and both shift by exactly the
    /// window's movement, so the difference between them does not change.
    offset: (f32, f32),
    /// Where the press landed, in SCREEN pixels.
    ///
    /// Screen and not client, so the slop is measured against a frame that does not move. In
    /// client coordinates the window growing at the moment of commitment would read as several
    /// hundred pixels of hand movement.
    start: (i32, i32),
    moved: bool,
}

/// What a move during a press on the hub amounts to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Carry {
    /// Still a click. The hand has not travelled far enough to mean anything else.
    Pending,
    /// It has just become a carry. The caller must make room BEFORE placing the wheel: the box it
    /// was born in is a few hundred pixels wider than the ring and no further.
    Began,
    /// Being carried.
    Moving,
}

/// The sustained-aim engine's own state. See [`super::dwell`] for the rules.
#[derive(Debug, Default)]
pub(super) struct Dwell {
    /// Where a real pointer sample last sat, for the arming displacement test.
    pub(super) anchor: Option<(f32, f32)>,
    pub(super) armed_at: Option<Instant>,
    /// The target the clock is counting against: `(generation, index, item id)`.
    ///
    /// The id is part of it because a workspace switch on the scroll wheel, or an MRU fetch
    /// resolving late, replaces the level under a parked pointer and KEEPS the index.
    pub(super) target: Option<(u64, usize, String)>,
    /// When the pointer settled. The count only begins once it has stayed put.
    pub(super) settled_at: Option<Instant>,
    /// Where it settled, for the hold tolerance.
    pub(super) settled_point: Option<(f32, f32)>,
    /// A dwell has fired; the next click within the quarantine is swallowed.
    pub(super) fired_at: Option<Instant>,
    /// Bumped on every attempt, so the progress arc restarts.
    pub(super) attempt: u64,
}

/// Direction aiming — the mode the clickless launch lives in.
///
/// The pointer is hidden and parked at the wheel's centre, so the slice comes from the VECTOR the
/// hand drew from there, not from the position the cursor happened to already be at. The vector is
/// accumulated from the deltas of each move, which makes it immune to the starting point — which
/// was exactly the defect: opening the wheel with the mouse low lit the bottom item on the first
/// tremor, and the dwell launched it without anyone having chosen anything.
#[derive(Debug, Default)]
struct Direction {
    vector: (f32, f32),
    /// The last raw sample, to take deltas from.
    last_raw: Option<(f32, f32)>,
}

impl Wheel {
    pub fn new(config: &UiConfig) -> Self {
        let root = build_root(config);
        Self {
            open: false,
            center: (0.0, 0.0),
            viewport: (0.0, 0.0),
            scale: 1.0,
            stack: Vec::new(),
            root,
            filter: String::new(),
            active: None,
            center_active: false,
            pointer: None,
            source: TriggerSource::Shortcut,
            closing: false,
            exiting_since: None,
            echo: None,
            bloom: Tween::held(0.0),
            layout: Layout { radius: 170.0, icon_size: 56.0 },
            hub_diameter: 62.0,
            consumed: false,
            level_generation: 0,
            dwell: Dwell::default(),
            hub_drag: None,
            direction: Direction::default(),
            hint_shown_at: None,
            hint_reported: false,
        }
    }

    // ── Level reads ─────────────────────────────────────────────────────────

    fn level(&self) -> &Level {
        self.stack.last().unwrap_or(&self.root)
    }

    pub fn is_root(&self) -> bool {
        self.stack.is_empty()
    }

    /// Whether the root is the workspace picker rather than a workspace's own shortcuts.
    pub fn root_is_picker(&self, config: &UiConfig) -> bool {
        config.enabled_workspace_count() > 1
    }

    /// The items on screen: the level, narrowed by what has been typed.
    pub fn items(&self) -> Vec<AppItem> {
        filter_items(&self.level().items, &self.filter)
    }

    pub fn item_count(&self) -> usize {
        // Counted without cloning: `items()` allocates, and this is read several times a frame.
        if self.filter.trim().is_empty() {
            self.level().items.len()
        } else {
            self.items().len()
        }
    }

    pub fn filter(&self) -> &str {
        &self.filter
    }

    pub fn active(&self) -> Option<usize> {
        self.active
    }

    pub fn center_active(&self) -> bool {
        self.center_active
    }

    /// The lit item's ID.
    pub fn active_item_id(&self) -> Option<String> {
        self.item_id_at(self.active?)
    }

    /// What the highlight is on, as the notes hear it — see [`crate::sys::sound::Highlight`].
    ///
    /// The one place the three states are named, so the hover note cannot disagree with what is lit
    /// about what counts as a change.
    pub fn highlight(&self) -> crate::sys::sound::Highlight {
        use crate::sys::sound::Highlight;
        if let Some(id) = self.active_item_id() {
            return Highlight::Item(id);
        }
        if self.center_active {
            return Highlight::Hub;
        }
        Highlight::Nothing
    }

    pub fn layout(&self) -> Layout {
        self.layout
    }

    pub fn hub_diameter(&self) -> f32 {
        self.hub_diameter
    }

    /// The breadcrumb the pill shows: the workspace, then each folder entered.
    ///
    /// Inside a workspace its name is enough — "Rovyl" identifies the root. In picker mode the root
    /// IS the choice of workspace, so naming the one picked last time read as "you are in X" before
    /// anything had been picked.
    pub fn breadcrumb(&self, config: &UiConfig) -> Vec<String> {
        if self.is_root() {
            let name = if self.root_is_picker(config) {
                "Workspaces".to_string()
            } else {
                config
                    .active_workspace()
                    .map(|w| w.name.clone())
                    .filter(|n| !n.is_empty())
                    .unwrap_or_else(|| "Rovyl".to_string())
            };
            return vec![name];
        }
        self.stack.iter().map(|l| l.label.clone()).collect()
    }

    pub fn bloom(&self) -> f32 {
        self.bloom.sample(anim::slice_ease)
    }

    pub fn scrim_bloom(&self) -> f32 {
        self.bloom.sample(anim::scrim_ease)
    }

    pub fn hub_bloom(&self) -> f32 {
        self.bloom.sample(anim::ease_out)
    }

    pub fn exiting(&self) -> bool {
        self.exiting_since.is_some()
    }

    /// Which slice the launch echo is holding, and how far through it is (0..1).
    pub fn echo(&self) -> Option<(Option<usize>, f32)> {
        let echo = self.echo?;
        let progress =
            (echo.at.elapsed().as_secs_f32() * 1000.0 / anim::ECHO_MS).clamp(0.0, 1.0);
        Some((if echo.center { None } else { echo.index }, progress))
    }

    pub fn echo_is_center(&self) -> bool {
        self.echo.map(|e| e.center).unwrap_or(false)
    }

    /// Whether the progress arc should be drawn, and on which slice.
    ///
    /// It appears only once the pointer has settled, from an aim re-resolved at that moment, and
    /// both the moment it is drawn and the moment it launches re-check the target triple — nearly
    /// half a second separates the two, and the level can change under a pointer that never moved.
    pub fn dwell_arc(&self) -> Option<(usize, f32, u64)> {
        let (_, index, _) = self.dwell.target.as_ref()?;
        let settled = self.dwell.settled_at?;
        Some((
            *index,
            settled.elapsed().as_secs_f32() * 1000.0,
            self.dwell.attempt,
        ))
    }

    /// Whether anything on screen still needs frames.
    pub fn animating(&self) -> bool {
        self.bloom.animating()
            || self.echo.is_some()
            || self.exiting_since.is_some()
            || self.dwell.settled_at.is_some()
    }

    // ── Opening and closing ─────────────────────────────────────────────────

    /// Open the wheel. `center` and `viewport` are in the overlay's client pixels.
    pub fn open(
        &mut self,
        config: &UiConfig,
        source: TriggerSource,
        center: (f32, f32),
        viewport: (f32, f32),
        scale: f32,
    ) {
        self.root = build_root(config);
        self.stack.clear();
        self.filter.clear();
        self.center = center;
        self.viewport = viewport;
        self.scale = scale;
        self.source = source;
        self.open = true;
        self.closing = false;
        self.exiting_since = None;
        self.echo = None;
        self.consumed = false;
        self.dwell = Dwell::default();
        self.direction = Direction::default();
        self.hint_shown_at = None;
        self.hint_reported = false;
        self.level_generation += 1;

        // A carry belongs to the gesture that started it. A wheel sent away mid-drag -- by the
        // right button, by Escape, by anything -- must not leave the next one believing it is
        // already being held: the first mouse move would then throw it across the screen.
        self.hub_drag = None;

        // A fresh open, pointer unknown. Without this the PREVIOUS open's position is left over,
        // and it sits far from the new centre: releasing the button without moving the mouse would
        // confirm a slice. `None` resolves to the centre, that is, to cancelling — the only safe
        // default.
        self.pointer = None;
        self.active = None;
        self.center_active = true;

        self.relayout(config);
        // The tiles mount collapsed at the hub and expand from there, so the open reads as a bloom
        // out of the point the gesture happened at.
        self.bloom.set(0.0);
        self.bloom.retarget(1.0, anim::SLICE_IN_MS, anim::slice_ease);
    }

    /// Begin the exit. The window stays up for `EXIT_MS` so the wheel can be seen leaving.
    pub fn begin_exit(&mut self) {
        if self.exiting_since.is_some() {
            return;
        }
        self.closing = true;
        self.exiting_since = Some(Instant::now());
        self.bloom.retarget(0.0, anim::EXIT_MS, anim::ease_out);
        self.dwell = Dwell::default();
    }

    /// Whether the exit has finished and the window may be hidden.
    pub fn exit_done(&self) -> bool {
        self.exiting_since
            .map(|at| at.elapsed().as_secs_f32() * 1000.0 >= anim::EXIT_MS)
            .unwrap_or(false)
    }

    pub fn close_now(&mut self) {
        self.open = false;
        self.closing = false;
        self.exiting_since = None;
        self.echo = None;
        self.pointer = None;
        self.active = None;
        self.bloom.set(0.0);
    }

    /// Recompute the ring for the current item count and viewport.
    pub fn relayout(&mut self, config: &UiConfig) {
        let count = self.item_count();
        // The config's sizes are in DIPs; everything drawn is in pixels.
        self.layout = layout::compute(&layout::LayoutInput {
            item_count: count,
            icon_size: config.icon_size * self.scale,
            min_gap: config.app_spacing * self.scale,
            menu_radius: config.menu_radius * self.scale,
            activation_threshold: config.activation_threshold * self.scale,
            viewport: self.viewport,
        });
        self.hub_diameter = layout::hub_diameter(config.icon_size * self.scale, &self.layout);
    }

    /// How far the drawn wheel reaches from its centre, for the placement clamp.
    ///
    /// The ring plus a whole tile, so the outer edge of an icon still lands on the screen when the
    /// pointer is in a corner. Deliberately NOT the window's own half-extent, which is several
    /// hundred pixels wider: clamping by that would push the wheel a quarter of a screen inward
    /// from a corner the user deliberately opened it in.
    pub fn ring_reach(&self) -> f32 {
        layout::ring_reach(&self.layout)
    }

    // ── Carrying the wheel ──────────────────────────────────────────────────

    /// Whether a point is on the hub's own target.
    pub fn hub_contains(&self, client: (f32, f32)) -> bool {
        let half = layout::hub_hit_size(self.hub_diameter) / 2.0;
        (client.0 - self.center.0).abs() <= half && (client.1 - self.center.1).abs() <= half
    }

    /// A press on the hub. Nothing is decided here.
    ///
    /// It is still a click until the hand has travelled `HUB_DRAG_SLOP_PX`, because the hub has an
    /// action of its own and every pixel of slop is lag on a control that is pressed constantly.
    ///
    /// Refused by direction, where the real pointer is hidden and parked at the centre: every
    /// sample there is a direction rather than a place, so there is no hand on screen to carry
    /// anything with.
    pub fn begin_hub_drag(
        &mut self,
        config: &UiConfig,
        screen: (i32, i32),
        client: (f32, f32),
    ) -> bool {
        if !self.open || self.closing || config.direction_mode() || self.hub_drag.is_some() {
            return false;
        }
        if !self.hub_contains(client) {
            return false;
        }
        self.hub_drag = Some(HubDrag {
            offset: (client.0 - self.center.0, client.1 - self.center.1),
            start: screen,
            moved: false,
        });
        true
    }

    pub fn hub_dragging(&self) -> bool {
        self.hub_drag.is_some()
    }

    /// Whether the carry has actually moved the wheel, as opposed to being a click so far.
    pub fn hub_drag_moved(&self) -> bool {
        self.hub_drag.is_some_and(|drag| drag.moved)
    }

    /// A move while the hub is held.
    pub fn hub_drag_move(&mut self, screen: (i32, i32)) -> Carry {
        let Some(drag) = self.hub_drag.as_mut() else {
            return Carry::Pending;
        };
        if drag.moved {
            return Carry::Moving;
        }
        let dx = (screen.0 - drag.start.0) as f32;
        let dy = (screen.1 - drag.start.1) as f32;
        if dx * dx + dy * dy < layout::HUB_DRAG_SLOP_PX * layout::HUB_DRAG_SLOP_PX {
            return Carry::Pending;
        }
        drag.moved = true;
        // Nothing that was counting towards a launch survives the wheel moving under it.
        self.dwell = Dwell::default();
        self.level_generation += 1;
        Carry::Began
    }

    /// Put the wheel where the hand is, clamped so none of the ring leaves the screen.
    pub fn hub_drag_place(&mut self, client: (f32, f32)) {
        let Some(drag) = self.hub_drag else {
            return;
        };
        if !drag.moved {
            return;
        }
        self.center = layout::clamp_wheel_center(
            (client.0 - drag.offset.0, client.1 - drag.offset.1),
            self.viewport,
            self.ring_reach(),
        );
        // The aim travels with the wheel. The pointer is inside the hub — it never left it, the
        // wheel followed it — so the centre is the honest answer, and recording it here is what
        // stops the release a moment later from confirming a slice the hand never pointed at.
        self.pointer = Some(client);
        self.active = None;
        self.center_active = true;
    }

    /// The hand let go. Returns whether this was a carry rather than a click.
    pub fn end_hub_drag(&mut self) -> bool {
        self.hub_drag.take().is_some_and(|drag| drag.moved)
    }

    /// The window moved under the wheel, so everything measured from its corner has to move too.
    ///
    /// Both halves have to land together. Applying the centre without the viewport paints the
    /// wheel at its new-frame position inside the old box; applying the viewport without the
    /// centre clamps it against an extent it is no longer expressed in.
    pub fn reframe(&mut self, shift: (f32, f32), viewport: (f32, f32)) {
        self.center = (self.center.0 + shift.0, self.center.1 + shift.1);
        self.viewport = viewport;
        if let Some(pointer) = self.pointer.as_mut() {
            pointer.0 += shift.0;
            pointer.1 += shift.1;
        }
    }

    /// Where the lit section of the wheel ends and the long dissolve begins.
    ///
    /// The scrim's pool is built around this, and so is the wedges' falloff — the two have to agree
    /// or the highlight would stop somewhere the dimming does not, which reads as a ring drawn
    /// around the wheel. Comfortably past the icon ring, so everything inside it is the part with
    /// the shortcuts in it.
    pub fn backdrop_radius(&self, config: &UiConfig) -> f32 {
        let min_gap = config.app_spacing * self.scale;
        (self.layout.radius + self.layout.icon_size * 0.75 + min_gap.max(18.0 * self.scale)).ceil()
    }

    /// Where the area wedges stop: as far as they can go, which is the nearest edge of the window.
    ///
    /// The NEAREST, not the farthest corner, and that is the whole constraint. The wedge's gradient
    /// is built to reach exactly zero at this radius; anything drawn past the window is cut, and a
    /// cut through alpha that is not yet zero is a straight line across the desktop — the one thing
    /// the scrim itself is carefully built never to produce. An inscribed circle is the largest
    /// shape whose own fade is guaranteed to finish inside the frame.
    ///
    /// They used to stop at the backdrop radius, where the scrim's pool starts fading. That kept
    /// the highlight tidy but short: it hugged the wheel, and the fade had to happen in the last
    /// thirty pixels, which is a visible edge no matter how it is shaped. Reaching the frame gives
    /// the fade hundreds of pixels to disappear in — and it is also the honest picture, because the
    /// pointer really can be anywhere on that side of the screen and still launch the item.
    ///
    /// The floor covers the pathological case — a wheel clamped hard against a corner. There the
    /// tiles are already at the edge and the wedges are not what is wrong.
    pub fn sector_outer_radius(&self) -> f32 {
        let to_edge = self
            .center
            .0
            .min(self.center.1)
            .min(self.viewport.0 - self.center.0)
            .min(self.viewport.1 - self.center.1)
            .floor();
        (self.layout.radius + self.layout.icon_size * 0.6)
            .round()
            .max(to_edge)
    }

    /// Where the wedges start owning the pointer.
    ///
    /// Floored at the hub's own radius so a high sensitivity — which pulls the aim gate in to
    /// ~18px — does not draw the seams across the middle button.
    pub fn sector_inner_radius(&self, config: &UiConfig) -> f32 {
        let gate = if config.direction_mode() {
            config.direction_commit_px() * self.scale
        } else {
            layout::dead_zone_radius(config.activation_threshold * self.scale, self.hub_diameter)
        };
        gate.max(self.hub_diameter / 2.0 + 8.0 * self.scale)
    }

    // ── Aiming ──────────────────────────────────────────────────────────────

    fn aim_context(&self, config: &UiConfig) -> AimContext {
        let direction_mode = config.direction_mode();
        let dead_zone =
            layout::dead_zone_radius(config.activation_threshold * self.scale, self.hub_diameter);
        AimContext {
            center: self.center,
            item_count: self.item_count(),
            radius: self.layout.radius,
            icon_size: self.layout.icon_size,
            mode: config.selection_mode(),
            // By direction, what rules is the SENSITIVITY and not the cancel zone: the dead zone
            // is the size of the middle BUTTON, and in a clickless gesture there is not even a
            // pointer to hit it with.
            aim_gate: if direction_mode {
                config.direction_commit_px() * self.scale
            } else {
                dead_zone
            },
            direction_mode,
        }
    }

    /// The target for the live pointer, re-resolved now.
    ///
    /// Every confirmation goes through this rather than reading `active`: state travels through a
    /// queue and a frame, and releasing mid-move used to confirm the slice the pointer had already
    /// left.
    pub fn resolve_live(&self, config: &UiConfig) -> Aim {
        aim::resolve(&self.aim_context(config), self.effective_pointer(config))
    }

    /// The point the aim is taken from.
    ///
    /// In direction mode this is not the pointer at all: it is the centre plus the accumulated
    /// vector, because the physical pointer is parked and hidden. The two diverge by construction,
    /// and letting the physical one decide meant confirming one thing with another one lit.
    fn effective_pointer(&self, config: &UiConfig) -> Option<(f32, f32)> {
        if config.direction_mode() {
            let (vx, vy) = self.direction.vector;
            if vx == 0.0 && vy == 0.0 {
                return None;
            }
            return Some((self.center.0 + vx, self.center.1 + vy));
        }
        self.pointer
    }

    /// A real pointer sample arrived.
    pub fn pointer_moved(&mut self, config: &UiConfig, point: (f32, f32)) -> Action {
        if !self.open || self.closing {
            return Action::Idle;
        }

        if config.direction_mode() {
            self.accumulate_direction(config, point);
        } else {
            self.pointer = Some(point);
        }

        // Arming is OBSERVED, never inferred. A dwell may only start after a real move lands more
        // than `ARM_DISPLACEMENT_PX` from a baseline set by an earlier real move. The tempting
        // rail is "has the pointer moved at all since the open", and it does not work: that
        // measures distance from the wheel CENTRE, so it is already true whenever the pointer sits
        // still far from the centre — exactly the state that must not launch anything.
        let observed = self.direction_or_pointer(config);
        match self.dwell.anchor {
            None => self.dwell.anchor = observed,
            Some(anchor) => {
                if let Some(now) = observed {
                    let (dx, dy) = (now.0 - anchor.0, now.1 - anchor.1);
                    if dx * dx + dy * dy
                        >= super::dwell::ARM_DISPLACEMENT_PX * super::dwell::ARM_DISPLACEMENT_PX
                        && self.dwell.armed_at.is_none()
                    {
                        self.dwell.armed_at = Some(Instant::now());
                    }
                }
            }
        }

        let previous = (self.active, self.center_active);
        let aim = self.resolve_live(config);
        self.apply_aim(aim);
        super::dwell::on_pointer(self, config, observed);

        if (self.active, self.center_active) == previous {
            Action::Redraw
        } else {
            // The highlight changed, which is also what the hover note plays on.
            Action::Redraw
        }
    }

    fn direction_or_pointer(&self, config: &UiConfig) -> Option<(f32, f32)> {
        self.effective_pointer(config)
    }

    fn accumulate_direction(&mut self, config: &UiConfig, point: (f32, f32)) {
        let Some(last) = self.direction.last_raw else {
            self.direction.last_raw = Some(point);
            return;
        };
        let (dx, dy) = (point.0 - last.0, point.1 - last.1);
        self.direction.last_raw = Some(point);

        // The parking warp reaches us as an ordinary move — and as a jump of hundreds of pixels,
        // which added to the vector would point opposite to the gesture. A sample that jumps
        // further than a hand can in one event is the teleport's: it becomes the new reference and
        // its delta is thrown away.
        if dx * dx + dy * dy >= super::dwell::PARK_JUMP_PX * super::dwell::PARK_JUMP_PX {
            return;
        }

        let commit = config.direction_commit_px() * self.scale;
        // The vector is clamped to a multiple of the sensitivity because this is a DIRECTION, not a
        // position: with no ceiling, turning from top to bottom after a wide gesture meant undoing
        // the whole path. With a ceiling, reversing always costs roughly the same.
        //
        // What is left above the threshold is the slack that separates "committed" from "back at
        // the centre", and it has to be larger than the dwell's hold tolerance — otherwise a
        // tremor the count still accepts as a still hand already undid the direction.
        let slack = (commit * (super::dwell::DIRECTION_CLAMP_FACTOR - 1.0))
            .min(super::dwell::DIRECTION_CLAMP_SLACK_MAX_PX * self.scale);
        let ceiling = commit + slack;

        let (mut vx, mut vy) = self.direction.vector;
        vx += dx;
        vy += dy;
        let length = (vx * vx + vy * vy).sqrt();
        if length > ceiling && length > 0.0 {
            vx = vx / length * ceiling;
            vy = vy / length * ceiling;
        }
        self.direction.vector = (vx, vy);
    }

    fn apply_aim(&mut self, aim: Aim) {
        match aim {
            Aim::Center => {
                self.center_active = true;
                self.active = None;
            }
            Aim::Slice(index) => {
                self.center_active = false;
                self.active = Some(index);
            }
            Aim::Nothing => {
                self.center_active = false;
                self.active = None;
            }
        }
    }

    /// Re-resolve the aim after a level change, so the new level arrives with the slice under the
    /// cursor already lit.
    ///
    /// Entering or leaving a level swaps the items under a cursor that has not moved, and since the
    /// highlight is only recomputed on a move, the new level used to come up entirely dark until
    /// the mouse was nudged.
    fn level_changed(&mut self, config: &UiConfig) {
        // Entering or leaving a level disarms the clickless launch, no exceptions: arming again
        // always costs fresh, OBSERVED displacement. This is what stops a dwell launch cascading
        // through nested folders — and it also covers the level swaps nobody gestured for, such as
        // an MRU fetch resolving after the user has already navigated elsewhere.
        self.level_generation += 1;
        self.dwell = Dwell::default();
        // Changing level is navigating, not confirming: the next gesture has to count again.
        self.consumed = false;

        // By direction the new level has to be born neutral. The direction that opened the folder
        // went on pointing the same way inside it, and the dwell immediately opened the item on
        // that side — one folder chained into the next without anyone choosing anything. Zeroing
        // the vector demands NEW movement, which is what the arming rule already does by position.
        if config.direction_mode() {
            self.direction = Direction::default();
            self.pointer = None;
        }

        self.relayout(config);
        // The level's own bloom: the tiles come out of the hub again rather than sliding from the
        // previous level's positions to the new ones.
        self.bloom.set(0.0);
        self.bloom.retarget(1.0, anim::SLICE_IN_MS, anim::slice_ease);

        let aim = self.resolve_live(config);
        self.apply_aim(aim);
    }

    // ── Navigation ──────────────────────────────────────────────────────────

    /// Act on an item: switch workspace, enter a folder, fetch recents, or launch.
    pub fn activate(&mut self, config: &mut UiConfig, index: usize) -> Action {
        if self.closing || self.consumed {
            return Action::Idle;
        }
        let items = self.items();
        let Some(item) = items.get(index).cloned() else {
            return Action::Idle;
        };

        // A click also disarms the engine, and that matters in exactly one place. Every branch
        // below changes the level synchronously — which is what normally disarms — except the MRU
        // fetch, which only starts a spinner and waits. Without an explicit disarm, a timer already
        // counting on the tile just clicked would push the same folder a second time, and the
        // gesture would stay live to launch whatever the pointer drifted onto while the user waited.
        self.dwell = Dwell::default();

        if let Some(ws_index) = workspace_pick_index(&item.id) {
            return self.switch_workspace(config, ws_index);
        }

        if item.is_folder() {
            let children = item.child_slice().to_vec();
            self.filter.clear();
            self.stack.push(Level {
                label: item.label.clone(),
                items: children,
                parent: Some(Box::new(item)),
            });
            self.level_changed(config);
            return Action::Redraw;
        }

        if item.wants_recents() {
            return Action::FetchRecents(Box::new(item));
        }

        self.begin_echo(Some(index), false);
        Action::Launch(Box::new(item))
    }

    /// The most-recently-used list for the item a [`Action::FetchRecents`] asked about.
    pub fn recents_arrived(&mut self, config: &UiConfig, parent: &AppItem, mut recents: Vec<AppItem>) {
        // A late answer for a level the user has already left must not shove a ring onto the
        // screen. The wheel being closed is the obvious case; the subtler one is having navigated
        // somewhere else in the meantime.
        if !self.open || self.closing {
            return;
        }

        if recents.is_empty() {
            // When "recent folders" is on but the fetch is empty or failed, show one explicit
            // slice — never auto-launch the parent IDE, which is what a single-item level would
            // do under a dwell.
            recents = vec![AppItem {
                id: format!("{}__recents-empty-fallback", parent.id),
                label: "No recent folders".into(),
                command: parent.command.clone(),
                command_type: Some(parent.resolved_command_type()),
                icon_name: if parent.icon_name.is_empty() {
                    "AppWindow".into()
                } else {
                    parent.icon_name.clone()
                },
                icon_source: parent.icon_source,
                custom_icon_url: parent.custom_icon_url.clone(),
                description: parent.label.clone(),
                ..AppItem::default()
            }];
        } else {
            // The parent's terminal settings travel down to every MRU slice: opening a project
            // means opening it the way that item is configured to.
            let commands: Vec<String> = parent
                .terminal_commands
                .clone()
                .unwrap_or_default()
                .into_iter()
                .filter(|c| !c.trim().is_empty())
                .collect();
            let wants_terminal = parent.open_terminal_for_recents.unwrap_or(false);
            if wants_terminal || !commands.is_empty() {
                for item in recents.iter_mut() {
                    item.open_terminal = Some(true);
                    if !commands.is_empty() {
                        item.terminal_commands = Some(commands.clone());
                    }
                    item.launch_mode = parent.launch_mode;
                }
            }
        }

        self.filter.clear();
        self.stack.push(Level {
            label: parent.label.clone(),
            items: recents,
            parent: Some(Box::new(parent.clone())),
        });
        self.level_changed(config);
    }

    /// Leave the current level, or act on the centre button at the root.
    pub fn center_activate(&mut self, config: &mut UiConfig) -> Action {
        if self.closing {
            return Action::Idle;
        }
        if !self.stack.is_empty() {
            self.stack.pop();
            self.filter.clear();
            self.level_changed(config);
            return Action::Redraw;
        }
        match config.center_button.kind {
            // `Widget` is a removed feature kept only so old configs parse; it closes like `None`.
            CenterKind::None | CenterKind::Cancel | CenterKind::Widget => {
                self.begin_exit();
                Action::Close
            }
            CenterKind::App | CenterKind::Command => {
                if config.center_button.target.trim().is_empty() {
                    self.begin_exit();
                    return Action::Close;
                }
                self.begin_echo(None, true);
                Action::Launch(Box::new(AppItem {
                    id: "__center__".into(),
                    label: config.center_button.label.clone(),
                    icon_name: config.center_button.icon_name.clone(),
                    command: config.center_button.target.clone(),
                    command_type: config.center_button.command_type,
                    ..AppItem::default()
                }))
            }
        }
    }

    /// What the hub says it does, for the pill's chip.
    pub fn center_label(&self, config: &UiConfig) -> &'static str {
        if !self.stack.is_empty() {
            return "Back";
        }
        match config.center_button.kind {
            CenterKind::App | CenterKind::Command
                if !config.center_button.target.trim().is_empty() =>
            {
                "Open"
            }
            _ => "Cancel",
        }
    }

    pub fn switch_workspace(&mut self, config: &mut UiConfig, index: usize) -> Action {
        if index >= config.workspaces.len() || !config.workspaces[index].enabled {
            return Action::Idle;
        }
        if config.active_workspace_index == index && self.stack.is_empty() && !self.is_picker_root(config) {
            return Action::Idle;
        }
        config.active_workspace_index = index;
        self.root = build_root(config);
        self.stack.clear();
        self.filter.clear();
        // Picking a workspace from the picker drops INTO it, which is the whole point of the
        // picker: the root is the choice, and the choice leads somewhere.
        if self.root_is_picker(config) {
            let apps = config.workspaces[index].apps.clone();
            let name = config.workspaces[index].name.clone();
            self.stack.push(Level {
                label: name,
                items: apps,
                parent: None,
            });
        }
        self.level_changed(config);
        Action::WorkspaceChanged(index)
    }

    fn is_picker_root(&self, config: &UiConfig) -> bool {
        self.stack.is_empty() && self.root_is_picker(config)
    }

    /// Step to the next or previous enabled workspace — the mouse wheel's gesture.
    pub fn cycle_workspace(&mut self, config: &mut UiConfig, forward: bool) -> Action {
        let enabled: Vec<usize> = config
            .workspaces
            .iter()
            .enumerate()
            .filter(|(_, w)| w.enabled)
            .map(|(i, _)| i)
            .collect();
        if enabled.len() < 2 {
            return Action::Idle;
        }
        let current = enabled
            .iter()
            .position(|&i| i == config.active_workspace_index)
            .unwrap_or(0);
        let next = if forward {
            (current + 1) % enabled.len()
        } else {
            (current + enabled.len() - 1) % enabled.len()
        };
        self.switch_workspace(config, enabled[next])
    }

    // ── Confirmation ────────────────────────────────────────────────────────

    /// Confirm whatever the LIVE pointer is on. The release of a held trigger, and the click of a
    /// tile, both come here.
    pub fn confirm(&mut self, config: &mut UiConfig) -> Action {
        if self.closing || self.consumed {
            return Action::Idle;
        }
        // A dwell has just fired; the user's trained click lands ~200 ms later, on a wheel that has
        // already descended a level, and would launch whatever happens to sit in the same
        // direction.
        if let Some(fired) = self.dwell.fired_at {
            if fired.elapsed().as_secs_f32() * 1000.0 < super::dwell::QUARANTINE_MS {
                return Action::Idle;
            }
        }
        match self.resolve_live(config) {
            Aim::Center => self.center_activate(config),
            Aim::Slice(index) => self.activate(config, index),
            // Past the dead zone but on nothing — pointer mode, released away from every icon.
            Aim::Nothing => {
                self.begin_exit();
                Action::Close
            }
        }
    }

    fn begin_echo(&mut self, index: Option<usize>, center: bool) {
        self.consumed = true;
        self.echo = Some(Echo {
            index,
            center,
            at: Instant::now(),
        });
    }

    /// Whether the echo has run its course, so the command may be dispatched and the window hidden.
    pub fn echo_done(&self) -> bool {
        self.echo
            .map(|e| e.at.elapsed().as_secs_f32() * 1000.0 >= anim::ECHO_MS)
            .unwrap_or(false)
    }

    // ── Keyboard ────────────────────────────────────────────────────────────

    /// A character typed at the wheel: filter.
    pub fn type_char(&mut self, config: &UiConfig, ch: char) -> Action {
        if self.closing || ch.is_control() {
            return Action::Idle;
        }
        self.filter.push(ch);
        self.after_filter(config)
    }

    pub fn backspace(&mut self, config: &mut UiConfig) -> Action {
        if self.closing {
            return Action::Idle;
        }
        if self.filter.pop().is_some() {
            return self.after_filter(config);
        }
        // Nothing typed: Backspace leaves the folder, which is the gesture people reach for.
        if !self.stack.is_empty() {
            return self.center_activate(config);
        }
        Action::Idle
    }

    fn after_filter(&mut self, config: &UiConfig) -> Action {
        self.relayout(config);
        // Filtering reshapes the ring, so the aim has to be re-resolved — the slice under the
        // cursor is a different item now.
        let aim = self.resolve_live(config);
        self.apply_aim(aim);
        // A filtered ring is a new layout, not a new level: the tiles move to their new angles
        // rather than being reborn at the hub.
        self.bloom.retarget(1.0, anim::SLICE_IN_MS, anim::slice_ease);
        Action::Redraw
    }

    pub fn clear_filter(&mut self, config: &UiConfig) -> Action {
        if self.filter.is_empty() {
            return Action::Idle;
        }
        self.filter.clear();
        self.after_filter(config)
    }

    /// Launch by number, 1–9. Only when `radial_number_launch` is on.
    pub fn launch_number(&mut self, config: &mut UiConfig, digit: usize) -> Action {
        if !config.number_launch() || digit == 0 || digit > 9 {
            return Action::Idle;
        }
        self.activate(config, digit - 1)
    }

    /// Whether the back key would do anything right now.
    ///
    /// It only fires where the hub actually says "Back": one level deep or more, with nothing
    /// typed. At the root there is nothing to leave, so the key goes back to being a character the
    /// filter can have — which is what keeps `qBittorrent` reachable with the default binding.
    pub fn back_key_active(&self, config: &UiConfig) -> bool {
        !config.back_key().is_empty() && !self.stack.is_empty() && self.filter.is_empty()
    }

    // ── The direction hint ──────────────────────────────────────────────────

    /// Whether the "push toward a target" hint is on screen.
    ///
    /// It used to come back on every open until the hand moved — right for someone meeting the
    /// mode, furniture for everyone else. It is now spent the first time it has been on screen long
    /// enough to have been read, and does not come back.
    pub fn direction_hint_visible(&mut self, config: &UiConfig) -> bool {
        if !config.direction_mode() || config.has_seen_direction_hint == Some(true) {
            return false;
        }
        // It leaves the moment the hand moves.
        if self.direction.vector != (0.0, 0.0) {
            return false;
        }
        if self.hint_shown_at.is_none() {
            self.hint_shown_at = Some(Instant::now());
        }
        true
    }

    /// Spend the hint's one showing, if it has been up long enough to have been read.
    ///
    /// Deferred to the close on purpose — spending the flag with the wheel still up would pull the
    /// hint off screen mid-sentence, punishing the one person it was written for.
    pub fn take_direction_hint_seen(&mut self) -> Option<Action> {
        if self.hint_reported {
            return None;
        }
        let shown = self.hint_shown_at?;
        if shown.elapsed().as_secs_f32() * 1000.0 < anim::DIRECTION_HINT_SEEN_MS {
            return None;
        }
        self.hint_reported = true;
        Some(Action::DirectionHintSeen)
    }

    // ── Accessors the dwell engine needs ────────────────────────────────────

    pub(super) fn dwell_state(&mut self) -> &mut Dwell {
        &mut self.dwell
    }

    pub(super) fn generation(&self) -> u64 {
        self.level_generation
    }

    pub(super) fn item_id_at(&self, index: usize) -> Option<String> {
        // Read without filtering when nothing is typed: `items()` clones the whole level, and this
        // is asked once a frame by both the dwell and the hover note.
        if self.filter.trim().is_empty() {
            return self.level().items.get(index).map(|i| i.id.clone());
        }
        self.items().get(index).map(|i| i.id.clone())
    }

    pub(super) fn is_closing(&self) -> bool {
        self.closing
    }
}

// ─── Level construction ─────────────────────────────────────────────────────

/// Root level of the wheel: the home launcher — every workspace, one slice each.
///
/// This used to be a choice: the home launcher, or the current workspace's shortcuts with keys to
/// switch between spaces. The two were never alternatives in practice — the launcher shows the
/// spaces AND the keys still reach them from it — so the setting only asked people to give one up
/// to have the other, and it is gone.
///
/// One workspace is the exception, and it is not a special case so much as the absence of one: a
/// launcher offering a single destination is a step that asks to be skipped, so the wheel opens on
/// that workspace's shortcuts and there is nothing to launch from.
fn build_root(config: &UiConfig) -> Level {
    if config.enabled_workspace_count() <= 1 {
        let apps = config
            .active_workspace()
            .map(|w| w.apps.clone())
            .unwrap_or_default();
        return Level {
            label: config
                .active_workspace()
                .map(|w| w.name.clone())
                .unwrap_or_default(),
            items: apps,
            parent: None,
        };
    }
    Level {
        label: "Workspaces".into(),
        items: workspace_picker_items(config),
        parent: None,
    }
}

/// Synthetic items — one per enabled workspace, with the real workspace index in the id.
pub fn workspace_picker_items(config: &UiConfig) -> Vec<AppItem> {
    config
        .workspaces
        .iter()
        .enumerate()
        .filter(|(_, ws)| ws.enabled)
        .map(|(index, ws)| {
            let key = config::workspace_key_at(ws, index);
            AppItem {
                id: format!("{WS_PICK_PREFIX}{index}"),
                kind: Some(ItemKind::App),
                label: ws.name.clone(),
                icon_name: ws
                    .picker_icon_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Layers")
                    .to_string(),
                // A chosen picture is drawn like any shortcut's; the glyph stays underneath as its
                // fallback.
                icon_source: Some(if ws.picker_icon_url.is_some() {
                    config::IconSource::Custom
                } else {
                    config::IconSource::Lucide
                }),
                custom_icon_url: ws.picker_icon_url.clone(),
                command: String::new(),
                command_type: Some(config::CommandType::App),
                // The key it actually answers to — recorded or positional — not the digit of its
                // place in the list.
                description: if key.is_empty() {
                    String::new()
                } else {
                    format!("({key})")
                },
                ..AppItem::default()
            }
        })
        .collect()
}

pub fn workspace_pick_index(id: &str) -> Option<usize> {
    id.strip_prefix(WS_PICK_PREFIX)?.parse().ok()
}

pub fn is_workspace_pick(id: &str) -> bool {
    id.starts_with(WS_PICK_PREFIX)
}

/// The level, narrowed to what has been typed on the wheel.
///
/// Two rules, in order, and the order is the point. A PREFIX match is what someone typing "sp" for
/// Spotify means, so those come first and in their original ring order; a match ANYWHERE in the
/// name is what saves them when the app is called "Visual Studio Code" and they typed "code".
/// Mixing the two by score would reorder the ring on nearly every keystroke, and a ring that
/// reshuffles as you type is one you cannot aim at — the whole reason for filtering in the first
/// place.
///
/// The second rule waits for a second character. One letter is inside almost every name — "s" is
/// in Discord and in Visual Studio Code — so applying it there kept five of seven slices and
/// narrowed nothing. A single letter therefore means "the ones that START with it", which is what
/// pressing one letter has meant in every list since menus had letters.
///
/// Case- and space-insensitive, so "visual studio" — typed the way anyone types it — matches
/// "Visual Studio Code". It is NOT an initials match: "vscode" does not find that app, because
/// matching initials means scoring, and scoring means the ring reorders on a keystroke.
pub fn filter_items(items: &[AppItem], query: &str) -> Vec<AppItem> {
    let needle: String = query
        .chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect();
    if needle.is_empty() {
        return items.to_vec();
    }
    let use_contains = needle.chars().count() >= 2;

    let mut prefix: Vec<AppItem> = Vec::new();
    let mut contains: Vec<AppItem> = Vec::new();
    for item in items {
        if item.label.is_empty() {
            continue;
        }
        let label: String = item
            .label
            .chars()
            .filter(|c| !c.is_whitespace())
            .flat_map(char::to_lowercase)
            .collect();
        if label.starts_with(&needle) {
            prefix.push(item.clone());
        } else if use_contains && label.contains(&needle) {
            contains.push(item.clone());
        }
    }
    prefix.extend(contains);
    prefix
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::defaults;

    fn config_with(workspaces: Vec<Workspace>) -> UiConfig {
        UiConfig {
            workspaces,
            ..defaults::ui_config()
        }
    }

    fn app(id: &str, label: &str) -> AppItem {
        AppItem {
            id: id.into(),
            label: label.into(),
            command: format!("{id}.exe"),
            ..AppItem::default()
        }
    }

    fn folder(id: &str, label: &str, children: Vec<AppItem>) -> AppItem {
        AppItem {
            id: id.into(),
            label: label.into(),
            kind: Some(ItemKind::Folder),
            children: Some(children),
            ..AppItem::default()
        }
    }

    /// An open wheel at a known centre, on a known viewport.
    fn carried_wheel(cfg: &UiConfig) -> Wheel {
        let mut wheel = Wheel::new(cfg);
        wheel.open(cfg, TriggerSource::Shortcut, (500.0, 400.0), (1920.0, 1040.0), 1.0);
        wheel.settle_for_probe();
        wheel.center = (500.0, 400.0);
        wheel.viewport = (1920.0, 1040.0);
        wheel
    }

    fn one_space() -> UiConfig {
        config_with(vec![Workspace {
            id: "w".into(),
            name: "Main".into(),
            apps: vec![app("a", "Alpha"), app("b", "Beta"), app("c", "Gamma")],
            enabled: true,
            ..Workspace::default()
        }])
    }

    #[test]
    fn pointer_targeting_sounds_on_every_icon_a_sweep_crosses() {
        // Pointer targeting hits the ICON, so the dead space between the icons is a real state: a
        // sweep around the ring reads item -> nothing -> item. Every arrival has to sound and no
        // gap may, and the note that only fired when one sample happened to land on two icons in a
        // row is why the sound "sometimes" worked.
        use crate::sys::sound::{note_for_highlight, Highlight, HIGHLIGHT_QUIET_MS};
        let mut cfg = one_space();
        cfg.radial_selection_mode = Some(SelectionMode::Cursor);
        let mut wheel = carried_wheel(&cfg);
        let radius = wheel.layout().radius;
        let later = HIGHLIGHT_QUIET_MS + 1;

        let mut sounded: Vec<&'static str> = Vec::new();
        let mut arrived: Vec<String> = Vec::new();
        let mut saw_a_gap = false;
        let mut previous = wheel.highlight();
        // Two degrees at a time: finer than the icons are wide, so no step can jump an icon.
        for step in 0..180 {
            let radians = (step as f32 * 2.0).to_radians();
            let point = (
                wheel.center.0 + radius * radians.cos(),
                wheel.center.1 + radius * radians.sin(),
            );
            wheel.pointer_moved(&cfg, point);
            let lit = wheel.highlight();
            if lit == previous {
                continue;
            }
            if let Some(note) = note_for_highlight(&lit, true, later, Some("sub-tick"), Some("thump"))
            {
                sounded.push(note);
                if let Highlight::Item(id) = &lit {
                    arrived.push(id.clone());
                }
            }
            saw_a_gap |= lit == Highlight::Nothing;
            previous = lit;
        }

        assert!(saw_a_gap, "the sweep never crossed dead space, so it proves nothing");
        arrived.sort();
        assert_eq!(arrived, vec!["a", "b", "c"], "sounded: {sounded:?}");
        // One note per arrival: the gaps are silent, so the count is the icons and nothing else.
        assert_eq!(sounded.len(), 3, "{sounded:?}");
        assert!(sounded.iter().all(|note| *note == "thump"), "{sounded:?}");
    }

    #[test]
    fn area_targeting_has_no_gaps_to_fall_into() {
        // The other half of the same rule: by area every direction belongs to a slice, so the
        // sweep goes item -> item and the note still fires exactly once per icon.
        use crate::sys::sound::Highlight;
        let cfg = one_space();
        let mut wheel = carried_wheel(&cfg);
        let radius = wheel.layout().radius;
        let mut changes = 0;
        let mut previous = wheel.highlight();
        for step in 0..180 {
            let radians = (step as f32 * 2.0).to_radians();
            let point = (
                wheel.center.0 + radius * radians.cos(),
                wheel.center.1 + radius * radians.sin(),
            );
            wheel.pointer_moved(&cfg, point);
            let lit = wheel.highlight();
            assert_ne!(lit, Highlight::Nothing, "a sector should always be lit by area");
            if lit != previous {
                changes += 1;
                previous = lit;
            }
        }
        // The aim starts on the hub, because no pointer has been seen yet: one change leaving it,
        // then one per sector boundary the full circle crosses.
        assert_eq!(changes, 4);
    }

    #[test]
    fn a_carry_does_not_survive_the_wheel_it_belonged_to() {
        // Sent away mid-drag. The next open must not believe it is already being held, or the
        // first mouse move throws it across the screen.
        let cfg = one_space();
        let mut wheel = carried_wheel(&cfg);
        assert!(wheel.begin_hub_drag(&cfg, (500, 400), (500.0, 400.0)));
        assert_eq!(wheel.hub_drag_move((540, 440)), Carry::Began);

        wheel.open(&cfg, TriggerSource::Shortcut, (500.0, 400.0), (1920.0, 1040.0), 1.0);
        assert!(!wheel.hub_dragging());
        assert!(!wheel.hub_drag_moved());
    }

    #[test]
    fn only_a_press_on_the_hub_can_become_a_carry() {
        let cfg = one_space();
        let mut wheel = carried_wheel(&cfg);
        // Out on the ring: that is an aim, and it must stay one.
        assert!(!wheel.begin_hub_drag(&cfg, (700, 400), (700.0, 400.0)));
        assert!(!wheel.hub_dragging());
        // On the hub.
        assert!(wheel.begin_hub_drag(&cfg, (500, 400), (500.0, 400.0)));
        assert!(wheel.hub_dragging());
        // And a second press while one is in flight changes nothing.
        assert!(!wheel.begin_hub_drag(&cfg, (500, 400), (500.0, 400.0)));
    }

    #[test]
    fn by_direction_there_is_no_hand_on_screen_to_carry_with() {
        // The real pointer is hidden and parked at the centre there, so every sample is a
        // direction rather than a place. A carry would be dragging something that is not moving.
        let mut cfg = one_space();
        cfg.radial_instant_activate = Some(crate::config::InstantActivate::Dwell);
        let mut wheel = carried_wheel(&cfg);
        assert!(!wheel.begin_hub_drag(&cfg, (500, 400), (500.0, 400.0)));
    }

    #[test]
    fn it_stays_a_click_until_the_hand_has_actually_travelled() {
        // The hub has an action of its own, and every pixel of slop is lag on a control that is
        // pressed constantly -- so the threshold is small, and nothing happens below it.
        let cfg = one_space();
        let mut wheel = carried_wheel(&cfg);
        assert!(wheel.begin_hub_drag(&cfg, (500, 400), (500.0, 400.0)));
        assert_eq!(wheel.hub_drag_move((502, 401)), Carry::Pending);
        assert!(!wheel.hub_drag_moved());
        // Still a click: the release is owed to the hub.
        assert!(!wheel.end_hub_drag());
    }

    #[test]
    fn crossing_the_slop_commits_once_and_then_carries() {
        let cfg = one_space();
        let mut wheel = carried_wheel(&cfg);
        assert!(wheel.begin_hub_drag(&cfg, (500, 400), (500.0, 400.0)));
        // `Began` is what tells the caller to make room, and it must be said exactly once: a
        // second one would resize the window mid-carry, moving the wheel out from under the hand.
        assert_eq!(wheel.hub_drag_move((520, 400)), Carry::Began);
        assert_eq!(wheel.hub_drag_move((560, 400)), Carry::Moving);
        assert_eq!(wheel.hub_drag_move((600, 400)), Carry::Moving);
        assert!(wheel.hub_drag_moved());
        // And the release is the carry's, not the hub's.
        assert!(wheel.end_hub_drag());
        assert!(!wheel.hub_dragging());
    }

    #[test]
    fn the_wheel_is_picked_up_rather_than_snapped_to_the_cursor() {
        let cfg = one_space();
        let mut wheel = carried_wheel(&cfg);
        // Pressed 12 right and 7 down of the centre, which is still inside the hub.
        assert!(wheel.begin_hub_drag(&cfg, (512, 407), (512.0, 407.0)));
        assert_eq!(wheel.hub_drag_move((562, 457)), Carry::Began);
        wheel.hub_drag_place((562.0, 457.0));
        // The grab offset is held for the whole carry, so the centre keeps its distance from the
        // hand instead of jumping under it.
        assert_eq!(wheel.center, (550.0, 450.0));
    }

    #[test]
    fn a_carry_cannot_take_the_ring_off_the_screen() {
        // The clamp is by the RING and not by the hub: a wheel whose far side is off the monitor
        // is a wheel with shortcuts that cannot be aimed at. They asked to move it, not to lose
        // half of it.
        let cfg = one_space();
        let mut wheel = carried_wheel(&cfg);
        let reach = wheel.ring_reach();
        assert!(wheel.begin_hub_drag(&cfg, (500, 400), (500.0, 400.0)));
        assert_eq!(wheel.hub_drag_move((520, 400)), Carry::Began);

        wheel.hub_drag_place((-400.0, -400.0));
        assert!(wheel.center.0 >= reach - 1.0, "{:?}", wheel.center);
        assert!(wheel.center.1 >= reach - 1.0, "{:?}", wheel.center);

        wheel.hub_drag_place((9000.0, 9000.0));
        assert!(wheel.center.0 <= 1920.0 - reach + 1.0, "{:?}", wheel.center);
        assert!(wheel.center.1 <= 1040.0 - reach + 1.0, "{:?}", wheel.center);
    }

    #[test]
    fn a_carry_leaves_the_aim_on_the_hub_so_the_release_cancels() {
        // The pointer is inside the hub -- it never left it, the wheel followed it -- so the
        // centre is the honest answer. Without this the release a moment later would confirm a
        // slice the hand never pointed at.
        let cfg = one_space();
        let mut wheel = carried_wheel(&cfg);
        wheel.pointer_moved(&cfg, (700.0, 400.0));
        assert!(wheel.active().is_some(), "a slice should be lit to begin with");

        assert!(wheel.begin_hub_drag(&cfg, (500, 400), (500.0, 400.0)));
        assert_eq!(wheel.hub_drag_move((540, 440)), Carry::Began);
        wheel.hub_drag_place((540.0, 440.0));
        assert_eq!(wheel.active(), None);
        assert!(wheel.center_active());
    }

    #[test]
    fn the_window_moving_under_the_wheel_does_not_move_the_wheel() {
        // Both halves have to land together. Applying the centre without the viewport paints the
        // wheel at its new-frame position inside the old box; applying the viewport without the
        // centre clamps it against an extent it is no longer expressed in.
        let cfg = one_space();
        let mut wheel = carried_wheel(&cfg);
        wheel.pointer_moved(&cfg, (520.0, 410.0));
        // The overlay grew up and to the left by 200, 150.
        wheel.reframe((200.0, 150.0), (1920.0, 1040.0));
        assert_eq!(wheel.center, (700.0, 550.0));
        assert_eq!(wheel.viewport, (1920.0, 1040.0));
    }

    #[test]
    fn one_workspace_skips_the_picker() {
        // A launcher offering a single destination is a step that asks to be skipped.
        let cfg = config_with(vec![Workspace {
            id: "w".into(),
            name: "Main".into(),
            apps: vec![app("a", "Alpha")],
            enabled: true,
            ..Workspace::default()
        }]);
        let wheel = Wheel::new(&cfg);
        assert!(!wheel.root_is_picker(&cfg));
        assert_eq!(wheel.items().len(), 1);
        assert_eq!(wheel.items()[0].id, "a");
    }

    #[test]
    fn two_workspaces_open_on_the_picker() {
        let cfg = config_with(vec![
            Workspace { id: "w1".into(), name: "One".into(), enabled: true, ..Workspace::default() },
            Workspace { id: "w2".into(), name: "Two".into(), enabled: true, ..Workspace::default() },
        ]);
        let wheel = Wheel::new(&cfg);
        assert!(wheel.root_is_picker(&cfg));
        assert_eq!(wheel.items().len(), 2);
        assert!(is_workspace_pick(&wheel.items()[0].id));
        assert_eq!(wheel.breadcrumb(&cfg), vec!["Workspaces"]);
    }

    #[test]
    fn a_disabled_workspace_is_not_offered() {
        let cfg = config_with(vec![
            Workspace { id: "w1".into(), name: "One".into(), enabled: true, ..Workspace::default() },
            Workspace { id: "w2".into(), name: "Two".into(), enabled: false, ..Workspace::default() },
            Workspace { id: "w3".into(), name: "Three".into(), enabled: true, ..Workspace::default() },
        ]);
        let wheel = Wheel::new(&cfg);
        let items = wheel.items();
        assert_eq!(items.len(), 2);
        // The ids carry the REAL indices, not the positions in the picker: the disabled one is
        // skipped but keeps its place in the config.
        assert_eq!(workspace_pick_index(&items[0].id), Some(0));
        assert_eq!(workspace_pick_index(&items[1].id), Some(2));
    }

    #[test]
    fn picking_a_workspace_drops_into_it() {
        let mut cfg = config_with(vec![
            Workspace { id: "w1".into(), name: "One".into(), enabled: true, apps: vec![app("a", "A")], ..Workspace::default() },
            Workspace { id: "w2".into(), name: "Two".into(), enabled: true, apps: vec![app("b", "B"), app("c", "C")], ..Workspace::default() },
        ]);
        let mut wheel = Wheel::new(&cfg);
        wheel.open(&cfg, TriggerSource::Shortcut, (500.0, 500.0), (1000.0, 1000.0), 1.0);
        let action = wheel.activate(&mut cfg, 1);
        assert_eq!(action, Action::WorkspaceChanged(1));
        assert_eq!(cfg.active_workspace_index, 1);
        assert_eq!(wheel.items().len(), 2);
        assert_eq!(wheel.breadcrumb(&cfg), vec!["Two"]);
        // And the hub now goes back out to the picker.
        assert_eq!(wheel.center_label(&cfg), "Back");
    }

    #[test]
    fn folders_push_and_the_hub_pops() {
        let mut cfg = config_with(vec![Workspace {
            id: "w".into(),
            name: "Main".into(),
            enabled: true,
            apps: vec![folder("f", "Media", vec![app("x", "Spotify")])],
            ..Workspace::default()
        }]);
        let mut wheel = Wheel::new(&cfg);
        wheel.open(&cfg, TriggerSource::Shortcut, (500.0, 500.0), (1000.0, 1000.0), 1.0);
        wheel.activate(&mut cfg, 0);
        assert_eq!(wheel.items()[0].id, "x");
        assert_eq!(wheel.breadcrumb(&cfg), vec!["Media"]);
        wheel.center_activate(&mut cfg);
        assert_eq!(wheel.items()[0].id, "f");
        assert!(wheel.is_root());
    }

    #[test]
    fn launching_returns_the_item_rather_than_running_it() {
        let mut cfg = config_with(vec![Workspace {
            id: "w".into(),
            name: "Main".into(),
            enabled: true,
            apps: vec![app("a", "Alpha")],
            ..Workspace::default()
        }]);
        let mut wheel = Wheel::new(&cfg);
        wheel.open(&cfg, TriggerSource::Shortcut, (500.0, 500.0), (1000.0, 1000.0), 1.0);
        match wheel.activate(&mut cfg, 0) {
            Action::Launch(item) => assert_eq!(item.id, "a"),
            other => panic!("expected a launch, got {other:?}"),
        }
    }

    #[test]
    fn a_gesture_launches_at_most_once() {
        // A second confirmation from the same hold would launch twice.
        let mut cfg = config_with(vec![Workspace {
            id: "w".into(),
            name: "Main".into(),
            enabled: true,
            apps: vec![app("a", "Alpha")],
            ..Workspace::default()
        }]);
        let mut wheel = Wheel::new(&cfg);
        wheel.open(&cfg, TriggerSource::Shortcut, (500.0, 500.0), (1000.0, 1000.0), 1.0);
        assert!(matches!(wheel.activate(&mut cfg, 0), Action::Launch(_)));
        assert_eq!(wheel.activate(&mut cfg, 0), Action::Idle);
    }

    #[test]
    fn the_centre_cancels_at_the_root_by_default() {
        let mut cfg = config_with(vec![Workspace {
            id: "w".into(), name: "Main".into(), enabled: true, apps: vec![app("a", "A")], ..Workspace::default()
        }]);
        let mut wheel = Wheel::new(&cfg);
        wheel.open(&cfg, TriggerSource::Shortcut, (500.0, 500.0), (1000.0, 1000.0), 1.0);
        assert_eq!(wheel.center_label(&cfg), "Cancel");
        assert_eq!(wheel.center_activate(&mut cfg), Action::Close);
    }

    #[test]
    fn an_empty_recents_fetch_never_launches_the_parent() {
        // A one-item level under a dwell would open the IDE on its own.
        let cfg = config_with(vec![Workspace {
            id: "w".into(), name: "Main".into(), enabled: true, ..Workspace::default()
        }]);
        let mut wheel = Wheel::new(&cfg);
        wheel.open(&cfg, TriggerSource::Shortcut, (500.0, 500.0), (1000.0, 1000.0), 1.0);
        let parent = AppItem { id: "ide".into(), label: "Cursor".into(), command: "cursor".into(), has_recents: Some(true), ..AppItem::default() };
        wheel.recents_arrived(&cfg, &parent, vec![]);
        let items = wheel.items();
        assert_eq!(items.len(), 1);
        assert!(items[0].id.ends_with("__recents-empty-fallback"));
    }

    #[test]
    fn recents_inherit_the_parents_terminal_settings() {
        let cfg = config_with(vec![Workspace { id: "w".into(), enabled: true, ..Workspace::default() }]);
        let mut wheel = Wheel::new(&cfg);
        wheel.open(&cfg, TriggerSource::Shortcut, (500.0, 500.0), (1000.0, 1000.0), 1.0);
        let parent = AppItem {
            id: "ide".into(),
            label: "Cursor".into(),
            command: "cursor".into(),
            has_recents: Some(true),
            open_terminal_for_recents: Some(true),
            terminal_commands: Some(vec!["npm run dev".into(), "  ".into()]),
            ..AppItem::default()
        };
        wheel.recents_arrived(&cfg, &parent, vec![app("r1", "project-one")]);
        let items = wheel.items();
        assert_eq!(items[0].open_terminal, Some(true));
        // Blank lines are dropped: a terminal that runs an empty command shows an error.
        assert_eq!(items[0].terminal_commands.as_deref(), Some(&["npm run dev".to_string()][..]));
    }

    #[test]
    fn a_late_recents_answer_for_a_closed_wheel_is_dropped() {
        let cfg = config_with(vec![Workspace { id: "w".into(), enabled: true, ..Workspace::default() }]);
        let mut wheel = Wheel::new(&cfg);
        let parent = AppItem { id: "ide".into(), has_recents: Some(true), ..AppItem::default() };
        wheel.recents_arrived(&cfg, &parent, vec![app("r1", "one")]);
        assert!(wheel.is_root());
    }

    #[test]
    fn filtering_prefers_prefixes_and_keeps_ring_order() {
        let items = vec![
            app("1", "Discord"),
            app("2", "Spotify"),
            app("3", "Visual Studio Code"),
            app("4", "Steam"),
        ];
        // Two characters: prefixes first in ring order, then the contains-matches.
        let hits = filter_items(&items, "st");
        assert_eq!(
            hits.iter().map(|i| i.label.as_str()).collect::<Vec<_>>(),
            vec!["Steam", "Visual Studio Code"]
        );
    }

    #[test]
    fn one_letter_means_starts_with() {
        // "s" is inside Discord and Visual Studio Code; applying contains there narrows nothing.
        let items = vec![app("1", "Discord"), app("2", "Spotify"), app("3", "Visual Studio Code")];
        let hits = filter_items(&items, "s");
        assert_eq!(hits.iter().map(|i| i.label.as_str()).collect::<Vec<_>>(), vec!["Spotify"]);
    }

    #[test]
    fn filtering_ignores_case_and_spaces() {
        let items = vec![app("1", "Visual Studio Code")];
        for query in ["visual studio", "VISUALSTUDIO", "  visualstudio  ", "code"] {
            assert_eq!(filter_items(&items, query).len(), 1, "{query}");
        }
        // Not an initials match: that would mean scoring, and scoring reorders the ring.
        assert_eq!(filter_items(&items, "vscode").len(), 0);
    }

    #[test]
    fn backspace_on_an_empty_filter_leaves_the_folder() {
        let mut cfg = config_with(vec![Workspace {
            id: "w".into(), name: "Main".into(), enabled: true,
            apps: vec![folder("f", "Media", vec![app("x", "Spotify")])],
            ..Workspace::default()
        }]);
        let mut wheel = Wheel::new(&cfg);
        wheel.open(&cfg, TriggerSource::Shortcut, (500.0, 500.0), (1000.0, 1000.0), 1.0);
        wheel.activate(&mut cfg, 0);
        wheel.type_char(&cfg, 's');
        wheel.backspace(&mut cfg);
        // The filter went first; the level is still the folder.
        assert_eq!(wheel.filter(), "");
        assert!(!wheel.is_root());
        wheel.backspace(&mut cfg);
        assert!(wheel.is_root());
    }

    #[test]
    fn the_back_key_is_inert_at_the_root_and_while_typing() {
        // What keeps `qBittorrent` reachable with the default binding.
        let mut cfg = config_with(vec![Workspace {
            id: "w".into(), enabled: true,
            apps: vec![folder("f", "Media", vec![app("x", "qBittorrent")])],
            ..Workspace::default()
        }]);
        cfg.radial_number_launch = Some(true);
        cfg.radial_back_key = Some("Q".into());
        let mut wheel = Wheel::new(&cfg);
        wheel.open(&cfg, TriggerSource::Shortcut, (500.0, 500.0), (1000.0, 1000.0), 1.0);
        assert!(!wheel.back_key_active(&cfg), "nothing to leave at the root");
        wheel.activate(&mut cfg, 0);
        assert!(wheel.back_key_active(&cfg));
        wheel.type_char(&cfg, 'q');
        assert!(!wheel.back_key_active(&cfg), "a typed filter owns the letter");
    }

    #[test]
    fn number_launch_is_off_unless_asked_for() {
        let mut cfg = config_with(vec![Workspace {
            id: "w".into(), enabled: true, apps: vec![app("a", "A")], ..Workspace::default()
        }]);
        let mut wheel = Wheel::new(&cfg);
        wheel.open(&cfg, TriggerSource::Shortcut, (500.0, 500.0), (1000.0, 1000.0), 1.0);
        assert_eq!(wheel.launch_number(&mut cfg, 1), Action::Idle);
        cfg.radial_number_launch = Some(true);
        assert!(matches!(wheel.launch_number(&mut cfg, 1), Action::Launch(_)));
    }

    #[test]
    fn the_wheel_cycles_only_enabled_workspaces() {
        let mut cfg = config_with(vec![
            Workspace { id: "w1".into(), enabled: true, ..Workspace::default() },
            Workspace { id: "w2".into(), enabled: false, ..Workspace::default() },
            Workspace { id: "w3".into(), enabled: true, ..Workspace::default() },
        ]);
        let mut wheel = Wheel::new(&cfg);
        wheel.open(&cfg, TriggerSource::Shortcut, (500.0, 500.0), (1000.0, 1000.0), 1.0);
        assert_eq!(wheel.cycle_workspace(&mut cfg, true), Action::WorkspaceChanged(2));
        assert_eq!(wheel.cycle_workspace(&mut cfg, true), Action::WorkspaceChanged(0));
        assert_eq!(wheel.cycle_workspace(&mut cfg, false), Action::WorkspaceChanged(2));
    }

    #[test]
    fn a_fresh_open_aims_at_nothing() {
        // Releasing without moving the mouse must cancel, not confirm the stale slice from the
        // previous gesture.
        let cfg = config_with(vec![Workspace {
            id: "w".into(), enabled: true,
            apps: vec![app("a", "A"), app("b", "B"), app("c", "C")],
            ..Workspace::default()
        }]);
        let mut wheel = Wheel::new(&cfg);
        wheel.open(&cfg, TriggerSource::MouseHold, (500.0, 500.0), (1000.0, 1000.0), 1.0);
        assert!(wheel.center_active());
        assert_eq!(wheel.active(), None);
        assert!(wheel.resolve_live(&cfg).is_center());
    }

    #[test]
    fn a_level_change_relights_the_slice_under_the_cursor() {
        // Entering a level used to leave it entirely dark until the mouse was nudged.
        let mut cfg = config_with(vec![Workspace {
            id: "w".into(), enabled: true,
            apps: vec![folder("f", "Media", vec![app("x", "One"), app("y", "Two")])],
            ..Workspace::default()
        }]);
        let mut wheel = Wheel::new(&cfg);
        wheel.open(&cfg, TriggerSource::Shortcut, (500.0, 500.0), (1000.0, 1000.0), 1.0);
        // Pointer well up and to the right of centre: in a two-item ring that is item 0.
        wheel.pointer_moved(&cfg, (520.0, 200.0));
        wheel.activate(&mut cfg, 0);
        assert_eq!(wheel.active(), Some(0), "the new level arrives lit");
    }

    #[test]
    fn closing_stops_every_gesture_synchronously() {
        let mut cfg = config_with(vec![Workspace {
            id: "w".into(), enabled: true, apps: vec![app("a", "A")], ..Workspace::default()
        }]);
        let mut wheel = Wheel::new(&cfg);
        wheel.open(&cfg, TriggerSource::Shortcut, (500.0, 500.0), (1000.0, 1000.0), 1.0);
        wheel.begin_exit();
        // Everything that could still launch has to be inert the moment the exit begins — a timer
        // outlives the window a click cannot.
        assert_eq!(wheel.activate(&mut cfg, 0), Action::Idle);
        assert_eq!(wheel.confirm(&mut cfg), Action::Idle);
        assert_eq!(wheel.type_char(&cfg, 'a'), Action::Idle);
        assert_eq!(wheel.center_activate(&mut cfg), Action::Idle);
    }

    #[test]
    fn the_direction_hint_is_spent_only_once_it_has_been_read() {
        let mut cfg = config_with(vec![Workspace { id: "w".into(), enabled: true, ..Workspace::default() }]);
        cfg.radial_instant_activate = Some(crate::config::InstantActivate::Dwell);
        cfg.has_seen_direction_hint = Some(false);
        let mut wheel = Wheel::new(&cfg);
        wheel.open(&cfg, TriggerSource::Shortcut, (500.0, 500.0), (1000.0, 1000.0), 1.0);
        assert!(wheel.direction_hint_visible(&cfg));
        // Not yet read: a flash must not spend the one showing.
        assert!(wheel.take_direction_hint_seen().is_none());
        // And a config that has already seen it never shows it again.
        cfg.has_seen_direction_hint = Some(true);
        assert!(!wheel.direction_hint_visible(&cfg));
    }
}

impl Wheel {
    /// Jump every animation to its end.
    ///
    /// Only the offscreen probe uses this: a probe of a half-expanded wheel measures the
    /// animation's timing rather than the frame's geometry, and the two want looking at separately.
    pub fn settle_for_probe(&mut self) {
        self.bloom.set(1.0);
    }
}
