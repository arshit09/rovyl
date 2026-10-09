//! The single-instance lock, and how a second launch reaches the first.
//!
//! A launcher that can run twice is a launcher with two mouse hooks fighting over one button and
//! two processes writing one configuration file. The second instance has to lose — but it must not
//! just exit silently, because the user who double-clicked the shortcut did so for a reason. It
//! tells the first instance what it wanted and then leaves.
//!
//! **Why a named mutex and not a window search.** The window may not exist yet: a second launch
//! during the first's startup would find nothing and both would carry on. A mutex is held from
//! before anything else is created, so the race has no window to slip through.
//!
//! **Why `Local\` and not `Global\`.** Two users signed in at once each get their own launcher,
//! with their own configuration and their own tray icon. A global name would let one user's
//! instance suppress the other's.

use windows::core::w;
use windows::Win32::Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, HANDLE, LPARAM, WPARAM};
use windows::Win32::System::Threading::CreateMutexW;
use windows::Win32::UI::WindowsAndMessaging::{
    FindWindowW, PostMessageW, RegisterWindowMessageW,
};

/// The message a second instance sends to the first.
///
/// Registered rather than a fixed `WM_APP + n`, so it cannot collide with anything else this
/// window receives — and so that only a process that registers the same string can send it.
pub fn wake_message() -> u32 {
    unsafe { RegisterWindowMessageW(w!("RovylWakeExistingInstance")) }
}

/// What the second instance asks the first to do.
pub const WAKE_SHOW_SETTINGS: usize = 1;
pub const WAKE_OPEN_WHEEL: usize = 2;

pub struct Lock {
    handle: HANDLE,
}

pub enum Outcome {
    /// This process is the only one. Carry on.
    First(Lock),
    /// Another instance already holds the lock and has been told what this launch wanted.
    Already,
}

/// Take the lock, or hand off to whoever has it.
pub fn acquire(what_this_launch_wanted: usize) -> Outcome {
    unsafe {
        let handle = CreateMutexW(None, true, w!("Local\\RovylSingleInstance"));
        let already = windows::Win32::Foundation::GetLastError() == ERROR_ALREADY_EXISTS;
        match handle {
            Ok(handle) if !already => Outcome::First(Lock { handle }),
            Ok(handle) => {
                // The mutex is closed before the hand-off, not after: if the first instance is in
                // the middle of exiting, holding a second handle would keep the name alive and the
                // next launch would also think it had lost.
                let _ = CloseHandle(handle);
                hand_off(what_this_launch_wanted);
                Outcome::Already
            }
            // The mutex could not be created at all — a sandbox with no kernel-object access. The
            // right answer is to run: a launcher that refuses to start because it cannot take a
            // lock is worse than one that might, rarely, run twice.
            Err(_) => Outcome::First(Lock {
                handle: HANDLE::default(),
            }),
        }
    }
}

/// Tell the running instance what this launch was for.
///
/// Best effort. The window may be mid-teardown, in which case the mutex this process just failed to
/// take is about to be released and nothing is listening — and a user who launched Rovyl while it
/// was quitting will simply launch it again.
fn hand_off(request: usize) {
    unsafe {
        let hwnd = FindWindowW(w!("RovylApp"), None);
        if let Ok(hwnd) = hwnd {
            if !hwnd.is_invalid() {
                let _ = PostMessageW(hwnd, wake_message(), WPARAM(request), LPARAM(0));
            }
        }
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        if !self.handle.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.handle);
            }
        }
    }
}

/// What a launch was for, read from its arguments.
///
/// `--tray` is what the installer and the login entry pass: a start the user did not ask to SEE
/// should not put a window up. Everything else is somebody running the program on purpose, and
/// that means they want the settings window — there is nothing else to show them.
pub fn request_from_args(args: &[String]) -> usize {
    let into_tray = args.iter().any(|a| {
        let a = a.as_str();
        a == "--tray" || a == "--hidden" || a == "--updated" || a == "--autostart"
    });
    if into_tray {
        WAKE_OPEN_WHEEL
    } else {
        WAKE_SHOW_SETTINGS
    }
}

/// Whether this launch should stay in the tray rather than opening a window.
pub fn starts_in_tray(args: &[String]) -> bool {
    request_from_args(args) == WAKE_OPEN_WHEEL
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_login_start_stays_in_the_tray() {
        // A start the user did not ask to see must not put a window up in front of whatever they
        // were doing when they signed in.
        for flag in ["--tray", "--hidden", "--updated", "--autostart"] {
            let args = vec!["rovyl.exe".to_string(), flag.to_string()];
            assert!(starts_in_tray(&args), "{flag}");
            assert_eq!(request_from_args(&args), WAKE_OPEN_WHEEL);
        }
    }

    #[test]
    fn a_deliberate_launch_opens_settings() {
        // There is nothing else to show somebody who ran the program on purpose.
        let args = vec!["rovyl.exe".to_string()];
        assert!(!starts_in_tray(&args));
        assert_eq!(request_from_args(&args), WAKE_SHOW_SETTINGS);
    }

    #[test]
    fn the_wake_message_is_stable_within_a_session() {
        // Registered message ids are allocated per session; both halves of the hand-off have to
        // resolve the same one.
        assert_ne!(wake_message(), 0);
        assert_eq!(wake_message(), wake_message());
    }
}
