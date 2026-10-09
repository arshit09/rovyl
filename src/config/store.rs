//! Reading and writing `config-v2.json`, atomically, with a backup and a quarantine path.
//!
//! The Electron build's rules, kept because each one is a fault that happened:
//!
//! - **Atomic writes only.** The file is written to a sibling temp name and then renamed over the
//!   target, so a crash mid-write leaves the previous file intact rather than a truncated one. A
//!   launcher whose configuration can be half-written is a launcher that loses a workspace to a
//!   power cut.
//! - **A `.bak` kept one generation behind.** The previous good file is copied aside before the
//!   rename, so there is something to fall back to when the primary turns out to be unreadable.
//! - **Corrupt blobs are quarantined, never deleted.** A file that fails to parse is moved to
//!   `config-v2.json.broken-<millis>`, so the user (or a bug report) still has it. Overwriting it
//!   with defaults is the one thing that turns a bad read into actual data loss.
//! - **A failed read must not become a successful write.** `Loaded::source` says where the config
//!   came from, and a caller that got `Defaults` after a file existed is expected to hold saves
//!   until the user has decided — which is what `persistence_meta` is for.

use super::model::{Persisted, UiConfig, UserProfile};
use super::{defaults, normalize};
use serde_json::Value;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const CONFIG_FILE: &str = "config-v2.json";
pub const BACKUP_FILE: &str = "config-v2.json.bak";
pub const LOG_FILE: &str = "rovyl-persistence.log";

/// `%APPDATA%\Rovyl` — the same folder the Electron build uses, because Electron derives it from
/// `productName` and the two builds are meant to share one profile. A port with its own directory
/// would look, to the user, exactly like an update that lost everything.
pub fn user_data_dir() -> PathBuf {
    // An escape hatch for working against a clean profile.
    //
    // The Electron build's note applies here too and is worth repeating: the dev app and the
    // packaged app share `%APPDATA%\Rovyl`, so a development session reads and writes the user's
    // real configuration. This is how to not do that — and how a test can exercise a first run
    // without destroying somebody's workspaces.
    if let Some(override_dir) = std::env::var_os("ROVYL_USER_DATA") {
        return PathBuf::from(override_dir);
    }
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            // No APPDATA is not a configuration this ships into, but falling back beside the
            // executable keeps the app usable rather than panicking at startup.
            std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(Path::to_path_buf))
                .unwrap_or_else(|| PathBuf::from("."))
        });
    base.join("Rovyl")
}

pub fn config_path() -> PathBuf {
    user_data_dir().join(CONFIG_FILE)
}

pub fn backup_path() -> PathBuf {
    user_data_dir().join(BACKUP_FILE)
}

/// The icon store: normalised PNGs keyed by hash, which `rovyl-icon://` references resolve into.
pub fn icon_store_dir() -> PathBuf {
    user_data_dir().join("icons")
}

/// Where a config came from, so a caller knows whether saving is safe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// The primary file parsed and had workspaces.
    Primary,
    /// The primary was unreadable and the backup answered. The primary has been quarantined.
    Backup,
    /// Neither file had anything usable. This is a first run — or a fault, and the two are told
    /// apart by `PersistenceMeta::bytes_on_disk`.
    Defaults,
}

pub struct Loaded {
    pub config: UiConfig,
    pub user: Option<UserProfile>,
    /// A legacy flat `apps` array, if the file still carries one. Kept so a save round-trips it.
    pub legacy_apps: Option<Vec<super::model::AppItem>>,
    pub source: Source,
}

/// Sizes of the files on disk — used to tell a first run from a failed read.
///
/// A load that falls back to defaults is ambiguous on its own: it is the correct outcome on a new
/// machine and a data-loss event on an old one. The byte counts are what separate them, and a
/// caller that sees a non-zero size with `Source::Defaults` is expected to refuse to save over it.
#[derive(Debug, Clone, Copy, Default)]
pub struct PersistenceMetaBytes {
    pub primary_bytes: u64,
    pub backup_bytes: u64,
    pub quarantine_bytes: u64,
}

pub fn persistence_meta() -> PersistenceMetaBytes {
    let dir = user_data_dir();
    let size_of = |p: PathBuf| fs::metadata(p).map(|m| m.len()).unwrap_or(0);
    let quarantine_bytes = fs::read_dir(&dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| {
                    e.file_name()
                        .to_string_lossy()
                        .starts_with("config-v2.json.broken-")
                })
                .filter_map(|e| e.metadata().ok())
                .map(|m| m.len())
                .sum()
        })
        .unwrap_or(0);
    PersistenceMetaBytes {
        primary_bytes: size_of(dir.join(CONFIG_FILE)),
        backup_bytes: size_of(dir.join(BACKUP_FILE)),
        quarantine_bytes,
    }
}

fn millis_now() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Parse one file into the v2 shape. `None` covers both "not there" and "there but unusable",
/// because the caller's next move is the same either way: try the other file.
fn read_blob(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    let raw: Value = serde_json::from_str(&text).ok()?;
    normalize::normalize_full_blob(&raw)
}

/// Move an unusable file aside. Never deletes: the blob is the only copy of whatever the user had.
fn quarantine(path: &Path) {
    if !path.exists() {
        return;
    }
    let target = path.with_file_name(format!("{CONFIG_FILE}.broken-{}", millis_now()));
    let _ = fs::rename(path, &target);
}

/// Load the configuration, falling back through `.bak` to the defaults.
pub fn load() -> Loaded {
    let primary = config_path();
    let backup = backup_path();

    let from_primary = read_blob(&primary);
    let (blob, source) = match from_primary {
        Some(blob) => (Some(blob), Source::Primary),
        None => {
            // The primary exists but is not usable. Move it aside BEFORE reading the backup, so a
            // later save does not land on top of a file somebody may want to inspect.
            if primary.exists() {
                quarantine(&primary);
            }
            match read_blob(&backup) {
                Some(blob) => (Some(blob), Source::Backup),
                None => (None, Source::Defaults),
            }
        }
    };

    match blob {
        Some(blob) => {
            let user = blob
                .get("user")
                .filter(|v| v.is_object())
                .and_then(|v| serde_json::from_value::<UserProfile>(v.clone()).ok());
            let legacy_apps = blob
                .get("apps")
                .and_then(|v| serde_json::from_value::<Vec<super::model::AppItem>>(v.clone()).ok());
            let config = normalize::hydrate(blob.get("config").unwrap_or(&Value::Null));
            Loaded {
                config,
                user,
                legacy_apps,
                source,
            }
        }
        None => Loaded {
            config: defaults::ui_config(),
            user: None,
            legacy_apps: None,
            source: Source::Defaults,
        },
    }
}

/// Write the configuration, atomically, keeping the previous file as `.bak`.
pub fn save(config: &UiConfig, user: Option<&UserProfile>, legacy_apps: Option<&[super::model::AppItem]>) -> io::Result<()> {
    let dir = user_data_dir();
    fs::create_dir_all(&dir)?;

    let blob = Persisted {
        user: user.cloned(),
        apps: legacy_apps.map(|a| a.to_vec()),
        config: config.clone(),
    };
    // Pretty, two spaces: the app points the user at this file in its own error messages, and a
    // single-line blob is not something a person can repair by hand.
    let text = serde_json::to_string_pretty(&blob)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

    let target = dir.join(CONFIG_FILE);
    // The temp name carries the pid, so two instances racing (which the single-instance lock makes
    // unlikely but a debugger makes easy) cannot truncate each other's staging file.
    let staging = dir.join(format!("{CONFIG_FILE}.tmp-{}", std::process::id()));
    fs::write(&staging, text.as_bytes())?;

    // One generation back, taken from the file that is about to be replaced rather than from the
    // new text: a backup of what is being written is not a backup.
    if target.exists() {
        let _ = fs::copy(&target, dir.join(BACKUP_FILE));
    }

    // `fs::rename` on Windows replaces an existing file, which is what makes this atomic. If it
    // fails — most often security software holding the target open — the staging file is cleaned
    // up so the directory does not fill with them.
    match fs::rename(&staging, &target) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&staging);
            Err(e)
        }
    }
}

/// Append one line to `rovyl-persistence.log`.
///
/// Best-effort by design, and the return type says so: a launcher must not fail to open a wheel
/// because it could not write a log line. The log is what makes "it opened something I did not
/// click" diagnosable after the fact, so it records confirmations as well as faults.
pub fn log_line(message: &str) {
    let dir = user_data_dir();
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    use std::io::Write;
    if let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(LOG_FILE))
    {
        let _ = writeln!(file, "[{}] {}", millis_now(), message);
    }
}
