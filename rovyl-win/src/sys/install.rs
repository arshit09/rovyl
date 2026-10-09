//! Installing and uninstalling, from the same binary.
//!
//! **Why no NSIS.** The Electron build needs an installer because it is 180 MB of Chromium in
//! several hundred files. This is one executable. Everything an installer would do — copy a file,
//! make two shortcuts, write one registry key — the program can do for itself, and a setup `.exe`
//! that is the application is a setup `.exe` that cannot be out of date.
//!
//! **Two spots, and the difference matters.** [`Spot::Replace`] is `%LOCALAPPDATA%\Programs\Rovyl`
//! — the folder the Electron build owned. An install there is a SUCCESSION: the old build is
//! retired first (see [`crate::sys::migrate`]), and the new executable takes its path, its name,
//! its shortcuts and its entry in Installed apps, so a pinned taskbar button still opens Rovyl
//! afterwards. [`Spot::Beside`] is `...\Rovyl Native`, which is how the port was tried out next to
//! a working 1.x install while it was being written, and is still what `--install --beside` does.
//!
//! **The configuration is never part of either.** Both builds read `%APPDATA%\Rovyl`, so the
//! workspaces survive the succession by not being touched by it — not by being copied anywhere.
//!
//! **Per-user, so nothing asks for a password.** Everything here is under `HKEY_CURRENT_USER` and
//! `%LOCALAPPDATA%`, which is where a launcher belongs: it starts with the user's session and has
//! no business in anybody else's.

use std::path::{Path, PathBuf};
use windows::core::{Interface, HSTRING, PCWSTR};
use windows::Win32::System::Com::{CoCreateInstance, IPersistFile, CLSCTX_INPROC_SERVER};
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
    KEY_SET_VALUE, REG_DWORD, REG_OPTION_NON_VOLATILE, REG_SZ,
};
use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

/// Which of the two install folders is meant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Spot {
    /// `%LOCALAPPDATA%\Programs\Rovyl` — the product's place, inherited from the Electron build.
    Replace,
    /// `%LOCALAPPDATA%\Programs\Rovyl Native` — a second copy, beside a 1.x install.
    Beside,
}

impl Spot {
    /// The folder under `Programs`.
    pub fn folder(self) -> &'static str {
        match self {
            Spot::Replace => "Rovyl",
            Spot::Beside => "Rovyl Native",
        }
    }

    /// The name on the Start menu and in the Installed apps list.
    pub fn display_name(self) -> &'static str {
        match self {
            Spot::Replace => "Rovyl",
            Spot::Beside => "Rovyl (native)",
        }
    }

    /// The shortcut's file name, which is the display name and has to stay that way: Windows pins
    /// a taskbar button by the `.lnk` it was pinned from.
    fn link_name(self) -> String {
        format!("{}.lnk", self.display_name())
    }
}

/// Where the executable goes.
pub fn install_dir(spot: Spot) -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Programs").join(spot.folder())
}

pub fn installed_exe(spot: Spot) -> PathBuf {
    install_dir(spot).join("Rovyl.exe")
}

/// Where the Start menu shortcut goes.
fn start_menu_link(spot: Spot) -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA").map(PathBuf::from)?;
    Some(
        base.join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs")
            .join(spot.link_name()),
    )
}

fn desktop_link(spot: Spot) -> Option<PathBuf> {
    let base = std::env::var_os("USERPROFILE").map(PathBuf::from)?;
    Some(base.join("Desktop").join(spot.link_name()))
}

/// Which install this process is running from, if it is running from one.
///
/// Both are checked because both can exist at once: somebody who tried the port beside their 1.x
/// build and then accepted the update has two, and the uninstaller has to take out the one the
/// user actually clicked rather than whichever is listed first.
pub fn running_spot() -> Option<Spot> {
    let exe = std::env::current_exe().ok()?;
    [Spot::Replace, Spot::Beside]
        .into_iter()
        .find(|spot| exe == installed_exe(*spot))
}

/// Whether this process is already running from an install folder.
pub fn running_installed() -> bool {
    running_spot().is_some()
}

/// What happened, so the caller can say it.
#[derive(Debug)]
pub enum Outcome {
    Installed(PathBuf),
    Failed(String),
}

/// The whole succession, in the order it has to happen.
///
/// This is what the setup window's button runs, and what the Electron build's own updater runs
/// when it spawns this executable with `--updated /S --force-run`.
///
/// **The new executable is copied in before the old one is taken out.** That ordering is the whole
/// safety of this: between the deletion and the copy there is a window in which the machine has no
/// launcher at all, and a copy can fail for reasons that have nothing to do with this program — a
/// full disk, or an antivirus with an opinion about an unsigned executable it has never seen.
/// Staging first means that failure ends with the user still running what they were running.
pub fn take_over() -> Result<PathBuf, String> {
    let previous = crate::sys::migrate::previous();
    // Mirror what was there rather than imposing a default: somebody who deleted the desktop
    // shortcut deleted it on purpose, and an update that puts it back is an update that litters.
    let desktop = previous.as_ref().map(|p| p.desktop_shortcut).unwrap_or(true);
    let at_login = previous
        .as_ref()
        .map(|p| p.starts_with_windows)
        .unwrap_or(false);

    let dir = install_dir(Spot::Replace);
    let target = installed_exe(Spot::Replace);
    let staged = dir.join("Rovyl.new.exe");
    let source = std::env::current_exe().map_err(|e| format!("cannot find this executable: {e}"))?;
    if source == target {
        return Err("already running from the install folder".into());
    }

    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot make {}: {e}", dir.display()))?;
    let _ = std::fs::remove_file(&staged);
    std::fs::copy(&source, &staged)
        .map_err(|e| format!("cannot copy to {}: {e}", staged.display()))?;

    // From here on the new build is on disk, so the old one can go.
    if let Some(previous) = previous.as_ref() {
        for line in crate::sys::migrate::retire(previous, Some(&staged)) {
            crate::config::store::log_line(&format!("migrate: {line}"));
        }
    }
    retire_beside();

    // Anything still running out of the target folder holds `Rovyl.exe` open, and that includes an
    // older native build put here by a previous succession.
    crate::sys::migrate::kill_in(&dir);
    if target.exists() {
        // Windows will not replace a running executable but will rename one out of the way. The
        // leftover goes on the next install, the same as any other upgrade's.
        let stale = target.with_extension("old");
        let _ = std::fs::remove_file(&stale);
        if std::fs::rename(&target, &stale).is_err() {
            let _ = std::fs::remove_file(&target);
        }
    }
    if let Err(error) = std::fs::rename(&staged, &target) {
        // A rename within one folder does not fail for want of space, so this is a lock — in which
        // case a copy will not do better, but it costs one syscall to be sure before giving up.
        std::fs::copy(&staged, &target)
            .map_err(|_| format!("cannot put Rovyl.exe in place: {error}"))?;
        let _ = std::fs::remove_file(&staged);
    }

    finish(Spot::Replace, &target, desktop);
    if at_login {
        crate::sys::autostart::set_for(&target, true);
    }
    Ok(target)
}

/// Remove a side-by-side `Rovyl Native` install, which the succession makes redundant.
///
/// Skipped when this process is running from it — that is a developer testing the migration out of
/// their own install, and deleting the folder under a running executable buys nothing.
fn retire_beside() {
    if running_spot() == Some(Spot::Beside) {
        return;
    }
    let dir = install_dir(Spot::Beside);
    if !dir.exists() {
        return;
    }
    crate::sys::migrate::kill_in(&dir);
    for line in uninstall_at(Spot::Beside, false) {
        crate::config::store::log_line(&format!("migrate: beside: {line}"));
    }
}

/// Copy this executable into place, make the shortcuts, and register the uninstaller.
pub fn install(spot: Spot, desktop_shortcut: bool) -> Outcome {
    let Ok(source) = std::env::current_exe() else {
        return Outcome::Failed("cannot find this executable".into());
    };
    let target = installed_exe(spot);

    if source == target {
        return Outcome::Failed("already running from the install folder".into());
    }
    if let Err(error) = std::fs::create_dir_all(install_dir(spot)) {
        return Outcome::Failed(format!(
            "cannot make {}: {error}",
            install_dir(spot).display()
        ));
    }
    // A running copy holds its own file open, so an upgrade renames the old one aside rather than
    // writing over it. Windows allows renaming a running executable; it does not allow replacing
    // one. The leftover is cleaned up on the next install.
    if target.exists() {
        let stale = target.with_extension("old");
        let _ = std::fs::remove_file(&stale);
        if std::fs::rename(&target, &stale).is_err() {
            let _ = std::fs::remove_file(&target);
        }
    }
    if let Err(error) = std::fs::copy(&source, &target) {
        return Outcome::Failed(format!("cannot copy to {}: {error}", target.display()));
    }

    finish(spot, &target, desktop_shortcut);
    Outcome::Installed(target)
}

/// Everything that turns an executable in a folder into an installed program.
///
/// Shared by the plain install and the succession, because a user who was migrated and a user who
/// ran the setup by hand must end up with exactly the same machine.
fn finish(spot: Spot, target: &Path, desktop_shortcut: bool) {
    // `IShellLink` is a COM object and this can run before anything else in the program has
    // started an apartment -- on the setup window's worker thread, it always does. Without this
    // `CoCreateInstance` fails and the shortcuts are silently not made, which looks exactly like
    // an install that worked.
    unsafe {
        let _ = windows::Win32::System::Com::CoInitializeEx(
            None,
            windows::Win32::System::Com::COINIT_APARTMENTTHREADED,
        );
    }

    // Reported rather than swallowed: a shortcut that was not made is the difference between an
    // installed program and a file in a folder.
    let mut missed = Vec::new();
    if let Some(link) = start_menu_link(spot) {
        if let Err(error) = make_shortcut(&link, target) {
            missed.push(format!("Start menu shortcut: {error}"));
        }
    }
    if desktop_shortcut {
        if let Some(link) = desktop_link(spot) {
            if let Err(error) = make_shortcut(&link, target) {
                missed.push(format!("desktop shortcut: {error}"));
            }
        }
    }
    register_uninstall(spot, target);

    // The copy that was renamed aside, if the process holding it has since gone. Attempted every
    // install rather than only after one, so an upgrade does not leave a file behind for ever
    // because the old build happened to still be running at the time.
    let stale = target.with_extension("old");
    if stale.exists() && std::fs::remove_file(&stale).is_err() {
        schedule_delete(&stale);
    }
    if !missed.is_empty() {
        crate::config::store::log_line(&format!("install: {}", missed.join("; ")));
    }
}

/// Take it all back out — whichever install the running executable belongs to.
///
/// The configuration is LEFT ALONE. A launcher that deletes somebody's workspaces because they
/// uninstalled a build of it is a launcher that cannot be reinstalled. (The 1.x uninstaller did
/// exactly that, which is why `migrate` takes that build apart by hand rather than running it.)
pub fn uninstall() -> Vec<String> {
    uninstall_at(running_spot().unwrap_or(Spot::Replace), true)
}

/// The uninstall, for a named spot.
///
/// `running` says whether this process is the executable being removed, which decides whether the
/// folder can be deleted now or has to wait for a restart.
fn uninstall_at(spot: Spot, running: bool) -> Vec<String> {
    let mut done = Vec::new();

    for link in [start_menu_link(spot), desktop_link(spot)]
        .into_iter()
        .flatten()
    {
        if link.exists() && std::fs::remove_file(&link).is_ok() {
            done.push(format!("removed {}", link.display()));
        }
    }

    // Only OUR entry, and only if it is there — and only when it names the executable being
    // removed. An uninstaller that switched off somebody's working launcher because they removed a
    // different copy of it would be a genuinely bad surprise.
    if crate::sys::autostart::is_set_for(&installed_exe(spot)) {
        crate::sys::autostart::set(false);
        done.push("removed the startup entry".into());
    }

    unsafe {
        let key = HSTRING::from(format!(
            "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{}",
            spot.folder()
        ));
        if RegDeleteTreeW(HKEY_CURRENT_USER, PCWSTR(key.as_ptr())).is_ok() {
            done.push("removed the uninstall entry".into());
        }
    }

    let dir = install_dir(spot);
    if dir.exists() {
        if !running && std::fs::remove_dir_all(&dir).is_ok() {
            done.push(format!("removed {}", dir.display()));
        } else {
            // The executable cannot delete itself while it is running, so the folder is left for
            // the operating system to clean up on the next restart. Saying so is better than
            // pretending.
            schedule_delete(&dir);
            done.push(format!(
                "{} will be removed when Windows next restarts",
                dir.display()
            ));
        }
    }
    done
}

/// Ask Windows to delete a path on the next boot.
///
/// `MoveFileEx` with `DELAY_UNTIL_REBOOT` and no destination is the documented way, and it is what
/// every installer on the platform uses for the file it is running from.
fn schedule_delete(path: &Path) {
    unsafe {
        use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_DELAY_UNTIL_REBOOT};
        // The files first, then the folder: the folder can only go once it is empty. A plain file
        // simply has nothing to enumerate.
        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                let _ = MoveFileExW(
                    &HSTRING::from(entry.path().as_os_str()),
                    PCWSTR::null(),
                    MOVEFILE_DELAY_UNTIL_REBOOT,
                );
            }
        }
        let _ = MoveFileExW(
            &HSTRING::from(path.as_os_str()),
            PCWSTR::null(),
            MOVEFILE_DELAY_UNTIL_REBOOT,
        );
    }
}

/// Write a `.lnk`.
fn make_shortcut(link: &Path, target: &Path) -> windows::core::Result<()> {
    unsafe {
        if let Some(parent) = link.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let shell: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        shell.SetPath(&HSTRING::from(target.as_os_str()))?;
        if let Some(parent) = target.parent() {
            shell.SetWorkingDirectory(&HSTRING::from(parent.as_os_str()))?;
        }
        shell.SetDescription(&HSTRING::from("One gesture. Any destination."))?;
        // The icon is in the executable, so the shortcut points at it rather than carrying a copy.
        shell.SetIconLocation(&HSTRING::from(target.as_os_str()), 0)?;
        let file: IPersistFile = shell.cast()?;
        file.Save(&HSTRING::from(link.as_os_str()), true)?;
        Ok(())
    }
}

/// The entry that puts this in Windows' own "Installed apps" list.
fn register_uninstall(spot: Spot, exe: &Path) {
    unsafe {
        let mut key = HKEY::default();
        let path = HSTRING::from(format!(
            "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{}",
            spot.folder()
        ));
        if RegCreateKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(path.as_ptr()),
            0,
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            None,
            &mut key,
            None,
        )
        .is_err()
        {
            return;
        }

        let mut text = |name: &str, value: String| {
            let wide: Vec<u16> = value.encode_utf16().chain(Some(0)).collect();
            let bytes = std::slice::from_raw_parts(
                wide.as_ptr() as *const u8,
                std::mem::size_of_val(&wide[..]),
            );
            let name = HSTRING::from(name);
            let _ = RegSetValueExW(key, PCWSTR(name.as_ptr()), 0, REG_SZ, Some(bytes));
        };

        text("DisplayName", spot.display_name().into());
        text("DisplayVersion", env!("CARGO_PKG_VERSION").into());
        text("Publisher", "Rovyl".into());
        text("DisplayIcon", exe.display().to_string());
        text("InstallLocation", install_dir(spot).display().to_string());
        text("UninstallString", format!("\"{}\" --uninstall", exe.display()));
        text(
            "QuietUninstallString",
            format!("\"{}\" --uninstall", exe.display()),
        );
        // Per-user, no repair, no modify: there is one file and nothing to repair it from.
        let one: u32 = 1;
        for name in ["NoModify", "NoRepair"] {
            let name = HSTRING::from(name);
            let _ = RegSetValueExW(
                key,
                PCWSTR(name.as_ptr()),
                0,
                REG_DWORD,
                Some(std::slice::from_raw_parts(
                    &one as *const u32 as *const u8,
                    4,
                )),
            );
        }
        // The size Windows shows, in KB.
        if let Ok(meta) = std::fs::metadata(exe) {
            let kb = (meta.len() / 1024) as u32;
            let name = HSTRING::from("EstimatedSize");
            let _ = RegSetValueExW(
                key,
                PCWSTR(name.as_ptr()),
                0,
                REG_DWORD,
                Some(std::slice::from_raw_parts(&kb as *const u32 as *const u8, 4)),
            );
        }
        let _ = RegCloseKey(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_succession_takes_the_folder_the_electron_build_owned() {
        // The point of `Replace`: the path a pinned taskbar button, a Start menu tile and a
        // desktop shortcut already name. An install anywhere else is an install the user's own
        // shortcuts do not reach.
        assert_eq!(install_dir(Spot::Replace), crate::sys::migrate::electron_dir());
        assert_eq!(Spot::Replace.display_name(), "Rovyl");
    }

    #[test]
    fn the_side_by_side_spot_is_a_different_folder_and_says_so() {
        let beside = install_dir(Spot::Beside);
        assert!(beside.ends_with("Rovyl Native"));
        assert_ne!(beside, install_dir(Spot::Replace));
        // Two entries in Installed apps that both read "Rovyl" would be unusable.
        assert_ne!(Spot::Beside.display_name(), Spot::Replace.display_name());
    }

    #[test]
    fn the_shortcuts_land_where_windows_looks_for_them() {
        for spot in [Spot::Replace, Spot::Beside] {
            let start = start_menu_link(spot).expect("a Start menu path");
            assert!(start.to_string_lossy().contains("Start Menu"));
            assert_eq!(start.extension().and_then(|e| e.to_str()), Some("lnk"));
            let desktop = desktop_link(spot).expect("a desktop path");
            assert!(desktop.to_string_lossy().contains("Desktop"));
        }
    }

    #[test]
    fn running_from_somewhere_else_is_not_running_installed() {
        // The build tree is not an install folder, which is what makes `--install` meaningful.
        assert!(!running_installed());
    }
}
