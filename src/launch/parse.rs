//! Windows launch-line parsing and canonicalisation.
//!
//! The whole of this file exists to stop `C:\Program Files\...` being split at the first space into
//! `C:\Program` plus garbage. That is the single most common way a launcher fails on Windows, and it
//! fails silently — the shell reports that it cannot find `C:\Program`, which nobody recognises as
//! the shortcut they added.
//!
//! The functions here are pure except [`split_exe_and_args`], which has to touch the disk: deciding
//! where an unquoted executable's path ENDS is not answerable from the string. `C:\Program Files\A
//! B\run.exe --flag x` has four plausible splits and only the filesystem knows which one exists.

use std::path::Path;

/// `shell:AppsFolder\<AppID>` — the Start menu's own launch route.
///
/// It is the only one that covers every shape the Start menu reports. Measured on a live host:
///
/// ```text
/// Microsoft.WindowsCalculator_8wekyb3d8bbwe!App                 MSIX AUMID
/// com.squirrel.Figma.Figma                                      Squirrel/Electron installer id
/// c:.users.<me>.appdata.local.capcut.apps.9.5.0.capcut.exe      a path the shell flattened
/// zoom.us.Zoom Video Meetings                                   an id with SPACES in it
/// {6D809377-6AF0-444B-8957-A3773F02200E}\Notepad++\notepad++.exe known-folder relative
/// C:\Games\Subnautica\Subnautica.exe                            a real path
/// Chrome                                                        bare alias
/// ```
///
/// Of those, only the last two survive being handed to a shell as a command line. The rest are
/// IDENTIFIERS, and passing them to the shell as if they were files is what put "Windows cannot
/// find…" in front of everyone who added Figma or CapCut from the picker.
pub const APPS_FOLDER_PREFIX: &str = "shell:AppsFolder\\";

/// Strip one layer of surrounding double quotes.
pub fn unquote(value: &str) -> &str {
    let t = value.trim();
    if t.len() >= 2 && t.starts_with('"') && t.ends_with('"') {
        &t[1..t.len() - 1]
    } else {
        t
    }
}

/// Split the tail of a command line into argv tokens: quoted runs, and space-separated words.
pub fn command_line_args(rest: &str) -> Vec<String> {
    let s = rest.trim();
    let bytes: Vec<char> = s.chars().collect();
    let mut args = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        while i < bytes.len() && bytes[i].is_whitespace() {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        if bytes[i] == '"' {
            let mut j = i + 1;
            while j < bytes.len() && bytes[j] != '"' {
                j += 1;
            }
            args.push(bytes[i + 1..j].iter().collect());
            i = j + 1;
        } else {
            let mut j = i;
            while j < bytes.len() && !bytes[j].is_whitespace() {
                j += 1;
            }
            args.push(bytes[i..j].iter().collect());
            i = j;
        }
    }
    args
}

/// Quote one argv token, but only when it needs it.
///
/// Leaving simple tokens bare matters because the result is compared against what is already stored
/// on disk: canonicalising has to be idempotent, or every read-write cycle would add another layer
/// of quotes.
pub fn quote_if_needed(value: &str) -> String {
    let stripped = unquote(value);
    if stripped.is_empty() {
        return String::new();
    }
    let needs = stripped
        .chars()
        .any(|c| c.is_whitespace() || "&()[]{}^=!;`+,".contains(c));
    if !needs {
        return stripped.to_string();
    }
    format!("\"{}\"", stripped.replace('"', "\\\""))
}

/// Split an unquoted command line into an executable and its arguments, WITHOUT breaking at the
/// first space inside a path.
///
/// The disk is consulted because the string alone cannot answer it. The longest prefix that is an
/// existing FILE wins — longest rather than shortest, because `C:\Tools\run` and
/// `C:\Tools\run file.txt` can both exist and the user who wrote the second one meant the second.
pub fn split_exe_and_args(command: &str) -> (String, Vec<String>) {
    let t = command.trim();
    if t.is_empty() {
        return (String::new(), Vec::new());
    }
    if let Some(rest) = t.strip_prefix('"') {
        return match rest.find('"') {
            Some(end) => (
                rest[..end].to_string(),
                command_line_args(&rest[end + 1..]),
            ),
            // An unterminated quote is a line somebody hand-edited. Treating the whole thing as
            // the executable is the reading most likely to work: the shell will unquote it.
            None => (t.to_string(), Vec::new()),
        };
    }
    if !t.contains(' ') {
        return (t.to_string(), Vec::new());
    }

    let parts: Vec<&str> = t.split(' ').collect();
    let mut best: Option<(String, usize)> = None;
    for i in 1..=parts.len() {
        let candidate = parts[..i].join(" ");
        if Path::new(&candidate).is_file() {
            best = Some((candidate, i));
        }
    }
    if let Some((exe, end)) = best {
        let rest = parts[end..].join(" ");
        return (exe, command_line_args(&rest));
    }
    // Nothing on disk matched. Fall back to the first space, which is what a shell would do.
    match t.find(' ') {
        Some(at) => (t[..at].to_string(), command_line_args(&t[at + 1..])),
        None => (t.to_string(), Vec::new()),
    }
}

/// Rebuild a launch line from its parsed parts, so paths with spaces are always quoted.
///
/// Idempotent for most lines. Skipped entirely for the shapes that are identifiers rather than
/// command lines — a URL, a protocol, a `shell:` moniker, an AUMID with no drive path — because
/// rewriting one of those is how `zoom.us.Zoom Video Meetings` became three arguments.
pub fn canonicalize(command: &str) -> String {
    let t = command.trim();
    if t.is_empty() {
        return String::new();
    }
    let lower = t.to_ascii_lowercase();
    if lower.starts_with("internal:")
        || lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("shell:")
        || lower.starts_with("steam:")
        || lower.starts_with("discord:")
        || lower.starts_with("spotify:")
        || lower.starts_with("mailto:")
    {
        return t.to_string();
    }
    // A store or protocol AUMID — no `X:\` path — is not rewritten.
    if t.contains('!') && !is_absolute_target(t) && !t.starts_with('"') {
        return t.to_string();
    }

    let (exe, args) = split_exe_and_args(t);
    if exe.is_empty() {
        return t.to_string();
    }
    let mut parts = Vec::with_capacity(args.len() + 1);
    parts.push(quote_if_needed(&exe));
    for arg in &args {
        let quoted = quote_if_needed(arg);
        if !quoted.is_empty() {
            parts.push(quoted);
        }
    }
    let out = parts.join(" ");
    if out.is_empty() {
        t.to_string()
    } else {
        out
    }
}

/// Whether a line is already written as an AppsFolder moniker.
pub fn is_apps_folder(command: &str) -> bool {
    let t = command.trim().to_ascii_lowercase();
    t.starts_with("shell:appsfolder\\") || t.starts_with("shell:appsfolder/")
}

/// The AppID inside a moniker, or `None` for anything else.
///
/// Everything after the prefix is the id — it is NEVER split on whitespace. `zoom.us.Zoom Video
/// Meetings` is one identifier, and treating its tail as argv is what made Zoom fail too.
pub fn apps_folder_id(command: &str) -> Option<&str> {
    let t = unquote(command);
    if !is_apps_folder(t) {
        return None;
    }
    let id = t["shell:AppsFolder".len()..].trim_start_matches(['\\', '/']).trim();
    (!id.is_empty()).then_some(id)
}

/// Wrap a Start-menu AppID as a launch line. Idempotent.
pub fn to_apps_folder(app_id: &str) -> String {
    let id = unquote(app_id);
    if id.is_empty() {
        return String::new();
    }
    match apps_folder_id(id) {
        Some(inner) => format!("{APPS_FOLDER_PREFIX}{inner}"),
        None => format!("{APPS_FOLDER_PREFIX}{id}"),
    }
}

/// An absolute Windows path — a drive-letter path or a UNC one.
pub fn is_absolute_target(command: &str) -> bool {
    let t = unquote(command);
    let bytes = t.as_bytes();
    (bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/'))
        || t.starts_with("\\\\")
}

/// Does this line look like a bare Start-menu AppID rather than something the shell can run?
///
/// Shortcuts added before the picker started writing monikers still hold the bare id, so the call
/// has to be made from the string alone — and it is what repairs those without a migration.
///
/// A real target always announces itself: a drive path, a UNC path, or a quoted first token. An
/// AppID never does — not even CapCut's, which opens `c:.` (drive letter, colon, DOT) precisely
/// because the shell flattened a path into an identifier.
///
/// Bare single words (`notepad`, `Chrome`) are deliberately NOT claimed. They already launch
/// through the shell, and most are not AppsFolder entries at all.
pub fn looks_like_bare_app_id(command: &str) -> bool {
    let t = command.trim();
    if t.is_empty() || t.starts_with('"') {
        return false;
    }
    if is_apps_folder(t) || is_absolute_target(t) {
        return false;
    }
    let lower = t.to_ascii_lowercase();
    // Any `scheme://` is a URL.
    if let Some(at) = lower.find("://") {
        if lower[..at]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
            && lower[..at].starts_with(|c: char| c.is_ascii_alphabetic())
        {
            return false;
        }
    }
    for scheme in [
        "internal:", "shortcut:", "shell:", "mailto:", "steam:", "discord:", "spotify:",
    ] {
        if lower.starts_with(scheme) {
            return false;
        }
    }
    if t.contains('/') {
        return false;
    }

    // A known-folder GUID or an MSIX AUMID is an AppID by construction.
    if t.starts_with('{') || t.contains('!') {
        return true;
    }

    let head = t.split(' ').next().unwrap_or("");
    let head_lower = head.to_ascii_lowercase();
    // `c:.users.….capcut.exe` — a flattened path keeps its extension, so test the SHAPE, not the
    // tail.
    let bytes = head.as_bytes();
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'.' {
        return true;
    }
    // Dots as id separators, not as a file extension: `com.squirrel.Figma.Figma`, `zoom.us.Zoom`.
    head.contains('.')
        && ![".exe", ".lnk", ".bat", ".cmd", ".com", ".vbs", ".ps1", ".msi"]
            .iter()
            .any(|ext| head_lower.ends_with(ext))
}

/// Whether a command is an identifier the shell activates rather than a file it opens.
pub fn is_shell_app(command: &str) -> bool {
    let t = command.trim();
    if t.starts_with('{') || t.contains('!') {
        return true;
    }
    if is_absolute_target(t) || t.contains('\\') || t.contains('/') {
        return false;
    }
    let lower = t.to_ascii_lowercase();
    t.contains('.')
        && ![".exe", ".lnk", ".bat", ".cmd"]
            .iter()
            .any(|ext| lower.ends_with(ext))
}

/// The directory a terminal should start in, for a launch line.
///
/// The LAST quoted path in the line, because that is the project folder an IDE was handed; failing
/// that, the executable's own directory. Never `description`, which can be "Quick Access Folder"
/// or "Application" and is not a path at all.
pub fn terminal_working_dir(command: &str, explicit: Option<&str>) -> Option<String> {
    if let Some(dir) = explicit.map(str::trim).filter(|d| !d.is_empty()) {
        return Some(dir.to_string());
    }
    let quoted: Vec<&str> = quoted_runs(command);
    for candidate in quoted.iter().rev() {
        let path = Path::new(candidate);
        if path.is_dir() {
            return Some((*candidate).to_string());
        }
        if path.is_file() {
            return path.parent().map(|p| p.to_string_lossy().into_owned());
        }
    }
    // Nothing quoted: the last unquoted token that is a directory, then the executable's folder.
    let (exe, args) = split_exe_and_args(command);
    for arg in args.iter().rev() {
        if Path::new(arg).is_dir() {
            return Some(arg.clone());
        }
    }
    let path = Path::new(&exe);
    if path.is_dir() {
        return Some(exe);
    }
    path.parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| p.to_string_lossy().into_owned())
}

fn quoted_runs(command: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let bytes = command.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'"' {
            if let Some(end) = command[i + 1..].find('"') {
                out.push(&command[i + 1..i + 1 + end]);
                i = i + 2 + end;
                continue;
            }
            break;
        }
        i += 1;
    }
    out
}

/// A path for deduplicating shortcuts that point at the same place.
///
/// Lower-cased, forward slashes, no trailing separator, unwrapped. Takes the LAST quoted run when
/// there is one, because for an IDE line that is the project folder rather than the executable.
pub fn normalize_for_dedup(command: &str) -> String {
    let mut path = {
        let quoted = quoted_runs(command);
        match quoted.last() {
            Some(last) => (*last).to_string(),
            None => {
                let lower = command.trim().to_ascii_lowercase();
                let mut stripped = command.trim().to_string();
                for prefix in [
                    "antigravity ", "cursor ", "code ", "vscode ", "code.exe ", "cursor.exe ",
                    "antigravity.exe ",
                ] {
                    if lower.starts_with(prefix) {
                        stripped = command.trim()[prefix.len()..].trim().to_string();
                        break;
                    }
                }
                stripped
            }
        }
    };
    path = path.to_ascii_lowercase();
    let mut out = String::with_capacity(path.len());
    let mut last_was_sep = false;
    for c in path.chars() {
        let sep = c == '\\' || c == '/';
        if sep {
            if !last_was_sep {
                out.push('/');
            }
        } else {
            out.push(c);
        }
        last_was_sep = sep;
    }
    out.trim_end_matches('/')
        .trim_matches(|c| c == '"' || c == '\'')
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn program_files_is_not_split_at_the_first_space() {
        // The single most common way a Windows launcher fails, and it fails silently.
        let line = "\"C:\\Program Files\\App\\app.exe\" --flag value";
        let (exe, args) = split_exe_and_args(line);
        assert_eq!(exe, "C:\\Program Files\\App\\app.exe");
        assert_eq!(args, vec!["--flag", "value"]);
    }

    #[test]
    fn canonicalising_is_idempotent() {
        // The result is compared against what is stored, so a second pass must not add quotes.
        for line in [
            "notepad",
            "\"C:\\Program Files\\App\\app.exe\" --flag",
            "https://example.com/",
            "shell:AppsFolder\\zoom.us.Zoom Video Meetings",
            "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
            "com.squirrel.Figma.Figma",
        ] {
            let once = canonicalize(line);
            assert_eq!(canonicalize(&once), once, "{line}");
        }
    }

    #[test]
    fn identifiers_are_never_rewritten() {
        // Rewriting one is how `zoom.us.Zoom Video Meetings` became three arguments.
        for line in [
            "shell:AppsFolder\\zoom.us.Zoom Video Meetings",
            "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
            "https://example.com/a b",
            "steam://run/440",
            "internal:notes",
        ] {
            assert_eq!(canonicalize(line), line, "{line}");
        }
    }

    #[test]
    fn an_app_id_keeps_its_spaces() {
        let id = apps_folder_id("shell:AppsFolder\\zoom.us.Zoom Video Meetings");
        assert_eq!(id, Some("zoom.us.Zoom Video Meetings"));
        // And the wrapper is idempotent.
        let wrapped = to_apps_folder("zoom.us.Zoom Video Meetings");
        assert_eq!(to_apps_folder(&wrapped), wrapped);
    }

    #[test]
    fn every_measured_start_menu_shape_is_classified() {
        // These are the exact strings a live host reports; the classification is what decides
        // whether a shortcut launches or produces "Windows cannot find...".
        let ids = [
            "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
            "com.squirrel.Figma.Figma",
            "c:.users.me.appdata.local.capcut.apps.9.5.0.capcut.exe",
            "zoom.us.Zoom Video Meetings",
            "{6D809377-6AF0-444B-8957-A3773F02200E}",
        ];
        for id in ids {
            assert!(looks_like_bare_app_id(id), "{id} should be an AppID");
        }
        // A real target announces itself and must NOT be claimed.
        for target in [
            "C:\\Games\\Subnautica\\Subnautica.exe",
            "\"C:\\Program Files\\App\\app.exe\"",
            "\\\\server\\share\\app.exe",
            "https://example.com/",
            "notepad",
            "Chrome",
            "app.exe",
        ] {
            assert!(!looks_like_bare_app_id(target), "{target} is not an AppID");
        }
    }

    #[test]
    fn a_flattened_path_is_still_an_id() {
        // CapCut's opens `c:.` — drive letter, colon, DOT — because the shell flattened a path.
        assert!(looks_like_bare_app_id("c:.users.me.capcut.exe"));
        // A real drive path is not.
        assert!(!looks_like_bare_app_id("c:\\users\\me\\capcut.exe"));
    }

    #[test]
    fn quoting_leaves_simple_tokens_alone() {
        assert_eq!(quote_if_needed("notepad"), "notepad");
        assert_eq!(quote_if_needed("--flag"), "--flag");
        assert_eq!(quote_if_needed("a b"), "\"a b\"");
        // `=` counts as needing quotes even though a shell would survive without them. It is in
        // the set because `cmd` treats it as a delimiter in some contexts, and a quoted
        // `"--flag=1"` reaches the program unquoted either way — so the safe reading is free.
        assert_eq!(quote_if_needed("--flag=1"), "\"--flag=1\"");
        // And unwraps before re-quoting, which is what makes it idempotent.
        assert_eq!(quote_if_needed("\"a b\""), "\"a b\"");
        assert_eq!(quote_if_needed("\"simple\""), "simple");
    }

    #[test]
    fn argv_splitting_handles_quoted_runs() {
        assert_eq!(
            command_line_args("  --flag  \"a b\"   c  "),
            vec!["--flag", "a b", "c"]
        );
        assert_eq!(command_line_args(""), Vec::<String>::new());
    }

    #[test]
    fn absolute_targets_are_recognised() {
        assert!(is_absolute_target("C:\\x"));
        assert!(is_absolute_target("c:/x"));
        assert!(is_absolute_target("\\\\server\\share"));
        assert!(is_absolute_target("\"C:\\Program Files\\a\""));
        assert!(!is_absolute_target("notepad"));
        assert!(!is_absolute_target("c:.flattened.exe"));
    }

    #[test]
    fn dedup_normalises_the_project_path() {
        // The LAST quoted run, because for an IDE line that is the project folder.
        assert_eq!(
            normalize_for_dedup("\"C:\\Tools\\code.exe\" \"D:\\Work\\Project\\\""),
            "d:/work/project"
        );
        // Unquoted IDE prefixes are stripped.
        assert_eq!(normalize_for_dedup("cursor D:\\Work\\Project"), "d:/work/project");
        // Repeated separators collapse and case is flattened, so two spellings of one path match.
        assert_eq!(
            normalize_for_dedup("D:\\\\Work//Project\\"),
            normalize_for_dedup("d:/work/project")
        );
    }

    #[test]
    fn an_unterminated_quote_does_not_lose_the_command() {
        let (exe, args) = split_exe_and_args("\"C:\\Program Files\\app.exe --flag");
        assert!(exe.contains("app.exe"));
        assert!(args.is_empty());
    }

    #[test]
    fn shell_apps_are_told_from_files() {
        assert!(is_shell_app("com.squirrel.Figma.Figma"));
        assert!(is_shell_app("Package_hash!App"));
        assert!(is_shell_app("{GUID}"));
        assert!(!is_shell_app("notepad.exe"));
        assert!(!is_shell_app("C:\\x\\y.exe"));
        assert!(!is_shell_app("notepad"));
    }
}
