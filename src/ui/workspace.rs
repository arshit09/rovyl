//! The workspace editor: the dialog a card in Settings → Workspaces opens.
//!
//! This is where shortcuts are actually made, and it is the one surface in Settings that is not a
//! list of switches. A dialog over the grid rather than a page in place of it, as in the original:
//! a workspace is edited *from* the list, and swapping the page out loses the context that makes
//! "which one is this" answerable at a glance. The grid stays behind the scrim, drawn and inert.
//!
//! The layout inside is the original's, because it encodes a decision worth keeping: the
//! workspace's own identity (icon, name, whether it shows, its key) sits in a band at the top, and
//! everything below it belongs to the shortcuts. Mixing the two — a name field between two
//! shortcut rows — is how the previous versions of that screen read as a form rather than a list.
//!
//! **Measured, not guessed.** The dialog is as tall as its contents and the open shortcut's card
//! is as tall as its fields, and in immediate mode both are only known once they have been drawn.
//! `opening_height` does the arithmetic up front for the one state a dialog can open in; the card
//! takes last frame's measurement, which costs it one frame of plate and never a wrong size.
//!
//! **Adding.** Five kinds, and they are not five spellings of one field. An application is picked
//! from what is installed; a URL needs a label that can be fetched from the page; a folder and a
//! file are paths with different fallbacks; a command carries a shell and a window policy. Each
//! gets its own small form rather than one "target" box that means five things, because the box
//! that means five things is the box that silently accepts a URL as a file path.
//!
//! **Identity by id, never by index.** A row being edited, an icon being picked, a confirmation
//! waiting — all of them hold the item's `id`. The list reorders and deletes underneath them, and
//! an index would quietly start editing the neighbour. The original learned this the same way.

use super::widgets::{self as w, ButtonKind};
use super::{Cursor, Frame};
use crate::config::{
    self, AppItem, CommandShell, CommandType, CommandWindow, IconSource, LaunchMode, UiConfig,
};
use crate::gfx::painter::Rect;
use crate::gfx::palette as pal;

/// What the "add" bar is currently offering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddMode {
    App,
    Url,
    Folder,
    File,
    Command,
}

impl AddMode {
    pub const ALL: [AddMode; 5] = [
        AddMode::App,
        AddMode::Url,
        AddMode::Folder,
        AddMode::File,
        AddMode::Command,
    ];

    pub fn label(self) -> &'static str {
        match self {
            AddMode::App => "Application",
            AddMode::Url => "URL",
            AddMode::Folder => "Folder",
            AddMode::File => "File",
            AddMode::Command => "Command",
        }
    }

    pub fn glyph(self) -> &'static str {
        match self {
            AddMode::App => "Monitor",
            AddMode::Url => "Globe2",
            AddMode::Folder => "FolderOpen",
            AddMode::File => "File",
            AddMode::Command => "TerminalSquare",
        }
    }

    /// What the add panel calls the box the target goes in.
    pub fn target_label(self) -> &'static str {
        match self {
            AddMode::App => "Application",
            AddMode::Url => "Address",
            AddMode::Folder => "Folder",
            AddMode::File => "File",
            AddMode::Command => "Command line",
        }
    }

    /// What the button at the end of that row says. Naming the kind rather than saying "Add" is
    /// the difference between a button and a button you can read without looking up.
    pub fn add_label(self) -> &'static str {
        match self {
            AddMode::App => "Add",
            AddMode::Url => "Add URL",
            AddMode::Folder => "Add folder",
            AddMode::File => "Add file",
            AddMode::Command => "Add command",
        }
    }

    /// What the shortcut it makes will be.
    pub fn kind(self) -> CommandType {
        match self {
            AddMode::App => CommandType::App,
            AddMode::Url => CommandType::Url,
            AddMode::Folder => CommandType::Folder,
            AddMode::File => CommandType::File,
            AddMode::Command => CommandType::Command,
        }
    }
}

/// The half-written shortcut. Cleared when the mode changes, so switching from URL to Command
/// does not carry a web address into a command line.
#[derive(Debug, Default, Clone)]
pub struct Draft {
    pub label: String,
    pub target: String,
    pub working_dir: String,
    pub cmd: bool,
    pub hidden: bool,
}

/// One entry in the installed-applications list, as the host hands it over.
#[derive(Debug, Clone)]
pub struct Installed {
    /// The id the shortcut will carry. Derived from the application's own identifier, so adding
    /// the same app twice — or re-adding it after a delete — reuses the icon already extracted
    /// for it rather than queueing the shell for a picture it has already produced.
    pub id: String,
    pub label: String,
    pub command: String,
}

/// Which list of shortcuts a page is editing.
///
/// The shortcut dock holds exactly the same kind of list as a workspace does, and the original
/// edits it with the same controls. One `Scope` is what stops that being a second copy of the add
/// panel, the row list, the reorder buttons and the glyph picker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Workspace(usize),
    Dock,
}

/// The list a scope names.
fn items_of(config: &mut UiConfig, scope: Scope) -> Option<&mut Vec<AppItem>> {
    match scope {
        Scope::Workspace(index) => config.workspaces.get_mut(index).map(|w| &mut w.apps),
        Scope::Dock => config.shortcut_dock.as_mut().map(|dock| &mut dock.items),
    }
}

/// Whose icon the picker is open for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IconTarget {
    Workspace,
    Item(String),
}

/// Above this many shortcuts the wedges get thin enough to be worth mentioning.
///
/// The numbers are the original's and they are not arbitrary: twelve is where a pointer gesture
/// starts needing care, and eighteen is where direction mode runs out of distinguishable headings.
const CROWDING_NOTE: usize = 12;
const CROWDING_WARN: usize = 18;

// ── The dialog's measurements ───────────────────────────────────────────────
//
// The original's, in DIPs, named rather than inlined — a dialog is one composition and half of
// these numbers only make sense next to the others. `f.px` turns each into device pixels at the
// monitor's scale, so nothing here is a pixel count.

/// The panel: as wide as the original makes it, as tall as its contents up to the same ceiling.
const DIALOG_W: f32 = 760.0;
const DIALOG_H: f32 = 680.0;
/// How close the panel may come to the window's edge before it gives up width or height.
const DIALOG_MARGIN: f32 = 20.0;
/// The inset shared by the header, the body and the footer, which is what puts them in a column.
const DIALOG_PAD: f32 = 20.0;
/// The body's own bottom inset, under the last thing in it.
const BODY_PAD_BOTTOM: f32 = 16.0;
/// The footer: a hairline, twelve above and below, around one 32px button.
const FOOTER_H: f32 = 57.0;

// ── The dialog's type ───────────────────────────────────────────────────────
//
// Six sizes that exist nowhere else in the panel. They live here rather than in `widgets` because
// a dialog is not a page: its title is smaller than a page's, its rows are tighter, and the detail
// line under a shortcut is the smallest type the product sets. Promoting them to the shared scale
// would invite a page to use them, and then the two would drift together.

/// How tall a line of type this size occupies.
///
/// The original is a browser, where a line box is taller than the glyphs in it — and the whole
/// dialog is spaced against those boxes, not against the ink. Measuring the ink instead, which is
/// what the painter hands back, lands every row a few pixels high and the error accumulates down
/// the column. 1.5 is what the browser's "normal" works out to for this face.
fn line_h(f: &Frame, size: f32) -> f32 {
    f.px(size * 1.5)
}

/// Draw one line centred inside a line box of `height`, and say where the box ends.
fn line(
    f: &mut Frame,
    text: &str,
    style: &crate::gfx::text::Style,
    at: Rect,
    height: f32,
    colour: windows::Win32::Graphics::Direct2D::Common::D2D1_COLOR_F,
) -> f32 {
    let (_, th) = f.p.measure(text, style);
    f.p.text(
        text,
        Rect::new(at.left, at.top + (height - th) / 2.0, at.right, at.top + height),
        style,
        colour,
    );
    at.top + height
}

/// The workspace's name, at the top of the dialog: 15px, 600.
fn dialog_title_style(scale: f32, rtl: bool) -> crate::gfx::text::Style {
    use crate::gfx::text::{Align, Family, Style};
    Style::new(Family::Ui, 15.0 * scale, 600, Align::Leading).tracking(-0.015).rtl(rtl)
}

/// The sentence under it: 12px, 400.
fn dialog_sub_style(scale: f32, rtl: bool) -> crate::gfx::text::Style {
    use crate::gfx::text::{Align, Family, Style};
    Style::new(Family::Ui, 12.0 * scale, 400, Align::Leading).rtl(rtl)
}

/// "Shortcuts": 13px, 600 — a heading inside the dialog, not a page's name.
fn section_style(scale: f32, rtl: bool) -> crate::gfx::text::Style {
    use crate::gfx::text::{Align, Family, Style};
    Style::new(Family::Ui, 13.0 * scale, 600, Align::Leading).tracking(-0.008).rtl(rtl)
}

/// A shortcut's name in the list, and a field's label above it: 11.5px, 500.
fn item_name_style(scale: f32, rtl: bool) -> crate::gfx::text::Style {
    use crate::gfx::text::{Align, Family, Style};
    Style::new(Family::Ui, 11.5 * scale, 500, Align::Leading).rtl(rtl)
}

/// What a shortcut actually opens, under its name: 9.5px, 400.
///
/// Small enough that it is read only when looked for, which is the point — the name is what the
/// list is scanned by, and a path at the same weight would compete with it.
fn item_detail_style(scale: f32, rtl: bool) -> crate::gfx::text::Style {
    use crate::gfx::text::{Align, Family, Style};
    Style::new(Family::Ui, 9.5 * scale, 400, Align::Leading).rtl(rtl)
}

/// The label on an add button, and on the one that deletes the workspace: 10.5px, 450.
fn chip_text_style(scale: f32, rtl: bool) -> crate::gfx::text::Style {
    use crate::gfx::text::{Align, Family, Style};
    Style::new(Family::Ui, 10.5 * scale, 450, Align::Leading).rtl(rtl)
}

/// The key on its cap: 12px, 500, in the display face the wheel's own labels use.
fn kbd_style(scale: f32, rtl: bool) -> crate::gfx::text::Style {
    use crate::gfx::text::{Align, Family, Style};
    Style::new(Family::Display, 12.0 * scale, 500, Align::Center).rtl(rtl)
}

//// Draw the editor. Returns false once the user is done with it.
///
/// A dialog over the grid, not a page in place of it, because that is what the original does and
/// the reason holds here: a workspace is edited *from* the list, and a page swap loses the one
/// piece of context that makes "which workspace is this" answerable at a glance. The grid stays
/// behind the scrim, inert.
pub fn editor(
    f: &mut Frame,
    state: &mut super::settings::SettingsUi,
    config: &mut UiConfig,
    index: usize,
    request: &mut super::settings::Request,
) -> bool {
    if index >= config.workspaces.len() {
        return false;
    }

    // A buffer belonging to some other workspace is dropped rather than shown over this one.
    //
    // By id, not by index: the dialog can be closed and another workspace opened at the same
    // index, and text typed against the first must never be applied to the second. The list can
    // also be reordered from the grid behind the scrim, which moves indices and moves no ids.
    let id = config.workspaces[index].id.clone();
    if state.code.as_ref().is_some_and(|buffer| !buffer.owns(&id)) {
        state.code = None;
    }
    let coding = state.code.is_some();

    let name = config.workspaces[index].name.clone();
    let title = if name.trim().is_empty() {
        "Untitled workspace".to_string()
    } else {
        name
    };
    // The code view fills the panel instead of being measured by its contents: a text editor has
    // no natural height, and one sized by the file in it would grow and shrink as lines were typed.
    let opening = if coding {
        0.0
    } else {
        opening_height(f, config.workspaces[index].apps.len(), true)
    };
    let mut dialog = dialog_open(
        f,
        state,
        &title,
        if coding {
            "This workspace as JSON. Nothing changes until it is applied."
        } else {
            "Organize shortcuts and control how this workspace behaves."
        },
        Some(if coding { View::Code } else { View::Visual }),
        opening,
        coding,
    );

    let scope = Scope::Workspace(index);
    if coding {
        code_view(f, state, config, index, &mut dialog);
    } else {
        identity(f, state, config, index);
        f.gap(12.0);
        key_row(f, state, config, index);
        // Two gaps, not one: the identity block closes with a padding of its own, and the
        // shortcuts are the next section down. Collapsing them pulls "Shortcuts" up against the key.
        f.gap(24.0);

        let count = config.workspaces[index].apps.len();
        // Measured from the heading, so the whole section is the target — see `drop_zone`.
        let dropped_on = f.y;
        let name = config.workspaces[index].name.clone();
        // Copied out before `items_of` takes the configuration mutably.
        let language = config.language.clone();
        shortcut_header(f, state, count);
        if let Some(items) = items_of(config, scope) {
            add_panel(f, state, items, &language);
            shortcut_list(f, state, items);
            let section = Rect::new(f.bounds.left, dropped_on, f.bounds.right, f.y);
            drop_zone(f, state, items, &name, section);
        }
        f.gap(12.0);
        delete_workspace(f, state, config, index, &mut dialog);
    }

    dialog_close(f, state, &mut dialog);

    // The view toggle, read after the body rather than where it was drawn, so a switch takes
    // effect on the next frame instead of halfway through this one — with a header belonging to
    // one view and a body already drawn for the other.
    match dialog.switch {
        Some(View::Code) if !coding => {
            state.code = Some(super::code::Buffer::open(&config.workspaces[index]));
            // The transient bits of the visual view belong to the visual view. An add panel left
            // open behind the code view would add its shortcut to a workspace whose text is about
            // to be rewritten from under it.
            state.add_mode = None;
            state.editing_item = None;
            state.draft = Draft::default();
            state.recording_key = None;
            state.editor_height = 0.0;
            f.want_frame();
        }
        Some(View::Visual) if coding => {
            // Refused rather than quietly discarding. The grid cannot show unapplied text, so
            // showing it would be showing the old values while the edits sat invisible in a
            // buffer — and switching back and finding them gone is worse than not switching.
            if state.code.as_ref().is_some_and(super::code::Buffer::changed) {
                f.ui.toast("Apply or revert the code first");
            } else {
                state.code = None;
                state.editor_height = 0.0;
                f.want_frame();
            }
        }
        _ => {}
    }

    // Last, so it sits over everything, the dialog included: it is a modal of its own, and the
    // one place in the panel where two are stacked.
    if !coding {
        icon_picker(f, state, config, scope, request);
    }

    !dialog.dismissed
}

/// The shortcut dock's own list, in the same dialog.
///
/// The same controls as a workspace's, because it is the same kind of list: the dock is a strip of
/// shortcuts that is always on screen rather than a ring that appears. Returns false once done.
pub fn dock_editor(
    f: &mut Frame,
    state: &mut super::settings::SettingsUi,
    config: &mut UiConfig,
    request: &mut super::settings::Request,
) -> bool {
    // The dock may never have been configured. Materialise it from the defaults before editing,
    // so the list has somewhere to live.
    if config.shortcut_dock.is_none() {
        config.shortcut_dock = Some(config.shortcut_dock_cfg());
    }

    let count = config.shortcut_dock.as_ref().map_or(0, |dock| dock.items.len());
    let opening = opening_height(f, count, false);
    let mut dialog = dialog_open(
        f,
        state,
        "Dock shortcuts",
        "The strip that is always on screen, and what is on it.",
        // No code view: the dock is a list inside the configuration and not a thing with a
        // document of its own, so there is no text for a second view to hold.
        None,
        opening,
        false,
    );

    let dropped_on = f.y;
    let language = config.language.clone();
    shortcut_header(f, state, count);
    if let Some(items) = items_of(config, Scope::Dock) {
        add_panel(f, state, items, &language);
        shortcut_list(f, state, items);
        let section = Rect::new(f.bounds.left, dropped_on, f.bounds.right, f.y);
        // The dock takes drops too: it holds ordinary `AppItem`s and is edited by the same list,
        // so a dock that refused them would be the one place the gesture stopped working.
        drop_zone(f, state, items, "the dock", section);
    }

    dialog_close(f, state, &mut dialog);
    icon_picker(f, state, config, Scope::Dock, request);
    !dialog.dismissed
}

// ── The dialog shell ────────────────────────────────────────────────────────

/// What `dialog_open` measured, handed to the call that finishes the frame.
///
/// A pair of functions rather than one taking a closure, for the reason `escape_clip` is a pair:
/// the body between them is a few hundred lines holding `&mut Frame`, and a closure around it
/// would borrow the frame it has already been given.
pub struct Dialog {
    panel: Rect,
    /// The scrolling region between the header and the footer.
    body: Rect,
    /// Where the body's content started, so its height is `f.y` minus this.
    content_top: f32,
    scroll: f32,
    /// The clip, the column and the cursor the page was using, to be put back.
    saved_clip: Option<Rect>,
    saved_bounds: Rect,
    saved_y: f32,
    /// Done, the close button, Escape, or a press on the scrim.
    dismissed: bool,
    /// The view the toggle was pressed for, which may be the one already showing.
    ///
    /// Reported rather than acted on, because acting on it here would change the view between the
    /// header that has been drawn and the body that has not.
    switch: Option<View>,
    /// Where the Done button ended up, so a view that adds buttons can put them beside it rather
    /// than guess at its width.
    done: Rect,
    /// Whether the body is a viewport the content fills, rather than a column the content sizes.
    ///
    /// The code view is the one of the two: a text editor has no natural height, so it takes the
    /// panel's and scrolls inside it. `dialog_close` reads this to leave the measurement and the
    /// page's own scroll bar alone — the editor has one of its own and owns the wheel.
    fill: bool,
}

/// Which of the dialog's two views is on screen.
///
/// The visual one is the grid of controls; the code one is the workspace's own JSON. Two views of
/// one thing rather than two dialogs, because they are edits to the same workspace and the title
/// above them is the same title.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum View {
    Visual,
    Code,
}

/// Draw the scrim, the panel, its header and its footer, and leave the frame pointed at the body.
///
/// Everything after this call lays itself out inside the body and is clipped to it, until
/// `dialog_close` puts the page's own column back.
fn dialog_open(
    f: &mut Frame,
    state: &mut super::settings::SettingsUi,
    title: &str,
    subtitle: &str,
    views: Option<View>,
    opening: f32,
    fill: bool,
) -> Dialog {
    // Over the whole window, not over the column: a dialog that leaves the nav clickable is a
    // dialog that can be navigated out from underneath.
    let saved_clip = f.escape_clip();
    f.modal = true;
    let screen = f.window;
    f.p.fill_rect(screen, f.theme.scrim);

    // The header's height comes from the type in it, so a translation that wraps the subtitle is
    // not a subtitle drawn over the first row of the body.
    let title_style = dialog_title_style(f.scale, f.rtl);
    let sub_style = dialog_sub_style(f.scale, f.rtl);
    let title_h = line_h(f, 15.0);
    // The one line in the dialog that is not on the 1.5 step: the original sets this paragraph at
    // 1.45, which is what keeps the subtitle tucked under the name rather than floating below it.
    let sub_h = f.px(12.0 * 1.45);
    let header_h = f.px(DIALOG_PAD) + title_h + f.px(4.0) + sub_h + f.px(16.0);
    let chrome = header_h + f.px(FOOTER_H);

    // As tall as it needs to be, up to the ceiling — which takes last frame's measurement, because
    // what is in the body is only known once it has been drawn. It settles on the frame after the
    // dialog opens, and `dialog_close` asks for that frame.
    let margin = f.px(DIALOG_MARGIN);
    let width = f.px(DIALOG_W).min(screen.width() - margin * 2.0);
    let ceiling = f.px(DIALOG_H).min(screen.height() - margin * 2.0);
    let wanted = if state.editor_height > 0.0 { state.editor_height } else { opening };
    // A filled body takes the ceiling outright. Measuring it would be measuring an editor, whose
    // height is the height of the file in it — so the panel would grow by a line every time a line
    // was typed and shrink again on Backspace.
    let height = if fill {
        ceiling
    } else {
        (chrome + wanted).clamp(chrome.min(ceiling), ceiling)
    };
    let panel = Rect::centred(screen.center().0, screen.center().1, width, height);
    w::shadow_panel(f, panel);

    let pad = f.px(DIALOG_PAD);

    // The head: the workspace's name, what the page is for, and the two controls that leave it.
    let head_right = panel.right - pad - f.px(110.0);
    let after = line(
        f,
        title,
        &title_style,
        Rect::new(panel.left + pad, panel.top + pad, head_right, panel.top + pad + title_h),
        title_h,
        f.theme.text,
    );
    line(
        f,
        subtitle,
        &sub_style,
        Rect::new(panel.left + pad, after + f.px(4.0), head_right, after + f.px(4.0) + sub_h),
        sub_h,
        f.theme.text_2,
    );

    let mut dismissed = false;

    // Close, at the panel's own top right.
    let close_size = f.px(26.0);
    let close = Rect::new(
        panel.right - pad - close_size,
        panel.top + pad + f.px(2.0),
        panel.right - pad,
        panel.top + pad + f.px(2.0) + close_size,
    );
    let hovered = f.hovered(close);
    if hovered {
        f.set_cursor(Cursor::Hand);
        f.p.fill_round_rect(close, f.px(6.0), f.theme.raised);
    }
    f.p.glyph(
        "X",
        close.center(),
        f.px(15.0),
        if hovered { f.theme.text } else { f.theme.text_3 },
        1.9,
    );
    if f.clicked("dlg-close", close) {
        dismissed = true;
    }

    // The two views, beside it. Only a workspace has a second one; the dock's list is part of the
    // configuration rather than a thing with a document of its own.
    let switch = views.and_then(|current| {
        let right = close.left - f.px(8.0);
        view_toggle(
            f,
            Rect::new(right - f.px(64.0), panel.top + pad, right, panel.top + pad + f.px(30.0)),
            current,
        )
    });

    // The foot: one button, and the hairline that separates it from the list above it.
    let footer_top = panel.bottom - f.px(FOOTER_H);
    f.p.line((panel.left, footer_top), (panel.right, footer_top), f.theme.line, 1.0);
    let done_w = f.p.measure("Done", &w::control_style(f.scale, f.rtl)).0 + f.px(24.0);
    let done = Rect::new(
        panel.right - pad - done_w,
        footer_top + f.px(12.0),
        panel.right - pad,
        footer_top + f.px(44.0),
    );
    if w::button_at(f, "dlg-done", done, "Done", ButtonKind::Primary, true) {
        dismissed = true;
    }

    // Escape, and a press on the scrim — the two ways out that are not a button. Escape belongs to
    // whatever is on top, so it is left alone while the glyph picker or a dropdown is up.
    if f.input.key_pressed(0x1B) && state.icon_picker.is_none() && !f.ui.list_open() {
        dismissed = true;
    }
    // A press on the scrim closes it, as it does in the original. The titlebar is carved out: it
    // is where the window is dragged from and where its three buttons are, and losing an open
    // editor because the window was moved is not what anybody meant by clicking outside.
    let scrim_top = screen.top + f.px(crate::win::settings::TITLEBAR_H);
    let on_scrim = f.input.pointer.1 >= scrim_top
        && screen.contains(f.input.pointer.0, f.input.pointer.1)
        && !panel.contains(f.input.pointer.0, f.input.pointer.1);
    if f.input.pressed && state.icon_picker.is_none() && on_scrim {
        dismissed = true;
    }

    let body = Rect::new(panel.left + pad, panel.top + header_h, panel.right - pad, footer_top);
    // A filled body does not scroll as a column — what is in it scrolls itself — so it is laid out
    // from its own top. Reading the stored offset would start the editor somewhere down the panel.
    let scroll = if fill { 0.0 } else { f.ui.scroll_of("ws-editor") };
    let saved_bounds = f.bounds;
    let saved_y = f.y;
    // Clipped to the panel's full width rather than the body's, so a control that sits in the
    // gutter — the scroll bar — is not cut in half by the column it is measuring.
    f.clip_to(Rect::new(panel.left, body.top, panel.right, body.bottom));
    f.bounds = body;
    f.y = body.top - scroll;

    Dialog {
        panel,
        body,
        content_top: f.y,
        scroll,
        saved_clip,
        saved_bounds,
        saved_y,
        dismissed,
        switch,
        done,
        fill,
    }
}

/// What the body will measure, worked out before it is drawn.
///
/// The dialog is as tall as its contents, and its contents are only known once they have been laid
/// out — so the opening frame would otherwise have to guess, and the only safe guess is "as tall as
/// possible", which is a dialog that visibly shrinks the instant it appears.
///
/// This is the same arithmetic the layout is about to do, and it is EXACT for the state a dialog
/// can open in: nothing expanded and nothing being added, because `dialog_close` clears both on the
/// way out. Every frame after the first uses the real measurement, so being wrong here costs a
/// single frame of a dialog that is the wrong height — never a wrong dialog.
fn opening_height(f: &Frame, count: usize, with_identity: bool) -> f32 {
    let items = if count == 0 {
        f.px(118.0)
    } else {
        (f.px(ITEM_H) + f.px(1.0)) * count as f32
    };
    // The heading and the gap under it, which both lists have.
    let mut total = f.px(28.0) + f.px(12.0) + items + f.px(BODY_PAD_BOTTOM);
    if count >= CROWDING_NOTE {
        total += line_h(f, 10.5) + f.px(16.0) + f.px(8.0);
    }
    if with_identity {
        let identity = f.px(48.0).max(line_h(f, 11.5) + f.px(8.0) + f.px(32.0));
        // Identity, the key row, the two gaps between them, and the delete button at the end.
        total += identity + f.px(12.0) + f.px(32.0) + f.px(24.0) + f.px(12.0) + f.px(23.0);
    }
    total
}

/// Measure what the body drew, scroll it, and give the page its column back.
fn dialog_close(f: &mut Frame, state: &mut super::settings::SettingsUi, dialog: &mut Dialog) {
    let content_h = f.y - dialog.content_top + f.px(BODY_PAD_BOTTOM);
    f.unclip();
    f.bounds = dialog.saved_bounds;
    f.y = dialog.saved_y;

    // A filled body is already exactly as tall as the viewport: there is nothing to measure, and
    // nothing for the panel's own scroll bar to scroll. The editor inside it has one of its own,
    // and takes the wheel in `code::panel` before this is reached.
    if !dialog.fill {
        // The panel is sized from this on the NEXT frame, so a change of height has to ask for
        // one. Without it a dialog opened on a long list would stay at its opening size until
        // something else happened to repaint.
        if (state.editor_height - content_h).abs() > 0.5 {
            state.editor_height = content_h;
            f.want_frame();
        }
        scroll_body(f, dialog, content_h);
    }

    f.restore_clip(dialog.saved_clip);

    if dialog.dismissed {
        // The transient bits belong to the dialog that is closing. Carrying an open add-panel out
        // of it and into the NEXT workspace is how a URL gets added to the wrong one.
        state.add_mode = None;
        state.editing_item = None;
        state.icon_picker = None;
        state.recording_key = None;
        state.draft = Draft::default();
        state.editor_height = 0.0;
        // The code buffer goes with them. By the time this runs, text that was worth keeping has
        // already been applied: `code_view` turns the first dismissal with unapplied changes into
        // a confirmation rather than letting it reach here.
        state.code = None;
        state.confirming = None;
        f.ui.set_scroll("ws-editor", 0.0);
    }
}

/// The body's own wheel and scroll bar, for the views that are a column rather than a viewport.
fn scroll_body(f: &mut Frame, dialog: &Dialog, content_h: f32) {
    let viewport = dialog.body.height();
    let max_offset = (content_h - viewport).max(0.0);
    if max_offset > 0.0 {
        if dialog.panel.contains(f.input.pointer.0, f.input.pointer.1) && f.input.scroll != 0.0 {
            let next = (dialog.scroll - f.input.scroll * f.px(54.0)).clamp(0.0, max_offset);
            f.ui.set_scroll("ws-editor", next);
            f.want_frame();
        }
        let track = Rect::new(
            dialog.panel.right - f.px(9.0),
            dialog.body.top,
            dialog.panel.right,
            dialog.body.bottom,
        );
        let ratio = (viewport / content_h).clamp(0.05, 1.0);
        let thumb_h = (track.height() * ratio).max(f.px(28.0));
        let span = track.height() - thumb_h;
        let t = (dialog.scroll / max_offset).clamp(0.0, 1.0);
        let top = track.top + span * t;
        f.p.fill_round_rect(
            Rect::new(track.left + f.px(2.0), top, track.right - f.px(2.0), top + thumb_h),
            f.px(3.0),
            w::alpha(f.theme.text, 0.15),
        );
    } else if dialog.scroll != 0.0 {
        f.ui.set_scroll("ws-editor", 0.0);
    }
}

/// The controls and the code, as two radio buttons in one plate.
///
/// Returns the view that was pressed, which may be the one already showing — the caller decides
/// what a press means, because leaving the code view is a decision about unapplied text and this
/// function knows nothing about any.
fn view_toggle(f: &mut Frame, at: Rect, current: View) -> Option<View> {
    f.p.fill_round_rect(at, f.px(8.0), f.theme.sunken);
    f.p.stroke_round_rect(at.inflate(-0.5), f.px(8.0), f.theme.line, 1.0);

    let inset = f.px(3.0);
    let bw = f.px(28.0);
    let slots = [
        (
            View::Visual,
            "Grid2x2",
            Rect::new(at.left + inset, at.top + inset, at.left + inset + bw, at.bottom - inset),
        ),
        (
            View::Code,
            "FileCode",
            Rect::new(
                at.left + inset + bw + f.px(2.0),
                at.top + inset,
                at.left + inset + bw * 2.0 + f.px(2.0),
                at.bottom - inset,
            ),
        ),
    ];

    let mut pressed = None;
    for (view, glyph, slot) in slots {
        let on = view == current;
        let hovered = f.hovered(slot);
        if hovered {
            f.set_cursor(Cursor::Hand);
        }
        // The selected one carries a plate of its own, which is the only thing separating them.
        if on {
            f.p.fill_round_rect(slot, f.px(5.0), f.theme.raised);
            f.p.stroke_round_rect(slot.inflate(-0.5), f.px(5.0), f.theme.line, 1.0);
        } else if hovered {
            f.p.fill_round_rect(slot, f.px(5.0), f.theme.hover);
        }
        f.p.glyph(
            glyph,
            slot.center(),
            f.px(14.0),
            if on {
                f.theme.text
            } else if hovered {
                f.theme.text_2
            } else {
                f.theme.text_3
            },
            1.9,
        );
        if f.clicked(&format!("dlg-view-{glyph}"), slot) {
            pressed = Some(view);
        }
    }
    pressed
}

// ── The code view ───────────────────────────────────────────────────────────
//
// The workspace as text, filling the dialog, with Revert and Apply beside Done. Three decisions
// hold it together:
//
// **Nothing is applied until it is applied.** Not on a keystroke, not on the way out, not on a view
// switch. A text editor over live configuration that saved as it was typed would launch the wheel
// from a half-written file every time somebody paused in the middle of a line — and the one state
// a parser can be in mid-edit is "broken".
//
// **So the one place typing can be lost is closing the dialog**, and that is the one place that
// asks twice.
//
// **Switching back to the grid is refused, not forgiven.** The grid cannot show unapplied text, so
// it would show the old values with the edits invisible behind them.

/// The body and the footer of the code view.
fn code_view(
    f: &mut Frame,
    state: &mut super::settings::SettingsUi,
    config: &mut UiConfig,
    index: usize,
    dialog: &mut Dialog,
) {
    // Taken out and put back, rather than borrowed in place. The guard at the end of this function
    // writes `state.confirming`, and a `&mut` into `state.code` held across it would be a second
    // mutable borrow of the same struct.
    let Some(mut buffer) = state.code.take() else {
        return;
    };

    super::code::panel(f, &mut buffer, &config.workspaces[index], dialog.body);
    // The body is a viewport and not a column, so the cursor is left at its end: `dialog_close`
    // measures from `f.y` and a filled body is exactly as tall as the space it was given.
    f.y = dialog.body.bottom;

    let changed = buffer.changed();
    let broken = buffer.problem().is_some();

    // The footer, out of the body's clip: it is below the hairline, in the panel's own chrome.
    let saved = f.escape_clip();
    let style = w::control_style(f.scale, f.rtl);
    let gap = f.px(8.0);
    let top = dialog.done.top;
    let bottom = dialog.done.bottom;

    let apply_w = f.p.measure("Apply", &style).0 + f.px(24.0);
    let apply_at = Rect::new(dialog.done.left - gap - apply_w, top, dialog.done.left - gap, bottom);
    let revert_w = f.p.measure("Revert", &style).0 + f.px(24.0);
    let revert_at = Rect::new(apply_at.left - gap - revert_w, top, apply_at.left - gap, bottom);

    // The keys, very quietly, at the other end of the footer. A text box that answers to Ctrl+Z
    // and Tab without saying so is a text box nobody tries them in — and this one is not a control
    // the platform drew, so there is no prior expectation to inherit.
    let hint_style = chip_text_style(f.scale, false);
    let (_, hint_h) = f.p.measure("Tab", &hint_style);
    f.p.text(
        "Tab indents · Ctrl+Z undoes · Ctrl+V pastes",
        Rect::new(
            dialog.panel.left + f.px(DIALOG_PAD),
            (top + bottom) / 2.0 - hint_h / 2.0,
            revert_at.left - gap,
            bottom,
        ),
        &hint_style,
        w::alpha(f.theme.text, 0.32),
    );

    if w::button_at(f, "ws-code-revert", revert_at, "Revert", ButtonKind::Quiet, changed) {
        buffer.revert(&config.workspaces[index]);
        f.want_frame();
    }
    // Disabled while the text does not read, which is what makes the status line worth reading:
    // the only way past it is to fix what it names.
    if w::button_at(f, "ws-code-apply", apply_at, "Apply", ButtonKind::Normal, changed && !broken) {
        apply_code(f, &mut buffer, config, index);
    }
    f.restore_clip(saved);

    // Leaving with text that was never applied. The first press arms, the second discards — the
    // same two-press shape as every destructive button in the panel, for the same reason.
    //
    // The REVISION is in the key, which is what keeps the arming honest. A confirmation that
    // outlived the text it was about would turn a press made ten minutes and thirty edits later
    // into a silent discard, with the sentence that warned about it long gone from the screen.
    // Carrying the revision means any further typing withdraws the warning and the next press
    // asks again.
    //
    // It cannot be cleared on the frames in between, either: every frame that is not a dismissal
    // would disarm it, and the second press would never find it armed.
    const DISCARD: &str = "ws-code-discard:";
    let key = format!("{DISCARD}{}:{}", config.workspaces[index].id, buffer.revision());
    if dialog.dismissed && buffer.changed() {
        if state.confirming.as_deref() != Some(key.as_str()) {
            state.confirming = Some(key);
            dialog.dismissed = false;
            f.ui.toast("Unapplied changes — close again to discard them");
        }
    } else if !buffer.changed()
        && state
            .confirming
            .as_deref()
            .is_some_and(|armed| armed.starts_with(DISCARD))
    {
        // Applied or reverted: there is nothing left to discard, so the warning goes with it.
        state.confirming = None;
    }

    state.code = Some(buffer);
}

/// Write the text into the workspace.
fn apply_code(
    f: &mut Frame,
    buffer: &mut super::code::Buffer,
    config: &mut UiConfig,
    index: usize,
) {
    let parsed = match buffer.parse(&config.workspaces[index]) {
        Ok(parsed) => parsed,
        Err(problem) => {
            // Unreachable from the interface — the button is disabled while the text does not
            // read — and reachable from the probe, which clicks by coordinate.
            f.ui.toast(problem.sentence());
            return;
        }
    };

    let mut workspace = parsed.workspace;
    let mut notes = parsed.healed;

    // Two invariants the text can break and the grid cannot, because both are about the LIST and
    // this view holds one workspace. The visual view refuses the press that would break them; here
    // the field is put back instead, because one word in forty lines is not a reason to throw the
    // other thirty-nine away. Either way it is said out loud.
    if !workspace.enabled {
        if config.active_workspace_index == index {
            workspace.enabled = true;
            notes.push("this is the current workspace, so it stays shown".to_string());
        } else if !config
            .workspaces
            .iter()
            .enumerate()
            .any(|(at, other)| at != index && other.enabled)
        {
            workspace.enabled = true;
            notes.push("at least one workspace has to stay shown".to_string());
        }
    }

    config.workspaces[index] = workspace;
    // Read back out of the config rather than reused from above: what the editor now shows has to
    // be what the configuration holds, and that is the copy that was stored.
    let stored = config.workspaces[index].clone();
    buffer.applied(&stored);
    f.mark_dirty();
    f.ui.toast(match notes.len() {
        0 => "Applied".to_string(),
        1 => format!("Applied — {}", notes[0]),
        several => format!("Applied, with {several} things tidied"),
    });
    f.want_frame();
}

/// The one destructive thing in the dialog, at the bottom where the original puts it.
///
/// Two presses, like every other destructive button in the panel: the first arms it and says so,
/// the second does it. The last workspace cannot be deleted — the wheel would have nothing to
/// open into.
fn delete_workspace(
    f: &mut Frame,
    state: &mut super::settings::SettingsUi,
    config: &mut UiConfig,
    index: usize,
    dialog: &mut Dialog,
) {
    let id = config.workspaces[index].id.clone();
    let key = format!("ws-del:{id}");
    let armed = state.confirming.as_deref() == Some(key.as_str());
    let enabled = config.workspaces.len() > 1;

    let label = if armed { "Delete it — press again" } else { "Delete workspace" };
    let style = chip_text_style(f.scale, f.rtl);
    let (tw, th) = f.p.measure(label, &style);
    let at = Rect::new(f.bounds.left, f.y, f.bounds.left + tw + f.px(33.0), f.y + f.px(23.0));
    f.y = at.bottom;

    let hovered = enabled && f.hovered(at);
    if hovered {
        f.set_cursor(Cursor::Hand);
        f.p.fill_round_rect(at, f.px(6.0), w::alpha(pal::DANGER, 0.08));
    }
    let ink = if armed {
        pal::DANGER_HOVER
    } else if hovered {
        pal::DANGER
    } else {
        f.theme.text_3
    };
    let ink = w::dimmed(ink, enabled);
    f.p.glyph("Trash2", (at.left + f.px(11.0), at.center().1), f.px(14.0), ink, 1.8);
    f.p.text(
        label,
        Rect::new(at.left + f.px(26.0), at.center().1 - th / 2.0, at.right, at.bottom),
        &style,
        ink,
    );

    if enabled && f.clicked(&key, at) {
        if armed {
            let gone = config.workspaces.remove(index);
            // The current workspace cannot be one that is no longer there, and neither can an
            // index past the end of a list that just got shorter.
            if config.active_workspace_index >= config.workspaces.len() {
                config.active_workspace_index = config.workspaces.len().saturating_sub(1);
            }
            state.confirming = None;
            f.ui.toast(format!("Deleted {}", gone.name));
            f.mark_dirty();
            dialog.dismissed = true;
        } else {
            state.confirming = Some(key);
        }
    }
}

// ── The glyph picker ───────────────────────────────────────────────────

/// How many glyphs are offered at once.
///
/// There are 1353 of them. A grid of 1353 is not a choice, it is a wall, and drawing it would
/// measure 1353 strings a frame. The search is the way through; this is what is shown before
/// anybody types.
const GLYPHS_SHOWN: usize = 84;
const GLYPH_COLUMNS: usize = 12;

/// The glyphs offered with an empty search.
///
/// Chosen rather than taken alphabetically: the first 84 names in a 1353-entry list are an
/// accident of the alphabet, and a picker that opens on `AArrowDown` has not helped anybody.
const SUGGESTED: &[&str] = &[
    "AppWindow", "Monitor", "Laptop", "Smartphone", "Globe2", "Chrome", "Compass", "Rocket",
    "Folder", "FolderOpen", "File", "FileCode", "FileText", "Files", "Archive", "Database",
    "TerminalSquare", "Code2", "Binary", "Bug", "GitBranch", "Github", "Container", "Cpu",
    "Music", "Headphones", "Video", "Clapperboard", "Camera", "Image", "Mic", "Radio",
    "MessageCircle", "Mail", "Send", "Phone", "Users", "User", "Bell", "Share2",
    "Calendar", "Clock", "Timer", "CheckSquare", "ListTodo", "StickyNote", "Pin", "Bookmark",
    "Settings", "Wrench", "Shield", "Lock", "Key", "Power", "Plug", "Gauge",
    "Home", "Building2", "MapPin", "Map", "Car", "Plane", "ShoppingCart", "CreditCard",
    "Sparkles", "Star", "Heart", "Flame", "Zap", "Lightbulb", "Palette", "Brush",
    "Stars", "Layers", "Grid2x2", "Box", "Package", "Puzzle", "Wand2", "Bot",
    "TrendingUp", "BarChart3", "Activity", "Coins",
];

/// The modal. Draws nothing unless a target is armed.
///
/// A shell around the body, for one reason: this covers the WINDOW, so it has to step out of the
/// scrolling column's clip, and the body has two ways out of itself. Pairing the escape with the
/// restore in one place is what stops a missed one costing the whole frame — an unbalanced clip
/// fails D2D's `EndDraw`, and then nothing is presented at all.
fn icon_picker(
    f: &mut Frame,
    state: &mut super::settings::SettingsUi,
    config: &mut UiConfig,
    scope: Scope,
    request: &mut super::settings::Request,
) {
    if state.icon_picker.is_none() {
        return;
    }
    let clip = f.escape_clip();
    icon_picker_body(f, state, config, scope, request);
    f.restore_clip(clip);
}

fn icon_picker_body(
    f: &mut Frame,
    state: &mut super::settings::SettingsUi,
    config: &mut UiConfig,
    scope: Scope,
    request: &mut super::settings::Request,
) {
    let Some(target) = state.icon_picker.clone() else {
        return;
    };

    // Over the whole window, not over the column: a modal that leaves the nav clickable is a
    // modal that can be navigated out from underneath.
    let screen = f.window;
    f.p.fill_rect(screen, f.theme.scrim);

    let width = f.px(520.0).min(screen.width() - f.px(48.0));
    let height = f.px(440.0).min(screen.height() - f.px(48.0));
    let panel = Rect::new(
        screen.center().0 - width / 2.0,
        screen.center().1 - height / 2.0,
        screen.center().0 + width / 2.0,
        screen.center().1 + height / 2.0,
    );
    w::shadow_panel(f, panel);

    let (title, hint) = match &target {
        IconTarget::Workspace => (
            "Workspace icon".to_string(),
            "Shown in the wheel's picker.".to_string(),
        ),
        IconTarget::Item(_) => (
            "Shortcut icon".to_string(),
            "Shown on the wheel, in place of the picture.".to_string(),
        ),
    };
    let pad = f.px(18.0);
    f.p.text(
        &title,
        Rect::new(panel.left + pad, panel.top + pad, panel.right - pad, panel.top + pad + f.px(22.0)),
        &w::group_style(f.scale, f.rtl),
        f.theme.text,
    );
    f.p.text(
        &hint,
        Rect::new(panel.left + pad, panel.top + pad + f.px(22.0), panel.right - pad, panel.top + pad + f.px(40.0)),
        &w::small_style(f.scale, f.rtl),
        f.theme.text_3,
    );

    // The close button, at the panel's own top-right.
    let close = Rect::new(panel.right - pad - f.px(26.0), panel.top + pad - f.px(2.0), panel.right - pad, panel.top + pad + f.px(24.0));
    if f.hovered(close) {
        f.set_cursor(Cursor::Hand);
        f.p.fill_round_rect(close, f.px(7.0), f.theme.hover);
    }
    f.p.glyph("X", close.center(), f.px(14.0), f.theme.text_2, 1.9);
    let dismissed = f.clicked("icon-close", close) || f.input.key_pressed(0x1B);

    // A picture of your own, before the glyphs. It is the answer for the shortcuts a glyph cannot
    // describe -- somebody's own logo, a program whose icon Rovyl could not find -- and burying it
    // under a search box of 1353 line drawings would be hiding the general case behind the
    // specific one.
    let browse_h = f.px(34.0);
    let browse_at = Rect::new(
        panel.left + pad,
        panel.top + pad + f.px(50.0),
        panel.right - pad,
        panel.top + pad + f.px(50.0) + browse_h,
    );
    let (_, bh) = f.p.measure("Use a picture", &w::body_style(f.scale, f.rtl));
    f.p.text(
        "Use a picture",
        Rect::new(browse_at.left, browse_at.center().1 - bh / 2.0, browse_at.right, browse_at.bottom),
        &w::body_style(f.scale, f.rtl),
        f.theme.text_2,
    );
    if w::button(f, "icon-browse", browse_at, "Browse\u{2026}", ButtonKind::Quiet, true) {
        request.pick_icon = Some(target.clone());
    }

    // The four libraries Windows keeps its own icons in, by name. Nobody browses to
    // `C:\Windows\System32\imageres.dll` on purpose.
    let mut row_y = browse_at.bottom + f.px(6.0);
    let chip_h = f.px(26.0);
    let mut chip_x = panel.left + pad;
    for (file, label) in crate::sys::picker::WINDOWS_LIBRARIES {
        let Some(path) = crate::sys::picker::windows_library(file) else {
            continue;
        };
        let width = f.p.measure(label, &w::small_style(f.scale, f.rtl)).0 + f.px(20.0);
        let at = Rect::new(chip_x, row_y, chip_x + width, row_y + chip_h);
        chip_x = at.right + f.px(6.0);
        let on = state
            .icon_library
            .as_ref()
            .is_some_and(|(open, _)| open == &path);
        let hovered = f.hovered(at);
        if hovered {
            f.set_cursor(Cursor::Hand);
        }
        f.p.fill_round_rect(
            at,
            f.px(7.0),
            if on {
                f.theme.solid
            } else if hovered {
                f.theme.hover
            } else {
                f.theme.raised
            },
        );
        let ink = if on { f.theme.on_solid } else { f.theme.text_2 };
        let (_, lh) = f.p.measure(label, &w::small_style(f.scale, f.rtl));
        f.p.text(
            label,
            Rect::new(at.left + f.px(10.0), at.center().1 - lh / 2.0, at.right, at.bottom),
            &w::small_style(f.scale, f.rtl),
            ink,
        );
        if f.clicked(&format!("iconlib:{file}"), at) {
            if on {
                state.icon_library = None;
            } else {
                // Counted here, on the UI thread, because it is a header read of a file the
                // loader already has mapped -- microseconds, once per click.
                let total = crate::icons::library::count(&path);
                state.icon_library = (total > 0).then_some((path, total));
                state.icon_library_row = 0;
            }
        }
    }
    row_y += chip_h + f.px(10.0);

    // The grid of what is inside the chosen one.
    if let Some((path, total)) = state.icon_library.clone() {
        let columns = GLYPH_COLUMNS;
        let cell = ((panel.width() - pad * 2.0) / columns as f32).floor();
        let rows_fit = (((panel.bottom - f.px(14.0)) - row_y) / cell).floor().max(1.0) as u32;
        let total_rows = total.div_ceil(columns as u32);
        let max_row = total_rows.saturating_sub(rows_fit);
        state.icon_library_row = state.icon_library_row.min(max_row);

        // Scrolled by rows, not pixels: a grid that stops halfway through a row of icons looks
        // like it has lost some.
        let area = Rect::new(panel.left + pad, row_y, panel.right - pad, panel.bottom - f.px(14.0));
        if f.hovered(area) && f.input.scroll != 0.0 {
            let delta = -f.input.scroll.signum() as i32 * 2;
            let next = state.icon_library_row as i32 + delta;
            state.icon_library_row = next.clamp(0, max_row as i32) as u32;
            f.want_frame();
        }

        let first = state.icon_library_row * columns as u32;
        let mut chosen: Option<u32> = None;
        for slot in 0..rows_fit * columns as u32 {
            let index = first + slot;
            if index >= total {
                break;
            }
            let x = area.left + (slot % columns as u32) as f32 * cell;
            let y = area.top + (slot / columns as u32) as f32 * cell;
            let box_at = Rect::new(x, y, x + cell, y + cell).inflate(-f.px(2.0));
            let hovered = f.hovered(box_at);
            if hovered {
                f.set_cursor(Cursor::Hand);
                f.p.fill_round_rect(box_at, f.px(8.0), f.theme.hover);
            }
            let reference = crate::icons::store::lib_ref(&path, index);
            match f.icons.and_then(|icons| icons.bitmap(&reference)) {
                Some(bitmap) => {
                    let art = box_at.inflate(-f.px(5.0));
                    f.p.bitmap_rounded(art, &bitmap, 1.0, f.px(3.0));
                }
                // Nothing yet. A box rather than a spinner: forty of them pulsing at once is a
                // waiting room, and they arrive within a frame or two anyway.
                None => {
                    f.p.fill_round_rect(box_at.inflate(-f.px(7.0)), f.px(4.0), f.theme.raised);
                    f.want_frame();
                }
            }
            if f.clicked(&format!("libicon:{index}"), box_at) {
                chosen = Some(index);
            }
        }

        let shown = (rows_fit * columns as u32).min(total.saturating_sub(first));
        let note = format!(
            "{total} icons in {} \u{2014} showing {}\u{2013}{}",
            path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            first + 1,
            first + shown
        );
        let (_, nh) = f.p.measure(&note, &w::small_style(f.scale, f.rtl));
        f.p.text(
            &note,
            Rect::new(panel.left + pad, panel.bottom - f.px(13.0) - nh / 2.0, panel.right - pad, panel.bottom),
            &w::small_style(f.scale, f.rtl),
            f.theme.text_3,
        );

        if let Some(index) = chosen {
            request.take_library_icon = Some((path, index));
        }
        // The glyph list is not drawn while a library is open: two grids of small square things,
        // one above the other, is a dialog nobody can read.
        f.blocked = true;
        return;
    }

    let search_at = Rect::new(panel.left + pad, row_y, panel.right - pad, row_y + f.px(34.0));
    if let Some(next) = w::text_field(f, "icon-search", search_at, &state.icon_search, "Search icons") {
        state.icon_search = next;
    }

    // The grid.
    let term = state.icon_search.trim().to_lowercase();
    let names: Vec<&str> = if term.is_empty() {
        SUGGESTED
            .iter()
            .copied()
            .filter(|name| crate::gfx::lucide::exists(name))
            .take(GLYPHS_SHOWN)
            .collect()
    } else {
        // Names first, then what the word MEANS: `lucide::search` is what makes "browser", "time"
        // and "music" find anything at all, since none of the three is a glyph name.
        crate::gfx::lucide::search(&term, GLYPHS_SHOWN)
    };

    let grid_top = search_at.bottom + f.px(14.0);
    let cell = ((panel.width() - pad * 2.0) / GLYPH_COLUMNS as f32).floor();
    let current = match (&target, scope) {
        (IconTarget::Workspace, Scope::Workspace(index)) => config.workspaces[index]
            .picker_icon_name
            .clone()
            .unwrap_or_else(|| "Layers".into()),
        (IconTarget::Item(id), _) => items_of(config, scope)
            .and_then(|items| items.iter().find(|item| &item.id == id))
            .map(|item| item.icon_name.clone())
            .unwrap_or_default(),
        _ => String::new(),
    };

    let mut chosen: Option<String> = None;
    for (at, name) in names.iter().enumerate() {
        let x = panel.left + pad + (at % GLYPH_COLUMNS) as f32 * cell;
        let y = grid_top + (at / GLYPH_COLUMNS) as f32 * cell;
        if y + cell > panel.bottom - f.px(14.0) {
            break;
        }
        let box_at = Rect::new(x, y, x + cell, y + cell).inflate(-f.px(2.0));
        let on = *name == current;
        let hovered = f.hovered(box_at);
        if hovered {
            f.set_cursor(Cursor::Hand);
        }
        if on || hovered {
            f.p.fill_round_rect(box_at, f.px(8.0), if on { f.theme.solid } else { f.theme.hover });
        }
        f.p.glyph(
            name,
            box_at.center(),
            f.px(17.0),
            if on { f.theme.on_solid } else { f.theme.text_2 },
            1.7,
        );
        if f.clicked(&format!("glyph:{name}"), box_at) {
            chosen = Some((*name).to_string());
        }
    }

    if names.is_empty() {
        f.p.text(
            "No icon by that name",
            Rect::new(panel.left + pad, grid_top + f.px(8.0), panel.right - pad, grid_top + f.px(32.0)),
            &w::body_style(f.scale, f.rtl),
            f.theme.text_3,
        );
    }

    if let Some(name) = chosen {
        match (&target, scope) {
            (IconTarget::Workspace, Scope::Workspace(index)) => {
                config.workspaces[index].picker_icon_name = Some(name);
                config.workspaces[index].picker_icon_url = None;
                config.workspaces[index].picker_icon_file = None;
            }
            (IconTarget::Item(id), _) => {
                if let Some(item) =
                    items_of(config, scope).and_then(|items| items.iter_mut().find(|i| &i.id == id))
                {
                    item.icon_name = name;
                    // A chosen glyph outranks the extracted picture, and `custom` is what stops
                    // the extractor putting the program's icon back on the next pass.
                    item.icon_source = Some(IconSource::Lucide);
                    item.custom_icon_url = None;
                    item.custom_icon_file = None;
                }
            }
            _ => {}
        }
        f.mark_dirty();
        state.icon_picker = None;
    } else if dismissed {
        state.icon_picker = None;
    }

    // Nothing behind the modal reacts. Set last so the widgets ABOVE still worked this frame.
    f.blocked = true;
}

/// ── The band at the top ─────────────────────────────────────────────────────

/// The icon, the name field, and the two flags — one row, as in the original.
///
/// The three are aligned along their BOTTOMS rather than their centres, which is what lets the
/// name keep a label above it without the icon and the flags drifting up with it. It is a 48px
/// square, then everything the width allows, then two 32px squares.
fn identity(
    f: &mut Frame,
    state: &mut super::settings::SettingsUi,
    config: &mut UiConfig,
    index: usize,
) {
    let label_style = item_name_style(f.scale, f.rtl);
    let label_h = line_h(f, 11.5);
    let field_h = f.px(32.0);
    let art = f.px(48.0);

    // The row is as tall as its tallest column, and the name's is the only one with two parts.
    let row_h = art.max(label_h + f.px(8.0) + field_h);
    let row = Rect::new(f.bounds.left, f.y, f.bounds.right, f.y + row_h);
    f.y = row.bottom;

    let art_at = Rect::new(row.left, row.bottom - art, row.left + art, row.bottom);
    let flag = f.px(32.0);
    let flags_right = row.right;
    let tick_at = Rect::new(flags_right - flag, row.bottom - f.px(1.0) - flag, flags_right, row.bottom - f.px(1.0));
    let eye_at = Rect::new(tick_at.left - f.px(4.0) - flag, tick_at.top, tick_at.left - f.px(4.0), tick_at.bottom);

    // The icon is a button, and it says so with a pencil in its corner rather than with a label.
    let hovered = f.hovered(art_at);
    let open = state.icon_picker == Some(IconTarget::Workspace);
    f.p.fill_round_rect(art_at, f.px(8.0), f.theme.sunken);
    f.p.stroke_round_rect(
        art_at.inflate(-0.5),
        f.px(8.0),
        if hovered || open { f.theme.line_strong } else { f.theme.line },
        1.0,
    );
    if hovered || open {
        f.p.fill_round_rect(art_at.inflate(-1.0), f.px(7.0), f.theme.raised);
    }
    let glyph = config.workspaces[index]
        .picker_icon_name
        .clone()
        .unwrap_or_else(|| "Layers".into());
    let ink = if hovered || open { f.theme.text } else { f.theme.text_2 };
    f.p.glyph(&glyph, art_at.center(), f.px(22.0), ink, 1.7);
    // The pencil sits on a patch of the panel's own colour, so it reads as a badge over the icon
    // rather than as a stroke that is part of it.
    let badge = Rect::centred(art_at.right - f.px(9.0), art_at.bottom - f.px(9.0), f.px(12.0), f.px(12.0));
    f.p.fill_round_rect(badge, f.px(3.0), f.theme.surface);
    f.p.glyph("Pencil", badge.center(), f.px(10.0), ink, 2.0);
    if hovered {
        f.set_cursor(Cursor::Hand);
    }
    if f.clicked("ws-icon", art_at) {
        state.icon_picker = match state.icon_picker {
            Some(IconTarget::Workspace) => None,
            _ => Some(IconTarget::Workspace),
        };
        state.icon_search.clear();
    }

    // The name takes everything between the icon and the flags.
    let field_at = Rect::new(
        art_at.right + f.px(12.0),
        row.bottom - field_h,
        eye_at.left - f.px(12.0),
        row.bottom,
    );
    line(
        f,
        "Workspace name",
        &label_style,
        Rect::new(field_at.left, field_at.top - f.px(8.0) - label_h, field_at.right, field_at.top),
        label_h,
        f.theme.text_2,
    );
    let current = config.workspaces[index].name.clone();
    if let Some(next) = w::text_field(f, "ws-name", field_at, &current, "Name this workspace") {
        config.workspaces[index].name = next;
        f.mark_dirty();
    }

    let is_active = config.active_workspace_index == index;
    let enabled = config.workspaces[index].enabled;

    // Available on the wheel. Inert rather than disabled while this is the current workspace: the
    // wheel would open into a space the picker does not show.
    if flag_button(f, "ws-eye", eye_at, if enabled { "Eye" } else { "EyeOff" }, enabled, is_active, 1.8) {
        if is_active {
            f.ui.toast("The current workspace is always shown");
        } else {
            let on_count = config.workspaces.iter().filter(|w| w.enabled).count();
            if enabled && on_count <= 1 {
                f.ui.toast("At least one workspace has to stay on");
            } else {
                config.workspaces[index].enabled = !enabled;
                f.mark_dirty();
            }
        }
    }

    if flag_button(f, "ws-current", tick_at, "Check", is_active, is_active, 2.2) && !is_active {
        // Making it current implies being available, or the result is an impossible state.
        config.workspaces[index].enabled = true;
        config.active_workspace_index = index;
        f.mark_dirty();
    }
}

/// A square icon button that is either on or off, with no label.
///
/// Off is an outline, not a plate: two filled squares beside a filled name field is three boxes
/// competing, and the original draws the unset state as a hairline for exactly that reason.
fn flag_button(
    f: &mut Frame,
    id: &str,
    at: Rect,
    glyph: &str,
    on: bool,
    inert: bool,
    stroke: f32,
) -> bool {
    let hovered = f.hovered(at) && !inert;
    if hovered {
        f.set_cursor(Cursor::Hand);
    }
    let radius = f.px(8.0);
    if on {
        let fill = w::alpha(f.theme.solid, if inert { 0.8 } else { 1.0 });
        f.p.fill_round_rect(at, radius, fill);
        f.p.stroke_round_rect(at.inflate(-0.5), radius, fill, 1.0);
    } else {
        if hovered {
            f.p.fill_round_rect(at, radius, f.theme.raised);
        }
        f.p.stroke_round_rect(
            at.inflate(-0.5),
            radius,
            if hovered { f.theme.line_strong } else { f.theme.line },
            1.0,
        );
    }
    let ink = if on {
        w::alpha(f.theme.on_solid, if inert { 0.8 } else { 1.0 })
    } else if hovered {
        f.theme.text
    } else {
        f.theme.text_2
    };
    f.p.glyph(glyph, at.center(), f.px(15.0), ink, stroke);
    f.clicked(id, at)
}

/// The workspace's wheel key — a cap you press to re-record, not a settings row.
///
/// One line: the label, the key itself on a cap, and the one or two things that can be done to it.
/// The original keeps this out of the row grid on purpose, because a key is read as a key and a
/// row of title-and-description reads as a setting with a value.
fn key_row(
    f: &mut Frame,
    state: &mut super::settings::SettingsUi,
    config: &mut UiConfig,
    index: usize,
) {
    let recording = state.recording_key == Some(index);
    let key = config::workspace_key_at(&config.workspaces[index], index);
    let is_default = config::is_default_workspace_key(&config.workspaces[index]);
    // What the key WOULD be if the field were cleared — the offer behind "Use 3", and never the
    // key that is already bound.
    let fallback = config::positional_workspace_key(index);

    let h = f.px(32.0);
    let row = Rect::new(f.bounds.left, f.y, f.bounds.right, f.y + h);
    f.y = row.bottom;

    let label_style = item_name_style(f.scale, f.rtl);
    let (label_w, label_ink) = f.p.measure("Wheel key", &label_style);
    f.p.text(
        "Wheel key",
        Rect::new(row.left, row.center().1 - label_ink / 2.0, row.left + label_w, row.bottom),
        &label_style,
        f.theme.text_2,
    );

    // The slot. Pressing it starts listening; pressing it again gives up.
    let slot = Rect::new(row.left + label_w + f.px(8.0), row.top, row.left + label_w + f.px(8.0) + f.px(96.0), row.bottom);
    let hovered = f.hovered(slot);
    if hovered {
        f.set_cursor(Cursor::Hand);
    }
    f.p.fill_round_rect(slot, f.px(8.0), if hovered || recording { f.theme.raised } else { f.theme.sunken });
    f.p.stroke_round_rect(
        slot.inflate(-0.5),
        f.px(8.0),
        if recording {
            f.theme.solid
        } else if hovered {
            f.theme.line_strong
        } else {
            f.theme.line
        },
        1.0,
    );
    if recording {
        let style = w::control_style(f.scale, f.rtl);
        let (tw, th) = f.p.measure("Press any key…", &style);
        f.p.text(
            "Press any key…",
            Rect::new(slot.center().0 - tw / 2.0, slot.center().1 - th / 2.0, slot.right, slot.bottom),
            &style,
            f.theme.text,
        );
    } else {
        let shown = if key == config::WORKSPACE_KEY_NONE || key.is_empty() {
            "None".to_string()
        } else if key == " " {
            "Space".to_string()
        } else {
            key.clone()
        };
        let unset = shown == "None";
        let style = kbd_style(f.scale, f.rtl);
        let (tw, th) = f.p.measure(&shown, &style);
        let cap_w = (tw + f.px(16.0)).max(f.px(28.0));
        let cap = Rect::centred(slot.center().0, slot.center().1, cap_w, f.px(24.0));
        if unset {
            // Dashed, the way an empty slot is drawn everywhere else in the panel: the outline of
            // something that is not there yet.
            super::settings::dashed_round_rect(f, cap.inflate(-0.5), f.px(6.0), f.theme.line_strong);
        } else {
            f.p.fill_round_rect(cap, f.px(6.0), f.theme.raised);
            f.p.stroke_round_rect(cap.inflate(-0.5), f.px(6.0), f.theme.line_strong, 1.0);
        }
        f.p.text(
            &shown,
            Rect::new(cap.left, cap.center().1 - th / 2.0, cap.right, cap.bottom),
            &style,
            if unset { f.theme.text_3 } else { f.theme.text },
        );
    }
    if f.clicked("ws-key-slot", slot) {
        state.recording_key = if recording { None } else { Some(index) };
        f.want_frame();
    }

    // What can be done to the key, as quiet buttons that only appear when they would do something.
    let mut x = slot.right + f.px(8.0);
    if !is_default && !fallback.is_empty() && fallback != key {
        let label = format!("Use {fallback}");
        let width = f.p.measure(&label, &w::control_style(f.scale, f.rtl)).0 + f.px(24.0);
        let at = Rect::new(x, row.top, x + width, row.bottom);
        x = at.right + f.px(8.0);
        if w::button_at(f, "ws-key-def", at, &label, ButtonKind::Quiet, true) {
            state.recording_key = None;
            config.workspaces[index].hotkey_key = None;
            f.mark_dirty();
        }
    }
    if key != config::WORKSPACE_KEY_NONE && !key.is_empty() {
        let width = f.p.measure("Remove", &w::control_style(f.scale, f.rtl)).0 + f.px(24.0);
        let at = Rect::new(x, row.top, x + width, row.bottom);
        if w::button_at(f, "ws-key-clear", at, "Remove", ButtonKind::Quiet, true) {
            state.recording_key = None;
            config.workspaces[index].hotkey_key = Some(String::new());
            f.mark_dirty();
        }
    }

    if recording {
        // The settings window has the keyboard, so the key arrives as an ordinary message: no hook
        // and no foreground theft. Escape cancels, Backspace and Delete clear the binding.
        if let Some(vk) = f.input.keys.first().copied() {
            state.recording_key = None;
            f.want_frame();
            match vk {
                0x1B => {}
                0x08 | 0x2E => {
                    config.workspaces[index].hotkey_key = Some(String::new());
                    f.mark_dirty();
                    f.ui.toast("Key cleared");
                }
                _ => {
                    // A workspace key is ONE character, so `F1` and `PageUp` normalise to nothing
                    // and are refused here rather than stored as a binding that never fires.
                    let pressed = crate::input::hotkey::key_name(vk);
                    let key = config::normalize_workspace_key(Some(&pressed));
                    if key.is_empty() {
                        f.ui.toast("That key cannot be used for a workspace");
                    } else {
                        take_key_from_others(config, index, &key);
                        config.workspaces[index].hotkey_key = Some(key);
                        f.mark_dirty();
                    }
                }
            }
        }
        // A line under it saying what will be accepted, which is the one thing the cap cannot say.
        let note = "Any single key — a letter, a digit or a symbol. Escape cancels.";
        let style = chip_text_style(f.scale, f.rtl);
        let (_, th) = f.p.measure(note, &style);
        f.y += f.px(8.0);
        f.p.text(
            note,
            Rect::new(f.bounds.left, f.y, f.bounds.right, f.y + th),
            &style,
            f.theme.text_2,
        );
        f.y += th;
    }
}

// Give a key to one workspace by taking it from whoever had it.
///
/// The one that loses it gets `Some("")` and not `None`: an absent field means "follow my
/// position", and the position may well be the key that was just taken away.
fn take_key_from_others(config: &mut UiConfig, keep: usize, key: &str) {
    for (at, workspace) in config.workspaces.iter_mut().enumerate() {
        if at == keep {
            continue;
        }
        if config::workspace_key_at(workspace, at).eq_ignore_ascii_case(key) {
            workspace.hotkey_key = Some(String::new());
        }
    }
}

/// ── The shortcuts ───────────────────────────────────────────────────────────

/// "Shortcuts" on the left, the five ways to add one on the right.
///
/// The add bar is laid out from the RIGHT so it keeps its shape as the dialog narrows: the button
/// that falls off the end is the last one, not a gap in the middle.
fn shortcut_header(f: &mut Frame, state: &mut super::settings::SettingsUi, count: usize) {
    let h = f.px(28.0);
    let row = Rect::new(f.bounds.left, f.y, f.bounds.right, f.y + h);
    f.y = row.bottom + f.px(12.0);

    let style = section_style(f.scale, f.rtl);
    let head_h = line_h(f, 13.0);
    // Bottom-aligned with the buttons beside it, which is what `align-items: flex-end` buys.
    line(
        f,
        "Shortcuts",
        &style,
        Rect::new(row.left, row.bottom - head_h, row.right, row.bottom),
        head_h,
        f.theme.text,
    );

    let chip = chip_text_style(f.scale, f.rtl);
    let mut right = row.right;
    for mode in AddMode::ALL.into_iter().rev() {
        let (tw, th) = f.p.measure(mode.label(), &chip);
        let width = tw + f.px(14.0 + 6.0 + 18.0);
        let at = Rect::new(right - width, row.top, right, row.bottom);
        right = at.left - f.px(4.0);
        let on = state.add_mode == Some(mode);
        let hovered = f.hovered(at);
        if hovered {
            f.set_cursor(Cursor::Hand);
        }
        if on || hovered {
            f.p.fill_round_rect(at, f.px(6.0), f.theme.raised);
        }
        f.p.stroke_round_rect(
            at.inflate(-0.5),
            f.px(6.0),
            if on || hovered { f.theme.line_strong } else { f.theme.line },
            1.0,
        );
        let ink = if on || hovered { f.theme.text } else { f.theme.text_2 };
        f.p.glyph(mode.glyph(), (at.left + f.px(16.0), at.center().1), f.px(14.0), ink, 1.8);
        f.p.text(
            mode.label(),
            Rect::new(at.left + f.px(29.0), at.center().1 - th / 2.0, at.right, at.bottom),
            &chip,
            ink,
        );
        if f.clicked(&format!("add:{}", mode.label()), at) {
            state.add_mode = if on { None } else { Some(mode) };
            state.draft = Draft::default();
            state.app_search.clear();
        }
    }

    // Said where the shortcut is added, and only once it is true. A note on every workspace is
    // furniture, not a warning.
    if count >= CROWDING_NOTE {
        let warn = count >= CROWDING_WARN;
        let message = if warn {
            format!("{count} shortcuts is past what one ring aims at comfortably. A folder would help.")
        } else {
            format!("{count} shortcuts. The wedges get thin past {CROWDING_WARN}.")
        };
        let style = chip_text_style(f.scale, f.rtl);
        let (_, th) = f.p.measure(&message, &style);
        let at = Rect::new(f.bounds.left, f.y - f.px(4.0), f.bounds.right, f.y - f.px(4.0) + th + f.px(16.0));
        f.y = at.bottom + f.px(12.0);
        let (ink, plate, edge) = if warn {
            (pal::CROWD_WARN_INK, pal::CROWD_WARN_FILL, pal::CROWD_WARN_LINE)
        } else {
            (pal::CROWD_NOTE_INK, pal::CROWD_NOTE_FILL, pal::CROWD_NOTE_LINE)
        };
        f.p.fill_round_rect(at, f.px(6.0), plate);
        f.p.stroke_round_rect(at.inflate(-0.5), f.px(6.0), edge, 1.0);
        f.p.glyph("AlertTriangle", (at.left + f.px(18.0), at.center().1), f.px(13.0), ink, 1.9);
        f.p.text(
            &message,
            Rect::new(at.left + f.px(33.0), at.center().1 - th / 2.0, at.right - f.px(12.0), at.bottom),
            &style,
            ink,
        );
    }
}

/// How tall one row of the list is, and the inset its contents sit within.
const ITEM_H: f32 = 50.0;
const ITEM_PAD: f32 = 4.0;
/// Where the name starts: the grip's column, the icon's, and the gaps between them.
const ITEM_COPY_X: f32 = ITEM_PAD + 16.0 + 8.0 + 34.0 + 8.0;

fn shortcut_list(f: &mut Frame, state: &mut super::settings::SettingsUi, items: &mut Vec<AppItem>) {
    if items.is_empty() {
        let name = item_name_style(f.scale, f.rtl).align(crate::gfx::text::Align::Center);
        let detail = chip_text_style(f.scale, f.rtl).align(crate::gfx::text::Align::Center);
        let h = f.px(118.0);
        let at = Rect::new(f.bounds.left, f.y, f.bounds.right, f.y + h);
        f.y = at.bottom;
        let (_, nh) = f.p.measure("This workspace is empty", &name);
        f.p.glyph("PackageOpen", (at.center().0, at.center().1 - f.px(24.0)), f.px(22.0), f.theme.text_3, 1.7);
        f.p.text(
            "This workspace is empty",
            Rect::new(at.left, at.center().1 - f.px(2.0), at.right, at.bottom),
            &name,
            f.theme.text_2,
        );
        let line = "Add an application, URL, folder, file, or command above.";
        f.p.text(
            line,
            Rect::new(at.left, at.center().1 - f.px(2.0) + nh + f.px(6.0), at.right, at.bottom),
            &detail,
            f.theme.text_3,
        );
        return;
    }

    let mut move_from_to: Option<(usize, usize)> = None;
    let mut remove: Option<usize> = None;

    for at in 0..items.len() {
        let item = items[at].clone();
        let expanded = state.editing_item.as_deref() == Some(item.id.as_str());

        // An expanded row is a card: it steps away from its neighbours, takes an outline and a
        // plate, and the list reads as one row having opened rather than as the list having been
        // interrupted. A plain row carries a transparent border so the two are the same height.
        if expanded {
            f.y += f.px(8.0);
        }
        let main_h = f.px(ITEM_H);
        let main = Rect::new(f.bounds.left, f.y, f.bounds.right, f.y + main_h);
        // The hairline the original leaves under every row. It is transparent — what it buys is
        // one pixel of separation that does not move when a row is opened or closed.
        f.y = main.bottom + f.px(1.0);

        let card_top = main.top;
        let hovered_row = f.hovered(main);
        if expanded {
            // The plate, before anything that sits on it. Its height is last frame's measurement,
            // so the first frame after a row opens draws the outline over the fields with no fill
            // behind them — one frame, and the alternative is a plate painted over its contents.
            if state.item_card_h > 0.0 {
                f.p.fill_round_rect(
                    Rect::new(main.left, card_top, main.right, card_top + state.item_card_h),
                    f.px(8.0),
                    f.theme.raised,
                );
            }
        } else if hovered_row {
            f.p.fill_rect(main, f.theme.hover);
        }

        let pad = f.px(ITEM_PAD);
        let grip = Rect::new(main.left + pad, main.top + f.px(6.0), main.left + pad + f.px(16.0), main.bottom - f.px(6.0));
        // The grip is the handle a mouse would drag by. There is no drag here yet, so it is drawn
        // at the weight the original gives it and left alone: a control that looks draggable and
        // is not would be a worse lie than a mark that is clearly just a mark.
        f.p.glyph(
            "GripVertical",
            grip.center(),
            f.px(14.0),
            w::alpha(f.theme.text_2, if expanded { 0.12 } else if hovered_row { 0.5 } else { 0.0 }),
            1.9,
        );

        // The item's own picture if it has one, its glyph otherwise — the same choice the wheel
        // makes, so the list and the wheel never disagree about what a shortcut looks like.
        let chip = Rect::new(
            main.left + pad + f.px(24.0),
            main.center().1 - f.px(15.0),
            main.left + pad + f.px(54.0),
            main.center().1 + f.px(15.0),
        );
        f.p.fill_round_rect(chip, f.px(6.0), f.theme.raised);
        let art = item
            .custom_icon_url
            .as_deref()
            .and_then(|reference| f.icons.and_then(|icons| icons.bitmap(reference)));
        match art {
            Some(bitmap) => f.p.bitmap_rounded(chip.inflate(-f.px(4.0)), &bitmap, 1.0, f.px(3.0)),
            None => {
                let glyph = if item.icon_name.is_empty() {
                    crate::gfx::lucide::FALLBACK
                } else {
                    item.icon_name.as_str()
                };
                f.p.glyph(glyph, chip.center(), f.px(17.0), f.theme.text_2, 1.7);
            }
        }

        // The name and what it opens, as one block centred in the row.
        let name_style = item_name_style(f.scale, f.rtl);
        let detail_style = item_detail_style(f.scale, f.rtl);
        let summary = target_summary(&item);
        let nh = line_h(f, 11.5);
        let dh = line_h(f, 9.5);
        let block_h = nh + f.px(3.0) + dh;
        let copy_x = main.left + f.px(ITEM_COPY_X);
        let copy_right = main.right - f.px(ITEM_PAD + 106.0 + 8.0);
        let top = main.center().1 - block_h / 2.0;
        let after = line(
            f,
            &item.label,
            &name_style,
            Rect::new(copy_x, top, copy_right, top + nh),
            nh,
            f.theme.text,
        );
        line(
            f,
            &summary,
            &detail_style,
            Rect::new(copy_x, after + f.px(3.0), copy_right, after + f.px(3.0) + dh),
            dh,
            f.theme.text_3,
        );

        // Four icon buttons at the right, in the order the original puts them: move, move, edit,
        // remove. Reordering first and destroying last is what stops a mis-click being expensive.
        let size = f.px(25.0);
        let gap = f.px(2.0);
        let mut x = main.right - f.px(ITEM_PAD) - size * 4.0 - gap * 3.0;
        let last = items.len() - 1;
        for (which, glyph, enabled, art) in [
            ("up", "ChevronUp", at > 0, 14.0),
            ("dn", "ChevronDown", at < last, 14.0),
            ("ed", "Pencil", true, 13.0),
            ("rm", "X", true, 13.0),
        ] {
            let b = Rect::new(x, main.center().1 - size / 2.0, x + size, main.center().1 + size / 2.0);
            x = b.right + gap;
            let on = which == "ed" && expanded;
            let hovered = enabled && f.hovered(b);
            if hovered {
                f.set_cursor(Cursor::Hand);
            }
            if on || hovered {
                f.p.fill_round_rect(b, f.px(6.0), f.theme.raised);
            }
            // The whole cluster is held back until the row is pointed at, which is what keeps a
            // list of twelve shortcuts from reading as a list of forty-eight buttons.
            let resting = if expanded || hovered_row { 1.0 } else { 0.7 };
            let ink = if on || hovered { f.theme.text } else { w::alpha(f.theme.text_3, resting) };
            f.p.glyph(glyph, b.center(), f.px(art), w::dimmed(ink, enabled), 1.9);
            if enabled && f.clicked(&format!("item-{which}:{}", item.id), b) {
                match which {
                    "ed" => {
                        state.editing_item = if expanded { None } else { Some(item.id.clone()) };
                        state.item_card_h = 0.0;
                    }
                    "up" => move_from_to = Some((at, at - 1)),
                    "dn" => move_from_to = Some((at, at + 1)),
                    _ => remove = Some(at),
                }
            }
        }

        if expanded {
            item_editor(f, state, items, at);
            f.y += f.px(12.0);
            let card = Rect::new(main.left, card_top, main.right, f.y);
            // The outline goes on last, over the fill and over everything in it.
            f.p.stroke_round_rect(card.inflate(-0.5), f.px(8.0), f.theme.line_strong, 1.0);
            if (state.item_card_h - card.height()).abs() > 0.5 {
                state.item_card_h = card.height();
                f.want_frame();
            }
            f.y += f.px(8.0);
        }
    }

    if let Some((from, to)) = move_from_to {
        items.swap(from, to);
        f.mark_dirty();
    }
    if let Some(at) = remove {
        let gone = items.remove(at);
        if state.editing_item.as_deref() == Some(gone.id.as_str()) {
            state.editing_item = None;
        }
        f.ui.toast(format!("Removed {}", gone.label));
        f.mark_dirty();
    }
}

// What the row says under the label.
fn target_summary(item: &AppItem) -> String {
    let kind = match item.command_type {
        Some(CommandType::Url) => "Web",
        Some(CommandType::Folder) => "Folder",
        Some(CommandType::File) => "File",
        Some(CommandType::Command) => "Command",
        _ => "App",
    };
    // A launch line carries its program quoted, because the path has spaces in it. The quotes
    // are the shell's business and not something to show somebody reading a list.
    let target = item.command.trim().trim_matches('"');
    if target.is_empty() {
        return kind.to_string();
    }
    // The shortest honest form: a path is read from its leaf, everything else from the front.
    let short = if matches!(item.command_type, Some(CommandType::Url) | Some(CommandType::Command)) {
        target.to_string()
    } else {
        target.rsplit(['\\', '/']).next().unwrap_or(target).to_string()
    };
    let short = if short.chars().count() > 58 {
        format!("{}…", short.chars().take(57).collect::<String>())
    } else {
        short
    };
    format!("{kind} \u{00b7} {short}")
}

/// The expanded row: name, target, icon, and the options that kind of shortcut actually has.
/// A label above its control, which is the shape every field in the dialog takes.
///
/// Not `w::row`: a row puts the title on the left and the control on the right, which is right for
/// a page of settings and wrong inside a card — the eye is already indented under the shortcut's
/// name, and a second column would put the label further from the box it names than from the box
/// above it. Returns where the control goes.
fn field(f: &mut Frame, label: &str, width: f32) -> Rect {
    let style = item_name_style(f.scale, f.rtl);
    let lh = line_h(f, 11.5);
    line(f, label, &style, Rect::new(f.bounds.left, f.y, f.bounds.right, f.y + lh), lh, f.theme.text_2);
    f.y += lh + f.px(8.0);
    let at = Rect::new(
        f.bounds.left,
        f.y,
        (f.bounds.left + f.px(width)).min(f.bounds.right),
        f.y + f.px(32.0),
    );
    f.y = at.bottom;
    at
}

/// The widest a field inside a card gets before it stops helping.
///
/// A path is longer than any box, and a box that runs the full width of the dialog makes the three
/// above it look like a form. The original caps the short ones here and lets a command line run.
const FIELD_W: f32 = 340.0;
const FIELD_WIDE: f32 = 10_000.0;

fn item_editor(
    f: &mut Frame,
    state: &mut super::settings::SettingsUi,
    items: &mut [AppItem],
    at: usize,
) {
    let item = items[at].clone();
    let saved = f.bounds;
    // Indented to sit under the shortcut's name, so the card reads as belonging to that row.
    f.bounds = Rect::new(saved.left + f.px(46.0), saved.top, saved.right - f.px(ITEM_PAD), saved.bottom);
    f.y += f.px(4.0);

    let r = field(f, "Name", FIELD_W);
    if let Some(next) = w::text_field(f, &format!("it-name:{}", item.id), r, &item.label, "Name shown on the wheel") {
        items[at].label = next;
        f.mark_dirty();
    }
    f.gap(12.0);

    // The icon, as a button that shows the icon rather than as a row that describes it.
    icon_field(f, state, &item);
    f.gap(12.0);

    let (title, placeholder, width) = match item.command_type {
        Some(CommandType::Url) => ("Address", "https://example.com", FIELD_WIDE),
        Some(CommandType::Command) => ("Command line", "A line your shell understands", FIELD_WIDE),
        Some(CommandType::Folder) => ("Folder", "C:\\Users\\You\\Projects", FIELD_WIDE),
        Some(CommandType::File) => ("File", "C:\\Users\\You\\notes.pdf", FIELD_WIDE),
        _ => ("Target", "The program to start", FIELD_WIDE),
    };
    let r = field(f, title, width);
    if let Some(next) = w::text_field(f, &format!("it-cmd:{}", item.id), r, &item.command, placeholder) {
        items[at].command = next;
        f.mark_dirty();
    }
    f.gap(12.0);

    match item.command_type {
        Some(CommandType::Command) => {
            let options = [("powershell", "PowerShell"), ("cmd", "cmd")];
            let r = field(f, "Run in", 220.0);
            let r = Rect::new(r.left, r.top, r.left + w::segmented_width(f, &options), r.bottom);
            let shell = item.command_shell.unwrap_or(CommandShell::Powershell);
            if let Some(pick) = w::segmented(
                f,
                &format!("it-shell:{}", item.id),
                r,
                &options,
                if shell == CommandShell::Cmd { "cmd" } else { "powershell" },
                true,
            ) {
                items[at].command_shell =
                    Some(if pick == "cmd" { CommandShell::Cmd } else { CommandShell::Powershell });
                f.mark_dirty();
            }
            f.gap(12.0);

            let options = [("open", "Show"), ("hidden", "Hide")];
            let r = field(f, "Console", 180.0);
            let r = Rect::new(r.left, r.top, r.left + w::segmented_width(f, &options), r.bottom);
            let window = item.command_window.unwrap_or(CommandWindow::Open);
            if let Some(pick) = w::segmented(
                f,
                &format!("it-win:{}", item.id),
                r,
                &options,
                if window == CommandWindow::Hidden { "hidden" } else { "open" },
                true,
            ) {
                items[at].command_window =
                    Some(if pick == "hidden" { CommandWindow::Hidden } else { CommandWindow::Open });
                f.mark_dirty();
            }
            f.gap(12.0);

            let r = field(f, "Working folder", FIELD_WIDE);
            let current = item.working_directory.clone().unwrap_or_default();
            if let Some(next) = w::text_field(f, &format!("it-dir:{}", item.id), r, &current, "Your user folder") {
                items[at].working_directory =
                    if next.trim().is_empty() { None } else { Some(next) };
                f.mark_dirty();
            }
        }
        Some(CommandType::Url) | Some(CommandType::File) => {}
        _ => {
            let options = [("normal", "Normal"), ("reuse", "Reuse"), ("prewarm", "Warm")];
            let r = field(f, "Launch mode", 280.0);
            let r = Rect::new(r.left, r.top, r.left + w::segmented_width(f, &options), r.bottom);
            let mode = item.launch_mode.unwrap_or(LaunchMode::Normal);
            let picked = match mode {
                LaunchMode::Reuse => "reuse",
                LaunchMode::Prewarm => "prewarm",
                LaunchMode::Normal => "normal",
            };
            if let Some(pick) = w::segmented(
                f,
                &format!("it-mode:{}", item.id),
                r,
                &options,
                picked,
                true,
            ) {
                items[at].launch_mode = Some(match pick.as_str() {
                    "reuse" => LaunchMode::Reuse,
                    "prewarm" => LaunchMode::Prewarm,
                    _ => LaunchMode::Normal,
                });
                f.mark_dirty();
            }
            f.gap(6.0);
            // What the three modes mean, under them rather than in a tooltip: the words are the
            // only thing telling "Reuse" from "Warm", and a control whose labels need explaining
            // has to carry the explanation.
            let note = "Reuse hands the target to a window that is already open instead of starting a second one.";
            let wrapped = Rect::new(f.bounds.left, f.y, f.bounds.right, f.bounds.bottom);
            f.y += w::draw_wrapped_at(f, note, wrapped, f.theme.text_3);
            // Last, and only on a program: the recents submenu is a thing the TARGET has, and a
            // URL or a document has no projects to have been in recently.
            ide_block(f, items, at);
        }
    }

    f.bounds = saved;
}

/// The icon field: the picture itself, what it came from, and a pencil.
///
/// A shortcut that found its own picture says so, instead of being offered a glyph list that would
/// not be used anyway — but the button still opens one, because "found its own" is sometimes the
/// wrong picture and the glyph is the way out of that.
fn icon_field(f: &mut Frame, state: &mut super::settings::SettingsUi, item: &AppItem) {
    let label_style = item_name_style(f.scale, f.rtl);
    let lh = line_h(f, 11.5);
    line(f, "Icon", &label_style, Rect::new(f.bounds.left, f.y, f.bounds.right, f.y + lh), lh, f.theme.text_2);
    f.y += lh + f.px(8.0);

    let has_picture = item.custom_icon_url.is_some();
    let (title, detail) = match item.icon_source {
        Some(IconSource::Custom) => ("Your picture", "Chosen by you."),
        Some(IconSource::Native) if has_picture => ("The program's icon", "Taken from the program."),
        _ => (
            if item.icon_name.is_empty() { crate::gfx::lucide::FALLBACK } else { item.icon_name.as_str() },
            "A drawn glyph.",
        ),
    };

    let at = Rect::new(
        f.bounds.left,
        f.y,
        (f.bounds.left + f.px(FIELD_W)).min(f.bounds.right),
        f.y + f.px(48.0),
    );
    f.y = at.bottom;

    let open = matches!(&state.icon_picker, Some(IconTarget::Item(id)) if id == &item.id);
    let hovered = f.hovered(at);
    if hovered {
        f.set_cursor(Cursor::Hand);
    }
    f.p.fill_round_rect(at, f.px(8.0), if hovered { f.theme.hover } else { f.theme.sunken });
    f.p.stroke_round_rect(
        at.inflate(-0.5),
        f.px(8.0),
        if hovered || open { f.theme.line_strong } else { f.theme.line },
        1.0,
    );

    let chip = Rect::new(at.left + f.px(8.0), at.center().1 - f.px(15.0), at.left + f.px(38.0), at.center().1 + f.px(15.0));
    let art = item
        .custom_icon_url
        .as_deref()
        .and_then(|reference| f.icons.and_then(|icons| icons.bitmap(reference)));
    match art {
        Some(bitmap) => f.p.bitmap_rounded(chip.inflate(-f.px(3.0)), &bitmap, 1.0, f.px(3.0)),
        None => {
            let glyph = if item.icon_name.is_empty() {
                crate::gfx::lucide::FALLBACK
            } else {
                item.icon_name.as_str()
            };
            f.p.glyph(glyph, chip.center(), f.px(17.0), f.theme.text_2, 1.7);
        }
    }

    let name_style = item_name_style(f.scale, f.rtl);
    let detail_style = item_detail_style(f.scale, f.rtl);
    let (_, nh) = f.p.measure(title, &name_style);
    let (_, dh) = f.p.measure(detail, &detail_style);
    let top = at.center().1 - (nh + f.px(2.0) + dh) / 2.0;
    let text_right = at.right - f.px(30.0);
    f.p.text(title, Rect::new(chip.right + f.px(8.0), top, text_right, top + nh), &name_style, f.theme.text);
    f.p.text(
        detail,
        Rect::new(chip.right + f.px(8.0), top + nh + f.px(2.0), text_right, at.bottom),
        &detail_style,
        f.theme.text_3,
    );
    f.p.glyph(
        "Pencil",
        (at.right - f.px(16.0), at.center().1),
        f.px(13.0),
        if hovered { f.theme.text_2 } else { f.theme.text_3 },
        1.9,
    );

    if f.clicked(&format!("it-icon:{}", item.id), at) {
        state.icon_picker = if open { None } else { Some(IconTarget::Item(item.id.clone())) };
        state.icon_search.clear();
    }
}

// ── Adding ──────────────────────────────────────────────────────────────────

/// One stacked field's height: its label, the gap, and the control.
fn field_h(f: &Frame) -> f32 {
    line_h(f, 11.5) + f.px(8.0) + f.px(32.0)
}

/// The panel that opens under the add bar.
///
/// A plate of its own — sunken, outlined, inset — rather than more rows in the column. The list
/// below it is a list of things that exist; this is a half-made one, and the box is what says so.
fn add_panel(
    f: &mut Frame,
    state: &mut super::settings::SettingsUi,
    items: &mut Vec<AppItem>,
    language: &str,
) {
    let Some(mode) = state.add_mode else {
        return;
    };

    let pad = f.px(12.0);
    // The box is drawn before its contents, so its height is worked out first. Every form here is
    // a fixed shape, which is what makes that possible without a measuring pass.
    let inner_h = match mode {
        AddMode::App => apps_panel_h(f, state),
        AddMode::Command => field_h(f) * 2.0 + f.px(12.0) * 3.0 + f.px(32.0) * 2.0 + f.px(32.0),
        _ => field_h(f),
    };
    let box_at = Rect::new(f.bounds.left, f.y, f.bounds.right, f.y + inner_h + pad * 2.0);
    f.y = box_at.bottom + f.px(12.0);
    f.p.fill_round_rect(box_at, f.px(8.0), f.theme.sunken);
    f.p.stroke_round_rect(box_at.inflate(-0.5), f.px(8.0), f.theme.line, 1.0);

    let saved_bounds = f.bounds;
    let saved_y = f.y;
    f.bounds = Rect::new(box_at.left + pad, box_at.top, box_at.right - pad, box_at.bottom);
    f.y = box_at.top + pad;

    // A list, because the installed picker can hand over several at once and every other form
    // hands over one. One shape for both is what keeps the commit below from being written twice.
    let made: Vec<AppItem> = match mode {
        AddMode::App => app_picker(f, state, language),
        AddMode::Url => path_form(f, state, mode).into_iter().collect(),
        AddMode::Folder => path_form(f, state, mode).into_iter().collect(),
        AddMode::File => path_form(f, state, mode).into_iter().collect(),
        AddMode::Command => command_form(f, state).into_iter().collect(),
    };

    f.bounds = saved_bounds;
    f.y = saved_y;

    if !made.is_empty() {
        // Ids come from the application's own identifier, so adding two at once is the one moment
        // two shortcuts could be born sharing one — `new_item` is given the same `app.id` twice
        // only if the list offered the same application twice, but a dropped batch has no such
        // guarantee and neither does a future caller.
        for item in made {
            items.push(item);
        }
        state.add_mode = None;
        state.draft = Draft::default();
        state.app_search.clear();
        state.multi_select = false;
        state.selected_apps.clear();
        f.mark_dirty();
    }
}

/// A target, a name, and the button that commits them — one row, bottom-aligned.
///
/// Shared by URL, folder and file because the three differ only in what they call the box, how the
/// box is filled, and what `command_type` comes out. A URL is typed; a folder and a file are
/// browsed for, because nobody types `C:\Users\You\AppData\Local\…` into a settings panel.
fn path_form(
    f: &mut Frame,
    state: &mut super::settings::SettingsUi,
    mode: AddMode,
) -> Option<AppItem> {
    let row_top = f.y;
    let row_h = field_h(f);
    let gap = f.px(12.0);

    let button = mode.add_label();
    let button_w = f.p.measure(button, &w::control_style(f.scale, f.rtl)).0 + f.px(44.0);
    let free = (f.bounds.width() - gap * 2.0 - button_w).max(f.px(160.0));
    let target_w = free * 0.6;

    // The target: a box for a URL, a browse button for anything on disk.
    let saved = f.bounds;
    f.bounds = Rect::new(saved.left, saved.top, saved.left + target_w, saved.bottom);
    if mode == AddMode::Url {
        let at = field(f, mode.target_label(), 10_000.0);
        if let Some(next) = w::text_field(f, "add-target", at, &state.draft.target, "https://example.com") {
            state.draft.target = next;
        }
    } else {
        f.y = row_top + row_h - f.px(54.0);
        let at = Rect::new(f.bounds.left, f.y, f.bounds.right, f.y + f.px(54.0));
        f.y = at.bottom;
        if browse_button(f, mode, &state.draft.target) {
            state.pick_path = Some(mode);
        }
    }

    // The name it will carry on the wheel.
    f.bounds = Rect::new(saved.left + target_w + gap, saved.top, saved.right - button_w - gap, saved.bottom);
    f.y = row_top;
    let at = field(f, "Name", 10_000.0);
    if let Some(next) = w::text_field(f, "add-label", at, &state.draft.label, "Filled automatically") {
        state.draft.label = next;
    }

    f.bounds = saved;
    f.y = row_top + row_h;

    let target = state.draft.target.trim().to_string();
    let at = Rect::new(saved.right - button_w, row_top + row_h - f.px(32.0), saved.right, row_top + row_h);
    if add_button(f, at, button, !target.is_empty()) {
        let label = if state.draft.label.trim().is_empty() {
            default_label(&target, mode.kind())
        } else {
            state.draft.label.trim().to_string()
        };
        return Some(new_item(label, target, mode.kind()));
    }
    None
}

/// The dashed plate that opens File Explorer: what has been chosen, or an invitation.
fn browse_button(f: &mut Frame, mode: AddMode, chosen: &str) -> bool {
    let at = Rect::new(f.bounds.left, f.y - f.px(54.0), f.bounds.right, f.y);
    let hovered = f.hovered(at);
    if hovered {
        f.set_cursor(Cursor::Hand);
    }
    if hovered {
        f.p.fill_round_rect(at, f.px(8.0), f.theme.hover);
    }
    super::settings::dashed_round_rect(f, at.inflate(-0.5), f.px(8.0), f.theme.line_strong);

    let folder = mode == AddMode::Folder;
    let ink = if hovered { f.theme.text } else { f.theme.text_2 };
    f.p.glyph(
        if folder { "FolderOpen" } else { "File" },
        (at.left + f.px(22.0), at.center().1),
        f.px(20.0),
        ink,
        1.7,
    );

    // The leaf of the path, with the whole of it underneath: a column of full paths is unreadable,
    // and the last segment is what anybody actually recognises.
    let (title, detail) = if chosen.is_empty() {
        (
            if folder { "Select a folder" } else { "Select a file" },
            if folder {
                "Opens File Explorer".to_string()
            } else {
                "Opens with whatever Windows uses for that file type".to_string()
            },
        )
    } else {
        let leaf = chosen
            .rsplit(['\\', '/'])
            .find(|part| !part.is_empty())
            .unwrap_or(chosen);
        (leaf, chosen.to_string())
    };

    let name_style = item_name_style(f.scale, f.rtl);
    let detail_style = item_detail_style(f.scale, f.rtl);
    let nh = line_h(f, 11.5);
    let dh = line_h(f, 9.5);
    let top = at.center().1 - (nh + f.px(2.0) + dh) / 2.0;
    let left = at.left + f.px(40.0);
    let right = at.right - f.px(28.0);
    let after = line(f, title, &name_style, Rect::new(left, top, right, top + nh), nh, ink);
    line(
        f,
        &detail,
        &detail_style,
        Rect::new(left, after + f.px(2.0), right, after + f.px(2.0) + dh),
        dh,
        f.theme.text_3,
    );
    f.p.glyph("ChevronRight", (at.right - f.px(14.0), at.center().1), f.px(15.0), f.theme.text_3, 1.8);

    f.clicked("add-browse", at)
}

/// The primary button at the end of an add row: a plus, then what it will add.
///
/// Drawn here rather than through `w::button_at` for one reason — that one centres its label
/// across the whole button, which is right for a word on its own and wrong for a word with a mark
/// in front of it. The two have to be centred TOGETHER or the gap between them moves with the
/// label's length.
fn add_button(f: &mut Frame, at: Rect, label: &str, enabled: bool) -> bool {
    let hovered = enabled && f.hovered(at);
    if hovered {
        f.set_cursor(Cursor::Hand);
    }
    let dim = if enabled { 1.0 } else { pal::DISABLED_DIM };
    let plate = w::alpha(f.theme.solid, if hovered { 0.9 * dim } else { dim });
    f.p.fill_round_rect(at, f.px(8.0), plate);

    let style = crate::gfx::text::Style::new(
        crate::gfx::text::Family::Ui,
        11.5 * f.scale,
        550,
        crate::gfx::text::Align::Leading,
    )
    .rtl(f.rtl);
    let (tw, th) = f.p.measure(label, &style);
    let glyph = f.px(14.0);
    let gap = f.px(8.0);
    let left = at.center().0 - (glyph + gap + tw) / 2.0;
    let ink = w::alpha(f.theme.on_solid, dim);
    f.p.glyph("Plus", (left + glyph / 2.0, at.center().1), glyph, ink, 2.0);
    f.p.text(
        label,
        Rect::new(left + glyph + gap, at.center().1 - th / 2.0, at.right, at.bottom),
        &style,
        ink,
    );
    enabled && f.clicked("add-go", at)
}

/// A command line, a name, where it runs, and the two choices that shape the window it runs in.
fn command_form(f: &mut Frame, state: &mut super::settings::SettingsUi) -> Option<AppItem> {
    let gap = f.px(12.0);
    let saved = f.bounds;
    let column = (saved.width() - gap) / 2.0;

    let at = field(f, "Command line", 10_000.0);
    let hint = if state.draft.cmd { "ipconfig /flushdns && pause" } else { "git pull; npm run dev" };
    if let Some(next) = w::text_field(f, "add-target", at, &state.draft.target, hint) {
        state.draft.target = next;
    }
    f.gap(12.0);

    // Two columns: what it is called, and where it runs.
    let row_top = f.y;
    f.bounds = Rect::new(saved.left, saved.top, saved.left + column, saved.bottom);
    let at = field(f, "Name", 10_000.0);
    if let Some(next) = w::text_field(f, "add-label", at, &state.draft.label, "Name shown on the wheel") {
        state.draft.label = next;
    }
    f.bounds = Rect::new(saved.left + column + gap, saved.top, saved.right, saved.bottom);
    f.y = row_top;
    let at = field(f, "Run in", 10_000.0);
    let browse_w = f.p.measure("Browse", &w::control_style(f.scale, f.rtl)).0 + f.px(38.0);
    let box_at = Rect::new(at.left, at.top, at.right - browse_w - f.px(8.0), at.bottom);
    if let Some(next) = w::text_field(f, "add-dir", box_at, &state.draft.working_dir, "Your user folder") {
        state.draft.working_dir = next;
    }
    let browse = Rect::new(at.right - browse_w, at.top, at.right, at.bottom);
    if w::button_at(f, "add-dir-browse", browse, "Browse", ButtonKind::Normal, true) {
        state.pick_path = Some(AddMode::Folder);
    }
    f.bounds = saved;
    f.gap(12.0);

    // The two things a command needs that a program does not.
    let row_top = f.y;
    f.bounds = Rect::new(saved.left, saved.top, saved.left + column, saved.bottom);
    let at = field(f, "Shell", 10_000.0);
    let shell_options = [("powershell", "PowerShell"), ("cmd", "Command Prompt")];
    let at = Rect::new(at.left, at.top, at.left + w::segmented_width(f, &shell_options), at.bottom);
    if let Some(pick) = w::segmented(
        f,
        "add-shell",
        at,
        &[("powershell", "PowerShell"), ("cmd", "Command Prompt")],
        if state.draft.cmd { "cmd" } else { "powershell" },
        true,
    ) {
        state.draft.cmd = pick == "cmd";
    }
    f.bounds = Rect::new(saved.left + column + gap, saved.top, saved.right, saved.bottom);
    f.y = row_top;
    let at = field(f, "Window", 10_000.0);
    let window_options = [("open", "Open"), ("hidden", "Hidden")];
    let at = Rect::new(at.left, at.top, at.left + w::segmented_width(f, &window_options), at.bottom);
    if let Some(pick) = w::segmented(
        f,
        "add-window",
        at,
        &[("open", "Open"), ("hidden", "Hidden")],
        if state.draft.hidden { "hidden" } else { "open" },
        true,
    ) {
        state.draft.hidden = pick == "hidden";
    }
    f.bounds = saved;
    f.gap(12.0);

    let target = state.draft.target.trim().to_string();
    let button = AddMode::Command.add_label();
    let button_w = f.p.measure(button, &w::control_style(f.scale, f.rtl)).0 + f.px(44.0);
    let at = Rect::new(saved.right - button_w, f.y, saved.right, f.y + f.px(32.0));
    f.y = at.bottom;
    if add_button(f, at, button, !target.is_empty()) {
        let label = if state.draft.label.trim().is_empty() {
            default_label(&target, CommandType::Command)
        } else {
            state.draft.label.trim().to_string()
        };
        let mut item = new_item(label, target, CommandType::Command);
        item.command_shell = Some(if state.draft.cmd { CommandShell::Cmd } else { CommandShell::Powershell });
        item.command_window = Some(if state.draft.hidden { CommandWindow::Hidden } else { CommandWindow::Open });
        let dir = state.draft.working_dir.trim();
        item.working_directory = if dir.is_empty() { None } else { Some(dir.to_string()) };
        return Some(item);
    }
    None
}

/// How many rows of the installed list are drawn at once.
///
/// The list is 300+ entries on a normal machine. Immediate mode redraws all of them every frame,
/// and each one measures a string — so it is paged, exactly as the original pages it for the same
/// reason in a different runtime.
const APPS_PAGE: usize = 40;
/// One row of it, and the window the list is shown through.
const APP_ROW_H: f32 = 42.0;
const APPS_MIN_H: f32 = 132.0;
const APPS_MAX_H: f32 = 320.0;

/// How tall the installed list will be, so the panel around it can be drawn first.
fn apps_list_h(f: &Frame, state: &super::settings::SettingsUi) -> f32 {
    let term = state.app_search.trim().to_lowercase();
    let shown = state
        .installed
        .iter()
        .filter(|app| term.is_empty() || app.label.to_lowercase().contains(&term))
        .count()
        .min(APPS_PAGE);
    let rows = if shown == 0 { f.px(44.0) } else { f.px(APP_ROW_H) * shown as f32 };
    rows.clamp(f.px(APPS_MIN_H), f.px(APPS_MAX_H))
}

/// The toolbar's chips, and the footer's: a labelled button whose width is its text.
///
/// `w::button` right-aligns inside the rectangle it is given, which is right for a row of settings
/// and wrong here — these are laid out from the left of a bar that also holds a search box. This
/// one takes a left edge and reports where it ended, so the next chip starts there.
fn chip_button(
    f: &mut Frame,
    id: &str,
    left: f32,
    top: f32,
    glyph: &str,
    label: &str,
    kind: ButtonKind,
) -> (bool, f32) {
    let style = w::control_style(f.scale, f.rtl);
    let tw = f.p.measure(label, &style).0;
    let width = tw + f.px(14.0 + 7.0 + 18.0);
    let at = Rect::new(left, top, left + width, top + f.px(32.0));
    // The glyph is drawn over the button, which has already painted its own plate and text. The
    // label is nudged right by the glyph's column so the two do not overlap.
    let pressed = w::button_at(f, id, at, &format!("    {label}"), kind, true);
    let ink = match kind {
        ButtonKind::Primary => f.theme.on_solid,
        _ => f.theme.text_2,
    };
    f.p.glyph(glyph, (at.left + f.px(15.0), at.center().1), f.px(13.0), ink, 1.9);
    (pressed, at.right)
}

/// How tall the installed list's panel is, which `add_panel` needs before it draws the box.
///
/// The footer only exists while something is ticked — a bar reading "0 selected" beside a button
/// that cannot be pressed is a row of furniture.
fn apps_panel_h(f: &Frame, state: &super::settings::SettingsUi) -> f32 {
    let footer = if state.multi_select && !state.selected_apps.is_empty() {
        f.px(8.0) + f.px(32.0)
    } else {
        0.0
    };
    f.px(32.0) + f.px(8.0) + apps_list_h(f, state) + footer
}

fn app_picker(
    f: &mut Frame,
    state: &mut super::settings::SettingsUi,
    language: &str,
) -> Vec<AppItem> {
    // The bar: the search, then the chips that change what a click on a row means. Laid out from
    // the RIGHT, so the box takes whatever is left and the chips keep their shape as the dialog
    // narrows — the same rule the add bar above the list follows.
    let bar_top = f.y;
    let mut right = f.bounds.right;

    let multi_label = crate::i18n::settings_text("multiSelect", language);
    let (toggled, _) = {
        let style = w::control_style(f.scale, f.rtl);
        let width = f.p.measure(multi_label, &style).0 + f.px(14.0 + 7.0 + 18.0);
        let left = right - width;
        let kind = if state.multi_select { ButtonKind::Primary } else { ButtonKind::Normal };
        let glyph = if state.multi_select { "CheckSquare" } else { "Square" };
        let out = chip_button(f, "add-multi", left, bar_top, glyph, multi_label, kind);
        right = left - f.px(6.0);
        out
    };
    if toggled {
        state.multi_select = !state.multi_select;
        // Leaving the mode drops the ticks with it. A selection that survived being switched off
        // would be added by the next press of a button the user had forgotten was armed.
        if !state.multi_select {
            state.selected_apps.clear();
        }
        f.mark_dirty();
    }

    // What the list currently offers, which both "select all" and the footer count are about.
    let term = state.app_search.trim().to_lowercase();
    let matches: Vec<usize> = state
        .installed
        .iter()
        .enumerate()
        .filter(|(_, app)| term.is_empty() || app.label.to_lowercase().contains(&term))
        .map(|(at, _)| at)
        .collect();
    let shown = matches.len().min(APPS_PAGE);
    let all_ticked = shown > 0
        && matches[..shown].iter().all(|&which| {
            state.selected_apps.iter().any(|c| c == &state.installed[which].command)
        });

    if state.multi_select {
        let label = crate::i18n::settings_text(
            if all_ticked { "clearSelection" } else { "selectAll" },
            language,
        );
        let style = w::control_style(f.scale, f.rtl);
        let width = f.p.measure(label, &style).0 + f.px(14.0 + 7.0 + 18.0);
        let left = right - width;
        let glyph = if all_ticked { "Square" } else { "CheckSquare" };
        let (pressed, _) = chip_button(f, "add-all", left, bar_top, glyph, label, ButtonKind::Normal);
        right = left - f.px(6.0);
        if pressed {
            // "All" means all that are SHOWN, not all that exist: the button sits beside a search
            // box, and ticking three hundred hidden rows is not what a filtered list offers.
            if all_ticked {
                for &which in &matches[..shown] {
                    let command = state.installed[which].command.clone();
                    state.selected_apps.retain(|c| c != &command);
                }
            } else {
                for &which in &matches[..shown] {
                    let command = state.installed[which].command.clone();
                    if !state.selected_apps.iter().any(|c| c == &command) {
                        state.selected_apps.push(command);
                    }
                }
            }
            f.mark_dirty();
        }
    }

    // The search, in the same plate the sidebar's own uses, filling what the chips left.
    let bar = Rect::new(f.bounds.left, bar_top, right, bar_top + f.px(32.0));
    f.y = bar.bottom + f.px(8.0);
    f.p.fill_round_rect(bar, f.px(8.0), f.theme.surface);
    f.p.stroke_round_rect(bar.inflate(-0.5), f.px(8.0), f.theme.line, 1.0);
    f.p.glyph("Search", (bar.left + f.px(16.0), bar.center().1), f.px(14.0), f.theme.text_3, 1.8);
    if let Some(next) = w::text_field_bare(
        f,
        "add-search",
        Rect::new(bar.left + f.px(28.0), bar.top, bar.right - f.px(10.0), bar.bottom),
        &state.app_search,
        "Search installed apps",
    ) {
        state.app_search = next;
    }

    let list = Rect::new(f.bounds.left, f.y, f.bounds.right, f.y + apps_list_h(f, state));
    f.y = list.bottom;

    if state.installed.is_empty() {
        let style = chip_text_style(f.scale, f.rtl).align(crate::gfx::text::Align::Center);
        let (_, th) = f.p.measure("Finding your applications…", &style);
        f.p.text(
            "Finding your applications…",
            Rect::new(list.left, list.center().1 - th / 2.0, list.right, list.bottom),
            &style,
            f.theme.text_3,
        );
        f.want_frame();
        return Vec::new();
    }

    if matches.is_empty() {
        let style = chip_text_style(f.scale, f.rtl).align(crate::gfx::text::Align::Center);
        let (_, th) = f.p.measure("Nothing matches that", &style);
        f.p.text(
            "Nothing matches that",
            Rect::new(list.left, list.center().1 - th / 2.0, list.right, list.bottom),
            &style,
            f.theme.text_3,
        );
        return Vec::new();
    }

    // The list scrolls inside its own window rather than making the dialog longer: a panel that
    // grew by three hundred rows would push everything it is being compared against off-screen.
    let content_h = f.px(APP_ROW_H) * shown as f32;
    let offset = f.ui.scroll_of("add-apps").clamp(0.0, (content_h - list.height()).max(0.0));
    if f.hovered(list) && f.input.scroll != 0.0 {
        let next = (offset - f.input.scroll * f.px(54.0)).clamp(0.0, (content_h - list.height()).max(0.0));
        f.ui.set_scroll("add-apps", next);
        f.want_frame();
    }

    let name_style = item_name_style(f.scale, f.rtl);
    let detail_style = item_detail_style(f.scale, f.rtl);
    let nh = line_h(f, 11.5);
    let dh = line_h(f, 9.5);

    let outer = f.escape_clip();
    f.clip_to(list);
    let mut picked = None;
    let mut ticked: Option<usize> = None;
    for (at, &which) in matches[..shown].iter().enumerate() {
        let top = list.top + f.px(APP_ROW_H) * at as f32 - offset;
        let row = Rect::new(list.left, top, list.right, top + f.px(APP_ROW_H));
        if row.bottom < list.top || row.top > list.bottom {
            continue;
        }
        let app = state.installed[which].clone();
        let on = state.selected_apps.iter().any(|c| c == &app.command);
        let hovered = f.hovered(row);
        if hovered || on {
            f.p.fill_round_rect(row, f.px(6.0), f.theme.hover);
        }
        if hovered {
            f.set_cursor(Cursor::Hand);
        }
        let chip = Rect::new(row.left + f.px(5.0), row.center().1 - f.px(14.0), row.left + f.px(33.0), row.center().1 + f.px(14.0));
        f.p.fill_round_rect(chip, f.px(6.0), f.theme.raised);
        f.p.glyph("Monitor", chip.center(), f.px(15.0), f.theme.text_3, 1.7);

        let top = row.center().1 - (nh + f.px(2.0) + dh) / 2.0;
        let left = chip.right + f.px(8.0);
        let right = row.right - f.px(26.0);
        let ink = if hovered || on { f.theme.text } else { f.theme.text_2 };
        let after = line(f, &app.label, &name_style, Rect::new(left, top, right, top + nh), nh, ink);
        line(
            f,
            &app.command,
            &detail_style,
            Rect::new(left, after + f.px(2.0), right, after + f.px(2.0) + dh),
            dh,
            f.theme.text_3,
        );
        // The mark on the right says what a press will do: a plus adds it now, a box ticks it for
        // later. Two meanings for one click is exactly what has to be visible before it is used.
        let (glyph, mark) = match (state.multi_select, on) {
            (false, _) => ("Plus", f.theme.text_3),
            (true, true) => ("CheckSquare", f.theme.text),
            (true, false) => ("Square", f.theme.text_3),
        };
        f.p.glyph(glyph, (row.right - f.px(13.0), row.center().1), f.px(14.0), mark, 2.0);
        if f.clicked(&format!("app:{which}"), row) {
            if state.multi_select {
                ticked = Some(which);
            } else {
                picked = Some(which);
            }
        }
    }
    f.unclip();
    f.restore_clip(outer);

    if let Some(which) = ticked {
        let command = state.installed[which].command.clone();
        if state.selected_apps.iter().any(|c| c == &command) {
            state.selected_apps.retain(|c| c != &command);
        } else {
            state.selected_apps.push(command);
        }
        f.mark_dirty();
    }

    // The footer: how many are ticked, and the button that takes them.
    let mut commit = false;
    if state.multi_select && !state.selected_apps.is_empty() {
        let foot = Rect::new(f.bounds.left, f.y + f.px(8.0), f.bounds.right, f.y + f.px(40.0));
        f.y = foot.bottom;
        let count = state.selected_apps.len();
        let counted = format!("{count} {}", crate::i18n::settings_text("selectedCount", language));
        let style = chip_text_style(f.scale, f.rtl);
        let (_, th) = f.p.measure(&counted, &style);
        f.p.text(
            &counted,
            Rect::new(foot.left, foot.center().1 - th / 2.0, foot.right, foot.bottom),
            &style,
            f.theme.text_3,
        );
        let label = format!("{} ({count})", crate::i18n::settings_text("addSelected", language));
        let style = w::control_style(f.scale, f.rtl);
        let width = f.p.measure(&label, &style).0 + f.px(14.0 + 7.0 + 18.0);
        let (pressed, _) = chip_button(
            f,
            "add-selected",
            foot.right - width,
            foot.top,
            "Plus",
            &label,
            ButtonKind::Primary,
        );
        commit = pressed;
    }

    if commit {
        let chosen = selected_items(&state.installed, &state.selected_apps);
        state.selected_apps.clear();
        state.multi_select = false;
        return chosen;
    }

    let Some(which) = picked else {
        return Vec::new();
    };
    let app = state.installed[which].clone();
    let mut item = new_item(app.label, app.command, CommandType::App);
    item.id = app.id;
    vec![item]
}

/// The ticked applications as shortcuts, in the LIST's order rather than the order they were
/// ticked.
///
/// The list is what was being read, so shortcuts that arrive in the order they were seen need no
/// explaining — and ticking something, changing your mind, and ticking it again would otherwise
/// move it to the end.
///
/// Apart from the drawing so it can be tested: which shortcuts a selection becomes is the part
/// worth being sure about, and it is a pure function of two lists.
fn selected_items(installed: &[Installed], selected: &[String]) -> Vec<AppItem> {
    installed
        .iter()
        .filter(|app| selected.iter().any(|command| command == &app.command))
        .map(|app| {
            let mut item = new_item(app.label.clone(), app.command.clone(), CommandType::App);
            // The application's own identifier, so a picture already extracted for it is reused
            // rather than queued again.
            item.id = app.id.clone();
            item
        })
        .collect()
}

// A name to fall back on when the user did not type one.
pub(crate) fn default_label(target: &str, kind: CommandType) -> String {
    match kind {
        CommandType::Url => {
            // The host, without `www.` — which is the part of a URL a person would have typed.
            let rest = target
                .split_once("://")
                .map(|(_, rest)| rest)
                .unwrap_or(target);
            let host = rest.split(['/', '?', '#']).next().unwrap_or(rest);
            let host = host.strip_prefix("www.").unwrap_or(host);
            if host.is_empty() {
                "Website".into()
            } else {
                host.to_string()
            }
        }
        CommandType::Command => {
            let first = target.split_whitespace().next().unwrap_or(target);
            let leaf = first.rsplit(['\\', '/']).next().unwrap_or(first);
            leaf.trim_end_matches(".exe").to_string()
        }
        _ => {
            let trimmed = target.trim_end_matches(['\\', '/']);
            let leaf = trimmed.rsplit(['\\', '/']).next().unwrap_or(trimmed);
            let leaf = leaf.strip_suffix(".exe").unwrap_or(leaf);
            if leaf.is_empty() {
                "Shortcut".into()
            } else {
                leaf.to_string()
            }
        }
    }
}

fn new_item(label: String, command: String, kind: CommandType) -> AppItem {
    // An editor is born with its recents submenu already on.
    //
    // Here rather than at each add site, because there are three of them — the installed list, a
    // browsed `.exe`, a typed path — and a feature that appears only when the program was reached
    // one of those three ways is a feature nobody can describe. The switch in the card is how it
    // is turned back off; `looks_like_an_ide` is the same guess `app.rs` makes before it goes
    // looking for a profile, so what is offered here is what the wheel would actually find.
    //
    // `terminal_commands` is seeded EMPTY rather than left absent, which is what the Electron
    // build writes: the list is the thing the card's "Add command" appends to, and `Some([])`
    // says "this shortcut has a command list, which is empty" where `None` says nothing at all.
    let ide = crate::sys::recents::looks_like_an_ide(&label, &command, Some(kind));
    AppItem {
        id: format!("item-{}", super::settings::now_millis()),
        label,
        command,
        command_type: Some(kind),
        has_recents: ide.then_some(true),
        terminal_commands: ide.then(Vec::new),
        icon_name: default_glyph(kind).into(),
        // `Native` for the kinds that have a picture to find; `Lucide` for the ones that do not,
        // so the extractor is never asked for an icon that cannot exist.
        // `Native` for the kinds that have a picture to find -- a program's resources, a site's
        // favicon -- and `Lucide` for the one that does not, so the extractor is never asked for
        // an icon that cannot exist.
        icon_source: Some(match kind {
            CommandType::Command => IconSource::Lucide,
            _ => IconSource::Native,
        }),
        ..AppItem::default()
    }
}

fn default_glyph(kind: CommandType) -> &'static str {
    match kind {
        CommandType::Url => "Globe2",
        CommandType::Folder => "Folder",
        CommandType::File => "File",
        CommandType::Command => "TerminalSquare",
        CommandType::App => "AppWindow",
    }
}


// ── IDE integration ───────────────────────────────────────────────────

/// A toggle inside a shortcut's card: the sentence on the left, the switch on the right.
///
/// Not `w::row`, for the reason `field` is not either — a row outdents its hover band to the
/// page's margin, and inside a card that band would reach past the card's own edge. This one
/// stays within `f.bounds`, which the caller has already narrowed to the card.
///
/// Returns true on the frame it was pressed, like every other control here. The copy takes the
/// press as well as the switch: the words are what is being read, so they are what is aimed at.
fn card_toggle(
    f: &mut Frame,
    id: &str,
    title: &str,
    description: &str,
    on: bool,
    enabled: bool,
) -> bool {
    let name = item_name_style(f.scale, f.rtl);
    let switch_w = f.px(36.0);
    let gap = f.px(16.0);

    let text_right = (f.bounds.right - switch_w - gap).max(f.bounds.left + f.px(80.0));
    let title_h = line_h(f, 11.5);
    let desc_h = if description.is_empty() {
        0.0
    } else {
        w::wrapped_height_of(f, description, text_right - f.bounds.left)
    };
    let text_h = title_h + if desc_h > 0.0 { f.px(2.0) + desc_h } else { 0.0 };
    let height = text_h.max(f.px(32.0));
    let band = Rect::new(f.bounds.left, f.y, f.bounds.right, f.y + height);

    let hovered = enabled && f.hovered(band);
    if hovered {
        f.set_cursor(Cursor::Hand);
    }

    let ink = w::dimmed(f.theme.text, enabled);
    let sub = w::dimmed(f.theme.text_3, enabled);
    let top = band.top + (height - text_h) / 2.0;
    line(f, title, &name, Rect::new(band.left, top, text_right, top + title_h), title_h, ink);
    if desc_h > 0.0 {
        let at = Rect::new(band.left, top + title_h + f.px(2.0), text_right, band.bottom);
        w::draw_wrapped_at(f, description, at, sub);
    }

    f.y = band.bottom;

    // The switch first, so its own press is the one that counts: a hit inside it must be one
    // toggle and not two, and a `clicked` on the whole band would otherwise also fire.
    if w::switch(f, id, band, on, enabled) {
        return true;
    }
    // The copy, only where the switch did not already take it.
    let copy = Rect::new(band.left, band.top, text_right, band.bottom);
    enabled && f.clicked(&format!("{id}-copy"), copy)
}

/// Recent projects, a terminal in the chosen one, and commands to run there.
///
/// Drawn only for a shortcut that could HAVE recent projects. The three controls mean nothing on
/// Notepad, and a card that offered them everywhere would be describing a feature by where it is
/// absent. `looks_like_an_ide` is the same guess `app.rs` uses to decide whether to go looking for
/// a profile, so the block appears exactly where the recents would come from.
///
/// The rest is gated on the first switch: a terminal "for recent folders" with no recent folders
/// to open is a switch with nothing on the other end of it.
fn ide_block(f: &mut Frame, items: &mut [AppItem], at: usize) {
    let item = items[at].clone();
    if !crate::sys::recents::looks_like_an_ide(&item.label, &item.command, item.command_type) {
        return;
    }

    f.gap(14.0);
    let name = item_name_style(f.scale, f.rtl);
    let detail = item_detail_style(f.scale, f.rtl);
    let lh = line_h(f, 11.5);
    line(
        f,
        "IDE integration",
        &name,
        Rect::new(f.bounds.left, f.y, f.bounds.right, f.y + lh),
        lh,
        f.theme.text_2,
    );
    f.y += lh + f.px(2.0);
    let blurb = "Recent projects and automated terminal commands.";
    let (_, dh) = f.p.measure(blurb, &detail);
    f.p.text(
        blurb,
        Rect::new(f.bounds.left, f.y, f.bounds.right, f.y + dh),
        &detail,
        f.theme.text_3,
    );
    f.y += dh + f.px(10.0);

    let recents = item.has_recents.unwrap_or(false);
    if card_toggle(
        f,
        &format!("it-recents:{}", item.id),
        "Show recent folders",
        "Open the IDE as a submenu containing its recent projects.",
        recents,
        true,
    ) {
        // Turning the submenu off leaves the commands stored rather than erasing them: a switch
        // is how somebody tries a feature, and trying it twice should not cost what they typed
        // the first time.
        items[at].has_recents = Some(!recents);
        f.mark_dirty();
    }
    f.gap(8.0);

    let terminal = item.open_terminal_for_recents.unwrap_or(false);
    if card_toggle(
        f,
        &format!("it-recents-term:{}", item.id),
        "Open terminal for recent folders",
        "Starts a terminal in the selected project directory.",
        terminal,
        recents,
    ) {
        items[at].open_terminal_for_recents = Some(!terminal);
        f.mark_dirty();
    }

    if !recents {
        return;
    }

    f.gap(14.0);
    let commands = item.terminal_commands.clone().unwrap_or_default();

    // The heading and the button on one line: "Add command" belongs to this list and to nothing
    // else on the card, and a button on its own row below would read as ending the section.
    let button_label = "Add command";
    let button_w = f.p.measure(button_label, &w::control_style(f.scale, f.rtl)).0 + f.px(44.0);
    let head_h = f.px(32.0);
    let head = Rect::new(f.bounds.left, f.y, f.bounds.right, f.y + head_h);
    let text_right = (head.right - button_w - f.px(12.0)).max(head.left + f.px(80.0));
    line(
        f,
        "Automated commands",
        &name,
        Rect::new(head.left, head.top, text_right, head.top + head_h),
        head_h,
        f.theme.text_2,
    );
    let button_at = Rect::new(head.right - button_w, head.top, head.right, head.bottom);
    f.y = head.bottom + f.px(8.0);
    if add_button(f, button_at, button_label, true) {
        let mut next = commands.clone();
        next.push(String::new());
        items[at].terminal_commands = Some(next);
        f.mark_dirty();
        return;
    }

    if commands.is_empty() {
        let empty = "No automated commands configured.";
        let (_, th) = f.p.measure(empty, &detail);
        f.p.text(
            empty,
            Rect::new(f.bounds.left, f.y, f.bounds.right, f.y + th),
            &detail,
            f.theme.text_3,
        );
        f.y += th;
        return;
    }

    // Run in order, so the row order is the run order and the list is never sorted.
    let remove_w = f.px(32.0);
    let mut edited: Option<(usize, String)> = None;
    let mut removed: Option<usize> = None;
    for (index, command) in commands.iter().enumerate() {
        let row_at = Rect::new(f.bounds.left, f.y, f.bounds.right, f.y + f.px(32.0));
        let box_at =
            Rect::new(row_at.left, row_at.top, row_at.right - remove_w - f.px(8.0), row_at.bottom);
        let placeholder = if index == 0 { "npm install" } else { "npm run dev" };
        if let Some(next) = w::text_field(
            f,
            &format!("it-term:{}:{index}", item.id),
            box_at,
            command,
            placeholder,
        ) {
            edited = Some((index, next));
        }
        let kill = Rect::new(row_at.right - remove_w, row_at.top, row_at.right, row_at.bottom);
        if w::button_at(
            f,
            &format!("it-term-x:{}:{index}", item.id),
            kill,
            "\u{00d7}",
            ButtonKind::Normal,
            true,
        ) {
            removed = Some(index);
        }
        f.y = row_at.bottom + f.px(8.0);
    }
    f.y -= f.px(8.0);

    // One change a frame, applied after the loop: a `Vec` cannot be edited while it is being
    // walked, and a remove during the walk would shift every row drawn after it.
    if let Some(index) = removed {
        let mut next = commands.clone();
        next.remove(index);
        items[at].terminal_commands = Some(next);
        f.mark_dirty();
    } else if let Some((index, value)) = edited {
        let mut next = commands.clone();
        next[index] = value;
        items[at].terminal_commands = Some(next);
        f.mark_dirty();
    }
}


// ── Dropping onto the list ────────────────────────────────────────────

/// The sheet over the Shortcuts section while a drag is on it, and the import when it lands.
///
/// One function for both because they are one question asked twice — "is the pointer over this
/// section" — and the rectangle it is asked about is only known once the section has been drawn.
/// `at` is therefore passed in by the caller rather than computed here.
///
/// The whole SECTION is the target, not the list: a near miss on an empty workspace would
/// otherwise land on the "This workspace is empty" card and do nothing, which is the one moment
/// somebody is most likely to be dragging something in.
fn drop_zone(
    f: &mut Frame,
    state: &mut super::settings::SettingsUi,
    items: &mut Vec<AppItem>,
    name: &str,
    at: Rect,
) {
    let over = f
        .drag
        .map(|(x, y)| at.contains(x, y))
        .unwrap_or(false);

    if over {
        // Over the section, not over the window: the plate is drawn where the shortcuts will go,
        // so what is being promised is a position and not just an acceptance.
        f.p.fill_round_rect(at, f.px(10.0), w::alpha(f.theme.surface, 0.92));
        f.p.stroke_round_rect(at.inflate(-1.0), f.px(10.0), f.theme.line_strong, 1.5);

        let title = format!("Drop to add to {name}");
        let note = "Applications, folders, files, links and commands — added straight away.";
        let title_style = section_style(f.scale, f.rtl).align(crate::gfx::text::Align::Center);
        let note_style = chip_text_style(f.scale, f.rtl).align(crate::gfx::text::Align::Center);
        let (_, th) = f.p.measure(&title, &title_style);
        let centre = at.center();
        f.p.glyph(
            "ArrowDownToLine",
            (centre.0, centre.1 - f.px(26.0)),
            f.px(20.0),
            f.theme.text_2,
            1.8,
        );
        f.p.text(
            &title,
            Rect::new(at.left, centre.1 - f.px(4.0), at.right, at.bottom),
            &title_style,
            f.theme.text,
        );
        f.p.text(
            note,
            Rect::new(at.left, centre.1 - f.px(4.0) + th + f.px(6.0), at.right, at.bottom),
            &note_style,
            f.theme.text_3,
        );
        f.want_frame();
    }

    // The payload is taken whether or not it landed here. A drop that missed the section is a
    // drop that did nothing, and leaving it on the state would make it arrive on the NEXT frame
    // that happened to be drawing this page — which is a workspace opened ten minutes later
    // suddenly growing a shortcut.
    let Some((payload, (x, y))) = state.dropped.take() else {
        return;
    };
    // Where the hand LET GO, not where it last hovered: `f.drag` is already `None` by the time a
    // drop is read, because the hover ended with it. Both are client pixels, which is what `at`
    // is in as well.
    if !at.contains(x, y) {
        return;
    }

    let added = import_dropped(&payload, items);
    if added > 0 {
        f.ui.toast(match added {
            1 => format!("Added \u{201c}{}\u{201d}", items[items.len() - 1].label),
            n => format!("Added {n} shortcuts"),
        });
        f.mark_dirty();
    }
}

/// Everything a drop was worth, appended to the list. Returns how many arrived.
///
/// Kept apart from the drawing so it can be tested without a frame: what a drop becomes is the
/// part worth being sure about, and it is a pure function of the payload once the disk has
/// answered.
fn import_dropped(payload: &crate::sys::dropped::Payload, items: &mut Vec<AppItem>) -> usize {
    use crate::sys::dropped;

    let before = items.len();
    for entry in dropped::entries_from(payload) {
        let made = dropped::to_item(&entry, dropped::resolve_shortcut, |label, command, kind| {
            // The same `new_item` every other way in uses, so a dropped editor arrives with its
            // recents on and a dropped command gets a glyph instead of a doomed extraction.
            let label = label.unwrap_or_else(|| default_label(&command, kind));
            new_item(label, command, kind)
        });
        if let Some(item) = made {
            // `new_item` names the id from the clock, and a drop of four files runs inside one
            // millisecond — so four shortcuts would share one id, and the list would edit, expand
            // and delete all of them together.
            let mut item = item;
            item.id = format!("{}-{}", item.id, items.len());
            items.push(item);
        }
    }
    items.len() - before
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_url_is_named_after_its_host() {
        assert_eq!(default_label("https://www.youtube.com/feed", CommandType::Url), "youtube.com");
        assert_eq!(default_label("https://chatgpt.com/", CommandType::Url), "chatgpt.com");
        // No scheme is still a host: the field accepts what a person pastes.
        assert_eq!(default_label("example.org/x", CommandType::Url), "example.org");
    }

    #[test]
    fn a_path_is_named_after_its_leaf() {
        assert_eq!(default_label(r"C:\Program Files\App\thing.exe", CommandType::App), "thing");
        assert_eq!(default_label(r"C:\Users\Me\Projects\", CommandType::Folder), "Projects");
        assert_eq!(default_label(r"C:\Users\Me\notes.pdf", CommandType::File), "notes.pdf");
    }

    #[test]
    fn a_command_is_named_after_the_program_it_runs() {
        assert_eq!(default_label("git status", CommandType::Command), "git");
        assert_eq!(
            default_label(r"C:\tools\sync.exe --now", CommandType::Command),
            "sync"
        );
    }

    #[test]
    fn every_add_mode_has_a_glyph_that_exists() {
        for mode in AddMode::ALL {
            assert!(crate::gfx::lucide::exists(mode.glyph()), "{:?}", mode);
        }
        for name in SUGGESTED {
            assert!(crate::gfx::lucide::exists(name), "suggested glyph {name} does not exist");
        }
        for kind in [
            CommandType::App,
            CommandType::Url,
            CommandType::Folder,
            CommandType::File,
            CommandType::Command,
        ] {
            assert!(crate::gfx::lucide::exists(default_glyph(kind)), "{:?}", kind);
        }
    }

    #[test]
    fn a_new_item_is_asked_for_a_picture_only_when_one_can_exist() {
        // A command line has no icon to extract: asking would queue a worker for every one of them
        // on every launch, and the answer would never change.
        assert_eq!(
            new_item("x".into(), "git status".into(), CommandType::Command).icon_source,
            Some(IconSource::Lucide)
        );
        assert_eq!(
            new_item("x".into(), "C:/a.exe".into(), CommandType::App).icon_source,
            Some(IconSource::Native)
        );
    }

    #[test]
    fn ticked_applications_arrive_in_the_order_the_list_showed_them() {
        let installed = vec![
            Installed { id: "a".into(), label: "Alpha".into(), command: "alpha.exe".into() },
            Installed { id: "b".into(), label: "Beta".into(), command: "beta.exe".into() },
            Installed { id: "c".into(), label: "Gamma".into(), command: "gamma.exe".into() },
        ];
        // Ticked last-to-first; they come back first-to-last, because the list is what was read.
        let picked = selected_items(&installed, &["gamma.exe".into(), "alpha.exe".into()]);
        assert_eq!(
            picked.iter().map(|i| i.label.as_str()).collect::<Vec<_>>(),
            vec!["Alpha", "Gamma"]
        );
        // The application's own id, not a fresh one: that is what lets an already-extracted
        // picture be reused instead of queued again.
        assert_eq!(picked[0].id, "a");
        assert_eq!(picked[1].id, "c");
        assert!(picked.iter().all(|i| i.command_type == Some(CommandType::App)));

        assert!(selected_items(&installed, &[]).is_empty());
        // A command that is no longer in the list — the search changed under the selection —
        // is simply not there to add.
        assert!(selected_items(&installed, &["gone.exe".into()]).is_empty());
    }

    #[test]
    fn a_drop_becomes_shortcuts_with_ids_of_their_own() {
        use crate::sys::dropped::Payload;

        let mut items: Vec<AppItem> = Vec::new();
        let added = import_dropped(
            &Payload {
                text: "https://example.com
npm run dev".into(),
                ..Payload::default()
            },
            &mut items,
        );
        assert_eq!(added, 2);
        assert_eq!(items[0].command_type, Some(CommandType::Url));
        assert_eq!(items[0].label, "example.com");
        assert_eq!(items[1].command_type, Some(CommandType::Command));
        assert_eq!(items[1].label, "npm");

        // `new_item` names an id from the clock and a multi-file drop runs inside one
        // millisecond. Shared ids would make the list edit, expand and delete them together.
        assert_ne!(items[0].id, items[1].id);
    }

    #[test]
    fn a_drop_of_nothing_adds_nothing() {
        let mut items: Vec<AppItem> = vec![new_item("keep".into(), "x".into(), CommandType::App)];
        let added = import_dropped(&crate::sys::dropped::Payload::default(), &mut items);
        assert_eq!(added, 0);
        assert_eq!(items.len(), 1);
    }

    #[test]
    fn an_editor_arrives_with_its_recents_submenu_already_on() {
        // The whole reason the IDE block is reachable at all: nothing else ever writes
        // `has_recents`, so an editor added without this is an editor whose recents can only be
        // turned on by somebody who already knows the switch is there.
        let code = new_item(
            "Visual Studio Code".into(),
            "Microsoft.VisualStudioCode".into(),
            CommandType::App,
        );
        assert_eq!(code.has_recents, Some(true));
        assert_eq!(code.terminal_commands, Some(Vec::new()));

        // And nothing else does. A card offering "recent projects" on Spotify describes the
        // feature by where it is absent.
        let other = new_item("Spotify".into(), "Spotify.exe".into(), CommandType::App);
        assert_eq!(other.has_recents, None);
        assert_eq!(other.terminal_commands, None);

        // A website named after an editor is still a website: `looks_like_an_ide` is given the
        // kind for exactly this case, and passing it is what keeps cursor.com off the list.
        let site = new_item("Cursor".into(), "https://cursor.com".into(), CommandType::Url);
        assert_eq!(site.has_recents, None);
    }

    #[test]
    fn taking_a_key_leaves_the_loser_deliberately_empty() {
        // Not `None`: absent means "follow my position", and the position may be the very key that
        // was just taken away — which would hand it straight back.
        let mut config = crate::config::defaults::ui_config();
        while config.workspaces.len() < 3 {
            config.workspaces.push(config::Workspace::default());
        }
        config.workspaces[1].hotkey_key = Some("M".into());
        take_key_from_others(&mut config, 2, "M");
        assert_eq!(config.workspaces[1].hotkey_key.as_deref(), Some(""));
        assert_eq!(config.workspaces[2].hotkey_key, None);
    }

    #[test]
    fn the_summary_says_the_kind_and_the_shortest_honest_target() {
        let mut item = AppItem {
            label: "VS Code".into(),
            command: r"C:\Program Files\Microsoft VS Code\Code.exe".into(),
            command_type: Some(CommandType::App),
            ..AppItem::default()
        };
        assert_eq!(target_summary(&item), "App \u{00b7} Code.exe");
        // A quoted launch line: the quotes belong to the shell, not to the reader.
        item.command = "\"C:\\Program Files\\Steam\\Steam.exe\"".into();
        assert_eq!(target_summary(&item), "App \u{00b7} Steam.exe");
        item.command_type = Some(CommandType::Url);
        item.command = "https://example.com/a/b".into();
        // A URL is read from the FRONT: its leaf is the least informative part of it.
        assert_eq!(target_summary(&item), "Web \u{00b7} https://example.com/a/b");
    }
}
