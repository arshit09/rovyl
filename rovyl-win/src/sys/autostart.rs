//! "Start with Windows".
//!
//! A value under `HKCU\...\Run`, which is the one mechanism that works for an unelevated, per-user
//! application and needs no installer privileges, no scheduled task and no service.
//!
//! The `--tray` argument is the whole reason this is not a bare path: a start the user did not ask
//! to SEE must not put a window in front of whatever they were doing when they signed in. The
//! Electron build passes the same flag for the same reason.

use windows::core::{w, HSTRING, PCWSTR};
use windows::Win32::System::Registry::{
    RegCloseKey, RegDeleteValueW, RegGetValueW, RegOpenKeyExW, RegSetValueExW, HKEY,
    HKEY_CURRENT_USER, KEY_SET_VALUE, REG_SZ, RRF_RT_REG_SZ,
};

const RUN_KEY: PCWSTR = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
const VALUE: PCWSTR = w!("Rovyl");

/// The command line the login entry holds.
fn command() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    // Quoted, because `C:\Program Files\...` is where this installs and the Run key is parsed as a
    // command line — unquoted, Windows would try to run `C:\Program`.
    Some(format!("\"{}\" --tray", exe.display()))
}

pub fn set(on: bool) {
    unsafe {
        let mut key = HKEY::default();
        if RegOpenKeyExW(HKEY_CURRENT_USER, RUN_KEY, 0, KEY_SET_VALUE, &mut key).is_err() {
            return;
        }
        if on {
            if let Some(command) = command() {
                let text = HSTRING::from(command);
                let wide = text.as_wide();
                let bytes = std::slice::from_raw_parts(
                    wide.as_ptr() as *const u8,
                    // The terminator is part of the value: a `REG_SZ` written without it is read
                    // back with whatever happens to follow it in the hive.
                    (wide.len() + 1) * 2,
                );
                let _ = RegSetValueExW(key, VALUE, 0, REG_SZ, Some(bytes));
            }
        } else {
            // A value that is not there is not an error — this is called on every toggle, and the
            // first "off" on a fresh profile has nothing to delete.
            let _ = RegDeleteValueW(key, VALUE);
        }
        let _ = RegCloseKey(key);
    }
}

/// Whether the login entry is present AND points at this executable.
///
/// The second half matters: an entry left behind by an installation at another path would read as
/// "on" while launching something else, and the switch would be lying about what it controls.
pub fn is_set() -> bool {
    unsafe {
        let mut buffer = [0u16; 1024];
        let mut size = (buffer.len() * 2) as u32;
        let ok = RegGetValueW(
            HKEY_CURRENT_USER,
            RUN_KEY,
            VALUE,
            RRF_RT_REG_SZ,
            None,
            Some(buffer.as_mut_ptr() as *mut _),
            Some(&mut size),
        )
        .is_ok();
        if !ok {
            return false;
        }
        let chars = (size as usize / 2).saturating_sub(1);
        let stored = String::from_utf16_lossy(&buffer[..chars]).to_lowercase();
        match std::env::current_exe() {
            Ok(exe) => stored.contains(&exe.display().to_string().to_lowercase()),
            Err(_) => !stored.is_empty(),
        }
    }
}

/// Bring the stored switch and the registry into agreement, at startup.
///
/// They can disagree for a reason that is nobody's fault: the app was moved or reinstalled to a
/// different path, so the entry still exists but names an executable that is gone. Reconciling on
/// the config's value — which is what the user actually chose — repairs that silently.
pub fn reconcile(wanted: bool) {
    if wanted != is_set() {
        set(wanted);
    }
}
