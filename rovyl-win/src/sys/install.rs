//! Installing and uninstalling, from the same binary.
//!
//! **Why no NSIS.** The Electron build needs an installer because it is 180 MB of Chromium in
//! several hundred files. This is one executable. Everything an installer would do — copy a file,
//! make two shortcuts, write one registry key — the program can do for itself, and a setup `.exe`
//! that is the application is a setup `.exe` that cannot be out of date.
//!
//! **It never touches the Electron build.** Both read `%APPDATA%\Rovyl`, on purpose, so the two
//! share one set of workspaces. But the Electron build installs to
//! `%LOCALAPPDATA%\Programs\Rovyl`, and installing over it would replace a working launcher with
//! one the user has not decided to switch to yet. This goes in a folder of its own and says so.
//!
//! **Per-user, so nothing asks for a password.** Everything here is under `HKEY_CURRENT_USER` and
//! `%LOCALAPPDATA%`, which is where a launcher belongs: it starts with the user's session and has
//! no business in anybody else's.

use std::path::{Path, PathBuf};
use windows::core::{Interface, HSTRING, PCWSTR};
use windows::Win32::System::Com::{CoCreateInstance, IPersistFile, CLSCTX_INPROC_SERVER};
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
    KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ, REG_DWORD,
};
use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

/// The folder this installs into.
///
/// `Rovyl Native`, not `Rovyl`: the Electron build owns that one, and the point of a port is to be
/// tried beside the thing it ports, not instead of it before anybody has looked at it.
pub const FOLDER: &str = "Rovyl Native";

/// The name on the Start menu and on the uninstall list.
pub const DISPLAY_NAME: &str = "Rovyl (native)";

/// Where the executable goes.
pub fn install_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Programs").join(FOLDER)
}

pub fn installed_exe() -> PathBuf {
    install_dir().join("Rovyl.exe")
}

/// Where the Start menu shortcut goes.
fn start_menu_link() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA").map(PathBuf::from)?;
    Some(
        base.join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs")
            .join(format!("{DISPLAY_NAME}.lnk")),
    )
}

fn desktop_link() -> Option<PathBuf> {
    let base = std::env::var_os("USERPROFILE").map(PathBuf::from)?;
    Some(base.join("Desktop").join(format!("{DISPLAY_NAME}.lnk")))
}

/// Whether this process is already running from the install folder.
pub fn running_installed() -> bool {
    std::env::current_exe()
        .map(|exe| exe == installed_exe())
        .unwrap_or(false)
}

/// What happened, so the caller can say it.
#[derive(Debug)]
pub enum Outcome {
    Installed(PathBuf),
    Failed(String),
}

/// Copy this executable into place, make the shortcuts, and register the uninstaller.
pub fn install(desktop_shortcut: bool) -> Outcome {
    // `IShellLink` is a COM object and this runs before anything else in the program has started
    // an apartment. Without it `CoCreateInstance` fails and the shortcuts are silently not made --
    // which looks exactly like an install that worked.
    unsafe {
        let _ = windows::Win32::System::Com::CoInitializeEx(
            None,
            windows::Win32::System::Com::COINIT_APARTMENTTHREADED,
        );
    }
    let Ok(source) = std::env::current_exe() else {
        return Outcome::Failed("cannot find this executable".into());
    };
    let target = installed_exe();

    if source == target {
        return Outcome::Failed("already running from the install folder".into());
    }
    if let Err(error) = std::fs::create_dir_all(install_dir()) {
        return Outcome::Failed(format!("cannot make {}: {error}", install_dir().display()));
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

    // Reported rather than swallowed: a shortcut that was not made is the difference between an
    // installed program and a file in a folder.
    let mut missed = Vec::new();
    if let Some(link) = start_menu_link() {
        if let Err(error) = make_shortcut(&link, &target) {
            missed.push(format!("Start menu shortcut: {error}"));
        }
    }
    if desktop_shortcut {
        if let Some(link) = desktop_link() {
            if let Err(error) = make_shortcut(&link, &target) {
                missed.push(format!("desktop shortcut: {error}"));
            }
        }
    }
    register_uninstall(&target);
    // The copy that was renamed aside, if the process holding it has since gone. Attempted every
    // install rather than only after one, so an upgrade does not leave a 1.5 MB file behind for
    // ever because the old build happened to still be running at the time.
    let stale = target.with_extension("old");
    if stale.exists() && std::fs::remove_file(&stale).is_err() {
        schedule_delete(&stale);
    }
    if !missed.is_empty() {
        crate::config::store::log_line(&format!("install: {}", missed.join("; ")));
    }
    Outcome::Installed(target)
}

/// Take it all back out.
///
/// The configuration is LEFT ALONE. A launcher that deletes somebody's workspaces because they
/// uninstalled a build of it is a launcher that cannot be reinstalled, and `%APPDATA%\Rovyl` is
/// shared with the Electron build besides.
pub fn uninstall() -> Vec<String> {
    let mut done = Vec::new();

    for link in [start_menu_link(), desktop_link()].into_iter().flatten() {
        if link.exists() && std::fs::remove_file(&link).is_ok() {
            done.push(format!("removed {}", link.display()));
        }
    }

    // Only OUR entry, and only if it is there. The Electron build keeps its own under a
    // different name (`com.henry.rovyl`), and an uninstaller that switched off somebody's working
    // launcher because they removed a different one would be a genuinely bad surprise.
    if crate::sys::autostart::is_set() {
        crate::sys::autostart::set(false);
        done.push("removed the startup entry".into());
    }

    unsafe {
        let key = HSTRING::from(format!(
            "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{FOLDER}"
        ));
        if RegDeleteTreeW(HKEY_CURRENT_USER, PCWSTR(key.as_ptr())).is_ok() {
            done.push("removed the uninstall entry".into());
        }
    }

    // The executable cannot delete itself while it is running, so the folder is left for the
    // operating system to clean up on the next restart. Saying so is better than pretending.
    let dir = install_dir();
    if dir.exists() {
        schedule_delete(&dir);
        done.push(format!(
            "{} will be removed when Windows next restarts",
            dir.display()
        ));
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
fn register_uninstall(exe: &Path) {
    unsafe {
        let mut key = HKEY::default();
        let path = HSTRING::from(format!(
            "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{FOLDER}"
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

        text("DisplayName", DISPLAY_NAME.into());
        text("DisplayVersion", env!("CARGO_PKG_VERSION").into());
        text("Publisher", "Rovyl".into());
        text("DisplayIcon", exe.display().to_string());
        text("InstallLocation", install_dir().display().to_string());
        text("UninstallString", format!("\"{}\" --uninstall", exe.display()));
        text("QuietUninstallString", format!("\"{}\" --uninstall", exe.display()));
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
    fn it_installs_beside_the_electron_build_and_not_over_it() {
        let ours = install_dir();
        // The Electron build owns `...\Programs\Rovyl`. Replacing a working launcher with one
        // nobody has decided to switch to yet is not an upgrade, it is a surprise.
        assert!(ours.ends_with(FOLDER));
        assert_ne!(ours.file_name().and_then(|n| n.to_str()), Some("Rovyl"));
        assert!(ours.to_string_lossy().contains("Programs"));
    }

    #[test]
    fn the_shortcuts_land_where_windows_looks_for_them() {
        let start = start_menu_link().expect("a Start menu path");
        assert!(start.to_string_lossy().contains("Start Menu"));
        assert_eq!(start.extension().and_then(|e| e.to_str()), Some("lnk"));
        let desktop = desktop_link().expect("a desktop path");
        assert!(desktop.to_string_lossy().contains("Desktop"));
    }

    #[test]
    fn running_from_somewhere_else_is_not_running_installed() {
        // The build tree is not the install folder, which is what makes `--install` meaningful.
        assert!(!running_installed());
    }
}
