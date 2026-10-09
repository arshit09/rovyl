//! Reading a drop.
//!
//! Everything that can be dragged onto the Shortcuts list arrives as one of three things: files
//! with real paths (`CF_HDROP`), a link dragged out of a browser (`CFSTR_INETURL`), or plain text
//! (`CF_UNICODETEXT` — an address typed somewhere else, a path from "Copy as path", a command line
//! out of a terminal). This module turns any of them into shortcuts.
//!
//! It is a port of the Electron build's `src/utils/droppedShortcut.ts` AND of
//! `backend/drop-inspect.cjs`, which were two files there because one ran in the renderer and one
//! had the disk. Here they are one, because this process has both — but the split in the code
//! below is the same: `entries_from` answers what the drop SAYS, and `inspect` answers what a path
//! on disk actually IS. The first is pure and is where the rules live; only the second stats
//! anything.

use crate::config::{AppItem, CommandType};
use std::path::Path;

/// What a drop turned out to be, before the disk has had its say about any of the paths.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    Path(String),
    Url(String),
    Command(String),
}

/// The raw material of a drop, lifted off the data object so the rules never touch COM.
#[derive(Debug, Default, Clone)]
pub struct Payload {
    /// Absolute paths, from `CF_HDROP`.
    pub paths: Vec<String>,
    /// `CFSTR_INETURL` — the address a browser hands over for a dragged link.
    pub uri_list: String,
    /// `CF_UNICODETEXT`, used only when there is nothing better.
    pub text: String,
}

impl Payload {
    pub fn is_empty(&self) -> bool {
        self.paths.is_empty() && self.uri_list.trim().is_empty() && self.text.trim().is_empty()
    }
}

/// What the disk says a dropped path is. Mirrors `inspectDroppedPath`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Inspected {
    /// The path to store as the shortcut's command.
    pub path: String,
    pub kind: CommandType,
    /// `.url` / `.website` files only: the address inside.
    pub url: Option<String>,
    /// The file's own name, without its extension.
    pub label: String,
}

/// Programs, by extension. A `.lnk` is not here: it is resolved first and judged by its target.
const APP_EXTENSIONS: &[&str] = &[".exe", ".com", ".bat", ".cmd", ".appref-ms", ".msc"];

/// Internet shortcuts: a tiny INI whose `URL=` line is the whole point of the file.
const URL_FILE_EXTENSIONS: &[&str] = &[".url", ".website"];

/// How much of a `.url` file is worth reading before giving up on finding `URL=`.
const URL_FILE_READ_LIMIT: usize = 64 * 1024;

/// Explorer's "Copy as path" wraps the path in quotes; so does a path pasted out of a terminal.
fn unquote(value: &str) -> &str {
    let trimmed = value.trim();
    if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
        trimmed[1..trimmed.len() - 1].trim()
    } else {
        trimmed
    }
}

fn extension_of(target: &str) -> String {
    let trimmed = target.trim_end_matches(['\\', '/']);
    let base = trimmed.rsplit(['\\', '/']).next().unwrap_or(trimmed);
    match base.rfind('.') {
        // `.gitignore` is a name, not an extension: a dot at position zero names the file.
        Some(at) if at > 0 => base[at..].to_lowercase(),
        _ => String::new(),
    }
}

/// A drive path (`C:\…`), a UNC share (`\\server\…`), or one that opens with an environment
/// variable (`%APPDATA%\…`). Anything else with a slash in it is far more likely to be an address
/// or a command line, and is left to the two tests below.
pub fn looks_like_a_windows_path(value: &str) -> bool {
    let clean = unquote(value);
    if clean.is_empty() || clean.contains(['\r', '\n']) {
        return false;
    }
    let bytes = clean.as_bytes();
    // `C:\` or `C:/`
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        return true;
    }
    // `\\server`
    if let Some(rest) = clean.strip_prefix("\\\\") {
        return rest.starts_with(|c| c != '\\' && c != '/');
    }
    // `%VAR%\`
    if let Some(rest) = clean.strip_prefix('%') {
        if let Some(end) = rest.find('%') {
            let name = &rest[..end];
            let after = &rest[end + 1..];
            return !name.is_empty()
                && !name.contains(char::is_whitespace)
                && after.starts_with(['\\', '/']);
        }
    }
    false
}

/// An address, with or without the scheme the user left out.
///
/// A bare host has to carry a dot and no whitespace, which is what keeps `npm run dev` and
/// `git status` out — and `localhost:3000` is allowed explicitly, because a dev server is the one
/// address anybody drops that has no dot in it at all.
pub fn looks_like_a_web_address(value: &str) -> bool {
    let clean = unquote(value);
    if clean.is_empty() || clean.contains(char::is_whitespace) {
        return false;
    }
    if looks_like_a_windows_path(clean) {
        return false;
    }
    let lower = clean.to_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return true;
    }
    // The authority, up to the first `/`, `?` or `#`.
    let authority = clean.split(['/', '?', '#']).next().unwrap_or(clean);
    let host = authority.split(':').next().unwrap_or(authority);
    let port_ok = match authority.split_once(':') {
        Some((_, port)) => !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()),
        None => true,
    };
    if !port_ok {
        return false;
    }
    let host_lower = host.to_lowercase();
    if host_lower == "localhost" || host_lower == "127.0.0.1" {
        return true;
    }
    // `host.tld`: at least one dot, and every label made of word characters or dashes.
    let labels: Vec<&str> = host.split('.').collect();
    labels.len() >= 2
        && labels.iter().all(|label| {
            !label.is_empty()
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
}

/// A scheme Windows hands to another program — `steam://`, `mailto:`, `ms-settings:`,
/// `obsidian://`.
///
/// These are shortcuts of type `url` like any web link, but nothing may be fetched from them:
/// there is no page behind `mailto:` to ask for a title, and prefixing `https://` onto one would
/// break it outright.
pub fn is_a_non_web_scheme(value: &str) -> bool {
    let clean = unquote(value);
    if clean.is_empty() || clean.contains(char::is_whitespace) {
        return false;
    }
    let lower = clean.to_lowercase();
    for known in ["http:", "https:", "file:"] {
        if lower.starts_with(known) {
            return false;
        }
    }
    let Some(colon) = clean.find(':') else {
        return false;
    };
    if colon == 0 || colon + 1 >= clean.len() {
        return false;
    }
    let scheme = &clean[..colon];
    // A drive letter is not a scheme. The Electron build gets away without this because
    // `classifyDropText` asks `looksLikeWindowsPath` first and never reaches here with `C:\x` —
    // but this is a `pub fn`, and one that answers "yes, `steam:`" about `C:` is a trap for the
    // next caller. A real one-letter scheme followed by a separator does not exist in practice.
    if scheme.len() == 1 && clean[colon + 1..].starts_with(['\\', '/']) {
        return false;
    }
    scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        && scheme
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'.' || b == b'-')
}

/// `file:///C:/Users/me/notes.txt` → `C:\Users\me\notes.txt`, and `file://server/share/x` → UNC.
///
/// `None` for anything that is not a `file:` URI, so callers can fall through.
pub fn file_uri_to_windows_path(value: &str) -> Option<String> {
    let clean = unquote(value);
    let rest = clean
        .strip_prefix("file://")
        .or_else(|| clean.strip_prefix("FILE://"))
        .or_else(|| {
            clean
                .get(..7)
                .filter(|head| head.eq_ignore_ascii_case("file://"))
                .map(|_| &clean[7..])
        })?;
    // `file://server/share` has an authority; `file:///C:/x` has an empty one.
    let (host, path) = match rest.strip_prefix('/') {
        Some(path) => ("", path),
        None => match rest.split_once('/') {
            Some((host, path)) => (host, path),
            None => (rest, ""),
        },
    };
    let decoded = percent_decode(path).replace('/', "\\");
    if !host.is_empty() {
        return Some(format!("\\\\{host}\\{decoded}"));
    }
    if decoded.is_empty() {
        return None;
    }
    Some(decoded)
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut at = 0;
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
    String::from_utf8_lossy(&out).into_owned()
}

/// One line of dropped text, read as whichever of the three kinds it looks most like.
pub fn classify_text(value: &str) -> Option<Entry> {
    let clean = unquote(value);
    if clean.is_empty() {
        return None;
    }
    if let Some(path) = file_uri_to_windows_path(clean) {
        return Some(Entry::Path(path));
    }
    if looks_like_a_windows_path(clean) {
        return Some(Entry::Path(clean.to_string()));
    }
    if looks_like_a_web_address(clean) || is_a_non_web_scheme(clean) {
        return Some(Entry::Url(clean.to_string()));
    }
    // Everything left is a command line. Nothing is checked beyond that, exactly as the typed
    // Command form checks nothing: the shell is the only judge of what a line means, and a line
    // that turns out to be nonsense comes back as a launch card the user can edit.
    Some(Entry::Command(clean.to_string()))
}

/// `CFSTR_INETURL` is one address; a `text/uri-list` is one URI per line with `#` comments. Both
/// read the same way, and the comment rule costs nothing on a single line.
fn uri_lines(value: &str) -> impl Iterator<Item = &str> {
    value
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
}

/// Every entry a drop is worth, in the order they were dropped and with no repeats.
///
/// The three sources are tried in order of how much they actually know. Files come first because a
/// path is unambiguous; the browser's link second, because it is the link and not the page's text;
/// plain text last, and only when the drop carried nothing else — a link dragged out of Chrome
/// brings its title along as text, and reading both would add the same site twice.
pub fn entries_from(payload: &Payload) -> Vec<Entry> {
    let mut entries: Vec<Entry> = Vec::new();
    let mut seen: Vec<String> = Vec::new();

    let push = |entry: Option<Entry>, entries: &mut Vec<Entry>, seen: &mut Vec<String>| {
        let Some(entry) = entry else { return };
        let key = match &entry {
            Entry::Path(path) => format!("path:{}", path.to_lowercase()),
            Entry::Url(url) => format!("url:{url}"),
            Entry::Command(line) => format!("command:{line}"),
        };
        if seen.iter().any(|k| k == &key) {
            return;
        }
        seen.push(key);
        entries.push(entry);
    };

    for candidate in &payload.paths {
        let clean = unquote(candidate);
        if !clean.is_empty() {
            push(Some(Entry::Path(clean.to_string())), &mut entries, &mut seen);
        }
    }
    if !entries.is_empty() {
        return entries;
    }

    for uri in uri_lines(&payload.uri_list) {
        push(classify_text(uri), &mut entries, &mut seen);
    }
    if !entries.is_empty() {
        return entries;
    }

    // Multi-line text is several shortcuts — a column of paths copied out of a spreadsheet, a few
    // addresses out of a note. A single line that happens to wrap is not.
    for line in payload.text.lines() {
        push(classify_text(line), &mut entries, &mut seen);
    }
    entries
}

/// `Quarterly report.xlsx` → `Quarterly report`; `D:\Projects\` → `Projects`.
pub fn label_from_path(value: &str) -> String {
    let clean = unquote(value).trim_end_matches(['\\', '/']);
    if clean.is_empty() {
        return String::new();
    }
    let base = clean
        .rsplit(['\\', '/'])
        .find(|part| !part.is_empty())
        .unwrap_or(clean);
    let stripped = match base.rfind('.') {
        Some(at) if at > 0 && !base[at + 1..].contains(char::is_whitespace) => &base[..at],
        _ => base,
    };
    let stripped = stripped.trim();
    if stripped.is_empty() {
        base.trim().to_string()
    } else {
        stripped.to_string()
    }
}

/// The address inside a `.url` / `.website` file, which is a tiny INI.
pub fn read_url_file(target: &Path) -> Option<String> {
    let bytes = std::fs::read(target).ok()?;
    let head = &bytes[..bytes.len().min(URL_FILE_READ_LIMIT)];
    let text = String::from_utf8_lossy(head);
    for line in text.lines() {
        let line = line.trim();
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim().eq_ignore_ascii_case("url") {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// What a path on disk actually is.
///
/// The one function here that touches the disk, and the reason the rules above do not: a name can
/// say `.lnk` but only the file system can say what it points at, and only a `stat` tells a folder
/// from a file with no extension.
pub fn inspect(raw: &str, resolve_link: impl Fn(&Path) -> Option<String>) -> Option<Inspected> {
    let target = unquote(raw);
    if target.is_empty() {
        return None;
    }
    let label = label_from_path(target);
    let path = Path::new(target);

    if path.is_dir() {
        return Some(Inspected {
            path: target.to_string(),
            kind: CommandType::Folder,
            url: None,
            label,
        });
    }

    let ext = extension_of(target);

    if URL_FILE_EXTENSIONS.contains(&ext.as_str()) {
        // No readable address left in it — it is still a file Windows knows how to open.
        return Some(match read_url_file(path) {
            Some(url) => Inspected {
                path: target.to_string(),
                kind: CommandType::Url,
                url: Some(url),
                label,
            },
            None => Inspected {
                path: target.to_string(),
                kind: CommandType::File,
                url: None,
                label,
            },
        });
    }

    if ext == ".lnk" {
        return Some(inspect_link(target, label, resolve_link));
    }

    if APP_EXTENSIONS.contains(&ext.as_str()) {
        return Some(Inspected {
            path: target.to_string(),
            kind: CommandType::App,
            url: None,
            label,
        });
    }

    // No extension and nothing on disk to check — a path typed or copied from somewhere else.
    // There is nothing to distinguish it from a folder that is not mounted, and `file` is the
    // safer of the two: opening a directory that way opens Explorer anyway.
    Some(Inspected {
        path: target.to_string(),
        kind: CommandType::File,
        url: None,
        label,
    })
}

/// A Windows shortcut, resolved through to whatever it really points at.
///
/// The kind comes from the target; the COMMAND does not, and the split is deliberate. A folder or
/// a document keeps its resolved path, because that value is shown and edited in Settings and a
/// `.lnk` there says nothing. A program keeps the `.lnk` itself — that is what the Start menu
/// hands out, it carries the arguments and the working directory the vendor chose, and it is
/// exactly what the Application picker already stores when the same file is chosen by hand.
fn inspect_link(
    target: &str,
    label: String,
    resolve_link: impl Fn(&Path) -> Option<String>,
) -> Inspected {
    let app = |label: String| Inspected {
        path: target.to_string(),
        kind: CommandType::App,
        url: None,
        label,
    };

    let Some(resolved) = resolve_link(Path::new(target))
        .map(|value| unquote(&value).to_string())
        .filter(|value| !value.is_empty())
    else {
        // An unreadable `.lnk` is still a launchable one.
        return app(label);
    };

    let resolved_path = Path::new(&resolved);
    if resolved_path.is_dir() {
        return Inspected {
            path: resolved,
            kind: CommandType::Folder,
            url: None,
            label,
        };
    }

    let resolved_ext = extension_of(&resolved);
    if URL_FILE_EXTENSIONS.contains(&resolved_ext.as_str()) {
        if let Some(url) = read_url_file(resolved_path) {
            return Inspected {
                path: resolved,
                kind: CommandType::Url,
                url: Some(url),
                label,
            };
        }
    }

    // An extensionless target is a program often enough (and never a document) to be launched as
    // one.
    if resolved_ext.is_empty() || APP_EXTENSIONS.contains(&resolved_ext.as_str()) {
        return app(label);
    }

    Inspected {
        path: resolved,
        kind: CommandType::File,
        url: None,
        label,
    }
}

/// A dropped entry as the shortcut it becomes, or `None` where there is nothing to make one from.
///
/// `build` is how the caller turns the three answers into an item, because the rules for that live
/// in `ui::workspace` and this module has no business knowing them — the id, the icon source,
/// whether an editor arrives with its recents already on, and what to call a shortcut that was not
/// given a name. A `None` label means exactly that last one: only a dropped PATH carries a name of
/// its own, and an address or a command line is named by the same `default_label` that names one
/// typed into the Add form.
pub fn to_item(
    entry: &Entry,
    resolve_link: impl Fn(&Path) -> Option<String>,
    build: impl Fn(Option<String>, String, CommandType) -> AppItem,
) -> Option<AppItem> {
    match entry {
        Entry::Url(url) => Some(build(None, url.clone(), CommandType::Url)),
        Entry::Command(line) => Some(build(None, line.clone(), CommandType::Command)),
        Entry::Path(path) => {
            let found = inspect(path, resolve_link)?;
            let label = Some(found.label).filter(|label| !label.is_empty());
            // A `.url` file becomes the address inside it, not the file: a web shortcut can be
            // given a favicon and a page title, and a `.url` on disk can be given neither.
            let command = found.url.unwrap_or(found.path);
            Some(build(label, command, found.kind))
        }
    }
}

/// What a `.lnk` points at, as the production `resolve_link` for `inspect`.
///
/// Separate from the rules above, and passed in rather than called by them, because this is the
/// one part that needs COM and a real file: every rule in this module stays testable without
/// either. `SLGP_RAWPATH` keeps `%ProgramFiles%` as written instead of expanding it against this
/// process — a shortcut written on a 64-bit install and read from a 32-bit one resolves to a
/// different folder, and the raw text is what the vendor meant.
///
/// `Resolve` is deliberately not called. It is allowed to hit the network for a moved target and
/// can put up a dialog of its own, and a drag-and-drop must not stall on either.
pub fn resolve_shortcut(link: &Path) -> Option<String> {
    use windows::core::{Interface, HSTRING, PWSTR};
    use windows::Win32::System::Com::{
        CoCreateInstance, IPersistFile, CLSCTX_INPROC_SERVER, STGM_READ,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink, SLGP_RAWPATH};

    unsafe {
        let shell: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let file: IPersistFile = shell.cast().ok()?;
        file.Load(&HSTRING::from(link.as_os_str()), STGM_READ).ok()?;

        let mut buffer = [0u16; 1024];
        shell
            .GetPath(&mut buffer, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32)
            .ok()?;
        let text = PWSTR(buffer.as_mut_ptr()).to_string().ok()?;
        let text = text.trim().to_string();
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_links(_: &Path) -> Option<String> {
        None
    }

    #[test]
    fn a_path_is_told_from_an_address_and_from_a_command() {
        assert!(looks_like_a_windows_path(r"C:\Users\Me\notes.txt"));
        assert!(looks_like_a_windows_path(r"\\server\share\x"));
        assert!(looks_like_a_windows_path(r"%APPDATA%\Rovyl"));
        assert!(looks_like_a_windows_path("\"C:/Program Files/x\""));
        // A slash alone proves nothing: this is the test that keeps a URL out.
        assert!(!looks_like_a_windows_path("example.com/path"));

        assert!(looks_like_a_web_address("https://example.com"));
        assert!(looks_like_a_web_address("example.com"));
        assert!(looks_like_a_web_address("localhost:3000"));
        assert!(looks_like_a_web_address("sub.example.co.uk/a?b=c"));
        // The whole point of the dot-and-no-whitespace rule.
        assert!(!looks_like_a_web_address("npm run dev"));
        assert!(!looks_like_a_web_address("git status"));
        assert!(!looks_like_a_web_address(r"C:\x\y"));

        assert!(is_a_non_web_scheme("steam://run/730"));
        assert!(is_a_non_web_scheme("mailto:someone@example.com"));
        assert!(is_a_non_web_scheme("ms-settings:display"));
        assert!(!is_a_non_web_scheme("https://example.com"));
        assert!(!is_a_non_web_scheme("C:\\x"));
    }

    #[test]
    fn a_dropped_line_lands_on_the_kind_it_looks_like() {
        assert_eq!(
            classify_text(r"C:\Tools\app.exe"),
            Some(Entry::Path(r"C:\Tools\app.exe".into()))
        );
        assert_eq!(
            classify_text("https://example.com"),
            Some(Entry::Url("https://example.com".into()))
        );
        assert_eq!(
            classify_text("npm run dev"),
            Some(Entry::Command("npm run dev".into()))
        );
        assert_eq!(classify_text("   "), None);
    }

    #[test]
    fn a_file_uri_comes_back_as_the_path_it_names() {
        assert_eq!(
            file_uri_to_windows_path("file:///C:/Users/me/My%20Notes.txt").as_deref(),
            Some(r"C:\Users\me\My Notes.txt")
        );
        assert_eq!(
            file_uri_to_windows_path("file://server/share/x").as_deref(),
            Some(r"\\server\share\x")
        );
        assert_eq!(file_uri_to_windows_path("https://example.com"), None);
    }

    #[test]
    fn files_win_over_a_link_which_wins_over_text() {
        // A link dragged out of a browser carries its own title as text. Reading both would put
        // the same site on the wheel twice, which is the reason for the order.
        let payload = Payload {
            paths: vec![],
            uri_list: "https://example.com".into(),
            text: "Example Domain".into(),
        };
        assert_eq!(
            entries_from(&payload),
            vec![Entry::Url("https://example.com".into())]
        );

        let payload = Payload {
            paths: vec![r"C:\a.exe".into()],
            uri_list: "https://example.com".into(),
            text: "whatever".into(),
        };
        assert_eq!(entries_from(&payload), vec![Entry::Path(r"C:\a.exe".into())]);
    }

    #[test]
    fn the_same_thing_dropped_twice_is_one_shortcut() {
        let payload = Payload {
            paths: vec![r"C:\a.exe".into(), r"c:\A.EXE".into(), r"C:\b.exe".into()],
            ..Payload::default()
        };
        assert_eq!(
            entries_from(&payload),
            vec![
                Entry::Path(r"C:\a.exe".into()),
                Entry::Path(r"C:\b.exe".into())
            ]
        );
    }

    #[test]
    fn several_lines_of_text_are_several_shortcuts() {
        let payload = Payload {
            text: "https://one.com\nhttps://two.com\n\nnpm run dev".into(),
            ..Payload::default()
        };
        assert_eq!(
            entries_from(&payload),
            vec![
                Entry::Url("https://one.com".into()),
                Entry::Url("https://two.com".into()),
                Entry::Command("npm run dev".into()),
            ]
        );
    }

    #[test]
    fn a_name_loses_its_extension_and_a_folder_keeps_its_leaf() {
        assert_eq!(label_from_path(r"C:\x\Quarterly report.xlsx"), "Quarterly report");
        assert_eq!(label_from_path(r"D:\Projects\"), "Projects");
        assert_eq!(label_from_path(r"C:\x\.gitignore"), ".gitignore");
        assert_eq!(label_from_path(""), "");
    }

    #[test]
    fn an_extension_decides_a_program_from_a_document() {
        let app = inspect(r"C:\nope\tool.exe", no_links).unwrap();
        assert_eq!(app.kind, CommandType::App);
        assert_eq!(app.label, "tool");

        let file = inspect(r"C:\nope\report.pdf", no_links).unwrap();
        assert_eq!(file.kind, CommandType::File);

        // Nothing on disk and no extension: `file` is the safer of the two guesses.
        let bare = inspect(r"C:\nope\thing", no_links).unwrap();
        assert_eq!(bare.kind, CommandType::File);

        assert_eq!(inspect("  ", no_links), None);
    }

    #[test]
    fn a_shortcut_is_judged_by_what_it_points_at_but_keeps_its_own_path() {
        // A program: the `.lnk` is kept, because it carries the arguments and the working
        // directory the vendor chose. This is the rule the Start menu picker already follows.
        let to_exe = inspect(r"C:\x\Thing.lnk", |_| Some(r"C:\Program Files\thing.exe".into()))
            .unwrap();
        assert_eq!(to_exe.kind, CommandType::App);
        assert_eq!(to_exe.path, r"C:\x\Thing.lnk");
        assert_eq!(to_exe.label, "Thing");

        // A document: the resolved path is kept, because a `.lnk` in the Target box says nothing.
        let to_doc = inspect(r"C:\x\Notes.lnk", |_| Some(r"C:\docs\notes.pdf".into())).unwrap();
        assert_eq!(to_doc.kind, CommandType::File);
        assert_eq!(to_doc.path, r"C:\docs\notes.pdf");

        // Unreadable, and still launchable.
        let broken = inspect(r"C:\x\Thing.lnk", no_links).unwrap();
        assert_eq!(broken.kind, CommandType::App);
        assert_eq!(broken.path, r"C:\x\Thing.lnk");
    }

    #[test]
    fn a_url_file_becomes_the_address_inside_it() {
        let dir = std::env::temp_dir().join(format!("rovyl-drop-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("Example site.url");
        std::fs::write(&file, "[InternetShortcut]\r\nURL=https://example.com\r\n").unwrap();

        let found = inspect(file.to_str().unwrap(), no_links).unwrap();
        assert_eq!(found.kind, CommandType::Url);
        assert_eq!(found.url.as_deref(), Some("https://example.com"));
        assert_eq!(found.label, "Example site");

        // One with no address left in it is still a file Windows knows how to open.
        let empty = dir.join("Empty.url");
        std::fs::write(&empty, "[InternetShortcut]\r\n").unwrap();
        assert_eq!(
            inspect(empty.to_str().unwrap(), no_links).unwrap().kind,
            CommandType::File
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
