//! Export and import: a portable copy of the configuration.
//!
//! The file is the SAME shape the app stores — `{ user, apps?, config }` — not a bespoke export
//! format. That matters for the one thing people actually do with it: a config exported from one
//! machine is dropped into `%APPDATA%\Rovyl` on another and works, with or without going through
//! the import dialog.
//!
//! What it deliberately does NOT carry is the icon store. A profile with a hundred extracted icons
//! would be megabytes, and every one of them is RE-DERIVABLE from the shortcut it belongs to — the
//! destination machine extracts them from its own installed applications, which is also the only
//! way they end up correct when the two machines have different versions installed.

use crate::config::{store, UiConfig, UserProfile};
use windows::core::{w, HSTRING, PCWSTR};
use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
use windows::Win32::UI::Shell::{
    FileOpenDialog, FileSaveDialog, IFileOpenDialog, IFileSaveDialog, SIGDN_FILESYSPATH,
    FOS_FILEMUSTEXIST, FOS_OVERWRITEPROMPT, FOS_PATHMUSTEXIST,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};

const FILTER_NAME: PCWSTR = w!("Rovyl settings");
const FILTER_SPEC: PCWSTR = w!("*.json");

/// Ask for a destination and write the configuration there.
pub fn export(config: &UiConfig, user: Option<&UserProfile>) {
    let Some(path) = save_dialog() else { return };
    let blob = crate::config::model::Persisted {
        user: user.cloned(),
        apps: None,
        config: config.clone(),
    };
    match serde_json::to_string_pretty(&blob) {
        Ok(text) => {
            if let Err(error) = std::fs::write(&path, text) {
                store::log_line(&format!("export failed: {error}"));
            } else {
                store::log_line(&format!("exported to {}", path.display()));
            }
        }
        Err(error) => store::log_line(&format!("export failed: {error}")),
    }
}

/// Ask for a file and read a configuration out of it.
///
/// It goes through exactly the same normalisation a file on disk does, so an export from an older
/// build — or a hand-edited one — lands with the same defaults, the same clamps and the same
/// migrations as the real thing. An import path that trusted its input would be a second, laxer
/// way into the configuration.
pub fn import() -> Option<UiConfig> {
    let path = open_dialog()?;
    let text = std::fs::read_to_string(&path).ok()?;
    let raw: serde_json::Value = serde_json::from_str(&text).ok()?;
    let blob = crate::config::normalize::normalize_full_blob(&raw)?;
    let config = crate::config::normalize::hydrate(blob.get("config")?);
    store::log_line(&format!("imported from {}", path.display()));
    Some(config)
}

fn save_dialog() -> Option<std::path::PathBuf> {
    unsafe {
        let dialog: IFileSaveDialog =
            CoCreateInstance(&FileSaveDialog, None, CLSCTX_INPROC_SERVER).ok()?;
        let filters = [COMDLG_FILTERSPEC {
            pszName: FILTER_NAME,
            pszSpec: FILTER_SPEC,
        }];
        dialog.SetFileTypes(&filters).ok()?;
        dialog.SetDefaultExtension(w!("json")).ok()?;
        dialog.SetFileName(w!("rovyl-settings.json")).ok()?;
        dialog.SetOptions(FOS_OVERWRITEPROMPT | FOS_PATHMUSTEXIST).ok()?;
        // A cancelled dialog returns an error, which is not a failure worth logging.
        dialog.Show(None).ok()?;
        let item = dialog.GetResult().ok()?;
        let path = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
        let text = path.to_string().ok()?;
        windows::Win32::System::Com::CoTaskMemFree(Some(path.0 as *const _));
        Some(std::path::PathBuf::from(text))
    }
}

fn open_dialog() -> Option<std::path::PathBuf> {
    unsafe {
        let dialog: IFileOpenDialog =
            CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).ok()?;
        let filters = [COMDLG_FILTERSPEC {
            pszName: FILTER_NAME,
            pszSpec: FILTER_SPEC,
        }];
        dialog.SetFileTypes(&filters).ok()?;
        dialog.SetOptions(FOS_FILEMUSTEXIST | FOS_PATHMUSTEXIST).ok()?;
        dialog.Show(None).ok()?;
        let item = dialog.GetResult().ok()?;
        let path = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
        let text = path.to_string().ok()?;
        windows::Win32::System::Com::CoTaskMemFree(Some(path.0 as *const _));
        Some(std::path::PathBuf::from(text))
    }
}

/// Pick one file, for the shortcut editor. `executables_only` narrows the filter to the things a
/// shortcut can point a program at.
pub fn pick_file(executables_only: bool) -> Option<std::path::PathBuf> {
    unsafe {
        let dialog: IFileOpenDialog =
            CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).ok()?;
        if executables_only {
            let filters = [COMDLG_FILTERSPEC {
                pszName: w!("Programs"),
                pszSpec: w!("*.exe;*.lnk;*.bat;*.cmd"),
            }];
            dialog.SetFileTypes(&filters).ok()?;
        }
        dialog.SetOptions(FOS_FILEMUSTEXIST | FOS_PATHMUSTEXIST).ok()?;
        dialog.Show(None).ok()?;
        let item = dialog.GetResult().ok()?;
        let path = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
        let text = path.to_string().ok()?;
        windows::Win32::System::Com::CoTaskMemFree(Some(path.0 as *const _));
        Some(std::path::PathBuf::from(text))
    }
}

/// Pick a folder.
pub fn pick_folder() -> Option<std::path::PathBuf> {
    use windows::Win32::UI::Shell::FOS_PICKFOLDERS;
    unsafe {
        let dialog: IFileOpenDialog =
            CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).ok()?;
        dialog.SetOptions(FOS_PICKFOLDERS | FOS_PATHMUSTEXIST).ok()?;
        dialog.Show(None).ok()?;
        let item = dialog.GetResult().ok()?;
        let path = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
        let text = path.to_string().ok()?;
        windows::Win32::System::Com::CoTaskMemFree(Some(path.0 as *const _));
        Some(std::path::PathBuf::from(text))
    }
}

#[allow(unused)]
fn unused(_: HSTRING) {}
