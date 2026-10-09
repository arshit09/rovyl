//! Finding the applications that are installed.
//!
//! The Electron build ran `Get-StartApps` in a PowerShell child process. That cmdlet is a thin
//! wrapper over the shell's **AppsFolder** — the virtual folder the Start menu itself lists — so
//! this enumerates that folder directly. It is the same data from the same source, without paying
//! 300–800 ms to start a PowerShell host, and without a second process that can fail or hang.
//!
//! AppsFolder is the right source rather than scanning `%ProgramData%\Microsoft\Windows\Start Menu`
//! for `.lnk` files, and the difference is packaged apps: a Store app has no shortcut on disk at
//! all, and a scan would find Notepad and miss every modern application on the machine.
//!
//! **What comes back is an identifier, not a path.** The shapes AppsFolder reports are listed in
//! `launch::parse` — an MSIX AUMID, a Squirrel installer id, a flattened path, an id with spaces in
//! it, a known-folder GUID, a real path, a bare alias. Only the last two can be handed to a shell
//! as a command line, which is why every discovered entry is stored as a `shell:AppsFolder\` moniker
//! rather than as whatever string came back.

use crate::config::{AppItem, CommandType, IconSource, ItemKind};
use windows::core::{GUID, PWSTR};
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::UI::Shell::{
    BHID_EnumItems, IEnumShellItems, IShellItem, SHGetKnownFolderItem, KF_FLAG_DONT_VERIFY,
    SIGDN_NORMALDISPLAY, SIGDN_PARENTRELATIVEPARSING,
};

/// `FOLDERID_AppsFolder` — the virtual folder the Start menu's "all apps" list is built from.
///
/// Written out rather than imported because the binding for it moves between `windows` crate
/// versions, and a known-folder GUID is part of the OS ABI and cannot change.
const FOLDERID_APPS_FOLDER: GUID = GUID::from_u128(0x1e87508d_89c2_42f0_8a7e_645a0f50ca58);

/// One installed application.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installed {
    pub name: String,
    /// The AppsFolder identifier. Stored as a moniker by `to_item`.
    pub app_id: String,
}

/// Names that are not applications.
///
/// Every installer drops these beside the real entry, and a wheel that offered "Microsoft Edge" and
/// "Microsoft Edge Help" with equal weight would be a wheel the user has to read rather than aim
/// at. The original filtered the same words.
const NOISE: &[&str] = &[
    "help", "feedback", "contact", "support", "manual", "uninstall", "readme", "release notes",
    "documentation", "website", "license",
];

fn is_noise(name: &str) -> bool {
    let lower = name.to_lowercase();
    NOISE.iter().any(|word| lower.contains(word))
}

/// Everything AppsFolder lists, with the obvious non-applications removed.
///
/// Call from a WORKER. The enumeration is tens of milliseconds on a machine with a few hundred
/// applications, which is far too long for the frame loop.
pub fn installed() -> Vec<Installed> {
    let mut out = Vec::new();
    unsafe {
        // `DONT_VERIFY`: AppsFolder is virtual and has nothing on disk to verify, and asking makes
        // the call slower for no answer.
        let folder: IShellItem = match SHGetKnownFolderItem(
            &FOLDERID_APPS_FOLDER,
            KF_FLAG_DONT_VERIFY,
            None,
        ) {
            Ok(folder) => folder,
            Err(_) => return out,
        };
        let items: IEnumShellItems = match folder.BindToHandler(None, &BHID_EnumItems) {
            Ok(items) => items,
            Err(_) => return out,
        };

        loop {
            let mut batch: [Option<IShellItem>; 32] = Default::default();
            let mut fetched = 0u32;
            if items.Next(&mut batch, Some(&mut fetched)).is_err() || fetched == 0 {
                break;
            }
            for item in batch.iter().take(fetched as usize).flatten() {
                let Some(name) = display_name(item, SIGDN_NORMALDISPLAY) else {
                    continue;
                };
                // The PARENT-RELATIVE parsing name of an AppsFolder item is the AppID itself —
                // the absolute one would be prefixed with the folder's own GUID path, which is not
                // what anything downstream expects.
                let Some(app_id) = display_name(item, SIGDN_PARENTRELATIVEPARSING) else {
                    continue;
                };
                if name.is_empty() || app_id.is_empty() || is_noise(&name) {
                    continue;
                }
                out.push(Installed { name, app_id });
            }
        }
    }

    // Case-insensitive by name, because that is the order a person scanning the picker expects —
    // and the shell's own order is by install date, which is nobody's mental model.
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out.dedup_by(|a, b| a.app_id == b.app_id);
    out
}

fn display_name(item: &IShellItem, kind: windows::Win32::UI::Shell::SIGDN) -> Option<String> {
    unsafe {
        let raw: PWSTR = item.GetDisplayName(kind).ok()?;
        let text = raw.to_string().ok()?;
        // The shell allocates it; leaking one string per app per scan is how a launcher grows.
        CoTaskMemFree(Some(raw.0 as *const _));
        Some(text)
    }
}

/// One discovered application as a wheel item.
///
/// Stored as a `shell:AppsFolder\` moniker, never as the bare id. The bare form is recognised by
/// shape at launch time so that shortcuts saved before monikers existed keep working, but anything
/// written NOW carries its provenance rather than relying on that inference.
pub fn to_item(app: &Installed) -> AppItem {
    AppItem {
        id: format!("app-{}", stable_id(&app.app_id)),
        kind: Some(ItemKind::App),
        label: app.name.clone(),
        // `native` and no picture yet: the extractor fills `custom_icon_url` in, and until it does
        // the tile shows a wait rather than a glyph that is not the app's.
        icon_source: Some(IconSource::Native),
        icon_name: "AppWindow".into(),
        command: crate::launch::parse::to_apps_folder(&app.app_id),
        command_type: Some(CommandType::App),
        description: String::new(),
        ..AppItem::default()
    }
}

/// A short, stable id for an application.
///
/// Derived from the AppID so that re-running discovery produces the same ids — otherwise every
/// scan would replace every item, and an icon extracted for one would be orphaned.
fn stable_id(app_id: &str) -> String {
    let hash = crate::icons::store::sha256(app_id.as_bytes());
    hash[..8].iter().map(|b| format!("{b:02x}")).collect()
}

/// The shortcuts a fresh profile's Main workspace starts with.
///
/// Eight, because that is where the wheel's geometry is still comfortable — `layout::crowding`
/// starts warning past twelve, and a first wheel should be under that with room for the user's own
/// additions. The choice is by RECOGNISABILITY rather than by the shell's order: the point of a
/// seeded wheel is that somebody can aim at it before they have configured anything.
pub fn seed(apps: &[Installed], limit: usize) -> Vec<AppItem> {
    // The applications most people have and most people reach for. Matched loosely, because the
    // display name carries a vendor or an edition on many installs — "Google Chrome", "Microsoft
    // Edge", "Visual Studio Code".
    const WANTED: &[&str] = &[
        "chrome", "edge", "firefox", "brave", "explorer", "file explorer", "terminal",
        "visual studio code", "cursor", "spotify", "discord", "steam", "whatsapp", "telegram",
        "notion", "slack", "obsidian", "calculator", "notepad",
    ];

    let mut picked: Vec<AppItem> = Vec::new();
    for wanted in WANTED {
        if picked.len() >= limit {
            break;
        }
        let found = apps.iter().find(|app| {
            let lower = app.name.to_lowercase();
            lower == *wanted || lower.starts_with(wanted) || lower.contains(wanted)
        });
        if let Some(app) = found {
            let item = to_item(app);
            if !picked.iter().any(|existing| existing.command == item.command) {
                picked.push(item);
            }
        }
    }
    picked
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(name: &str, id: &str) -> Installed {
        Installed {
            name: name.into(),
            app_id: id.into(),
        }
    }

    #[test]
    fn noise_is_filtered() {
        // Every installer drops these beside the real entry.
        for name in [
            "Microsoft Edge Help",
            "Uninstall Spotify",
            "VLC Documentation",
            "Release Notes",
            "Contact Support",
        ] {
            assert!(is_noise(name), "{name}");
        }
        for name in ["Microsoft Edge", "Spotify", "VLC media player", "Steam"] {
            assert!(!is_noise(name), "{name}");
        }
    }

    #[test]
    fn ids_are_stable_across_scans() {
        // An id that changed per scan would orphan the icon extracted for it and replace every
        // item in the workspace on every discovery.
        let a = to_item(&app("Spotify", "Spotify.exe"));
        let b = to_item(&app("Spotify", "Spotify.exe"));
        assert_eq!(a.id, b.id);
        // And a different application gets a different one.
        let c = to_item(&app("Steam", "Steam.exe"));
        assert_ne!(a.id, c.id);
    }

    #[test]
    fn a_discovered_command_carries_its_provenance() {
        // Written as a moniker now, rather than relying on the launcher inferring it by shape.
        let item = to_item(&app("Zoom", "zoom.us.Zoom Video Meetings"));
        assert_eq!(item.command, "shell:AppsFolder\\zoom.us.Zoom Video Meetings");
        assert_eq!(
            crate::launch::parse::apps_folder_id(&item.command),
            Some("zoom.us.Zoom Video Meetings")
        );
    }

    #[test]
    fn a_discovered_item_waits_for_its_icon() {
        // `native` with no picture is what makes the tile show a wait rather than a glyph that is
        // not the app's.
        let item = to_item(&app("Spotify", "Spotify.exe"));
        assert_eq!(item.icon_source, Some(IconSource::Native));
        assert!(item.custom_icon_url.is_none());
    }

    #[test]
    fn the_seed_prefers_recognisable_apps_and_respects_the_limit() {
        let apps = vec![
            app("Some Internal Tool", "a"),
            app("Google Chrome", "b"),
            app("Spotify", "c"),
            app("Another Internal Tool", "d"),
            app("Steam", "e"),
        ];
        let seeded = seed(&apps, 8);
        let names: Vec<&str> = seeded.iter().map(|i| i.label.as_str()).collect();
        assert_eq!(names, vec!["Google Chrome", "Spotify", "Steam"]);
        assert_eq!(seed(&apps, 2).len(), 2);
    }

    #[test]
    fn the_seed_never_repeats_one_app() {
        // "edge" and "explorer" both match "Microsoft Edge ... Explorer"-shaped names on some
        // installs, and a wheel with the same tile twice is a wheel with a bug in it.
        let apps = vec![app("Microsoft Edge", "edge"), app("File Explorer", "ex")];
        let seeded = seed(&apps, 8);
        let mut commands: Vec<&str> = seeded.iter().map(|i| i.command.as_str()).collect();
        commands.sort_unstable();
        let before = commands.len();
        commands.dedup();
        assert_eq!(commands.len(), before);
    }

    #[test]
    fn enumeration_returns_real_applications() {
        // Runs against the live machine. The only thing that can be asserted is that the shell
        // answered at all and that what came back has the shape everything downstream expects —
        // which is exactly the failure worth catching, because a change to the folder id or the
        // display-name flag produces an empty list and a silently empty first wheel.
        unsafe {
            let _ = windows::Win32::System::Com::CoInitializeEx(
                None,
                windows::Win32::System::Com::COINIT_APARTMENTTHREADED,
            );
        }
        let apps = installed();
        assert!(!apps.is_empty(), "AppsFolder listed nothing");
        for app in apps.iter().take(50) {
            assert!(!app.name.trim().is_empty());
            assert!(!app.app_id.trim().is_empty());
            // An AppID must never come back already wrapped: `to_apps_folder` would double it.
            assert!(!app.app_id.to_lowercase().starts_with("shell:appsfolder"));
        }
        // Sorted by name, case-insensitively.
        for pair in apps.windows(2) {
            assert!(pair[0].name.to_lowercase() <= pair[1].name.to_lowercase());
        }
    }
}
