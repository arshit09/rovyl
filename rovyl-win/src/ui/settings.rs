//! The settings panel.
//!
//! A port of the original's `PrecisionSettings`, row for row and sentence for sentence. The copy is
//! kept verbatim rather than rewritten, because it is the part of the product that had the most
//! care spent on it: nearly every description says what a setting COSTS or what it is answering
//! rather than what it does, and that is not a property that survives paraphrasing.
//!
//! The structure is the original's too. Rows are a function of the configuration, evaluated each
//! frame, so a row that only exists while a switch above it is on is an `if` rather than a
//! subscription — and a description that changes with the value it describes (the three the
//! targeting row has, one per combination of mode and wedges) is a `match`.

use crate::config::{self, *};
use crate::gfx::painter::Rect;
use crate::gfx::palette as pal;
use crate::gfx::text::{Align, Family, Style};
use crate::input::trigger;
use crate::ui::widgets::{self as w, ButtonKind, Choice};
use crate::ui::{Cursor, Frame};
use windows::Win32::Graphics::Direct2D::Common::D2D1_COLOR_F;

/// Which page is on screen.
///
/// The order is the original's nav order, which is not alphabetical and not a hierarchy: it is
/// roughly how often a page is opened, with Workspaces first because that is what people come here
/// to change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Section {
    Workspaces,
    Activation,
    Sound,
    Advanced,
    Appearance,
    General,
}

impl Section {
    pub const ALL: [Section; 6] = [
        Section::Workspaces,
        Section::Activation,
        Section::Sound,
        Section::Advanced,
        Section::Appearance,
        Section::General,
    ];

    /// The key this section's name and caption live under.
    ///
    /// The same keys the Electron build uses, so the two panels say the same thing in the same
    /// language. `trigger` and `advanced` are its names for what this build calls Activation and
    /// Advanced -- renaming them here would mean regenerating the table against keys that do not
    /// exist in the file it comes from.
    fn key(self) -> &'static str {
        match self {
            Section::Workspaces => "workspaces",
            Section::Activation => "trigger",
            Section::Sound => "sound",
            Section::Advanced => "advanced",
            Section::Appearance => "appearance",
            Section::General => "general",
        }
    }

    pub fn label(self, language: &str) -> &'static str {
        crate::i18n::settings_text(self.key(), language)
    }

    pub fn caption(self, language: &str) -> &'static str {
        crate::i18n::settings_text(&format!("{}Desc", self.key()), language)
    }

    pub fn glyph(self) -> &'static str {
        match self {
            Section::Workspaces => "Layers",
            Section::Activation => "Mouse",
            Section::Sound => "Volume2",
            Section::Advanced => "Shield",
            Section::Appearance => "Palette",
            Section::General => "Settings",
        }
    }
}

/// What the panel wants the host to do.
#[derive(Debug, Default)]
pub struct Request {
    /// Re-arm the triggers, because a binding or a switch changed.
    pub rearm: bool,
    /// Put the login entry in or take it out.
    pub set_autostart: Option<bool>,
    /// Open a URL in the user's browser.
    pub open_url: Option<String>,
    /// Record a new global shortcut or mouse button.
    pub record: Option<Recording>,
    /// Restore the shipped configuration.
    pub reset: bool,
    pub export: bool,
    pub import: bool,
    /// Play this note once, so a sound can be heard before it is chosen.
    pub preview_sound: Option<String>,
    /// Go and ask the release feed what the newest version is.
    pub check_updates: bool,
    /// Store this icon out of this library, and put it on the target the picker is open for.
    pub take_library_icon: Option<(std::path::PathBuf, u32)>,
    /// Open the system's file dialog and put the chosen picture on this target.
    ///
    /// The host runs it, not the panel: the dialog is modal and blocks the message loop, and this
    /// is decided in the middle of a frame.
    pub pick_icon: Option<super::workspace::IconTarget>,
    /// The installed-apps list is wanted. Asked for every frame the picker is open; the host
    /// answers once and then answers from its own cache, which is what keeps this cheap.
    pub list_apps: bool,
    /// Open the system's folder or file dialog and put the chosen path in the add panel's draft.
    ///
    /// The host runs it for the same reason it runs the icon dialog: it is modal, it holds the
    /// message loop, and this is decided in the middle of a frame.
    pub pick_path: Option<super::workspace::AddMode>,
}

/// Where an update check got to.
#[derive(Debug, Clone, PartialEq)]
pub enum UpdateState {
    Checking,
    UpToDate,
    Available { version: String, url: String },
    /// Asked and could not be answered — no network, a rate limit, a feed that moved.
    Unreachable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recording {
    Shortcut,
    MouseButton,
}

pub struct SettingsUi {
    pub section: Section,
    /// A recording in progress, so the row can say so and the hooks can be told.
    pub recording: Option<Recording>,
    /// The index of the workspace being edited, if any.
    pub editing_workspace: Option<usize>,
    /// How tall the open editor's contents were last frame, so the dialog can be that tall.
    ///
    /// A dialog is sized by what is in it, and what is in it is only known once it has been
    /// drawn. Zero means "not measured yet", which opens it at its full height.
    pub editor_height: f32,
    /// How tall the open shortcut's card was last frame.
    ///
    /// The card's plate has to be painted BEFORE the fields inside it, and its height is only
    /// known after they have been laid out. One row is open at a time, so one number — and it is
    /// cleared whenever a different row opens, so a tall card's height is never worn by a short one.
    pub item_card_h: f32,
    /// What was dropped on the window, and WHERE, waiting for the page that knows what to do
    /// with it.
    ///
    /// Set by `app.rs` from the drop target and taken by the Shortcuts list. It arrives at a frame
    /// rather than at a handler because this panel has none: every answer it gives is a function
    /// of the state at the top of a frame, and a drop is one more piece of that state.
    ///
    /// The point travels WITH the payload because by the time a frame reads this the hover is
    /// over — `drag` is already `None` — and where the hand let go is the only thing that can say
    /// which section was being dropped on.
    pub dropped: Option<(crate::sys::dropped::Payload, (f32, f32))>,
    /// A folder or file dialog the add panel asked for, waiting to be handed to the host.
    ///
    /// On the state rather than straight onto the request because the panel that raises it is
    /// several frames deep in a list and does not hold one.
    pub pick_path: Option<super::workspace::AddMode>,
    /// An action that destroys something asks twice. This is which one is waiting.
    pub confirming: Option<String>,
    /// Which workspace is waiting for a key. Separate from `recording` because this one is read
    /// from the settings window's own keyboard and never arms the global hook.
    pub recording_key: Option<usize>,
    /// The kind of shortcut the add bar is offering, if any.
    pub add_mode: Option<super::workspace::AddMode>,
    /// The half-written shortcut.
    pub draft: super::workspace::Draft,
    /// The term narrowing the installed-apps list.
    pub app_search: String,
    /// Which shortcut's row is expanded, BY ID: the list reorders underneath it.
    pub editing_item: Option<String>,
    /// Whose icon the picker is open for.
    pub icon_picker: Option<super::workspace::IconTarget>,
    /// The term narrowing the glyph list.
    pub icon_search: String,
    /// What is installed, as the host last handed it over. Empty until it has been asked for.
    pub installed: Vec<super::workspace::Installed>,
    /// Whether the installed list is picking several applications at once.
    ///
    /// Off by default, and reset whenever the add panel closes: the list's ordinary behaviour is
    /// that a row IS the add, and a mode where a click only ticks a box has to be asked for.
    pub multi_select: bool,
    /// The commands ticked so far, which is what the original selects by too.
    ///
    /// By command rather than by index: the list is filtered as the search is typed, and an index
    /// into it means a different application one keystroke later.
    pub selected_apps: Vec<String>,
    /// Set by the host when the configured shortcut could not be registered.
    pub shortcut_taken: bool,
    /// A program or library the picker is showing the icons of, and how many it holds.
    pub icon_library: Option<(std::path::PathBuf, u32)>,
    /// How far down that grid has been scrolled, in rows.
    pub icon_library_row: u32,
    /// Whether the dock's own shortcut list is the page being shown.
    pub editing_dock: bool,
    /// The open workspace, as the text the code view is editing.
    ///
    /// `Some` IS the code view — there is no separate flag, because a flag and a buffer can
    /// disagree and the only state either could describe is "there is text being edited". It
    /// carries the id of the workspace it came out of and `workspace::editor` drops it when that
    /// is no longer the one on screen.
    pub code: Option<super::code::Buffer>,
    /// What the last update check found. `None` is "nobody has asked".
    pub update_state: Option<UpdateState>,
    /// The slice the try-wheel last played a note for.
    ///
    /// `None` is "the pointer is not on it", which is a state of its own: leaving and coming back
    /// should sound like arriving, and a frame that merely redraws should sound like nothing.
    pub try_highlight: Option<Option<usize>>,
    /// Whether the sidebar is down to its icon rail.
    pub nav_collapsed: bool,
    /// The sections stepped away from, and the ones stepped back out of.
    ///
    /// Two stacks rather than a cursor into one list, which is how every browser does it and the
    /// only shape in which "go back, then pick something else" throws the forward side away
    /// without any bookkeeping.
    pub back: Vec<Section>,
    pub forward: Vec<Section>,
    /// What the sidebar's search field is narrowing the panel to.
    pub search: String,
}

impl Default for SettingsUi {
    fn default() -> Self {
        Self {
            section: Section::Workspaces,
            recording: None,
            editing_workspace: None,
            editor_height: 0.0,
            dropped: None,
            pick_path: None,
            item_card_h: 0.0,
            confirming: None,
            recording_key: None,
            add_mode: None,
            draft: super::workspace::Draft::default(),
            app_search: String::new(),
            editing_item: None,
            icon_picker: None,
            icon_search: String::new(),
            installed: Vec::new(),
            multi_select: false,
            selected_apps: Vec::new(),
            shortcut_taken: false,
            icon_library: None,
            icon_library_row: 0,
            editing_dock: false,
            code: None,
            update_state: None,
            try_highlight: None,
            nav_collapsed: false,
            back: Vec::new(),
            forward: Vec::new(),
            search: String::new(),
        }
    }
}

impl SettingsUi {
    /// Go to `section`, remembering where we were.
    ///
    /// Picking the page already on screen is not a step: without this, clicking the current nav
    /// row would fill the back stack with the same section over and over and the back button
    /// would appear to do nothing for the first dozen presses.
    pub fn go(&mut self, section: Section) {
        if self.section == section {
            return;
        }
        self.back.push(self.section);
        self.forward.clear();
        self.section = section;
    }
}

/// How wide the sidebar is, in DIPs — the 235 the original uses plus its 1px rule.
const NAV_W: f32 = 236.0;
/// How wide it is once it has been collapsed to its icons.
const NAV_RAIL_W: f32 = 58.0;
/// The content's own padding: the original's `.zs-scroll`.
const CONTENT_PAD_X: f32 = 35.2;
const CONTENT_PAD_TOP: f32 = 32.0;
/// The scroll bar's track, which the column is held clear of whether or not one is showing.
///
/// Reserved unconditionally because the alternative is a column that shifts sideways by nine
/// pixels the moment a page grows past the window, which is visible as a jump every time a
/// disclosure opens.
const SCROLLBAR_W: f32 = 9.0;

pub fn draw(
    f: &mut Frame,
    state: &mut SettingsUi,
    config: &mut UiConfig,
    version: &str,
) -> Request {
    let mut request = Request::default();
    // Decided once, for the whole surface. A panel where half the rows had worked out which way
    // the language reads and half had not would be worse than either answer.
    f.rtl = crate::i18n::is_rtl(&config.language);
    // An open dropdown is a modal: the click that lands in its list must not also land on the row
    // the list is covering. Lifted again by `w::menu_layer`, once the list has been drawn.
    f.blocked = f.ui.list_open();
    let window = f.bounds;

    f.p.fill_rect(window, f.theme.bg);

    let bar_h = f.px(crate::win::settings::TITLEBAR_H);
    let bar = Rect::new(window.left, window.top, window.right, window.top + bar_h);
    titlebar(f, bar, state);

    let nav_w = if state.nav_collapsed { NAV_RAIL_W } else { NAV_W };
    let nav = Rect::new(window.left, bar.bottom, window.left + f.px(nav_w), window.bottom);
    sidebar(f, state, nav, &config.language, version);

    let content = Rect::new(nav.right, bar.bottom, window.right, window.bottom);
    f.p.fill_rect(content, f.theme.surface);

    // The column: the content's own padding, with the scroll bar's track held clear on the right.
    // Not centred and not capped — the original lets the column grow with the window, and a row
    // that stopped following the frame would read as a panel that had failed to resize.
    let left = content.left + f.px(CONTENT_PAD_X);
    let inner_w = (content.width() - f.px(CONTENT_PAD_X * 2.0 + SCROLLBAR_W)).max(f.px(240.0));

    // The results are a page of their own, so they scroll on their own. Sharing the section's
    // offset meant searching from halfway down Sound opened the results already scrolled, past
    // whatever matched first.
    let scroll_id = if state.search.trim().is_empty() {
        format!("content:{:?}", state.section)
    } else {
        "content:results".to_string()
    };
    let offset = f.ui.scroll_of(&scroll_id);

    // The scroller, clipped to the viewport it scrolls inside.
    //
    // The clip is what makes the offset safe. A page is laid out from `content.top - offset`, so
    // every row above the viewport is at a real negative position with the titlebar drawn over
    // that ground already — and the window buttons are painted after the column, so the leak came
    // out as rows sliding across a titlebar that had apparently turned transparent.
    //
    // What belongs to the window rather than to the column still gets out: the dropdown lists by
    // being drawn downstream of it, in `w::menu_layer`, and the icon picker and the colour palette
    // with `escape_clip`. Clipped to the column, each would lose the shadow that separates it, and
    // the taller lists would lose their last options as well.
    let saved_bounds = f.bounds;
    let saved_y = f.y;
    f.bounds = Rect::new(left, content.top, left + inner_w, content.bottom);
    f.y = content.top + f.px(CONTENT_PAD_TOP) - offset;
    f.clip_to(content);

    let start_y = f.y;
    let section = state.section;

    // A term in the search field replaces the page with what matched it, out of every page.
    let term = state.search.trim().to_lowercase();
    if !term.is_empty() {
        results(f, state, config, &mut request, version, &term);

        let content_h = f.y - start_y + f.px(CONTENT_PAD_TOP);
        f.unclip();
        f.bounds = saved_bounds;
        f.y = saved_y;
        scroll_and_furniture(f, config, content, &scroll_id, offset, content_h);
        return request;
    }

    // Every page says its own name, the ones with a dialog over them included: the editor is a
    // sheet over the grid it was opened from, and a page that blanked itself underneath would be
    // a dialog that had nothing to go back to.
    page_head(f, section.label(&config.language), section.caption(&config.language));

    // What is under an open dialog is drawn, and inert. `blocked` is what the rows already read to
    // tell "not under the pointer" from "not available", so the page needs no idea a dialog exists.
    let editing_workspace = state
        .editing_workspace
        .filter(|&index| index < config.workspaces.len());
    let covered = (section == Section::Workspaces && editing_workspace.is_some())
        || (section == Section::Appearance && state.editing_dock);
    let was_blocked = f.blocked;
    f.blocked |= covered;

    match section {
        Section::Workspaces => {
            // One section, one page, and a dialog over it. The editor is not a section of its own
            // because the nav would then have a row that is only reachable from another row.
            state.editing_workspace = editing_workspace;
            workspaces(f, state, config);
        }
        Section::Activation => activation(f, state, config, &mut request),
        Section::Sound => sound(f, state, config, &mut request),
        Section::Advanced => advanced(f, state, config, &mut request),
        Section::Appearance => appearance(f, state, config),
        Section::General => general(f, state, config, &mut request, version),
    }
    f.blocked = was_blocked;
    let content_h = f.y - start_y + f.px(CONTENT_PAD_TOP);

    // The dialog, over whichever page it belongs to. Drawn from here rather than from inside the
    // page so that the page's own height is already settled: the editor steps out of the scrolling
    // column entirely, and a sheet that had added to the column's height would scroll the grid
    // behind it by its own length.
    if let Some(index) = editing_workspace {
        if !super::workspace::editor(f, state, config, index, &mut request) {
            state.editing_workspace = None;
        }
        request.list_apps = state.add_mode == Some(super::workspace::AddMode::App);
    } else if state.editing_dock {
        if !super::workspace::dock_editor(f, state, config, &mut request) {
            state.editing_dock = false;
        }
        request.list_apps = state.add_mode == Some(super::workspace::AddMode::App);
    }
    // Handed over once, by the one place that holds both the state and the request. The panel that
    // asked for it is several frames of layout away from either.
    request.pick_path = state.pick_path.take();

    f.unclip();
    f.bounds = saved_bounds;
    f.y = saved_y;
    scroll_and_furniture(f, config, content, &scroll_id, offset, content_h);

    request
}

/// The scroll bar, the toast and the welcome card: everything that sits over a page rather than
/// on it, and that every page — the results among them — finishes with.
fn scroll_and_furniture(
    f: &mut Frame,
    config: &mut UiConfig,
    content: Rect,
    scroll_id: &str,
    offset: f32,
    content_h: f32,
) {
    let viewport_h = content.height();
    let max_offset = (content_h - viewport_h).max(0.0);
    // A page under a dialog keeps its offset and loses its controls. Without this the wheel turned
    // over the dialog's own list would move both, and the page's scroll bar — drawn after the
    // dialog, because the toast and the dropdowns have to be — would be a stripe across it.
    if max_offset > 0.0 && !f.modal {
        if content.contains(f.input.pointer.0, f.input.pointer.1) && f.input.scroll != 0.0 {
            // Three rows a notch, which is what every list in Windows does.
            let next = (offset - f.input.scroll * f.px(54.0)).clamp(0.0, max_offset);
            f.ui.set_scroll(scroll_id, next);
            f.want_frame();
        }
        scrollbar(f, content, offset, content_h, viewport_h);
    } else if offset != 0.0 {
        f.ui.set_scroll(scroll_id, 0.0);
    }

    if let Some((text, progress)) = f.ui.current_toast() {
        toast(f, content, &text.to_string(), progress);
    }

    // The open dropdown's list, over the page, the scroll bar and the toast alike.
    w::menu_layer(f);

    // The welcome card, over whatever the panel is showing. Last, so it covers the nav as well:
    // a modal that leaves the sidebar clickable is a modal that can be navigated out from under.
    if config.has_seen_onboarding != Some(true) && super::firstrun::draw(f, config) {
        config.has_seen_onboarding = Some(true);
        f.mark_dirty();
    }
}

/// Every page's rows, with only the ones that match the term left standing.
///
/// Running all six pages is what makes this cheap to be right about: there is no second list of
/// what the settings are called that could fall out of step with the rows themselves, and a row
/// added to Advanced next year is searchable the day it is written.
///
/// Workspaces is not among them. Its page is a grid of pictures rather than a list of sentences,
/// and a workspace is not a setting — searching for one is what the nav is for.
fn results(
    f: &mut Frame,
    state: &mut SettingsUi,
    config: &mut UiConfig,
    request: &mut Request,
    version: &str,
    term: &str,
) {
    page_head(f, "Results", &format!("Settings matching \u{201c}{term}\u{201d}."));

    let before = f.y;
    f.filter = Some(term.to_string());
    activation(f, state, config, request);
    sound(f, state, config, request);
    advanced(f, state, config, request);
    appearance(f, state, config);
    general(f, state, config, request, version);
    f.filter = None;
    // A heading whose rows were all filtered out never got drawn. Dropped rather than flushed:
    // it would otherwise appear at the bottom of the results with nothing under it.
    let _ = f.take_group();

    if f.y <= before {
        let style = w::body_style(f.scale, f.rtl);
        let message = "Nothing here answers to that. Try a word from the setting itself.";
        let (_, th) = f.p.measure(message, &style);
        f.p.text(
            message,
            Rect::new(f.bounds.left, f.y, f.bounds.right, f.y + th),
            &style,
            f.theme.text_3,
        );
        f.y += th;
    }
}

// ─── Chrome ─────────────────────────────────────────────────────────────────

/// A page's name and the sentence under it.
///
/// Every section opens with one. It is the only thing on the page that says where you are once the
/// nav has been collapsed to its icons, which is why it is not merely decoration.
fn page_head(f: &mut Frame, title: &str, caption: &str) {
    // Both blocks are given the line box the original's CSS gives them, with the ink centred in
    // it, rather than the height DirectWrite measures. Everything below a page head is positioned
    // off its total, so a font whose metrics differ by a pixel would otherwise move the whole page.
    let title_style = w::page_title_style(f.scale, f.rtl);
    let title_h = f.px(21.0 * 1.15);
    let (_, title_ink) = f.p.measure(title, &title_style);
    f.p.text(
        title,
        Rect::new(f.bounds.left, f.y + (title_h - title_ink) / 2.0, f.bounds.right, f.y + title_h),
        &title_style,
        f.theme.text,
    );
    f.y += title_h + f.px(4.0);

    let caption_style = w::page_caption_style(f.scale, f.rtl);
    let caption_h = f.px(12.5 * 1.45);
    let (_, caption_ink) = f.p.measure(caption, &caption_style);
    f.p.text(
        caption,
        Rect::new(f.bounds.left, f.y + (caption_h - caption_ink) / 2.0, f.bounds.right, f.y + caption_h),
        &caption_style,
        f.theme.text_2,
    );
    f.y += caption_h + f.px(20.0);
}

fn titlebar(f: &mut Frame, bar: Rect, state: &mut SettingsUi) {
    // The bar merges into the surface, like a native Windows window.
    f.p.fill_rect(bar, f.theme.sunken);
    f.p.fill_rect(
        Rect::new(bar.left, bar.bottom - f.px(1.0), bar.right, bar.bottom),
        f.theme.line,
    );

    // Where you are and how you got here, in the bar rather than on the page: the three of them
    // belong to the WINDOW, and a back arrow that scrolled away with the content would be a back
    // arrow nobody could find.
    let rects = nav_buttons(bar, f.scale);
    let enabled = [true, !state.back.is_empty(), !state.forward.is_empty()];
    let glyphs = [
        if state.nav_collapsed { "PanelLeftOpen" } else { "PanelLeftClose" },
        "ArrowLeft",
        "ArrowRight",
    ];
    for (index, rect) in rects.iter().enumerate() {
        let live = enabled[index];
        let hovered = live && f.hovered(*rect);
        if hovered {
            f.set_cursor(Cursor::Hand);
            f.p.fill_round_rect(*rect, rect.height() / 2.0, w::alpha(f.theme.text, 0.08));
        }
        if live && f.clicked(&format!("navbtn:{index}"), *rect) {
            match index {
                0 => state.nav_collapsed = !state.nav_collapsed,
                1 => {
                    if let Some(previous) = state.back.pop() {
                        state.forward.push(state.section);
                        state.section = previous;
                    }
                }
                _ => {
                    if let Some(next) = state.forward.pop() {
                        state.back.push(state.section);
                        state.section = next;
                    }
                }
            }
            // Stepping through the history is a way of choosing a page, so it ends a search
            // for the same reason clicking a nav row does. Without this the arrows look dead:
            // the section behind changes and the results stay on screen.
            if index > 0 {
                state.search.clear();
                if f.ui.is_focused("search") {
                    f.ui.blur();
                }
            }
            state.confirming = None;
            f.ui.close_menu();
        }
        // A step that cannot be taken is drawn, not hidden. An arrow that came and went would
        // move the two beside it, and the bar would never look the same twice.
        let colour = w::dimmed(
            if hovered { f.theme.text } else { f.theme.text_3 },
            live,
        );
        let (cx, cy) = rect.center();
        f.p.glyph(glyphs[index], (cx, cy), f.px(14.0), colour, 1.6);
    }
}

/// The three buttons at the left of the bar: collapse, back, forward.
fn nav_buttons(bar: Rect, scale: f32) -> [Rect; 3] {
    let w = 32.0 * scale;
    let h = 24.0 * scale;
    let top = bar.top + (bar.height() - h) / 2.0;
    let left = bar.left + 12.0 * scale;
    let step = w + 4.0 * scale;
    [
        Rect::new(left, top, left + w, top + h),
        Rect::new(left + step, top, left + step + w, top + h),
        Rect::new(left + step * 2.0, top, left + step * 2.0 + w, top + h),
    ]
}

/// Where every drawn button in the bar is, so `WM_NCHITTEST` can keep the caption off them.
///
/// The three on the left as well as the three on the right. Without them the collapse and the two
/// arrows sit inside the drag region, and pressing one moves the window instead.
pub fn caption_buttons(bar: Rect, scale: f32) -> [Rect; 6] {
    let w = 46.0 * scale;
    let nav = nav_buttons(bar, scale);
    [
        nav[0],
        nav[1],
        nav[2],
        Rect::new(bar.right - w * 3.0, bar.top, bar.right - w * 2.0, bar.bottom),
        Rect::new(bar.right - w * 2.0, bar.top, bar.right - w, bar.bottom),
        Rect::new(bar.right - w, bar.top, bar.right, bar.bottom),
    ]
}

/// The window buttons. Returns which was pressed: 0 minimise, 1 maximise, 2 close.
pub fn window_buttons(f: &mut Frame, bar: Rect, maximized: bool) -> Option<usize> {
    let all = caption_buttons(bar, f.scale);
    let rects = &all[3..];
    let mut pressed = None;
    for (index, rect) in rects.iter().enumerate() {
        let hovered = f.hovered(*rect);
        if f.clicked(&format!("caption:{index}"), *rect) {
            pressed = Some(index);
        }
        if hovered {
            // Windows does not animate the highlight on these buttons — it lights up and goes out
            // at once. A transition here reads as an app effect rather than a system window.
            let fill = if index == 2 {
                pal::CLOSE_HOVER
            } else {
                w::alpha(f.theme.text, 0.08)
            };
            f.p.fill_rect(*rect, fill);
        }
        let colour = if hovered && index == 2 {
            pal::rgb(pal::WHITE)
        } else if hovered {
            f.theme.text
        } else {
            f.theme.text_3
        };
        // The same three Lucide glyphs the original uses, rather than hand-drawn lines: the
        // maximise one is a set of corner brackets and not a square, and a square in its place is
        // the single most recognisable way in which this bar used to look like a different app's.
        let (cx, cy) = rect.center();
        let glyph = match index {
            0 => "Minus",
            1 if maximized => "Minimize",
            1 => "Maximize",
            _ => "X",
        };
        f.p.glyph(glyph, (cx, cy), f.px(13.0), colour, 1.6);
    }
    pressed
}

fn sidebar(f: &mut Frame, state: &mut SettingsUi, nav: Rect, language: &str, version: &str) {
    f.p.fill_rect(nav, f.theme.sunken);
    f.p.fill_rect(
        Rect::new(nav.right - f.px(1.0), nav.top, nav.right, nav.bottom),
        f.theme.line,
    );

    let collapsed = state.nav_collapsed;
    let pad = f.px(12.0);
    // The rail centres one 34x34 square; the open sidebar runs its rows the full width.
    let item = |f: &Frame, y: f32| -> Rect {
        if collapsed {
            let side = f.px(34.0);
            let left = nav.left + (nav.width() - f.px(1.0) - side) / 2.0;
            Rect::new(left, y, left + side, y + side)
        } else {
            Rect::new(nav.left + pad, y, nav.right - f.px(1.0) - pad, y + f.px(34.0))
        }
    };

    let mut y = nav.top + f.px(20.0);

    // The panel's own name. Gone with the labels when the sidebar is a rail: a 15px word in a
    // 58px column is a word that has been cut in half.
    if !collapsed {
        let style = w::sidebar_title_style(f.scale, f.rtl);
        let title = crate::i18n::settings_text("settings", language);
        // The CSS line box, not the measured ink: the search field and the whole nav below it are
        // placed off this number, and a font that measured a pixel short would walk the list up.
        let th = f.px(23.25);
        let (_, ink) = f.p.measure(title, &style);
        let at = if f.rtl {
            Rect::new(nav.left, y + (th - ink) / 2.0, nav.right - pad - f.px(8.0), y + th)
        } else {
            Rect::new(nav.left + pad + f.px(8.0), y + (th - ink) / 2.0, nav.right, y + th)
        };
        f.p.text(title, at, &style, f.theme.text);
        y += th + f.px(16.0);
    }

    // The search field, which narrows the whole panel rather than this list.
    //
    // A control's height when it is one, a nav square's when it has become an icon button: on the
    // rail it is a sibling of the six below it and has to match them, and in the open sidebar it
    // is a text field and has to match every other text field in the product.
    let field = if collapsed {
        item(f, y)
    } else {
        let full = item(f, y);
        Rect::new(full.left, y, full.right, y + f.px(pal::CONTROL_H))
    };
    search_field(f, state, field, language, collapsed);
    y = field.bottom + f.px(16.0);

    for section in Section::ALL {
        let rect = item(f, y);
        let selected = state.section == section;
        let hovered = f.hovered(rect);
        if hovered {
            f.set_cursor(Cursor::Hand);
        }
        if f.clicked(&format!("nav:{:?}", section), rect) {
            state.go(section);
            // Picking a page is an answer to the question the search was asking.
            state.search.clear();
            state.confirming = None;
            f.ui.close_menu();
        }
        // A discreet active state: a raised surface and a hairline, never a high-contrast pill.
        if selected {
            f.p.fill_round_rect(rect, f.px(pal::R_CONTROL), f.theme.raised);
            f.p.stroke_round_rect(rect.inflate(-0.5), f.px(pal::R_CONTROL), f.theme.line, 1.0);
        } else if hovered {
            f.p.fill_round_rect(rect, f.px(pal::R_CONTROL), f.theme.hover);
        }
        let colour = if selected || hovered { f.theme.text } else { f.theme.text_2 };
        let icon_colour = if selected { f.theme.text } else if hovered { f.theme.text_2 } else { f.theme.text_3 };
        let glyph_x = if collapsed {
            rect.center().0
        } else if f.rtl {
            rect.right - f.px(16.0)
        } else {
            rect.left + f.px(16.0)
        };
        f.p.glyph(
            section.glyph(),
            (glyph_x, rect.center().1),
            f.px(16.0),
            icon_colour,
            2.0,
        );
        if !collapsed {
            let style = w::nav_style(f.scale, f.rtl);
            let label = section.label(language);
            let (_, th) = f.p.measure(label, &style);
            // Past the glyph's own box with room to spare: a 16px glyph centred at 16 reaches 24,
            // and the ones that fill their box (Layers, Palette) are why this is not 26.
            let text_at = if f.rtl {
                Rect::new(rect.left, rect.center().1 - th / 2.0, rect.right - f.px(35.0), rect.bottom)
            } else {
                Rect::new(rect.left + f.px(35.0), rect.center().1 - th / 2.0, rect.right, rect.bottom)
            };
            f.p.text(label, text_at, &style, colour);
        }
        y = rect.bottom + f.px(2.0);
    }

    // The foot: the mark and the product's name at one end, the build at the other, over a rule.
    //
    // The version has a row of its own in General as well, which is where somebody reads it. This
    // is the other thing a version number is for — being seen without being looked for, so that
    // the answer to "which build is this" is already on screen when the question comes up.
    if collapsed {
        return;
    }
    let foot_h = f.px(34.0);
    let foot = Rect::new(
        nav.left + pad,
        nav.bottom - f.px(12.0) - foot_h,
        nav.right - f.px(1.0) - pad,
        nav.bottom - f.px(12.0),
    );
    f.p.fill_rect(
        Rect::new(foot.left, foot.top, foot.right, foot.top + f.px(1.0)),
        f.theme.line,
    );
    let mark = f.px(14.0);
    // The name is a shade brighter than the number beside it: one is the product and the other is
    // a detail about this copy of it, and they are not read with the same attention.
    let brand_style = Style::new(Family::Ui, 11.0 * f.scale, 500, Align::Leading).rtl(f.rtl);
    let (_, th) = f.p.measure("Rovyl", &brand_style);
    // Tabular, as the original sets it: the build number sits under a column of nav labels and
    // is the one string down there that changes between builds.
    let version_style = w::small_style(f.scale, f.rtl).tabular();
    let (vw, vh) = f.p.measure(version, &version_style);
    let baseline = foot.top + f.px(1.0) + (foot.height() - f.px(1.0)) / 2.0;
    if f.rtl {
        crate::wheel::render::draw_logo_probe_at(
            f.p,
            (foot.right - mark / 2.0, baseline),
            mark,
            f.theme.text_2,
            f.theme.sunken,
        );
        // Ends where the mark begins. A right-to-left run is aligned to the RIGHT edge of the
        // rectangle it is given, so a box that reaches `foot.right` puts the word on top of the
        // mark rather than beside it.
        f.p.text(
            "Rovyl",
            Rect::new(foot.left, baseline - th / 2.0, foot.right - mark - f.px(6.0), foot.bottom),
            &brand_style,
            f.theme.text_2,
        );
        f.p.text(
            version,
            Rect::new(foot.left, baseline - vh / 2.0, foot.left + vw, foot.bottom),
            &version_style,
            f.theme.text_3,
        );
    } else {
        crate::wheel::render::draw_logo_probe_at(
            f.p,
            (foot.left + mark / 2.0, baseline),
            mark,
            f.theme.text_2,
            f.theme.sunken,
        );
        f.p.text(
            "Rovyl",
            Rect::new(foot.left + mark + f.px(6.0), baseline - th / 2.0, foot.right, foot.bottom),
            &brand_style,
            f.theme.text_2,
        );
        f.p.text(
            version,
            Rect::new(foot.right - vw, baseline - vh / 2.0, foot.right, foot.bottom),
            &version_style,
            f.theme.text_3,
        );
    }
}

/// The sidebar's search box, and the icon button it becomes on the rail.
fn search_field(f: &mut Frame, state: &mut SettingsUi, at: Rect, language: &str, collapsed: bool) {
    let hovered = f.hovered(at);
    if hovered {
        f.set_cursor(if collapsed { Cursor::Hand } else { Cursor::Text });
    }
    f.p.fill_round_rect(at, f.px(pal::R_CONTROL), f.theme.surface);
    f.p.stroke_round_rect(
        at.inflate(-0.5),
        f.px(pal::R_CONTROL),
        if f.ui.is_focused("search") { f.theme.line_strong } else { f.theme.line },
        1.0,
    );

    if collapsed {
        // No room for a field. The icon opens the sidebar back up and puts the caret in it, which
        // is the only thing the user could have wanted by pressing a magnifier this small.
        f.p.glyph("Search", at.center(), f.px(14.0), f.theme.text_2, 1.7);
        if f.clicked("search-open", at) {
            state.nav_collapsed = false;
            f.ui.begin_edit("search", &state.search.clone());
        }
        return;
    }

    let glyph_x = if f.rtl { at.right - f.px(17.0) } else { at.left + f.px(17.0) };
    f.p.glyph("Search", (glyph_x, at.center().1), f.px(14.0), f.theme.text_3, 1.7);
    let text_at = if f.rtl {
        Rect::new(at.left + f.px(8.0), at.top, at.right - f.px(31.0), at.bottom)
    } else {
        Rect::new(at.left + f.px(31.0), at.top, at.right - f.px(8.0), at.bottom)
    };
    if let Some(next) = w::text_field_bare(
        f,
        "search",
        text_at,
        &state.search,
        crate::i18n::settings_text("searchSettings", language),
    ) {
        state.search = next;
    }
}

fn scrollbar(f: &mut Frame, area: Rect, offset: f32, content_h: f32, viewport_h: f32) {
    let track_w = f.px(9.0);
    let track = Rect::new(area.right - track_w, area.top, area.right, area.bottom);
    let ratio = (viewport_h / content_h).clamp(0.05, 1.0);
    let thumb_h = (track.height() * ratio).max(f.px(28.0));
    let span = track.height() - thumb_h;
    let t = if content_h > viewport_h {
        offset / (content_h - viewport_h)
    } else {
        0.0
    };
    let top = track.top + span * t.clamp(0.0, 1.0);
    f.p.fill_round_rect(
        Rect::new(track.left + f.px(2.0), top, track.right - f.px(2.0), top + thumb_h),
        f.px(3.0),
        w::alpha(f.theme.text, 0.15),
    );
}

fn toast(f: &mut Frame, area: Rect, text: &str, progress: f32) {
    // It rises on the way in and fades on the way out; in between it just sits there.
    let fade = (progress * 8.0).min(1.0) * ((1.0 - progress) * 8.0).min(1.0);
    let style = Style::new(Family::Ui, 12.0 * f.scale, 450, Align::Center);
    let (tw, th) = f.p.measure(text, &style);
    let pad = f.px(16.0);
    let rect = Rect::centred(
        area.center().0,
        area.bottom - f.px(40.0),
        tw + pad * 2.0,
        th + f.px(18.0),
    );
    w::shadow_panel(f, rect);
    f.p.fill_round_rect(rect, f.px(pal::R_PANEL), w::alpha(f.theme.bg, fade));
    f.p.text(
        text,
        Rect::new(rect.left, rect.center().1 - th / 2.0, rect.right, rect.bottom),
        &style,
        w::alpha(f.theme.text, fade),
    );
    f.want_frame();
}

// ─── General ────────────────────────────────────────────────────────────────

fn general(
    f: &mut Frame,
    state: &mut SettingsUi,
    config: &mut UiConfig,
    request: &mut Request,
    version: &str,
) {
    // One unnamed group: three rows under three headings was a heading per row, which labels
    // nothing the row's own title does not already say.
    w::group(f, "");

    let r = w::row(
        f,
        "Start with Windows",
        "Rovyl is ready as soon as you sign in to Windows.",
        40.0,
    );
    let on = config.open_at_login == Some(true);
    if w::switch(f, "openAtLogin", r.control, on, true) {
        config.open_at_login = Some(!on);
        request.set_autostart = Some(!on);
        f.mark_dirty();
    }

    let r = w::row(f, "Language", "Choose interface display language.", 150.0);
    let choices: Vec<Choice> = crate::i18n::LANGUAGES
        .iter()
        .map(|l| Choice::with_hint(l.code, l.endonym, l.english))
        .collect();
    w::select(f, "language", r.control, &choices, &config.language, true);
    if let Some(value) = w::select_popup(f, "language", &choices, &config.language) {
        config.language = value;
        f.mark_dirty();
    }

    // The release feed both builds publish to, asked only when somebody asks. A launcher that
    // phones home on every start is a launcher with a network dependency it did not need, and
    // this one opens in four milliseconds on a machine with no network at all.
    let (description, label, enabled) = match state.update_state.as_ref() {
        None => (
            format!("You are on {version}."),
            "Check".to_string(),
            true,
        ),
        Some(UpdateState::Checking) => (
            "Asking the release feed\u{2026}".to_string(),
            "Checking".to_string(),
            false,
        ),
        Some(UpdateState::UpToDate) => (
            format!("{version} is the newest there is."),
            "Check again".to_string(),
            true,
        ),
        Some(UpdateState::Available { version: found, .. }) => (
            format!("{found} is out. You are on {version}."),
            "Open release".to_string(),
            true,
        ),
        Some(UpdateState::Unreachable) => (
            "Could not reach the release feed.".to_string(),
            "Try again".to_string(),
            true,
        ),
    };
    let r = w::row(f, "Check for updates", &description, 130.0);
    let primary = matches!(state.update_state, Some(UpdateState::Available { .. }));
    if w::button(
        f,
        "updates",
        r.control,
        &label,
        if primary { ButtonKind::Primary } else { ButtonKind::Normal },
        enabled,
    ) {
        match state.update_state.as_ref() {
            Some(UpdateState::Available { url, .. }) => {
                request.open_url = Some(url.clone());
            }
            _ => {
                state.update_state = Some(UpdateState::Checking);
                request.check_updates = true;
            }
        }
    }

    let r = w::row(f, "GitHub", "Source code, releases, and issues.", 90.0);
    if w::button(f, "github", r.control, "Open", ButtonKind::Normal, true) {
        request.open_url = Some("https://github.com/arshit09/rovyl".into());
    }

    let r = w::row(f, "Version", "The build you are running.", 120.0);
    let style = w::value_style(f.scale, f.rtl);
    let (_, th) = f.p.measure(version, &style);
    f.p.text(
        version,
        Rect::new(
            r.control.left,
            r.control.center().1 - th / 2.0,
            r.control.right,
            r.control.bottom,
        ),
        &Style::new(Family::Ui, 11.5 * f.scale, 500, Align::Trailing),
        f.theme.text_2,
    );
}

// ─── Activation ─────────────────────────────────────────────────────────────

fn activation(f: &mut Frame, state: &mut SettingsUi, config: &mut UiConfig, request: &mut Request) {
    w::group(f, "Keyboard");

    let keyboard_on = config.keyboard_trigger_on();
    let mouse_on = config.enable_mouse_trigger;

    let r = w::row(
        f,
        "Enable keyboard trigger",
        "Open the wheel with a keyboard shortcut.",
        40.0,
    );
    if w::switch(f, "keyboard", r.control, keyboard_on, true) {
        // Turning off the LAST trigger would leave no way in, so the other one comes on in the
        // same change — the pair behaves like a choice of route rather than two switches that can
        // both be down.
        //
        // The press is never refused. Someone switching the last trigger off is not making a
        // mistake, they are saying "not this one", and answering that with a message leaves them to
        // work out the other half themselves; doing it for them is the answer they meant.
        if keyboard_on && !mouse_on {
            config.enable_keyboard_trigger = Some(false);
            config.enable_mouse_trigger = true;
            f.ui.toast("Switched to the mouse trigger");
        } else {
            config.enable_keyboard_trigger = Some(!keyboard_on);
        }
        request.rearm = true;
        f.mark_dirty();
    }

    if keyboard_on {
        let recording = state.recording == Some(Recording::Shortcut);
        let description = if recording {
            "Press a combination. Escape cancels.".to_string()
        } else if state.shortcut_taken {
            format!(
                "{} is held by another program, so it does nothing here. Record a different one.",
                config.global_shortcut
            )
        } else {
            "Open the wheel over any application.".to_string()
        };
        let r = w::row(f, "Global shortcut", &description, 160.0);
        let label = if recording {
            "Press a combination\u{2026}".to_string()
        } else {
            config.global_shortcut.clone()
        };
        if w::button(
            f,
            "shortcut",
            r.control,
            &label,
            if recording { ButtonKind::Primary } else { ButtonKind::Normal },
            true,
        ) {
            state.recording = if recording { None } else { Some(Recording::Shortcut) };
            request.record = state.recording;
        }

        if recording {
            // The settings window has the keyboard while it is in front, so the combination
            // arrives as ordinary messages. No hook is armed for this and the global binding is
            // released while it lasts — otherwise pressing the CURRENT shortcut during recording
            // opens the wheel instead of being recorded.
            match read_shortcut(f.input) {
                Recorded::Nothing => {}
                Recorded::Cancelled => {
                    state.recording = None;
                    request.record = None;
                }
                Recorded::Modifierless => {
                    f.ui.toast("A shortcut needs Ctrl, Alt, Shift or Win");
                    // Written down, because "I pressed it and nothing happened" is the report
                    // this produces and the keys are gone by the time anybody asks.
                    crate::config::store::log_line(&format!(
                        "recording: refused keys {:?} (ctrl={} alt={} shift={} win={})",
                        f.input.keys, f.input.ctrl, f.input.alt, f.input.shift, f.input.win
                    ));
                }
                Recorded::Taken(accelerator) => {
                    crate::config::store::log_line(&format!("recording: took {accelerator}"));
                    state.recording = None;
                    request.record = None;
                    config.global_shortcut = accelerator;
                    request.rearm = true;
                    f.mark_dirty();
                }
            }
            f.want_frame();
        }

        let r = w::row(
            f,
            "Shortcut behavior",
            "How the global keyboard shortcut activates the menu.",
            150.0,
        );
        let current = match config.shortcut_trigger_mode {
            Some(ShortcutTriggerMode::Hold) => "hold",
            _ => "toggle",
        };
        // A select, not a segmented pair. The two are not a this-or-that of equal weight: Hold
        // changes what the key DOES for as long as it is held, and reading both labels at once
        // invites the reader to treat them as the same kind of answer.
        let choices = vec![Choice::new("toggle", "Toggle"), Choice::new("hold", "Hold")];
        w::select(f, "shortcutMode", r.control, &choices, current, true);
        if let Some(value) = w::select_popup(f, "shortcutMode", &choices, current) {
            config.shortcut_trigger_mode = Some(if value == "hold" {
                ShortcutTriggerMode::Hold
            } else {
                ShortcutTriggerMode::Toggle
            });
            f.mark_dirty();
        }
    }

    f.gap(28.0);
    w::group(f, "Mouse");

    let r = w::row(
        f,
        "Enable mouse trigger",
        "Open the wheel with a mouse button.",
        40.0,
    );
    if w::switch(f, "mouse", r.control, mouse_on, true) {
        if mouse_on && !keyboard_on {
            config.enable_mouse_trigger = false;
            config.enable_keyboard_trigger = Some(true);
            f.ui.toast("Switched to the keyboard trigger");
        } else {
            config.enable_mouse_trigger = !mouse_on;
        }
        request.rearm = true;
        f.mark_dirty();
    }

    if mouse_on {
        let recording = state.recording == Some(Recording::MouseButton);
        let r = w::row(
            f,
            "Trigger button",
            &trigger::phrase(config.mouse_trigger_button.as_deref()),
            170.0,
        );
        let chips = trigger::chips(config.mouse_trigger_button.as_deref());
        let label = if recording {
            "Press a button\u{2026}".to_string()
        } else {
            chips.join(" + ")
        };
        if w::button(
            f,
            "mouseButton",
            r.control,
            &label,
            if recording { ButtonKind::Primary } else { ButtonKind::Normal },
            true,
        ) {
            state.recording = if recording { None } else { Some(Recording::MouseButton) };
            request.record = state.recording;
        }

        // Left and right are click-only: hold means the wheel is up for as long as the button is
        // down, which for the primary or secondary button is a drag as far as the rest of Windows
        // is concerned. The row goes away rather than offering a mode that cannot work.
        if trigger::allows_hold(config.mouse_trigger_button.as_deref()) {
            let r = w::row(
                f,
                "Gesture behavior",
                "Click keeps the wheel open; hold runs the selection on release.",
                150.0,
            );
            let current = match config.mouse_trigger_mode {
                Some(TriggerMode::Hold) => "hold",
                _ => "click",
            };
            if let Some(value) = w::segmented(
                f,
                "mouseMode",
                r.control,
                &[("click", "Click"), ("hold", "Hold")],
                current,
                true,
            ) {
                config.mouse_trigger_mode = Some(if value == "hold" {
                    TriggerMode::Hold
                } else {
                    TriggerMode::Click
                });
                request.rearm = true;
                f.mark_dirty();
            }
        }
    }

    f.gap(28.0);
    w::group(f, "Position");

    let placement_decides = matches!(config.placement(), RadialPlacement::Cursor);
    let monitor = config.monitor_choice();
    // The consequence, not the mechanism. Nobody opens this panel wanting to know which display
    // object is asked for — they want to know which screen the thing they are about to launch will
    // be sitting on.
    let description = if placement_decides {
        "Appearance opens the wheel under the pointer, so it is already on the screen the pointer is on \u{2014} this choice has nothing left to decide."
    } else if matches!(monitor, RadialMonitor::Cursor) {
        "The wheel opens on the screen the pointer is already on, so what you launch lands where you are working."
    } else {
        "The wheel always opens on the main screen, wherever the pointer happens to be."
    };
    let r = w::row(f, "Monitor", description, 190.0);
    let current = if matches!(monitor, RadialMonitor::Cursor) { "cursor" } else { "primary" };
    if let Some(value) = w::segmented(
        f,
        "radialMonitor",
        r.control,
        &[("primary", "Main screen"), ("cursor", "Follow pointer")],
        current,
        !placement_decides,
    ) {
        config.radial_monitor = Some(if value == "cursor" {
            RadialMonitor::Cursor
        } else {
            RadialMonitor::Primary
        });
        f.mark_dirty();
    }

    if let Some(value) = w::slider_row(
        f,
        "threshold",
        "Activation zone",
        "Cursor distance required to confirm a target.",
        config.activation_threshold,
        20.0,
        120.0,
        1.0,
        false,
        None,
        &|v| format!("{} px", v.round()),
        true,
    ) {
        config.activation_threshold = value;
        f.mark_dirty();
    }
}

// ─── Sound ──────────────────────────────────────────────────────────────────

fn sound(f: &mut Frame, state: &mut SettingsUi, config: &mut UiConfig, request: &mut Request) {
    w::group(f, "");

    let sounds_on = config.sounds_on();
    let r = w::row(
        f,
        "Sound effects",
        "Short bass notes as the wheel opens and as you move between items.",
        40.0,
    );
    if w::switch(f, "sounds", r.control, sounds_on, true) {
        config.radial_sounds = Some(!sounds_on);
        f.mark_dirty();
    }
    if !sounds_on {
        return;
    }

    // Straight under the switch, because turning sound on is a request to hear it. The rows below
    // tune what it plays; this is where you find out what tuning them did.
    if !f.filtering() {
        try_wheel(f, state, config, request);
    }

    let open_on = config.radial_open_sound != Some(false);
    let r = w::row(
        f,
        "When the wheel opens",
        "One note as the wheel blooms open, and again when you aim back at the center.",
        40.0,
    );
    if w::switch(f, "openSound", r.control, open_on, true) {
        config.radial_open_sound = Some(!open_on);
        f.mark_dirty();
    }
    if open_on {
        let current = config
            .radial_open_sound_id
            .clone()
            .unwrap_or_else(|| "sub-tick".into());
        let r = w::row(
            f,
            "Opening sound",
            "Press play beside a name to hear it before choosing.",
            160.0,
        );
        let choices = sound_choices();
        w::select(f, "openSoundId", r.control, &choices, &current, true);
        if let Some(value) = w::select_popup(f, "openSoundId", &choices, &current) {
            request.preview_sound = Some(value.clone());
            config.radial_open_sound_id = Some(value);
            f.mark_dirty();
        }
    }

    let hover_on = config.radial_hover_sound != Some(false);
    let r = w::row(
        f,
        "When moving between items",
        "A note each time the highlight moves to a different item.",
        40.0,
    );
    if w::switch(f, "hoverSound", r.control, hover_on, true) {
        config.radial_hover_sound = Some(!hover_on);
        f.mark_dirty();
    }
    if hover_on {
        let current = config
            .radial_hover_sound_id
            .clone()
            .unwrap_or_else(|| "thump".into());
        let r = w::row(
            f,
            "Hover sound",
            "Press play beside a name to hear it before choosing.",
            160.0,
        );
        let choices = sound_choices();
        w::select(f, "hoverSoundId", r.control, &choices, &current, true);
        if let Some(value) = w::select_popup(f, "hoverSoundId", &choices, &current) {
            request.preview_sound = Some(value.clone());
            config.radial_hover_sound_id = Some(value);
            f.mark_dirty();
        }
    }

    let volume = config.radial_sound_volume.unwrap_or(100.0);
    if let Some(value) = w::slider_row(
        f,
        "soundVolume",
        "Volume",
        "How loud both sounds play. Windows volume still applies on top.",
        volume,
        0.0,
        100.0,
        10.0,
        true,
        Some("%"),
        &|v| format!("{}%", v.round()),
        true,
    ) {
        config.radial_sound_volume = Some(value);
        request.preview_sound = config.radial_hover_sound_id.clone();
        f.mark_dirty();
    }
}

/// A note's name, for the sentence that says which two you are about to hear.
fn sound_name(id: &str) -> &'static str {
    crate::sys::sound::CATALOGUE
        .iter()
        .find(|(value, _)| *value == id)
        .map(|(_, name)| *name)
        .unwrap_or("none")
}

fn sound_choices() -> Vec<Choice> {
    crate::sys::sound::CATALOGUE
        .iter()
        .map(|(id, name)| Choice::new(id, name))
        .collect()
}

// ─── Appearance ─────────────────────────────────────────────────────────────

fn appearance(f: &mut Frame, state: &mut SettingsUi, config: &mut UiConfig) {
    // The wheel itself, at the top, because everything below this line is a number whose effect
    // is only visible on it.
    // Not on the results page: a picture of the wheel is not a setting anyone searched for, and
    // it would be the first and largest thing under a heading that promised matches.
    if !f.filtering() {
        super::preview::draw(f, config);
    }

    w::group(f, "Theme");

    let r = w::row(
        f,
        "Rovyl surfaces",
        "Applies to the window and title bar. The wheel remains dark.",
        150.0,
    );
    let current = match config.theme() {
        Theme::White => "white",
        Theme::Black => "black",
    };
    if let Some(value) = w::segmented(
        f,
        "theme",
        r.control,
        &[("black", "Black"), ("white", "White")],
        current,
        true,
    ) {
        config.appearance_theme = Some(if value == "white" { Theme::White } else { Theme::Black });
        f.mark_dirty();
    }

    f.gap(28.0);
    w::group(f, "Wheel");

    let r = w::row(
        f,
        "Hover color",
        "Color used by the target under the pointer.",
        120.0,
    );
    if let Some(value) = w::color_field(f, "radialHoverColor", r.control, config.hover_color()) {
        config.radial_hover_color = Some(format!("#{value:06X}"));
        f.mark_dirty();
    }

    // Three descriptions, one per combination, because what this setting MEANS changes with the
    // other two — and a row whose sentence does not match the state it is in is worse than no
    // sentence.
    let by_pointer = matches!(config.selection_mode(), SelectionMode::Cursor);
    let description = if by_pointer {
        if config.direction_mode() {
            "Launch without clicking hides the pointer and aims by direction, so while it is on every shortcut owns an equal share of the screen regardless of this."
        } else {
            "Only the icon under the pointer highlights. Release away from every icon to cancel."
        }
    } else if config.radial_area_wedges == Some(true) {
        "The wheel is cut into equal wedges \u{2014} one per shortcut \u{2014} and the one you point at fills up. Click anywhere inside it."
    } else {
        "Every shortcut owns an equal share of the screen: point toward one and it highlights from anywhere. Click anywhere in its share."
    };
    let r = w::row(f, "Targeting", description, 150.0);
    if let Some(value) = w::segmented(
        f,
        "aim",
        r.control,
        &[("area", "Area"), ("cursor", "Pointer")],
        if by_pointer { "cursor" } else { "area" },
        true,
    ) {
        config.radial_selection_mode = Some(if value == "cursor" {
            SelectionMode::Cursor
        } else {
            SelectionMode::Area
        });
        f.mark_dirty();
    }

    if !by_pointer {
        let on = config.radial_area_wedges == Some(true);
        let r = w::row(
            f,
            "Visible wedges",
            "Draws the seams between the shares and fills the one you are aiming at with the hover color. Off, the aim is identical and only the icon lights up.",
            40.0,
        );
        if w::switch(f, "areaWedges", r.control, on, true) {
            config.radial_area_wedges = Some(!on);
            f.mark_dirty();
        }
    }

    if let Some(value) = w::slider_row(
        f,
        "radius",
        "Orbital radius",
        "Perceived wheel diameter.",
        config.menu_radius,
        90.0,
        220.0,
        1.0,
        false,
        None,
        &|v| format!("{} px", v.round()),
        true,
    ) {
        config.menu_radius = value;
        f.mark_dirty();
    }

    if let Some(value) = w::slider_row(
        f,
        "iconSize",
        "Icon size",
        "Visual weight of each target.",
        config.icon_size,
        36.0,
        92.0,
        1.0,
        false,
        None,
        &|v| format!("{} px", v.round()),
        true,
    ) {
        config.icon_size = value;
        f.mark_dirty();
    }

    if let Some(value) = w::slider_row(
        f,
        "spacing",
        "Target spacing",
        "Free space between items.",
        config.app_spacing,
        0.0,
        40.0,
        1.0,
        false,
        None,
        &|v| format!("{} px", v.round()),
        true,
    ) {
        config.app_spacing = value;
        f.mark_dirty();
    }

    let on = config.show_labels;
    let r = w::row(f, "Persistent labels", "Keep every target name visible.", 40.0);
    if w::switch(f, "labels", r.control, config.always_show_app_labels, on) {
        config.always_show_app_labels = !config.always_show_app_labels;
        f.mark_dirty();
    }

    let on = config.show_pill();
    let r = w::row(
        f,
        "Workspace name",
        "Show the pill under the wheel with the current workspace and folder.",
        40.0,
    );
    if w::switch(f, "workspacePill", r.control, on, true) {
        config.show_workspace_pill = Some(!on);
        f.mark_dirty();
    }

    f.gap(28.0);
    w::group(f, "Position");

    let at_pointer = matches!(config.placement(), RadialPlacement::Cursor);
    // Said as the consequence, because that is the whole of the choice: the same wheel, the same
    // targets, a different distance for the hand.
    let description = if at_pointer {
        "The wheel blooms under the pointer, so nothing is further away than the gesture that opened it. Near an edge it steps inward just enough to keep every target on screen."
    } else {
        "The wheel always blooms at the middle of the screen, wherever the pointer happens to be."
    };
    let r = w::row(f, "Where it opens", description, 190.0);
    if let Some(value) = w::segmented(
        f,
        "radialPlacement",
        r.control,
        &[("center", "Screen center"), ("cursor", "At pointer")],
        if at_pointer { "cursor" } else { "center" },
        true,
    ) {
        config.radial_placement = Some(if value == "cursor" {
            RadialPlacement::Cursor
        } else {
            RadialPlacement::Center
        });
        f.mark_dirty();
    }

    f.gap(28.0);
    w::group(f, "Presence");

    if let Some(value) = w::slider_row(
        f,
        "backdrop",
        "Background dimming",
        "How much the rest of the screen recedes. At 100% it goes: the desktop is covered edge to edge.",
        config.backdrop_opacity,
        0.0,
        1.0,
        0.01,
        false,
        None,
        &|v| format!("{}%", (v * 100.0).round()),
        true,
    ) {
        config.backdrop_opacity = value;
        f.mark_dirty();
    }

    docks(f, state, config);
}

fn docks(f: &mut Frame, state: &mut SettingsUi, config: &mut UiConfig) {
    f.gap(28.0);
    w::group(f, "Shortcut dock");

    let mut dock = config.shortcut_dock_cfg();
    let r = w::row(
        f,
        "Shortcut dock",
        "Your own icons, in a corner of the open wheel.",
        40.0,
    );
    if w::switch(f, "shortcutDock", r.control, dock.enabled, true) {
        dock.enabled = !dock.enabled;
        config.shortcut_dock = Some(dock.clone());
        f.mark_dirty();
    }
    if dock.enabled {
        // The list itself, on a page of its own. Inline it would push the rest of Appearance down
        // and fight it for the same space, which is what the original moved away from.
        let count = dock.items.len();
        let summary = match count {
            0 => "Nothing in it yet.".to_string(),
            1 => "One shortcut.".to_string(),
            n => format!("{n} shortcuts."),
        };
        let r = w::row(f, "Icons", &summary, 130.0);
        let label = if count == 0 { "Add icons" } else { "Edit" };
        if w::button(f, "shortcutDock-items", r.control, label, ButtonKind::Quiet, true) {
            state.editing_dock = true;
            state.add_mode = None;
            state.editing_item = None;
        }

        let r = w::row(
            f,
            "Where it sits",
            "Pick the corner or edge on the screen below. The wheel opens over the whole screen while a dock is on \u{2014} everything but the taskbar \u{2014} so the corner is a real one.",
            170.0,
        );
        if let Some(value) = dock_position_select(f, "shortcutDock-position", r.control, dock.position) {
            dock.position = value;
            config.shortcut_dock = Some(dock.clone());
            f.mark_dirty();
        }

        if let Some(value) = w::slider_row(
            f,
            "shortcutDock-size",
            "Icon size",
            "How big each icon is drawn.",
            dock.icon_size as f32,
            24.0,
            88.0,
            1.0,
            false,
            None,
            &|v| format!("{} px", v.round()),
            true,
        ) {
            dock.icon_size = value as i32;
            config.shortcut_dock = Some(dock.clone());
            f.mark_dirty();
        }

        if let Some(value) = w::slider_row(
            f,
            "shortcutDock-gap",
            "Spacing",
            "The gap between neighbouring icons.",
            dock.gap as f32,
            0.0,
            48.0,
            1.0,
            false,
            None,
            &|v| format!("{} px", v.round()),
            true,
        ) {
            dock.gap = value as i32;
            config.shortcut_dock = Some(dock.clone());
            f.mark_dirty();
        }

        let r = w::row(
            f,
            "Names under the icons",
            "Off by default: a strip of eight names is a menu, and the wheel is already that.",
            40.0,
        );
        if w::switch(f, "shortcutDock-labels", r.control, dock.show_labels, true) {
            dock.show_labels = !dock.show_labels;
            config.shortcut_dock = Some(dock);
            f.mark_dirty();
        }
    }

    f.gap(28.0);
    w::group(f, "System dock");

    let mut status = config.status_dock_cfg();
    let r = w::row(
        f,
        "System dock",
        "Time, battery, network and volume, read live, beside the open wheel. The volume slider and the mute button work from here.",
        40.0,
    );
    if w::switch(f, "statusDock", r.control, status.enabled, true) {
        status.enabled = !status.enabled;
        config.status_dock = Some(status.clone());
        f.mark_dirty();
    }
    if status.enabled {
        let r = w::row(
            f,
            "Where it sits",
            "Pick the corner or edge on the screen below.",
            170.0,
        );
        if let Some(value) = dock_position_select(f, "statusDock-position", r.control, status.position) {
            status.position = value;
            config.status_dock = Some(status.clone());
            f.mark_dirty();
        }

        if let Some(value) = w::slider_row(
            f,
            "statusDock-size",
            "Icon size",
            "How big the glyphs are drawn. The readouts beside them are set to match.",
            status.icon_size as f32,
            12.0,
            32.0,
            1.0,
            false,
            None,
            &|v| format!("{} px", v.round()),
            true,
        ) {
            status.icon_size = value as i32;
            config.status_dock = Some(status.clone());
            f.mark_dirty();
        }

        if let Some(value) = w::slider_row(
            f,
            "statusDock-gap",
            "Spacing",
            "The gap between neighbouring readouts.",
            status.gap as f32,
            0.0,
            48.0,
            1.0,
            false,
            None,
            &|v| format!("{} px", v.round()),
            true,
        ) {
            status.gap = value as i32;
            config.status_dock = Some(status.clone());
            f.mark_dirty();
        }

        for (id, title, description, get) in [
            (
                "statusDock-volume",
                "Volume",
                "Output level, with a slider you can drag. Click the glyph to mute.",
                0usize,
            ),
            (
                "statusDock-network",
                "Network",
                "Wi-Fi signal, or a wired connection. Click it for the Windows network panel.",
                1,
            ),
            (
                "statusDock-battery",
                "Battery",
                "Charge level, and whether it is on the charger. Nothing is drawn on a machine with no battery.",
                2,
            ),
            (
                "statusDock-clock",
                "Clock",
                "The time, with the date under it.",
                3,
            ),
        ] {
            let on = match get {
                0 => status.show_volume,
                1 => status.show_network,
                2 => status.show_battery,
                _ => status.show_clock,
            };
            let r = w::row(f, title, description, 40.0);
            if w::switch(f, id, r.control, on, true) {
                match get {
                    0 => status.show_volume = !on,
                    1 => status.show_network = !on,
                    2 => status.show_battery = !on,
                    _ => status.show_clock = !on,
                }
                config.status_dock = Some(status.clone());
                f.mark_dirty();
            }
        }
    }
}

fn dock_position_select(
    f: &mut Frame,
    id: &str,
    at: Rect,
    current: HudPosition,
) -> Option<HudPosition> {
    let choices: Vec<Choice> = [
        ("top-left", "Top left"),
        ("top-center", "Top center"),
        ("top-right", "Top right"),
        ("bottom-left", "Bottom left"),
        ("bottom-center", "Bottom center"),
        ("bottom-right", "Bottom right"),
    ]
    .iter()
    .map(|(v, l)| Choice::new(v, l))
    .collect();
    let current_value = hud_value(current);
    w::select(f, id, at, &choices, current_value, true);
    w::select_popup(f, id, &choices, current_value).and_then(|value| hud_from(&value))
}

fn hud_value(position: HudPosition) -> &'static str {
    match position {
        HudPosition::TopLeft => "top-left",
        HudPosition::TopCenter => "top-center",
        HudPosition::TopRight => "top-right",
        HudPosition::BottomLeft => "bottom-left",
        HudPosition::BottomCenter => "bottom-center",
        HudPosition::BottomRight => "bottom-right",
    }
}

fn hud_from(value: &str) -> Option<HudPosition> {
    Some(match value {
        "top-left" => HudPosition::TopLeft,
        "top-center" => HudPosition::TopCenter,
        "top-right" => HudPosition::TopRight,
        "bottom-left" => HudPosition::BottomLeft,
        "bottom-center" => HudPosition::BottomCenter,
        "bottom-right" => HudPosition::BottomRight,
        _ => return None,
    })
}

// ─── Advanced ───────────────────────────────────────────────────────────────

fn advanced(f: &mut Frame, state: &mut SettingsUi, config: &mut UiConfig, request: &mut Request) {
    w::group(f, "Protection");

    let r = w::row(
        f,
        "Fullscreen protection",
        "Prevent accidental openings during games and videos.",
        40.0,
    );
    if w::switch(f, "game", r.control, config.game_mode.enabled, true) {
        config.game_mode.enabled = !config.game_mode.enabled;
        f.mark_dirty();
    }
    if config.game_mode.enabled {
        let r = w::row(f, "Scope", "All fullscreen apps or only a selected list.", 150.0);
        let current = match config.game_mode.mode {
            GameModeScope::All => "all",
            GameModeScope::List => "list",
        };
        if let Some(value) = w::segmented(
            f,
            "scope",
            r.control,
            &[("all", "All"), ("list", "List")],
            current,
            true,
        ) {
            config.game_mode.mode = if value == "all" {
                GameModeScope::All
            } else {
                GameModeScope::List
            };
            f.mark_dirty();
        }

        if matches!(config.game_mode.mode, GameModeScope::List) {
            let r = w::row(
                f,
                "Detect games automatically",
                "Uses game-store folders and engine files; protection still applies only in fullscreen.",
                40.0,
            );
            if w::switch(f, "auto-games", r.control, config.game_mode.auto_detect_games, true) {
                config.game_mode.auto_detect_games = !config.game_mode.auto_detect_games;
                f.mark_dirty();
            }

            let r = w::row(
                f,
                "Protected applications",
                "One name per line, as the executable is called \u{2014} csgo.exe.",
                260.0,
            );
            let field = Rect::new(
                r.control.left - f.px(60.0),
                r.control.top,
                r.control.right,
                r.control.bottom,
            );
            if let Some(text) = w::text_field(f, "blocked", field, &config.game_mode.blocked_apps, "csgo.exe, valorant.exe") {
                config.game_mode.blocked_apps = text;
                f.mark_dirty();
            }
        }
    }

    f.gap(28.0);
    w::group(f, "Hands-free");

    let dwell_on = config.direction_mode();
    let r = w::row(
        f,
        "Launch without clicking",
        "Hides the pointer and picks by direction \u{2014} move toward a target and it opens by itself. Escape closes the wheel without opening anything.",
        40.0,
    );
    if w::switch(f, "instant", r.control, dwell_on, true) {
        config.radial_instant_activate = Some(if dwell_on {
            InstantActivate::Off
        } else {
            InstantActivate::Dwell
        });
        f.mark_dirty();
    }
    if dwell_on {
        let r = w::row(
            f,
            "Direction sensitivity",
            "How far your hand must travel before that direction is chosen. High picks on the smallest movement.",
            200.0,
        );
        let current = match config.sensitivity() {
            Sensitivity::Low => "low",
            Sensitivity::Medium => "medium",
            Sensitivity::High => "high",
        };
        if let Some(value) = w::segmented(
            f,
            "instantSensitivity",
            r.control,
            &[("low", "Low"), ("medium", "Medium"), ("high", "High")],
            current,
            true,
        ) {
            config.radial_instant_sensitivity = Some(match value.as_str() {
                "low" => Sensitivity::Low,
                "high" => Sensitivity::High,
                _ => Sensitivity::Medium,
            });
            f.mark_dirty();
        }

        let dwell = config.dwell_ms();
        if let Some(value) = w::slider_row(
            f,
            "dwellMs",
            "Hover time",
            "How long a target must stay aimed before it opens. Drag to zero and the direction opens the moment it commits.",
            dwell,
            0.0,
            2000.0,
            50.0,
            false,
            None,
            // Zero is not "0 ms", it is the setting being off — and with the low end of the rail
            // now labelled, that is the word the label under it has to say.
            &|v| if v.round() == 0.0 { "Instant".into() } else { format!("{} ms", v.round()) },
            true,
        ) {
            config.radial_instant_dwell_ms = Some(value);
            f.mark_dirty();
        }
    }

    f.gap(28.0);
    w::group(f, "Number keys");

    let numbers_on = config.number_launch();
    let r = w::row(
        f,
        "Quick launch with number keys",
        "While the wheel is up, 1\u{2013}9 open the shortcut in that position. It claims those digits, so a workspace still on its positional default goes quiet.",
        40.0,
    );
    if w::switch(f, "numberLaunch", r.control, numbers_on, true) {
        config.radial_number_launch = Some(!numbers_on);
        f.mark_dirty();
    }
    if numbers_on {
        let on = config.radial_number_labels != Some(false);
        let r = w::row(
            f,
            "Show numbers on the wheel",
            "Draws each position\u{2019}s digit on its icon. Turn it off once the wheel is in your hands \u{2014} the keys go on working.",
            40.0,
        );
        if w::switch(f, "numberLabels", r.control, on, true) {
            config.radial_number_labels = Some(!on);
            f.mark_dirty();
        }

        let r = w::row(
            f,
            "Key to leave a folder",
            "One key, pressed on its own, that steps back out. It only answers inside a folder with nothing typed.",
            120.0,
        );
        let key = config.radial_back_key.clone().unwrap_or_default();
        let label = if key.is_empty() { "None".to_string() } else { key.clone() };
        let field = Rect::new(
            r.control.right - f.px(90.0),
            r.control.top,
            r.control.right,
            r.control.bottom,
        );
        if let Some(text) = w::text_field(f, "backKey", field, &label, "None") {
            let normalized = config::normalize::normalize_back_key(Some(&text));
            config.radial_back_key = Some(normalized);
            f.mark_dirty();
        }
    }

    f.gap(28.0);
    w::group(f, "Settings shortcut");

    let gear_on = config.show_settings_corner == Some(true);
    let r = w::row(
        f,
        "Settings button on the wheel",
        "A gear in a corner of the open wheel. It makes the overlay cover the whole monitor, so that a corner is the screen\u{2019}s corner.",
        40.0,
    );
    if w::switch(f, "settingsCorner", r.control, gear_on, true) {
        config.show_settings_corner = Some(!gear_on);
        f.mark_dirty();
    }
    if gear_on {
        let r = w::row(
            f,
            "Which corner",
            "Where the gear sits. It steps inboard if a dock is already there.",
            170.0,
        );
        let choices: Vec<Choice> = [
            ("top-left", "Top left"),
            ("top-right", "Top right"),
            ("bottom-left", "Bottom left"),
            ("bottom-right", "Bottom right"),
        ]
        .iter()
        .map(|(v, l)| Choice::new(v, l))
        .collect();
        let current = match config.gear_corner() {
            SettingsCorner::TopLeft => "top-left",
            SettingsCorner::TopRight => "top-right",
            SettingsCorner::BottomLeft => "bottom-left",
            SettingsCorner::BottomRight => "bottom-right",
        };
        w::select(f, "settingsCornerPosition", r.control, &choices, current, true);
        if let Some(value) = w::select_popup(f, "settingsCornerPosition", &choices, current) {
            config.settings_corner = Some(match value.as_str() {
                "top-left" => SettingsCorner::TopLeft,
                "bottom-left" => SettingsCorner::BottomLeft,
                "bottom-right" => SettingsCorner::BottomRight,
                _ => SettingsCorner::TopRight,
            });
            f.mark_dirty();
        }
    }

    f.gap(28.0);
    w::group(f, "Data");

    let r = w::row(f, "Export settings", "Save a portable copy of your configuration.", 100.0);
    if w::button(f, "export", r.control, "Export", ButtonKind::Normal, true) {
        request.export = true;
    }

    let r = w::row(f, "Import settings", "Replace this profile with a saved copy.", 100.0);
    if w::button(f, "import", r.control, "Import", ButtonKind::Normal, true) {
        request.import = true;
    }

    // A second press on an action nothing can undo. Red only on the button that does it — a red
    // ROW would read as an error, and nothing has gone wrong yet.
    let confirming = state.confirming.as_deref() == Some("reset");
    let r = w::row(
        f,
        "Restore defaults",
        if confirming {
            "This erases your workspaces, shortcuts and settings. It cannot be undone."
        } else {
            "Erase local settings and start over."
        },
        200.0,
    );
    if confirming {
        let half = r.control.width() / 2.0 - f.px(4.0);
        let cancel = Rect::new(r.control.left, r.control.top, r.control.left + half, r.control.bottom);
        let confirm = Rect::new(r.control.right - half, r.control.top, r.control.right, r.control.bottom);
        if w::button_at(f, "reset-cancel", cancel, "Cancel", ButtonKind::Quiet, true) {
            state.confirming = None;
        }
        if w::button_at(f, "reset-do", confirm, "Erase everything", ButtonKind::Danger, true) {
            state.confirming = None;
            request.reset = true;
        }
    } else if w::button(f, "reset", r.control, "Restore defaults", ButtonKind::Normal, true) {
        state.confirming = Some("reset".into());
    }
}

// ─── Workspaces ─────────────────────────────────────────────────────────────

/// The workspaces page: one card per context, laid out as a grid.
///
/// A card rather than a row, because what distinguishes two workspaces is their SHAPE — how many
/// shortcuts, arranged how — and a row can only say that in words. The thumbnail puts the same
/// arrangement the launcher draws on the card, so picking the right one is recognition rather
/// than reading.
fn workspaces(f: &mut Frame, state: &mut SettingsUi, config: &mut UiConfig) {
    // The label on its own: no rule under it. A rule here would cut the heading off from the
    // grid it introduces, and the cards already have outlines of their own.
    let heading = crate::i18n::settings_text("yourWorkspaces", &config.language);
    let (_, heading_h) = f.p.measure(heading, &w::group_style(f.scale, f.rtl));
    f.p.text(
        heading,
        Rect::new(f.bounds.left, f.y, f.bounds.right, f.y + heading_h),
        &w::group_style(f.scale, f.rtl),
        f.theme.text_2,
    );
    f.y += heading_h + f.px(8.0);
    f.gap(8.0);

    // `repeat(auto-fill, minmax(148px, 1fr))`, worked out the way the browser does: as many
    // columns of at least 148 as fit, then every one widened to share the remainder.
    let gap = f.px(8.0);
    let min_col = f.px(148.0);
    let columns = (((f.bounds.width() + gap) / (min_col + gap)).floor() as usize).max(1);
    let card_w = (f.bounds.width() - gap * (columns - 1) as f32) / columns as f32;

    let count = config.workspaces.len();
    let total = count + 1; // the cards, and the one that makes another
    let card_h = f.px(161.0);
    let new_card_h = f.px(132.0);

    let mut open: Option<usize> = None;
    let mut delete: Option<usize> = None;
    // By id, never by index: the grid reorders and shortens underneath a pending question, and a
    // confirmation that followed a POSITION would end up pointed at a different workspace.
    let mut ask: Option<String> = None;
    let mut cancel = false;

    for index in 0..total {
        let column = index % columns;
        // A row is as tall as the tallest card on it, which is what a grid does and what keeps
        // the "new" card flush with the real ones whenever it shares their row.
        let row_height = |row_start: usize| if row_start < count { card_h } else { new_card_h };
        if column == 0 && index > 0 {
            f.y += row_height(index - columns) + gap;
        }
        let left = f.bounds.left + (card_w + gap) * column as f32;
        let at = Rect::new(left, f.y, left + card_w, f.y + row_height(index - column));

        if index == count {
            new_workspace_card(f, config, at);
            continue;
        }
        let key = format!("ws:{}", config.workspaces[index].id);
        let confirming = state.confirming.as_deref() == Some(key.as_str());
        match workspace_card(f, config, at, index, confirming) {
            Some(CardHit::Open) => open = Some(index),
            Some(CardHit::AskDelete) => ask = Some(key),
            Some(CardHit::ConfirmDelete) => delete = Some(index),
            Some(CardHit::CancelDelete) => cancel = true,
            None => {}
        }
    }
    // The last row's own height, which the loop only adds when another row follows it.
    let last_row_starts_at = (total - 1) / columns * columns;
    f.y += if last_row_starts_at < count { card_h } else { new_card_h };
    f.gap(8.0);

    if let Some(key) = ask {
        state.confirming = Some(key);
    }
    if cancel {
        state.confirming = None;
    }
    if let Some(index) = open {
        state.editing_workspace = Some(index);
        state.confirming = None;
    }

    if let Some(index) = delete {
        if config.workspaces.len() > 1 {
            let gone = config.workspaces.remove(index);
            config.active_workspace_index = active_after_delete(
                config.active_workspace_index,
                index,
                config.workspaces.len(),
            );
            // The positional digits follow the list, so a delete renumbers everything below it.
            for (at, ws) in config.workspaces.iter_mut().enumerate() {
                ws.hotkey = if at < 9 { at as u32 + 1 } else { 0 };
            }
            // The same shape as the editor's "Removed <shortcut>": the panel says what it did
            // and names the thing, so an accidental confirmation is recognisable at a glance.
            f.ui.toast(format!("Deleted {}", gone.name));
            f.mark_dirty();
        } else {
            f.ui.toast("The last workspace cannot be deleted");
        }
        state.confirming = None;
    }
}

enum CardHit {
    Open,
    /// The cross was pressed. Nothing has been deleted — the card turns round and asks.
    AskDelete,
    ConfirmDelete,
    CancelDelete,
}

/// One workspace's card, or the question it asks before it is thrown away.
fn workspace_card(
    f: &mut Frame,
    config: &UiConfig,
    at: Rect,
    index: usize,
    confirming: bool,
) -> Option<CardHit> {
    let workspace = &config.workspaces[index];
    let current = config.active_workspace_index == index;
    let radius = f.px(pal::R_CONTROL);

    // Deleting a workspace takes every shortcut in it and cannot be undone, so it asks twice —
    // the same rule "Restore defaults" follows, and for the same reason. The question takes over
    // the card rather than opening a dialog: the thing being destroyed is the thing you are
    // looking at, and a modal would cover it up at the moment you want to check which one it is.
    if confirming {
        f.p.fill_round_rect(at, radius, f.theme.sunken);
        f.p.stroke_round_rect(at.inflate(-0.5), radius, w::alpha(pal::DANGER, 0.45), 1.0);

        let title_style = w::name_style(f.scale, f.rtl).align(Align::Center);
        let body_style = w::small_style(f.scale, f.rtl).align(Align::Center);
        let count = workspace.apps.len();
        let detail = match count {
            0 => "It has no shortcuts.".to_string(),
            1 => "Its one shortcut goes with it.".to_string(),
            n => format!("Its {n} shortcuts go with it."),
        };
        let pad = f.px(12.0);
        let text_w = at.width() - pad * 2.0;
        let (_, title_h) = f.p.measure(&workspace.name, &title_style);
        let detail_h = w::wrapped_height_of(f, &detail, text_w);

        let buttons_h = f.px(pal::CONTROL_SM_H);
        let block_h = title_h + f.px(2.0) + detail_h;
        let top = at.top + (at.height() - buttons_h - f.px(12.0) - block_h) / 2.0;
        f.p.text(
            &workspace.name,
            Rect::new(at.left + pad, top, at.right - pad, top + title_h),
            &title_style,
            f.theme.text,
        );
        w::draw_wrapped_at(
            f,
            &detail,
            Rect::new(at.left + pad, top + title_h + f.px(2.0), at.right - pad, at.bottom),
            f.theme.text_2,
        );

        let buttons_top = top + block_h + f.px(12.0);
        let half = (at.width() - pad * 2.0) / 2.0 - f.px(4.0);
        let cancel = Rect::new(at.left + pad, buttons_top, at.left + pad + half, buttons_top + buttons_h);
        let confirm = Rect::new(at.right - pad - half, buttons_top, at.right - pad, buttons_top + buttons_h);
        if w::button_at(f, &format!("ws-keep:{index}"), cancel, "Keep", ButtonKind::Quiet, true) {
            return Some(CardHit::CancelDelete);
        }
        if w::button_at(f, &format!("ws-drop:{index}"), confirm, "Delete", ButtonKind::Danger, true) {
            return Some(CardHit::ConfirmDelete);
        }
        // Nothing else on the card is offered the press. Asking for it here would take the
        // capture back off whichever button is mid-press, and neither Keep nor Delete would
        // ever complete — the card is inert behind its own question by not asking at all.
        return None;
    }

    let hovered = f.hovered(at);
    if hovered {
        f.set_cursor(Cursor::Hand);
    }
    f.p.fill_round_rect(at, radius, f.theme.sunken);
    // The current workspace is outlined in the theme's solid, which is the only full-contrast
    // line on the page — and the only thing that has to be found at a glance among six
    // near-identical cards.
    let border = if current {
        f.theme.solid
    } else if hovered {
        f.theme.line_strong
    } else {
        f.theme.line
    };
    f.p.stroke_round_rect(at.inflate(-0.5), radius, border, 1.0);

    // The cross appears with the pointer. Six of them sitting on the grid at rest would make a
    // page of workspaces look like a page of things about to be thrown away.
    let delete_at = Rect::new(
        at.right - f.px(30.0),
        at.top + f.px(6.0),
        at.right - f.px(6.0),
        at.top + f.px(30.0),
    );
    let delete_hovered = hovered && f.hovered(delete_at);
    if hovered {
        if delete_hovered {
            f.p.fill_round_rect(delete_at, f.px(pal::R_CHIP), f.theme.hover);
        }
        f.p.glyph(
            "X",
            delete_at.center(),
            f.px(13.0),
            if delete_hovered { f.theme.text } else { f.theme.text_3 },
            1.6,
        );
    }

    // The thumbnail, 92 square, under the card's own top padding.
    let side = f.px(92.0);
    let stage = Rect::new(
        at.center().0 - side / 2.0,
        at.top + f.px(13.0),
        at.center().0 + side / 2.0,
        at.top + f.px(13.0) + side,
    );
    workspace_thumb(f, workspace, stage);

    // The name, with the count beside it.
    let name_style = w::name_style(f.scale, f.rtl);
    let chip_style = w::chip_style(f.scale, f.rtl).align(Align::Center);
    let chip = workspace.apps.len().to_string();
    let (name_w, name_h) = f.p.measure(&workspace.name, &name_style);
    let (chip_text_w, chip_text_h) = f.p.measure(&chip, &chip_style);
    let chip_w = (chip_text_w + f.px(10.0)).max(f.px(17.0));
    let chip_h = f.px(17.0);
    let head_w = name_w + f.px(6.0) + chip_w;
    let head_top = stage.bottom + f.px(8.0);
    let head_left = at.center().0 - head_w / 2.0;
    f.p.text(
        &workspace.name,
        Rect::new(head_left, head_top, head_left + name_w, head_top + name_h),
        &name_style,
        f.theme.text,
    );
    let chip_at = Rect::new(
        head_left + name_w + f.px(6.0),
        head_top + (name_h - chip_h) / 2.0,
        head_left + name_w + f.px(6.0) + chip_w,
        head_top + (name_h + chip_h) / 2.0,
    );
    f.p.stroke_round_rect(chip_at.inflate(-0.5), f.px(pal::R_CHIP), f.theme.line, 1.0);
    f.p.text(
        &chip,
        Rect::new(
            chip_at.left,
            chip_at.center().1 - chip_text_h / 2.0,
            chip_at.right,
            chip_at.bottom,
        ),
        &chip_style,
        f.theme.text_2,
    );

    if current {
        let style = w::small_style(f.scale, f.rtl).align(Align::Center);
        let label = crate::i18n::settings_text("current", &config.language);
        let (_, th) = f.p.measure(label, &style);
        let top = head_top + name_h + f.px(2.0);
        f.p.text(label, Rect::new(at.left, top, at.right, top + th), &style, f.theme.text_2);
    }

    // The cross sits INSIDE the card, so only one of the two may be offered the press.
    //
    // Asking both and filtering the answer does not work: `clicked` takes the pointer capture on
    // the press, so the card — asked second — would take it off the cross, and the release would
    // then find neither of them active. The cross would do nothing at all, which is precisely
    // what it did. The card is therefore not asked while the pointer is on the cross.
    if hovered && f.clicked(&format!("ws-del:{index}"), delete_at) {
        return Some(CardHit::AskDelete);
    }
    if !delete_hovered && f.clicked(&format!("ws-card:{index}"), at) {
        return Some(CardHit::Open);
    }
    None
}

/// Where the active workspace ends up when the one at `removed` is deleted.
///
/// The active workspace is held by POSITION, and every workspace below a deleted one shifts up by
/// one — so clamping the index to the new length is not enough. Left alone, deleting anything
/// above the current workspace makes the launcher quietly open onto its neighbour, which is the
/// kind of thing nobody notices until a shortcut they press does the wrong thing.
///
/// Its own function because it is arithmetic that is easy to get subtly wrong, and this way it
/// has a test that needs no device context.
fn active_after_delete(active: usize, removed: usize, remaining: usize) -> usize {
    if remaining == 0 {
        return 0;
    }
    let moved = if active > removed {
        active - 1
    } else if active == removed {
        // The one being used is gone. The first position is the only one always there, and it is
        // where a fresh profile starts.
        0
    } else {
        active
    };
    if moved >= remaining {
        0
    } else {
        moved
    }
}

/// The wheel, drawn at thumbnail size: a dashed orbit, the hub, and one slot per shortcut.
///
/// Not the real renderer. At 92px the tiles are 18px and every detail the wheel is made of —
/// shadows, the double outline, the label plate — lands inside a pixel or two, so drawing them
/// costs a dozen calls to produce grey mud. What survives at this size is the ARRANGEMENT, and
/// that is all this draws.
fn workspace_thumb(f: &mut Frame, workspace: &Workspace, stage: Rect) {
    // The whole thumbnail sits at .4, as the original's does. It is a diagram of the workspace,
    // not a second thing on the card competing with its name.
    const DIM: f32 = 0.4;
    let tint = config::parse_hex_rgb(workspace.color.as_deref()).unwrap_or(0x3B_82_F6);
    let (cx, cy) = stage.center();
    let ring = f.px(34.0);

    // The dashed orbit, as chords. At this radius the difference from arcs is under a pixel.
    const DASHES: usize = 36;
    for step in (0..DASHES).step_by(2) {
        let a0 = step as f32 / DASHES as f32 * std::f32::consts::TAU;
        let a1 = (step as f32 + 1.0) / DASHES as f32 * std::f32::consts::TAU;
        f.p.line(
            (cx + a0.cos() * ring, cy + a0.sin() * ring),
            (cx + a1.cos() * ring, cy + a1.sin() * ring),
            pal::rgba(tint, 0.267 * DIM),
            f.px(1.0),
        );
    }

    f.p.fill_circle((cx, cy), f.px(8.0), pal::rgba(tint, DIM));

    let items = workspace.apps.len();
    if items == 0 {
        let style = w::chip_style(f.scale, f.rtl).align(Align::Center);
        let (_, th) = f.p.measure("empty", &style);
        f.p.text(
            "empty",
            Rect::new(stage.left, stage.bottom - f.px(4.0) - th, stage.right, stage.bottom),
            &style,
            w::alpha(f.theme.text_2, DIM),
        );
        return;
    }

    // Twelve o'clock and clockwise, which is where the wheel puts its first item.
    let slot = f.px(18.0);
    for (at, app) in workspace.apps.iter().enumerate() {
        let angle = at as f32 / items as f32 * std::f32::consts::TAU - std::f32::consts::FRAC_PI_2;
        let (sx, sy) = (cx + angle.cos() * ring, cy + angle.sin() * ring);
        let box_at = Rect::centred(sx, sy, slot, slot);
        f.p.fill_round_rect(box_at, f.px(5.0), w::alpha(f.theme.surface, DIM));
        f.p.stroke_round_rect(box_at.inflate(-0.5), f.px(5.0), w::alpha(f.theme.line, DIM), 1.0);
        // The shortcut's own picture where there is one, as the wheel would draw it. Six cards
        // of identical grey glyphs say nothing about which workspace is which, which is the only
        // question this thumbnail exists to answer.
        let art = app
            .custom_icon_url
            .as_deref()
            .and_then(|reference| f.icons.and_then(|icons| icons.bitmap(reference)));
        match art {
            Some(bitmap) => f.p.bitmap_rounded(
                Rect::centred(sx, sy, slot * 0.88, slot * 0.88),
                &bitmap,
                DIM,
                f.px(4.0),
            ),
            None => {
                let glyph = if app.icon_name.is_empty() {
                    crate::gfx::lucide::FALLBACK
                } else {
                    app.icon_name.as_str()
                };
                f.p.glyph(glyph, (sx, sy), f.px(10.0), w::alpha(f.theme.text_2, DIM), 1.6);
            }
        }
    }
}

/// The card that makes another workspace.
fn new_workspace_card(f: &mut Frame, config: &mut UiConfig, at: Rect) {
    let radius = f.px(pal::R_CONTROL);
    let hovered = f.hovered(at);
    if hovered {
        f.set_cursor(Cursor::Hand);
    }
    f.p.fill_round_rect(at, radius, f.theme.sunken);
    // Dashed, the way an empty slot is drawn everywhere: the outline of something that is not
    // there yet, rather than the outline of something that is.
    let line = if hovered { f.theme.line_strong } else { f.theme.line };
    dashed_round_rect(f, at.inflate(-0.5), radius, line);

    let label = crate::i18n::settings_text("newWorkspace", &config.language);
    let style = w::nav_style(f.scale, f.rtl).align(Align::Center);
    let (_, th) = f.p.measure(label, &style);
    let colour = if hovered { f.theme.text } else { f.theme.text_2 };
    f.p.glyph("Plus", (at.center().0, at.center().1 - f.px(12.0)), f.px(18.0), colour, 1.6);
    let top = at.center().1 + f.px(6.0);
    f.p.text(label, Rect::new(at.left, top, at.right, top + th), &style, colour);

    if f.clicked("new-space", at) {
        let index = config.workspaces.len();
        config.workspaces.push(Workspace {
            id: format!("workspace-{}", now_millis()),
            name: format!("Workspace {}", index + 1),
            hotkey: if index < 9 { index as u32 + 1 } else { 0 },
            enabled: true,
            picker_icon_name: Some("Layers".into()),
            ..Workspace::default()
        });
        f.mark_dirty();
    }
}

/// A dashed outline around a rounded rectangle, drawn as segments along its perimeter.
///
/// Direct2D can stroke with a dash pattern, but it wants a stroke-style object per pattern and
/// the painter hands out none. Two dozen short lines cost less than plumbing one through for the
/// single shape on one page that wants it.
pub(super) fn dashed_round_rect(f: &mut Frame, rect: Rect, radius: f32, colour: D2D1_COLOR_F) {
    let dash = f.px(5.0);
    let step = dash + f.px(4.0);
    let width = f.px(1.0);
    let mut run = |from: (f32, f32), to: (f32, f32)| {
        let span = ((to.0 - from.0).powi(2) + (to.1 - from.1).powi(2)).sqrt();
        if span <= 0.0 {
            return;
        }
        let (ux, uy) = ((to.0 - from.0) / span, (to.1 - from.1) / span);
        let mut travelled = 0.0;
        while travelled < span {
            let end = (travelled + dash).min(span);
            f.p.line(
                (from.0 + ux * travelled, from.1 + uy * travelled),
                (from.0 + ux * end, from.1 + uy * end),
                colour,
                width,
            );
            travelled += step;
        }
    };
    run((rect.left + radius, rect.top), (rect.right - radius, rect.top));
    run((rect.right, rect.top + radius), (rect.right, rect.bottom - radius));
    run((rect.right - radius, rect.bottom), (rect.left + radius, rect.bottom));
    run((rect.left, rect.bottom - radius), (rect.left, rect.top + radius));
    // The corners, as short chords: without them the outline reads as four detached lines.
    for (ccx, ccy, from) in [
        (rect.left + radius, rect.top + radius, std::f32::consts::PI),
        (rect.right - radius, rect.top + radius, -std::f32::consts::FRAC_PI_2),
        (rect.right - radius, rect.bottom - radius, 0.0),
        (rect.left + radius, rect.bottom - radius, std::f32::consts::FRAC_PI_2),
    ] {
        const STEPS: usize = 4;
        for s in 0..STEPS {
            let a0 = from + (s as f32 / STEPS as f32) * std::f32::consts::FRAC_PI_2;
            let a1 = from + ((s + 1) as f32 / STEPS as f32) * std::f32::consts::FRAC_PI_2;
            f.p.line(
                (ccx + a0.cos() * radius, ccy + a0.sin() * radius),
                (ccx + a1.cos() * radius, ccy + a1.sin() * radius),
                colour,
                width,
            );
        }
    }
}

/// What one frame of input made of a recording in progress.
enum Recorded {
    Nothing,
    Cancelled,
    /// A key with no modifier on it. Refused rather than stored: registering a bare key takes it
    /// away from every application in the system, and `hotkey::parse` would reject it afterwards
    /// anyway — leaving a configuration that says one thing and a launcher that does another.
    Modifierless,
    Taken(String),
}

/// Turn a frame's keystrokes into an accelerator.
///
/// Modifier keys are skipped rather than recorded: somebody pressing `Ctrl+Alt+K` presses Ctrl
/// first, and a recorder that took the first key event would store `Ctrl` and stop listening.
fn read_shortcut(input: &crate::ui::Input) -> Recorded {
    use windows::Win32::UI::Input::KeyboardAndMouse as k;
    for &vk in &input.keys {
        if vk == k::VK_ESCAPE.0 {
            return Recorded::Cancelled;
        }
        let is_modifier = matches!(
            vk,
            v if v == k::VK_CONTROL.0
                || v == k::VK_LCONTROL.0
                || v == k::VK_RCONTROL.0
                || v == k::VK_MENU.0
                || v == k::VK_LMENU.0
                || v == k::VK_RMENU.0
                || v == k::VK_SHIFT.0
                || v == k::VK_LSHIFT.0
                || v == k::VK_RSHIFT.0
                || v == k::VK_LWIN.0
                || v == k::VK_RWIN.0
        );
        if is_modifier {
            continue;
        }
        if !(input.ctrl || input.alt || input.shift || input.win) {
            return Recorded::Modifierless;
        }
        let mut parts: Vec<&str> = Vec::with_capacity(4);
        // The order `hotkey::format` writes, so a recorded accelerator and a round-tripped one
        // are the same string and the field does not appear to change by itself.
        if input.ctrl {
            parts.push("Ctrl");
        }
        if input.alt {
            parts.push("Alt");
        }
        if input.shift {
            parts.push("Shift");
        }
        if input.win {
            parts.push("Super");
        }
        let accelerator = format!("{}+{}", parts.join("+"), crate::input::hotkey::key_name(vk));
        // Parsed back before it is accepted. A key this build cannot name — a media key, a
        // browser key — formats to something `parse` does not recognise, and storing it would be
        // storing a shortcut that never fires.
        return match crate::input::hotkey::parse(&accelerator) {
            Some(_) => Recorded::Taken(accelerator),
            None => Recorded::Modifierless,
        };
    }
    Recorded::Nothing
}

/// A wheel to sweep a pointer across, so the notes can be heard the way the real one plays them.
///
/// It is NOT a small copy of the wheel. What it shares is only what decides a note: the aim, the
/// hub's cancel zone, and which sound answers which. The geometry is its own, sized to the box,
/// because the thing being judged here is how often a note comes on a sweep across YOUR number of
/// shortcuts -- and that is a property of the count, not of the radius.
fn try_wheel(
    f: &mut Frame,
    state: &mut SettingsUi,
    config: &mut UiConfig,
    request: &mut Request,
) {
    let count = config
        .active_workspace()
        .map(|w| w.apps.len())
        .filter(|n| *n > 0)
        .unwrap_or(6)
        .min(16);

    // The heading and the sentence sit ABOVE the stage, on the page, as any other row's text
    // would. Inside it they were a caption floating over the wheel's own backdrop.
    let (_, title_h) = f.p.measure("Try it", &w::title_style(f.scale, f.rtl));
    f.p.text(
        "Try it",
        Rect::new(f.bounds.left, f.y, f.bounds.right, f.y + title_h),
        &w::title_style(f.scale, f.rtl),
        f.theme.text,
    );
    f.y += title_h + f.px(3.0);
    // The sentence names the notes that are actually selected. "The notes the wheel plays" is
    // true of any setting; this tells you which two you are about to hear.
    let hover_name = sound_name(
        config
            .radial_hover_sound_id
            .as_deref()
            .unwrap_or("thump"),
    );
    let open_name = sound_name(
        config
            .radial_open_sound_id
            .as_deref()
            .unwrap_or("sub-tick"),
    );
    let sentence = format!(
        "Move around the wheel: items play {hover_name}, and aiming back at the center plays {open_name}."
    );
    let text_h = w::draw_wrapped_at(
        f,
        &sentence,
        Rect::new(f.bounds.left, f.y, f.bounds.right, f.y + f.px(60.0)),
        f.theme.text_2,
    );
    f.y += text_h + f.px(12.0);

    // The stage: the full column, and the wheel's own backdrop rather than the panel's.
    let height = f.px(252.0);
    let box_at = Rect::new(f.bounds.left, f.y, f.bounds.right, f.y + height);
    f.y += height;
    let radius = f.px(pal::R_CONTROL);
    let glow = f.p.radial_brush(
        box_at.center(),
        (box_at.width().powi(2) + box_at.height().powi(2)).sqrt() / 2.0 * 0.72,
        &[
            crate::gfx::painter::Stop { offset: 0.0, color: pal::TRY_STAGE_CENTRE },
            crate::gfx::painter::Stop { offset: 1.0, color: pal::TRY_STAGE_EDGE },
        ],
    );
    match glow {
        Some(brush) => f.p.fill_round_rect_with(box_at, radius, &brush),
        None => f.p.fill_round_rect(box_at, radius, pal::TRY_STAGE_EDGE),
    }
    f.p.stroke_round_rect(box_at.inflate(-0.5), radius, f.theme.line, 1.0);

    let centre = (box_at.center().0, box_at.center().1);
    let ring = f.px(80.0);
    let tile = f.px(44.0);
    let hub = f.px(44.0);
    // The wheel's own cancel zone: the hub's BOX at the scale it takes when lit, not its circle.
    let dead = (hub / 2.0) * 1.06 * std::f32::consts::SQRT_2 + f.px(4.0);

    let pointer = f.input.pointer;
    let inside = !f.blocked
        && !f.input.pointer_outside
        && box_at.contains(pointer.0, pointer.1);
    let delta = (pointer.0 - centre.0, pointer.1 - centre.1);
    let distance = (delta.0 * delta.0 + delta.1 * delta.1).sqrt();
    let highlight = if !inside {
        None
    } else if distance <= dead {
        // The hub. `None` here means "the centre", which answers with the opening note.
        Some(None)
    } else {
        crate::wheel::sectors::index_for_delta(delta.0, delta.1, count).map(Some)
    };

    // A note on a CHANGE, never per frame.
    if highlight != state.try_highlight {
        if let Some(target) = highlight {
            let id = match target {
                // Aiming back at the centre is the opening note, as on the real wheel.
                None => config
                    .radial_open_sound_id
                    .clone()
                    .unwrap_or_else(|| "sub-tick".into()),
                Some(_) => config
                    .radial_hover_sound_id
                    .clone()
                    .unwrap_or_else(|| "thump".into()),
            };
            let wanted = match target {
                None => config.radial_open_sound != Some(false),
                Some(_) => config.radial_hover_sound != Some(false),
            };
            if wanted {
                request.preview_sound = Some(id);
            }
        }
        state.try_highlight = highlight;
        f.want_frame();
    }

    // The ring. The tiles are the wheel's own — its plate, its border, its inset highlight —
    // rather than the panel's raised surface, because what this box is for is hearing the wheel
    // and a row of settings-coloured squares is not the wheel.
    let glyphs: Vec<&str> = config
        .active_workspace()
        .map(|workspace| {
            workspace
                .apps
                .iter()
                .map(|app| {
                    if app.icon_name.is_empty() {
                        crate::gfx::lucide::FALLBACK
                    } else {
                        app.icon_name.as_str()
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    for index in 0..count {
        let deg = crate::wheel::sectors::centre_deg(index, count);
        let (x, y) = crate::wheel::sectors::polar_point(0.0, ring, deg);
        let at = Rect::centred(centre.0 + x, centre.1 + y, tile, tile);
        let lit = highlight == Some(Some(index));
        // The wheel's own plate, border and corner radius, from the wheel's own functions. A
        // second set of numbers here is a second wheel that drifts from the first, silently.
        let corner = f.px(pal::tile_radius(44.0));
        f.p.fill_round_rect(at, corner, pal::tile_plate(config.backdrop_opacity));
        f.p.stroke_round_rect(
            at.inflate(-0.5),
            corner,
            if lit { pal::rgba(pal::WHITE, 0.70) } else { pal::tile_border(config.backdrop_opacity) },
            1.0,
        );
        f.p.glyph(
            glyphs.get(index).copied().unwrap_or(crate::gfx::lucide::FALLBACK),
            at.center(),
            f.px(16.0),
            pal::rgba(pal::WHITE, if lit { 1.0 } else { 0.78 }),
            1.7,
        );
    }

    // The hub, which is lit when the aim is the centre. Empty, as the wheel's is: a speaker drawn
    // in it would be the one thing in the picture that the real wheel never shows.
    let hub_lit = highlight == Some(None);
    f.p.fill_circle(centre, hub / 2.0, pal::HUB_FILL);
    f.p.stroke_circle(
        centre,
        hub / 2.0,
        if hub_lit { pal::rgba(pal::WHITE, 0.75) } else { pal::HUB_RING },
        f.px(pal::HUB_RING_WIDTH),
    );

    if inside {
        f.set_cursor(Cursor::Hand);
    }
}

pub fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pressed(keys: &[u16], ctrl: bool, alt: bool, shift: bool, win: bool) -> crate::ui::Input {
        crate::ui::Input {
            keys: keys.to_vec(),
            ctrl,
            alt,
            shift,
            win,
            ..Default::default()
        }
    }

    #[test]
    fn a_modifier_on_its_own_is_not_a_shortcut() {
        use windows::Win32::UI::Input::KeyboardAndMouse as k;
        // Somebody pressing Ctrl+Alt+K presses Ctrl FIRST. A recorder that took the first key
        // event would store `Ctrl` and stop listening before the shortcut was finished.
        let input = pressed(&[k::VK_CONTROL.0], true, false, false, false);
        assert!(matches!(read_shortcut(&input), Recorded::Nothing));
        let input = pressed(&[k::VK_LMENU.0], false, true, false, false);
        assert!(matches!(read_shortcut(&input), Recorded::Nothing));
    }

    #[test]
    fn escape_cancels() {
        let input = pressed(&[0x1B], false, false, false, false);
        assert!(matches!(read_shortcut(&input), Recorded::Cancelled));
    }

    #[test]
    fn a_bare_key_is_refused() {
        // Registering one takes that key away from every application in the system, and
        // `hotkey::parse` would refuse it afterwards anyway -- leaving a stored shortcut that
        // never fires and a panel that says it does.
        let input = pressed(&[b'Z' as u16], false, false, false, false);
        assert!(matches!(read_shortcut(&input), Recorded::Modifierless));
    }

    #[test]
    fn a_combination_is_written_the_way_it_is_read_back() {
        use windows::Win32::UI::Input::KeyboardAndMouse as k;
        let input = pressed(&[k::VK_CONTROL.0, b'K' as u16], true, true, false, false);
        let Recorded::Taken(accelerator) = read_shortcut(&input) else {
            panic!("not recorded");
        };
        assert_eq!(accelerator, "Ctrl+Alt+K");
        // The round trip is the point: a recorded accelerator that formats differently from the
        // one `parse` produces makes the field appear to change by itself on the next launch.
        let hotkey = crate::input::hotkey::parse(&accelerator).expect("parses");
        assert_eq!(crate::input::hotkey::format(&hotkey), accelerator);
    }

    #[test]
    fn the_shipped_shortcut_round_trips() {
        let input = pressed(&[b'Z' as u16], false, true, false, false);
        let Recorded::Taken(accelerator) = read_shortcut(&input) else {
            panic!("not recorded");
        };
        assert_eq!(accelerator, "Alt+Z");
        assert_eq!(accelerator, crate::config::defaults::ui_config().global_shortcut);
    }

    #[test]
    fn every_section_has_its_own_glyph_and_caption() {
        // A duplicate glyph in the nav is two rows that look like the same page.
        let mut glyphs: Vec<&str> = Section::ALL.iter().map(|s| s.glyph()).collect();
        glyphs.sort_unstable();
        let before = glyphs.len();
        glyphs.dedup();
        assert_eq!(glyphs.len(), before);
        for section in Section::ALL {
            assert!(crate::gfx::lucide::exists(section.glyph()), "{:?}", section);
            // Every section has a name and a caption in every language the panel offers.
            for language in crate::i18n::LANGUAGES {
                assert!(
                    !section.label(language.code).is_empty(),
                    "{section:?} has no name in {}",
                    language.code
                );
                assert!(
                    !section.caption(language.code).is_empty(),
                    "{section:?} has no caption in {}",
                    language.code
                );
            }
        }
    }

    #[test]
    fn dock_positions_round_trip() {
        for position in [
            HudPosition::TopLeft,
            HudPosition::TopCenter,
            HudPosition::TopRight,
            HudPosition::BottomLeft,
            HudPosition::BottomCenter,
            HudPosition::BottomRight,
        ] {
            assert_eq!(hud_from(hud_value(position)), Some(position));
        }
        assert_eq!(hud_from("nowhere"), None);
    }

    #[test]
    fn deleting_a_workspace_keeps_the_active_one() {
        // Six workspaces, the fifth in use. Deleting the second leaves five, and the one in use
        // is now fourth -- not fifth, which is what a bare clamp would have left behind.
        assert_eq!(active_after_delete(4, 1, 5), 3);
        // Deleting below it changes nothing.
        assert_eq!(active_after_delete(1, 4, 5), 1);
        // Deleting the one in use falls back to the first, which always exists.
        assert_eq!(active_after_delete(4, 4, 5), 0);
        // The last one in use, with the last one deleted.
        assert_eq!(active_after_delete(5, 5, 5), 0);
        // An index already past the end comes back in range rather than pointing at nothing.
        assert_eq!(active_after_delete(9, 0, 3), 0);
        // Nothing left to point at.
        assert_eq!(active_after_delete(2, 0, 0), 0);
    }

    #[test]
    fn the_nav_order_puts_workspaces_first() {
        // Not alphabetical and not a hierarchy: it is roughly how often a page is opened, and
        // workspaces is what people come here to change.
        assert_eq!(Section::ALL[0], Section::Workspaces);
        assert_eq!(Section::ALL[Section::ALL.len() - 1], Section::General);
    }
}
