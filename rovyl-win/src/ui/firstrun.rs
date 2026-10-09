//! What a new install says the first time Settings opens.
//!
//! Four points, and every one of them reads the configuration rather than describing a default:
//! somebody who installed this and changed the trigger before opening Settings must not be told to
//! press a key they have already replaced. That is also why it lives here and not in a string
//! table — the sentences are assembled from what the launcher is actually set to do.
//!
//! It is a modal over the panel rather than a window of its own, because it is about the panel: it
//! ends with "everything above is in Settings", and the place to say that is in front of Settings.

use super::widgets::{self as w, ButtonKind};
use super::{Cursor, Frame};
use crate::config::{InstantActivate, TriggerMode, UiConfig};
use crate::gfx::painter::Rect;

/// One line of the card.
struct Point {
    glyph: &'static str,
    title: String,
    body: String,
}

/// Build the points from what the launcher is set to do.
fn points(config: &UiConfig) -> Vec<Point> {
    let mut out = Vec::with_capacity(4);
    let by_keyboard = config.keyboard_trigger_on();
    let by_mouse = config.enable_mouse_trigger;

    if by_keyboard {
        out.push(Point {
            glyph: "Keyboard",
            title: "Open the wheel".into(),
            body: format!(
                "Press {} anywhere in Windows \u{2014} over any application, without leaving it.",
                config.global_shortcut
            ),
        });
    }

    if by_mouse {
        let button = crate::input::trigger::phrase(config.mouse_trigger_button.as_deref());
        let by_hold = matches!(config.mouse_trigger_mode, Some(TriggerMode::Hold));
        out.push(Point {
            glyph: "Mouse",
            // "Or" only makes sense as the second way in.
            title: if by_keyboard {
                "Or use the mouse".into()
            } else {
                "Open the wheel".into()
            },
            body: if by_hold {
                format!("Hold {button} to open the wheel, and let go on a target to run it.")
            } else {
                format!("Click {button} to open the wheel. It stays open until you pick something.")
            },
        });
    }

    let by_direction = matches!(config.instant_activate(), InstantActivate::Dwell);
    out.push(Point {
        glyph: "Target",
        title: "Aim, do not hunt".into(),
        body: format!(
            "{} Start typing to narrow a crowded wheel down to what you meant.",
            if by_direction {
                "Every target owns a whole wedge of the screen, so a flick in its direction is enough \u{2014} you never have to land on the icon."
            } else {
                "Move onto the icon you want and click it. Release away from every icon to cancel."
            }
        ),
    });

    let workspaces = config.workspaces.len();
    out.push(Point {
        glyph: "Layers",
        title: "Workspaces".into(),
        body: if workspaces > 1 {
            format!("You have {workspaces} sets of shortcuts \u{2014} one for work, one for whatever else. Switch between them from the wheel or the tray.")
        } else {
            "Keep separate sets of shortcuts \u{2014} one for work, one for whatever else \u{2014} and switch between them from the wheel or the tray.".into()
        },
    });

    out
}

/// Draw the card. Returns true when it was dismissed.
pub fn draw(f: &mut Frame, config: &UiConfig) -> bool {
    let screen = f.window;
    f.p.fill_rect(screen, f.theme.scrim);

    let points = points(config);
    let pad = f.px(24.0);
    let width = f.px(520.0).min(screen.width() - f.px(48.0));
    let text_width = width - pad * 2.0 - f.px(30.0);

    // Measured before the panel is placed, because the panel's height is the sum of its contents
    // and a card that clipped its last point would clip the one about workspaces.
    let mut body_h = 0.0;
    for point in &points {
        body_h += f.px(19.0) + w::wrapped_height_of(f, &point.body, text_width) + f.px(14.0);
    }
    let height =
        (pad + f.px(26.0) + f.px(22.0) + f.px(14.0) + body_h + f.px(52.0) + pad)
            .min(screen.height() - f.px(32.0));

    let panel = Rect::centred(screen.center().0, screen.center().1, width, height);
    w::shadow_panel(f, panel);

    let mut y = panel.top + pad;
    let (_, title_h) = f.p.measure("Rovyl is running", &w::group_style(f.scale, f.rtl));
    f.p.text(
        "Rovyl is running",
        Rect::new(panel.left + pad, y, panel.right - pad, panel.bottom),
        &w::group_style(f.scale, f.rtl),
        f.theme.text,
    );
    y += title_h + f.px(4.0);
    y += w::draw_wrapped_at(
        f,
        "It stays out of the way in the tray. Here is what to know.",
        Rect::new(panel.left + pad, y, panel.right - pad, panel.bottom),
        f.theme.text_2,
    );
    y += f.px(14.0);

    for point in &points {
        let mark = (panel.left + pad + f.px(9.0), y + f.px(8.0));
        f.p.glyph(point.glyph, mark, f.px(15.0), f.theme.text_3, 1.8);
        let left = panel.left + pad + f.px(30.0);
        let (_, h) = f.p.measure(&point.title, &w::title_style(f.scale, f.rtl));
        f.p.text(
            &point.title,
            Rect::new(left, y, panel.right - pad, panel.bottom),
            &w::title_style(f.scale, f.rtl),
            f.theme.text,
        );
        y += h + f.px(2.0);
        y += w::draw_wrapped_at(
            f,
            &point.body,
            Rect::new(left, y, panel.right - pad, panel.bottom),
            f.theme.text_2,
        );
        y += f.px(14.0);
    }

    // Nothing here is a setting, so there is nothing to cancel: one way out.
    let button_h = f.px(32.0);
    let button_y = panel.bottom - pad - button_h / 2.0;
    let label = "Got it";
    let button_w = f.p.measure(label, &w::control_style(f.scale, f.rtl)).0 + f.px(34.0);
    let at = Rect::new(
        panel.right - pad - button_w,
        button_y - button_h / 2.0,
        panel.right - pad,
        button_y + button_h / 2.0,
    );
    let dismissed = w::button_at(f, "firstrun-ok", at, label, ButtonKind::Primary, true);
    let (_, note_h) = f.p.measure("x", &w::small_style(f.scale, f.rtl));
    f.p.text(
        "Everything above is in Settings, and can be changed there.",
        Rect::new(
            panel.left + pad,
            button_y - note_h / 2.0,
            at.left - f.px(12.0),
            panel.bottom,
        ),
        &w::small_style(f.scale, f.rtl),
        f.theme.text_3,
    );
    if f.hovered(at) {
        f.set_cursor(Cursor::Hand);
    }

    // Nothing behind it reacts. Last, so the button above still worked this frame.
    f.blocked = true;
    dismissed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_card_describes_what_the_launcher_is_set_to_do() {
        let mut config = crate::config::defaults::ui_config();
        config.global_shortcut = "Ctrl+Space".into();
        let points = points(&config);
        // Somebody who changed the trigger before opening Settings must not be told to press the
        // key they replaced.
        assert!(
            points.iter().any(|p| p.body.contains("Ctrl+Space")),
            "{:?}",
            points.iter().map(|p| p.body.clone()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn the_mouse_point_only_exists_when_the_mouse_trigger_does() {
        let mut config = crate::config::defaults::ui_config();
        config.enable_mouse_trigger = false;
        assert!(!points(&config).iter().any(|p| p.glyph == "Mouse"));
        config.enable_mouse_trigger = true;
        assert!(points(&config).iter().any(|p| p.glyph == "Mouse"));
    }

    #[test]
    fn or_is_only_said_when_there_is_something_to_be_other_than() {
        let mut config = crate::config::defaults::ui_config();
        config.enable_mouse_trigger = true;
        config.enable_keyboard_trigger = Some(false);
        let alone = points(&config);
        let mouse = alone.iter().find(|p| p.glyph == "Mouse").expect("mouse point");
        assert_eq!(mouse.title, "Open the wheel");

        config.enable_keyboard_trigger = Some(true);
        let both = points(&config);
        let mouse = both.iter().find(|p| p.glyph == "Mouse").expect("mouse point");
        assert_eq!(mouse.title, "Or use the mouse");
    }

    #[test]
    fn every_mark_is_a_glyph_that_exists() {
        let config = crate::config::defaults::ui_config();
        for point in points(&config) {
            assert!(
                crate::gfx::lucide::exists(point.glyph),
                "{} does not exist",
                point.glyph
            );
        }
    }
}
