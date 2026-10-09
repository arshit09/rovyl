//! The configuration a fresh profile starts with, and the ranges every stored value is held to.
//!
//! Ported value for value from `src/defaults.ts` and `src/utils/screenDocks.ts`. The comments that
//! explain WHY a default is what it is came with those values and are kept, because each one
//! records a decision that is easy to undo by accident — most of them some variation of "an update
//! must not change what is already on somebody's screen".

use super::model::*;

/// Where the pool starts filling out into a sheet. Below this the scrim is the pool it always was.
pub const SCRIM_FLATTEN_FROM: f32 = 0.7;

/// Which scale a saved `backdrop_opacity` is written on.
///
/// Scale 1 (unmarked, everything shipped up to 1.6.0) topped out at 0.52 alpha under the wheel and
/// fell to nothing well inside the wheel's window — "100%" was half a pool. Scale 2 reaches an
/// opaque, monitor-wide fill at 1, which means the SAME stored number now paints something far
/// darker. So the number is converted once on read rather than reinterpreted, and the marker says
/// which side of the change a config was written on. Its absence is the whole test: nobody's
/// screen may go black because they upgraded.
pub const BACKDROP_DIM_SCALE: f32 = 2.0;

/// Q. It is next to Tab and Escape, so the hand that reaches for "get out of here" is already
/// there, and unlike W/E/R it is not next to anything that launches.
pub const DEFAULT_BACK_KEY: &str = "Q";

/// No key. A saved empty string is a deliberate choice and must survive hydration as one.
pub const BACK_KEY_OFF: &str = "";

pub const DWELL_MS_DEFAULT: f32 = 400.0;
/// Zero is a legitimate value, not an accidental floor: the wait is optional. At zero the direction
/// fires the instant it commits.
pub const DWELL_MS_MIN: f32 = 0.0;
pub const DWELL_MS_MAX: f32 = 2000.0;

/// Long enough that crossing the picker does not open every workspace on the way, short enough
/// that a deliberate rest reads as instant. Measured against the same hand the dwell is: a sweep
/// across a slice takes well under this, a stop takes none of it.
pub const PEEK_DELAY_MS_DEFAULT: f32 = 180.0;
/// Zero is a choice: the shortcuts appear the moment the workspace lights.
pub const PEEK_DELAY_MS_MIN: f32 = 0.0;
/// Past a second the feature is no longer "hover to see"; it is a wait nobody sits through.
pub const PEEK_DELAY_MS_MAX: f32 = 1000.0;

pub const STATUS_DOCK_ICON_MIN: i32 = 12;
pub const STATUS_DOCK_ICON_MAX: i32 = 32;
pub const SHORTCUT_DOCK_ICON_MIN: i32 = 24;
pub const SHORTCUT_DOCK_ICON_MAX: i32 = 88;
pub const DOCK_GAP_MIN: i32 = 0;
pub const DOCK_GAP_MAX: i32 = 48;

/// Off, like every other thing Rovyl draws outside the wheel itself.
///
/// The positions are the ones the docks are FOR — readouts bottom-right where Windows puts them,
/// so the eye already knows where to look, and shortcuts bottom-left where the taskbar's pinned
/// apps are. Turning a dock on should land it somewhere recognisable without a second decision.
pub fn status_dock() -> StatusDock {
    StatusDock {
        enabled: false,
        position: HudPosition::BottomRight,
        icon_size: 18,
        gap: 10,
        show_clock: true,
        show_battery: true,
        show_network: true,
        show_volume: true,
    }
}

pub fn shortcut_dock() -> ShortcutDock {
    ShortcutDock {
        enabled: false,
        position: HudPosition::BottomLeft,
        icon_size: 40,
        gap: 12,
        items: Vec::new(),
        show_labels: false,
    }
}

fn item(
    id: &str,
    label: &str,
    icon: &str,
    source: IconSource,
    command: &str,
    command_type: Option<CommandType>,
    description: &str,
) -> AppItem {
    AppItem {
        id: id.to_string(),
        kind: Some(ItemKind::App),
        label: label.to_string(),
        icon_name: icon.to_string(),
        icon_source: Some(source),
        command: command.to_string(),
        command_type,
        description: description.to_string(),
        ..AppItem::default()
    }
}

/// Main workspace before Start Menu discovery: empty — never the full demo wheel, which keeps the
/// wrong apps out of the first paint and off disk.
pub fn minimal_main_workspace_apps() -> Vec<AppItem> {
    Vec::new()
}

pub fn workspaces() -> Vec<Workspace> {
    vec![
        Workspace {
            id: "workspace-1".into(),
            name: "Main".into(),
            hotkey: 1,
            enabled: true,
            apps: minimal_main_workspace_apps(),
            color: Some("#3B82F6".into()),
            // Without this every workspace lands in the wheel with the same `Layers` and is told
            // apart only by name.
            picker_icon_name: Some("Home".into()),
            ..Workspace::default()
        },
        Workspace {
            id: "workspace-2".into(),
            name: "Streaming".into(),
            hotkey: 2,
            enabled: true,
            picker_icon_name: Some("MonitorPlay".into()),
            color: Some("#EF4444".into()),
            apps: vec![
                item(
                    "stream-1",
                    "YouTube",
                    "Youtube",
                    IconSource::Lucide,
                    "https://www.youtube.com/",
                    Some(CommandType::Url),
                    "Watch videos",
                ),
                item(
                    "stream-2",
                    "Twitch",
                    "Tv",
                    IconSource::Lucide,
                    "https://www.twitch.tv/",
                    Some(CommandType::Url),
                    "Live streaming",
                ),
                item(
                    "stream-4",
                    "Netflix",
                    "Clapperboard",
                    IconSource::Lucide,
                    "https://www.netflix.com/br/",
                    Some(CommandType::Url),
                    "Netflix Brasil",
                ),
            ],
            ..Workspace::default()
        },
        // The wheel Rovyl is shown with: AI tools, editors and design, on 3.
        //
        // Every command here is a Start Menu AppID rather than a path, because that is what Windows
        // hands back for these installers and what the launcher's AUMID branch already knows how to
        // turn into an executable. An entry whose app is not installed simply fails to launch — the
        // user deletes it, the same as any other item on the wheel.
        Workspace {
            id: "workspace-3".into(),
            name: "Build".into(),
            hotkey: 3,
            enabled: true,
            picker_icon_name: Some("Stars".into()),
            color: Some("#FFFFFF".into()),
            apps: vec![
                item(
                    "build-1",
                    "Claude",
                    "Bot",
                    IconSource::Native,
                    "Claude_pzs8sxrjxfjjc!Claude",
                    Some(CommandType::App),
                    "AI assistant",
                ),
                item(
                    "build-2",
                    "ChatGPT",
                    "MessageCircle",
                    IconSource::Lucide,
                    "https://chatgpt.com/",
                    Some(CommandType::Url),
                    "AI chat",
                ),
                item(
                    "build-3",
                    "Gemini",
                    "Sparkles",
                    IconSource::Lucide,
                    "https://gemini.google.com/app",
                    Some(CommandType::Url),
                    "AI chat",
                ),
                item(
                    "build-4",
                    "Cursor",
                    "Code2",
                    IconSource::Native,
                    "Anysphere.Cursor",
                    Some(CommandType::App),
                    "AI code editor",
                ),
                item(
                    "build-5",
                    "Antigravity",
                    "Binary",
                    IconSource::Native,
                    "electron.app.Antigravity",
                    Some(CommandType::App),
                    "AI IDE",
                ),
                item(
                    "build-6",
                    "Visual Studio Code",
                    "FileCode",
                    IconSource::Native,
                    "Microsoft.VisualStudioCode",
                    Some(CommandType::App),
                    "Code editor",
                ),
                item(
                    "build-7",
                    "Comet",
                    "Compass",
                    IconSource::Native,
                    "Comet.XC3C7ZDCXKJMBTAJSSDCPHARG4",
                    Some(CommandType::App),
                    "AI browser",
                ),
                item(
                    "build-8",
                    "Figma",
                    "Figma",
                    IconSource::Native,
                    "com.squirrel.Figma.Figma",
                    Some(CommandType::App),
                    "Design",
                ),
            ],
            ..Workspace::default()
        },
    ]
}

/// The bundled demo wheel's ids — Browser, Media Hub, Steam and the rest.
///
/// These are not real Start Menu picks. If Main still contains any of them after an earlier bug,
/// discovery is re-run to replace them.
pub const BUNDLED_DEMO_APP_IDS: &[&str] = &[
    "1a7a5818-4c99-4e4f-8a4d-3e28d4d7f5d7",
    "2b8b6818-5d99-4e4f-8a4d-3e28d4d7f5d8",
    "3c9c7818-6e99-4e4f-8a4d-3e28d4d7f5d9",
    "4da08818-7f99-4e4f-8a4d-3e28d4d7f5da",
    "5eb19818-8099-4e4f-8a4d-3e28d4d7f5db",
    "6fc2a818-9199-4e4f-8a4d-3e28d4d7f5dc",
    "70d3b818-a299-4e4f-8a4d-3e28d4d7f5dd",
    "81e4c818-b399-4e4f-8a4d-3e28d4d7f5de",
    "a306e818-d599-4e4f-8a4d-3e28d4d7f5e0",
    "antigravity-default",
    "cursor-default",
];

/// `UiConfig::default()` is the shipped configuration, not a zeroed struct.
///
/// A zeroed one would be a wheel with no radius, no tiles and no workspaces — which is not a state
/// the product has, and would be a silent and very confusing thing for a `..Default::default()` to
/// introduce at a call site.
impl Default for UiConfig {
    fn default() -> Self {
        ui_config()
    }
}

pub fn ui_config() -> UiConfig {
    UiConfig {
        accent_color: "#FFFFFF".into(),
        radial_hover_color: Some("#FFFFFF".into()),
        menu_radius: 140.0,
        icon_size: 64.0,
        fixed_position: true,
        // The main screen, which is where every wheel has opened until now. Following the pointer
        // is a better default for two monitors and a worse one for the person who put the wheel
        // somewhere on purpose — so it is offered, not imposed.
        radial_monitor: Some(RadialMonitor::Primary),
        // The centre of the screen, same reasoning as the monitor above.
        radial_placement: Some(RadialPlacement::Center),
        // Deliberately deep: at 0.9 the desktop is a dark suggestion behind the wheel (~0.85 alpha
        // under it, still falling off at the edge rather than a flat sheet), so the wheel is the
        // only thing on screen worth looking at. Note this is past `SCRIM_FLATTEN_FROM`, so the
        // overlay opens monitor-wide by default instead of as a box around the wheel.
        backdrop_opacity: 0.9,
        backdrop_dim_scale: Some(BACKDROP_DIM_SCALE),
        // Both off. They paint things beside the wheel that were never there, and the shortcut dock
        // is empty until somebody fills it — a strip of nothing appearing in the corner because a
        // person updated is not a feature arriving, it is a fault report.
        status_dock: Some(status_dock()),
        shortcut_dock: Some(shortcut_dock()),
        menu_background_style: Some("circle".into()),
        app_spacing: 10.0,
        activation_threshold: 60.0,
        center_button: CenterButton {
            kind: CenterKind::None,
            target: String::new(),
            label: String::new(),
            icon_name: "Circle".into(),
            command_type: None,
        },
        show_labels: true,
        always_show_app_labels: false,
        show_workspace_pill: Some(true),
        // On, both of them, with a different note for each so the two moments never sound alike.
        radial_sounds: Some(true),
        radial_open_sound: Some(true),
        radial_open_sound_id: Some("sub-tick".into()),
        radial_hover_sound: Some(true),
        radial_hover_sound_id: Some("thump".into()),
        radial_sound_volume: Some(100.0),
        show_battery: false,
        show_weather: false,
        weather_location: None,
        clock_position: Some(HudPosition::TopCenter),
        // On, in the top-right corner: Settings has no other visible door. The trigger key is the
        // only other way in, and somebody who has forgotten it has no way to be told it — so the
        // gear is worth what it costs, which is the overlay's cheap box.
        show_settings_corner: Some(true),
        settings_corner: Some(SettingsCorner::TopRight),
        game_mode: GameMode {
            enabled: false,
            mode: GameModeScope::List,
            blocked_apps: String::new(),
            auto_detect_games: false,
        },
        global_shortcut: "Alt+Z".into(),
        has_seen_onboarding: Some(false),
        has_seen_direction_hint: Some(false),
        workspaces: workspaces(),
        active_workspace_index: 0,
        appearance_theme: Some(Theme::Black),
        radial_selection_mode: Some(SelectionMode::Area),
        // The shares are aimed by but not drawn, which is the wheel every existing profile already
        // has. Turning the wedges on is a deliberate choice in Appearance.
        radial_area_wedges: Some(false),
        // Off by default: with this on, resting the mouse over an icon LAUNCHES IT. Changing the
        // behaviour under someone already using the wheel would turn a neutral gesture (aiming)
        // into a destructive one.
        radial_instant_activate: Some(InstantActivate::Off),
        radial_instant_dwell_ms: Some(DWELL_MS_DEFAULT),
        radial_instant_sensitivity: Some(Sensitivity::Medium),
        // Off, like every other setting here that changes what an existing gesture DOES. Typing on
        // an open wheel filters it; turning this on makes nine of those keys launch instead.
        radial_number_launch: Some(false),
        // On, so that turning the feature on is enough to see where the numbers are.
        radial_number_labels: Some(true),
        radial_back_key: Some(DEFAULT_BACK_KEY.into()),
        // Off, for the reason every switch in this group is off: it changes what crossing the
        // picker DOES, and an update must not start moving shortcuts under a hand that asked for
        // nothing. The style only matters once it is on.
        radial_workspace_peek: Some(false),
        radial_workspace_peek_style: Some(PeekStyle::Fan),
        radial_workspace_peek_delay_ms: Some(PEEK_DELAY_MS_DEFAULT),
        enable_keyboard_trigger: Some(true),
        enable_mouse_trigger: true,
        mouse_trigger_mode: Some(TriggerMode::Click),
        mouse_trigger_button: Some("middle".into()),
        shortcut_trigger_mode: Some(ShortcutTriggerMode::Toggle),
        // On: a launcher that has to be started by hand is not there when the wheel is reached
        // for, so a new install signs in ready — into the tray, not into Settings. Existing
        // profiles keep what they have; hydration holds a config saved before this key at `false`.
        open_at_login: Some(true),
        language: "en".into(),
        main_start_menu_discovery_done: Some(false),
        persistence_meta: None,
        extra: Extra::new(),
    }
}
