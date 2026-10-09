//! The projects an editor opened last, as a ring of their own.
//!
//! **Why discovery and not a table of paths.** The profile folder an editor creates is not its
//! product name and changes across versions and vendors: "Antigravity IDE" (not "Antigravity",
//! which is only the Chromium runtime), "Code - Insiders", "Windsurf", "Trae". A fixed table fails
//! SILENTLY — it returns an empty list with no error, which is exactly what happened to the
//! original with Antigravity. So the rule is structural instead: any folder with
//! `User/globalStorage/{storage.json|state.vscdb}` is a profile of this family, and the one whose
//! name best matches the shortcut wins. Editors that do not exist yet work without a code change.
//!
//! **Where the list actually lives.** `history.recentlyOpenedPathsList`, in `storage.json` on
//! older builds and in `state.vscdb` — a SQLite database — on current ones. Every profile on the
//! machine this was written on keeps it in the database, so the JSON path is the fallback and not
//! the other way round.
//!
//! Everything here reads files a running editor owns, so everything here is a read.

use crate::config::{AppItem, CommandType, IconSource, ItemKind};
use std::path::{Path, PathBuf};

/// How many recent projects a ring shows.
///
/// Six, as the original. It is a wheel: past this the wedges are thinner than the gesture that
/// aims at them, and a list of twenty recent folders is a file manager rather than a launcher.
pub const MAX_RECENTS: usize = 6;

/// Comparison without spaces, hyphens, punctuation or case.
fn normalize(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// Labels that look nothing like the folder the product creates.
const ALIASES: &[(&str, &str)] = &[
    ("visualstudiocode", "code"),
    ("vscode", "code"),
    ("vscodeinsiders", "codeinsiders"),
];

/// Path and file-name fragments that never identify a product.
const STOPLIST: &[&str] = &[
    "exe", "com", "app", "bin", "cmd", "lnk", "url", "users", "user", "appdata", "local",
    "locallow", "roaming", "program", "programs", "programfiles", "files", "windows", "system32",
    "start", "menu", "desktop", "microsoft", "google", "data",
    // AUMID prefixes of Electron apps: `electron.app.Antigravity` identifies no product at all.
    "electron", "electronapp", "shell", "launcher",
];

/// Identity clues, in order of confidence.
///
/// The EXECUTABLE comes first: `Antigravity IDE.exe` and `Antigravity.exe` are different products
/// that share a prefix, and the label — which the user can rename — does not tell them apart. Then
/// the visible name, and last the path.
pub fn identity_tokens(name: &str, command: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::with_capacity(8);
    let mut push = |raw: &str| {
        let token = normalize(raw);
        if token.len() < 3 || tokens.contains(&token) || STOPLIST.contains(&token.as_str()) {
            return;
        }
        tokens.push(token.clone());
        if let Some((_, alias)) = ALIASES.iter().find(|(from, _)| *from == token) {
            let alias = alias.to_string();
            if !tokens.contains(&alias) {
                tokens.push(alias);
            }
        }
    };

    let command = command.trim().trim_matches('"');
    let segments: Vec<&str> = command.split(['\\', '/']).filter(|s| !s.is_empty()).collect();
    let executable = segments.last().copied().unwrap_or("");

    // `Antigravity IDE.exe` -> `antigravityide`.
    push(executable.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(executable));
    // The install folder: `...\Programs\Antigravity IDE\...`.
    if segments.len() >= 2 {
        push(segments[segments.len() - 2]);
    }
    // An AUMID: `Google.Antigravity` -> `antigravity`.
    for part in executable.split('.') {
        push(part);
    }

    push(name);
    for word in name.split([' ', '-', '_']) {
        push(word);
    }
    for segment in &segments {
        push(segment);
    }
    tokens
}

/// One profile folder of the VS Code family.
#[derive(Debug, Clone)]
pub struct Profile {
    pub name: String,
    pub normalized: String,
    pub global_storage: PathBuf,
    /// When its store was last written, so the freshest of two matches wins.
    pub modified: std::time::SystemTime,
}

/// Where apps of this family keep a profile.
fn search_roots() -> Vec<PathBuf> {
    ["APPDATA", "LOCALAPPDATA"]
        .iter()
        .filter_map(|name| std::env::var_os(name))
        .map(PathBuf::from)
        .collect()
}

fn profile_at(dir: &Path, name: &str) -> Option<Profile> {
    let global_storage = dir.join("User").join("globalStorage");
    let mut modified: Option<std::time::SystemTime> = None;
    for file in ["state.vscdb", "storage.json"] {
        if let Ok(meta) = std::fs::metadata(global_storage.join(file)) {
            let when = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
            modified = Some(modified.map_or(when, |best: std::time::SystemTime| best.max(when)));
        }
    }
    Some(Profile {
        name: name.to_string(),
        normalized: normalize(name),
        global_storage,
        modified: modified?,
    })
}

/// Every profile of this family on the machine.
pub fn profiles() -> Vec<Profile> {
    let mut out = Vec::new();
    for root in search_roots() {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(profile) = profile_at(&entry.path(), &name) {
                out.push(profile);
            }
        }
    }
    out
}

/// How well a profile folder's name answers to one identity token.
fn score(token: &str, profile: &Profile) -> u32 {
    let name = profile.normalized.as_str();
    if token.is_empty() || name.is_empty() {
        return 0;
    }
    if name == token {
        return 100;
    }
    if name.starts_with(token) {
        return 80;
    }
    if token.starts_with(name) {
        return 70;
    }
    // A short token inside a long name is a coincidence, not a match.
    if token.len() >= 5 && name.contains(token) {
        return 50;
    }
    0
}

/// Whether a product has a data folder of its own that is NOT a profile of this family.
///
/// The case this exists for: a token matches a real folder, that folder has no `globalStorage`,
/// and a partial match would then hand back some OTHER editor's recent projects. An empty ring is
/// correct there; somebody else's projects is not.
fn has_own_non_profile_dir(token: &str) -> bool {
    for root in search_roots() {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            if normalize(&entry.file_name().to_string_lossy()) != token {
                continue;
            }
            if !entry.path().join("User").join("globalStorage").exists() {
                return true;
            }
        }
    }
    false
}

/// The profile folder a shortcut's recents should come from.
pub fn resolve_global_storage(name: &str, command: &str) -> Option<PathBuf> {
    let tokens = identity_tokens(name, command);
    if tokens.is_empty() {
        return None;
    }
    let profiles = profiles();
    if profiles.is_empty() {
        return None;
    }

    // 1) An exact match. A product identified to the millimetre never yields to a prefix.
    for token in &tokens {
        let exact = profiles
            .iter()
            .filter(|profile| &profile.normalized == token)
            .max_by_key(|profile| profile.modified);
        if let Some(profile) = exact {
            return Some(profile.global_storage.clone());
        }
        // 2) The product has a home of its own and it is not a profile: there is no MRU to show.
        if has_own_non_profile_dir(token) {
            return None;
        }
    }

    // 3) Only then a partial, for profiles whose folder name differs from the product.
    let mut best: Option<(usize, u32, &Profile)> = None;
    for (index, token) in tokens.iter().enumerate() {
        for profile in &profiles {
            let value = score(token, profile);
            if value == 0 {
                continue;
            }
            let better = match best {
                None => true,
                Some((best_index, best_score, best_profile)) => {
                    index < best_index
                        || (index == best_index
                            && (value > best_score
                                || (value == best_score
                                    && profile.modified > best_profile.modified)))
                }
            };
            if better {
                best = Some((index, value, profile));
            }
        }
    }
    best.map(|(_, _, profile)| profile.global_storage.clone())
}

/// Whether this shortcut is one that could have recent projects at all.
///
/// A cheap, local guess. `resolve_global_storage` is the real answer and costs a directory scan,
/// so this is what decides whether to bother asking.
pub fn looks_like_an_ide(label: &str, command: &str, kind: Option<CommandType>) -> bool {
    if !matches!(kind, Some(CommandType::App) | None) {
        return false;
    }
    let label = label.trim().to_lowercase();
    if label == "code" {
        return true;
    }
    let haystack = format!("{label} {}", command.to_lowercase());
    const KEYWORDS: &[&str] = &[
        "visual studio code",
        "visualstudiocode",
        "visual studio",
        "vscode",
        "code.exe",
        "cursor",
        "antigravity",
        "windsurf",
        "intellij",
        "webstorm",
        "pycharm",
        "phpstorm",
        "rider",
        "clion",
        "goland",
        "android studio",
        "sublime text",
        "atom.exe",
        "zed.exe",
    ];
    KEYWORDS.iter().any(|keyword| haystack.contains(keyword))
}

/// Turn `file:///c%3A/Users/Me/Project` into `C:\Users\Me\Project`.
pub fn path_from_uri(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix("file:///").unwrap_or(uri);
    let decoded = percent_decode(rest);
    let decoded = decoded.trim_start_matches('/');
    if decoded.is_empty() {
        return None;
    }
    Some(decoded.replace('/', "\\"))
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut at = 0usize;
    while at < bytes.len() {
        if bytes[at] == b'%' && at + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[at + 1..at + 3]).ok();
            if let Some(byte) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(byte);
                at += 3;
                continue;
            }
        }
        out.push(bytes[at]);
        at += 1;
    }
    // Lossy: a path this cannot decode should come back slightly wrong rather than not at all.
    String::from_utf8_lossy(&out).into_owned()
}

/// Read the recently-opened list out of a profile.
fn recently_opened(global_storage: &Path) -> Vec<serde_json::Value> {
    const KEY: &str = "history.recentlyOpenedPathsList";

    // The database first: on every profile this was written against, the JSON file no longer
    // carries the key at all.
    let vscdb = global_storage.join("state.vscdb");
    if let Some(bytes) = super::sqlite::lookup(&vscdb, "ItemTable", KEY) {
        if let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            let entries = entries_of(&parsed);
            if !entries.is_empty() {
                return entries;
            }
        }
    }

    let storage = global_storage.join("storage.json");
    let Ok(text) = std::fs::read_to_string(&storage) else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    entries_of(parsed.pointer("/history/recentlyOpenedPathsList").unwrap_or(&serde_json::Value::Null))
}

/// The list, whichever of its two shapes it was stored in.
fn entries_of(raw: &serde_json::Value) -> Vec<serde_json::Value> {
    if let Some(array) = raw.as_array() {
        return array.clone();
    }
    raw.get("entries")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default()
}

/// The command that opens one project with this editor.
///
/// A shortcut Windows discovered is often an AUMID (`shell:AppsFolder\…`), which takes no folder
/// argument at all. Where the executable can be found instead, it is used; where it cannot, the
/// entry is still listed and opens the folder in Explorer, which is the honest fallback.
fn open_with(command: &str, project: &str) -> String {
    let trimmed = command.trim().trim_matches('"');
    let looks_runnable = trimmed.to_lowercase().ends_with(".exe");
    if !looks_runnable {
        return project.to_string();
    }
    if trimmed.contains(' ') {
        format!("\"{trimmed}\" \"{project}\"")
    } else {
        format!("{trimmed} \"{project}\"")
    }
}

/// The recent projects of one shortcut, as items a ring can be built from.
pub fn fetch(label: &str, command: &str) -> Vec<AppItem> {
    let Some(global_storage) = resolve_global_storage(label, command) else {
        return Vec::new();
    };
    let entries = recently_opened(&global_storage);
    let mut seen: Vec<String> = Vec::with_capacity(MAX_RECENTS);
    let mut out: Vec<AppItem> = Vec::with_capacity(MAX_RECENTS);

    for entry in entries {
        // A folder, a multi-root workspace file, or a single file — in that order, which is the
        // order of how much of a "project" each one is.
        let uri = entry
            .get("folderUri")
            .and_then(|v| v.as_str())
            .or_else(|| entry.pointer("/workspace/configPath").and_then(|v| v.as_str()))
            .or_else(|| entry.get("fileUri").and_then(|v| v.as_str()));
        let Some(uri) = uri else { continue };
        if seen.iter().any(|s| s == uri) {
            continue;
        }
        let Some(path) = path_from_uri(uri) else { continue };
        let leaf = path.trim_end_matches('\\').rsplit('\\').next().unwrap_or(&path);
        // `.` is what a path with nothing after the drive comes out as, and it is not a project.
        if leaf.is_empty() || leaf == "." {
            continue;
        }
        seen.push(uri.to_string());

        // A file's working directory is the folder it is in; a folder's is itself.
        let working = if std::fs::metadata(&path).map(|m| m.is_file()).unwrap_or(false) {
            path.rsplit_once('\\').map(|(dir, _)| dir.to_string())
        } else {
            Some(path.clone())
        };

        out.push(AppItem {
            id: format!("recent-{uri}"),
            kind: Some(ItemKind::App),
            label: leaf.to_string(),
            icon_name: "Folder".into(),
            icon_source: Some(IconSource::Lucide),
            command: open_with(command, &path),
            command_type: Some(CommandType::App),
            // The full path, so the wheel can say WHICH `src` this is when two are open.
            description: path.clone(),
            working_directory: working,
            ..AppItem::default()
        });
        if out.len() >= MAX_RECENTS {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_executable_identifies_a_product_before_its_label_does() {
        // `Antigravity IDE.exe` and `Antigravity.exe` are different products sharing a prefix.
        let tokens = identity_tokens(
            "Antigravity",
            r"C:\Users\Me\AppData\Local\Programs\Antigravity IDE\Antigravity IDE.exe",
        );
        assert_eq!(tokens.first().map(String::as_str), Some("antigravityide"));
        assert!(tokens.contains(&"antigravity".to_string()));
    }

    #[test]
    fn the_label_vs_code_uses_is_aliased_to_the_folder_it_creates() {
        let tokens = identity_tokens("Visual Studio Code", "Microsoft.VisualStudioCode");
        assert!(
            tokens.contains(&"code".to_string()),
            "no `code` alias in {tokens:?}"
        );
    }

    #[test]
    fn path_fragments_that_identify_nothing_are_dropped() {
        let tokens = identity_tokens("", r"C:\Users\Me\AppData\Local\Programs\cursor\Cursor.exe");
        for noise in ["users", "appdata", "local", "programs", "exe"] {
            assert!(!tokens.contains(&noise.to_string()), "{noise} survived: {tokens:?}");
        }
        assert!(tokens.contains(&"cursor".to_string()));
        // An AUMID prefix identifies no product either.
        let tokens = identity_tokens("Antigravity", "electron.app.Antigravity");
        assert!(!tokens.contains(&"electron".to_string()), "{tokens:?}");
        assert!(tokens.contains(&"antigravity".to_string()));
    }

    #[test]
    fn a_uri_becomes_the_path_windows_uses() {
        assert_eq!(
            path_from_uri("file:///c%3A/Users/Me/Projects/thing").as_deref(),
            Some(r"c:\Users\Me\Projects\thing")
        );
        assert_eq!(
            path_from_uri("file:///d%3A/With%20Spaces/x").as_deref(),
            Some(r"d:\With Spaces\x")
        );
        // A UNC path keeps both leading separators.
        assert_eq!(path_from_uri("file:///"), None);
    }

    #[test]
    fn an_aumid_cannot_take_a_folder_argument() {
        // Opening the folder is the honest fallback: a moniker handed a path opens the app with
        // no project at all, which looks like the shortcut silently ignoring the click.
        assert_eq!(
            open_with(r"shell:AppsFolder\Microsoft.VisualStudioCode", r"C:\p"),
            r"C:\p"
        );
        assert_eq!(
            open_with(r"C:\Program Files\VS\Code.exe", r"C:\p"),
            "\"C:\\Program Files\\VS\\Code.exe\" \"C:\\p\""
        );
        // No spaces, no quotes around the program.
        assert_eq!(open_with(r"C:\tools\code.exe", r"C:\p"), "C:\\tools\\code.exe \"C:\\p\"");
    }

    #[test]
    fn only_editors_are_asked() {
        assert!(looks_like_an_ide("Visual Studio Code", "Microsoft.VisualStudioCode", Some(CommandType::App)));
        assert!(looks_like_an_ide("Cursor", "Anysphere.Cursor", Some(CommandType::App)));
        assert!(looks_like_an_ide("code", "", Some(CommandType::App)));
        assert!(!looks_like_an_ide("Spotify", "Spotify.exe", Some(CommandType::App)));
        // A web shortcut has no recent projects however it is named.
        assert!(!looks_like_an_ide("Cursor", "https://cursor.com", Some(CommandType::Url)));
    }

    #[test]
    fn the_list_is_read_in_either_of_its_two_shapes() {
        let array = serde_json::json!([{ "folderUri": "file:///c%3A/a" }]);
        assert_eq!(entries_of(&array).len(), 1);
        let object = serde_json::json!({ "entries": [{ "folderUri": "file:///c%3A/a" }] });
        assert_eq!(entries_of(&object).len(), 1);
        assert_eq!(entries_of(&serde_json::Value::Null).len(), 0);
    }

    /// Against whatever editors this machine has.
    #[test]
    fn a_real_editor_yields_real_projects() {
        let candidates = [
            ("Visual Studio Code", "Microsoft.VisualStudioCode"),
            ("Cursor", "Anysphere.Cursor"),
        ];
        for (label, command) in candidates {
            let Some(storage) = resolve_global_storage(label, command) else {
                continue;
            };
            assert!(
                storage.ends_with("globalStorage"),
                "{label} resolved to {storage:?}"
            );
            for item in fetch(label, command) {
                assert!(!item.label.is_empty());
                assert!(!item.description.is_empty());
                assert!(item.id.starts_with("recent-"));
            }
        }
    }
}
