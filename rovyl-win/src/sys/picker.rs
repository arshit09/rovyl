//! The system's own "choose a file" dialog.
//!
//! `IFileOpenDialog` rather than the ancient `GetOpenFileName`: it is the one Windows has shipped
//! since Vista, it remembers where the user was last, and it is the dialog every other program on
//! the machine shows. A hand-rolled file browser inside a settings panel is a second file browser
//! that is worse than the one already installed.
//!
//! **It is modal and it blocks.** That is correct and it is why this is never called from inside a
//! frame: the caller runs it between frames, and the message loop is held by the dialog's own
//! until the user is done.

use windows::core::{HSTRING, PCWSTR};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
use windows::Win32::UI::Shell::{FileOpenDialog, IFileOpenDialog, FOS_PICKFOLDERS, SIGDN_FILESYSPATH};

/// One line of the dialog's type dropdown.
pub struct Filter {
    pub label: &'static str,
    /// Semicolon-separated, as the dialog wants it: `*.png;*.jpg`.
    pub pattern: &'static str,
}

/// Everything an icon can be taken from.
///
/// Programs and libraries are in the list because that is where most of the icons on a Windows
/// machine actually live: `shell32.dll` alone has over three hundred.
pub const ICON_FILTERS: &[Filter] = &[
    Filter {
        label: "Pictures and programs",
        pattern: "*.png;*.jpg;*.jpeg;*.bmp;*.gif;*.webp;*.ico;*.exe;*.dll",
    },
    Filter {
        label: "Pictures",
        pattern: "*.png;*.jpg;*.jpeg;*.bmp;*.gif;*.webp;*.ico",
    },
    Filter {
        label: "Programs and icon libraries",
        pattern: "*.exe;*.dll;*.ico",
    },
    Filter {
        label: "All files",
        pattern: "*.*",
    },
];

/// Ask the user for a file. `None` when they cancelled, which is not a failure.
///
/// `owner` keeps the dialog in front of the window that asked for it; without it the dialog can
/// open behind the settings panel and look like nothing happened.
pub fn open_file(
    owner: windows::Win32::Foundation::HWND,
    title: &str,
    filters: &[Filter],
) -> Option<std::path::PathBuf> {
    unsafe {
        let dialog: IFileOpenDialog =
            CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).ok()?;
        dialog.SetTitle(&HSTRING::from(title)).ok()?;

        // The strings have to outlive the call, so they are kept alive here rather than built
        // inside the `map` -- a `PCWSTR` into a temporary is a pointer into freed memory.
        let wide: Vec<(Vec<u16>, Vec<u16>)> = filters
            .iter()
            .map(|filter| {
                (
                    filter.label.encode_utf16().chain(Some(0)).collect(),
                    filter.pattern.encode_utf16().chain(Some(0)).collect(),
                )
            })
            .collect();
        let specs: Vec<COMDLG_FILTERSPEC> = wide
            .iter()
            .map(|(label, pattern)| COMDLG_FILTERSPEC {
                pszName: PCWSTR(label.as_ptr()),
                pszSpec: PCWSTR(pattern.as_ptr()),
            })
            .collect();
        let _ = dialog.SetFileTypes(&specs);

        // A cancel comes back as an error, and it is the expected outcome rather than a fault.
        if dialog.Show(owner).is_err() {
            return None;
        }
        let item = dialog.GetResult().ok()?;
        let path = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
        let text = path.to_string().ok()?;
        windows::Win32::System::Com::CoTaskMemFree(Some(path.0 as *const _));
        Some(std::path::PathBuf::from(text))
    }
}

/// Ask the user for a folder. `None` when they cancelled.
///
/// The same dialog with one flag flipped, rather than the old `SHBrowseForFolder` tree: that one
/// has no address bar, no search and no recent places, and it is the thing people mean when they
/// say a folder picker feels like 1998.
pub fn open_folder(
    owner: windows::Win32::Foundation::HWND,
    title: &str,
) -> Option<std::path::PathBuf> {
    unsafe {
        let dialog: IFileOpenDialog =
            CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).ok()?;
        dialog.SetTitle(&HSTRING::from(title)).ok()?;
        let options = dialog.GetOptions().ok()?;
        dialog.SetOptions(options | FOS_PICKFOLDERS).ok()?;
        if dialog.Show(owner).is_err() {
            return None;
        }
        let item = dialog.GetResult().ok()?;
        let path = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
        let text = path.to_string().ok()?;
        windows::Win32::System::Com::CoTaskMemFree(Some(path.0 as *const _));
        Some(std::path::PathBuf::from(text))
    }
}

/// Everything, for the shortcut that opens one particular file.
pub const ANY_FILE: &[Filter] = &[Filter {
    label: "All files",
    pattern: "*.*",
}];

/// Whether a path is the kind of file that holds SEVERAL icons.
pub fn is_icon_library(path: &std::path::Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("exe") | Some("dll") | Some("ocx") | Some("cpl") | Some("icl")
    )
}

/// The libraries Windows keeps its own icons in.
///
/// Offered by name because nobody browses to `C:\Windows\System32\imageres.dll` on purpose, and
/// because these four are where almost every familiar Windows icon lives.
pub const WINDOWS_LIBRARIES: &[(&str, &str)] = &[
    ("shell32.dll", "Shell"),
    ("imageres.dll", "Images"),
    ("ddores.dll", "Devices"),
    ("wmploc.dll", "Media"),
];

/// A full path to one of them, if this machine has it.
pub fn windows_library(file: &str) -> Option<std::path::PathBuf> {
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let path = std::path::PathBuf::from(root).join("System32").join(file);
    path.exists().then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn a_library_is_told_from_a_picture_by_its_extension() {
        assert!(is_icon_library(Path::new(r"C:\Windows\System32\shell32.dll")));
        assert!(is_icon_library(Path::new(r"C:\Program Files\App\app.EXE")));
        assert!(!is_icon_library(Path::new(r"C:\pics\logo.png")));
        // `.ico` holds several sizes of ONE icon, not several icons; it decodes as a picture.
        assert!(!is_icon_library(Path::new(r"C:\pics\app.ico")));
        assert!(!is_icon_library(Path::new("no-extension")));
    }

    #[test]
    fn the_windows_libraries_are_where_this_machine_keeps_them() {
        // shell32 is on every Windows there has ever been; the others are not guaranteed, and the
        // point of the check is that a missing one yields `None` rather than a broken path.
        assert!(windows_library("shell32.dll").is_some());
        assert!(windows_library("definitely-not-a-library.dll").is_none());
        for (file, label) in WINDOWS_LIBRARIES {
            assert!(!label.is_empty(), "{file} has no label");
        }
    }
}
