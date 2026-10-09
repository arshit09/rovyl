//! The controls the settings panel is built from.
//!
//! Each one is a function that draws itself and returns what the user did. They are written against
//! the original's design tokens, and where a value looks arbitrary the comment says what it is
//! answering — most of them are answering "what does this look like over an unknown background",
//! "what keeps the row from moving when a control changes", or "what does the eye read as the
//! signal".
//!
//! Two rules carried over from the original's CSS, because they are easy to undo by accident:
//!
//! - **Opacity is not the de-emphasis channel** for anything with its own background. A disabled
//!   switch dims its TRACK and keeps its knob opaque, because the one thing that still has to read
//!   is whether it is on.
//! - **A row's hover band is the row, not the control.** Pointing at a setting marks the setting:
//!   the whole row is what the press is about, and lighting only the switch makes the sentence
//!   beside it look inert.

use super::{Cursor, Frame, Menu};
use crate::gfx::painter::Rect;
use crate::gfx::palette as pal;
use crate::gfx::text::{Align, Family, Style};
use crate::wheel::anim;
use windows::Win32::Graphics::Direct2D::Common::D2D1_COLOR_F;

// ─── Type ───────────────────────────────────────────────────────────────────

/// A page's name: 21px, 600. The largest type the panel has, and one per page.
pub fn page_title_style(scale: f32, rtl: bool) -> Style {
    Style::new(Family::Ui, 21.0 * scale, 600, Align::Leading).tracking(-0.022).rtl(rtl)
}

/// The sentence under a page's name: 12.5px, 400.
pub fn page_caption_style(scale: f32, rtl: bool) -> Style {
    Style::new(Family::Ui, 12.5 * scale, 400, Align::Leading).rtl(rtl)
}

/// The sidebar's own heading: 15.5px, 600.
pub fn sidebar_title_style(scale: f32, rtl: bool) -> Style {
    Style::new(Family::Ui, 15.5 * scale, 600, Align::Leading).tracking(-0.015).rtl(rtl)
}

/// A navigation label and the text inside a field: 12.5px, 450.
pub fn nav_style(scale: f32, rtl: bool) -> Style {
    Style::new(Family::Ui, 12.5 * scale, 450, Align::Leading).rtl(rtl)
}

/// The same size, carrying a name rather than a label: 12.5px, 500.
pub fn name_style(scale: f32, rtl: bool) -> Style {
    Style::new(Family::Ui, 12.5 * scale, 500, Align::Leading).rtl(rtl)
}

/// A note under a picture: 10.5px, 400 — the smallest the panel sets.
pub fn caption_style(scale: f32, rtl: bool) -> Style {
    Style::new(Family::Ui, 10.5 * scale, 400, Align::Leading).rtl(rtl)
}

/// The number on a chip: 10px, 500.
pub fn chip_style(scale: f32, rtl: bool) -> Style {
    Style::new(Family::Ui, 10.0 * scale, 500, Align::Leading).rtl(rtl)
}

/// A row's title: 13px, 500. The one line that has to be scannable down the column.
pub fn title_style(scale: f32, rtl: bool) -> Style {
    Style::new(Family::Ui, 13.0 * scale, 500, Align::Leading).tracking(-0.008).rtl(rtl)
}

/// A row's description: 11.5px, 400, one step down in contrast.
pub fn body_style(scale: f32, rtl: bool) -> Style {
    Style::new(Family::Ui, 11.5 * scale, 400, Align::Leading).rtl(rtl)
}

/// A group heading: set apart from the description by WEIGHT, not by caps or tracking.
pub fn group_style(scale: f32, rtl: bool) -> Style {
    Style::new(Family::Ui, 12.0 * scale, 600, Align::Leading).tracking(-0.005).rtl(rtl)
}

/// Control type: 11.5px, 450 — and 500 for the part that carries the value.
pub fn control_style(scale: f32, rtl: bool) -> Style {
    Style::new(Family::Ui, 11.5 * scale, 450, Align::Leading).rtl(rtl)
}

pub fn value_style(scale: f32, rtl: bool) -> Style {
    Style::new(Family::Ui, 11.5 * scale, 500, Align::Leading).rtl(rtl)
}

pub fn small_style(scale: f32, rtl: bool) -> Style {
    Style::new(Family::Ui, 11.0 * scale, 450, Align::Leading).rtl(rtl)
}

/// What a colour becomes when its control is switched off.
///
/// One function, so "disabled" is the same step everywhere. Dimming the colour the control would
/// have had — rather than substituting a grey — keeps a disabled danger button recognisably the
/// danger button, which is what tells the user it is the same control they saw a moment ago.
pub fn dimmed(colour: D2D1_COLOR_F, enabled: bool) -> D2D1_COLOR_F {
    if enabled {
        colour
    } else {
        alpha(colour, colour.a * pal::DISABLED_DIM)
    }
}

// ─── Rows ───────────────────────────────────────────────────────────────────

/// A setting row: a title, an optional description, and room on the right for a control.
///
/// Returns the rectangle the control goes in. The row's own height comes from the text, so a
/// two-line description makes the row taller rather than clipping.
pub struct Row {
    pub bounds: Rect,
    /// Where the control goes — right-aligned, vertically centred.
    pub control: Rect,
    /// The full-width band under the sentence, for a control that cannot live in the right-hand
    /// column. Empty unless the row was asked for one.
    pub under: Rect,
    pub hovered: bool,
}

pub fn row(f: &mut Frame, title: &str, description: &str, control_width: f32) -> Row {
    row_indented(f, title, description, control_width, 0.0)
}

/// A row with a second line beneath it, the full width of the content column.
///
/// A slider is the only control here that wants one. Squeezed into the right-hand column it is
/// 150px of travel for a range of 200 values, which is a control nobody can land a number on; the
/// original gives it the whole width and puts only the readout in the column.
pub fn row_under(f: &mut Frame, title: &str, description: &str, control_width: f32, under_h: f32) -> Row {
    row_full(f, title, description, control_width, 0.0, under_h)
}

/// A row whose text starts further in, to leave room for a leading glyph.
///
/// `indent` is in DIPs and is measured from the row's own padding, so a row with a glyph and a row
/// without still have their text at the same distance from whatever precedes it.
pub fn row_indented(
    f: &mut Frame,
    title: &str,
    description: &str,
    control_width: f32,
    indent: f32,
) -> Row {
    row_full(f, title, description, control_width, indent, 0.0)
}

fn row_full(
    f: &mut Frame,
    title: &str,
    description: &str,
    control_width: f32,
    indent: f32,
    under_h: f32,
) -> Row {
    if !f.matches(title, description) {
        return Row {
            bounds: f.nowhere(),
            control: f.nowhere(),
            under: f.nowhere(),
            hovered: false,
        };
    }
    // The first row of a group to get this far is what makes the heading real.
    //
    // It brings its own air with it. On a normal page the space above a group comes from the
    // `gap` calls between sections, and those are suppressed while filtering — without this the
    // results come out as one unbroken column with headings wedged between the rows.
    if let Some(pending) = f.take_group() {
        if f.y > f.bounds.top {
            f.y += f.px(pal::SPACE[6]);
        }
        draw_group(f, &pending);
    }

    let pad_y = f.px(12.0);
    // The row's 12px of horizontal padding is handed straight back as a negative margin, so the
    // sentence lines up with the page's heading and the hover band is the only thing that reaches
    // past it. Inset text instead, and every row sits 12px right of the title above it.
    let pad_x = f.px(12.0);
    let gap = f.px(24.0);
    let control_w = f.px(control_width);
    let indent = f.px(indent);

    let text_width = (f.bounds.width() - indent - control_w - gap).max(f.px(80.0));
    let (_, title_h) = f.p.measure(title, &title_style(f.scale, f.rtl));
    let desc_h = if description.is_empty() {
        0.0
    } else {
        wrapped_height(f, description, text_width)
    };
    let text_h = title_h + if desc_h > 0.0 { f.px(3.0) + desc_h } else { 0.0 };
    // The head is the sentence and the control beside it, padded above and below. A second line
    // is `pad_y` again below the sentence, then its own height, then the row's own bottom pad —
    // which makes the gap between the two lines the same 12px as the air around them.
    let head = (text_h + pad_y * 2.0).max(f.px(48.0));
    let under_h = f.px(under_h);
    let height = head + if under_h > 0.0 { under_h + pad_y } else { 0.0 };

    // The band, outdented; the content, on the column.
    let bounds = Rect::new(f.bounds.left - pad_x, f.y, f.bounds.right + pad_x, f.y + height);
    f.y += height;

    let hovered = f.hovered(bounds);
    if hovered {
        f.p.fill_round_rect(bounds, f.px(pal::R_CONTROL), f.theme.hover);
    }

    // Mirrored for a right-to-left language: the sentence on the right, the control on the left.
    // DirectWrite already shapes and orders the run correctly either way -- what has to move is
    // the furniture, because nothing in a layout knows which way a language reads.
    let text_left = if f.rtl {
        f.bounds.right - indent - text_width
    } else {
        f.bounds.left + indent
    };

    // Centred in the HEAD, not in the whole row: with a second line below, centring in the row
    // would push the sentence down into the gap and leave the top pad twice as deep as the rest.
    let text_top = bounds.top + (head - text_h) / 2.0;
    f.p.text(
        title,
        Rect::new(text_left, text_top, text_left + text_width, bounds.bottom),
        &title_style(f.scale, f.rtl),
        f.theme.text,
    );
    if !description.is_empty() {
        draw_wrapped(
            f,
            description,
            Rect::new(
                text_left,
                text_top + title_h + f.px(3.0),
                text_left + text_width,
                bounds.bottom,
            ),
            f.theme.text_2,
        );
    }

    let control_left = if f.rtl {
        f.bounds.left
    } else {
        f.bounds.right - control_w
    };
    let control = Rect::new(
        control_left,
        bounds.top + (head - f.px(pal::CONTROL_H)) / 2.0,
        control_left + control_w,
        bounds.top + (head + f.px(pal::CONTROL_H)) / 2.0,
    );
    let under = if under_h > 0.0 {
        Rect::new(f.bounds.left, bounds.top + head, f.bounds.right, bounds.top + head + under_h)
    } else {
        f.nowhere()
    };
    Row {
        bounds,
        control,
        under,
        hovered,
    }
}

/// A group heading, with the single rule under it.
///
/// One rule per group and none between the rows: a divider under every row turned a five-setting
/// group into six horizontal lines and the page into a ruled pad. The group's title and the space
/// around it already say where it begins and ends; the rows are separated by proximity, not ink.
pub fn group(f: &mut Frame, title: &str) {
    // On the results page the heading waits: a group whose every row was filtered out would
    // otherwise be a title with a rule under it and nothing between them.
    if f.filtering() {
        f.defer_group(title);
        return;
    }
    draw_group(f, title);
}

fn draw_group(f: &mut Frame, title: &str) {
    if !title.is_empty() {
        let (_, h) = f.p.measure(title, &group_style(f.scale, f.rtl));
        let rect = Rect::new(f.bounds.left, f.y, f.bounds.right, f.y + h);
        f.p.text(title, rect, &group_style(f.scale, f.rtl), f.theme.text_2);
        f.y += h + f.px(8.0);
    }
    f.p.fill_rect(
        Rect::new(f.bounds.left, f.y, f.bounds.right, f.y + f.px(1.0)),
        f.theme.line,
    );
    f.y += f.px(1.0);
}

// ─── Switch ─────────────────────────────────────────────────────────────────

/// The on/off control. 36x20, a 14px knob, and the theme's solid pair when on.
///
/// The knob TRAVELS and the colours CROSS, on the two clocks in `anim`, rather than both cutting on
/// the frame of the press. A toggle is the one control whose whole job is to show a state changing,
/// and a cut shows the two states without ever showing the change: the eye is told the answer but
/// never sees which thing answered, so a mis-aimed press on a column of nineteen switches reads as
/// the panel flickering rather than as this row having flipped.
///
/// Nothing above has to know. The call site still passes a bool and still gets a bool back; where
/// the drawing has got to lives on the context, keyed by the same `id` that already identifies the
/// control for hover and capture.
pub fn switch(f: &mut Frame, id: &str, at: Rect, on: bool, enabled: bool) -> bool {
    let w = f.px(36.0);
    let h = f.px(20.0);
    let rect = Rect::new(at.right - w, at.center().1 - h / 2.0, at.right, at.center().1 + h / 2.0);
    let hovered = enabled && f.hovered(rect);
    let clicked = enabled && f.clicked(id, rect);
    if hovered {
        f.set_cursor(Cursor::Hand);
    }

    // `on` is the state the configuration holds THIS frame, and on the frame of a press that is
    // still the OLD one: the call site flips the value from the `true` this function is about to
    // return. So the travel begins one frame later, and that frame has to be asked for — a click
    // that arrives with the pointer perfectly still puts nothing in the message queue, and without
    // this the panel would sit on the state the user just left until the hand moved again.
    let phase = f.ui.toggle(id, on);
    if clicked || phase.animating {
        f.want_frame();
    }

    // Disabled WITHOUT a global opacity: that dims the track and the knob by the same amount and
    // takes with it the one thing that still has to read — whether it is on.
    //
    // Both ends are evaluated every frame and mixed, rather than one end being selected. That is
    // what lets hover stay instant — as it is on every other control in the panel — while the
    // travel runs: pointing at a switch mid-flight changes which two colours it is crossing
    // between, not where it has got to.
    let theme = f.theme;
    let ends = |on: bool| match (on, enabled, hovered) {
        (true, true, false) => (theme.solid, theme.solid, theme.on_solid),
        (true, true, true) => (
            mix(theme.solid, theme.surface, 0.86),
            mix(theme.solid, theme.surface, 0.86),
            theme.on_solid,
        ),
        (true, false, _) => (
            alpha(theme.solid, 0.5),
            alpha(theme.solid, 0.5),
            mix(theme.on_solid, theme.surface, 0.55),
        ),
        (false, true, false) => (theme.raised, theme.line_strong, theme.text_3),
        (false, true, true) => (theme.pressed, theme.text_3, theme.text_2),
        (false, false, _) => (theme.hover, theme.line, alpha(theme.text_3, 0.85)),
    };
    let (off_track, off_edge, off_knob) = ends(false);
    let (on_track, on_edge, on_knob) = ends(true);
    let track = mix(on_track, off_track, phase.tint);
    let edge = mix(on_edge, off_edge, phase.tint);
    let knob = mix(on_knob, off_knob, phase.tint);

    f.p.fill_round_rect(rect, h / 2.0, track);
    f.p.stroke_round_rect(rect.inflate(-0.5), h / 2.0, edge, 1.0);

    // The knob travels 16px of a 36px track — 3px of inset on each side plus its own 14px.
    //
    // Three and not two. The original's knob is inset 2px from INSIDE a 1px border, and the border
    // is drawn within the 36×20 box, so the gap from the outer edge is 3 on every side — the same
    // above and below the knob as beside it. At 2 the circle reads as crowded against the end it
    // is resting on, which is the one thing about this control anybody notices.
    let inset = f.px(3.0);
    let knob_d = f.px(14.0);
    let travel = w - inset * 2.0 - knob_d;

    // Held down, the knob stretches into a capsule along the track rather than scaling — the end
    // it is resting against stays put and the other end reaches towards where it is going. It is
    // the press feedback the original has and the only part of this control that was missing.
    let held = enabled && f.ui.is_active(id);
    let knob_w = if held { f.px(17.0) } else { knob_d };
    // No frame is asked for on account of the squish: the press and the release each arrive as a
    // message and each draws, and between them nothing about the knob changes. Asking here would
    // spin the loop for as long as a finger stays down.
    let reach = travel - (knob_w - knob_d);
    let x = rect.left + inset + reach * phase.knob;
    f.p.fill_round_rect(
        Rect::new(
            x,
            rect.center().1 - knob_d / 2.0,
            x + knob_w,
            rect.center().1 + knob_d / 2.0,
        ),
        knob_d / 2.0,
        knob,
    );
    clicked
}

// ─── Segmented ──────────────────────────────────────────────────────────────

/// A small set of mutually exclusive choices, shown all at once.
///
/// Used where there are two or three and their labels are short. Past that it becomes a select:
/// seven 62px-minimum buttons is ~460px of row, wider than the control column, and it would wrap
/// into a block of chips no eye can scan.
/// How wide a segmented control will be, before one is drawn.
///
/// `segmented` hugs the RIGHT of the space it is given, which is what a settings row wants: the
/// control lines up with every other control down the column. A field with its label above it
/// wants the opposite, and this is how it asks — measure, then hand over a rectangle that ends
/// where the control should.
pub fn segmented_width(f: &Frame, options: &[(&str, &str)]) -> f32 {
    if options.is_empty() {
        return 0.0;
    }
    let pad = f.px(2.0);
    let min_w = f.px(62.0);
    let text_pad = f.px(12.0);
    let total: f32 = options
        .iter()
        .map(|(_, label)| (f.p.measure(label, &small_style(f.scale, f.rtl)).0 + text_pad * 2.0).max(min_w))
        .sum();
    total + pad * 2.0 + pad * (options.len() - 1) as f32
}

pub fn segmented(
    f: &mut Frame,
    id: &str,
    at: Rect,
    options: &[(&str, &str)],
    current: &str,
    enabled: bool,
) -> Option<String> {
    if options.is_empty() {
        return None;
    }
    let pad = f.px(2.0);
    let h = f.px(30.0);
    let button_h = f.px(26.0);
    let min_w = f.px(62.0);
    let text_pad = f.px(12.0);

    let widths: Vec<f32> = options
        .iter()
        .map(|(_, label)| (f.p.measure(label, &small_style(f.scale, f.rtl)).0 + text_pad * 2.0).max(min_w))
        .collect();
    let total: f32 = widths.iter().sum::<f32>() + pad * 2.0 + pad * (options.len() - 1) as f32;

    let rect = Rect::new(
        at.right - total,
        at.center().1 - h / 2.0,
        at.right,
        at.center().1 + h / 2.0,
    );
    f.p.fill_round_rect(rect, f.px(pal::R_CONTROL), f.theme.sunken);
    f.p.stroke_round_rect(rect.inflate(-0.5), f.px(pal::R_CONTROL), f.theme.line, 1.0);

    let mut chosen = None;
    let mut x = rect.left + pad;
    for ((value, label), width) in options.iter().zip(&widths) {
        let button = Rect::new(x, rect.center().1 - button_h / 2.0, x + width, rect.center().1 + button_h / 2.0);
        let selected = *value == current;
        let hovered = enabled && f.hovered(button);
        if hovered {
            f.set_cursor(Cursor::Hand);
        }
        if enabled && f.clicked(&format!("{id}:{value}"), button) && !selected {
            chosen = Some((*value).to_string());
        }

        // The chosen one is already at the top of the hierarchy; the mouse only firms it one step.
        let fill = match (selected, hovered) {
            (true, false) => f.theme.raised,
            (true, true) => f.theme.pressed,
            (false, true) => f.theme.hover,
            (false, false) => pal::TRANSPARENT,
        };
        if fill.a > 0.0 {
            f.p.fill_round_rect(button, f.px(pal::R_CHIP), fill);
        }
        if selected {
            f.p.stroke_round_rect(
                button.inflate(-0.5),
                f.px(pal::R_CHIP),
                if hovered { f.theme.line_strong } else { f.theme.line },
                1.0,
            );
        }
        let colour = if !enabled {
            f.theme.text_3
        } else if selected || hovered {
            f.theme.text
        } else {
            f.theme.text_2
        };
        let (_, th) = f.p.measure(label, &small_style(f.scale, f.rtl));
        f.p.text(
            label,
            Rect::new(button.left, button.center().1 - th / 2.0, button.right, button.bottom),
            &Style::new(Family::Ui, 11.0 * f.scale, 450, Align::Center),
            colour,
        );
        x += width + pad;
    }
    chosen
}

// ─── Buttons ────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ButtonKind {
    Normal,
    Primary,
    Quiet,
    Danger,
}

pub fn button(
    f: &mut Frame,
    id: &str,
    at: Rect,
    label: &str,
    kind: ButtonKind,
    enabled: bool,
) -> bool {
    let pad = f.px(14.0);
    let w = f.p.measure(label, &control_style(f.scale, f.rtl)).0 + pad * 2.0;
    let h = f.px(pal::CONTROL_H);
    let rect = Rect::new(at.right - w, at.center().1 - h / 2.0, at.right, at.center().1 + h / 2.0);
    button_at(f, id, rect, label, kind, enabled)
}

pub fn button_at(
    f: &mut Frame,
    id: &str,
    rect: Rect,
    label: &str,
    kind: ButtonKind,
    enabled: bool,
) -> bool {
    let hovered = enabled && f.hovered(rect);
    let held = f.ui.is_active(id);
    let clicked = enabled && f.clicked(id, rect);
    if hovered {
        f.set_cursor(Cursor::Hand);
    }

    // Red only on the button that does it. A red ROW would read as an error, and nothing has gone
    // wrong yet — the user is being asked to confirm, not told about a failure.
    let danger = pal::DANGER;
    let (fill, border, text) = match kind {
        ButtonKind::Primary => (f.theme.solid, f.theme.solid, f.theme.on_solid),
        ButtonKind::Danger => (
            alpha(danger, if hovered { 0.16 } else { 0.09 }),
            alpha(danger, if hovered { 0.7 } else { 0.45 }),
            if hovered { pal::DANGER_HOVER } else { danger },
        ),
        ButtonKind::Quiet => (
            if hovered { f.theme.hover } else { pal::TRANSPARENT },
            if hovered { f.theme.line } else { pal::TRANSPARENT },
            if hovered { f.theme.text } else { f.theme.text_2 },
        ),
        ButtonKind::Normal => (
            if held {
                f.theme.pressed
            } else if hovered {
                f.theme.hover
            } else {
                pal::TRANSPARENT
            },
            if hovered { f.theme.line_strong } else { f.theme.line },
            f.theme.text,
        ),
    };
    let dim = if enabled { 1.0 } else { pal::DISABLED_DIM };
    if fill.a > 0.0 {
        f.p.fill_round_rect(rect, f.px(pal::R_CONTROL), alpha(fill, fill.a * dim));
    }
    if border.a > 0.0 {
        f.p.stroke_round_rect(
            rect.inflate(-0.5),
            f.px(pal::R_CONTROL),
            alpha(border, border.a * dim),
            1.0,
        );
    }
    let (_, th) = f.p.measure(label, &control_style(f.scale, f.rtl));
    f.p.text(
        label,
        Rect::new(rect.left, rect.center().1 - th / 2.0, rect.right, rect.bottom),
        &Style::new(Family::Ui, 11.5 * f.scale, if kind == ButtonKind::Primary { 550 } else { 450 }, Align::Center),
        alpha(text, text.a * dim),
    );
    clicked
}

// ─── Slider ─────────────────────────────────────────────────────────────────

/// How tall the band under a slider row has to be. The rail's own height plus the line box of the
/// numbers either side of it, which are what make it taller than the rail.
pub const SLIDER_UNDER_H: f32 = 16.5;

/// A setting that is a value on a range: the sentence, its reading in the right-hand column, and
/// the rail across the full width underneath.
///
/// The rail is on its own line rather than in the control column, which is where every other
/// control sits. A 150px track carrying 200 values gives each one less than a pixel, so the number
/// cannot be landed on and the drag becomes a negotiation; across the content column the same
/// range gets four times the travel. It is also what lets the end points be labelled, which is the
/// difference between "about three quarters" and "160 px".
///
/// `unit` turns the reading into a field that can be typed into — the slider for a percentage is
/// the one place somebody wants to say the number rather than find it. `ticks` marks every step,
/// which only reads when the steps are few: at one tick per unit it is a grey bar.
#[allow(clippy::too_many_arguments)]
pub fn slider_row(
    f: &mut Frame,
    id: &str,
    title: &str,
    description: &str,
    value: f32,
    min: f32,
    max: f32,
    step: f32,
    ticks: bool,
    unit: Option<&str>,
    format: &dyn Fn(f32) -> String,
    enabled: bool,
) -> Option<f32> {
    // Drawn whether or not the search has filtered it out, as every other control here is: a
    // filtered row is handed a rectangle off the side of the world and paints into it.
    let r = row_under(f, title, description, 58.0, SLIDER_UNDER_H);

    // The field first, so that a number being typed into it wins the keyboard before the rail
    // below reads the same frame's input.
    let typed = match unit {
        Some(unit) => value_field(f, &format!("{id}-value"), r.control, value, min, max, unit, enabled),
        None => {
            readout(f, r.control, &format(value), enabled);
            None
        }
    };
    let dragged = slider_rail(f, id, r.under, value, min, max, step, ticks, format, enabled);
    // A drag beats a field that was committed on the same frame: the drag is this frame's gesture
    // and the commit is the end of the last one.
    dragged.or(typed)
}

/// Where a pointer anywhere along the rail puts the value.
///
/// Snapped to the step, so a slider that reads in whole pixels cannot store a fraction of one and
/// come back reading differently — and so a volume that steps by ten is only ever a multiple of
/// ten, which is the whole point of giving it ten steps instead of a hundred.
///
/// Snapping happens from `min`, not from zero: a range that starts at 20 and steps by 50 has its
/// rest positions at 20, 70, 120 — not at 0, 50, 100, two of which it cannot even reach.
fn snap(raw: f32, min: f32, max: f32, step: f32) -> f32 {
    if step <= 0.0 {
        return raw.clamp(min, max);
    }
    (min + ((raw - min) / step).round() * step).clamp(min, max)
}

/// The rail: the end points, the track between them, and the thumb on it.
#[allow(clippy::too_many_arguments)]
pub fn slider_rail(
    f: &mut Frame,
    id: &str,
    at: Rect,
    value: f32,
    min: f32,
    max: f32,
    step: f32,
    ticks: bool,
    format: &dyn Fn(f32) -> String,
    enabled: bool,
) -> Option<f32> {
    let dim = if enabled { 1.0 } else { pal::DISABLED_DIM };
    let bounds_style = Style::new(Family::Ui, 11.0 * f.scale, 400, Align::Leading).rtl(f.rtl).tabular();
    let low = format(min);
    let high = format(max);
    let (low_w, low_h) = f.p.measure(&low, &bounds_style);
    let (high_w, high_h) = f.p.measure(&high, &bounds_style);
    let mid = at.center().1;
    let gap = f.px(12.0);

    // The low number sits at the low end of the rail, which in Arabic is the right-hand one: the
    // rail is a number line and it runs the way the language reads.
    let (low_at, high_at, rail) = if f.rtl {
        (
            Rect::new(at.right - low_w, mid - low_h / 2.0, at.right, at.bottom),
            Rect::new(at.left, mid - high_h / 2.0, at.left + high_w, at.bottom),
            Rect::new(at.left + high_w + gap, at.top, at.right - low_w - gap, at.bottom),
        )
    } else {
        (
            Rect::new(at.left, mid - low_h / 2.0, at.left + low_w, at.bottom),
            Rect::new(at.right - high_w, mid - high_h / 2.0, at.right, at.bottom),
            Rect::new(at.left + low_w + gap, at.top, at.right - high_w - gap, at.bottom),
        )
    };
    f.p.text(&low, low_at, &bounds_style, alpha(f.theme.text_3, f.theme.text_3.a * dim));
    f.p.text(&high, high_at, &bounds_style, alpha(f.theme.text_3, f.theme.text_3.a * dim));

    let knob_r = f.px(6.5);
    // The thumb's CENTRE travels between these, not its edge: a thumb that reached the end of the
    // rail would be half off it at both ends.
    let travel_left = rail.left + knob_r;
    let travel_right = rail.right - knob_r;
    if travel_right <= travel_left {
        return None;
    }

    // The grab area is the whole band, not the 4px track: a 4px target is one nobody hits.
    let hovered = enabled && f.hovered(rail);
    if hovered {
        f.set_cursor(Cursor::Hand);
    }
    if enabled && hovered && f.input.pressed {
        f.ui.set_active(id);
    }
    let dragging = f.ui.is_active(id);
    if dragging && f.input.released {
        f.ui.clear_active();
    }

    let span = (max - min).max(1e-6);
    let mut result = None;
    if dragging {
        let along = if f.rtl {
            (travel_right - f.input.pointer.0) / (travel_right - travel_left)
        } else {
            (f.input.pointer.0 - travel_left) / (travel_right - travel_left)
        };
        let raw = min + along.clamp(0.0, 1.0) * span;
        let snapped = snap(raw, min, max, step);
        if (snapped - value).abs() > 1e-4 {
            result = Some(snapped);
        }
        f.want_frame();
    }

    let track_h = f.px(4.0);
    let track = Rect::new(rail.left, mid - track_h / 2.0, rail.right, mid + track_h / 2.0);
    f.p.fill_round_rect(track, track_h / 2.0, alpha(f.theme.raised, f.theme.raised.a * dim));

    // One dot per step, on the positions the thumb can come to rest at. The ends are left out:
    // there is already a number under each of them, and a dot the thumb is sitting on top of at
    // rest reads as a smudge.
    if ticks && step > 0.0 {
        let count = ((max - min) / step).round() as i32;
        if count > 1 && count <= 40 {
            let dot = f.px(6.0);
            for i in 1..count {
                let along = i as f32 / count as f32;
                let x = if f.rtl {
                    travel_right - (travel_right - travel_left) * along
                } else {
                    travel_left + (travel_right - travel_left) * along
                };
                f.p.fill_circle(
                    (x, mid),
                    dot / 2.0,
                    alpha(f.theme.line_strong, f.theme.line_strong.a * dim),
                );
            }
        }
    }

    let along = ((value - min) / span).clamp(0.0, 1.0);
    let x = if f.rtl {
        travel_right - (travel_right - travel_left) * along
    } else {
        travel_left + (travel_right - travel_left) * along
    };
    // Pressed it shrinks, hovered it grows — the same two steps the original takes, and the only
    // thing on the rail that answers the pointer.
    let scale = if dragging { 0.94 } else if hovered { 1.12 } else { 1.0 };
    f.p.fill_circle((x, mid), knob_r * scale, alpha(f.theme.solid, dim));
    // A hairline around it. Against the track it is almost nothing; against the white thumb on a
    // light theme it is what stops the thumb dissolving into the surface behind it.
    f.p.stroke_circle(
        (x, mid),
        knob_r * scale + 0.5,
        alpha(f.theme.line_strong, f.theme.line_strong.a * dim),
        1.0,
    );
    result
}

/// A slider's reading, where it is only read.
pub fn readout(f: &mut Frame, at: Rect, text: &str, enabled: bool) {
    let dim = if enabled { 1.0 } else { pal::DISABLED_DIM };
    let style = Style::new(Family::Display, 12.5 * f.scale, 500, Align::Trailing).rtl(f.rtl).tabular();
    let (_, th) = f.p.measure(text, &style);
    f.p.text(
        text,
        Rect::new(at.left, at.center().1 - th / 2.0, at.right, at.bottom),
        &style,
        alpha(f.theme.text, dim),
    );
}

/// A slider's reading, where it can also be typed.
///
/// The unit is part of the reading at rest and a label beside the box while it is being edited:
/// "100%" is what the setting says, and "%" is a thing being told to somebody who is halfway
/// through typing "7".
#[allow(clippy::too_many_arguments)]
pub fn value_field(
    f: &mut Frame,
    id: &str,
    at: Rect,
    value: f32,
    min: f32,
    max: f32,
    unit: &str,
    enabled: bool,
) -> Option<f32> {
    let style = Style::new(Family::Display, 12.5 * f.scale, 500, Align::Trailing).rtl(f.rtl).tabular();
    let h = f.px(24.0);
    let editing = f.ui.is_focused(id);
    let (unit_w, _) = f.p.measure(unit, &style);
    // The box gives up the unit's width while the unit is beside it, so the pair stays inside the
    // same 58px column and the rail below does not move when the field is clicked into.
    let box_right = if editing { at.right - unit_w - f.px(3.0) } else { at.right };
    let rect = Rect::new(at.left, at.center().1 - h / 2.0, box_right, at.center().1 + h / 2.0);

    let hovered = enabled && f.hovered(rect);
    if hovered {
        f.set_cursor(Cursor::Text);
    }

    let mut committed: Option<f32> = None;
    let finish = |text: Option<String>| -> Option<f32> {
        let text = text?;
        let digits: String = text.chars().filter(|c| c.is_ascii_digit()).collect();
        let parsed: f32 = digits.parse().ok()?;
        Some(parsed.round().clamp(min, max))
    };

    if f.input.pressed {
        if hovered {
            if !editing {
                f.ui.begin_edit(id, &format!("{}", value.round()));
            }
        } else if editing {
            // Clicking away commits, as it does in every other field here.
            let text = f.ui.end_edit();
            f.ui.blur();
            committed = finish(text);
        }
    }

    if f.ui.is_focused(id) {
        let typed = f.input.typed.clone();
        let back = f.input.key_pressed(0x08);
        let enter = f.input.key_pressed(0x0D);
        let escape = f.input.key_pressed(0x1B);
        if let Some((text, caret)) = f.ui.edit_mut(id) {
            // Digits only, and never more than the longest number this range can hold: a field
            // that accepts "1000%" has to then explain itself.
            let room = format!("{}", max.round()).len();
            for ch in typed.chars().filter(|c| c.is_ascii_digit()) {
                if text.len() >= room {
                    break;
                }
                let at = byte_at(text, *caret);
                text.insert(at, ch);
                *caret += 1;
            }
            if back && *caret > 0 {
                let at = byte_at(text, *caret - 1);
                text.remove(at);
                *caret -= 1;
            }
        }
        if enter {
            let text = f.ui.end_edit();
            f.ui.blur();
            committed = finish(text);
        } else if escape {
            f.ui.end_edit();
            f.ui.blur();
        }
    }

    let editing = f.ui.is_focused(id);
    let shown = f
        .ui
        .editing(id)
        .map(|(text, _)| text.to_string())
        .unwrap_or_else(|| format!("{}{unit}", value.round()));

    let dim = if enabled { 1.0 } else { pal::DISABLED_DIM };
    f.p.fill_round_rect(rect, f.px(pal::R_CHIP), f.theme.sunken);
    f.p.stroke_round_rect(
        rect.inflate(-0.5),
        f.px(pal::R_CHIP),
        if editing {
            f.theme.line_strong
        } else if hovered {
            f.theme.line_strong
        } else {
            f.theme.line
        },
        1.0,
    );
    let pad = f.px(6.0);
    let (_, th) = f.p.measure(&shown, &style);
    f.p.text(
        &shown,
        Rect::new(rect.left + pad, rect.center().1 - th / 2.0, rect.right - pad, rect.bottom),
        &style,
        alpha(f.theme.text, dim),
    );
    if editing {
        f.p.text(
            unit,
            Rect::new(rect.right + f.px(3.0), rect.center().1 - th / 2.0, at.right, at.bottom),
            &style,
            f.theme.text_3,
        );
        // The caret sits where the next digit will appear. The text is right-aligned and the
        // caret is always at its end, so that is the text's own right edge — no measuring, and
        // nothing to drift as the digits change width.
        f.p.fill_rect(
            Rect::new(
                rect.right - pad + f.px(1.0),
                rect.center().1 - th / 2.0,
                rect.right - pad + f.px(2.0),
                rect.center().1 + th / 2.0,
            ),
            f.theme.text,
        );
        f.want_frame();
    }
    committed.filter(|v| (v - value).abs() > 1e-4)
}

// ─── Select ─────────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct Choice {
    pub value: String,
    pub label: String,
    /// A second line of support — the English name of a language, say. It recedes, and it is the
    /// part that gives way when the row is narrow.
    pub hint: String,
}

impl Choice {
    pub fn new(value: &str, label: &str) -> Self {
        Self {
            value: value.into(),
            label: label.into(),
            hint: String::new(),
        }
    }

    pub fn with_hint(value: &str, label: &str, hint: &str) -> Self {
        Self {
            value: value.into(),
            label: label.into(),
            hint: hint.into(),
        }
    }
}

/// The trigger half of a dropdown. The list itself is drawn later, above everything else.
pub fn select(
    f: &mut Frame,
    id: &str,
    at: Rect,
    choices: &[Choice],
    current: &str,
    enabled: bool,
) -> Option<String> {
    let label = choices
        .iter()
        .find(|c| c.value == current)
        .map(|c| c.label.as_str())
        .unwrap_or(current);
    let pad = f.px(12.0);
    let chevron = f.px(14.0);
    let w = (f.p.measure(label, &value_style(f.scale, f.rtl)).0 + pad * 2.0 + chevron + f.px(8.0))
        .min(at.width())
        .max(f.px(90.0));
    let h = f.px(pal::CONTROL_H);
    let rect = Rect::new(at.right - w, at.center().1 - h / 2.0, at.right, at.center().1 + h / 2.0);

    let open = f.ui.menu_open_for(id).is_some();
    // An open list makes the panel behind it inert, the rows it covers included. Its own trigger is
    // the exception: that is what the user presses to put the list away again.
    let blocked = f.blocked;
    if open {
        f.blocked = false;
    }
    let hovered = enabled && f.hovered(rect);
    if hovered {
        f.set_cursor(Cursor::Hand);
    }
    if enabled && f.clicked(id, rect) {
        if open {
            f.ui.close_menu();
        } else {
            f.ui.open_menu(id, rect);
        }
    }
    f.blocked = blocked;

    let fill = if open {
        f.theme.raised
    } else if hovered {
        f.theme.hover
    } else {
        f.theme.sunken
    };
    f.p.fill_round_rect(rect, f.px(pal::R_CONTROL), fill);
    f.p.stroke_round_rect(
        rect.inflate(-0.5),
        f.px(pal::R_CONTROL),
        if open || hovered { f.theme.line_strong } else { f.theme.line },
        1.0,
    );
    let (_, th) = f.p.measure(label, &value_style(f.scale, f.rtl));
    f.p.text(
        label,
        Rect::new(rect.left + pad, rect.center().1 - th / 2.0, rect.right - chevron - pad, rect.bottom),
        &value_style(f.scale, f.rtl),
        if enabled { f.theme.text } else { f.theme.text_3 },
    );
    // The chevron turns to point at its own list when the list is open.
    let cx = rect.right - pad - chevron / 2.0;
    let cy = rect.center().1;
    f.p.glyph(
        if open { "ChevronUp" } else { "ChevronDown" },
        (cx, cy),
        chevron,
        if open || hovered { f.theme.text_2 } else { f.theme.text_3 },
        2.0,
    );
    None
}

/// Hand this dropdown's list to the frame's last pass, and answer with what was picked from it.
///
/// The list is NOT drawn here. Drawn where its row is, it is painted over by everything that comes
/// after that row — the page keeps going, and so do the scroll bar and the toast — which is what
/// made an open list look transparent: in the dark theme its own fill is the content's colour, so
/// the rows coming through it are all there is to see. It is not clipped by the scrolling column
/// either, which it has to escape: the language list is ten times the height of its row.
///
/// The pick therefore arrives on the frame after the click, because the list is drawn downstream of
/// the row that owns it. One frame, against a list that is actually on top.
pub fn select_popup(
    f: &mut Frame,
    id: &str,
    choices: &[Choice],
    current: &str,
) -> Option<String> {
    if let Some(from) = f.ui.menu_open_for(id) {
        f.ui.queue_menu(Menu {
            id: id.to_string(),
            from,
            choices: choices.to_vec(),
            current: current.to_string(),
            bounds: f.bounds,
        });
    }
    f.ui.take_choice(id)
}

/// Draw the open dropdown's list, over the page and everything standing on it.
///
/// The panel's last pass, and the only place a list is drawn. Called every frame whether or not one
/// is open: a list whose row has gone — filtered away by the search, or switched off by the row
/// above it — is hanging off a trigger that is no longer there, and it closes.
pub fn menu_layer(f: &mut Frame) {
    // A pick nobody came back for: a frame old, and the row that would have taken it is no longer
    // being drawn. Dropped here rather than kept, or it lands the next time that row appears.
    f.ui.forget_choice();
    let Some(menu) = f.ui.take_menu() else {
        if f.ui.list_open() {
            f.ui.close_menu();
            f.blocked = false;
            f.want_frame();
        }
        return;
    };
    let from = menu.from;
    let pad = f.px(4.0);
    let item_h = f.px(pal::CONTROL_H);
    let max_h = f.px(320.0);
    let height = (menu.choices.len() as f32 * item_h + pad * 2.0).min(max_h);
    let width = from
        .width()
        .max(f.px(180.0))
        .max(
            menu.choices
                .iter()
                .map(|c| {
                    f.p.measure(&c.label, &value_style(f.scale, f.rtl)).0
                        + if c.hint.is_empty() {
                            0.0
                        } else {
                            f.p.measure(&c.hint, &small_style(f.scale, f.rtl)).0 + f.px(10.0)
                        }
                        + f.px(28.0)
                })
                .fold(0.0, f32::max),
        );

    // Below the trigger, unless there is no room — then above it. A list that ran off the bottom of
    // the window would be a list whose last options cannot be reached.
    let below = from.bottom + f.px(4.0);
    let top = if below + height <= menu.bounds.bottom {
        below
    } else {
        (from.top - f.px(4.0) - height).max(menu.bounds.top)
    };
    let left = (from.right - width).max(menu.bounds.left + f.px(8.0));
    let list = Rect::new(left, top, left + width, top + height);

    // The shade: transparent, full-bleed, and only there to catch the click that dismisses.
    if f.input.pressed && !list.contains(f.input.pointer.0, f.input.pointer.1) && !from.contains(f.input.pointer.0, f.input.pointer.1) {
        f.ui.close_menu();
        f.blocked = false;
        return;
    }

    shadow_panel(f, list);

    let mut chosen = None;
    let mut y = list.top + pad;
    for choice in &menu.choices {
        if y + item_h > list.bottom - pad {
            break;
        }
        let item = Rect::new(list.left + pad, y, list.right - pad, y + item_h);
        let hovered = item.contains(f.input.pointer.0, f.input.pointer.1);
        if hovered {
            f.set_cursor(Cursor::Hand);
            f.p.fill_round_rect(item, f.px(pal::R_CHIP), f.theme.hover);
        }
        if hovered && f.input.released {
            chosen = Some(choice.value.clone());
        }
        let selected = choice.value == menu.current;
        let (_, th) = f.p.measure(&choice.label, &value_style(f.scale, f.rtl));
        let text_left = item.left + f.px(10.0);
        f.p.text(
            &choice.label,
            Rect::new(text_left, item.center().1 - th / 2.0, item.right, item.bottom),
            &value_style(f.scale, f.rtl),
            f.theme.text,
        );
        if !choice.hint.is_empty() {
            let label_w = f.p.measure(&choice.label, &value_style(f.scale, f.rtl)).0;
            f.p.text(
                &choice.hint,
                Rect::new(
                    text_left + label_w + f.px(10.0),
                    item.center().1 - th / 2.0,
                    item.right - f.px(26.0),
                    item.bottom,
                ),
                &small_style(f.scale, f.rtl),
                f.theme.text_3,
            );
        }
        if selected {
            f.p.glyph(
                "Check",
                (item.right - f.px(14.0), item.center().1),
                f.px(14.0),
                f.theme.text,
                2.0,
            );
        }
        y += item_h;
    }

    if let Some(value) = chosen {
        f.ui.choose(&menu.id, value);
        f.ui.close_menu();
        // The row is told on the next frame, so there has to BE a next frame.
        f.want_frame();
    }
    // The list has been drawn, so what comes after it in the frame — the window's own buttons — is
    // live again. A list left open must never be able to swallow the close button.
    f.blocked = false;
}

/// A floating surface: the panel fill, its hairline, and a soft drop shadow under it.
pub fn shadow_panel(f: &mut Frame, rect: Rect) {
    // The shadow is drawn as three expanding, fading outlines rather than a blurred bitmap. A
    // popup's geometry changes with its contents, so baking one per size would be a blur per frame
    // of a list that is scrolling — and at this softness the difference is not visible.
    for step in 1..=3 {
        let spread = f.px(step as f32 * 4.0);
        f.p.fill_round_rect(
            rect.inflate(spread).offset(0.0, f.px(4.0)),
            f.px(pal::R_PANEL) + spread,
            pal::rgba(pal::BLACK, 0.10 / step as f32),
        );
    }
    f.p.fill_round_rect(rect, f.px(pal::R_PANEL), f.theme.surface);
    f.p.stroke_round_rect(rect.inflate(-0.5), f.px(pal::R_PANEL), f.theme.line_strong, 1.0);
}

// ─── Text field ─────────────────────────────────────────────────────────────

/// A single-line text field. Returns the text when it is committed.
pub fn text_field(
    f: &mut Frame,
    id: &str,
    rect: Rect,
    value: &str,
    placeholder: &str,
) -> Option<String> {
    let hovered = f.hovered(rect);
    if hovered {
        f.set_cursor(Cursor::Text);
    }
    let focused = f.ui.is_focused(id);
    if f.input.pressed {
        if hovered {
            if !focused {
                f.ui.begin_edit(id, value);
            }
        } else if focused {
            // Clicking away commits. Discarding instead is the behaviour nobody expects from a
            // settings field, and it loses work that was visibly typed.
            let text = f.ui.end_edit();
            f.ui.blur();
            return text;
        }
    }

    let mut committed = None;
    if focused {
        let typed = f.input.typed.clone();
        let back = f.input.key_pressed(0x08);
        let enter = f.input.key_pressed(0x0D);
        let escape = f.input.key_pressed(0x1B);
        if let Some((text, caret)) = f.ui.edit_mut(id) {
            for ch in typed.chars().filter(|c| !c.is_control()) {
                let at = byte_at(text, *caret);
                text.insert(at, ch);
                *caret += 1;
            }
            if back && *caret > 0 {
                let at = byte_at(text, *caret - 1);
                text.remove(at);
                *caret -= 1;
            }
        }
        if enter {
            committed = f.ui.end_edit();
            f.ui.blur();
        } else if escape {
            f.ui.end_edit();
            f.ui.blur();
        }
    }

    let shown = f
        .ui
        .editing(id)
        .map(|(text, _)| text.to_string())
        .unwrap_or_else(|| value.to_string());

    f.p.fill_round_rect(rect, f.px(pal::R_CONTROL), f.theme.sunken);
    f.p.stroke_round_rect(
        rect.inflate(-0.5),
        f.px(pal::R_CONTROL),
        if focused { f.theme.focus } else if hovered { f.theme.line_strong } else { f.theme.line },
        1.0,
    );
    let pad = f.px(10.0);
    let (text_w, th) = f.p.measure(&shown, &control_style(f.scale, f.rtl));
    let display: &str = if shown.is_empty() { placeholder } else { &shown };
    f.p.text(
        display,
        Rect::new(rect.left + pad, rect.center().1 - th / 2.0, rect.right - pad, rect.bottom),
        &control_style(f.scale, f.rtl),
        if shown.is_empty() { f.theme.text_3 } else { f.theme.text },
    );
    if focused {
        // A blinking caret, on the half-second the platform uses. Drawn rather than measured per
        // character: the caret is always at the end here, because these fields are short and
        // arrow-key editing inside one is not a thing anybody does to a setting.
        let on = (std::time::Instant::now().elapsed().as_millis() / 500) % 2 == 0;
        let _ = on;
        f.p.fill_rect(
            Rect::new(
                rect.left + pad + text_w + f.px(1.0),
                rect.center().1 - th / 2.0,
                rect.left + pad + text_w + f.px(2.0),
                rect.center().1 + th / 2.0,
            ),
            f.theme.text,
        );
        f.want_frame();
    }
    committed
}

/// A field with no plate of its own, which reports on every keystroke.
///
/// The settings search is the one field here that is not a value being committed: it narrows the
/// panel as it is typed, so there is nothing to press Enter on and nothing to discard with Escape
/// but the term itself. `text_field` is the other shape — a value the configuration will be given
/// once, when the user says so — and the two are kept apart rather than merged behind a flag,
/// because "commits on blur" and "applies as you type" want opposite things of every key.
///
/// `rect` is where the TEXT goes. The caller has already drawn the box, which is what lets the
/// search field put a magnifier inside the same plate.
pub fn text_field_bare(
    f: &mut Frame,
    id: &str,
    rect: Rect,
    value: &str,
    placeholder: &str,
) -> Option<String> {
    let focused = f.ui.is_focused(id);
    if f.input.pressed {
        if f.hovered(rect) {
            if !focused {
                f.ui.begin_edit(id, value);
            }
        } else if focused {
            f.ui.blur();
        }
    }

    let mut changed = None;
    if focused {
        let typed = f.input.typed.clone();
        let back = f.input.key_pressed(0x08);
        let escape = f.input.key_pressed(0x1B);
        if let Some((text, caret)) = f.ui.edit_mut(id) {
            let before = text.clone();
            for ch in typed.chars().filter(|c| !c.is_control()) {
                let at = byte_at(text, *caret);
                text.insert(at, ch);
                *caret += 1;
            }
            if back && *caret > 0 {
                let at = byte_at(text, *caret - 1);
                text.remove(at);
                *caret -= 1;
            }
            if *text != before {
                changed = Some(text.clone());
            }
        }
        if escape {
            // Escape empties the field rather than reverting it. A search term HAS no previous
            // value to go back to, and leaving the old one there after an Escape is the one
            // outcome nobody pressing it wanted.
            f.ui.end_edit();
            f.ui.blur();
            changed = Some(String::new());
        }
    }

    let shown = f
        .ui
        .editing(id)
        .map(|(text, _)| text.to_string())
        .unwrap_or_else(|| value.to_string());
    let style = Style::new(Family::Ui, 12.5 * f.scale, 450, Align::Leading).rtl(f.rtl);
    let (text_w, th) = f.p.measure(&shown, &style);
    let display: &str = if shown.is_empty() { placeholder } else { &shown };
    f.p.text(
        display,
        Rect::new(rect.left, rect.center().1 - th / 2.0, rect.right, rect.bottom),
        &style,
        if shown.is_empty() { f.theme.text_3 } else { f.theme.text },
    );
    if focused {
        let caret_x = if f.rtl { rect.right - text_w - f.px(2.0) } else { rect.left + text_w + f.px(1.0) };
        f.p.fill_rect(
            Rect::new(caret_x, rect.center().1 - th / 2.0, caret_x + f.px(1.0), rect.center().1 + th / 2.0),
            f.theme.text,
        );
        f.want_frame();
    }
    changed
}

fn byte_at(text: &str, chars: usize) -> usize {
    text.char_indices()
        .nth(chars)
        .map(|(at, _)| at)
        .unwrap_or(text.len())
}

// ─── Colour ─────────────────────────────────────────────────────────────────

/// The hover-colour control: a swatch and the hex beside it.
pub fn color_field(f: &mut Frame, id: &str, at: Rect, value: u32) -> Option<u32> {
    let h = f.px(pal::CONTROL_H);
    let w = f.px(104.0);
    let rect = Rect::new(at.right - w, at.center().1 - h / 2.0, at.right, at.center().1 + h / 2.0);
    let hovered = f.hovered(rect);
    f.p.stroke_round_rect(
        rect.inflate(-0.5),
        f.px(pal::R_CONTROL),
        if hovered { f.theme.line_strong } else { f.theme.line },
        1.0,
    );
    if hovered {
        f.p.fill_round_rect(rect, f.px(pal::R_CONTROL), f.theme.hover);
    }

    let swatch = Rect::centred(rect.left + f.px(16.0), rect.center().1, f.px(22.0), f.px(22.0));
    f.p.fill_round_rect(swatch, f.px(6.0), pal::rgb(value));
    f.p.stroke_round_rect(swatch.inflate(-0.5), f.px(6.0), f.theme.line_strong, 1.0);

    let hex = format!("{value:06X}");
    let (_, th) = f.p.measure(&hex, &small_style(f.scale, f.rtl));
    f.p.text(
        "#",
        Rect::new(swatch.right + f.px(6.0), rect.center().1 - th / 2.0, rect.right, rect.bottom),
        &small_style(f.scale, f.rtl),
        f.theme.text_3,
    );
    f.p.text(
        &hex,
        Rect::new(swatch.right + f.px(14.0), rect.center().1 - th / 2.0, rect.right, rect.bottom),
        &Style::new(Family::Ui, 11.0 * f.scale, 500, Align::Leading).tracking(0.025),
        f.theme.text,
    );

    // The picker is a small palette rather than a system colour dialog: the wheel is monochrome
    // plus ONE colour, and a full picker invites a choice the design has no room for. These are
    // the hues that stay legible as a tile's background under a white glyph.
    if f.clicked(id, rect) {
        f.ui.open_menu(id, rect);
    }
    if f.ui.menu_open_for(id).is_some() {
        return color_popup(f, rect, value);
    }
    None
}

const SWATCHES: &[u32] = &[
    0xFFFFFF, 0xE6E6E6, 0x0A84FF, 0x5E5CE6, 0xBF5AF2, 0xFF375F, 0xFF453A, 0xFF9F0A, 0xFFD60A,
    0x32D74B, 0x30D158, 0x40C8E0, 0x64D2FF, 0x8E8E93,
];

fn color_popup(f: &mut Frame, from: Rect, current: u32) -> Option<u32> {
    let cell = f.px(28.0);
    let pad = f.px(8.0);
    let columns = 7;
    let rows = SWATCHES.len().div_ceil(columns);
    let width = cell * columns as f32 + pad * 2.0;
    let height = cell * rows as f32 + pad * 2.0;
    let left = (from.right - width).max(f.bounds.left + f.px(8.0));
    let top = if from.bottom + f.px(4.0) + height <= f.bounds.bottom {
        from.bottom + f.px(4.0)
    } else {
        (from.top - f.px(4.0) - height).max(f.bounds.top)
    };
    let panel = Rect::new(left, top, left + width, top + height);

    if f.input.pressed
        && !panel.contains(f.input.pointer.0, f.input.pointer.1)
        && !from.contains(f.input.pointer.0, f.input.pointer.1)
    {
        f.ui.close_menu();
        return None;
    }
    let clip = f.escape_clip();
    shadow_panel(f, panel);

    let mut chosen = None;
    for (index, colour) in SWATCHES.iter().enumerate() {
        let x = panel.left + pad + (index % columns) as f32 * cell;
        let y = panel.top + pad + (index / columns) as f32 * cell;
        let cell_rect = Rect::new(x, y, x + cell, y + cell);
        let swatch = cell_rect.inflate(-f.px(4.0));
        let hovered = cell_rect.contains(f.input.pointer.0, f.input.pointer.1);
        if hovered {
            f.set_cursor(Cursor::Hand);
        }
        if hovered && f.input.released {
            chosen = Some(*colour);
        }
        f.p.fill_round_rect(swatch, f.px(6.0), pal::rgb(*colour));
        if *colour == current {
            f.p.stroke_round_rect(swatch.inflate(f.px(2.0)), f.px(8.0), f.theme.text, f.px(1.5));
        } else if hovered {
            f.p.stroke_round_rect(swatch.inflate(f.px(1.0)), f.px(7.0), f.theme.line_strong, 1.0);
        }
    }
    if chosen.is_some() {
        f.ui.close_menu();
    }
    f.restore_clip(clip);
    chosen
}

// ─── Text wrapping ──────────────────────────────────────────────────────────
//
// A description is one or two lines and is wrapped by hand rather than by DirectWrite, because the
// layouts are cached by `(style, string)` and a wrapped layout would have to be keyed by its width
// too. Wrapping to a line list keeps every cached layout independent of the box it is drawn in.

fn wrap<'a>(f: &Frame, text: &'a str, width: f32) -> Vec<&'a str> {
    let style = body_style(f.scale, f.rtl);
    if f.p.measure(text, &style).0 <= width {
        return vec![text];
    }
    let mut lines = Vec::new();
    let mut start = 0usize;
    let mut last_break = None;
    for (at, ch) in text.char_indices() {
        if ch == ' ' {
            if f.p.measure(&text[start..at], &style).0 > width {
                if let Some(brk) = last_break {
                    lines.push(&text[start..brk]);
                    start = brk + 1;
                    last_break = Some(at);
                    continue;
                }
            }
            last_break = Some(at);
        }
    }
    if f.p.measure(&text[start..], &style).0 > width {
        if let Some(brk) = last_break {
            lines.push(&text[start..brk]);
            start = brk + 1;
        }
    }
    lines.push(&text[start..]);
    lines
}

/// How tall wrapped body text will be, before anything is drawn.
pub fn wrapped_height_of(f: &Frame, text: &str, width: f32) -> f32 {
    wrapped_height(f, text, width)
}

fn wrapped_height(f: &Frame, text: &str, width: f32) -> f32 {
    let lines = wrap(f, text, width);
    let line_h = f.p.measure("Ag", &body_style(f.scale, f.rtl)).1 * 1.45;
    lines.len() as f32 * line_h
}

/// Draw wrapped body text into `rect`, and say how tall it came out.
///
/// The card stacks three blocks of prose and has to know where each one ended; everything else in
/// this file lays out against a row whose height was decided before anything was drawn.
pub fn draw_wrapped_at(f: &mut Frame, text: &str, rect: Rect, colour: D2D1_COLOR_F) -> f32 {
    let height = wrapped_height(f, text, rect.width());
    draw_wrapped(f, text, rect, colour);
    height
}

fn draw_wrapped(f: &mut Frame, text: &str, rect: Rect, colour: D2D1_COLOR_F) {
    let style = body_style(f.scale, f.rtl);
    let line_h = f.p.measure("Ag", &style).1 * 1.45;
    let lines = wrap(f, text, rect.width());
    for (index, line) in lines.iter().enumerate() {
        f.p.text(
            line,
            Rect::new(
                rect.left,
                rect.top + index as f32 * line_h,
                rect.right,
                rect.bottom,
            ),
            &style,
            colour,
        );
    }
}

// ─── Colour helpers ─────────────────────────────────────────────────────────

pub fn alpha(colour: D2D1_COLOR_F, a: f32) -> D2D1_COLOR_F {
    D2D1_COLOR_F {
        a: a.clamp(0.0, 1.0),
        ..colour
    }
}

/// `color-mix(in srgb, a <amount>%, b)` — the CSS the original's hover states use.
pub fn mix(a: D2D1_COLOR_F, b: D2D1_COLOR_F, amount: f32) -> D2D1_COLOR_F {
    let t = amount.clamp(0.0, 1.0);
    D2D1_COLOR_F {
        r: a.r * t + b.r * (1.0 - t),
        g: a.g * t + b.g * (1.0 - t),
        b: a.b * t + b.b * (1.0 - t),
        a: a.a * t + b.a * (1.0 - t),
    }
}

/// A value eased toward a target, for the states that animate.
pub fn ease_to(current: f32, target: f32, elapsed_ms: f32, duration_ms: f32) -> f32 {
    if duration_ms <= 0.0 {
        return target;
    }
    let t = (elapsed_ms / duration_ms).clamp(0.0, 1.0);
    current + (target - current) * anim::standard(t)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mixing_matches_css_color_mix() {
        let white = pal::rgb(0xFFFFFF);
        let black = pal::rgb(0x000000);
        let half = mix(white, black, 0.5);
        assert!((half.r - 0.5).abs() < 1e-6);
        assert_eq!(mix(white, black, 1.0).r, 1.0);
        assert_eq!(mix(white, black, 0.0).r, 0.0);
        // Clamped, so an out-of-range amount cannot produce a colour outside the two.
        assert_eq!(mix(white, black, 2.0).r, 1.0);
    }

    #[test]
    fn alpha_only_touches_alpha() {
        let c = pal::rgba(0x804020, 0.8);
        let faded = alpha(c, 0.25);
        assert_eq!((faded.r, faded.g, faded.b), (c.r, c.g, c.b));
        assert_eq!(faded.a, 0.25);
    }

    #[test]
    fn the_swatches_are_all_opaque_and_distinct() {
        // A duplicate would be a cell that looks like a second chance to pick the same colour.
        for (i, a) in SWATCHES.iter().enumerate() {
            assert!(*a <= 0xFFFFFF);
            for b in &SWATCHES[i + 1..] {
                assert_ne!(a, b, "{a:06X} appears twice");
            }
        }
    }

    #[test]
    fn the_default_hover_colour_is_offered() {
        // White is the shipped value; a palette that cannot express the current setting would show
        // nothing as selected.
        assert!(SWATCHES.contains(&0xFFFFFF));
    }

    #[test]
    fn the_volume_only_ever_lands_on_a_multiple_of_ten() {
        // Ten steps and not a hundred, which is what the ticks under the rail are promising. A
        // drag that came to rest on 73 would leave the thumb between two dots.
        for raw in [0.0, 4.9, 5.1, 12.0, 49.0, 87.0, 99.9, 100.0] {
            let snapped = snap(raw, 0.0, 100.0, 10.0);
            assert_eq!(snapped % 10.0, 0.0, "{raw} snapped to {snapped}");
            assert!((0.0..=100.0).contains(&snapped));
            assert!((snapped - raw).abs() <= 5.0, "{raw} snapped as far as {snapped}");
        }
    }

    #[test]
    fn a_step_is_measured_from_the_low_end_not_from_zero() {
        // Hover time runs 0..2000 in 50s, which happens to be the same either way. The activation
        // zone runs 20..120 — snapped from zero its rest positions would miss both ends.
        assert_eq!(snap(20.0, 20.0, 120.0, 50.0), 20.0);
        assert_eq!(snap(44.0, 20.0, 120.0, 50.0), 20.0);
        assert_eq!(snap(46.0, 20.0, 120.0, 50.0), 70.0);
        assert_eq!(snap(120.0, 20.0, 120.0, 50.0), 120.0);
    }

    #[test]
    fn both_ends_of_a_range_are_always_reachable() {
        // A step that does not divide the range exactly would otherwise round the top end past
        // `max` and clamp it back to a value the ticks do not mark.
        for (min, max, step) in [(0.0, 100.0, 10.0), (20.0, 120.0, 1.0), (0.0, 1.0, 0.01), (12.0, 32.0, 1.0)] {
            assert_eq!(snap(min, min, max, step), min);
            assert_eq!(snap(max, min, max, step), max);
            // And nothing outside, however far the pointer is dragged past the end.
            assert_eq!(snap(max + 500.0, min, max, step), max);
            assert_eq!(snap(min - 500.0, min, max, step), min);
        }
    }

    #[test]
    fn a_range_with_no_step_keeps_the_value_it_was_given() {
        assert_eq!(snap(0.37, 0.0, 1.0, 0.0), 0.37);
        assert_eq!(snap(2.0, 0.0, 1.0, 0.0), 1.0);
    }
}
