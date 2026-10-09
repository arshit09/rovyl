//! The configuration: its shape, its defaults, what a missing key means, and where it lives.

pub mod defaults;
pub mod model;
pub mod normalize;
pub mod snippet;
pub mod store;

pub use model::*;

// ─── Derived reads ──────────────────────────────────────────────────────────
//
// Questions about the config that more than one part of the app asks. They live here rather than
// at the call sites for the reason the Electron build gives for `screenDocks.ts`: the wheel, the
// settings panel and the window sizing all need the same answers, and a second copy of one of them
// is how the three drift apart.

impl UiConfig {
    pub fn hover_color(&self) -> u32 {
        parse_hex_rgb(self.radial_hover_color.as_deref()).unwrap_or(0xFF_FF_FF)
    }

    pub fn accent(&self) -> u32 {
        parse_hex_rgb(Some(&self.accent_color)).unwrap_or(0xFF_FF_FF)
    }

    pub fn theme(&self) -> Theme {
        self.appearance_theme.unwrap_or(Theme::Black)
    }

    pub fn monitor_choice(&self) -> RadialMonitor {
        self.radial_monitor.unwrap_or(RadialMonitor::Primary)
    }

    pub fn placement(&self) -> RadialPlacement {
        self.radial_placement.unwrap_or(RadialPlacement::Center)
    }

    /// `swipe` is coerced to `off` here as well as in hydration, because a config can be mutated
    /// in memory by the settings panel and this is the read every gesture goes through.
    pub fn instant_activate(&self) -> InstantActivate {
        match self.radial_instant_activate {
            Some(InstantActivate::Dwell) => InstantActivate::Dwell,
            _ => InstantActivate::Off,
        }
    }

    /// Whether the wheel aims by direction with the pointer hidden and parked at the centre.
    pub fn direction_mode(&self) -> bool {
        matches!(self.instant_activate(), InstantActivate::Dwell)
    }

    pub fn selection_mode(&self) -> SelectionMode {
        match self.radial_selection_mode {
            Some(SelectionMode::Cursor) => SelectionMode::Cursor,
            _ => SelectionMode::Area,
        }
    }

    /// Area targeting, DRAWN.
    ///
    /// Two conditions and not one. The mode says the target is a share of the plane; the switch
    /// says whether that share is shown. Pointer targeting is the one mode it cannot mean: there
    /// the target is the icon and not the sector, so a wedge would promise an area that does not
    /// launch anything.
    pub fn area_wedges(&self) -> bool {
        !matches!(self.selection_mode(), SelectionMode::Cursor)
            && self.radial_area_wedges == Some(true)
    }

    pub fn dwell_ms(&self) -> f32 {
        self.radial_instant_dwell_ms
            .unwrap_or(defaults::DWELL_MS_DEFAULT)
            .clamp(defaults::DWELL_MS_MIN, defaults::DWELL_MS_MAX)
    }

    pub fn sensitivity(&self) -> Sensitivity {
        self.radial_instant_sensitivity.unwrap_or(Sensitivity::Medium)
    }

    /// Pixels of travel the current direction needs to light up a slice.
    ///
    /// High is short on purpose — but not below ~16px: a gaming mouse at 1600 DPI produces a dozen
    /// pixels just from the hand settling, and a wheel that chooses on that chooses by itself.
    /// These are read in DIPs of CURSOR travel, not of hand travel: Windows pointer acceleration
    /// multiplies a fast push, so 84px of cursor is a few centimetres of desk at most.
    ///
    /// Ceiling: they have to stay clear of the re-park radius, or the direction could never commit
    /// before the cursor is warped back to the centre.
    pub fn direction_commit_px(&self) -> f32 {
        match self.sensitivity() {
            Sensitivity::High => 18.0,
            Sensitivity::Medium => 96.0,
            Sensitivity::Low => 200.0,
        }
    }

    pub fn number_launch(&self) -> bool {
        self.radial_number_launch == Some(true)
    }

    /// Whether tiles carry their digit. Means nothing on its own: with number launching off, no
    /// tile is numbered whatever this says.
    pub fn number_badges(&self) -> bool {
        self.number_launch() && self.radial_number_labels != Some(false)
    }

    /// The key that leaves a folder. Means nothing while `radial_number_launch` is off — that
    /// switch owns the keyboard-driven wheel and this key is part of it. A binding that acts with
    /// no visible setting behind it is indistinguishable from a bug.
    pub fn back_key(&self) -> &str {
        if !self.number_launch() {
            return "";
        }
        self.radial_back_key.as_deref().unwrap_or("")
    }

    pub fn show_pill(&self) -> bool {
        self.show_workspace_pill != Some(false)
    }

    pub fn sounds_on(&self) -> bool {
        self.radial_sounds != Some(false)
    }

    pub fn open_sound_on(&self) -> bool {
        self.sounds_on() && self.radial_open_sound != Some(false)
    }

    pub fn hover_sound_on(&self) -> bool {
        self.sounds_on() && self.radial_hover_sound != Some(false)
    }

    pub fn sound_volume(&self) -> f32 {
        self.radial_sound_volume.unwrap_or(100.0).clamp(0.0, 100.0) / 100.0
    }

    pub fn keyboard_trigger_on(&self) -> bool {
        self.enable_keyboard_trigger != Some(false)
    }

    pub fn status_dock_cfg(&self) -> StatusDock {
        self.status_dock
            .clone()
            .unwrap_or_else(defaults::status_dock)
    }

    pub fn shortcut_dock_cfg(&self) -> ShortcutDock {
        self.shortcut_dock
            .clone()
            .unwrap_or_else(defaults::shortcut_dock)
    }

    /// The gear is NOT offered while click-free launching aims by direction: that mode hides the
    /// pointer and parks it at the centre, so there is no way to reach a corner, and a click
    /// anywhere launches whatever the gesture is pointing at. It hides itself rather than sit on
    /// screen unclickable.
    pub fn gear_visible(&self) -> bool {
        self.show_settings_corner == Some(true) && !self.direction_mode()
    }

    pub fn gear_corner(&self) -> SettingsCorner {
        self.settings_corner.unwrap_or(SettingsCorner::TopRight)
    }

    pub fn enabled_workspace_count(&self) -> usize {
        self.workspaces.iter().filter(|w| w.enabled).count()
    }

    pub fn active_workspace(&self) -> Option<&Workspace> {
        self.workspaces.get(self.active_workspace_index)
    }

    /// Whether the overlay window has to reach the screen edges instead of opening as a box around
    /// the wheel.
    ///
    /// Three separate things ask for it and they are all the same request: a corner that is not the
    /// SCREEN's corner is a thing floating a couple of hundred pixels off the wheel on a diagonal,
    /// and a scrim with alpha left at the window's edge is a dark rectangle with four hard sides
    /// sitting on a bright desktop.
    pub fn needs_full_bleed(&self) -> bool {
        crate::wheel::scrim::needs_full_bleed(self.backdrop_opacity)
            || self.gear_visible()
            || self.status_dock_cfg().is_active()
            || self.shortcut_dock_cfg().is_active()
    }
}

// ─── Workspace keys ─────────────────────────────────────────────────────────

/// No key at all — the workspace stays reachable through the picker wheel and the mouse wheel.
pub const WORKSPACE_KEY_NONE: &str = "";

/// The shipped key for a position: 1–9 counting down the list, nothing past the ninth.
///
/// This is the DEFAULT, not the binding. It follows the position — reorder the list and the keys
/// follow — which is what anybody who never touches the field still gets.
pub fn positional_workspace_key(index: usize) -> String {
    if index < 9 {
        (index + 1).to_string()
    } else {
        WORKSPACE_KEY_NONE.to_string()
    }
}

/// The stored form of a recorded key: one character, upper case.
///
/// Unlike the back key, digits are allowed — they are what this field ships with. A key event
/// carries the CHARACTER the layout produced, so the physical key someone pressed on AZERTY is
/// stored as the character it prints, which is the one they will press again.
pub fn normalize_workspace_key(value: Option<&str>) -> String {
    let Some(trimmed) = value.map(str::trim).filter(|s| !s.is_empty()) else {
        return WORKSPACE_KEY_NONE.to_string();
    };
    let mut chars = trimmed.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) => c.to_uppercase().collect(),
        _ => WORKSPACE_KEY_NONE.to_string(),
    }
}

/// What this workspace actually answers to.
///
/// `hotkey_key`'s ABSENCE is meaningful: `None` means "whatever this position gets", so a
/// workspace nobody has edited keeps following its position forever. `Some("")` is the deliberate
/// "no key" — what taking a key away from a workspace leaves behind — and it has to survive a
/// reorder, which a positional default would not.
///
/// A stored value that is not a single character is read as absent rather than as none: that is a
/// hand-edited or corrupted config, and falling back to the position leaves the workspace
/// reachable instead of silently mute.
pub fn workspace_key_at(workspace: &Workspace, index: usize) -> String {
    let Some(stored) = workspace.hotkey_key.as_deref() else {
        return positional_workspace_key(index);
    };
    if stored.trim().is_empty() {
        return WORKSPACE_KEY_NONE.to_string();
    }
    let normalized = normalize_workspace_key(Some(stored));
    if normalized.is_empty() {
        positional_workspace_key(index)
    } else {
        normalized
    }
}

/// Whether this workspace is still on its positional default — what the recorder calls "Default".
pub fn is_default_workspace_key(workspace: &Workspace) -> bool {
    workspace.hotkey_key.is_none()
}

/// Every workspace that has a key, paired with its index.
///
/// Two workspaces cannot both answer to K, and the recorder refuses to create that state, so this
/// only resolves duplicates that arrived some other way: a hand-edited config, an imported
/// workspace file, or — the one that happens by accident — a reorder. Record 3 for a workspace at
/// the top of the list, drag another into third place, and its positional default is now that same
/// digit.
///
/// A RECORDED key therefore beats a positional one, whatever their order. The alternative is that
/// a key somebody deliberately chose stops working because an unrelated workspace was dragged
/// somewhere, and the one that gives way is the one whose key was never chosen in the first place.
/// Between two of the same kind, the earlier wins — an arbitrary rule, but a fixed one, where
/// registration order is neither.
pub fn workspace_key_bindings(config: &UiConfig) -> Vec<(String, usize)> {
    let mut bindings: Vec<(String, usize)> = Vec::new();
    let mut seen: Vec<String> = Vec::new();

    for recorded in [true, false] {
        for (index, workspace) in config.workspaces.iter().enumerate() {
            if is_default_workspace_key(workspace) == recorded {
                continue;
            }
            let key = workspace_key_at(workspace, index);
            if key.is_empty() || seen.contains(&key) {
                continue;
            }
            seen.push(key.clone());
            bindings.push((key, index));
        }
    }

    // In wheel order, not in claim order: this is read by people reading a log, and by nothing else.
    bindings.sort_by_key(|(_, index)| *index);
    bindings
}

// ─── Colour ─────────────────────────────────────────────────────────────────

/// `#rrggbb` as `0x00RRGGBB`. `None` for anything else, so a caller supplies its own fallback
/// rather than inheriting black from a typo.
pub fn parse_hex_rgb(value: Option<&str>) -> Option<u32> {
    let s = value?.trim().strip_prefix('#')?;
    if s.len() != 6 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    u32::from_str_radix(s, 16).ok()
}

/// Keeps icons and labels readable when the user picks a light or dark hover colour.
///
/// The threshold is 0.56 rather than 0.5 because the foreground is a 1.75-weight glyph, not a
/// filled shape: a thin white stroke gives up first, so the swap to black happens slightly before
/// the midpoint.
pub fn readable_foreground(background: u32) -> u32 {
    let r = ((background >> 16) & 0xFF) as f32;
    let g = ((background >> 8) & 0xFF) as f32;
    let b = (background & 0xFF) as f32;
    let luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0;
    if luminance > 0.56 {
        0x00_00_00
    } else {
        0xFF_FF_FF
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recorded_key_beats_a_positional_collision() {
        // Workspace 0 recorded "3"; workspace 2's positional default is also "3". The recorded one
        // keeps it, and the other goes quiet rather than stealing it back on the next renumber.
        let mut cfg = defaults::ui_config();
        cfg.workspaces = vec![
            Workspace { id: "a".into(), hotkey_key: Some("3".into()), ..Workspace::default() },
            Workspace { id: "b".into(), ..Workspace::default() },
            Workspace { id: "c".into(), ..Workspace::default() },
        ];
        let bindings = workspace_key_bindings(&cfg);
        assert!(bindings.contains(&("3".to_string(), 0)));
        assert!(!bindings.iter().any(|(_, i)| *i == 2));
    }

    #[test]
    fn empty_hotkey_key_is_deliberate_silence() {
        let ws = Workspace { hotkey_key: Some(String::new()), ..Workspace::default() };
        assert_eq!(workspace_key_at(&ws, 0), "");
        // Absent follows the position instead.
        let ws = Workspace { hotkey_key: None, ..Workspace::default() };
        assert_eq!(workspace_key_at(&ws, 0), "1");
    }

    #[test]
    fn back_key_is_inert_without_number_launch() {
        // A binding that acts with no visible setting behind it is indistinguishable from a bug.
        let mut cfg = defaults::ui_config();
        cfg.radial_back_key = Some("Q".into());
        cfg.radial_number_launch = Some(false);
        assert_eq!(cfg.back_key(), "");
        cfg.radial_number_launch = Some(true);
        assert_eq!(cfg.back_key(), "Q");
    }

    #[test]
    fn hover_foreground_flips_on_light_colours() {
        assert_eq!(readable_foreground(0xFFFFFF), 0x000000);
        assert_eq!(readable_foreground(0x101014), 0xFFFFFF);
    }

    #[test]
    fn gear_withdraws_in_direction_mode() {
        // An icon that cannot be pressed is worse than no icon: the click that tried would launch
        // whatever the gesture was aiming across.
        let mut cfg = defaults::ui_config();
        cfg.show_settings_corner = Some(true);
        assert!(cfg.gear_visible());
        cfg.radial_instant_activate = Some(InstantActivate::Dwell);
        assert!(!cfg.gear_visible());
    }
}
