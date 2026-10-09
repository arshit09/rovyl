//! Everything a config has to be put through between coming off disk and being believed.
//!
//! A port of `src/configHydration.ts` plus `backend/persistence-normalize.cjs` plus the clamps in
//! `src/utils/screenDocks.ts`. The three were separate files in the Electron build for a reason
//! worth keeping: one of them answers "what shape is this blob", one answers "what do the missing
//! keys mean", and one answers "is this number in range". They run in that order and nothing
//! downstream re-asks any of the questions.
//!
//! The one structural decision here: hydration merges JSON values rather than struct fields.
//!
//! `normalizeStoredConfig` is written as `{ ...DEFAULT_UI_CONFIG, ...loaded }`, and the behaviour
//! that matters is not the merge, it is that ABSENCE is observable — eight separate rules below
//! turn on whether a key is in the file at all, not on what its value is. Deserialising straight
//! into the struct would spend that information before any of them could read it: a missing
//! `openAtLogin` and a stored `false` would arrive identically, and every existing profile would
//! get an entry in its startup list on the first launch after the port. So the raw `Value` is kept
//! until the presence tests are done.

use super::defaults;
use super::model::*;
use serde_json::{Map, Value};

// ─── Blob shape ─────────────────────────────────────────────────────────────

/// Top-level keys of the full persistence blob (v2). Everything else in a flat legacy file is
/// treated as `UiConfig`.
///
/// `notes` / `alarms` / `noteWorkspaces` / `activeNoteWorkspaceId` are from removed widgets: they
/// stay listed so an old flat file does not dump them into the config — but they are not read.
const PERSISTENCE_TOP_KEYS: &[&str] = &[
    "user",
    "apps",
    "notes",
    "alarms",
    "noteWorkspaces",
    "activeNoteWorkspaceId",
];

/// The disk JSON as the v2 shape `{ user, apps?, config }`.
///
/// `None` when the payload is empty or has no workspace data at all — the caller then tries `.bak`
/// rather than overwriting what may still be a real file. That distinction is the whole point of
/// returning an `Option` instead of falling back to defaults here: defaults written over a blob
/// that merely failed to parse is how a configuration gets lost.
pub fn normalize_full_blob(raw: &Value) -> Option<Value> {
    let obj = raw.as_object()?;

    let nonempty_array = |v: Option<&Value>| -> bool {
        v.and_then(Value::as_array).map(|a| !a.is_empty()).unwrap_or(false)
    };

    // Legacy / flat: config fields at the root, including `workspaces`, with no nested `config`.
    if nonempty_array(obj.get("workspaces")) && !obj.contains_key("config") {
        let mut config = Map::new();
        for (k, v) in obj {
            if PERSISTENCE_TOP_KEYS.contains(&k.as_str()) {
                continue;
            }
            config.insert(k.clone(), v.clone());
        }
        if !nonempty_array(config.get("workspaces")) {
            return None;
        }
        let mut out = Map::new();
        out.insert("user".into(), obj.get("user").cloned().unwrap_or(Value::Null));
        if let Some(apps) = obj.get("apps").filter(|v| v.is_array()) {
            out.insert("apps".into(), apps.clone());
        }
        out.insert("config".into(), Value::Object(config));
        return Some(Value::Object(out));
    }

    // Nested `config`: accept valid workspaces, or repair from a legacy root `apps` when the
    // workspace array is empty or missing.
    let config_obj = obj.get("config")?.as_object()?;
    let mut config = config_obj.clone();
    let mut workspaces: Vec<Value> = config
        .get("workspaces")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    // Some builds wrote `workspaces` at the root while `config` omitted the array — merge, so a
    // load never comes back empty over a file that plainly has the data.
    if workspaces.is_empty() && nonempty_array(obj.get("workspaces")) {
        workspaces = obj["workspaces"].as_array().cloned().unwrap_or_default();
    }

    let needs_repair = workspaces.is_empty()
        && nonempty_array(obj.get("apps"))
        && !nonempty_array(obj.get("workspaces"));
    if needs_repair {
        let mut ws = Map::new();
        ws.insert("id".into(), Value::String("workspace-1".into()));
        ws.insert("name".into(), Value::String("Main".into()));
        ws.insert("hotkey".into(), Value::from(1));
        ws.insert("enabled".into(), Value::Bool(true));
        ws.insert("apps".into(), obj["apps"].clone());
        ws.insert("color".into(), Value::String("#3B82F6".into()));
        workspaces = vec![Value::Object(ws)];

        let keep_index = config
            .get("activeWorkspaceIndex")
            .and_then(Value::as_i64)
            .filter(|n| *n >= 0)
            .unwrap_or(0);
        config.insert("activeWorkspaceIndex".into(), Value::from(keep_index));
    }

    if workspaces.is_empty() {
        return None;
    }
    config.insert("workspaces".into(), Value::Array(workspaces));

    let mut out = Map::new();
    out.insert("user".into(), obj.get("user").cloned().unwrap_or(Value::Null));
    if let Some(apps) = obj.get("apps").filter(|v| v.is_array()) {
        out.insert("apps".into(), apps.clone());
    }
    out.insert("config".into(), Value::Object(config));
    Some(Value::Object(out))
}

// ─── Value merging ──────────────────────────────────────────────────────────

/// `{ ...base, ...overlay }` — one level deep, exactly as the JS spread it replaces.
///
/// Shallow on purpose. A `statusDock` from disk REPLACES the default wholesale and is then repaired
/// field by field by `normalize_status_dock`; deep-merging it instead would resurrect a sub-field
/// the user had deliberately turned off, because "off" and "absent" are the same thing to a merge
/// and only `normalize_status_dock` knows which of the two a given field's absence means.
fn shallow_merge(base: &mut Map<String, Value>, overlay: &Map<String, Value>) {
    for (k, v) in overlay {
        base.insert(k.clone(), v.clone());
    }
}

/// `shallow_merge` applied to one nested object, creating it if the base has none.
fn merge_nested(base: &mut Map<String, Value>, key: &str, overlay: Option<&Value>) {
    let Some(overlay) = overlay.and_then(Value::as_object) else {
        return;
    };
    let slot = base
        .entry(key.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if let Some(existing) = slot.as_object_mut() {
        shallow_merge(existing, overlay);
    } else {
        *slot = Value::Object(overlay.clone());
    }
}

// ─── Scalar clamps ──────────────────────────────────────────────────────────

/// A stored number, clamped, or the fallback.
///
/// The test is `is_f64`/`is_i64` and not a coercion, and the difference is `null`: coerced it
/// becomes 0, which is a finite number, which clamps to the MINIMUM — so a config that had merely
/// lost the key would come back as the smallest dock the slider can show rather than the default
/// one. A number genuinely out of range is clamped instead of replaced, because that was a real
/// choice made on a build whose slider reached further.
fn clamp_int(value: Option<&Value>, min: i32, max: i32, fallback: i32) -> i32 {
    let Some(n) = value.and_then(Value::as_f64) else {
        return fallback;
    };
    if !n.is_finite() {
        return fallback;
    }
    (n.round() as i64).clamp(min as i64, max as i64) as i32
}

fn flag(value: Option<&Value>, fallback: bool) -> bool {
    value.and_then(Value::as_bool).unwrap_or(fallback)
}

fn dock_position(value: Option<&Value>, fallback: HudPosition) -> HudPosition {
    match value.and_then(Value::as_str) {
        Some("top-left") => HudPosition::TopLeft,
        Some("top-center") => HudPosition::TopCenter,
        Some("top-right") => HudPosition::TopRight,
        Some("bottom-left") => HudPosition::BottomLeft,
        Some("bottom-center") => HudPosition::BottomCenter,
        Some("bottom-right") => HudPosition::BottomRight,
        _ => fallback,
    }
}

/// A stored blob as the shape the rest of the code may assume.
///
/// Anything missing takes its DEFAULT rather than a zero: a config written before a switch existed
/// must not read as "the user turned that off", and a dock whose `iconSize` came back as 0 would be
/// enabled, positioned, and invisible — the hardest kind of fault to report.
pub fn normalize_status_dock(value: Option<&Value>) -> StatusDock {
    let d = defaults::status_dock();
    let empty = Map::new();
    let raw = value.and_then(Value::as_object).unwrap_or(&empty);
    StatusDock {
        enabled: flag(raw.get("enabled"), d.enabled),
        position: dock_position(raw.get("position"), d.position),
        icon_size: clamp_int(
            raw.get("iconSize"),
            defaults::STATUS_DOCK_ICON_MIN,
            defaults::STATUS_DOCK_ICON_MAX,
            d.icon_size,
        ),
        gap: clamp_int(
            raw.get("gap"),
            defaults::DOCK_GAP_MIN,
            defaults::DOCK_GAP_MAX,
            d.gap,
        ),
        show_clock: flag(raw.get("showClock"), d.show_clock),
        show_battery: flag(raw.get("showBattery"), d.show_battery),
        show_network: flag(raw.get("showNetwork"), d.show_network),
        show_volume: flag(raw.get("showVolume"), d.show_volume),
    }
}

pub fn normalize_shortcut_dock(value: Option<&Value>) -> ShortcutDock {
    let d = defaults::shortcut_dock();
    let empty = Map::new();
    let raw = value.and_then(Value::as_object).unwrap_or(&empty);
    // An item with no `id` cannot be launched, reported on failure or edited, so it is dropped
    // here rather than drawn as a nameless tile.
    let items: Vec<AppItem> = raw
        .get("items")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter(|v| v.get("id").and_then(Value::as_str).is_some_and(|s| !s.is_empty()))
                .filter_map(|v| serde_json::from_value::<AppItem>(v.clone()).ok())
                .collect()
        })
        .unwrap_or_default();
    ShortcutDock {
        enabled: flag(raw.get("enabled"), d.enabled),
        position: dock_position(raw.get("position"), d.position),
        icon_size: clamp_int(
            raw.get("iconSize"),
            defaults::SHORTCUT_DOCK_ICON_MIN,
            defaults::SHORTCUT_DOCK_ICON_MAX,
            d.icon_size,
        ),
        gap: clamp_int(
            raw.get("gap"),
            defaults::DOCK_GAP_MIN,
            defaults::DOCK_GAP_MAX,
            d.gap,
        ),
        items,
        show_labels: flag(raw.get("showLabels"), d.show_labels),
    }
}

/// Milliseconds of sustained aim, clamped.
///
/// Do NOT coerce to decide this. Lowering the minimum to zero changed what coercion means: `null`,
/// `""`, `false` and `[]` all come out as 0, which stopped being "out of range, raise to the
/// minimum" and became the most aggressive choice the wheel has — launch on the first shove. A
/// broken file must not arm the product's fastest trigger on its own.
pub fn clamp_dwell_ms(value: Option<&Value>) -> f32 {
    let numeric = match value {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) if !s.trim().is_empty() => s.trim().parse::<f64>().ok(),
        _ => None,
    };
    match numeric {
        Some(n) if n.is_finite() => (n.round() as f32)
            .clamp(defaults::DWELL_MS_MIN, defaults::DWELL_MS_MAX),
        _ => defaults::DWELL_MS_DEFAULT,
    }
}

/// The languages that have a table. `fr`, `it`, `ja` and `ko` are named in old configs and have
/// none, so a config carrying one still lands on English.
const SUPPORTED_LANGUAGES: &[&str] = &["en", "es", "zh", "pt", "ru", "de", "ar"];

pub fn normalize_language(value: &str) -> String {
    if SUPPORTED_LANGUAGES.contains(&value) {
        value.to_string()
    } else {
        "en".to_string()
    }
}

/// A scale-1 `backdrop_opacity` as the scale-2 value that paints exactly the same pixels.
///
/// Scale 1: `alpha = 0.22 + 0.30·v`. Scale 2: `alpha = 0.22 + 0.78·v²`. Equate and solve for v.
pub fn legacy_backdrop_opacity_to_dim(legacy: f32) -> f32 {
    let v = if legacy.is_finite() {
        legacy.clamp(0.0, 1.0)
    } else {
        1.0
    };
    (((0.3 * v) / 0.78).sqrt() * 100.0).round() / 100.0
}

/// The upper-case single character a recorded back key is stored as, or `BACK_KEY_OFF`.
///
/// Anything else — a multi-character key name, a modifier, a digit, whitespace, junk from a
/// hand-edited config — is no key at all rather than a guess. Digits are refused outright, at
/// every layer, because `radial_number_launch` can claim 1–9 at any time afterwards: a binding
/// that works until an unrelated switch is flipped, then silently stops, is not worth the one key
/// it buys.
pub fn normalize_back_key(value: Option<&str>) -> String {
    let Some(trimmed) = value.map(str::trim).filter(|s| !s.is_empty()) else {
        return defaults::BACK_KEY_OFF.to_string();
    };
    let mut chars = trimmed.chars();
    let (Some(c), None) = (chars.next(), chars.next()) else {
        return defaults::BACK_KEY_OFF.to_string();
    };
    if c.is_ascii_digit() {
        return defaults::BACK_KEY_OFF.to_string();
    }
    c.to_uppercase().collect()
}

// ─── Hydration ──────────────────────────────────────────────────────────────

/// A raw stored config as the one the wheel and the settings panel may both believe.
///
/// Pure, and deliberately blind to the CONTENTS of `workspaces`: Start Menu discovery and the
/// persistence-meta stamping run around this, not inside it.
pub fn hydrate(raw: &Value) -> UiConfig {
    let empty = Map::new();
    let loaded = raw.as_object().unwrap_or(&empty);

    // The defaults go in BEFORE whatever came off disk. Without that base, every setting added in
    // a version later than the saved file reaches the renderer as absent instead of as its
    // default. The symptom misleads: it looks like the backup did not keep the settings, when in
    // truth they were never in the file and nobody restored them on read.
    let mut merged = match serde_json::to_value(defaults::ui_config()) {
        Ok(Value::Object(m)) => m,
        _ => Map::new(),
    };
    shallow_merge(&mut merged, loaded);

    // The opening point is no longer configurable: the wheel is always born at the centre of its
    // own window. Old configs can carry `false` — normalise on read, otherwise a state the
    // interface can no longer show or undo would survive.
    merged.insert("fixedPosition".into(), Value::Bool(true));

    // Game mode is the one nested object the TS spreads two levels deep, so it is the one that
    // merges rather than replaces.
    let defaults_game = serde_json::to_value(defaults::ui_config().game_mode).unwrap_or(Value::Null);
    merged.insert("gameMode".into(), defaults_game);
    merge_nested(&mut merged, "gameMode", loaded.get("gameMode"));
    // Drops the old demo list: the selection is visual now, per application.
    if let Some(game) = merged.get_mut("gameMode").and_then(Value::as_object_mut) {
        let blocked = game
            .get("blockedApps")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let is_demo_list =
            blocked.trim().to_ascii_lowercase() == "csgo.exe, valorant.exe, dota2.exe, overwatch.exe";
        game.insert(
            "blockedApps".into(),
            Value::String(if is_demo_list { String::new() } else { blocked }),
        );
    }

    // The centre button is replaced wholesale by a stored one, like every other nested object, but
    // its own fields are then filled from the default: a partial blob from a hand edit would
    // otherwise fail the parse and take the whole config with it.
    let defaults_center =
        serde_json::to_value(defaults::ui_config().center_button).unwrap_or(Value::Null);
    let stored_center = merged.get("centerButton").cloned();
    merged.insert("centerButton".into(), defaults_center);
    merge_nested(&mut merged, "centerButton", stored_center.as_ref());

    // The docks are normalised field by field rather than merged, because for them "missing" and
    // "false" differ per field — see `normalize_status_dock`.
    if let Ok(v) = serde_json::to_value(normalize_status_dock(loaded.get("statusDock"))) {
        merged.insert("statusDock".into(), v);
    }
    if let Ok(v) = serde_json::to_value(normalize_shortcut_dock(loaded.get("shortcutDock"))) {
        merged.insert("shortcutDock".into(), v);
    }

    // Contiguous hotkeys by position, on read too. Renumbering only on mutations would leave out
    // the files already saved with gaps — the "1, 2, 4" left over from a workspace deleted in the
    // middle on an earlier version. The operation is idempotent.
    if let Some(list) = merged.get_mut("workspaces").and_then(Value::as_array_mut) {
        for (index, ws) in list.iter_mut().enumerate() {
            if let Some(obj) = ws.as_object_mut() {
                let hotkey = if index < 9 { index as i64 + 1 } else { 0 };
                obj.insert("hotkey".into(), Value::from(hotkey));
            }
        }
    }

    // A config written before this flag existed belongs to someone already using Rovyl, and the
    // welcome card is for people who are not. The merge above fills the missing key with `false`,
    // so without this every existing user would be welcomed to an app they have had for months.
    //
    // The test is that the key is ABSENT, not that a config exists at all: a first run saves one
    // within seconds — before anybody has read the card, let alone dismissed it.
    if !loaded.contains_key("hasSeenOnboarding") {
        merged.insert("hasSeenOnboarding".into(), Value::Bool(true));
    }

    // "Start with Windows" ships on, but only for installs that begin with it. A config written
    // before the default changed belongs to somebody who has been using Rovyl without it, and an
    // update must not put an entry in their startup list on its own.
    //
    // Same test as the card above — the key is ABSENT, not `false`.
    if !loaded.contains_key("openAtLogin") {
        merged.insert("openAtLogin".into(), Value::Bool(false));
    }

    // "Background dimming" used to top out at half a pool; it now reaches an opaque screen. The
    // saved number therefore means something darker than it did, and the default was the top of
    // the old scale — so left alone, every existing profile would have blacked the screen out on
    // the first open after updating, having changed nothing.
    //
    // Converted once, to the value that paints exactly the pixels the person already had. The test
    // is the missing marker, not the value.
    let stored_scale = loaded
        .get("backdropDimScale")
        .and_then(Value::as_f64)
        .unwrap_or(f64::NAN);
    if stored_scale as f32 != defaults::BACKDROP_DIM_SCALE {
        let legacy = loaded
            .get("backdropOpacity")
            .and_then(Value::as_f64)
            .unwrap_or(1.0) as f32;
        merged.insert(
            "backdropDimScale".into(),
            Value::from(defaults::BACKDROP_DIM_SCALE),
        );
        merged.insert(
            "backdropOpacity".into(),
            Value::from(legacy_backdrop_opacity_to_dim(legacy)),
        );
    }

    // Targeting used to offer three choices — Direction, Area, Pointer — of which the first two
    // aimed identically and disagreed only about whether the shares were drawn. Drawing is not a
    // way of targeting, so there are two modes now and a switch beside them.
    //
    // Both halves have to be read off the STORED value, and neither may fall back to the default.
    // `angle` says the person never had the wedges and `area` says they chose them; writing the
    // flag from that, once, is the difference between an update that changes nothing on screen and
    // one that either takes the wedges away from everyone who picked them or hands them to
    // everyone who did not.
    let stored_mode = loaded.get("radialSelectionMode").and_then(Value::as_str);
    if !loaded.contains_key("radialAreaWedges") {
        merged.insert(
            "radialAreaWedges".into(),
            Value::Bool(stored_mode == Some("area")),
        );
    }
    if stored_mode == Some("angle") {
        merged.insert("radialSelectionMode".into(), Value::String("area".into()));
    }

    // The dwell wait has to be clamped before it is believed: it drives a timer that LAUNCHES.
    merged.insert(
        "radialInstantDwellMs".into(),
        Value::from(clamp_dwell_ms(loaded.get("radialInstantDwellMs"))),
    );

    let mut config: UiConfig = serde_json::from_value(Value::Object(merged))
        // A struct that cannot be built from the merge is a bug in this function, not in the file:
        // every field above either came from the defaults or was overwritten with a value of the
        // right shape. Falling back to the defaults keeps the app usable while losing nothing that
        // was not already unreadable.
        .unwrap_or_else(|_| defaults::ui_config());

    // Normalise, do not overwrite. A stored choice has to survive a reload — but only for a
    // language that actually has a table.
    config.language = normalize_language(&config.language);
    // `swipe` is declared in the model and implemented nowhere; every read coerces it to `off`.
    if matches!(config.radial_instant_activate, Some(InstantActivate::Swipe)) {
        config.radial_instant_activate = Some(InstantActivate::Off);
    }
    // `angle` is handled above for a stored value; this catches one that arrived any other way.
    if matches!(config.radial_selection_mode, Some(SelectionMode::Angle)) {
        config.radial_selection_mode = Some(SelectionMode::Area);
    }
    config.radial_back_key = Some(normalize_back_key(config.radial_back_key.as_deref()));
    // An index past the end of the list is a workspace that cannot be drawn. It happens after a
    // workspace is deleted on one build and the file is read by another.
    if config.active_workspace_index >= config.workspaces.len() {
        config.active_workspace_index = 0;
    }
    // `internal:*` shortcuts came from the removed widgets. Without this the wheel would show dead
    // icons that launch nothing.
    strip_internal_widgets(&mut config);

    config
}

/// Old configs saved `internal:*` shortcuts (Notes / Alarm / Stopwatch / Pomodoro). Those widgets
/// are gone.
fn strip_internal_widgets(config: &mut UiConfig) {
    fn walk(items: &mut Vec<AppItem>) {
        items.retain(|a| !a.command.starts_with("internal:"));
        for item in items.iter_mut() {
            if let Some(children) = item.children.as_mut() {
                walk(children);
            }
        }
    }
    for ws in config.workspaces.iter_mut() {
        walk(&mut ws.apps);
    }
    if let Some(dock) = config.shortcut_dock.as_mut() {
        walk(&mut dock.items);
    }
    if config.center_button.target.starts_with("internal:") {
        config.center_button = CenterButton {
            kind: CenterKind::None,
            target: String::new(),
            label: String::new(),
            icon_name: "Circle".into(),
            command_type: None,
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_open_at_login_means_off() {
        // The whole point of testing presence rather than value: an existing profile must not gain
        // a startup entry by being read.
        let cfg = hydrate(&serde_json::json!({ "workspaces": [] }));
        assert_eq!(cfg.open_at_login, Some(false));
        let cfg = hydrate(&serde_json::json!({ "openAtLogin": true }));
        assert_eq!(cfg.open_at_login, Some(true));
    }

    #[test]
    fn missing_onboarding_flag_means_already_seen() {
        let cfg = hydrate(&serde_json::json!({}));
        assert_eq!(cfg.has_seen_onboarding, Some(true));
        let cfg = hydrate(&serde_json::json!({ "hasSeenOnboarding": false }));
        assert_eq!(cfg.has_seen_onboarding, Some(false));
    }

    #[test]
    fn legacy_dim_is_rescaled_once() {
        // Scale 1's full value painted 0.52 alpha; on scale 2 that is ~0.62 on the slider.
        let cfg = hydrate(&serde_json::json!({ "backdropOpacity": 1.0 }));
        assert_eq!(cfg.backdrop_dim_scale, Some(2.0));
        assert!((cfg.backdrop_opacity - 0.62).abs() < 0.011, "got {}", cfg.backdrop_opacity);
        // A config already on scale 2 is left exactly as written.
        let cfg = hydrate(&serde_json::json!({ "backdropOpacity": 0.9, "backdropDimScale": 2.0 }));
        assert!((cfg.backdrop_opacity - 0.9).abs() < 1e-6);
    }

    #[test]
    fn angle_mode_keeps_its_bare_wedges() {
        let cfg = hydrate(&serde_json::json!({ "radialSelectionMode": "angle" }));
        assert_eq!(cfg.radial_selection_mode, Some(SelectionMode::Area));
        assert_eq!(cfg.radial_area_wedges, Some(false));
        let cfg = hydrate(&serde_json::json!({ "radialSelectionMode": "area" }));
        assert_eq!(cfg.radial_area_wedges, Some(true));
    }

    #[test]
    fn broken_dwell_falls_back_rather_than_arming() {
        // Every one of these coerces to 0 in JS, which would be the hair trigger.
        for junk in [Value::Null, Value::String(String::new()), Value::Bool(false)] {
            assert_eq!(clamp_dwell_ms(Some(&junk)), defaults::DWELL_MS_DEFAULT);
        }
        assert_eq!(clamp_dwell_ms(Some(&Value::from(0))), 0.0);
        assert_eq!(clamp_dwell_ms(Some(&Value::from(99999))), defaults::DWELL_MS_MAX);
    }

    #[test]
    fn dock_keeps_a_visible_size_when_the_key_is_gone() {
        // `null` coerces to 0, which clamps to the minimum — a dock that is on and invisible.
        let dock = normalize_status_dock(Some(&serde_json::json!({ "iconSize": null })));
        assert_eq!(dock.icon_size, defaults::status_dock().icon_size);
        let dock = normalize_status_dock(Some(&serde_json::json!({ "iconSize": 4 })));
        assert_eq!(dock.icon_size, defaults::STATUS_DOCK_ICON_MIN);
    }

    #[test]
    fn back_key_refuses_digits_and_names() {
        assert_eq!(normalize_back_key(Some("q")), "Q");
        assert_eq!(normalize_back_key(Some("4")), "");
        assert_eq!(normalize_back_key(Some("Escape")), "");
        assert_eq!(normalize_back_key(None), "");
    }

    #[test]
    fn flat_legacy_blob_becomes_v2() {
        let raw = serde_json::json!({
            "workspaces": [{ "id": "w1", "name": "Main", "apps": [] }],
            "accentColor": "#ABCDEF",
            "user": { "name": "x" },
            "notes": ["dropped"],
        });
        let out = normalize_full_blob(&raw).expect("flat blob should normalize");
        assert_eq!(out["config"]["accentColor"], "#ABCDEF");
        assert!(out["config"].get("notes").is_none(), "widget leftovers must not reach the config");
        assert_eq!(out["user"]["name"], "x");
    }

    #[test]
    fn blob_with_no_workspaces_is_refused() {
        // `None` is what sends the caller to `.bak` instead of overwriting a real file.
        assert!(normalize_full_blob(&serde_json::json!({})).is_none());
        assert!(normalize_full_blob(&serde_json::json!({ "config": {} })).is_none());
    }

    #[test]
    fn root_apps_repair_an_empty_workspace_array() {
        let raw = serde_json::json!({
            "config": { "workspaces": [] },
            "apps": [{ "id": "a", "label": "Thing", "command": "x" }],
        });
        let out = normalize_full_blob(&raw).expect("root apps should repair");
        assert_eq!(out["config"]["workspaces"][0]["name"], "Main");
        assert_eq!(out["config"]["workspaces"][0]["apps"][0]["id"], "a");
    }

    #[test]
    fn unknown_keys_survive_a_round_trip() {
        // Running the native port must not strip a setting the Electron build added.
        let cfg = hydrate(&serde_json::json!({ "someFutureSetting": 42 }));
        let back = serde_json::to_value(&cfg).unwrap();
        assert_eq!(back["someFutureSetting"], 42);
    }
}
