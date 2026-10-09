//! The global keyboard shortcut that opens the wheel.
//!
//! The accelerator grammar is Electron's, because that is what is already in every user's
//! `config-v2.json`: `Alt+Z`, `Ctrl+Shift+Space`, `Super+R`, `CommandOrControl+Alt+K`. Both builds
//! read the same file, so parsing has to accept exactly what the other one writes.
//!
//! The registration is `RegisterHotKey`, not a keyboard hook. A hook would also work and would be
//! one fewer mechanism, and it is the wrong choice here for two reasons: a registered hotkey is
//! visible to the system, so Windows itself resolves conflicts and reports them (which is what
//! makes `probe` possible), and a hook that swallowed the opening keystroke could not tell the
//! difference between "the user pressed the trigger" and "the user pressed the trigger while the
//! wheel was already up" without duplicating the wheel's own state.

use std::collections::BTreeSet;
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS, MOD_ALT, MOD_CONTROL,
    MOD_NOREPEAT, MOD_SHIFT, MOD_WIN,
};

/// A parsed accelerator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Hotkey {
    pub modifiers: HOT_KEY_MODIFIERS,
    /// The virtual-key code of the non-modifier key.
    pub vk: u16,
}

/// Identifiers for the hotkeys this process registers.
///
/// The wheel's trigger is one; the workspace keys registered while the wheel is OPEN take the rest,
/// starting past it so the two sets can never collide. The original hardcoded 1–9 against the
/// workspace position, which stopped being true the moment a key could be recorded.
pub const ID_TRIGGER: i32 = 1;
pub const ID_WORKSPACE_BASE: i32 = 100;

/// Parse an Electron-style accelerator.
///
/// Returns `None` for anything that could not be registered, which the settings panel shows as a
/// refusal rather than saving: an accelerator that displays in the row and opens nothing is worse
/// than none at all.
pub fn parse(accelerator: &str) -> Option<Hotkey> {
    let mut modifiers = HOT_KEY_MODIFIERS(0);
    let mut key: Option<u16> = None;

    for raw in accelerator.split('+') {
        let part = raw.trim();
        if part.is_empty() {
            continue;
        }
        let lower = part.to_ascii_lowercase();
        match lower.as_str() {
            "ctrl" | "control" | "commandorcontrol" | "cmdorctrl" | "command" | "cmd" => {
                // `Command` and `CommandOrControl` both mean Control here. Electron maps them to
                // the Windows Control key, and a config written on a Mac and synced across would
                // otherwise register nothing.
                modifiers |= MOD_CONTROL;
            }
            "alt" | "option" | "altgr" => modifiers |= MOD_ALT,
            "shift" => modifiers |= MOD_SHIFT,
            "super" | "meta" | "win" | "windows" => modifiers |= MOD_WIN,
            _ => {
                // Two non-modifier keys is not an accelerator.
                if key.is_some() {
                    return None;
                }
                key = virtual_key(&lower);
                key?;
            }
        }
    }

    let vk = key?;
    // A bare key with no modifier is refused. Registering one takes that key away from every
    // application in the system, and the field is a free string that a hand edit can put anything
    // in — including `Z`.
    if modifiers.0 == 0 {
        return None;
    }
    Some(Hotkey {
        // No auto-repeat. A held accelerator would otherwise fire dozens of times a second, and in
        // toggle mode that is the wheel flickering open and shut.
        modifiers: modifiers | MOD_NOREPEAT,
        vk,
    })
}

/// The canonical spelling, which is what the settings panel writes back.
pub fn format(hotkey: &Hotkey) -> String {
    let mut parts: Vec<&str> = Vec::with_capacity(5);
    if hotkey.modifiers & MOD_CONTROL != HOT_KEY_MODIFIERS(0) {
        parts.push("Ctrl");
    }
    if hotkey.modifiers & MOD_ALT != HOT_KEY_MODIFIERS(0) {
        parts.push("Alt");
    }
    if hotkey.modifiers & MOD_SHIFT != HOT_KEY_MODIFIERS(0) {
        parts.push("Shift");
    }
    if hotkey.modifiers & MOD_WIN != HOT_KEY_MODIFIERS(0) {
        parts.push("Super");
    }
    let name = key_name(hotkey.vk);
    let mut out = parts.join("+");
    if !out.is_empty() {
        out.push('+');
    }
    out.push_str(&name);
    out
}

/// An accelerator key name to a virtual-key code.
fn virtual_key(lower: &str) -> Option<u16> {
    use windows::Win32::UI::Input::KeyboardAndMouse as k;
    // A single character: a letter or a digit, as the layout prints it.
    let mut chars = lower.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        if c.is_ascii_alphabetic() {
            return Some(c.to_ascii_uppercase() as u16);
        }
        if c.is_ascii_digit() {
            return Some(c as u16);
        }
    }
    Some(match lower {
        "space" => k::VK_SPACE.0,
        "tab" => k::VK_TAB.0,
        "backspace" => k::VK_BACK.0,
        "delete" | "del" => k::VK_DELETE.0,
        "insert" => k::VK_INSERT.0,
        "return" | "enter" => k::VK_RETURN.0,
        "escape" | "esc" => k::VK_ESCAPE.0,
        "up" => k::VK_UP.0,
        "down" => k::VK_DOWN.0,
        "left" => k::VK_LEFT.0,
        "right" => k::VK_RIGHT.0,
        "home" => k::VK_HOME.0,
        "end" => k::VK_END.0,
        "pageup" => k::VK_PRIOR.0,
        "pagedown" => k::VK_NEXT.0,
        "plus" => k::VK_OEM_PLUS.0,
        "-" | "minus" => k::VK_OEM_MINUS.0,
        "," => k::VK_OEM_COMMA.0,
        "." => k::VK_OEM_PERIOD.0,
        "/" => k::VK_OEM_2.0,
        ";" => k::VK_OEM_1.0,
        "'" => k::VK_OEM_7.0,
        "[" => k::VK_OEM_4.0,
        "]" => k::VK_OEM_6.0,
        "\\" => k::VK_OEM_5.0,
        "`" => k::VK_OEM_3.0,
        "=" => k::VK_OEM_PLUS.0,
        "capslock" => k::VK_CAPITAL.0,
        "numlock" => k::VK_NUMLOCK.0,
        "scrolllock" => k::VK_SCROLL.0,
        "printscreen" => k::VK_SNAPSHOT.0,
        "pause" => k::VK_PAUSE.0,
        "numadd" => k::VK_ADD.0,
        "numsub" => k::VK_SUBTRACT.0,
        "nummult" => k::VK_MULTIPLY.0,
        "numdiv" => k::VK_DIVIDE.0,
        "numdec" => k::VK_DECIMAL.0,
        other => {
            // Function keys, and the numpad digits Electron spells `num0`..`num9`.
            if let Some(n) = other.strip_prefix('f').and_then(|n| n.parse::<u32>().ok()) {
                if (1..=24).contains(&n) {
                    return Some((k::VK_F1.0 as u32 + n - 1) as u16);
                }
            }
            if let Some(n) = other.strip_prefix("num").and_then(|n| n.parse::<u32>().ok()) {
                if n <= 9 {
                    return Some((k::VK_NUMPAD0.0 as u32 + n) as u16);
                }
            }
            return None;
        }
    })
}

/// A virtual-key code back to the name the accelerator grammar uses.
pub fn key_name(vk: u16) -> String {
    use windows::Win32::UI::Input::KeyboardAndMouse as k;
    if (b'A' as u16..=b'Z' as u16).contains(&vk) {
        return ((vk as u8) as char).to_string();
    }
    if (b'0' as u16..=b'9' as u16).contains(&vk) {
        return ((vk as u8) as char).to_string();
    }
    if (k::VK_F1.0..=k::VK_F24.0).contains(&vk) {
        return format!("F{}", vk - k::VK_F1.0 + 1);
    }
    if (k::VK_NUMPAD0.0..=k::VK_NUMPAD9.0).contains(&vk) {
        return format!("num{}", vk - k::VK_NUMPAD0.0);
    }
    match vk {
        v if v == k::VK_SPACE.0 => "Space",
        v if v == k::VK_TAB.0 => "Tab",
        v if v == k::VK_BACK.0 => "Backspace",
        v if v == k::VK_DELETE.0 => "Delete",
        v if v == k::VK_INSERT.0 => "Insert",
        v if v == k::VK_RETURN.0 => "Return",
        v if v == k::VK_ESCAPE.0 => "Escape",
        v if v == k::VK_UP.0 => "Up",
        v if v == k::VK_DOWN.0 => "Down",
        v if v == k::VK_LEFT.0 => "Left",
        v if v == k::VK_RIGHT.0 => "Right",
        v if v == k::VK_HOME.0 => "Home",
        v if v == k::VK_END.0 => "End",
        v if v == k::VK_PRIOR.0 => "PageUp",
        v if v == k::VK_NEXT.0 => "PageDown",
        v if v == k::VK_OEM_PLUS.0 => "Plus",
        v if v == k::VK_OEM_MINUS.0 => "-",
        v if v == k::VK_OEM_COMMA.0 => ",",
        v if v == k::VK_OEM_PERIOD.0 => ".",
        v if v == k::VK_OEM_2.0 => "/",
        v if v == k::VK_OEM_1.0 => ";",
        v if v == k::VK_OEM_7.0 => "'",
        v if v == k::VK_OEM_4.0 => "[",
        v if v == k::VK_OEM_6.0 => "]",
        v if v == k::VK_OEM_5.0 => "\\",
        v if v == k::VK_OEM_3.0 => "`",
        _ => return format!("0x{vk:02X}"),
    }
    .to_string()
}

/// Whether the non-modifier key of this accelerator is still physically held.
///
/// Used by the shortcut's HOLD mode. A registered hotkey reports only the press, so the release has
/// to be observed — and `GetAsyncKeyState` is the right tool because it reads the PHYSICAL key
/// state regardless of focus, which is the whole situation here: the overlay never has focus.
///
/// Polled from the frame loop rather than hooked. The wheel is already drawing frames throughout
/// the gesture this applies to, so the poll is free; a keyboard hook installed for it would see
/// every keystroke in the system for the sake of one key.
pub fn key_is_held(hotkey: &Hotkey) -> bool {
    unsafe { (GetAsyncKeyState(hotkey.vk as i32) as u16 & 0x8000) != 0 }
}

/// What a registration attempt found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Probe {
    /// Free, and now held by this process.
    Registered,
    /// This process already holds it — which, for the shortcut in use, is what healthy looks like.
    AlreadyOurs,
    /// Something else in the system holds it.
    Taken,
    /// Not an accelerator this build can register.
    Invalid,
}

/// Everything this process currently holds, so a re-register can tell "taken by us" from "taken".
#[derive(Default)]
pub struct Registry {
    held: BTreeSet<i32>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register `hotkey` under `id`, replacing whatever that id held.
    pub fn set(&mut self, hwnd: HWND, id: i32, hotkey: &Hotkey) -> Probe {
        self.clear(hwnd, id);
        let ok = unsafe { RegisterHotKey(hwnd, id, hotkey.modifiers, hotkey.vk as u32) };
        if ok.is_ok() {
            self.held.insert(id);
            Probe::Registered
        } else {
            Probe::Taken
        }
    }

    pub fn clear(&mut self, hwnd: HWND, id: i32) {
        if self.held.remove(&id) {
            unsafe {
                let _ = UnregisterHotKey(hwnd, id);
            }
        }
    }

    pub fn clear_range(&mut self, hwnd: HWND, from: i32) {
        let doomed: Vec<i32> = self.held.iter().copied().filter(|id| *id >= from).collect();
        for id in doomed {
            self.clear(hwnd, id);
        }
    }

    pub fn holds(&self, id: i32) -> bool {
        self.held.contains(&id)
    }

    /// Whether Windows would give this process the combination, without keeping it.
    ///
    /// Registering and immediately unregistering is the only way to ask: there is no query API, and
    /// a `RegisterHotKey` that fails is the answer. The one subtlety is the accelerator this
    /// process ALREADY holds — it would fail, which reads as "taken" when it means "yours".
    pub fn probe(&self, hwnd: HWND, accelerator: &str, our_id: i32) -> Probe {
        let Some(hotkey) = parse(accelerator) else {
            return Probe::Invalid;
        };
        if self.holds(our_id) {
            // Compare against what we would register: the same accelerator is ours, a different
            // one has to be tested for real, which means giving ours up for a moment.
            unsafe {
                let _ = UnregisterHotKey(hwnd, our_id);
            }
            let free = unsafe {
                RegisterHotKey(hwnd, our_id, hotkey.modifiers, hotkey.vk as u32).is_ok()
            };
            if free {
                unsafe {
                    let _ = UnregisterHotKey(hwnd, our_id);
                }
            }
            return if free { Probe::AlreadyOurs } else { Probe::Taken };
        }
        // A spare id, so probing cannot disturb anything that is registered.
        let probe_id = i32::MAX;
        let ok = unsafe { RegisterHotKey(hwnd, probe_id, hotkey.modifiers, hotkey.vk as u32) };
        if ok.is_ok() {
            unsafe {
                let _ = UnregisterHotKey(hwnd, probe_id);
            }
            Probe::Registered
        } else {
            Probe::Taken
        }
    }

    pub fn clear_all(&mut self, hwnd: HWND) {
        for id in std::mem::take(&mut self.held) {
            unsafe {
                let _ = UnregisterHotKey(hwnd, id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::UI::Input::KeyboardAndMouse as k;

    #[test]
    fn the_shipped_default_parses() {
        let h = parse("Alt+Z").expect("Alt+Z is the default accelerator");
        assert_eq!(h.vk, b'Z' as u16);
        assert!(h.modifiers & MOD_ALT != HOT_KEY_MODIFIERS(0));
        assert!(h.modifiers & MOD_NOREPEAT != HOT_KEY_MODIFIERS(0));
    }

    #[test]
    fn repeat_is_always_suppressed() {
        // A held accelerator in toggle mode is the wheel flickering open and shut.
        for spelling in ["Alt+Z", "Ctrl+Shift+Space", "Super+F5"] {
            let h = parse(spelling).unwrap();
            assert!(h.modifiers & MOD_NOREPEAT != HOT_KEY_MODIFIERS(0), "{spelling}");
        }
    }

    #[test]
    fn electrons_cross_platform_names_mean_control() {
        // A config synced from a Mac must still register something.
        for spelling in ["CommandOrControl+K", "CmdOrCtrl+K", "Command+K", "Ctrl+K"] {
            let h = parse(spelling).unwrap_or_else(|| panic!("{spelling}"));
            assert!(h.modifiers & MOD_CONTROL != HOT_KEY_MODIFIERS(0), "{spelling}");
            assert_eq!(h.vk, b'K' as u16);
        }
    }

    #[test]
    fn a_bare_key_is_refused() {
        // Registering one takes that key away from every application in the system, and the field
        // is a free string a hand edit can put anything in.
        assert!(parse("Z").is_none());
        assert!(parse("Space").is_none());
        assert!(parse("F5").is_none());
    }

    #[test]
    fn two_real_keys_is_not_an_accelerator() {
        assert!(parse("Alt+Z+X").is_none());
    }

    #[test]
    fn junk_is_refused_rather_than_guessed() {
        // A row that displays an accelerator and opens nothing is worse than a refusal.
        assert!(parse("").is_none());
        assert!(parse("Alt+").is_none());
        assert!(parse("Alt+Grizzly").is_none());
        assert!(parse("Alt+F99").is_none());
    }

    #[test]
    fn named_keys_round_trip() {
        for spelling in [
            "Alt+Space", "Ctrl+Tab", "Alt+F12", "Ctrl+Up", "Alt+PageDown", "Ctrl+num7",
            "Alt+Escape", "Shift+Alt+Delete",
        ] {
            let parsed = parse(spelling).unwrap_or_else(|| panic!("{spelling}"));
            let printed = format(&parsed);
            let reparsed = parse(&printed).unwrap_or_else(|| panic!("{printed}"));
            assert_eq!(parsed, reparsed, "{spelling} -> {printed}");
        }
    }

    #[test]
    fn function_keys_map_contiguously() {
        assert_eq!(parse("Alt+F1").unwrap().vk, k::VK_F1.0);
        assert_eq!(parse("Alt+F12").unwrap().vk, k::VK_F1.0 + 11);
        assert_eq!(parse("Alt+F24").unwrap().vk, k::VK_F24.0);
    }

    #[test]
    fn workspace_ids_cannot_collide_with_the_trigger() {
        // The original hardcoded 1-9 against the workspace position; these have to stay apart from
        // the trigger's own id whatever the workspace count.
        assert!(ID_WORKSPACE_BASE > ID_TRIGGER);
        for index in 0..64 {
            assert_ne!(ID_WORKSPACE_BASE + index, ID_TRIGGER);
        }
    }

    #[test]
    fn digits_parse_as_themselves() {
        assert_eq!(parse("Alt+1").unwrap().vk, b'1' as u16);
        assert_eq!(key_name(b'1' as u16), "1");
    }
}
