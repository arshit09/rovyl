//! What the setup window shows: the mark, one sentence, Install, Close.
//!
//! **Why it is this small.** The 1.x installer was NSIS's two-page wizard — a welcome page, a
//! folder to choose, a progress bar and a finish page — because an Electron build genuinely has
//! something to decide: where several hundred files go. This is one executable that always goes to
//! the same per-user folder, so every page of that wizard would have been a page with nothing on
//! it. What is left is the only two things a person can actually answer: do it, or do not.
//!
//! **Why it says what it replaces.** Somebody running this very likely already has Rovyl — they
//! are being handed the native build in place of the Electron one — and the single question that
//! matters to them is whether their workspaces survive it. So the window answers it before it is
//! asked, on the line above the button.

use super::widgets::{self as w, ButtonKind};
use super::{Cursor, Frame};
use crate::gfx::painter::Rect;
use crate::gfx::text::{Align, Family, Style};

/// The window's size in DIPs. Fixed: there is nothing in it that can reflow.
pub const WINDOW_W: f32 = 400.0;
pub const WINDOW_H: f32 = 300.0;

/// Where the install has got to.
#[derive(Debug, Clone, PartialEq)]
pub enum Stage {
    /// Nothing has happened yet.
    Ready,
    /// The worker is copying, deleting and writing keys.
    Working,
    /// Installed, and the executable is at this path.
    Done,
    /// It did not install, and this is why.
    Failed(String),
}

/// What the window was asked to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Action {
    pub install: bool,
    pub open: bool,
    pub close: bool,
}

/// Draw the whole window.
///
/// `replacing` is whether a 1.x install was found, which changes one sentence and nothing else.
pub fn draw(f: &mut Frame, stage: &Stage, replacing: bool) -> Action {
    let mut action = Action::default();
    let window = f.bounds;

    f.p.fill_rect(window, f.theme.bg);

    let pad = f.px(16.0);

    // The close affordance, top-right. It is the same control as the Close button below — a window
    // this small with an X that did something different from its own button would be a puzzle.
    let close = Rect::new(
        window.right - pad - f.px(22.0),
        window.top + pad,
        window.right - pad,
        window.top + pad + f.px(22.0),
    );
    let busy = *stage == Stage::Working;
    if !busy && f.hovered(close) {
        f.set_cursor(Cursor::Hand);
        f.p.fill_round_rect(close, f.px(6.0), f.theme.hover);
    }
    f.p.glyph("X", close.center(), f.px(13.0), f.theme.text_2, 1.9);
    if !busy && f.clicked("setup-x", close) {
        action.close = true;
    }

    // The mark, drawn from its own geometry at a size that makes the rotated bars legible. `bg` is
    // what the punched centre is filled with, because `bg` is what is actually behind it.
    crate::wheel::render::draw_logo_probe_at(
        f.p,
        (window.center().0, window.top + f.px(86.0)),
        f.px(60.0),
        crate::gfx::palette::rgb(crate::gfx::palette::LOGO),
        f.theme.bg,
    );

    let centred = |f: &mut Frame, text: &str, y: f32, style: &Style, colour| {
        f.p.text(
            text,
            Rect::new(window.left, y, window.right, window.bottom),
            style,
            colour,
        );
    };

    let title = Style::new(Family::Ui, 19.0 * f.scale, 600, Align::Center).tracking(-0.01);
    centred(f, "Rovyl", window.top + f.px(130.0), &title, f.theme.text);

    let line = Style::new(Family::Ui, 12.0 * f.scale, 400, Align::Center);
    centred(
        f,
        "One gesture. Any destination.",
        window.top + f.px(160.0),
        &line,
        f.theme.text_2,
    );

    // The one line that changes, and the one somebody is actually reading.
    let small = Style::new(Family::Ui, 11.0 * f.scale, 450, Align::Center);
    let (note, colour) = match stage {
        Stage::Ready if replacing => (
            "Replaces your current Rovyl. Workspaces and settings stay.".to_string(),
            f.theme.text_3,
        ),
        Stage::Ready => (
            "Installs for you only — no admin, no restart.".to_string(),
            f.theme.text_3,
        ),
        Stage::Working => ("Installing…".to_string(), f.theme.text_3),
        Stage::Done => ("Installed. Rovyl is in your tray.".to_string(), f.theme.text_2),
        // Shortened rather than wrapped: the window is fixed, and the full text is in the log.
        Stage::Failed(why) => (clip(why, 64), f.theme.text_2),
    };
    centred(f, &note, window.top + f.px(186.0), &small, colour);

    // Two buttons, side by side and centred: the thing to do, and the way out of it.
    let button_w = f.px(112.0);
    let button_h = f.px(34.0);
    let gap = f.px(10.0);
    let row_y = window.bottom - f.px(30.0) - button_h / 2.0;
    let left = window.center().0 - button_w - gap / 2.0;

    let (label, enabled) = match stage {
        Stage::Ready => ("Install", true),
        Stage::Working => ("Installing…", false),
        Stage::Done => ("Open Rovyl", true),
        Stage::Failed(_) => ("Try again", true),
    };
    let primary = Rect::new(left, row_y - button_h / 2.0, left + button_w, row_y + button_h / 2.0);
    if w::button_at(f, "setup-go", primary, label, ButtonKind::Primary, enabled) {
        match stage {
            Stage::Done => action.open = true,
            _ => action.install = true,
        }
    }

    let secondary = Rect::new(
        primary.right + gap,
        primary.top,
        primary.right + gap + button_w,
        primary.bottom,
    );
    if w::button_at(f, "setup-close", secondary, "Close", ButtonKind::Quiet, !busy) {
        action.close = true;
    }

    action
}

/// Cut a message to something that fits on one line, on a word boundary where there is one.
fn clip(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max).collect();
    let cut = match cut.rsplit_once(' ') {
        Some((head, _)) if head.len() > max / 2 => head.to_string(),
        _ => cut,
    };
    format!("{cut}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_long_failure_is_cut_to_one_line() {
        let long = "cannot copy to C:\\Users\\somebody\\AppData\\Local\\Programs\\Rovyl\\Rovyl.exe: Access is denied. (os error 5)";
        let short = clip(long, 64);
        assert!(short.chars().count() <= 65, "{short}");
        assert!(short.ends_with('…'));
        // Short messages are left exactly as they are, ellipsis and all.
        assert_eq!(clip("nope", 64), "nope");
    }
}
