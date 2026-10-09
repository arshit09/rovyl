//! The mouse button that opens the wheel, as a binding rather than a name.
//!
//! The setting used to be three fixed choices (wheel, back, forward) because those are the three
//! buttons Windows reports that nothing else in the system already owns. But a modern mouse has
//! more buttons than Windows has names for, and the ones it does have — left and right — are only
//! unusable BARE. Held with a modifier they are as free as any side button, and on a mouse whose
//! extra keys the driver maps onto left/right they may be the only ones Rovyl can be given.
//!
//! So a binding is a button plus the modifiers held with it, written as one string:
//!
//! ```text
//! middle            Ctrl+left            Alt+Shift+x2
//! ```
//!
//! The three old values are exactly the modifier-free forms of three of the buttons, so every
//! config written before the grammar existed still parses and still means what it meant.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Middle,
    X1,
    X2,
    Left,
    Right,
}

impl Button {
    /// Short enough for the chip in the settings row.
    pub fn label(self) -> &'static str {
        match self {
            Button::Middle => "Wheel",
            Button::X1 => "Mouse 4",
            Button::X2 => "Mouse 5",
            Button::Left => "Left",
            Button::Right => "Right",
        }
    }

    /// The long form, for a sentence rather than a chip.
    pub fn name(self) -> &'static str {
        match self {
            Button::Middle => "the mouse wheel button",
            Button::X1 => "the back side-button",
            Button::X2 => "the forward side-button",
            Button::Left => "the left button",
            Button::Right => "the right button",
        }
    }

    /// The canonical spelling, which is what gets written to disk.
    pub fn canonical(self) -> &'static str {
        match self {
            Button::Middle => "middle",
            Button::X1 => "x1",
            Button::X2 => "x2",
            Button::Left => "left",
            Button::Right => "right",
        }
    }

    /// The two buttons the whole operating system is built on.
    ///
    /// Binding one bare would take the primary click or the context menu away from every
    /// application at once, so a bare binding on either is refused.
    fn needs_modifier(self) -> bool {
        matches!(self, Button::Left | Button::Right)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Trigger {
    pub button: Button,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    /// The Windows key. Written `Super` to match the keyboard-shortcut field.
    pub meta: bool,
}

pub const DEFAULT: Trigger = Trigger {
    button: Button::Middle,
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
};

/// What a hand-written or pre-grammar config may call a button.
fn button_alias(part: &str) -> Option<Button> {
    Some(match part {
        "middle" | "wheel" | "mouse3" => Button::Middle,
        "x1" | "mouse4" | "xbutton1" | "back" => Button::X1,
        "x2" | "mouse5" | "xbutton2" | "forward" => Button::X2,
        "left" | "mouse1" | "leftclick" => Button::Left,
        "right" | "mouse2" | "rightclick" => Button::Right,
        _ => return None,
    })
}

/// A stored value back into its parts, or `None` if it is not a binding this build can arm.
///
/// Deliberately strict about the rules and forgiving about the spelling: a config can be hand
/// edited or written by an older version, but a binding the hook will not accept must not survive
/// into the UI as a row that displays a button and opens nothing.
pub fn parse(value: Option<&str>) -> Option<Trigger> {
    let value = value?;
    let mut trigger = DEFAULT;
    let mut button: Option<Button> = None;
    let mut saw_any = false;

    for raw in value.split('+') {
        let part = raw.trim().to_ascii_lowercase();
        if part.is_empty() {
            continue;
        }
        saw_any = true;
        match part.as_str() {
            "ctrl" | "control" => trigger.ctrl = true,
            "alt" | "option" => trigger.alt = true,
            "shift" => trigger.shift = true,
            "super" | "win" | "windows" | "meta" | "cmd" => trigger.meta = true,
            other => match button_alias(other) {
                // Two buttons in one binding is not a binding: the hook watches exactly one.
                Some(named) if button.is_none() => button = Some(named),
                _ => return None,
            },
        }
    }

    if !saw_any {
        return None;
    }
    trigger.button = button?;
    if reject(&trigger).is_some() {
        return None;
    }
    Some(trigger)
}

/// The canonical string: modifiers in the order the shortcut field writes them, then the button.
pub fn format(trigger: &Trigger) -> String {
    let mut parts: Vec<&str> = Vec::with_capacity(5);
    if trigger.ctrl {
        parts.push("Ctrl");
    }
    if trigger.alt {
        parts.push("Alt");
    }
    if trigger.shift {
        parts.push("Shift");
    }
    if trigger.meta {
        parts.push("Super");
    }
    parts.push(trigger.button.canonical());
    parts.join("+")
}

/// Why this combination cannot be the trigger, or `None` when it can.
///
/// The one rule is about left and right. Everything else a mouse can send is fair game — that is
/// the whole point of recording rather than choosing from a list.
pub fn reject(trigger: &Trigger) -> Option<&'static str> {
    if !trigger.button.needs_modifier() {
        return None;
    }
    if trigger.ctrl || trigger.alt || trigger.shift || trigger.meta {
        return None;
    }
    Some(match trigger.button {
        Button::Left => {
            "The left button on its own is how Windows clicks everything. Hold Ctrl, Alt, Shift or Win and click again."
        }
        _ => {
            "The right button on its own is every context menu in Windows. Hold Ctrl, Alt, Shift or Win and click again."
        }
    })
}

/// The binding a config holds, falling back to the default rather than to nothing.
pub fn resolve(value: Option<&str>) -> Trigger {
    parse(value).unwrap_or(DEFAULT)
}

/// Whether this binding can be HELD as well as clicked.
///
/// Left and right cannot. Hold means the wheel is up for as long as the button is down and the
/// release runs whatever you were pointing at — which for the primary or secondary button is a drag
/// as far as the rest of Windows is concerned, and a press the hook has to hand back to the window
/// underneath the moment it turns out not to have been a gesture. Both of those fight the one thing
/// left and right are already used for everywhere, so those bindings are click-only and the gesture
/// row goes away rather than offering a mode that cannot work.
pub fn allows_hold(value: Option<&str>) -> bool {
    !resolve(value).button.needs_modifier()
}

/// The chips the settings row draws: one per modifier, then the button.
pub fn chips(value: Option<&str>) -> Vec<&'static str> {
    let trigger = resolve(value);
    let mut out: Vec<&'static str> = Vec::with_capacity(5);
    if trigger.ctrl {
        out.push("Ctrl");
    }
    if trigger.alt {
        out.push("Alt");
    }
    if trigger.shift {
        out.push("Shift");
    }
    if trigger.meta {
        out.push("Win");
    }
    out.push(trigger.button.label());
    out
}

/// The same binding inside a sentence: "hold the back side-button", "hold Ctrl and the left button".
pub fn phrase(value: Option<&str>) -> String {
    let trigger = resolve(value);
    let mut modifiers = chips(value);
    // The last chip is the button, whose long name is already in `name`.
    modifiers.pop();
    if modifiers.is_empty() {
        trigger.button.name().to_string()
    } else {
        format!("{} and {}", modifiers.join("+"), trigger.button.name())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_three_legacy_values_still_mean_what_they_meant() {
        // Every config written before the grammar existed holds one of these.
        assert_eq!(parse(Some("middle")).unwrap().button, Button::Middle);
        assert_eq!(parse(Some("x1")).unwrap().button, Button::X1);
        assert_eq!(parse(Some("x2")).unwrap().button, Button::X2);
    }

    #[test]
    fn spelling_is_forgiving() {
        for spelling in ["x1", "X1", " mouse4 ", "XButton1", "back"] {
            assert_eq!(parse(Some(spelling)).unwrap().button, Button::X1, "{spelling}");
        }
        let t = parse(Some("control+SHIFT+left")).unwrap();
        assert!(t.ctrl && t.shift && !t.alt);
        assert_eq!(t.button, Button::Left);
    }

    #[test]
    fn a_bare_primary_button_is_refused() {
        // Binding it would take the primary click away from every application at once.
        assert!(parse(Some("left")).is_none());
        assert!(parse(Some("right")).is_none());
        // With a modifier they are as free as any side button.
        assert!(parse(Some("Ctrl+left")).is_some());
        assert!(parse(Some("Alt+right")).is_some());
    }

    #[test]
    fn two_buttons_is_not_a_binding() {
        // The hook watches exactly one.
        assert!(parse(Some("middle+x1")).is_none());
    }

    #[test]
    fn junk_falls_back_rather_than_disarming_the_mouse() {
        // A row that displays a button and opens nothing is worse than the default.
        assert_eq!(resolve(Some("grizzly")).button, Button::Middle);
        assert_eq!(resolve(None).button, Button::Middle);
        assert_eq!(resolve(Some("")).button, Button::Middle);
    }

    #[test]
    fn format_round_trips() {
        for spelling in ["middle", "Ctrl+left", "Ctrl+Alt+Shift+Super+x2"] {
            let parsed = parse(Some(spelling)).unwrap();
            assert_eq!(parse(Some(&format(&parsed))).unwrap(), parsed, "{spelling}");
        }
    }

    #[test]
    fn hold_is_offered_only_where_it_can_work() {
        assert!(allows_hold(Some("middle")));
        assert!(allows_hold(Some("x2")));
        assert!(!allows_hold(Some("Ctrl+left")));
        assert!(!allows_hold(Some("Alt+right")));
    }

    #[test]
    fn phrases_read_as_sentences() {
        assert_eq!(phrase(Some("middle")), "the mouse wheel button");
        assert_eq!(phrase(Some("Ctrl+left")), "Ctrl and the left button");
        assert_eq!(
            phrase(Some("Ctrl+Shift+x1")),
            "Ctrl+Shift and the back side-button"
        );
    }
}

/// A binding from what the recorder saw: the button's ordinal and the modifier mask.
///
/// The ordinals are the hook's, not `MouseEvent.button`'s — the two differ, and the hook is the
/// only thing in this build that ever reports a button.
pub fn from_ordinal(button: u32, modifiers: u32) -> Option<Trigger> {
    use crate::input::hook::{MOD_ALT, MOD_CTRL, MOD_SHIFT, MOD_WIN};
    let button = match button {
        1 => Button::Left,
        2 => Button::Right,
        3 => Button::Middle,
        4 => Button::X1,
        5 => Button::X2,
        _ => return None,
    };
    Some(Trigger {
        button,
        ctrl: modifiers & MOD_CTRL != 0,
        alt: modifiers & MOD_ALT != 0,
        shift: modifiers & MOD_SHIFT != 0,
        meta: modifiers & MOD_WIN != 0,
    })
}
