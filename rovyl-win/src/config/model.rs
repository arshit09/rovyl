//! The persisted data model, field for field as `config-v2.json` on disk holds it.
//!
//! This is a deliberate mirror of the Electron build's `src/types.ts`, down to the key spellings,
//! because both read and write the SAME file in `%APPDATA%\Rovyl`. A port that invented its own
//! shape would be a port that silently discards the user's workspaces on first launch.
//!
//! Three rules carry everything below:
//!
//! 1. **Every optional field keeps its `Option`.** Absence is information: a config written before
//!    a switch existed must not read as "the user turned that off". The defaults are applied in
//!    `normalize::hydrate`, exactly where `normalizeStoredConfig` applies them.
//! 2. **Unknown keys survive a round trip.** `extra` collects anything this build does not know
//!    about, so running the native port and then the Electron one again does not strip settings
//!    the other half added. Dropping them would make the two builds lossy against each other.
//! 3. **Nothing here validates.** Clamping and normalising live in `normalize.rs`; this module is
//!    only the shape. Keeping them apart is what lets the clamps be tested without a file.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// Anything in the JSON this build has no field for, kept so a round trip is lossless.
pub type Extra = BTreeMap<String, Value>;

pub(crate) fn yes() -> bool {
    true
}

// ─── Enums ──────────────────────────────────────────────────────────────────
//
// Every one of these sits behind an `Option<T>` at its use site and falls back in `normalize.rs`,
// so an unknown string from a hand-edited file lands on the default rather than failing the whole
// parse. That is the difference between a typo in one key and a lost configuration.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemKind {
    App,
    Folder,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IconSource {
    /// The `icon_name` glyph.
    Lucide,
    /// A bitmap Rovyl found by itself — the program's icon, the site's favicon. Kept up to date by
    /// the healing pass and re-extracted when the pipeline version changes.
    Native,
    /// The user chose it. Nothing automatic ever replaces it.
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandType {
    App,
    Url,
    Folder,
    /// A document and not a program: handed to the shell, which opens it in whatever Windows has
    /// registered for the extension. Deliberately not `App` — the app ladder builds
    /// `<terminal> /c <line>`, and a `.pdf` down that route opens a console window or nothing.
    File,
    Command,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandShell {
    Powershell,
    Cmd,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandWindow {
    Open,
    Hidden,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LaunchMode {
    Normal,
    /// Hand the target to an already-running instance instead of starting a second one.
    Reuse,
    /// Warm the files in the Windows cache without opening anything.
    Prewarm,
}

/// Theme for the opaque surfaces (titlebar + Settings). The wheel always stays dark: it is an
/// overlay on the desktop, not a surface of the product.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Black,
    White,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RadialMonitor {
    /// Always the main screen, wherever the hand is. The default, and what shipped.
    Primary,
    /// The screen the pointer is on, so what gets launched lands in front of the user.
    Cursor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RadialPlacement {
    Center,
    Cursor,
}

/// How the wheel decides the target.
///
/// `angle` was a third value and is gone: it aimed exactly as `Area` does and differed only in
/// whether the shares were painted, which is `radial_area_wedges` now. Configs carrying it are
/// rewritten on read — see `normalize::hydrate`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SelectionMode {
    /// Only lights up when the pointer is right over the icon.
    Cursor,
    /// Direction from the centre: the plane is cut into as many equal shares as there are items,
    /// and the one pointed at is the target with the cursor anywhere inside its share.
    Area,
    /// Read as `Area`. Kept so a stored `"angle"` parses instead of poisoning the file.
    Angle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InstantActivate {
    Off,
    /// RESERVED and read as `Off` everywhere. Declared so a future implementation does not have to
    /// migrate configs; the gesture needs the pointer to start at the wheel centre, and by default
    /// it does not.
    Swipe,
    /// Holding the aim on a target for `radial_instant_dwell_ms` launches it.
    Dwell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Sensitivity {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TriggerMode {
    /// A click opens and leaves the wheel open.
    Click,
    /// Holding opens; releasing runs the selection.
    Hold,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShortcutTriggerMode {
    Toggle,
    Hold,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GameModeScope {
    /// Any fullscreen app.
    All,
    /// Only apps from the list, and only in fullscreen.
    List,
}

/// The six regions a HUD element or a dock may occupy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HudPosition {
    TopLeft,
    TopCenter,
    TopRight,
    BottomLeft,
    BottomCenter,
    BottomRight,
}

impl HudPosition {
    /// Whether this region sits against the top edge. The docks stack inboard from their own edge,
    /// so everything placed from it needs to know which way "inboard" runs.
    pub fn is_top(self) -> bool {
        matches!(
            self,
            HudPosition::TopLeft | HudPosition::TopCenter | HudPosition::TopRight
        )
    }
}

/// Where the settings gear may sit while the wheel is open.
///
/// Corners only, unlike the HUD's regions: the middle of an edge is the one place a small target
/// must not be, because that is where a wedge aimed at the top or the bottom of the wheel ends up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SettingsCorner {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

impl SettingsCorner {
    pub fn as_hud(self) -> HudPosition {
        match self {
            SettingsCorner::TopLeft => HudPosition::TopLeft,
            SettingsCorner::TopRight => HudPosition::TopRight,
            SettingsCorner::BottomLeft => HudPosition::BottomLeft,
            SettingsCorner::BottomRight => HudPosition::BottomRight,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CenterKind {
    App,
    /// Kept only to read old configs — the built-in widgets were removed.
    Widget,
    Command,
    None,
    Cancel,
}

// ─── AppItem ────────────────────────────────────────────────────────────────

/// One thing on the wheel: a shortcut, or a folder holding more of them.
/// `PartialEq` is derived so an `Action` carrying an item can be compared in tests. It is a
/// structural comparison and NOT an identity one — two items with the same `id` but different
/// labels are unequal. Anything that means "is this the same shortcut" compares `id`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppItem {
    #[serde(default)]
    pub id: String,
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<ItemKind>,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub icon_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_source: Option<IconSource>,
    /// `rovyl-icon://` reference to a file in userData, an `https:` favicon, or a legacy `data:` URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_icon_url: Option<String>,
    /// The file a custom picture was taken from, as Windows writes an icon location:
    /// `C:\Icons\app.png`, or `C:\Windows\System32\shell32.dll,4` for the fifth icon in a library.
    /// Only here so the workspace file can name it; the picture itself is `custom_icon_url`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_icon_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
    #[serde(default)]
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_type: Option<CommandType>,
    /// `Command` only: which shell reads the line, and whether a console window shows it. Unset
    /// means PowerShell in a window that stays open, so the output of a typo can still be read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_shell: Option<CommandShell>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_window: Option<CommandWindow>,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shortcut: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<AppItem>>,
    /// Whether this item opens a ring of its own most-recently-used projects.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_recents: Option<bool>,
    /// When true, MRU sub-items also spawn a terminal in the selected project folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_terminal_for_recents: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_terminal: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_commands: Option<Vec<String>>,
    /// Explicit directory for terminal/commands; avoids inferring cwd from the IDE's launch line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_mode: Option<LaunchMode>,
    #[serde(flatten)]
    pub extra: Extra,
}

impl Default for AppItem {
    fn default() -> Self {
        Self {
            id: String::new(),
            kind: Some(ItemKind::App),
            label: String::new(),
            icon_name: String::new(),
            icon_source: None,
            custom_icon_url: None,
            custom_icon_file: None,
            direction: None,
            command: String::new(),
            command_type: None,
            command_shell: None,
            command_window: None,
            description: String::new(),
            shortcut: None,
            children: None,
            has_recents: None,
            open_terminal_for_recents: None,
            open_terminal: None,
            terminal_commands: None,
            working_directory: None,
            launch_mode: None,
            extra: Extra::new(),
        }
    }
}

impl AppItem {
    pub fn is_folder(&self) -> bool {
        matches!(self.kind, Some(ItemKind::Folder))
    }

    pub fn child_slice(&self) -> &[AppItem] {
        self.children.as_deref().unwrap_or(&[])
    }

    pub fn wants_recents(&self) -> bool {
        self.has_recents.unwrap_or(false)
    }

    /// What `command` is, with the guess the Electron build's launcher makes when the field is
    /// absent. Old items carry no `commandType` at all.
    pub fn resolved_command_type(&self) -> CommandType {
        if let Some(kind) = self.command_type {
            return kind;
        }
        let c = self.command.trim();
        let lower = c.to_ascii_lowercase();
        if lower.starts_with("http://") || lower.starts_with("https://") {
            CommandType::Url
        } else {
            CommandType::App
        }
    }
}

// ─── Workspace ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub apps: Vec<AppItem>,
    /// The POSITIONAL number key: 1–9 by place in the list, zero past the ninth. Renumbered on
    /// every reorder and every delete, so it always describes the position and never the workspace.
    ///
    /// It is the default, not the binding — read `workspace_key_at`, which prefers `hotkey_key`.
    #[serde(default)]
    pub hotkey: u32,
    /// A key recorded for THIS workspace, which outranks the positional digit above.
    ///
    /// Three states, and the difference between two of them is the whole point:
    ///   `None`     — never edited, so the workspace follows its position and keeps doing so after
    ///                a reorder. This is what every existing config has.
    ///   `Some("")` — deliberately no key, which is what is left behind when the key is given to
    ///                something else. It survives a reorder; a missing field would not.
    ///   `Some(k)`  — that key, as the single upper-case character the layout prints.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hotkey_key: Option<String>,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Glyph on the home launcher — the wheel's first level. Omitted → `Layers`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub picker_icon_name: Option<String>,
    /// A picture chosen for the workspace, drawn instead of `picker_icon_name`. The glyph stays as
    /// the fallback if the file is gone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub picker_icon_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub picker_icon_file: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

impl Default for Workspace {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            apps: Vec::new(),
            hotkey: 0,
            hotkey_key: None,
            enabled: true,
            color: None,
            picker_icon_name: None,
            picker_icon_url: None,
            picker_icon_file: None,
            extra: Extra::new(),
        }
    }
}

// ─── Docks ──────────────────────────────────────────────────────────────────

/// The readouts — clock, battery, network, volume — in one region of the open wheel.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusDock {
    pub enabled: bool,
    pub position: HudPosition,
    /// Edge length of one icon box, in DIPs.
    pub icon_size: i32,
    /// Space between neighbouring items, in DIPs.
    pub gap: i32,
    pub show_clock: bool,
    pub show_battery: bool,
    pub show_network: bool,
    pub show_volume: bool,
}

impl StatusDock {
    /// Whether the dock would show anything at all.
    ///
    /// Enabled with all four readouts switched off is a dock with nothing in it, and it has to be
    /// recognised as one HERE rather than by the renderer: this is what decides that the
    /// system-status reader is never started, so a dock left on with everything unticked costs
    /// what off costs.
    pub fn is_active(&self) -> bool {
        self.enabled
            && (self.show_clock || self.show_battery || self.show_network || self.show_volume)
    }

    /// The readouts that need live sampling. A clock-only dock is drawn from the system clock and
    /// costs nothing.
    pub fn needs_sampler(&self) -> bool {
        self.enabled && (self.show_battery || self.show_network || self.show_volume)
    }
}

/// The icons the user put there. Ordinary `AppItem`s, so one launch path serves them and the wheel.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutDock {
    pub enabled: bool,
    pub position: HudPosition,
    pub icon_size: i32,
    pub gap: i32,
    #[serde(default)]
    pub items: Vec<AppItem>,
    /// Name under each icon. Off by default: a dock of eight names is a menu, not a strip.
    pub show_labels: bool,
}

impl ShortcutDock {
    pub fn is_active(&self) -> bool {
        self.enabled && !self.items.is_empty()
    }
}

// ─── Game mode ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameMode {
    pub enabled: bool,
    pub mode: GameModeScope,
    #[serde(default)]
    pub blocked_apps: String,
    /// Auto-detects fullscreen games by folder, launcher and engine markers.
    #[serde(default)]
    pub auto_detect_games: bool,
}

// ─── Center button ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CenterButton {
    #[serde(rename = "type")]
    pub kind: CenterKind,
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub icon_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_type: Option<CommandType>,
}

// ─── User profile ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserProfile {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub is_premium: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_tier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_admin: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trial_ends_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

// ─── Persistence meta ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistenceMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_first_run_completed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_successful_load: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
}

// ─── UIConfig ───────────────────────────────────────────────────────────────

/// Everything the wheel and the settings panel read.
///
/// The `Option`s are not laziness: each one marks a key that a config written by an older build
/// can be missing, and `normalize::hydrate` is the single place that decides what absence means.
/// A field made non-optional here is a field whose absence silently becomes `Default::default()`
/// in a thousand places instead of once.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiConfig {
    #[serde(default)]
    pub accent_color: String,
    /// Colour applied to the item pointed at. Optional for compatibility with old configs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radial_hover_color: Option<String>,
    #[serde(default)]
    pub menu_radius: f32,
    #[serde(default)]
    pub icon_size: f32,
    /// No longer configurable — the wheel is always born at the centre of its own window. Kept
    /// only to read old configs, which hydration normalises to `true`.
    ///
    /// Not to be confused with `radial_monitor`: that one is live, and it chooses a SCREEN. This
    /// one chose a POINT, which is the part that is gone.
    #[serde(default = "yes")]
    pub fixed_position: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radial_monitor: Option<RadialMonitor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radial_placement: Option<RadialPlacement>,
    /// "Background dimming", 0..1. Read it through `scrim::alphas` — the number is not an alpha,
    /// and how it maps to one changed. `backdrop_dim_scale` says which mapping a saved value
    /// belongs to.
    #[serde(default)]
    pub backdrop_opacity: f32,
    /// Which scale `backdrop_opacity` is written on. ABSENT means the config predates the scale
    /// that reaches a black screen, and hydration converts the value once so the dimming looks
    /// exactly as it did before the upgrade.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backdrop_dim_scale: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_dock: Option<StatusDock>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shortcut_dock: Option<ShortcutDock>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub menu_background_style: Option<String>,
    #[serde(default)]
    pub app_spacing: f32,
    #[serde(default)]
    pub activation_threshold: f32,
    pub center_button: CenterButton,
    #[serde(default = "yes")]
    pub show_labels: bool,
    /// When true, names stay visible for all items; when false, only the aimed one shows its label.
    #[serde(default)]
    pub always_show_app_labels: bool,
    /// The pill under the wheel naming where you are (workspace, then folders). Absent means on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_workspace_pill: Option<bool>,
    /// Sound effects, all of them. The two below only count while this is on, and are read the
    /// same way: absent means on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radial_sounds: Option<bool>,
    /// A note as the wheel blooms open — once per open, not on every folder or workspace swap.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radial_open_sound: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radial_open_sound_id: Option<String>,
    /// A note each time the highlight moves to a different item.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radial_hover_sound: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radial_hover_sound_id: Option<String>,
    /// One volume for both notes, 0–100. 100 is the level they were tuned at.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radial_sound_volume: Option<f32>,
    #[serde(default)]
    pub show_battery: bool,
    #[serde(default)]
    pub show_weather: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weather_location: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clock_position: Option<HudPosition>,
    pub game_mode: GameMode,
    #[serde(default)]
    pub global_shortcut: String,
    /// Whether the first-run card has been dismissed. Absent means "not yet" — and any config that
    /// came off disk is marked true on load, so it can only ever be false on a genuinely new
    /// profile.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_seen_onboarding: Option<bool>,
    /// Whether the direction-mode hint has had its one showing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_seen_direction_hint: Option<bool>,
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
    #[serde(default)]
    pub active_workspace_index: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub appearance_theme: Option<Theme>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radial_selection_mode: Option<SelectionMode>,
    /// Whether area targeting DRAWS the division it aims by. Off by default: the same aim, nothing
    /// painted — which is what the wheel has always looked like, and an update must not repaint the
    /// screen of somebody who asked for nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radial_area_wedges: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radial_instant_activate: Option<InstantActivate>,
    /// Milliseconds of continuous aim before the target runs. Clamped to [0, 2000], and zero is a
    /// choice and not a floor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radial_instant_dwell_ms: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radial_instant_sensitivity: Option<Sensitivity>,
    /// Number keys pick AND run: while the wheel is up, 1–9 launch the shortcut in that position.
    /// Off by default: it turns a keystroke that filtered into one that launches.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radial_number_launch: Option<bool>,
    /// Whether each tile carries its digit while `radial_number_launch` is on. Absent means on: a
    /// number you cannot see is a number you have to count to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radial_number_labels: Option<bool>,
    /// The single key that leaves a folder — the hub's keyboard equivalent. Stored upper case; an
    /// empty string means no key at all. Means nothing while `radial_number_launch` is off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radial_back_key: Option<String>,
    /// A gear in a corner of the open wheel, which opens Settings. Turning it on makes the overlay
    /// cover the whole monitor, because a "corner" of the wheel's own box is not a corner of the
    /// screen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_settings_corner: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings_corner: Option<SettingsCorner>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_at_login: Option<bool>,
    /// Whether the global shortcut opens the wheel at all. Absent means yes: every config written
    /// before this key existed had a working keyboard trigger.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enable_keyboard_trigger: Option<bool>,
    #[serde(default = "yes")]
    pub enable_mouse_trigger: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mouse_trigger_mode: Option<TriggerMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shortcut_trigger_mode: Option<ShortcutTriggerMode>,
    /// The button that opens the wheel, as a binding rather than a name: a button plus the
    /// modifiers held with it — `middle`, `x1`, `Ctrl+left`, `Alt+Shift+x2`.
    ///
    /// Left as a plain string: the set of buttons a mouse can report is not a list this type
    /// should pretend to close.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mouse_trigger_button: Option<String>,
    #[serde(default)]
    pub language: String,
    /// Start Menu discovery already ran, or Main was saved with custom apps — do not import
    /// shortcuts again at startup.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub main_start_menu_discovery_done: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persistence_meta: Option<PersistenceMeta>,
    #[serde(flatten)]
    pub extra: Extra,
}

// ─── The whole blob ─────────────────────────────────────────────────────────

/// `config-v2.json` in its nested (v2) shape: `{ user, apps?, config }`.
///
/// `apps` is legacy — a flat list that predates workspaces. It is kept so a file written by a very
/// old build round-trips, and `normalize::from_disk` is what repairs a config whose `workspaces`
/// is empty but whose root `apps` is not.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Persisted {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<UserProfile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub apps: Option<Vec<AppItem>>,
    pub config: UiConfig,
}
