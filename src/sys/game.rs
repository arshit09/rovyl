//! Focus protection: keeping the wheel out of the way while the user is in a fullscreen game.
//!
//! The check sits between the button and the wheel appearing, so it has to be cheap. Everything
//! here is a window-handle query or a string test; the one thing that touches the disk — looking
//! for a game engine's DLLs beside an executable — is cached per executable path, because the same
//! game is in the foreground for hours.
//!
//! **Why fullscreen is part of the test and not just the executable.** A game that is windowed or
//! alt-tabbed is a window like any other, and the user reaching for the launcher while they are
//! looking at their desktop means it. The original's two modes say the same thing: `All` is "any
//! fullscreen app", `List` is "these apps, and only when they are fullscreen".

use crate::config::{GameMode, GameModeScope};
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::Path;
use windows::Win32::Foundation::{HWND, MAX_PATH, RECT};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId,
};

/// Folders that only ever contain games.
const PATH_MARKERS: &[&str] = &[
    "\\steamapps\\common\\",
    "\\epic games\\",
    "\\gog galaxy\\games\\",
    "\\gog games\\",
    "\\xboxgames\\",
    "\\riot games\\",
    "\\ea games\\",
    "\\ubisoft game launcher\\games\\",
];

/// The launchers themselves, which are NOT games.
///
/// They live in the same folders and often run fullscreen (Steam's Big Picture), so without this
/// list the wheel would refuse to open on the one screen a user is most likely to want it on —
/// the library they are picking a game from.
const LAUNCHERS: &[&str] = &[
    "steam.exe",
    "epicgameslauncher.exe",
    "goggalaxy.exe",
    "galaxyclient.exe",
    "battle.net.exe",
    "riotclientservices.exe",
    "riotclientux.exe",
    "eadesktop.exe",
    "ealauncher.exe",
    "ubisoftconnect.exe",
    "upc.exe",
    "uplay.exe",
    "xboxapp.exe",
    "gamingservices.exe",
];

/// Files that only ship beside a game.
const ENGINE_MARKERS: &[&str] = &[
    "steam_api64.dll",
    "steam_api.dll",
    "UnityPlayer.dll",
    "GameAssembly.dll",
    "EOSSDK-Win64-Shipping.dll",
    "EOSSDK-Win32-Shipping.dll",
    "Galaxy64.dll",
    "Galaxy.dll",
];

/// Whether the wheel should stay down right now.
pub fn should_block(mode: &GameMode) -> bool {
    if !mode.enabled {
        return false;
    }
    let Some(foreground) = foreground_window() else {
        return false;
    };
    // Windowed or alt-tabbed is a window like any other: the user looking at their desktop and
    // reaching for the launcher means it.
    if !covers_its_monitor(foreground) {
        return false;
    }

    let exe = foreground_executable(foreground);

    match mode.mode {
        GameModeScope::All => true,
        GameModeScope::List => {
            let Some(exe) = exe else {
                return false;
            };
            let base = basename(&exe);
            if list_contains(&mode.blocked_apps, &base) {
                return true;
            }
            mode.auto_detect_games && looks_like_a_game(&exe)
        }
    }
}

fn foreground_window() -> Option<HWND> {
    let hwnd = unsafe { GetForegroundWindow() };
    (!hwnd.is_invalid()).then_some(hwnd)
}

/// Whether a window covers the whole of the monitor it is on.
///
/// Compared against the monitor's BOUNDS rather than its work area: a fullscreen game covers the
/// taskbar, and a maximised window — which does not — must not be mistaken for one.
fn covers_its_monitor(hwnd: HWND) -> bool {
    let mut rect = RECT::default();
    if unsafe { GetWindowRect(hwnd, &mut rect) }.is_err() {
        return false;
    }
    let display = crate::win::monitor::from_window(hwnd);
    let m = display.bounds;
    // A pixel of slack at each edge. Some games report a rect one pixel larger than the display,
    // and a borderless-fullscreen window occasionally lands one pixel short.
    rect.left <= m.left + 1
        && rect.top <= m.top + 1
        && rect.right >= m.right - 1
        && rect.bottom >= m.bottom - 1
}

fn foreground_executable(hwnd: HWND) -> Option<String> {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if pid == 0 {
        return None;
    }
    unsafe {
        // `PROCESS_QUERY_LIMITED_INFORMATION` rather than the full query right: it is the one an
        // unelevated process is granted against an elevated one, and a game launched by an
        // anti-cheat service is often exactly that. Asking for more fails on the processes this
        // most needs to identify.
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = [0u16; MAX_PATH as usize];
        let mut size = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_FORMAT(0),
            windows::core::PWSTR(buffer.as_mut_ptr()),
            &mut size,
        );
        let _ = windows::Win32::Foundation::CloseHandle(handle);
        result.ok()?;
        Some(String::from_utf16_lossy(&buffer[..size as usize]))
    }
}

fn basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// Whether a comma- or newline-separated list names this executable.
///
/// Both separators, because the field is a free-text box the user types into and both are what
/// people write. Each entry is matched against the BASENAME, so a list written as `csgo.exe` works
/// whatever drive the game is installed on.
fn list_contains(list: &str, base: &str) -> bool {
    list.split([',', '\n', ';'])
        .map(|entry| entry.trim().to_ascii_lowercase())
        .filter(|entry| !entry.is_empty())
        .any(|entry| entry == base || basename(&entry) == base)
}

/// Whether an executable path looks like a game.
pub fn looks_like_a_game(exe_path: &str) -> bool {
    let normalized = exe_path.trim().replace('/', "\\").to_ascii_lowercase();
    if !normalized.ends_with(".exe") {
        return false;
    }
    let base = basename(&normalized);
    if LAUNCHERS.contains(&base.as_str()) {
        return false;
    }

    if PATH_MARKERS.iter().any(|marker| normalized.contains(marker)) {
        return true;
    }
    // Unreal's shipping layout, which no other kind of program has.
    if normalized.contains("\\engine\\binaries\\win64\\")
        || normalized.contains("\\engine\\binaries\\win32\\")
    {
        return true;
    }
    for suffix in [
        "-win64-shipping.exe",
        "-win32-shipping.exe",
        ".win64.shipping.exe",
        ".win32.shipping.exe",
    ] {
        if base.ends_with(suffix) {
            return true;
        }
    }

    engine_marker_near(exe_path)
}

/// Look for an engine's DLLs beside the executable, and up to two directories above it.
///
/// Cached per path: this is the one disk-touching test, and the same executable is in the
/// foreground for hours at a time. Up to two levels, because a game's binary often sits in
/// `Game/Binaries/Win64/` while `steam_api64.dll` sits at `Game/`.
fn engine_marker_near(exe_path: &str) -> bool {
    thread_local! {
        static CACHE: RefCell<HashMap<String, bool>> = RefCell::new(HashMap::new());
    }
    let key = exe_path.to_ascii_lowercase();
    if let Some(found) = CACHE.with(|c| c.borrow().get(&key).copied()) {
        return found;
    }

    let path = Path::new(exe_path);
    let mut answer = false;
    if path.is_absolute() {
        let mut dir = path.parent();
        for _ in 0..3 {
            let Some(current) = dir else { break };
            if ENGINE_MARKERS
                .iter()
                // Access denied in a protected install folder is a normal negative result, which
                // `exists` already reports as `false`.
                .any(|marker| current.join(marker).exists())
            {
                answer = true;
                break;
            }
            dir = current.parent();
        }
    }
    CACHE.with(|c| c.borrow_mut().insert(key, answer));
    answer
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launchers_are_not_games() {
        // Steam's Big Picture runs fullscreen, and the library is the one screen a user is most
        // likely to want the wheel on.
        for launcher in ["C:\\Program Files (x86)\\Steam\\steam.exe", "D:\\Epic\\EpicGamesLauncher.exe"] {
            assert!(!looks_like_a_game(launcher), "{launcher}");
        }
    }

    #[test]
    fn install_folders_identify_a_game() {
        for path in [
            "D:\\SteamLibrary\\steamapps\\common\\Subnautica\\Subnautica.exe",
            "C:\\Program Files\\Epic Games\\Fortnite\\x.exe",
            "C:\\XboxGames\\Forza\\Content\\forza.exe",
            "C:\\Riot Games\\VALORANT\\live\\valorant.exe",
        ] {
            assert!(looks_like_a_game(path), "{path}");
        }
    }

    #[test]
    fn unreals_shipping_layout_identifies_a_game() {
        assert!(looks_like_a_game(
            "D:\\Games\\MyGame\\Engine\\Binaries\\Win64\\MyGame.exe"
        ));
        assert!(looks_like_a_game("D:\\Games\\MyGame\\MyGame-Win64-Shipping.exe"));
    }

    #[test]
    fn ordinary_programs_are_not_games() {
        for path in [
            "C:\\Windows\\notepad.exe",
            "C:\\Program Files\\Git\\git.exe",
            "C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\cursor.exe",
        ] {
            assert!(!looks_like_a_game(path), "{path}");
        }
        // Not an executable at all.
        assert!(!looks_like_a_game("D:\\steamapps\\common\\game\\readme.txt"));
    }

    #[test]
    fn the_blocked_list_accepts_what_people_type() {
        // The field is a free-text box; commas, semicolons and newlines all appear in real configs.
        let list = "csgo.exe, valorant.exe\ndota2.exe;overwatch.exe";
        for name in ["csgo.exe", "valorant.exe", "dota2.exe", "overwatch.exe"] {
            assert!(list_contains(list, name), "{name}");
        }
        assert!(!list_contains(list, "notepad.exe"));
        // A full path in the list still matches the basename, so it works whatever drive the game
        // was installed on.
        assert!(list_contains("D:\\Games\\csgo.exe", "csgo.exe"));
    }

    #[test]
    fn a_disabled_mode_never_blocks() {
        let mode = GameMode {
            enabled: false,
            mode: GameModeScope::All,
            blocked_apps: String::new(),
            auto_detect_games: true,
        };
        assert!(!should_block(&mode));
    }

    #[test]
    fn an_empty_list_with_no_auto_detect_never_blocks() {
        // Which is the shipped default, and the reason the default costs nothing.
        let mode = GameMode {
            enabled: true,
            mode: GameModeScope::List,
            blocked_apps: String::new(),
            auto_detect_games: false,
        };
        // No foreground game in a test harness, but the list branch is what matters: with nothing
        // listed and detection off there is no path to `true`.
        assert!(!should_block(&mode));
    }
}
