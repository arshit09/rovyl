//! What the card says when a launch fails, and what it offers to do about it.
//!
//! The order of the three parts is the order somebody reads them in: what failed, why, and what to
//! try. The raw error is NOT one of the three — it is what the Copy button is for. A card whose
//! first line is `CreateProcessW failed: 0x80070002` has told a person nothing they can act on.

use super::widgets::{self as w, ButtonKind};
use super::{Cursor, Frame};
use crate::gfx::painter::Rect;

/// A failure, already turned into something a person can read.
#[derive(Debug, Clone, PartialEq)]
pub struct Fault {
    /// Which shortcut, by name.
    pub title: String,
    /// What went wrong, in a sentence.
    pub message: String,
    /// What to try, when there is something worth trying.
    pub hint: Option<String>,
    /// The shortcut's id, so "Fix" can open Settings on the right row. `None` for a failure that
    /// belongs to no shortcut -- a button that opened Settings on nothing in particular would be
    /// worse than no button.
    pub item_id: Option<String>,
    /// Where the shortcut lives, so "Fix" knows which workspace to open.
    pub workspace: Option<usize>,
    /// The error as the system gave it, for the clipboard.
    pub raw: String,
}

/// What the card was asked to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct FaultAction {
    pub fix: bool,
    pub copy: bool,
    pub dismiss: bool,
}

/// Turn a launch failure into the three lines a person can act on.
///
/// The system's own message is kept, but it is never the FIRST thing: `0x80070002` is the file
/// system saying "no such file", and the sentence that says so is the one worth leading with.
pub fn from_launch(
    item: &crate::config::AppItem,
    outcome: &crate::launch::Outcome,
    workspace: Option<usize>,
) -> Fault {
    let raw = outcome.error.clone().unwrap_or_default();
    let name = if item.label.trim().is_empty() {
        "This shortcut".to_string()
    } else {
        item.label.clone()
    };

    let (message, hint) = match outcome.exists {
        // Known missing: the most common failure by a distance, and the one with a real answer.
        Some(false) => (
            "Its target is not where the shortcut says it is.".to_string(),
            Some("The program may have been moved, updated or uninstalled. Point the shortcut at it again.".to_string()),
        ),
        _ if raw.to_lowercase().contains("no target") => (
            "It has nothing to open.".to_string(),
            Some("Give it a target in Settings.".to_string()),
        ),
        _ => (
            "Windows would not start it.".to_string(),
            (!raw.trim().is_empty()).then(|| raw.trim().to_string()),
        ),
    };

    Fault {
        title: format!("{name} did not open"),
        message,
        hint,
        item_id: (!item.id.trim().is_empty()).then(|| item.id.clone()),
        workspace,
        raw,
    }
}

/// Draw the card into the whole of `f.bounds`.
pub fn draw(f: &mut Frame, fault: &Fault, copied: bool) -> FaultAction {
    let mut action = FaultAction::default();
    let card = f.bounds;

    f.p.fill_round_rect(card, f.px(12.0), f.theme.surface);
    f.p.stroke_round_rect(card.inflate(-0.5), f.px(12.0), f.theme.line_strong, 1.0);

    let pad = f.px(16.0);
    let mark = f.px(18.0);
    f.p.glyph(
        "AlertTriangle",
        (card.left + pad + mark / 2.0, card.top + pad + mark / 2.0),
        mark,
        crate::gfx::palette::rgb(0xEF_B0_6C),
        1.9,
    );

    let text_left = card.left + pad + mark + f.px(10.0);
    let text_right = card.right - pad - f.px(26.0);
    let mut y = card.top + pad;

    let title_style = w::title_style(f.scale, f.rtl);
    let (_, title_h) = f.p.measure(&fault.title, &title_style);
    f.p.text(
        &fault.title,
        Rect::new(text_left, y, text_right, card.bottom),
        &title_style,
        f.theme.text,
    );
    y += title_h + f.px(5.0);

    let body = w::body_style(f.scale, f.rtl);
    y += w::draw_wrapped_at(f, &fault.message, Rect::new(text_left, y, text_right, card.bottom), f.theme.text_2);
    if let Some(hint) = fault.hint.as_deref() {
        y += f.px(4.0);
        let small = w::small_style(f.scale, f.rtl);
        let _ = &small;
        y += w::draw_wrapped_at(f, hint, Rect::new(text_left, y, text_right, card.bottom), f.theme.text_3);
    }
    let _ = body;
    let _ = y;

    // The close affordance, at the card's own top-right.
    let close = Rect::new(card.right - pad - f.px(22.0), card.top + pad - f.px(2.0), card.right - pad, card.top + pad + f.px(20.0));
    if f.hovered(close) {
        f.set_cursor(Cursor::Hand);
        f.p.fill_round_rect(close, f.px(6.0), f.theme.hover);
    }
    f.p.glyph("X", close.center(), f.px(13.0), f.theme.text_2, 1.9);
    if f.clicked("fault-close", close) {
        action.dismiss = true;
    }

    // The buttons, on one row at the bottom, laid out from the right.
    let row_h = f.px(30.0);
    let row_y = card.bottom - pad - row_h / 2.0;
    let mut right = card.right - pad;

    let copy_label = if copied { "Copied" } else { "Copy" };
    let copy_w = f.p.measure(copy_label, &w::control_style(f.scale, f.rtl)).0 + f.px(26.0);
    let copy_at = Rect::new(right - copy_w, row_y - row_h / 2.0, right, row_y + row_h / 2.0);
    right = copy_at.left - f.px(8.0);
    if w::button_at(f, "fault-copy", copy_at, copy_label, ButtonKind::Quiet, !fault.raw.trim().is_empty()) {
        action.copy = true;
    }

    // First in reading order and last in layout: the only one of the three that is a verb.
    if fault.item_id.is_some() {
        let label = "Fix shortcut";
        let fix_w = f.p.measure(label, &w::control_style(f.scale, f.rtl)).0 + f.px(26.0);
        let fix_at = Rect::new(right - fix_w, row_y - row_h / 2.0, right, row_y + row_h / 2.0);
        if w::button_at(f, "fault-fix", fix_at, label, ButtonKind::Primary, true) {
            action.fix = true;
        }
    }

    action
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AppItem;
    use crate::launch::Outcome;

    fn item(label: &str) -> AppItem {
        AppItem {
            id: "item-1".into(),
            label: label.into(),
            command: r"C:\gone\thing.exe".into(),
            ..AppItem::default()
        }
    }

    #[test]
    fn a_missing_target_is_said_in_a_sentence_before_it_is_said_in_hex() {
        let fault = from_launch(&item("Figma"), &Outcome::for_test("0x80070002", Some(false)), Some(2));
        assert_eq!(fault.title, "Figma did not open");
        assert!(fault.message.contains("not where the shortcut says"));
        assert!(fault.hint.as_deref().unwrap().contains("Point the shortcut at it"));
        // The raw text is kept for the clipboard, but it is never the first thing read.
        assert_eq!(fault.raw, "0x80070002");
        assert!(!fault.title.contains("0x"));
        assert!(!fault.message.contains("0x"));
    }

    #[test]
    fn a_shortcut_with_no_target_is_told_what_to_do_about_it() {
        let fault = from_launch(&item("Empty"), &Outcome::for_test("This shortcut has no target.", None), None);
        assert!(fault.message.contains("nothing to open"));
        assert!(fault.hint.as_deref().unwrap().contains("Settings"));
    }

    #[test]
    fn an_unnamed_shortcut_still_reads_as_a_sentence() {
        let fault = from_launch(&item("  "), &Outcome::for_test("nope", None), None);
        assert_eq!(fault.title, "This shortcut did not open");
    }

    #[test]
    fn fix_is_offered_only_when_there_is_something_to_fix() {
        let mut blank = item("X");
        blank.id = String::new();
        // A failure belonging to no shortcut gets no button: one that opened Settings on nothing
        // in particular would be worse than none.
        assert!(from_launch(&blank, &Outcome::for_test("nope", None), None).item_id.is_none());
        assert!(from_launch(&item("X"), &Outcome::for_test("nope", None), Some(0)).item_id.is_some());
    }
}
