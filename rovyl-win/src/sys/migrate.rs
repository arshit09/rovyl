//! Retiring the Electron build, without taking the workspaces with it.
//!
//! Every 1.x release was an Electron app installed by NSIS, and it watches the same GitHub feed
//! this one publishes to. The last update it ever performs hands it THIS executable: it downloads
//! it, spawns it with NSIS's own arguments (`--updated /S --force-run`), and quits. From that
//! moment the machine's "Rovyl" is this program, and the old one has to be taken apart.
//!
//! **Never `Uninstall Rovyl.exe`.** It is the obvious way to do this and it is the one that loses
//! everything. That uninstaller was built by electron-builder with `deleteAppDataOnUninstall:
//! true`, so it deletes `%APPDATA%\Rovyl` — which is where the workspaces, the custom icons and
//! the settings live, and which both builds share on purpose. Handing the migration to it would
//! mean every user who accepted an update came back to an empty wheel. So the old build is taken
//! apart by hand instead: its folder, its shortcuts, its Run entry and its uninstall key, one at a
//! time, and nothing under `%APPDATA%` is touched except the Electron updater's own note.
//!
//! **Nothing here is fatal.** A shortcut that will not delete, a key that was not there, a file
//! still held open by a process that has not finished exiting — none of them is a reason to leave
//! somebody without a launcher. Every step says what it did, and the install goes ahead regardless.

use std::path::{Path, PathBuf};
use windows::core::{HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, MAX_PATH};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Registry::{
    RegCloseKey, RegDeleteTreeW, RegDeleteValueW, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, HKEY,
    HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE, RRF_RT_REG_SZ,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject,
    PROCESS_ACCESS_RIGHTS, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_TERMINATE,
};

/// `SYNCHRONIZE`, which the windows crate files under `FileSystem` because that is the header it
/// is declared in. Spelled out here rather than imported from there, where it reads as a mistake.
const SYNCHRONIZE: PROCESS_ACCESS_RIGHTS = PROCESS_ACCESS_RIGHTS(0x0010_0000);

/// `HKCU\...\Uninstall`, where a per-user installer registers itself.
const UNINSTALL_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";

/// The Run value Electron writes, which is the `appId` from `package.json` verbatim.
const ELECTRON_RUN_VALUE: &str = "com.henry.rovyl";

/// The uninstaller's file name, and the one reliable fingerprint of an Electron install.
///
/// The folder name alone is not: after this migration `%LOCALAPPDATA%\Programs\Rovyl` holds the
/// NATIVE build, and a second run of the setup must not mistake it for the thing it replaces and
/// delete the install it just made.
const NSIS_UNINSTALLER: &str = "Uninstall Rovyl.exe";

/// What is left of the Electron build on this machine.
pub struct Previous {
    /// Its install folder, when the files are still there.
    pub dir: Option<PathBuf>,
    /// Its entries in Windows' "Installed apps" list, by key name.
    keys: Vec<String>,
    /// Whether it was set to start with Windows, so the replacement can keep that promise.
    ///
    /// Carried across rather than re-asked: somebody who had Rovyl at login and accepted an update
    /// did not ask to sign in tomorrow without it.
    pub starts_with_windows: bool,
    /// Whether it had a desktop shortcut, so the replacement makes the same shortcuts and not one
    /// more.
    pub desktop_shortcut: bool,
}

/// Where the Electron build installed itself: electron-builder's per-user NSIS target.
pub fn electron_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Programs").join("Rovyl")
}

/// Whether a folder holds the Electron build rather than this one.
fn is_electron_install(dir: &Path) -> bool {
    // Either half is conclusive on its own: the uninstaller is NSIS's, and `resources\app.asar` is
    // the packed JavaScript. This build produces neither, ever.
    dir.join(NSIS_UNINSTALLER).exists() || dir.join("resources").join("app.asar").exists()
}

/// What the migration has to clean up, or `None` when there is no 1.x build here.
pub fn previous() -> Option<Previous> {
    let dir = Some(electron_dir()).filter(|d| is_electron_install(d));
    let keys = uninstall_keys();
    let starts_with_windows = run_value().is_some();
    let desktop_shortcut = desktop_link().map(|l| l.exists()).unwrap_or(false);

    if dir.is_none() && keys.is_empty() && !starts_with_windows {
        return None;
    }
    Some(Previous {
        dir,
        keys,
        starts_with_windows,
        desktop_shortcut,
    })
}

/// Take the old build apart, in the order that cannot strand it half-removed.
///
/// The processes go first — a folder cannot be deleted while a file in it is open — and the files
/// go last, so a migration interrupted in the middle leaves a folder nothing points at rather than
/// a Start menu full of shortcuts to something that is gone.
///
/// `keep` is the one path inside that folder that must survive: the succession stages the new
/// executable there BEFORE it takes the old build out, so that a copy which fails for a reason
/// outside this program's control leaves the user with the launcher they already had.
pub fn retire(previous: &Previous, keep: Option<&Path>) -> Vec<String> {
    let mut done = Vec::new();

    back_up_config(&mut done);

    if let Some(dir) = previous.dir.as_deref() {
        let killed = kill_in(dir);
        if killed > 0 {
            done.push(format!("closed {killed} running process(es) of the old build"));
        }
    }

    for link in [start_menu_link(), desktop_link()].into_iter().flatten() {
        if remove_link_into(&link, &electron_dir()) {
            done.push(format!("removed {}", link.display()));
        }
    }

    if let Some(command) = run_value() {
        delete_run_value();
        done.push(format!("removed the startup entry ({})", first_word(&command)));
    }

    for key in &previous.keys {
        if delete_uninstall_key(key) {
            done.push("removed its entry from Installed apps".into());
        }
    }

    // The updater's note, and only the note. It lives in the same folder as the configuration and
    // is the one file in there that belongs to a program about to stop existing.
    let note = crate::config::store::user_data_dir().join("pending-update.json");
    if note.exists() && std::fs::remove_file(&note).is_ok() {
        done.push("removed the pending-update note".into());
    }

    if let Some(dir) = previous.dir.as_deref() {
        // "Emptied" rather than "removed" when the new build is already staged inside it: the
        // folder stays, because what is left in it is the launcher the user is about to have.
        let verb = if keep.map(|k| k.starts_with(dir)).unwrap_or(false) {
            "emptied"
        } else {
            "removed"
        };
        match remove_tree(dir, keep) {
            Ok(()) => done.push(format!("{verb} {}", dir.display())),
            Err(left) => done.push(format!(
                "{} could not be emptied ({left} file(s) still in use)",
                dir.display()
            )),
        }
    }

    clear_updater_cache(&mut done);

    done
}

/// Copy the configuration aside before anything is deleted.
///
/// Nothing in this module writes to `%APPDATA%\Rovyl`, so in principle this is unnecessary. It is
/// here because "in principle" is not what somebody whose workspaces are gone wants to hear: the
/// file is small, the copy is made once, and a later run never overwrites it — so whatever the
/// user had on the day they were migrated stays recoverable by hand.
fn back_up_config(done: &mut Vec<String>) {
    let from = crate::config::store::config_path();
    if !from.exists() {
        return;
    }
    let to = from.with_extension("json.pre-native.bak");
    if to.exists() {
        return;
    }
    if std::fs::copy(&from, &to).is_ok() {
        done.push(format!("copied the configuration to {}", to.display()));
    }
}

/// End every process running out of `dir`, and wait for the handles to drop.
///
/// By PATH and not by name. The old build ran a helper, a key listener and sometimes a second copy
/// of itself, all with different names — and its name, `Rovyl.exe`, is also this build's own. A
/// kill by name during a migration is a program killing itself halfway through replacing another.
pub(crate) fn kill_in(dir: &Path) -> usize {
    let mut killed = 0;
    let ours = std::process::id();
    let prefix = dir.to_string_lossy().to_lowercase();

    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return 0;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let pid = entry.th32ProcessID;
                if pid != ours && pid != 0 {
                    if let Some(path) = image_path(pid) {
                        if path.to_lowercase().starts_with(&prefix) && terminate(pid) {
                            killed += 1;
                        }
                    }
                }
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    killed
}

/// Where a process's executable actually lives.
fn image_path(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = [0u16; MAX_PATH as usize];
        let mut size = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_FORMAT(0),
            PWSTR(buffer.as_mut_ptr()),
            &mut size,
        );
        let _ = CloseHandle(handle);
        result.ok()?;
        Some(String::from_utf16_lossy(&buffer[..size as usize]))
    }
}

/// Stop a process and wait for it, briefly.
///
/// The wait is the point. `TerminateProcess` returns as soon as the kill is QUEUED, and deleting
/// the folder a quarter of a millisecond later fails on files the dying process still holds open —
/// which is the whole class of "the update left half of the old app behind" bug.
fn terminate(pid: u32) -> bool {
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, false, pid) else {
            return false;
        };
        let ended = TerminateProcess(handle, 0).is_ok();
        if ended {
            WaitForSingleObject(handle, 5_000);
        }
        let _ = CloseHandle(handle);
        ended
    }
}

/// Delete a folder, giving the operating system a moment to let go of it.
///
/// Retried, because the failure it retries is a handle in the process of closing rather than a
/// permission — the second pass usually clears what the first could not, and a single attempt
/// leaves a 180 MB Electron install on disk for ever. Returns how many files survived.
fn remove_tree(dir: &Path, keep: Option<&Path>) -> Result<(), usize> {
    let protected = keep.filter(|k| k.starts_with(dir));

    // The whole folder in one call, which is both faster and more thorough — but only when there
    // is nothing in it to save.
    if protected.is_none() {
        for attempt in 0..3 {
            if std::fs::remove_dir_all(dir).is_ok() || !dir.exists() {
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(300 * (attempt + 1)));
        }
    }

    // Entry by entry, so the staged executable can be stepped over. What will not come out is
    // counted rather than fought: a folder that is mostly gone is 180 MB reclaimed, and the
    // leftovers are inert.
    let mut left = 0;
    for pass in 0..3 {
        left = 0;
        let Ok(entries) = std::fs::read_dir(dir) else {
            break;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if Some(path.as_path()) == protected {
                continue;
            }
            let removed = if path.is_dir() {
                std::fs::remove_dir_all(&path).is_ok()
            } else {
                std::fs::remove_file(&path).is_ok()
            };
            if !removed {
                left += 1;
            }
        }
        if left == 0 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(300 * (pass + 1)));
    }
    if protected.is_none() {
        let _ = std::fs::remove_dir(dir);
    }

    // The leftovers are deliberately NOT queued for deletion on the next restart, the way an
    // uninstaller would queue them. This is the folder the native build installs INTO, and a
    // delete queued against it would take the new `Rovyl.exe` with it the next time the machine
    // rebooted — an app that uninstalls itself overnight.
    if left == 0 {
        Ok(())
    } else {
        Err(left)
    }
}

/// Empty `%LOCALAPPDATA%\rovyl-updater`, which is electron-updater's download cache.
///
/// It holds the 85 MB installer downloaded to perform this very migration, and this process is
/// very likely RUNNING from inside it — so its own file is skipped and left for the operating
/// system to clean up on the next restart.
fn clear_updater_cache(done: &mut Vec<String>) {
    let Some(base) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) else {
        return;
    };
    let cache = base.join("rovyl-updater");
    if !cache.exists() {
        return;
    }
    let ours = std::env::current_exe().unwrap_or_default();
    let mut freed = 0u64;
    let mut stack = vec![cache];
    let mut files = Vec::new();
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                files.push(path);
            }
        }
    }
    for file in files {
        if file == ours {
            schedule_delete(&file);
            continue;
        }
        let size = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
        if std::fs::remove_file(&file).is_ok() {
            freed += size;
        }
    }
    if freed > 1024 * 1024 {
        done.push(format!("freed {} MB of update cache", freed / (1024 * 1024)));
    }
}

/// Ask Windows to delete a path on the next boot — for the one file this process cannot delete,
/// which is the one it is running from.
fn schedule_delete(path: &Path) {
    unsafe {
        use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_DELAY_UNTIL_REBOOT};
        let _ = MoveFileExW(
            &HSTRING::from(path.as_os_str()),
            PCWSTR::null(),
            MOVEFILE_DELAY_UNTIL_REBOOT,
        );
    }
}

/// Delete a `.lnk`, but only once it is confirmed to point into the old install.
///
/// The names are generic — `Rovyl.lnk` on a desktop is exactly what somebody's own shortcut to
/// something else would also be called — so the target is read first. A migration that deletes a
/// shortcut it did not create is a migration that took something away.
fn remove_link_into(link: &Path, dir: &Path) -> bool {
    if !link.exists() {
        return false;
    }
    let Some(target) = crate::sys::dropped::resolve_shortcut(link) else {
        return false;
    };
    if !target
        .to_lowercase()
        .starts_with(&dir.to_string_lossy().to_lowercase())
    {
        return false;
    }
    std::fs::remove_file(link).is_ok()
}

fn start_menu_link() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA").map(PathBuf::from)?;
    Some(
        base.join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs")
            .join("Rovyl.lnk"),
    )
}

fn desktop_link() -> Option<PathBuf> {
    let base = std::env::var_os("USERPROFILE").map(PathBuf::from)?;
    Some(base.join("Desktop").join("Rovyl.lnk"))
}

/// The Electron build's login entry, if it is set.
fn run_value() -> Option<String> {
    read_string(RUN_KEY, ELECTRON_RUN_VALUE)
}

fn delete_run_value() {
    unsafe {
        let mut key = HKEY::default();
        let path = HSTRING::from(RUN_KEY);
        if RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(path.as_ptr()),
            0,
            KEY_SET_VALUE,
            &mut key,
        )
        .is_err()
        {
            return;
        }
        let value = HSTRING::from(ELECTRON_RUN_VALUE);
        let _ = RegDeleteValueW(key, PCWSTR(value.as_ptr()));
        let _ = RegCloseKey(key);
    }
}

/// Every "Installed apps" entry that belongs to the Electron build.
///
/// Found by what the entry DOES rather than by what it is called: the key name is a GUID out of
/// `package.json`, and a release that had changed it would leave an orphan nothing could ever
/// clean up. An `UninstallString` naming `Uninstall Rovyl.exe` is NSIS's, and cannot be this
/// build's — whose own entry runs `Rovyl.exe --uninstall`.
fn uninstall_keys() -> Vec<String> {
    let mut found = Vec::new();
    unsafe {
        let mut key = HKEY::default();
        let path = HSTRING::from(UNINSTALL_KEY);
        if RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(path.as_ptr()),
            0,
            KEY_READ,
            &mut key,
        )
        .is_err()
        {
            return found;
        }
        let mut index = 0u32;
        loop {
            let mut name = [0u16; 256];
            let mut length = name.len() as u32;
            if RegEnumKeyExW(
                key,
                index,
                PWSTR(name.as_mut_ptr()),
                &mut length,
                None,
                PWSTR::null(),
                None,
                None,
            )
            .is_err()
            {
                break;
            }
            index += 1;
            let name = String::from_utf16_lossy(&name[..length as usize]);
            let sub = format!("{UNINSTALL_KEY}\\{name}");
            let command = read_string(&sub, "UninstallString").unwrap_or_default();
            if command
                .to_lowercase()
                .contains(&NSIS_UNINSTALLER.to_lowercase())
            {
                found.push(name);
            }
        }
        let _ = RegCloseKey(key);
    }
    found
}

fn delete_uninstall_key(name: &str) -> bool {
    unsafe {
        let path = HSTRING::from(format!("{UNINSTALL_KEY}\\{name}"));
        RegDeleteTreeW(HKEY_CURRENT_USER, PCWSTR(path.as_ptr())).is_ok()
    }
}

/// Read one `REG_SZ` out of `HKEY_CURRENT_USER`.
fn read_string(subkey: &str, value: &str) -> Option<String> {
    unsafe {
        let mut buffer = [0u16; 1024];
        let mut size = (buffer.len() * 2) as u32;
        let subkey = HSTRING::from(subkey);
        let value = HSTRING::from(value);
        if RegGetValueW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            PCWSTR(value.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            Some(buffer.as_mut_ptr() as *mut _),
            Some(&mut size),
        )
        .is_err()
        {
            return None;
        }
        let chars = (size as usize / 2).saturating_sub(1);
        let text = String::from_utf16_lossy(&buffer[..chars]);
        (!text.trim().is_empty()).then_some(text)
    }
}

fn first_word(command: &str) -> String {
    command
        .split_whitespace()
        .next()
        .unwrap_or(command)
        .trim_matches('"')
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn our_own_install_is_never_mistaken_for_the_one_it_replaces() {
        // Both builds live at `%LOCALAPPDATA%\Programs\Rovyl` once the migration is done, so the
        // fingerprint has to be something only Electron leaves behind. If this ever matched on the
        // folder name, a second run of the setup would delete the install it had just made.
        let scratch = std::env::temp_dir().join("rovyl-migrate-test-native");
        let _ = std::fs::create_dir_all(&scratch);
        let _ = std::fs::write(scratch.join("Rovyl.exe"), b"native");
        assert!(!is_electron_install(&scratch));

        let _ = std::fs::write(scratch.join(NSIS_UNINSTALLER), b"nsis");
        assert!(is_electron_install(&scratch));
        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[test]
    fn the_electron_build_is_looked_for_where_electron_builder_puts_it() {
        let dir = electron_dir();
        assert!(dir.ends_with("Rovyl"));
        assert!(dir.to_string_lossy().contains("Programs"));
    }

    #[test]
    fn the_staged_executable_survives_the_folder_it_is_staged_in() {
        let dir = std::env::temp_dir().join("rovyl-migrate-test-keep");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("resources")).expect("a scratch folder");
        std::fs::write(dir.join("Rovyl.exe"), b"electron").expect("the old build");
        std::fs::write(dir.join("resources").join("app.asar"), b"js").expect("its javascript");
        let staged = dir.join("Rovyl.new.exe");
        std::fs::write(&staged, b"native").expect("the new build");

        assert!(remove_tree(&dir, Some(&staged)).is_ok());

        // Everything the old build left is gone...
        assert!(!dir.join("Rovyl.exe").exists());
        assert!(!dir.join("resources").exists());
        // ...and the new one is still standing in the folder it was staged in. Taking the folder
        // itself is the bug that would leave somebody with no launcher at all.
        assert!(staged.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn with_nothing_to_keep_the_folder_goes_too() {
        let dir = std::env::temp_dir().join("rovyl-migrate-test-sweep");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("locales")).expect("a scratch folder");
        std::fs::write(dir.join("locales").join("en-GB.pak"), b"x").expect("a file in it");

        assert!(remove_tree(&dir, None).is_ok());
        assert!(!dir.exists());
    }

    #[test]
    fn a_shortcut_that_cannot_be_read_is_left_alone() {
        // `Rovyl.lnk` on a desktop is exactly what somebody's own shortcut would be called too, so
        // an unverifiable one is never deleted.
        let link = std::env::temp_dir().join("rovyl-migrate-test.lnk");
        let _ = std::fs::write(&link, b"not really a shortcut");
        assert!(!remove_link_into(&link, &electron_dir()));
        assert!(link.exists());
        let _ = std::fs::remove_file(&link);
    }
}
