//! The notification-area icon and its menu.
//!
//! The tray is the only thing on screen while the app idles, and for a launcher that is the point:
//! it is a program the user interacts with through a gesture, not through a window. It is also the
//! one place the app can be quit from, which is why it is not optional and why its menu opens even
//! when nothing else about the app is working.
//!
//! **Why the menu waits for the mouse buttons.** Opening a popup menu while a button is physically
//! held leaves the menu's own modal loop owning input that the hook is also watching, and the menu
//! then does not close when the button is released — it sits there until clicked a second time.
//! `hook::notify_on_buttons_up` is what this waits for.

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, POINT, WPARAM};
use windows::Win32::UI::HiDpi::{GetDpiForSystem, GetSystemMetricsForDpi};
use windows::Win32::UI::Shell::{
    Shell_NotifyIconW, NIF_ICON, NIF_MESSAGE, NIF_SHOWTIP, NIF_TIP, NIM_ADD, NIM_DELETE,
    NIM_MODIFY, NIM_SETVERSION, NOTIFYICONDATAW, NOTIFYICONDATAW_0, NOTIFYICON_VERSION_4,
};
use windows::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreatePopupMenu, DestroyMenu, GetCursorPos, LoadImageW, PostMessageW,
    SetForegroundWindow, ShowWindow, TrackPopupMenuEx, HICON, HMENU, IMAGE_ICON, LR_SHARED,
    MF_CHECKED, MF_GRAYED, MF_POPUP, MF_SEPARATOR, MF_STRING, MF_UNCHECKED, SM_CXICON, SM_CXSMICON,
    SM_CYICON, SM_CYSMICON, SW_HIDE, SW_SHOWNA, SYSTEM_METRICS_INDEX, TPM_BOTTOMALIGN,
    TPM_RIGHTBUTTON, WM_APP, WM_NULL,
};

/// The message the icon sends to the app's window.
pub const MSG_TRAY: u32 = WM_APP + 300;

/// The icon was chosen with the mouse. `shellapi.h` spells it `WM_USER + 0`.
///
/// Written out rather than imported because the `windows` crate does not carry the `NIN_*` family,
/// and a version 4 icon says this instead of `WM_LBUTTONUP` when it is activated.
pub const NIN_SELECT: u32 = 0x0400;
/// The icon was chosen with the keyboard — `NIN_SELECT | NINF_KEY`.
pub const NIN_KEYSELECT: u32 = 0x0401;

/// Menu command ids. They are returned by `TrackPopupMenuEx` and handled in one place.
pub const CMD_OPEN_WHEEL: u32 = 1;
pub const CMD_SETTINGS: u32 = 2;
pub const CMD_PAUSE: u32 = 3;
pub const CMD_QUIT: u32 = 4;
/// Ask the release feed, or open the release the last answer named.
pub const CMD_UPDATES: u32 = 5;
/// End a pause, however it was started.
pub const CMD_RESUME: u32 = 6;
/// `CMD_PAUSE_BASE + n` is `PAUSE_CHOICES[n]`, and `CMD_WORKSPACE_BASE + n` is the nth workspace.
///
/// Bases rather than a constant each, because both lists are as long as they need to be and a menu
/// built from a list cannot have a name for every item in it. They are far enough apart that a
/// list growing past its block is not a silent collision — `workspace_of` and `pause_minutes_of`
/// are what read them back, and the ranges are tested.
pub const CMD_PAUSE_BASE: u32 = 10;
pub const CMD_WORKSPACE_BASE: u32 = 100;

/// How long "pause" can mean. Minutes, because the label says minutes. The original's three.
pub const PAUSE_CHOICES: [u32; 3] = [15, 30, 60];

/// The workspace a command id names, if it names one.
pub fn workspace_of(command: u32, count: usize) -> Option<usize> {
    let index = command.checked_sub(CMD_WORKSPACE_BASE)? as usize;
    (index < count).then_some(index)
}

/// The number of minutes a command id asks to be paused for, if it asks for any.
pub fn pause_minutes_of(command: u32) -> Option<u32> {
    let index = command.checked_sub(CMD_PAUSE_BASE)? as usize;
    PAUSE_CHOICES.get(index).copied()
}

/// A nul-terminated wide string that stays put while the menu reads it.
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// What the app tells the menu about itself.
///
/// A struct rather than five arguments: the menu has grown from four fixed items to one that
/// describes the program's state, and a positional list of bools and options at the call site is
/// how the wrong one gets passed.
pub struct MenuState<'a> {
    pub version: &'a str,
    /// The workspaces offered, as `(index in the configuration, name, is the current one)`.
    ///
    /// The index travels with the name because the list is FILTERED — a disabled workspace is not
    /// offered — so an item's position in the menu is not its position in the configuration. The
    /// command id is built from the real index, which is the only one `switch_workspace` accepts.
    pub workspaces: Vec<(usize, String, bool)>,
    pub paused: bool,
    /// Whole minutes left on a timed pause. `None` while paused with no end, or not paused.
    pub minutes_left: Option<u32>,
    pub update: UpdateLine,
}

/// The one line the menu gives updates, which is the panel's row said shorter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateLine {
    Idle,
    Checking,
    UpToDate,
    Available(String),
    Unreachable,
}

impl UpdateLine {
    pub fn label(&self) -> &'static str {
        match self {
            UpdateLine::Idle => "Check for updates",
            UpdateLine::Checking => "Checking for updates\u{2026}",
            UpdateLine::UpToDate => "You are on the latest version",
            UpdateLine::Available(_) => "An update is available",
            UpdateLine::Unreachable => "Could not check for updates",
        }
    }

    /// Whether pressing it does anything. A check already running is the one state with no action
    /// behind it — and a live item that silently did nothing is worse than a greyed one.
    pub fn pressable(&self) -> bool {
        !matches!(self, UpdateLine::Checking)
    }
}

/// The workspaces a menu should offer, each with the index the configuration knows it by.
///
/// A disabled workspace is left out: the wheel refuses to switch to one, so a menu item for it
/// would be a row that does nothing when pressed. Leaving it out is what makes the index and the
/// position differ, which is why the index is carried rather than recomputed.
pub fn workspaces_for_menu(
    names: impl IntoIterator<Item = (String, bool)>,
    active: usize,
) -> Vec<(usize, String, bool)> {
    names
        .into_iter()
        .enumerate()
        .filter(|(_, (_, enabled))| *enabled)
        .map(|(index, (name, _))| (index, name, index == active))
        .collect()
}

/// What the pause submenu is called, which is also where a timed pause reports its clock.
fn pause_title(state: &MenuState) -> String {
    match (state.paused, state.minutes_left) {
        (false, _) => "Pause triggers".into(),
        // Rounded up by the caller, so a pause with forty seconds left says "1 min left" rather
        // than "0" — the one number this label must never show.
        (true, Some(minutes)) => format!("Paused \u{2014} {} min left", minutes.max(1)),
        (true, None) => "Paused".into(),
    }
}


/// The icon's identifier within this window. Any value works; it just has to be stable across the
/// add, the modify and the delete.
const ICON_ID: u32 = 1;

pub struct Tray {
    hwnd: HWND,
    added: bool,
    /// Whether `NIM_SETVERSION` took, which decides what the shell's callbacks MEAN.
    ///
    /// Not a detail of the registration: a version 4 icon and a legacy one describe the same
    /// gesture in different words, and reading one vocabulary against the other is how a single
    /// right click gets acted on twice. [`Tray::classify`] is told this rather than left to guess.
    version_4: bool,
}

impl Tray {
    /// Add the icon. `tip` is the hover text, which is the only name the user ever sees for the
    /// process.
    pub fn new(hwnd: HWND) -> Self {
        let mut tray = Self { hwnd, added: false, version_4: false };
        tray.add();
        tray
    }

    /// Which vocabulary the shell is speaking, for [`Tray::classify`] and [`Tray::menu_point`].
    pub fn version_4(&self) -> bool {
        self.version_4
    }

    fn data(&self) -> NOTIFYICONDATAW {
        let mut data = NOTIFYICONDATAW {
            cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
            hWnd: self.hwnd,
            uID: ICON_ID,
            // `NIF_SHOWTIP` is not redundant next to `NIF_TIP`: version 4 suppresses the standard
            // tooltip on the assumption that the app draws its own rich one, so without it `szTip`
            // is stored and never shown and hovering the icon names nothing.
            uFlags: NIF_ICON | NIF_MESSAGE | NIF_TIP | NIF_SHOWTIP,
            uCallbackMessage: MSG_TRAY,
            // The shell draws this at `SM_CXSMICON`, so the small frame is what it wants.
            hIcon: app_icon_small(),
            Anonymous: NOTIFYICONDATAW_0 {
                uVersion: NOTIFYICON_VERSION_4,
            },
            ..Default::default()
        };
        // The tooltip is a fixed-size array, not a pointer: it is copied in rather than referenced.
        let tip: Vec<u16> = "Rovyl".encode_utf16().chain(std::iter::once(0)).collect();
        data.szTip[..tip.len()].copy_from_slice(&tip);
        data
    }

    fn add(&mut self) {
        let data = self.data();
        unsafe {
            if Shell_NotifyIconW(NIM_ADD, &data).as_bool() {
                self.added = true;
                // Version 4 is what makes the callback carry the cursor position in `wParam`,
                // which is the only reliable way to place the menu: `GetCursorPos` at the time the
                // message is HANDLED can be somewhere else entirely if the queue ran behind.
                self.version_4 = Shell_NotifyIconW(NIM_SETVERSION, &data).as_bool();
            }
        }
    }

    /// Put the icon back after Explorer restarts.
    ///
    /// Explorer broadcasts `TaskbarCreated` when it comes back from a crash or a restart, and an
    /// icon that does not re-add itself is simply gone for the rest of the session — with the only
    /// way to quit the app gone with it.
    pub fn restore(&mut self) {
        self.added = false;
        self.add();
    }

    pub fn update_tip(&self, tip: &str) {
        if !self.added {
            return;
        }
        let mut data = self.data();
        data.szTip = [0; 128];
        let encoded: Vec<u16> = tip.encode_utf16().take(127).chain(std::iter::once(0)).collect();
        data.szTip[..encoded.len()].copy_from_slice(&encoded);
        unsafe {
            let _ = Shell_NotifyIconW(NIM_MODIFY, &data);
        }
    }

    /// Show the menu at `at`, and return the command the user picked.
    ///
    /// Blocks in the menu's own modal loop until a choice is made, which is why the caller waits
    /// for every mouse button to be released first.
    pub fn show_menu(&self, at: POINT, state: &MenuState) -> Option<u32> {
        unsafe {
            let menu: HMENU = CreatePopupMenu().ok()?;
            // Every dynamic label has to outlive `TrackPopupMenuEx`: `AppendMenuW` takes a pointer
            // and the menu reads it when it draws. A `String` formatted inline would be freed at
            // the end of the statement that made it, and the menu would show whatever took its
            // place in the allocator.
            let mut alive: Vec<Vec<u16>> = Vec::new();
            let mut submenus: Vec<HMENU> = Vec::new();

            // The version, as a heading rather than a command. Disabled, because there is nothing
            // to press — it is there so "which build is this" is answerable without opening a
            // window, which is the question a tray icon is asked when something looks wrong.
            let header = wide(&format!("Rovyl {}", state.version));
            let _ = AppendMenuW(menu, MF_STRING | MF_GRAYED, 0, PCWSTR(header.as_ptr()));
            alive.push(header);
            let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());

            let _ = AppendMenuW(menu, MF_STRING, CMD_OPEN_WHEEL as usize, w!("Open wheel"));

            // The workspaces, with the current one ticked. A radio mark rather than a check: they
            // are one choice, and a column of check marks would say several could be on at once.
            if state.workspaces.len() > 1 {
                let sub = CreatePopupMenu().ok()?;
                for (index, name, active) in &state.workspaces {
                    let label = wide(name);
                    let flags = MF_STRING | if *active { MF_CHECKED } else { MF_UNCHECKED };
                    let _ = AppendMenuW(
                        sub,
                        flags,
                        (CMD_WORKSPACE_BASE + *index as u32) as usize,
                        PCWSTR(label.as_ptr()),
                    );
                    alive.push(label);
                }
                let _ = AppendMenuW(menu, MF_POPUP, sub.0 as usize, w!("Workspace"));
                submenus.push(sub);
            }

            let _ = AppendMenuW(menu, MF_STRING, CMD_SETTINGS as usize, w!("Settings"));
            let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());

            // Pause, as a submenu rather than a switch.
            //
            // A pause with no end is a pause somebody forgets they set, and then Rovyl is simply
            // broken until they remember. The timed choices are the answer to that; "Until I
            // resume" is still there, because somebody giving a presentation knows exactly what
            // they want and should not have to guess at a number of minutes.
            let sub = CreatePopupMenu().ok()?;
            if state.paused {
                let _ = AppendMenuW(sub, MF_STRING, CMD_RESUME as usize, w!("Resume now"));
                let _ = AppendMenuW(sub, MF_SEPARATOR, 0, PCWSTR::null());
                for (index, minutes) in PAUSE_CHOICES.iter().enumerate() {
                    let label = wide(&format!("Restart for {minutes} minutes"));
                    let _ = AppendMenuW(
                        sub,
                        MF_STRING,
                        (CMD_PAUSE_BASE + index as u32) as usize,
                        PCWSTR(label.as_ptr()),
                    );
                    alive.push(label);
                }
            } else {
                for (index, minutes) in PAUSE_CHOICES.iter().enumerate() {
                    let label = wide(&format!("For {minutes} minutes"));
                    let _ = AppendMenuW(
                        sub,
                        MF_STRING,
                        (CMD_PAUSE_BASE + index as u32) as usize,
                        PCWSTR(label.as_ptr()),
                    );
                    alive.push(label);
                }
                let _ = AppendMenuW(sub, MF_SEPARATOR, 0, PCWSTR::null());
                let _ = AppendMenuW(sub, MF_STRING, CMD_PAUSE as usize, w!("Until I resume"));
            }
            let pause_label = wide(&pause_title(state));
            let _ = AppendMenuW(menu, MF_POPUP, sub.0 as usize, PCWSTR(pause_label.as_ptr()));
            alive.push(pause_label);
            submenus.push(sub);

            let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
            let updates = wide(state.update.label());
            let _ = AppendMenuW(
                menu,
                MF_STRING | if state.update.pressable() { MF_STRING } else { MF_GRAYED },
                CMD_UPDATES as usize,
                PCWSTR(updates.as_ptr()),
            );
            alive.push(updates);

            let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
            let _ = AppendMenuW(menu, MF_STRING, CMD_QUIT as usize, w!("Quit Rovyl"));

            // The documented dance: the owner window must be foreground before the menu is shown,
            // or the menu does not dismiss when the user clicks away from it.
            //
            // The window has to be SHOWN for that to be possible at all. `SetForegroundWindow`
            // refuses a window that is not visible, and the owner here is the message window,
            // which is never shown — so the call was failing every time and the menu was left
            // without the foreground it needs. The symptom is not a menu that fails to open; it is
            // one that opens and then will not go away, because the click aimed at dismissing it
            // never reaches it.
            //
            // Showing it puts nothing on screen: it is a `WS_POPUP` of zero size with no frame to
            // draw, and `WS_EX_TOOLWINDOW` keeps it out of the taskbar and out of Alt-Tab. It is
            // hidden again the moment the menu closes, which is what hands the foreground back to
            // whatever the user was actually working in.
            let _ = ShowWindow(self.hwnd, SW_SHOWNA);
            let _ = SetForegroundWindow(self.hwnd);
            let chosen = TrackPopupMenuEx(
                menu,
                // `RETURNCMD` is what makes this return the id instead of posting `WM_COMMAND`,
                // which keeps the whole interaction in one function.
                (TPM_RIGHTBUTTON | TPM_BOTTOMALIGN).0
                    | windows::Win32::UI::WindowsAndMessaging::TPM_RETURNCMD.0,
                at.x,
                at.y,
                self.hwnd,
                None,
            );
            // The other half of the documented dance (KB135788): the menu's modal loop needs one
            // more message through the owner's queue before it will accept that it has lost the
            // foreground. Without it, it is the NEXT menu that misbehaves.
            let _ = PostMessageW(self.hwnd, WM_NULL, WPARAM(0), LPARAM(0));
            let _ = ShowWindow(self.hwnd, SW_HIDE);
            // Destroying the parent destroys the submenus with it, so they are not freed here —
            // doing both is a double free.
            let _ = submenus;
            let _ = DestroyMenu(menu);
            drop(alive);
            (chosen.0 != 0).then_some(chosen.0 as u32)
        }
    }

    /// Where the menu should appear for a tray message.
    ///
    /// Version 4 callbacks carry the anchor in `wParam`, which is the only reliable placement: the
    /// cursor read later can be somewhere else entirely if the queue ran behind.
    ///
    /// Under the legacy contract `wParam` is the ICON ID, not a position — read as one it puts the
    /// menu at (1, 0), in the corner of the primary display. That is why this is told which
    /// contract is in force rather than treating a zero as the only sign of one.
    pub fn menu_point(w: WPARAM, version_4: bool) -> POINT {
        if version_4 {
            let x = (w.0 & 0xFFFF) as u16 as i16 as i32;
            let y = ((w.0 >> 16) & 0xFFFF) as u16 as i16 as i32;
            if x != 0 || y != 0 {
                return POINT { x, y };
            }
        }
        let mut point = POINT::default();
        unsafe {
            let _ = GetCursorPos(&mut point);
        }
        point
    }

    /// What a tray callback means. Returned as an enum so the caller does not repeat the constants.
    ///
    /// **Why the version decides which messages are read.** A version 4 icon is sent BOTH
    /// vocabularies for one gesture: a right click arrives as `WM_RBUTTONDOWN`, `WM_RBUTTONUP`
    /// AND `WM_CONTEXTMENU`, a left click as `WM_LBUTTONUP` AND `NIN_SELECT`. Answering both
    /// spellings is how one press asks for two menus, and how one click opens the wheel and closes
    /// it again in the same breath. So each contract is read in its own words and the other
    /// spelling of the same gesture is ignored — which is also what makes `NIN_KEYSELECT`
    /// reachable, the only way a keyboard can work the icon at all.
    pub fn classify(l: LPARAM, version_4: bool) -> TrayEvent {
        use windows::Win32::UI::WindowsAndMessaging::{
            WM_CONTEXTMENU, WM_LBUTTONDBLCLK, WM_LBUTTONUP, WM_RBUTTONUP,
        };
        let message = (l.0 as u32) & 0xFFFF;
        // A double click has no version 4 spelling of its own — the shell delivers the plain mouse
        // message under either contract — so it is answered before the two part ways.
        if message == WM_LBUTTONDBLCLK {
            return TrayEvent::Settings;
        }
        if version_4 {
            return match message {
                // A single left click, or Enter/Space on the icon with the keyboard. Both open the
                // wheel: that is the gesture people try first, and a tray icon that does nothing
                // on it reads as broken.
                NIN_SELECT | NIN_KEYSELECT => TrayEvent::Activate,
                // Sent for a right click AND for the menu key, which is the point of answering
                // this rather than `WM_RBUTTONUP`.
                WM_CONTEXTMENU => TrayEvent::Menu,
                _ => TrayEvent::Nothing,
            };
        }
        match message {
            WM_LBUTTONUP => TrayEvent::Activate,
            WM_RBUTTONUP | WM_CONTEXTMENU => TrayEvent::Menu,
            _ => TrayEvent::Nothing,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayEvent {
    Activate,
    Settings,
    Menu,
    Nothing,
}

impl Drop for Tray {
    fn drop(&mut self) {
        if !self.added {
            return;
        }
        // An icon left behind outlives the process and sits in the tray until the user hovers it.
        unsafe {
            let _ = Shell_NotifyIconW(
                NIM_DELETE,
                &NOTIFYICONDATAW {
                    cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
                    hWnd: self.hwnd,
                    uID: ICON_ID,
                    ..Default::default()
                },
            );
        }
    }
}

/// The product's icon at the large size, for the Alt-Tab list and the window's own title bar.
///
/// Resource id 1, which is what `rovyl.rc` links in and what Explorer also uses for the file's
/// icon — so the tray, the taskbar and the shortcut cannot disagree.
pub fn app_icon() -> HICON {
    app_icon_sized(SM_CXICON, SM_CYICON)
}

/// The product's icon at the small size, for the taskbar button and the notification area.
///
/// Worth keeping separate from [`app_icon`]: handed the large icon for a small slot, Windows
/// downscales 32px to 16px itself, and that is visibly softer than the 16px frame the `.ico`
/// already carries.
pub fn app_icon_small() -> HICON {
    app_icon_sized(SM_CXSMICON, SM_CYSMICON)
}

/// Load resource icon 1 at the size the given system metrics report.
///
/// `LoadImageW` rather than `LoadIconW`, because `LoadIconW` only ever returns `SM_CXICON` — it
/// has no way to ask for the small frame.
///
/// The metrics are read `ForDpi` rather than plain: `GetSystemMetrics` reports 96-DPI values to a
/// per-monitor-aware process like this one (see `monitor::declare_dpi_awareness`), so on a scaled
/// display it asks for a 16px icon for a slot the shell draws at 24px and the shell stretches the
/// difference. `GetDpiForSystem` and not the wheel's monitor: the notification area lives on the
/// primary display, which is the one the system DPI describes.
fn app_icon_sized(cx: SYSTEM_METRICS_INDEX, cy: SYSTEM_METRICS_INDEX) -> HICON {
    unsafe {
        let module: HINSTANCE = windows::Win32::System::LibraryLoader::GetModuleHandleW(None)
            .unwrap_or_default()
            .into();
        // `LR_SHARED` hands back the same cached handle on every call instead of a fresh copy.
        // These icons are never destroyed — a window class holds its own for the life of the
        // process — so anything else would leak one per call.
        LoadImageW(
            module,
            PCWSTR(1 as *const u16),
            IMAGE_ICON,
            GetSystemMetricsForDpi(cx, GetDpiForSystem()),
            GetSystemMetricsForDpi(cy, GetDpiForSystem()),
            LR_SHARED,
        )
        .map(|handle| HICON(handle.0))
        .unwrap_or_default()
    }
}

/// The message Explorer broadcasts when the taskbar is recreated.
///
/// Registered rather than a constant: it is a dynamically allocated message id, and the value
/// differs between sessions.
pub fn taskbar_created_message() -> u32 {
    unsafe { windows::Win32::UI::WindowsAndMessaging::RegisterWindowMessageW(w!("TaskbarCreated")) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_commands_are_distinct_and_nonzero() {
        // Zero is what `TrackPopupMenuEx` returns for "nothing was chosen", so no command may be it.
        let commands = [
            CMD_OPEN_WHEEL,
            CMD_SETTINGS,
            CMD_PAUSE,
            CMD_QUIT,
            CMD_UPDATES,
            CMD_RESUME,
        ];
        for command in commands {
            assert_ne!(command, 0);
        }
        for (i, a) in commands.iter().enumerate() {
            for b in &commands[i + 1..] {
                assert_ne!(a, b);
            }
        }
    }

    #[test]
    fn the_two_id_ranges_never_reach_the_fixed_commands_or_each_other() {
        // The failure this guards against is silent and total: a list long enough to run into the
        // next block gives a menu item somebody else's meaning, and "switch to workspace 7" opens
        // as "quit".
        let fixed = [CMD_OPEN_WHEEL, CMD_SETTINGS, CMD_PAUSE, CMD_QUIT, CMD_UPDATES, CMD_RESUME];
        for command in fixed {
            assert!(command < CMD_PAUSE_BASE, "{command} collides with the pause block");
            assert_eq!(pause_minutes_of(command), None);
            assert_eq!(workspace_of(command, 64), None);
        }
        assert!(CMD_PAUSE_BASE + PAUSE_CHOICES.len() as u32 <= CMD_WORKSPACE_BASE);
    }

    #[test]
    fn a_command_id_decodes_back_to_what_the_menu_meant() {
        assert_eq!(pause_minutes_of(CMD_PAUSE_BASE), Some(PAUSE_CHOICES[0]));
        assert_eq!(pause_minutes_of(CMD_PAUSE_BASE + 2), Some(PAUSE_CHOICES[2]));
        // Past the end of the list is not a pause, however close the number is.
        assert_eq!(pause_minutes_of(CMD_PAUSE_BASE + 3), None);

        assert_eq!(workspace_of(CMD_WORKSPACE_BASE, 3), Some(0));
        assert_eq!(workspace_of(CMD_WORKSPACE_BASE + 2, 3), Some(2));
        // The count is what bounds it: a menu built when there were five workspaces must not
        // address a sixth after one was deleted while it was open.
        assert_eq!(workspace_of(CMD_WORKSPACE_BASE + 3, 3), None);
        assert_eq!(workspace_of(CMD_WORKSPACE_BASE - 1, 3), None);
    }

    #[test]
    fn a_menu_item_carries_the_index_the_configuration_knows_not_its_own_position() {
        // The bug this exists for: filter a disabled workspace out of the list, then address the
        // remainder by their position in the MENU, and every workspace after the disabled one
        // switches to its neighbour. Silent, and only on a configuration that has one.
        let names = vec![
            ("Work".to_string(), false),
            ("Games".to_string(), true),
            ("Stream".to_string(), true),
        ];
        let offered = workspaces_for_menu(names, 2);
        assert_eq!(
            offered,
            vec![
                (1, "Games".to_string(), false),
                (2, "Stream".to_string(), true),
            ]
        );
        // And the id built from that index decodes back to it.
        let (index, _, _) = offered[0].clone();
        assert_eq!(workspace_of(CMD_WORKSPACE_BASE + index as u32, 3), Some(1));
    }

    #[test]
    fn the_pause_label_never_says_zero_minutes_left() {
        // Forty seconds left is not "no time left", and a menu that said so would be describing a
        // pause that had already ended.
        let state = |paused, minutes| MenuState {
            version: "1.19.0",
            workspaces: Vec::new(),
            paused,
            minutes_left: minutes,
            update: UpdateLine::Idle,
        };
        assert_eq!(pause_title(&state(false, None)), "Pause triggers");
        assert_eq!(pause_title(&state(true, None)), "Paused");
        assert!(pause_title(&state(true, Some(0))).contains("1 min left"));
        assert!(pause_title(&state(true, Some(12))).contains("12 min left"));
    }

    #[test]
    fn a_check_already_running_is_the_only_unpressable_update_line() {
        for line in [
            UpdateLine::Idle,
            UpdateLine::UpToDate,
            UpdateLine::Available("1.20.0".into()),
            UpdateLine::Unreachable,
        ] {
            assert!(line.pressable(), "{line:?}");
            assert!(!line.label().is_empty());
        }
        assert!(!UpdateLine::Checking.pressable());
    }

    #[test]
    fn a_wide_string_is_terminated() {
        // `AppendMenuW` reads until the nul. Without one the menu shows whatever follows the
        // allocation, which is the kind of bug that only appears on somebody else's machine.
        let encoded = wide("Rovyl");
        assert_eq!(encoded.last(), Some(&0));
        assert_eq!(String::from_utf16_lossy(&encoded[..encoded.len() - 1]), "Rovyl");
    }

    #[test]
    fn the_position_is_signed() {
        // A tray icon on a monitor left of the primary reports a negative x; read unsigned, the
        // menu opens tens of thousands of pixels away.
        let packed = WPARAM(((-100i32 as u16 as usize) & 0xFFFF) | (((50i32 as u16 as usize) & 0xFFFF) << 16));
        let point = Tray::menu_point(packed, true);
        assert_eq!((point.x, point.y), (-100, 50));
    }

    #[test]
    fn a_legacy_callback_never_reads_its_icon_id_as_a_position() {
        // Under the legacy contract `wParam` is the icon id. Read as a point, id 1 is (1, 0) — the
        // corner of the primary display, which is nowhere near the icon that was clicked. The
        // fallback has to be the cursor, and "is it zero" cannot be what decides that: 1 is not 0.
        let point = Tray::menu_point(WPARAM(ICON_ID as usize), false);
        assert_ne!((point.x, point.y), (1, 0));
    }

    #[test]
    fn a_version_4_gesture_is_acted_on_once_not_twice() {
        use windows::Win32::UI::WindowsAndMessaging::{
            WM_CONTEXTMENU, WM_LBUTTONDBLCLK, WM_LBUTTONUP, WM_RBUTTONUP,
        };
        // The bug this exists for: the shell sends a version 4 icon BOTH spellings of one gesture.
        // Answering both opened two menus for one right click, and opened the wheel and shut it
        // again for one left click. Under version 4 only the version 4 words count.
        let v4 = |m: u32| Tray::classify(LPARAM(m as isize), true);
        assert_eq!(v4(NIN_SELECT), TrayEvent::Activate);
        assert_eq!(v4(NIN_KEYSELECT), TrayEvent::Activate);
        assert_eq!(v4(WM_CONTEXTMENU), TrayEvent::Menu);
        assert_eq!(v4(WM_LBUTTONUP), TrayEvent::Nothing, "the other spelling of NIN_SELECT");
        assert_eq!(v4(WM_RBUTTONUP), TrayEvent::Nothing, "the other spelling of WM_CONTEXTMENU");
        // A double click has no version 4 spelling, so it is the one mouse message still read.
        assert_eq!(v4(WM_LBUTTONDBLCLK), TrayEvent::Settings);
        assert_eq!(v4(0), TrayEvent::Nothing);
    }

    #[test]
    fn a_legacy_shell_is_still_understood() {
        use windows::Win32::UI::WindowsAndMessaging::{
            WM_CONTEXTMENU, WM_LBUTTONDBLCLK, WM_LBUTTONUP, WM_RBUTTONUP,
        };
        // `NIM_SETVERSION` can fail, and then none of the `NIN_*` notifications are ever sent —
        // reading only those would leave the icon completely dead.
        let legacy = |m: u32| Tray::classify(LPARAM(m as isize), false);
        assert_eq!(legacy(WM_LBUTTONUP), TrayEvent::Activate);
        assert_eq!(legacy(WM_LBUTTONDBLCLK), TrayEvent::Settings);
        assert_eq!(legacy(WM_RBUTTONUP), TrayEvent::Menu);
        // The keyboard's menu key arrives as this under either contract, so it is worth keeping.
        assert_eq!(legacy(WM_CONTEXTMENU), TrayEvent::Menu);
        assert_eq!(legacy(NIN_SELECT), TrayEvent::Nothing);
        assert_eq!(legacy(0), TrayEvent::Nothing);
    }

    #[test]
    fn the_icon_id_rides_in_the_high_word_and_is_not_mistaken_for_the_event() {
        // A version 4 callback packs the icon id into HIWORD(lParam). Read whole, `NIN_SELECT`
        // from icon 1 is 0x1_0400 and matches nothing at all.
        let packed = LPARAM(((ICON_ID as isize) << 16) | NIN_SELECT as isize);
        assert_eq!(Tray::classify(packed, true), TrayEvent::Activate);
    }
}
