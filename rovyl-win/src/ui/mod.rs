//! A small immediate-mode UI, for the windowed surfaces.
//!
//! **Why immediate mode.** The settings panel is ~60 rows whose visibility, enabled state and
//! values all derive from the configuration — a row appears because a switch above it is on, a
//! slider's range depends on which dock it belongs to, a select's choices depend on the installed
//! languages. A retained tree would need every one of those relationships expressed twice: once to
//! build the tree and once to update it. Here the panel is a function of the config, run each
//! frame, and the relationships are ordinary `if`s.
//!
//! The cost of immediate mode is usually layout and text measurement per frame. Neither bites here:
//! the layout is a single column of rows, and text layouts are cached by `(style, string)` in
//! `gfx::text`, so a frame that draws the same panel again measures nothing.
//!
//! **Identity.** Hover is positional and needs no identity, but "which control is being dragged"
//! does — a slider must keep the drag when the pointer leaves it. Widgets therefore take an `id`,
//! and the context remembers only the active and focused ones. Two widgets with the same id in one
//! frame is a bug that shows up as both responding to one drag, which is why the ids here are
//! strings taken from the setting's own key rather than generated from call order.

pub mod code;
pub mod fault;
pub mod firstrun;
pub mod preview;
pub mod settings;
pub mod widgets;
pub mod workspace;

use crate::gfx::painter::{Painter, Rect};
use crate::gfx::palette::Surface;
use crate::wheel::anim::{self, Tween};

/// One frame's worth of input.
///
/// Collected by the window procedure and handed to the UI whole, rather than queried from the OS
/// inside widgets: a widget that asked `GetKeyState` would see the state at paint time, which on a
/// frame that ran late is not the state the event described.
#[derive(Debug, Default, Clone)]
pub struct Input {
    pub pointer: (f32, f32),
    /// Whether the primary button is down right now.
    pub down: bool,
    /// Whether it went down since the last frame.
    pub pressed: bool,
    /// Whether it came up since the last frame.
    pub released: bool,
    /// Vertical wheel, in notches.
    pub scroll: f32,
    /// Characters typed since the last frame.
    pub typed: String,
    /// Virtual-key codes pressed since the last frame.
    pub keys: Vec<u16>,
    pub ctrl: bool,
    pub shift: bool,
    /// Alt and the Windows key, for the shortcut recorder.
    ///
    /// Not needed by any widget — a settings panel has no use for them — but an accelerator
    /// recorder that cannot see Alt is a recorder that cannot record `Alt+Z`, which is what this
    /// product ships with.
    pub alt: bool,
    pub win: bool,
    /// The pointer left the window, so nothing should read as hovered.
    pub pointer_outside: bool,
}

impl Input {
    /// Clear the per-frame parts. The held state (`down`, modifiers, position) persists.
    pub fn end_frame(&mut self) {
        self.pressed = false;
        self.released = false;
        self.scroll = 0.0;
        self.typed.clear();
        self.keys.clear();
    }

    pub fn key_pressed(&self, vk: u16) -> bool {
        self.keys.contains(&vk)
    }

    /// How many times `vk` arrived since the last frame.
    ///
    /// The one place the COUNT matters is the code editor, and there it matters a lot: Windows
    /// auto-repeat sends a `WM_KEYDOWN` per repeat, and a frame that ran late holds several of
    /// them. `key_pressed` collapses those to one, so a held Backspace would delete at frame rate
    /// instead of at the user's repeat rate — slower than the keyboard on a quiet frame, and
    /// visibly uneven whenever a frame took longer.
    ///
    /// Settings rows keep asking `key_pressed`: a switch flipped twice because two presses landed
    /// in one frame is a switch that ends up where neither press meant.
    pub fn key_repeats(&self, vk: u16) -> usize {
        self.keys.iter().filter(|&&k| k == vk).count()
    }
}

/// What a frame wants the host to do afterwards.
#[derive(Debug, Default)]
pub struct Outcome {
    /// Something changed and the configuration should be written.
    pub dirty: bool,
    /// Another frame is wanted even with no input — an animation is running.
    pub animating: bool,
    /// The cursor the window should show.
    pub cursor: Cursor,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum Cursor {
    #[default]
    Arrow,
    Hand,
    Text,
    SizeWestEast,
}

/// How far through its travel a switch is, this frame.
///
/// Both numbers run 0 at off to 1 at on, and both are already eased — a caller multiplies and
/// mixes with them rather than curving them again.
#[derive(Debug, Clone, Copy)]
pub struct Toggle {
    /// The knob's position along the track.
    pub knob: f32,
    /// How far the track, its edge and the knob's colour have crossed over.
    pub tint: f32,
    /// Still moving, so the surface needs another frame.
    pub animating: bool,
}

/// State the UI keeps between frames.
///
/// Deliberately tiny. Anything larger than this belongs in the configuration or in the host: a UI
/// that accumulates state is a UI with a second copy of the truth in it.
#[derive(Default)]
pub struct Ui {
    /// The widget currently capturing the pointer — a slider being dragged, a button being held.
    active: Option<String>,
    /// The widget that has the keyboard.
    focused: Option<String>,
    /// The open dropdown, if any, and the rectangle it was opened from.
    open_menu: Option<(String, Rect)>,
    /// Its list, held back so the panel can draw it after the page rather than under it.
    menu: Option<Menu>,
    /// Which dropdown that was. The colour palette draws its own popup where it stands and uses
    /// the same open slot, so "a list the panel owes a pass to" and "a popup that has already
    /// drawn itself" have to be told apart — one of them is missing if it is not drawn, and the
    /// other is missing if it is.
    listed: Option<String>,
    /// What was picked out of a list, waiting for its row to come round again and ask.
    menu_choice: Option<(String, String)>,
    /// Per-scroller offsets, by id.
    scroll: Vec<(String, f32)>,
    /// Per-switch travel, by id: where the knob is, and how far the colours have gone over.
    ///
    /// The one piece of state here that is not a copy of anything — a switch's VALUE lives in the
    /// configuration, and this is only where the drawing of it has got to. Keeping it on the
    /// context rather than in the config is what lets the widget stay a pure function of `on`:
    /// nineteen call sites pass a bool and none of them know that anything moves.
    toggles: Vec<(String, Tween, Tween)>,
    /// Text being edited, so a field can hold a value the config has not accepted yet.
    editing: Option<(String, String, usize)>,
    /// A transient message, and when it was shown.
    toast: Option<(String, std::time::Instant)>,
}

/// An open dropdown's list, captured where its row is and drawn once the page is done.
///
/// A list has to be drawn after every row, including the rows it covers — and a row cannot know
/// that something above it opened a list over the space it is about to take. So the row hands its
/// list over here and the panel draws it last, which is the only order in which a list is actually
/// on top of the page.
pub struct Menu {
    pub id: String,
    /// The trigger the list hangs off.
    pub from: Rect,
    pub choices: Vec<widgets::Choice>,
    /// The value with the tick beside it.
    pub current: String,
    /// The column the row was laid into, which the list is kept inside. Captured with the rest: by
    /// the time the list is drawn the frame's bounds have been handed back to the whole window,
    /// and a list clamped to THAT would be free to hang off the sidebar.
    pub bounds: Rect,
}

/// How long a toast stays up.
///
/// Long enough to read a short sentence, short enough that it is gone before the next action. The
/// toasts here report something that ALREADY happened ("switched to the mouse trigger"), never
/// something the user must act on, so nothing is lost by missing one.
const TOAST_MS: f32 = 2600.0;

impl Ui {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn active(&self) -> Option<&str> {
        self.active.as_deref()
    }

    pub fn is_active(&self, id: &str) -> bool {
        self.active.as_deref() == Some(id)
    }

    pub fn set_active(&mut self, id: &str) {
        self.active = Some(id.to_string());
    }

    pub fn clear_active(&mut self) {
        self.active = None;
    }

    pub fn is_focused(&self, id: &str) -> bool {
        self.focused.as_deref() == Some(id)
    }

    pub fn focus(&mut self, id: &str) {
        self.focused = Some(id.to_string());
    }

    pub fn blur(&mut self) {
        self.focused = None;
        self.editing = None;
    }

    pub fn menu_open_for(&self, id: &str) -> Option<Rect> {
        match &self.open_menu {
            Some((open, rect)) if open == id => Some(*rect),
            _ => None,
        }
    }

    pub fn any_menu_open(&self) -> bool {
        self.open_menu.is_some()
    }

    pub fn open_menu(&mut self, id: &str, from: Rect) {
        self.open_menu = Some((id.to_string(), from));
    }

    pub fn close_menu(&mut self) {
        self.open_menu = None;
    }

    /// Hand a list over to be drawn after the page. One list is open at a time, so one slot.
    pub fn queue_menu(&mut self, menu: Menu) {
        self.listed = Some(menu.id.clone());
        self.menu = Some(menu);
    }

    /// Whether what is open is a list the panel draws in its last pass.
    ///
    /// The question the panel asks before making itself inert, and before deciding that an open
    /// menu nobody drew this frame has lost the row it belonged to.
    pub fn list_open(&self) -> bool {
        match (&self.open_menu, &self.listed) {
            (Some((open, _)), Some(listed)) => open == listed,
            _ => false,
        }
    }

    pub fn take_menu(&mut self) -> Option<Menu> {
        self.menu.take()
    }

    /// Record what was picked. The row that owns the list runs upstream of where the list is
    /// drawn, so it is told on the next frame — the frame the pick has already asked for.
    pub fn choose(&mut self, id: &str, value: String) {
        self.menu_choice = Some((id.to_string(), value));
    }

    pub fn take_choice(&mut self, id: &str) -> Option<String> {
        match &self.menu_choice {
            Some((key, _)) if key == id => self.menu_choice.take().map(|(_, value)| value),
            _ => None,
        }
    }

    /// Drop a pick nobody came back for — a row the search filtered away, or one a switch above it
    /// turned off, between the click and the frame after it. Left there, it would be applied the
    /// next time that row happened to be drawn.
    pub fn forget_choice(&mut self) {
        self.menu_choice = None;
    }

    pub fn scroll_of(&self, id: &str) -> f32 {
        self.scroll
            .iter()
            .find(|(key, _)| key == id)
            .map(|(_, value)| *value)
            .unwrap_or(0.0)
    }

    pub fn set_scroll(&mut self, id: &str, value: f32) {
        match self.scroll.iter_mut().find(|(key, _)| key == id) {
            Some(slot) => slot.1 = value,
            None => self.scroll.push((id.to_string(), value)),
        }
    }

    /// Move a switch toward `on`, and say where it is now.
    ///
    /// A switch seen for the first time is SETTLED at the value the configuration already holds.
    /// Starting it at off would mean a panel that opened with nineteen knobs sliding into place,
    /// announcing changes nobody made — and the same would happen every time a search term hid a
    /// row and then stopped hiding it.
    ///
    /// Interruption is the `Tween`'s doing: flipping something twice quickly re-aims from wherever
    /// the knob actually is, so the second press continues the motion instead of restarting it.
    pub fn toggle(&mut self, id: &str, on: bool) -> Toggle {
        let target = if on { 1.0 } else { 0.0 };
        if !self.toggles.iter().any(|(key, _, _)| key == id) {
            self.toggles
                .push((id.to_string(), Tween::held(target), Tween::held(target)));
        }
        let Some((_, knob, tint)) = self.toggles.iter_mut().find(|(key, _, _)| key == id) else {
            // Pushed a line ago, so this cannot happen; `unreachable!` in a paint path can.
            return Toggle { knob: target, tint: target, animating: false };
        };
        knob.retarget(target, anim::TOGGLE_KNOB_MS, anim::standard);
        tint.retarget(target, anim::TOGGLE_TINT_MS, anim::css_ease_out);
        Toggle {
            knob: knob.sample(anim::standard),
            tint: tint.sample(anim::css_ease_out),
            animating: knob.animating() || tint.animating(),
        }
    }

    /// The text a field is currently holding, and the caret.
    pub fn editing(&self, id: &str) -> Option<(&str, usize)> {
        match &self.editing {
            Some((key, text, caret)) if key == id => Some((text.as_str(), *caret)),
            _ => None,
        }
    }

    pub fn begin_edit(&mut self, id: &str, text: &str) {
        self.editing = Some((id.to_string(), text.to_string(), text.chars().count()));
        self.focus(id);
    }

    pub fn edit_mut(&mut self, id: &str) -> Option<(&mut String, &mut usize)> {
        match &mut self.editing {
            Some((key, text, caret)) if key == id => Some((text, caret)),
            _ => None,
        }
    }

    pub fn end_edit(&mut self) -> Option<String> {
        self.editing.take().map(|(_, text, _)| text)
    }

    pub fn toast(&mut self, message: impl Into<String>) {
        self.toast = Some((message.into(), std::time::Instant::now()));
    }

    /// The toast and how far through its life it is, or `None`.
    pub fn current_toast(&self) -> Option<(&str, f32)> {
        let (text, at) = self.toast.as_ref()?;
        let progress = at.elapsed().as_secs_f32() * 1000.0 / TOAST_MS;
        (progress < 1.0).then_some((text.as_str(), progress))
    }
}

/// The per-frame drawing and layout cursor.
///
/// A column: rows are placed top to bottom within `bounds`, and `y` is where the next one goes.
/// There is no general-purpose layout engine here because the product has one layout — a list of
/// rows in a scrolling column — and an engine that could express more would be more to get wrong.
pub struct Frame<'a, 'p> {
    pub p: &'a Painter<'p>,
    pub ui: &'a mut Ui,
    pub input: &'a Input,
    pub theme: Surface,
    /// Device scale, so every size below is in DIPs.
    pub scale: f32,
    /// Where the icon picker's grid gets its thumbnails.
    ///
    /// `None` on every surface but the settings panel: the wheel has its own, and the failure card
    /// and the welcome card draw no bitmaps at all.
    pub icons: Option<&'a dyn crate::wheel::render::IconSource2>,
    /// A drag hovering over the window, in CLIENT pixels, while one is.
    ///
    /// On the frame for the same reason `icons` is: it belongs to one surface — the settings
    /// panel — and the one page that answers for it is several layers of layout away from the
    /// window that was told about the drag. `None` everywhere else, including on the wheel, which
    /// is click-through and could not be dropped on if it wanted to be.
    pub drag: Option<(f32, f32)>,
    /// Whether the interface language reads right to left.
    ///
    /// On the frame rather than looked up per widget: it is a property of the whole surface, and a
    /// panel where half the rows had worked it out and half had not would be worse than either.
    pub rtl: bool,
    /// The column the rows are laid into. Narrowed and restored as sections lay themselves out.
    pub bounds: Rect,
    /// The whole surface, which `bounds` never outgrows and never changes.
    ///
    /// A modal needs it: it covers the window, not the column, and a dialog that leaves the nav
    /// clickable is a dialog that can be navigated out from underneath.
    pub window: Rect,
    /// Where the next row goes.
    pub y: f32,
    pub outcome: Outcome,
    /// Set while a modal (a dropdown) is capturing input, so the rows behind it do not react.
    pub blocked: bool,
    /// A search term, lower-cased, while the panel is showing results rather than a page.
    ///
    /// On the frame rather than threaded through sixty call sites: the rows are already a
    /// function of the configuration, and "which rows exist" is the one question every one of
    /// them answers the same way. With this set, a row whose words do not contain the term is
    /// not drawn and takes no height — so the results page is the ordinary pages, run in order,
    /// with most of them having nothing to say.
    pub filter: Option<String>,
    /// A group heading waiting to find out whether anything under it survived the filter.
    pending_group: Option<String>,
    /// The viewport the pass being drawn is clipped to, if any.
    ///
    /// The scrolling column pushes one. Without it a row scrolled past the top of the viewport is
    /// still drawn, over a titlebar that was painted before it — which reads as a titlebar that
    /// has gone transparent, because the window buttons are drawn after the column and stay on
    /// top of the leak.
    ///
    /// Overlays step out of it with `escape_clip` while they draw: a dropdown or the icon picker
    /// belongs to the WINDOW rather than to the column it was opened from, and the shadow that
    /// separates one is wider than the panel it is under.
    clip: Option<Rect>,
    /// Set once a dialog has covered the window this frame.
    ///
    /// The page under it is drawn FIRST — a modal over a blank panel would be a modal that forgot
    /// where it was opened from — and then has to stop behaving like a page. `blocked` already
    /// stops its rows reacting, but the column it lives in reads the wheel afterwards, from a
    /// pass that has no idea a dialog is up. Without this, scrolling the dialog's own list also
    /// scrolls the grid behind it.
    pub modal: bool,
}

impl<'a, 'p> Frame<'a, 'p> {
    pub fn new(
        p: &'a Painter<'p>,
        ui: &'a mut Ui,
        input: &'a Input,
        theme: Surface,
        scale: f32,
        bounds: Rect,
    ) -> Self {
        Self {
            p,
            ui,
            input,
            theme,
            scale,
            icons: None,
            drag: None,
            rtl: false,
            bounds,
            window: bounds,
            y: bounds.top,
            outcome: Outcome::default(),
            blocked: false,
            filter: None,
            pending_group: None,
            clip: None,
            modal: false,
        }
    }

    /// Whether the panel is showing search results rather than a page.
    pub fn filtering(&self) -> bool {
        self.filter.is_some()
    }

    /// Whether a row with this text belongs in the results.
    ///
    /// Always true when nothing is being searched for, so a call site can ask without first
    /// asking whether it should ask.
    pub fn matches(&self, title: &str, description: &str) -> bool {
        let Some(term) = self.filter.as_deref() else {
            return true;
        };
        if term.is_empty() {
            return true;
        }
        title.to_lowercase().contains(term) || description.to_lowercase().contains(term)
    }

    /// Hold a group heading back until something under it is drawn.
    pub fn defer_group(&mut self, title: &str) {
        self.pending_group = Some(title.to_string());
    }

    /// The heading being held back, if any — taken, so it is drawn once.
    pub fn take_group(&mut self) -> Option<String> {
        self.pending_group.take()
    }

    /// Somewhere nothing can be seen.
    ///
    /// A row the filter dropped still hands its caller a rectangle to put a control in, because
    /// the alternative is sixty call sites learning to check. The rectangle is off the surface,
    /// so the control draws where no pixel of the window is and no pointer can reach.
    pub fn nowhere(&self) -> Rect {
        Rect::new(-100_000.0, -100_000.0, -99_900.0, -99_900.0)
    }

    /// Clip the rest of this pass to `rect`: nothing drawn, hovered or clicked outside it counts.
    ///
    /// Only one is ever in force. Nesting would want a stack here and a second one in the painter,
    /// and the product has one scroller.
    pub fn clip_to(&mut self, rect: Rect) {
        self.unclip();
        self.p.push_clip(rect);
        self.clip = Some(rect);
    }

    /// Drop the clip, if there is one.
    ///
    /// Safe on a frame that was never clipped, so every way out of a clipped pass — including the
    /// early return the results page takes — can call it without first asking.
    pub fn unclip(&mut self) {
        if self.clip.take().is_some() {
            self.p.pop_clip();
        }
    }

    /// Step out of the clip for an overlay, handing back what `restore_clip` needs.
    ///
    /// Paired by value rather than wrapped in a closure for the reason `clip_to` is: the overlays
    /// are `&mut Frame` call sites hundreds of lines long, and a closure around one would borrow
    /// the frame it is already holding.
    pub fn escape_clip(&mut self) -> Option<Rect> {
        let saved = self.clip;
        self.unclip();
        saved
    }

    /// Put back the clip `escape_clip` lifted.
    pub fn restore_clip(&mut self, saved: Option<Rect>) {
        if let Some(rect) = saved {
            self.clip_to(rect);
        }
    }

    /// Lend this frame an icon cache, for the one panel that draws bitmaps.
    pub fn with_icons(mut self, icons: &'a dyn crate::wheel::render::IconSource2) -> Self {
        self.icons = Some(icons);
        self
    }

    /// Where a drag is hovering, in the same space every rectangle on this frame is in.
    pub fn with_drag(mut self, at: Option<(f32, f32)>) -> Self {
        self.drag = at;
        self
    }

    /// A length in DIPs, as pixels.
    pub fn px(&self, dips: f32) -> f32 {
        dips * self.scale
    }

    /// Take `height` DIPs of the column.
    pub fn row(&mut self, height: f32) -> Rect {
        let h = self.px(height);
        let rect = Rect::new(self.bounds.left, self.y, self.bounds.right, self.y + h);
        self.y += h;
        rect
    }

    pub fn gap(&mut self, dips: f32) {
        // Space between rows is not space when there are no rows. On the results page a page's
        // worth of gaps, with every row between them filtered out, is a page of nothing.
        if self.filtering() {
            return;
        }
        self.y += self.px(dips);
    }

    /// Whether the pointer is over `rect` AND nothing is capturing it elsewhere.
    pub fn hovered(&self, rect: Rect) -> bool {
        if self.blocked || self.input.pointer_outside {
            return false;
        }
        // Scrolled out of the viewport is out of reach as well as out of sight. A row that has
        // scrolled under the titlebar is still at a real position, and the three window buttons
        // are the one strip of that bar the system reports as client area — so without this,
        // pressing Close can also flip whichever switch has scrolled beneath it.
        if let Some(clip) = self.clip {
            if !clip.contains(self.input.pointer.0, self.input.pointer.1) {
                return false;
            }
        }
        // A widget that is capturing counts as hovered wherever the pointer is: a slider must keep
        // responding when the drag leaves its track, which is most drags.
        rect.contains(self.input.pointer.0, self.input.pointer.1)
    }

    /// Standard button behaviour: returns true on the frame the press completes inside `rect`.
    ///
    /// The press has to complete INSIDE, which is what lets a user who pressed the wrong thing
    /// slide off it and let go without activating it — the behaviour every native control has and
    /// the one people rely on without knowing they do.
    pub fn clicked(&mut self, id: &str, rect: Rect) -> bool {
        let over = self.hovered(rect);
        if over && self.input.pressed {
            self.ui.set_active(id);
        }
        if self.ui.is_active(id) && self.input.released {
            self.ui.clear_active();
            return over;
        }
        false
    }

    pub fn mark_dirty(&mut self) {
        self.outcome.dirty = true;
    }

    pub fn want_frame(&mut self) {
        self.outcome.animating = true;
    }

    pub fn set_cursor(&mut self, cursor: Cursor) {
        // The strongest request wins, so a row that wants a hand does not lose to a later one that
        // wants the default. Ordering by "how specific is this" rather than by draw order keeps the
        // cursor from flickering between widgets that overlap.
        if cursor != Cursor::Arrow {
            self.outcome.cursor = cursor;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn end_frame_keeps_held_state_and_drops_edges() {
        let mut input = Input {
            down: true,
            pressed: true,
            released: true,
            scroll: 3.0,
            typed: "a".into(),
            keys: vec![13],
            ctrl: true,
            ..Default::default()
        };
        input.end_frame();
        assert!(input.down, "a held button is still held next frame");
        assert!(input.ctrl, "so is a held modifier");
        assert!(!input.pressed);
        assert!(!input.released);
        assert_eq!(input.scroll, 0.0);
        assert!(input.typed.is_empty());
        assert!(input.keys.is_empty());
    }

    #[test]
    fn scroll_offsets_are_per_id() {
        let mut ui = Ui::new();
        assert_eq!(ui.scroll_of("a"), 0.0);
        ui.set_scroll("a", 40.0);
        ui.set_scroll("b", -10.0);
        assert_eq!(ui.scroll_of("a"), 40.0);
        assert_eq!(ui.scroll_of("b"), -10.0);
        ui.set_scroll("a", 5.0);
        assert_eq!(ui.scroll_of("a"), 5.0);
        assert_eq!(ui.scroll.len(), 2, "updating must not append a duplicate");
    }

    #[test]
    fn a_switch_is_settled_the_first_time_it_is_seen() {
        // Otherwise opening the panel is nineteen knobs sliding in, claiming changes nobody made.
        let mut ui = Ui::new();
        let on = ui.toggle("sounds", true);
        assert_eq!((on.knob, on.tint), (1.0, 1.0));
        assert!(!on.animating);

        let off = ui.toggle("game", false);
        assert_eq!((off.knob, off.tint), (0.0, 0.0));
        assert!(!off.animating);
    }

    #[test]
    fn flipping_a_switch_travels() {
        let mut ui = Ui::new();
        ui.toggle("sounds", false);
        let moving = ui.toggle("sounds", true);
        assert!(moving.animating, "the frame of the press has to ask for the next one");
        // Neither channel is allowed to arrive on the frame of the press — that is the cut this
        // replaces. Which of the two is ahead early on is the easing curves' business, not a
        // promise of this function; what matters is pinned in `anim`, where the clocks live.
        assert!(moving.knob < 1.0, "the knob cannot already be there");
        assert!(moving.tint < 1.0, "nor can the colours");
    }

    #[test]
    fn a_switch_re_asserted_keeps_going_rather_than_restarting() {
        // Sixty frames a second re-assert the same bool. Any of them restarting the clock would
        // leave the knob stuck a few pixels in for as long as the panel stayed open.
        let mut ui = Ui::new();
        ui.toggle("sounds", false);
        let first = ui.toggle("sounds", true).knob;
        std::thread::sleep(std::time::Duration::from_millis(30));
        let second = ui.toggle("sounds", true).knob;
        assert!(second > first, "{second} did not advance past {first}");
    }

    #[test]
    fn switches_travel_independently() {
        let mut ui = Ui::new();
        ui.toggle("sounds", true);
        ui.toggle("game", false);
        let flipped = ui.toggle("sounds", false);
        assert!(flipped.animating);
        // The untouched one is still where it was, and still asking for nothing.
        let other = ui.toggle("game", false);
        assert_eq!(other.knob, 0.0);
        assert!(!other.animating);
        assert_eq!(ui.toggles.len(), 2, "one slot per id, not one per frame");
    }

    #[test]
    fn editing_is_scoped_to_one_field() {
        let mut ui = Ui::new();
        ui.begin_edit("name", "Main");
        assert_eq!(ui.editing("name").map(|(t, _)| t), Some("Main"));
        assert!(ui.editing("other").is_none());
        assert!(ui.is_focused("name"));
        assert_eq!(ui.end_edit().as_deref(), Some("Main"));
        assert!(ui.editing("name").is_none());
    }

    #[test]
    fn a_toast_expires() {
        let mut ui = Ui::new();
        assert!(ui.current_toast().is_none());
        ui.toast("switched to the mouse trigger");
        let (text, progress) = ui.current_toast().expect("just shown");
        assert!(text.starts_with("switched"));
        assert!(progress < 0.1);
    }

    #[test]
    fn menus_are_identified() {
        let mut ui = Ui::new();
        let rect = Rect::new(0.0, 0.0, 10.0, 10.0);
        assert!(!ui.any_menu_open());
        ui.open_menu("language", rect);
        assert!(ui.any_menu_open());
        assert_eq!(ui.menu_open_for("language"), Some(rect));
        assert_eq!(ui.menu_open_for("theme"), None);
        ui.close_menu();
        assert!(!ui.any_menu_open());
    }
}
