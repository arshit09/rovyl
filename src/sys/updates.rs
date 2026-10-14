//! Is there a newer Rovyl — and if there is, fetch it, check it, and put it in on the next start.
//!
//! The same feed and the same rules as the Electron build's updater, so both builds behave alike:
//!
//! 1. **Check.** `latest.yml`, beside the newest GitHub release, says its version, its installer's
//!    file name, size and SHA-512. An installed copy asks ten seconds after it starts and every six
//!    hours after that; any copy asks when somebody presses the button.
//! 2. **Download.** Straight away, on the same worker, into `%LOCALAPPDATA%\Rovyl\updates`. The
//!    file is hashed against the feed before it counts as downloaded; one that does not match is
//!    deleted, never run.
//! 3. **Note.** `pending-update.json` beside the configuration — the 1.x note, field for field —
//!    records which installer is waiting. It is written as soon as the file is verified rather
//!    than on exit, because a crash, a reboot and a kill from Task Manager are exits too.
//! 4. **Install.** "Restart now" in Settings or the tray hands the installer the machine at once.
//!    Otherwise the next launch does it, before any of the app exists — the Electron build learned
//!    that installing in the background of an exit races the user's next click on the icon.
//!
//! The installer is the setup executable's own silent mode (`--updated /S --force-run`), which
//! replaces the installed copy and starts the new one; [`crate::sys::install::take_over`] is all of
//! that. Two goes at the same installer and the launcher stops trying and starts on what it has: a
//! launcher that refuses to launch is worse than one a version behind.
//!
//! **It never runs on a frame.** Everything here that touches the network or the disk belongs to
//! the updater's own thread, which sleeps on a condition between checks and costs nothing there.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// Where the Electron build publishes, so both builds see the same releases.
const OWNER: &str = "arshit09";
const REPO: &str = "rovyl";

/// How long after starting an installed copy asks for the first time — long enough for the launch
/// itself to have finished, which is what the 1.x updater waited for too.
const FIRST_CHECK: Duration = Duration::from_secs(10);

/// The app lives in the tray for days: checking only once at startup is not enough.
const RECHECK: Duration = Duration::from_secs(6 * 60 * 60);

/// The largest installer this will download. The real one is under 4 MB; this is only a bound on
/// a feed that points somewhere strange.
const MAX_INSTALLER_BYTES: u64 = 64 * 1024 * 1024;

/// Two goes at the same installer, then the app starts on whatever is on disk.
const MAX_ATTEMPTS: u32 = 2;

/// The note's file name, which the 1.x build used and the silent setup already reads.
const NOTE_FILE: &str = "pending-update.json";

// ── The feed ────────────────────────────────────────────────────────────────

/// What `latest.yml` says about the newest release.
#[derive(Debug, Clone, PartialEq)]
pub struct Feed {
    /// The version, with any leading `v` taken off.
    pub version: String,
    /// The installer's file name in the release.
    pub file: String,
    /// The installer's SHA-512, decoded from the feed's base64.
    pub sha512: Vec<u8>,
    /// The installer's size in bytes, when the feed gives one.
    pub size: Option<u64>,
}

/// Ask the feed. `None` if it could not be reached or did not make sense.
///
/// Call from a WORKER. It is somebody else's TLS handshake.
pub fn latest() -> Option<Feed> {
    let url = format!("https://github.com/{OWNER}/{REPO}/releases/latest/download/latest.yml");
    let body = super::web::fetch_file(&url)?;
    parse_feed(std::str::from_utf8(&body).ok()?)
}

/// Read the handful of fields that matter out of electron-builder's `latest.yml`.
///
/// Not a YAML parser, because the file is not free-form: it is written by `scripts/release.ps1`
/// (and before that by electron-builder) in one fixed shape, and every field this needs is a
/// `key: value` on a line of its own. The top-level `path` and `sha512` are the installer's; `size`
/// only appears under `files`.
fn parse_feed(text: &str) -> Option<Feed> {
    let mut version = None;
    let mut file = None;
    let mut sha512 = None;
    let mut size = None;
    for line in text.lines() {
        let top_level = !line.starts_with([' ', '\t', '-']);
        let entry = line.trim().trim_start_matches("- ");
        let Some((key, value)) = entry.split_once(':') else {
            continue;
        };
        let value = value.trim().trim_matches(['\'', '"']);
        match (top_level, key.trim()) {
            (true, "version") => version = Some(value.trim_start_matches(['v', 'V']).to_string()),
            (true, "path") => file = Some(value.to_string()),
            (true, "sha512") => sha512 = base64_decode(value),
            (false, "size") if size.is_none() => size = value.parse().ok(),
            _ => {}
        }
    }
    let version = version.filter(|v| !v.is_empty())?;
    let file = file.filter(|f| is_safe_file_name(f))?;
    // SHA-512 is 64 bytes. Anything else is a feed this cannot check a download against, and an
    // update that cannot be checked is not one this installs.
    let sha512 = sha512.filter(|digest| digest.len() == 64)?;
    Some(Feed {
        version,
        file,
        sha512,
        size,
    })
}

/// Whether a name from the feed is safe to use as a file name in the updates folder.
///
/// The name ends up in a path on this machine and then in a process launch, so it is held to the
/// shape the release script writes: letters, digits, dots, dashes and underscores, ending `.exe`,
/// with nothing that could climb out of the folder.
fn is_safe_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        && name.to_ascii_lowercase().ends_with(".exe")
}

/// Standard base64, with or without padding. The feed's `sha512` is base64 of the raw digest.
fn base64_decode(text: &str) -> Option<Vec<u8>> {
    fn value(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a') as u32 + 26),
            b'0'..=b'9' => Some((c - b'0') as u32 + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let digits = text.trim().trim_end_matches('=').as_bytes();
    if digits.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(digits.len() * 3 / 4);
    for group in digits.chunks(4) {
        let mut bits = 0u32;
        for (at, c) in group.iter().enumerate() {
            bits |= value(*c)? << (18 - 6 * at);
        }
        let bytes = bits.to_be_bytes();
        out.extend_from_slice(&bytes[1..group.len()]);
    }
    Some(out)
}

/// Whether `candidate` is a later version than `current`.
///
/// Compared component by component as numbers, not as strings: `1.9.0` and `1.10.0` sort the wrong
/// way round as text, and that is the comparison an updater gets to be wrong about exactly once.
/// Anything non-numeric in a component — `1.20.0-beta.1` — makes it a PRE-release of that
/// component, which sorts BEFORE the plain one, as semver says.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    let (candidate_core, candidate_pre) = split_pre(candidate);
    let (current_core, current_pre) = split_pre(current);

    let mut left = candidate_core.split('.');
    let mut right = current_core.split('.');
    for _ in 0..4 {
        let a: u64 = left.next().unwrap_or("0").trim().parse().unwrap_or(0);
        let b: u64 = right.next().unwrap_or("0").trim().parse().unwrap_or(0);
        if a != b {
            return a > b;
        }
    }
    // Same numbers. A release outranks a pre-release of itself; two pre-releases compare as text,
    // which is the best anything can do without a full semver parser and is never load-bearing.
    match (candidate_pre, current_pre) {
        (None, Some(_)) => true,
        (Some(_), None) => false,
        (Some(a), Some(b)) => a > b,
        (None, None) => false,
    }
}

fn split_pre(version: &str) -> (&str, Option<&str>) {
    match version.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (version, None),
    }
}

// ── The download ────────────────────────────────────────────────────────────

/// Where installers are downloaded to.
///
/// Not beside the configuration: `%APPDATA%` roams, and an installer has no business following
/// somebody from machine to machine. A test profile (`ROVYL_USER_DATA`) keeps its downloads to
/// itself, so trying the updater out never touches the real folder.
fn updates_dir() -> PathBuf {
    if std::env::var_os("ROVYL_USER_DATA").is_some() {
        return crate::config::store::user_data_dir().join("updates");
    }
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(crate::config::store::user_data_dir)
        .join("Rovyl")
        .join("updates")
}

/// Download the feed's installer, or find it already downloaded, and check it.
///
/// Downloaded to a `.partial` first and renamed only once the size and hash match, so the one path
/// the note can ever point at is a file that was verified.
fn fetch_installer(feed: &Feed, send: &dyn Fn(Event)) -> Result<PathBuf, String> {
    let dir = updates_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot make {}: {e}", dir.display()))?;
    let target = dir.join(&feed.file);
    if matches_feed(&target, feed) {
        return Ok(target);
    }

    let partial = target.with_extension("partial");
    send(Event::Downloading {
        version: feed.version.clone(),
        percent: None,
    });
    // Whole percentage points only: the network delivers dozens of chunks a second, and every
    // event wakes the UI thread for a number it can only show as an integer.
    let mut shown = None;
    let url = format!(
        "https://github.com/{OWNER}/{REPO}/releases/download/v{}/{}",
        feed.version, feed.file
    );
    let downloaded = super::web::download(&url, &partial, MAX_INSTALLER_BYTES, |done, total| {
        let percent = total
            .or(feed.size)
            .filter(|total| *total > 0)
            .map(|total| (done.saturating_mul(100) / total).min(100) as u8);
        if percent != shown {
            shown = percent;
            send(Event::Downloading {
                version: feed.version.clone(),
                percent,
            });
        }
    });
    if let Err(why) = downloaded {
        let _ = std::fs::remove_file(&partial);
        return Err(why);
    }
    if !matches_feed(&partial, feed) {
        let _ = std::fs::remove_file(&partial);
        return Err("the download does not match the feed's size and SHA-512".into());
    }
    let _ = std::fs::remove_file(&target);
    std::fs::rename(&partial, &target)
        .map_err(|e| format!("cannot move the download into place: {e}"))?;
    Ok(target)
}

/// Whether a file on disk is the installer the feed describes.
fn matches_feed(path: &Path, feed: &Feed) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if feed.size.map(|size| size != meta.len()).unwrap_or(false) {
        return false;
    }
    sha512_of(path)
        .map(|digest| digest[..] == feed.sha512[..])
        .unwrap_or(false)
}

/// SHA-512 of a file, through Windows' own CNG rather than a crate.
fn sha512_of(path: &Path) -> Option<[u8; 64]> {
    use std::io::Read;
    use windows::Win32::Security::Cryptography::{
        BCryptCreateHash, BCryptDestroyHash, BCryptFinishHash, BCryptHashData, BCRYPT_HASH_HANDLE,
        BCRYPT_SHA512_ALG_HANDLE,
    };

    let mut file = std::fs::File::open(path).ok()?;
    let mut digest = [0u8; 64];
    unsafe {
        let mut hash = BCRYPT_HASH_HANDLE::default();
        // The algorithm pseudo-handle, so there is no provider to open and close around this.
        if !BCryptCreateHash(BCRYPT_SHA512_ALG_HANDLE, &mut hash, None, None, 0).is_ok() {
            return None;
        }
        let mut chunk = vec![0u8; 64 * 1024];
        let mut whole = true;
        loop {
            match file.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => {
                    if !BCryptHashData(hash, &chunk[..read], 0).is_ok() {
                        whole = false;
                        break;
                    }
                }
                Err(_) => {
                    whole = false;
                    break;
                }
            }
        }
        let finished = whole && BCryptFinishHash(hash, &mut digest, 0).is_ok();
        let _ = BCryptDestroyHash(hash);
        finished.then_some(digest)
    }
}

/// Delete everything in the updates folder except `keep`.
///
/// What is in there otherwise is spent: the installer of a version that is now running, an older
/// download a newer one superseded, a `.partial` from a session that ended mid-download.
fn purge(keep: Option<&Path>) {
    let Ok(entries) = std::fs::read_dir(updates_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if Some(path.as_path()) != keep && path.is_file() {
            let _ = std::fs::remove_file(&path);
        }
    }
}

// ── The note ────────────────────────────────────────────────────────────────

/// `pending-update.json`: which installer is waiting, and how its installs have gone.
///
/// The Electron build's note, with its field names, so the silent setup's reading of `reopen`
/// works the same whichever build wrote it.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub version: String,
    pub installer_path: String,
    #[serde(default)]
    pub downloaded_at: u64,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default)]
    pub last_attempt_at: u64,
    #[serde(default)]
    pub gave_up: bool,
    /// Where the new version should come back: `window` puts Settings up, `tray` does not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reopen: Option<String>,
}

fn note_path() -> PathBuf {
    crate::config::store::user_data_dir().join(NOTE_FILE)
}

pub fn read_note() -> Option<Note> {
    let text = std::fs::read_to_string(note_path()).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_note(note: &Note) {
    let path = note_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let written = serde_json::to_string(note)
        .ok()
        .map(|text| std::fs::write(&path, text).is_ok())
        .unwrap_or(false);
    if !written {
        crate::config::store::log_line("updates: could not record the pending install");
    }
}

fn clear_note() {
    let _ = std::fs::remove_file(note_path());
}

/// Record a verified installer as the one waiting.
///
/// A note for the SAME installer keeps its attempt count and its give-up flag. Checks find the
/// same release again every six hours, and a counter reset on each of them would hand a broken
/// installer unlimited goes at every start.
fn record(version: &str, installer: &Path) {
    let installer_path = installer.to_string_lossy().into_owned();
    let previous =
        read_note().filter(|n| n.version == version && n.installer_path == installer_path);
    write_note(&Note {
        version: version.to_string(),
        installer_path,
        downloaded_at: now_millis(),
        attempts: previous.as_ref().map(|n| n.attempts).unwrap_or(0),
        last_attempt_at: previous.as_ref().map(|n| n.last_attempt_at).unwrap_or(0),
        gave_up: previous.as_ref().map(|n| n.gave_up).unwrap_or(false),
        reopen: None,
    });
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A verified update waiting on disk for a version later than `current`, if there is one.
///
/// What the panel reads at startup, so a download from an earlier session is offered as ready
/// without being fetched again.
pub fn ready(current: &str) -> Option<Note> {
    read_note()
        .filter(|note| is_newer(&note.version, current) && Path::new(&note.installer_path).exists())
}

// ── Installing ──────────────────────────────────────────────────────────────

/// What a launch should do about the note on disk.
#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    /// Nothing to install. Build the app.
    Start,
    /// The note is spent — this is the version it asked for, or its installer is gone. Delete it.
    Clear,
    /// Hand the machine to the installer and exit; it starts the new version when it is done.
    Install,
    /// The installer has had its goes and has not taken. Flag the note and start anyway.
    GiveUp,
}

/// Decide what a launch does about `note`, without touching anything.
///
/// `installer_exists` and `installer_running` are functions so the process walk only happens on
/// the branch that needs its answer — never on a normal start.
pub fn decide(
    note: Option<&Note>,
    current: &str,
    installer_exists: impl FnOnce() -> bool,
    installer_running: impl FnOnce() -> bool,
) -> Decision {
    let Some(note) = note else {
        return Decision::Start;
    };
    if !is_newer(&note.version, current) {
        // This IS the new version: the install worked, and the note has done its job.
        return Decision::Clear;
    }
    // Flagged as hopeless by an earlier launch. Kept on disk so the flag survives: deleted, the
    // next check would write a fresh note with the counter back at zero.
    if note.gave_up {
        return Decision::Start;
    }
    if !installer_exists() {
        return Decision::Clear;
    }
    if note.attempts >= MAX_ATTEMPTS {
        return Decision::GiveUp;
    }
    // A second click on the icon while the first install is still working. Two installs over one
    // folder is how an install ends up half-applied; if the running one succeeds it starts the new
    // version anyway.
    if installer_running() {
        return Decision::Start;
    }
    Decision::Install
}

/// Run the waiting installer before this launch builds anything, if there is one to run.
///
/// `true` means an installer now has the machine and this process should exit. Only an installed
/// copy acts on the note: a development build shares the configuration folder, and must not start
/// installing releases over the top of the installed one every time it is run.
pub fn install_at_launch(current: &str, from_login: bool) -> bool {
    if !super::install::running_installed() {
        return false;
    }
    let note = read_note();
    let decision = decide(
        note.as_ref(),
        current,
        || {
            note.as_ref()
                .map(|n| Path::new(&n.installer_path).exists())
                .unwrap_or(false)
        },
        || {
            note.as_ref()
                .map(|n| super::migrate::is_running(Path::new(&n.installer_path)))
                .unwrap_or(false)
        },
    );
    let Some(note) = note else {
        return false;
    };
    match decision {
        Decision::Start => false,
        Decision::Clear => {
            clear_note();
            purge(None);
            false
        }
        Decision::GiveUp => {
            crate::config::store::log_line(&format!(
                "updates: {} did not install after {} attempts; starting on {current}",
                note.version, note.attempts
            ));
            write_note(&Note {
                gave_up: true,
                ..note
            });
            false
        }
        // A login start goes back to the tray; a click on the icon was asking for the window.
        Decision::Install => {
            start_installer(note, if from_login { "tray" } else { "window" }).is_ok()
        }
    }
}

/// Start the installer the note names, counting it as an attempt. `Ok` means this process should
/// now exit; the installer waits for it to, then replaces it and starts the new version.
///
/// The attempt is counted BEFORE the spawn, so an installer that dies takes one of its goes with
/// it — which is the whole of what stops a broken one from being retried on every start.
pub fn start_installer(note: Note, reopen: &str) -> Result<(), String> {
    let installer = PathBuf::from(&note.installer_path);
    if !installer.exists() {
        return Err(format!("{} is gone", installer.display()));
    }
    crate::config::store::log_line(&format!(
        "updates: installing {} (reopens into {reopen})",
        note.version
    ));
    write_note(&Note {
        attempts: note.attempts + 1,
        last_attempt_at: now_millis(),
        reopen: Some(reopen.to_string()),
        ..note
    });
    std::process::Command::new(&installer)
        .args(["--updated", "/S", "--force-run", "--wait"])
        .arg(std::process::id().to_string())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("cannot start {}: {e}", installer.display()))
}

/// Wait for the process that started this installer to finish exiting.
///
/// The app spawns the installer and then quits, and the quit still has a configuration to save and
/// a mouse hook to take down. The installer kills whatever is still running out of the install
/// folder, so without this it could end the old app halfway through writing the user's workspaces.
pub fn wait_for(pid: u32) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };
    unsafe {
        if let Ok(process) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
            // Bounded: an app that is not done in fifteen seconds is stuck, and `take_over` is
            // about to end it regardless.
            let _ = WaitForSingleObject(process, 15_000);
            let _ = CloseHandle(process);
        }
    }
}

// ── The updater's thread ────────────────────────────────────────────────────

/// What the updater reports, in the order it happens.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Checking,
    UpToDate,
    /// The feed could not be reached or read.
    Unreachable,
    /// `percent` is `None` until the size is known.
    Downloading {
        version: String,
        percent: Option<u8>,
    },
    /// Downloaded and verified. Only a restart is missing.
    Ready {
        version: String,
    },
    /// Found, but the download failed or did not match the feed.
    Failed {
        version: String,
    },
}

/// One check, carried as far as it goes: the feed, then the download, then the note.
///
/// `true` when an installer is ready, which is the end of the road for the checks: nothing a
/// later one could find would change what the user is offered.
pub fn check(current: &str, send: &dyn Fn(Event)) -> bool {
    send(Event::Checking);
    let Some(feed) = latest() else {
        send(Event::Unreachable);
        return false;
    };
    if !is_newer(&feed.version, current) {
        // Whatever is still in the folder is spent — usually the installer that put this version
        // here, which was still running when the new version started and could not be deleted.
        // Except the one a note is waiting on: a development build newer than the release shares
        // the folder with an installed copy that may still have an update to put in.
        let waiting = read_note().map(|note| PathBuf::from(note.installer_path));
        purge(waiting.as_deref());
        send(Event::UpToDate);
        return false;
    }
    match fetch_installer(&feed, send) {
        Ok(installer) => {
            record(&feed.version, &installer);
            purge(Some(&installer));
            crate::config::store::log_line(&format!(
                "updates: {} downloaded and verified (running {current})",
                feed.version
            ));
            send(Event::Ready {
                version: feed.version,
            });
            true
        }
        Err(why) => {
            crate::config::store::log_line(&format!(
                "updates: {} could not be downloaded: {why}",
                feed.version
            ));
            send(Event::Failed {
                version: feed.version,
            });
            false
        }
    }
}

/// The updater: one thread, asleep between checks, and a queue of what it found.
///
/// One of these per process. Every door to it — the panel's button, the tray's item, the timer —
/// goes through [`Updater::check_now`], so two checks never run at once and a press while one is
/// under way joins it rather than starting another.
pub struct Updater {
    control: Arc<Control>,
    events: Receiver<Event>,
}

struct Control {
    flags: Mutex<Flags>,
    wake: Condvar,
}

#[derive(Default)]
struct Flags {
    asked: bool,
    stop: bool,
}

impl Updater {
    /// Start the thread. `automatic` decides whether it checks on its own; `notify` is called after
    /// every event, from the updater's thread, and is how the UI thread finds out there is one.
    pub fn start(
        current: &'static str,
        automatic: bool,
        notify: impl Fn() + Send + 'static,
    ) -> Self {
        let control = Arc::new(Control {
            flags: Mutex::new(Flags::default()),
            wake: Condvar::new(),
        });
        let (sender, events) = std::sync::mpsc::channel();
        let shared = Arc::clone(&control);
        std::thread::Builder::new()
            .name("rovyl-updates".into())
            .spawn(move || run(shared, current, automatic, sender, notify))
            .ok();
        Self { control, events }
    }

    /// Check now, rather than when the timer next says to.
    pub fn check_now(&self) {
        let mut flags = self.control.flags.lock().unwrap();
        flags.asked = true;
        self.control.wake.notify_one();
    }

    /// The next thing the updater found, if it found anything since the last call.
    pub fn next_event(&self) -> Option<Event> {
        self.events.try_recv().ok()
    }
}

impl Drop for Updater {
    fn drop(&mut self) {
        let mut flags = self.control.flags.lock().unwrap();
        flags.stop = true;
        self.control.wake.notify_one();
    }
}

fn run(
    control: Arc<Control>,
    current: &'static str,
    automatic: bool,
    sender: Sender<Event>,
    notify: impl Fn(),
) {
    // COM, for nothing in particular today — but WinHTTP's proxy discovery can reach into it, and
    // a thread that never initialised it is a thread that finds that out on somebody else's network.
    unsafe {
        let _ = windows::Win32::System::Com::CoInitializeEx(
            None,
            windows::Win32::System::Com::COINIT_MULTITHREADED,
        );
    }
    let send = |event: Event| {
        if sender.send(event).is_ok() {
            notify();
        }
    };
    let mut wait = automatic.then_some(FIRST_CHECK);
    loop {
        {
            let deadline = wait.map(|wait| Instant::now() + wait);
            let mut flags = control.flags.lock().unwrap();
            loop {
                if flags.stop {
                    return;
                }
                if flags.asked {
                    flags.asked = false;
                    break;
                }
                match deadline {
                    Some(deadline) => {
                        let now = Instant::now();
                        if now >= deadline {
                            break;
                        }
                        flags = control.wake.wait_timeout(flags, deadline - now).unwrap().0;
                    }
                    None => flags = control.wake.wait(flags).unwrap(),
                }
            }
        }
        let ready = check(current, &send);
        wait = (automatic && !ready).then_some(RECHECK);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_as_numbers_and_not_as_text() {
        // The one an updater gets to be wrong about exactly once.
        assert!(is_newer("1.10.0", "1.9.0"));
        assert!(!is_newer("1.9.0", "1.10.0"));
        assert!(is_newer("2.0.0", "1.99.99"));
        assert!(is_newer("1.19.1", "1.19.0"));
        assert!(!is_newer("1.19.0", "1.19.0"));
        assert!(!is_newer("1.18.0", "1.19.0"));
        // A missing component is a zero.
        assert!(is_newer("1.20", "1.19.3"));
        assert!(!is_newer("1.19", "1.19.0"));
    }

    #[test]
    fn a_release_outranks_its_own_pre_release() {
        assert!(is_newer("1.20.0", "1.20.0-beta.1"));
        assert!(!is_newer("1.20.0-beta.1", "1.20.0"));
        assert!(is_newer("1.20.0-beta.2", "1.20.0-beta.1"));
        // And a pre-release of a later version still wins on the numbers.
        assert!(is_newer("1.21.0-beta.1", "1.20.0"));
    }

    /// `dist/latest.yml` for 2.2.0, as `scripts/release.ps1` wrote it.
    const FEED: &str = "version: 2.2.0\nfiles:\n  - url: Rovyl-Setup-2.2.0.exe\n    sha512: bLaIxBvXB049CSLylO9KUM0awsdK7nwq7JHD0ci9dXiicn8FONB4BmvqkUapAlEgTbwqjqKGoTOB9NWyrFQqjA==\n    size: 3584000\npath: Rovyl-Setup-2.2.0.exe\nsha512: bLaIxBvXB049CSLylO9KUM0awsdK7nwq7JHD0ci9dXiicn8FONB4BmvqkUapAlEgTbwqjqKGoTOB9NWyrFQqjA==\nreleaseDate: '2026-10-14T05:35:27.870Z'\n";

    #[test]
    fn the_feed_is_read_the_way_the_release_script_writes_it() {
        let feed = parse_feed(FEED).expect("parses");
        assert_eq!(feed.version, "2.2.0");
        assert_eq!(feed.file, "Rovyl-Setup-2.2.0.exe");
        assert_eq!(feed.size, Some(3_584_000));
        assert_eq!(feed.sha512.len(), 64);
        assert_eq!(&feed.sha512[..3], &[0x6C, 0xB6, 0x88]);

        // CRLF, the way the file reads when it has been through Windows tooling.
        assert_eq!(parse_feed(&FEED.replace('\n', "\r\n")), Some(feed));
    }

    #[test]
    fn a_feed_that_cannot_be_checked_is_not_a_feed() {
        // No digest: a download could not be verified, so there is nothing to offer.
        assert_eq!(
            parse_feed("version: 2.3.0\npath: Rovyl-Setup-2.3.0.exe\n"),
            None
        );
        // A digest that is not SHA-512.
        assert_eq!(
            parse_feed("version: 2.3.0\npath: Rovyl-Setup-2.3.0.exe\nsha512: AAAA\n"),
            None
        );
        // Rate-limited, or any other answer that is not a feed.
        assert_eq!(parse_feed("{\"message\":\"Not Found\"}"), None);
    }

    #[test]
    fn a_file_name_from_the_feed_cannot_leave_the_updates_folder() {
        assert!(is_safe_file_name("Rovyl-Setup-2.3.0.exe"));
        assert!(!is_safe_file_name("..\\..\\Startup\\evil.exe"));
        assert!(!is_safe_file_name("C:/Windows/evil.exe"));
        assert!(!is_safe_file_name("Rovyl-Setup-2.3.0.msi"));
        assert!(!is_safe_file_name(""));
    }

    #[test]
    fn base64_decodes_with_and_without_padding() {
        assert_eq!(base64_decode("TWFu"), Some(b"Man".to_vec()));
        assert_eq!(base64_decode("TWE="), Some(b"Ma".to_vec()));
        assert_eq!(base64_decode("TQ=="), Some(b"M".to_vec()));
        assert_eq!(base64_decode("TQ"), Some(b"M".to_vec()));
        assert_eq!(base64_decode("T"), None);
        assert_eq!(base64_decode("TW!u"), None);
    }

    #[test]
    fn the_hash_is_sha512() {
        let path = std::env::temp_dir().join(format!("rovyl-sha512-{}.txt", std::process::id()));
        std::fs::write(&path, b"abc").unwrap();
        let digest = sha512_of(&path).expect("hashes");
        let _ = std::fs::remove_file(&path);
        // FIPS 180-2's own example.
        assert_eq!(&digest[..4], &[0xDD, 0xAF, 0x35, 0xA1]);
        assert_eq!(&digest[60..], &[0xA5, 0x4C, 0xA4, 0x9F]);
    }

    fn note(version: &str, attempts: u32, gave_up: bool) -> Note {
        Note {
            version: version.into(),
            installer_path: "C:\\x\\Rovyl-Setup.exe".into(),
            downloaded_at: 0,
            attempts,
            last_attempt_at: 0,
            gave_up,
            reopen: None,
        }
    }

    #[test]
    fn a_launch_installs_a_newer_update_and_nothing_else() {
        let yes = || true;
        let no = || false;
        assert_eq!(decide(None, "2.2.0", yes, no), Decision::Start);
        assert_eq!(
            decide(Some(&note("2.3.0", 0, false)), "2.2.0", yes, no),
            Decision::Install
        );
        assert_eq!(
            decide(Some(&note("2.3.0", 1, false)), "2.2.0", yes, no),
            Decision::Install
        );
        // The relaunch the installer makes: the note is spent.
        assert_eq!(
            decide(Some(&note("2.3.0", 1, false)), "2.3.0", yes, no),
            Decision::Clear
        );
        assert_eq!(
            decide(Some(&note("2.3.0", 0, false)), "2.4.0", yes, no),
            Decision::Clear
        );
    }

    #[test]
    fn a_broken_installer_gets_two_goes_and_then_is_left_alone() {
        let yes = || true;
        let no = || false;
        assert_eq!(
            decide(Some(&note("2.3.0", 2, false)), "2.2.0", yes, no),
            Decision::GiveUp
        );
        assert_eq!(
            decide(Some(&note("2.3.0", 2, true)), "2.2.0", yes, no),
            Decision::Start
        );
        // A file that has gone is nothing to retry.
        assert_eq!(
            decide(Some(&note("2.3.0", 0, false)), "2.2.0", no, no),
            Decision::Clear
        );
        // Nor is one already being run.
        assert_eq!(
            decide(Some(&note("2.3.0", 0, false)), "2.2.0", yes, yes),
            Decision::Start
        );
    }

    #[test]
    fn the_note_keeps_the_electron_builds_field_names() {
        let text = serde_json::to_string(&Note {
            reopen: Some("tray".into()),
            ..note("2.3.0", 1, false)
        })
        .unwrap();
        for field in [
            "\"installerPath\"",
            "\"lastAttemptAt\"",
            "\"gaveUp\"",
            "\"reopen\":\"tray\"",
        ] {
            assert!(text.contains(field), "{text}");
        }
        // And reads one the Electron build wrote, which has no `reopen` until an install starts.
        let electron: Note = serde_json::from_str(
            r#"{"version":"1.19.0","installerPath":"C:\\u\\x.exe","downloadedAt":1,"attempts":0,"lastAttemptAt":0,"gaveUp":false}"#,
        )
        .unwrap();
        assert_eq!(electron.reopen, None);
    }
}
