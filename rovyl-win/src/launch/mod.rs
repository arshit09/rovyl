//! Running what the wheel confirmed.
//!
//! One entry point, [`run`], and one path through it per command type. That is deliberate: the
//! original's comment on it says one launch path means one place where a failure is reported, and
//! the corner docks, the keyboard and the ring all come through here for exactly that reason.
//!
//! **The ladder.** For `App` — the only type whose target cannot be classified from the string
//! alone — several methods are tried in order until one starts something. The order is not
//! arbitrary; each arrangement below exists because the obvious one failed on a real machine, and
//! the reasons are recorded at each branch.
//!
//! **Why `ShellExecuteExW` and not a spawned shell.** The original reached the shell through
//! `cmd /c start ""`, and documented the consequence: handed an id the shell cannot resolve, that
//! raises a MODAL "Windows cannot find…" dialog owned by the calling window, the call never
//! returns, and the ladder hangs behind it until someone presses OK. It worked around this by
//! spawning `explorer.exe` instead. `ShellExecuteExW` with `SEE_MASK_FLAG_NO_UI` is the native
//! answer to the same problem: it returns a code, shows nothing, and spawns no helper process.

pub mod parse;

use crate::config::{AppItem, CommandShell, CommandType, CommandWindow, LaunchMode};
use std::path::Path;
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Shell::{
    ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS,
    SHELLEXECUTEINFOW,
};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

/// Which rung started the target, for the log and for the failure card.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    /// The shell opened a URL, a folder or a document.
    ShellOpen,
    /// A Start-menu entry, activated through its `shell:AppsFolder` moniker.
    AppsFolder,
    /// An executable started directly, with its arguments, and no console.
    Spawn,
    /// A shell line run in a terminal — the user's own `command` type, and the last rung of the
    /// app ladder.
    Terminal,
}

impl Method {
    pub fn name(self) -> &'static str {
        match self {
            Method::ShellOpen => "shell-open",
            Method::AppsFolder => "apps-folder",
            Method::Spawn => "spawn",
            Method::Terminal => "terminal",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Outcome {
    pub method: Option<Method>,
    /// `None` on success. Never a panic and never a throw: the caller wants to know IF it started,
    /// and an error would force every launch site to carry its own handler.
    pub error: Option<String>,
    /// Whether the target was an absolute path that is not on disk. `None` means no opinion —
    /// honest rather than convenient, because a UNC path cannot be probed cheaply and claiming it
    /// is missing is worse than saying nothing.
    pub exists: Option<bool>,
}

impl Outcome {
    fn ok(method: Method) -> Self {
        Self {
            method: Some(method),
            error: None,
            exists: None,
        }
    }

    fn failed(error: impl Into<String>, exists: Option<bool>) -> Self {
        Self {
            method: None,
            error: Some(error.into()),
            exists,
        }
    }

    pub fn succeeded(&self) -> bool {
        self.error.is_none()
    }

    /// A failure built by hand, for the tests that turn one into a card.
    #[cfg(test)]
    pub fn for_test(error: &str, exists: Option<bool>) -> Self {
        Self::failed(error, exists)
    }

    /// The failure the card probe draws: a target that is simply not there, which is the most
    /// common one by a distance and the only one with a real answer.
    pub fn probe_failure() -> Self {
        Self::failed(
            "CreateProcessW failed: 0x80070002 (the system cannot find the file specified)",
            Some(false),
        )
    }
}

/// Run an item. Never fails: a failure is an `Outcome` with an error in it.
pub fn run(item: &AppItem) -> Outcome {
    let command = item.command.trim();
    if command.is_empty() {
        return Outcome::failed("This shortcut has no target.", None);
    }

    let outcome = match item.resolved_command_type() {
        CommandType::Url => run_url(command),
        CommandType::Folder => run_folder(item, command),
        CommandType::File => run_file(command),
        CommandType::Command => run_command_line(item, command),
        CommandType::App => run_app(item, command),
    };

    match &outcome.error {
        None => crate::config::store::log_line(&format!(
            "launched [{}] {}",
            outcome.method.map(Method::name).unwrap_or("?"),
            command
        )),
        Some(error) => crate::config::store::log_line(&format!("launch failed: {command} -- {error}")),
    }
    outcome
}

/// Whether to refuse before touching the shell, because the target is plainly gone.
///
/// Only an opinion about a drive-letter path. A UNC target stays `None` rather than claiming the
/// file is there: a disk that does not answer is not a broken shortcut, and the caller's failure
/// card reads this to tell "the file moved" apart from "nothing opens this kind of file".
fn missing_target(command: &str) -> Option<Outcome> {
    let target = parse::unquote(command);
    if !parse::is_absolute_target(target) || target.starts_with("\\\\") {
        return None;
    }
    let path = Path::new(target);
    if path.exists() {
        return None;
    }
    Some(Outcome::failed(
        format!("{} is no longer there.", shown(target)),
        Some(false),
    ))
}

fn shown(target: &str) -> String {
    if target.chars().count() > 50 {
        let head: String = target.chars().take(50).collect();
        format!("\"{head}...\"")
    } else {
        format!("\"{target}\"")
    }
}

// ─── The simple types ───────────────────────────────────────────────────────

fn run_url(command: &str) -> Outcome {
    match shell_open(command, None) {
        Ok(()) => Outcome::ok(Method::ShellOpen),
        Err(error) => Outcome::failed(error, None),
    }
}

fn run_folder(item: &AppItem, command: &str) -> Outcome {
    if let Some(gone) = missing_target(command) {
        return gone;
    }
    let wants_terminal = item.open_terminal.unwrap_or(false)
        || item
            .terminal_commands
            .as_ref()
            .is_some_and(|c| c.iter().any(|line| !line.trim().is_empty()));
    if wants_terminal {
        if let Ok(()) = run_terminal(item, command) {
            return Outcome::ok(Method::Terminal);
        }
        // A terminal that would not start is not a reason to leave the folder unopened.
    }
    match shell_open(parse::unquote(command), None) {
        Ok(()) => Outcome::ok(Method::ShellOpen),
        Err(error) => Outcome::failed(error, None),
    }
}

/// A document, opened the way a double-click in Explorer opens it.
///
/// The shell and nothing else: it asks Windows which program owns the extension, which is the
/// entire point of the type. The app ladder is NOT a fallback here — its last rung wraps the line
/// in a terminal, so a `.pdf` down that route opens a console window, and a `.ps1` or `.bat` the
/// user only meant to OPEN would be RUN. A file shortcut must never become an execution, so this
/// branch answers with its own failure instead of falling through.
fn run_file(command: &str) -> Outcome {
    if let Some(gone) = missing_target(command) {
        return gone;
    }
    let target = parse::unquote(command);
    match shell_open(target, None) {
        Ok(()) => Outcome::ok(Method::ShellOpen),
        Err(error) => {
            let exists = if parse::is_absolute_target(target) && !target.starts_with("\\\\") {
                Some(Path::new(target).exists())
            } else {
                None
            };
            Outcome::failed(
                format!("Failed to open {}. {error}", shown(target)),
                exists,
            )
        }
    }
}

/// The user's own shell line.
fn run_command_line(item: &AppItem, command: &str) -> Outcome {
    let shell = item.command_shell.unwrap_or(CommandShell::Powershell);
    // Unset means PowerShell in a window that STAYS OPEN, so the output of a typo can still be
    // read. A command the user wrote is the one case where a console window is the feature.
    let hidden = matches!(item.command_window, Some(CommandWindow::Hidden));
    let cwd = parse::terminal_working_dir(command, item.working_directory.as_deref());
    match spawn_shell(shell, command, hidden, cwd.as_deref(), !hidden) {
        Ok(()) => Outcome::ok(Method::Terminal),
        Err(error) => Outcome::failed(error, None),
    }
}

// ─── The app ladder ─────────────────────────────────────────────────────────

fn run_app(item: &AppItem, command: &str) -> Outcome {
    if matches!(item.launch_mode, Some(LaunchMode::Prewarm)) {
        // Warm the file in the Windows cache and open nothing. A read of the first page is enough
        // to pull the image into the standby list, which is the whole of what the mode promises.
        prewarm(command);
        return Outcome::ok(Method::Spawn);
    }

    let mut target = command.to_string();

    // IDE mapping: an AUMID cannot carry an argument, so an id paired with a drive path is
    // rewritten to the command-line tool of the same name. Opening a recent project needs a real
    // executable and an argument, and these are the two installers that ship an id instead.
    let lower = target.to_ascii_lowercase();
    let carries_path = lower.contains(":\\") || lower.contains(":/");
    if carries_path {
        if lower.contains("google.antigravity") {
            target = replace_ignore_case(&target, "google.antigravity", "antigravity");
        } else if lower.contains("cursor") && target.contains('!') {
            if let Some(at) = target.find(' ') {
                target = format!("cursor {}", target[at..].trim());
            }
        }
    }

    let explicit_moniker = parse::apps_folder_id(&target).map(str::to_string);
    let bare_id = parse::looks_like_bare_app_id(&target).then(|| target.clone());
    let app_id = explicit_moniker.clone().or(bare_id);
    // An id carrying a drive path is a command line, not an identifier: AppsFolder activation has
    // nowhere to put an argument.
    let id_carries_path = app_id
        .as_deref()
        .is_some_and(|id| id.contains(":\\") || id.contains(":/"));
    let is_ide = ["antigravity", "cursor", "code"]
        .iter()
        .any(|name| lower.contains(name));

    // A Start-menu entry, launched the way the Start menu launches it.
    //
    // `explicit_moniker` is provenance: the picker wrote it, so there is nothing to infer. A bare
    // id is the same entry stored before the picker started writing monikers, recognised by shape —
    // which is what makes shortcuts already sitting in a workspace start working, with no
    // migration and no rewrite of anyone's config.
    //
    // IDEs are left to the branch below when the id is BARE, because opening a recent project
    // needs an argument.
    if let Some(id) = app_id.filter(|_| !id_carries_path && (explicit_moniker.is_some() || !is_ide))
    {
        let moniker = parse::to_apps_folder(&id);
        match shell_open(&moniker, None) {
            Ok(()) => {
                after_launch(item, &target);
                return Outcome::ok(Method::AppsFolder);
            }
            Err(error) => {
                return Outcome::failed(
                    format!("Windows could not start \"{id}\". {error}"),
                    None,
                );
            }
        }
    }

    if let Some(gone) = missing_target(&target) {
        return gone;
    }

    // The ladder proper. Each ordering below is the one that worked on a real machine for the shape
    // it covers; the comments say what the other orderings did wrong.
    let ladder: &[Method] = if is_ide && target.contains(' ') {
        // An IDE with an argument: spawn it directly, with no console at all. Going through the
        // shell flashes a window, and through a terminal leaves one open behind the editor.
        &[Method::Spawn, Method::ShellOpen, Method::Terminal]
    } else if parse::is_shell_app(&target) {
        // An identifier: the shell is the only thing that can resolve it.
        &[Method::AppsFolder, Method::ShellOpen, Method::Terminal]
    } else {
        // A path or an alias. The shell first, because it handles both — and a terminal last,
        // because its console window is a visible cost that only pays off when nothing else worked.
        &[Method::ShellOpen, Method::Spawn, Method::Terminal]
    };

    let mut last_error = String::new();
    for method in ladder {
        let attempt = match method {
            Method::ShellOpen => {
                let (exe, args) = parse::split_exe_and_args(&target);
                let argument = (!args.is_empty()).then(|| {
                    args.iter()
                        .map(|a| parse::quote_if_needed(a))
                        .collect::<Vec<_>>()
                        .join(" ")
                });
                shell_open(&exe, argument.as_deref())
            }
            Method::AppsFolder => shell_open(&parse::to_apps_folder(&target), None),
            Method::Spawn => spawn_direct(&target),
            Method::Terminal => spawn_shell(
                CommandShell::Cmd,
                &target,
                true,
                parse::terminal_working_dir(&target, item.working_directory.as_deref()).as_deref(),
                false,
            ),
        };
        match attempt {
            Ok(()) => {
                after_launch(item, &target);
                return Outcome::ok(*method);
            }
            Err(error) => last_error = error,
        }
    }

    Outcome::failed(
        format!("Failed to run {}. {last_error}", shown(&target)),
        None,
    )
}

/// The terminal and the automatic commands an item may also ask for.
fn after_launch(item: &AppItem, command: &str) {
    let has_commands = item
        .terminal_commands
        .as_ref()
        .is_some_and(|c| c.iter().any(|line| !line.trim().is_empty()));
    if item.open_terminal.unwrap_or(false) || has_commands {
        let _ = run_terminal(item, command);
    }
}

fn run_terminal(item: &AppItem, command: &str) -> Result<(), String> {
    let cwd = parse::terminal_working_dir(command, item.working_directory.as_deref());
    let lines: Vec<String> = item
        .terminal_commands
        .clone()
        .unwrap_or_default()
        .into_iter()
        .filter(|line| !line.trim().is_empty())
        .collect();
    if lines.is_empty() {
        // A bare terminal in the right directory, which is what "open terminal" alone means.
        return spawn_shell(CommandShell::Powershell, "", false, cwd.as_deref(), true);
    }
    // Chained with `;` so a failing line does not silently skip the rest: PowerShell's `&&` is
    // only available in 7+, and the shell here may be the one Windows ships.
    let joined = lines.join("; ");
    spawn_shell(CommandShell::Powershell, &joined, false, cwd.as_deref(), true)
}

/// Pull an executable into the Windows cache without starting it.
fn prewarm(command: &str) {
    let (exe, _) = parse::split_exe_and_args(command);
    let target = parse::unquote(&exe).to_string();
    // On a worker: this reads from disk, and the frame loop must never block.
    std::thread::spawn(move || {
        use std::io::Read;
        if let Ok(mut file) = std::fs::File::open(&target) {
            // The first 64 KiB is enough to fault in the headers and the first pages, which is what
            // the cold-start cost actually is. Reading the whole image would evict more than it
            // warms on a machine under memory pressure.
            let mut buffer = [0u8; 64 * 1024];
            let _ = file.read(&mut buffer);
        }
    });
}

fn replace_ignore_case(haystack: &str, needle: &str, with: &str) -> String {
    let lower = haystack.to_ascii_lowercase();
    match lower.find(&needle.to_ascii_lowercase()) {
        Some(at) => format!("{}{}{}", &haystack[..at], with, &haystack[at + needle.len()..]),
        None => haystack.to_string(),
    }
}

// ─── The shell and the process ──────────────────────────────────────────────

/// `ShellExecuteExW` with the verb the shell picks itself.
///
/// `SEE_MASK_FLAG_NO_UI` is the flag that matters: without it an unresolvable target raises a modal
/// dialog owned by this process, and the ladder stops dead behind it. `SEE_MASK_NOASYNC` makes the
/// call complete before returning, which it must — the process may be about to go idle, and an
/// asynchronous shell execute can be cancelled when its caller stops pumping.
fn shell_open(target: &str, arguments: Option<&str>) -> Result<(), String> {
    let file = HSTRING::from(target);
    let args = arguments.map(HSTRING::from);
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_FLAG_NO_UI | SEE_MASK_NOASYNC | SEE_MASK_NOCLOSEPROCESS,
        hwnd: HWND::default(),
        lpVerb: PCWSTR::null(),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: args
            .as_ref()
            .map(|a| PCWSTR(a.as_ptr()))
            .unwrap_or(PCWSTR::null()),
        lpDirectory: PCWSTR::null(),
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };
    unsafe {
        match ShellExecuteExW(&mut info) {
            Ok(()) => {
                if !info.hProcess.is_invalid() {
                    // The handle is only taken so the call can report a real failure; the child is
                    // not waited on. Leaking it would hold the process object alive after the app
                    // it names has exited.
                    let _ = windows::Win32::Foundation::CloseHandle(info.hProcess);
                }
                Ok(())
            }
            Err(error) => Err(describe(error.code().0)),
        }
    }
}

/// `CreateProcessW`, with no console and no inherited handles.
fn spawn_direct(command: &str) -> Result<(), String> {
    use windows::Win32::System::Threading::{
        CreateProcessW, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, DETACHED_PROCESS,
        PROCESS_INFORMATION, STARTUPINFOW,
    };

    let (exe, _) = parse::split_exe_and_args(command);
    if exe.is_empty() {
        return Err("nothing to run".into());
    }
    // The line is canonicalised so a path with spaces is quoted — `CreateProcessW` parses the
    // command line itself and would otherwise split at the first space, which is the exact failure
    // `parse` exists to prevent.
    let line = parse::canonicalize(command);
    let mut wide: Vec<u16> = line.encode_utf16().chain(std::iter::once(0)).collect();

    let cwd = Path::new(parse::unquote(&exe))
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| HSTRING::from(p.as_os_str()));

    let startup = STARTUPINFOW {
        cb: std::mem::size_of::<STARTUPINFOW>() as u32,
        ..Default::default()
    };
    let mut info = PROCESS_INFORMATION::default();
    unsafe {
        CreateProcessW(
            PCWSTR::null(),
            windows::core::PWSTR(wide.as_mut_ptr()),
            None,
            None,
            // No inherited handles. This process holds a low-level hook and a composition device;
            // handing either to a launched application is a lifetime nobody is tracking.
            false,
            // Detached and in its own process group, so the launched app does not die with Rovyl
            // and does not receive the console signals Rovyl would.
            DETACHED_PROCESS | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP,
            None,
            cwd.as_ref()
                .map(|c| PCWSTR(c.as_ptr()))
                .unwrap_or(PCWSTR::null()),
            &startup,
            &mut info,
        )
        .map_err(|e| describe(e.code().0))?;
        // Both handles are closed at once: the child is detached and nothing here waits on it.
        let _ = windows::Win32::Foundation::CloseHandle(info.hThread);
        let _ = windows::Win32::Foundation::CloseHandle(info.hProcess);
    }
    Ok(())
}

/// A shell line, in a console that either stays open or never appears.
fn spawn_shell(
    shell: CommandShell,
    line: &str,
    hidden: bool,
    cwd: Option<&str>,
    keep_open: bool,
) -> Result<(), String> {
    use windows::Win32::System::Threading::{
        CreateProcessW, CREATE_NEW_CONSOLE, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW,
        PROCESS_INFORMATION, STARTUPINFOW,
    };

    let command = match (shell, line.trim().is_empty()) {
        (CommandShell::Powershell, true) => "powershell.exe -NoLogo -NoExit".to_string(),
        (CommandShell::Powershell, false) => format!(
            "powershell.exe -NoLogo {} -Command {}",
            if keep_open { "-NoExit" } else { "" },
            quote_for_shell(line)
        ),
        (CommandShell::Cmd, true) => "cmd.exe".to_string(),
        (CommandShell::Cmd, false) => format!(
            "cmd.exe {} {}",
            if keep_open { "/k" } else { "/c" },
            line
        ),
    };
    let mut wide: Vec<u16> = command.encode_utf16().chain(std::iter::once(0)).collect();
    let dir = cwd
        .map(str::trim)
        .filter(|d| !d.is_empty() && Path::new(d).is_dir())
        .map(HSTRING::from);

    let startup = STARTUPINFOW {
        cb: std::mem::size_of::<STARTUPINFOW>() as u32,
        ..Default::default()
    };
    let mut info = PROCESS_INFORMATION::default();
    unsafe {
        CreateProcessW(
            PCWSTR::null(),
            windows::core::PWSTR(wide.as_mut_ptr()),
            None,
            None,
            false,
            if hidden {
                CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
            } else {
                // Its OWN console. Without this the child would try to attach to Rovyl's, and
                // Rovyl is a GUI process with none — which on some shells exits before running a
                // line.
                CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP
            },
            None,
            dir.as_ref()
                .map(|d| PCWSTR(d.as_ptr()))
                .unwrap_or(PCWSTR::null()),
            &startup,
            &mut info,
        )
        .map_err(|e| describe(e.code().0))?;
        let _ = windows::Win32::Foundation::CloseHandle(info.hThread);
        let _ = windows::Win32::Foundation::CloseHandle(info.hProcess);
    }
    Ok(())
}

/// Quote a line for PowerShell's `-Command`.
///
/// Single quotes, with internal ones doubled: PowerShell does not expand anything inside them, so
/// a user's `$env:PATH` or backtick survives as written. Double quotes would interpolate it.
fn quote_for_shell(line: &str) -> String {
    format!("'{}'", line.replace('\'', "''"))
}

/// A Windows error code as something a person can act on.
///
/// The codes below are the ones that actually come back from a launcher's shell calls, and the
/// wording is the user's rather than the API's: "the file was moved or uninstalled" is a sentence
/// somebody can do something about, where `ERROR_FILE_NOT_FOUND` is not.
fn describe(code: i32) -> String {
    let win32 = (code & 0xFFFF) as u32;
    match win32 {
        2 => "Windows could not find it — the file was moved or uninstalled.".into(),
        3 => "The folder in its path no longer exists.".into(),
        5 => "Windows refused access to it.".into(),
        8 | 14 => "Windows did not have enough memory to start it.".into(),
        32 => "Another program is holding the file open.".into(),
        1155 => "No program is associated with this kind of file.".into(),
        1223 => "The request was cancelled.".into(),
        0 => "Unknown error.".into(),
        other => format!("Windows error {other}."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{AppItem, ItemKind};

    fn item(command: &str, kind: CommandType) -> AppItem {
        AppItem {
            id: "t".into(),
            kind: Some(ItemKind::App),
            label: "Test".into(),
            command: command.into(),
            command_type: Some(kind),
            ..AppItem::default()
        }
    }

    #[test]
    fn an_empty_target_is_refused_rather_than_handed_to_the_shell() {
        let outcome = run(&item("   ", CommandType::App));
        assert!(!outcome.succeeded());
        assert!(outcome.error.unwrap().contains("no target"));
    }

    #[test]
    fn a_missing_absolute_path_fails_before_the_shell() {
        // Reaching the shell would raise its own dialog; the point is to answer first.
        let outcome = run(&item("C:\\definitely\\not\\here.exe", CommandType::File));
        assert!(!outcome.succeeded());
        assert_eq!(outcome.exists, Some(false));
    }

    #[test]
    fn a_unc_path_gets_no_opinion() {
        // A disk that does not answer is not a broken shortcut.
        assert!(missing_target("\\\\server\\share\\app.exe").is_none());
    }

    #[test]
    fn a_relative_or_alias_target_is_never_pre_judged() {
        for command in ["notepad", "calc", "com.squirrel.Figma.Figma"] {
            assert!(missing_target(command).is_none(), "{command}");
        }
    }

    #[test]
    fn powershell_quoting_survives_a_dollar_sign() {
        // Double quotes would interpolate it, and the user wrote it to be literal.
        assert_eq!(quote_for_shell("echo $env:PATH"), "'echo $env:PATH'");
        assert_eq!(quote_for_shell("it's"), "'it''s'");
    }

    #[test]
    fn error_codes_become_sentences() {
        assert!(describe(2).contains("moved or uninstalled"));
        assert!(describe(1155).contains("No program is associated"));
        // An unmapped code still says something specific rather than "failed".
        assert!(describe(9999).contains("9999"));
    }

    #[test]
    fn the_ide_aumid_is_rewritten_only_when_it_carries_a_path() {
        // An AUMID cannot carry an argument, so the one paired with a project path becomes the CLI.
        assert_eq!(
            replace_ignore_case("Google.Antigravity D:\\Work", "google.antigravity", "antigravity"),
            "antigravity D:\\Work"
        );
        // And the bare id is left alone, because AppsFolder activation handles it.
        assert!(parse::looks_like_bare_app_id("Google.Antigravity"));
    }

    #[test]
    fn method_names_are_stable() {
        // They go in the log and in the failure card; renaming one silently breaks a bug report.
        assert_eq!(Method::ShellOpen.name(), "shell-open");
        assert_eq!(Method::AppsFolder.name(), "apps-folder");
        assert_eq!(Method::Spawn.name(), "spawn");
        assert_eq!(Method::Terminal.name(), "terminal");
    }

    #[test]
    fn a_long_target_is_shortened_for_the_message() {
        let long = "C:\\".to_string() + &"a".repeat(80);
        let text = shown(&long);
        assert!(text.contains("..."));
        assert!(text.chars().count() < 60);
    }
}

/// Open a URL in the user's default browser.
///
/// Separate from `run` because it takes no `AppItem` and must not go anywhere near the app ladder:
/// a URL handed to a terminal is a shell line.
pub fn open_url(url: &str) {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        // The only URLs this is called with are the product's own. Refusing anything else keeps a
        // future caller from turning this into "ask the shell to run an arbitrary string".
        return;
    }
    let _ = shell_open(url, None);
}
