//! Rovyl — a radial launcher for Windows.
//!
//! One gesture. Any destination. Hold the middle mouse button anywhere, aim, release.
//!
//! This is the native port of the Electron build. The shape of the program is deliberately
//! different from it in one respect that explains most of the rest: **there is one process.**
//!
//! The Electron build ran a main process, a Chromium renderer per window, a long-lived PowerShell
//! process for the mouse hook, another for stealing the foreground, another for icon extraction,
//! and a C# helper for the system readouts — and every boundary between them needed a protocol, a
//! lifecycle, and a story for what happens when one half dies. Here the hook is a `WH_MOUSE_LL`
//! callback on a thread of this process, the keyboard is a `WH_KEYBOARD_LL` callback beside it, and
//! the icons and readouts come from the shell and the system APIs directly. Nothing is spawned to
//! answer a question this process can ask itself.
//!
//! Three consequences are worth naming, because they are the reasons the port exists:
//!
//! - **The wheel paints from a surface that is already resident** when the trigger fires, so the
//!   first frame is drawn and committed before the window is shown. The original needed a
//!   paint-token handshake across a process boundary for the same effect, and a verification script
//!   to keep it intact.
//! - **One coordinate space.** The hook and the renderer are the same process, so there is no DIP
//!   rectangle handed to a DPI-unaware helper — which is `docs/ARCHITECTURE.md`'s standing
//!   mixed-DPI defect, now absent rather than worked around.
//! - **Nothing has to steal the foreground.** The overlay never takes focus; keystrokes arrive from
//!   the hook, so the window the user was in keeps focus throughout.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// A match arm naming a constant that is not in scope is not an error: Rust reads it as a NEW
// BINDING, which matches anything and silently swallows every arm below it. In a window procedure
// that is a window which paints correctly and responds to nothing, and it is exactly what happened
// to the settings panel: `WM_MOUSELEAVE` lives in `UI::Controls`, not `UI::WindowsAndMessaging`,
// and one missing import cost every click, key and scroll after it. The compiler saw it and said
// so; a warning among a hundred warnings is not something anybody sees. This makes it stop the
// build.
#![deny(unreachable_patterns)]

mod app;
mod config;
mod gfx;
mod i18n;
mod icons;
mod input;
mod launch;
mod probe;
mod sys;
mod ui;
mod wheel;
mod win;

fn main() {
    // COM, for the shell: `ShellExecuteExW` and the icon extractor both need an initialised
    // apartment, and a single-threaded one is what the shell's own interfaces expect.
    unsafe {
        let _ = windows::Win32::System::Com::CoInitializeEx(
            None,
            windows::Win32::System::Com::COINIT_APARTMENTTHREADED,
        );
    }

    let args: Vec<String> = std::env::args().collect();

    // The hand-over from the Electron build, and the double-click on the downloaded setup file.
    //
    // Both end in the same place — `sys::install::take_over` — and both have to be answered BEFORE
    // anything else in this function, including the single-instance lock: an update must not be
    // suppressed because the launcher it is replacing is running, which is the normal case.
    if let Some(mode) = setup_mode(&args) {
        run_setup(mode, &args);
        return;
    }

    // `--diagnose` prints what this build makes of the configuration on disk and exits.
    //
    // It exists because the two builds share one file and the failure it guards against is silent:
    // a config this one mis-reads looks like a working launcher with the wrong shortcuts on it.
    // Printing the hydrated view is the only way to see that from outside.
    if args.iter().any(|a| a == "--diagnose") {
        diagnose();
        return;
    }
    // `--probe` draws one frame offscreen and writes it to a PNG. See `probe.rs` for why a
    // screenshot is not a substitute.
    if args.iter().any(|a| a == "--probe") {
        probe::run(&args);
        return;
    }
    if args.iter().any(|a| a == "--probe-logo") {
        probe::run_logo(&args);
        return;
    }
    if args.iter().any(|a| a == "--probe-brush") {
        probe::run_brush(&args);
        return;
    }
    if args.iter().any(|a| a == "--probe-fonts") {
        probe::run_fonts();
        return;
    }
    if args.iter().any(|a| a == "--probe-settings") {
        probe::run_settings(&args);
        return;
    }
    // `--seed` runs the first-launch path and exits. It is here, ahead of the single-instance
    // lock, because it is a diagnostic rather than a launch — but it WRITES the configuration, so
    // it belongs pointed at a throwaway profile via `ROVYL_USER_DATA` and not at a live one.
    // `--web <url>` fetches what a web shortcut would be born with and prints it. A network
    // failure looks exactly like a glyph that never changed, which is not a thing to debug by
    // staring at a wheel.
    if let Some(at) = args.iter().position(|a| a == "--web") {
        attach_console();
        let url = args.get(at + 1).cloned().unwrap_or_default();
        let full = sys::web::with_scheme(&url);
        let host = sys::web::host_of(&full).unwrap_or_default();
        println!("url         {full}");
        println!("host        {host}");
        println!("fetchable   {}", sys::web::is_fetchable_host(&host));
        let started = std::time::Instant::now();
        match sys::web::page_title(&full) {
            Some(title) => println!("title       {title}  ({:.0} ms)", started.elapsed().as_secs_f64() * 1000.0),
            None => println!("title       (none)  ({:.0} ms)", started.elapsed().as_secs_f64() * 1000.0),
        }
        let started = std::time::Instant::now();
        match sys::web::favicon(&host) {
            Some(bytes) => println!(
                "favicon     {} bytes, .{}  ({:.0} ms)",
                bytes.len(),
                sys::web::extension_for(&bytes),
                started.elapsed().as_secs_f64() * 1000.0
            ),
            None => println!("favicon     (none)  ({:.0} ms)", started.elapsed().as_secs_f64() * 1000.0),
        }
        return;
    }
    // `--recents <label> <command>` prints what the MRU ring would show. The profile folder an
    // editor creates is not its product name, and a mismatch fails SILENTLY — an empty ring and
    // no error. This is how to see which profile a shortcut resolved to.
    if let Some(at) = args.iter().position(|a| a == "--recents") {
        attach_console();
        let label = args.get(at + 1).cloned().unwrap_or_default();
        let command = args.get(at + 2).cloned().unwrap_or_default();
        println!("label       {label}");
        println!("command     {command}");
        println!("ide?        {}", sys::recents::looks_like_an_ide(&label, &command, None));
        println!("tokens      {:?}", sys::recents::identity_tokens(&label, &command));
        println!("profiles");
        for profile in sys::recents::profiles() {
            println!("  {:<22} {}", profile.name, profile.global_storage.display());
        }
        match sys::recents::resolve_global_storage(&label, &command) {
            Some(path) => println!("resolved    {}", path.display()),
            None => println!("resolved    (none)"),
        }
        let started = std::time::Instant::now();
        let items = sys::recents::fetch(&label, &command);
        println!("recents     {} ({:.0} ms)", items.len(), started.elapsed().as_secs_f64() * 1000.0);
        for item in &items {
            println!("  {:<24} {}", item.label, item.description);
        }
        return;
    }
    // `--probe-drop` reads the CLIPBOARD as if it had been dropped on the settings window.
    //
    // Drag-and-drop is the one path no test can reach: it starts with a hand on a mouse, and the
    // data object is handed over by OLE. The clipboard offers the same `IDataObject` with the
    // same formats, so copying files in Explorer and running this exercises everything from
    // `QueryGetData` down to the shortcuts the drop would have produced.
    if args.iter().any(|a| a == "--probe-drop") {
        attach_console();
        match win::drop::payload_from_clipboard() {
            None => println!("clipboard   nothing a drop would take"),
            Some(payload) => {
                println!("paths       {:?}", payload.paths);
                println!("link        {:?}", payload.uri_list);
                println!("text        {:?}", payload.text);
                let entries = sys::dropped::entries_from(&payload);
                println!("entries     {}", entries.len());
                for entry in &entries {
                    let found = sys::dropped::to_item(
                        entry,
                        sys::dropped::resolve_shortcut,
                        |label, command, kind| config::AppItem {
                            // The same fallback the real import uses, so what is printed is what
                            // would be stored rather than a blank where a name would appear.
                            label: label
                                .unwrap_or_else(|| ui::workspace::default_label(&command, kind)),
                            command,
                            command_type: Some(kind),
                            ..config::AppItem::default()
                        },
                    );
                    match found {
                        Some(item) => println!(
                            "  {:<28} {:?}  {}",
                            item.label,
                            item.command_type.unwrap_or(config::CommandType::App),
                            item.command
                        ),
                        None => println!("  (nothing) {entry:?}"),
                    }
                }
            }
        }
        return;
    }
    // `--updates` asks the release feed what it would tell the panel.
    if args.iter().any(|a| a == "--updates") {
        attach_console();
        let current = env!("CARGO_PKG_VERSION");
        println!("running     {current}");
        match sys::updates::latest() {
            Some(release) => println!(
                "latest      {}  ({})
newer?      {}",
                release.version,
                release.url,
                sys::updates::is_newer(&release.version, current)
            ),
            None => println!("latest      (could not reach the feed)"),
        }
        return;
    }
    // `--icon-from <file> [index]` stores a picture or one icon out of a library, and says what
    // reference it got. The file dialog in front of this is the one part a test cannot drive.
    if let Some(at) = args.iter().position(|a| a == "--icon-from") {
        attach_console();
        let path = std::path::PathBuf::from(args.get(at + 1).cloned().unwrap_or_default());
        let index: u32 = args.get(at + 2).and_then(|v| v.parse().ok()).unwrap_or(0);
        println!("file        {}", path.display());
        println!("library?    {}", sys::picker::is_icon_library(&path));
        if sys::picker::is_icon_library(&path) {
            println!("icons in it {}", icons::library::count(&path));
            match icons::library::put(&path, index) {
                Some((reference, origin)) => println!("stored      {reference}
origin      {origin}"),
                None => println!("stored      (nothing at index {index})"),
            }
        } else {
            match crate::gfx::encode::decode_file(&path) {
                Ok((pixels, w, h)) => {
                    println!("decoded     {w}x{h}");
                    match crate::gfx::encode::encode_png(&pixels, w, h)
                        .ok()
                        .and_then(|bytes| icons::store::put(&bytes, "png").ok())
                    {
                        Some(reference) => println!("stored      {reference}"),
                        None => println!("stored      (failed)"),
                    }
                }
                Err(error) => println!("decoded     failed: {error}"),
            }
        }
        return;
    }
    // `--install` puts this where Windows expects an installed program and makes the shortcuts.
    //
    // One executable, so there is no installer to build. Everything an installer would do -- copy
    // a file, make two shortcuts, write one registry key -- this can do for itself, and a setup
    // `.exe` that IS the application is a setup `.exe` that cannot be out of date.
    //
    // It takes over `%LOCALAPPDATA%\Programs\Rovyl` -- retiring a 1.x build if one is there -- so
    // the user is left with one Rovyl rather than two launchers fighting over one shortcut.
    // `--beside` is the old behaviour, which is for trying this next to a working 1.x install.
    if args.iter().any(|a| a == "--install") {
        attach_console();
        let desktop = !args.iter().any(|a| a == "--no-desktop-shortcut");
        let beside = args.iter().any(|a| a == "--beside");
        let done = if beside {
            match sys::install::install(sys::install::Spot::Beside, desktop) {
                sys::install::Outcome::Installed(path) => {
                    println!("installed   {}", path.display());
                    println!("start menu  {}", sys::install::Spot::Beside.display_name());
                    println!();
                    println!("It is installed BESIDE the Electron build, not over it: both read the");
                    println!("same `%APPDATA%\\Rovyl`, so they share one set of workspaces, and only one");
                    println!("of them should be running at a time -- two launchers both holding the");
                    println!("same global shortcut is one of them silently doing nothing.");
                    Some(path)
                }
                sys::install::Outcome::Failed(why) => {
                    println!("install failed: {why}");
                    None
                }
            }
        } else {
            match sys::install::take_over() {
                Ok(path) => {
                    println!("installed   {}", path.display());
                    println!("start menu  {}", sys::install::Spot::Replace.display_name());
                    println!();
                    println!("Any 1.x build was retired: its folder, shortcuts, startup entry and");
                    println!("uninstall entry are gone. `%APPDATA%\\Rovyl` -- the workspaces, the");
                    println!("icons and the settings -- was not touched.");
                    Some(path)
                }
                Err(why) => {
                    println!("install failed: {why}");
                    None
                }
            }
        };
        if let Some(path) = done {
            if !args.iter().any(|a| a == "--no-launch") {
                let _ = std::process::Command::new(&path).arg("--tray").spawn();
                println!();
                println!("Started it in the tray.");
            }
        }
        return;
    }

    // `--uninstall` is what the entry in Windows' own "Installed apps" list runs.
    if args.iter().any(|a| a == "--uninstall") {
        attach_console();
        for line in sys::install::uninstall() {
            println!("{line}");
        }
        println!();
        println!("Your workspaces in %APPDATA%\\Rovyl were left alone.");
        return;
    }

    if args.iter().any(|a| a == "--seed") {
        attach_console();
        if let Ok(mut app) = app::App::new() {
            app.seed();
        }
        return;
    }

    // One instance. A launcher that can run twice is two mouse hooks fighting over one button
    // and two processes writing one configuration file — and the second one tells the first what
    // this launch was for rather than exiting in silence.
    let _lock = match win::instance::acquire(win::instance::request_from_args(&args)) {
        win::instance::Outcome::First(lock) => lock,
        win::instance::Outcome::Already => return,
    };

    match app::App::new() {
        Ok(mut app) => {
            // `--bench N` measures the open path and exits. It is here rather than in `probe.rs`
            // because it has to run against the REAL window and the real swapchain: the number
            // that matters includes the buffer reallocation and the present, and an offscreen
            // bitmap has neither.
            if let Some(at) = args.iter().position(|a| a == "--bench") {
                attach_console();
                let rounds = args
                    .get(at + 1)
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(60usize);
                app.bench(rounds);
                return;
            }
            app.run()
        }
        Err(error) => {
            // Nothing is on screen yet, so there is nowhere to show this but the log — and a
            // launcher that fails to start is exactly the case somebody will go looking for it.
            config::store::log_line(&format!("startup failed: {error}"));
        }
    }
}

/// Which kind of setup run this launch is, if it is one.
enum SetupMode {
    /// NSIS's own arguments, which is the 1.x updater handing this build the machine. No window,
    /// no questions: the user already agreed to this in the app they were running.
    Silent,
    /// Somebody double-clicked the file they downloaded.
    Window,
}

/// Work out whether this launch is a setup — from the command line, and failing that, from the
/// file's own name.
///
/// The silent half is dictated by the Electron build: `backend/electron-main.js` spawns the
/// downloaded file with `--updated /S --force-run`, which are NSIS's flags, and those three
/// strings are everything this program is told about the hand-over.
///
/// The window half has to be decided by the NAME, because nothing else can decide it. This
/// executable is the application AND its own installer, so the same bytes are `Rovyl.exe` in the
/// install folder and `Rovyl-Setup-2.0.0.exe` in somebody's Downloads — and only the name says
/// which of those the user double-clicked. `--setup` forces it, for testing out of a build tree.
fn setup_mode(args: &[String]) -> Option<SetupMode> {
    if args
        .iter()
        .any(|a| a.eq_ignore_ascii_case("/S") || a == "--updated" || a == "--silent")
    {
        return Some(SetupMode::Silent);
    }
    if args.iter().any(|a| a == "--setup") {
        return Some(SetupMode::Window);
    }
    // Only a bare double-click. Any argument at all means somebody is driving this on purpose.
    if args.len() > 1 || sys::install::running_installed() {
        return None;
    }
    let named_setup = std::env::current_exe()
        .ok()
        .and_then(|exe| {
            exe.file_stem()
                .map(|stem| stem.to_string_lossy().to_lowercase())
        })
        .map(|stem| stem.starts_with("rovyl-setup"))
        .unwrap_or(false);
    named_setup.then_some(SetupMode::Window)
}

/// Install, with or without a window.
fn run_setup(mode: SetupMode, args: &[String]) {
    match mode {
        SetupMode::Window => {
            if let Err(error) = win::setup::run() {
                config::store::log_line(&format!("setup: window failed: {error}"));
            }
        }
        SetupMode::Silent => {
            // Read before the migration, which deletes it: the old build's note says where the
            // user was when they asked for this. Somebody who pressed "Restart to update" in
            // Settings is waiting for a window; somebody who used the tray is not.
            let reopen = pending_reopen();
            match sys::install::take_over() {
                Ok(path) => {
                    config::store::log_line(&format!("setup: installed {}", path.display()));
                    // `--force-run` is the updater asking for the app back on its feet. Without
                    // it, the user asked for the install and nothing else.
                    if args.iter().any(|a| a == "--force-run") {
                        let mut command = std::process::Command::new(&path);
                        if reopen.as_deref() != Some("window") {
                            command.arg("--tray");
                        }
                        let _ = command.spawn();
                    }
                }
                // Nothing is on screen -- this launch never had a window -- so the log is the only
                // place this can be said. The old build is still installed when the copy is what
                // failed, which is the ordering `take_over` exists to guarantee.
                Err(why) => config::store::log_line(&format!("setup: failed: {why}")),
            }
        }
    }
}

/// What the 1.x updater's note says to reopen into, if it left one.
fn pending_reopen() -> Option<String> {
    let note = config::store::user_data_dir().join("pending-update.json");
    let text = std::fs::read_to_string(note).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    Some(value.get("reopen")?.as_str()?.to_string())
}

/// Attach to the launching terminal so a diagnostic flag's output is visible.
///
/// The binary is a GUI-subsystem image and has no console of its own; without this the output of
/// `--diagnose` and `--bench` goes nowhere and the flag looks like it did nothing.
fn attach_console() {
    unsafe {
        use windows::Win32::System::Console::{AllocConsole, AttachConsole, ATTACH_PARENT_PROCESS};
        if AttachConsole(ATTACH_PARENT_PROCESS).is_err() {
            let _ = AllocConsole();
        }
    }
}

/// Print this build's view of the configuration on disk.
///
/// A console is attached explicitly because the binary is a GUI subsystem image: without it the
/// output goes nowhere and the flag looks like it did nothing.
fn diagnose() {
    attach_console();

    let loaded = config::store::load();
    let c = &loaded.config;
    println!("source            {:?}", loaded.source);
    println!("bytes on disk     {:?}", config::store::persistence_meta());
    println!("path              {}", config::store::config_path().display());
    println!();
    println!("workspaces        {} ({} enabled)", c.workspaces.len(), c.enabled_workspace_count());
    for (i, w) in c.workspaces.iter().enumerate() {
        let key = config::workspace_key_at(w, i);
        println!(
            "  [{i}] {:<16} {:>3} apps  enabled={:<5} key={:<2} glyph={}",
            w.name,
            w.apps.len(),
            w.enabled,
            if key.is_empty() { "-" } else { &key },
            w.picker_icon_name.as_deref().unwrap_or("Layers"),
        );
    }
    println!("active            {}", c.active_workspace_index);
    println!();
    println!("trigger (mouse)   {} {:?}  enabled={}",
        crate::input::trigger::phrase(c.mouse_trigger_button.as_deref()),
        c.mouse_trigger_mode,
        c.enable_mouse_trigger);
    println!("trigger (key)     {} {:?}  enabled={}  parses={}",
        c.global_shortcut, c.shortcut_trigger_mode, c.keyboard_trigger_on(),
        crate::input::hotkey::parse(&c.global_shortcut).is_some());
    println!("targeting         {:?}  wedges={}", c.selection_mode(), c.area_wedges());
    println!("clickless         {:?} dwell={}ms sens={:?}",
        c.instant_activate(), c.dwell_ms(), c.sensitivity());
    println!("numbers           launch={} badges={} back={:?}",
        c.number_launch(), c.number_badges(), c.back_key());
    println!("dimming           {:.2} (scale {:?}) full-bleed={}",
        c.backdrop_opacity, c.backdrop_dim_scale, c.needs_full_bleed());
    println!("geometry          radius={} icon={} spacing={} threshold={}",
        c.menu_radius, c.icon_size, c.app_spacing, c.activation_threshold);
    println!("placement         {:?} on {:?}", c.placement(), c.monitor_choice());
    println!("gear              {:?} at {:?}", c.gear_visible(), c.gear_corner());
    println!("docks             status={} shortcut={}",
        c.status_dock_cfg().is_active(), c.shortcut_dock_cfg().is_active());
    println!("labels            show={} always={} pill={}",
        c.show_labels, c.always_show_app_labels, c.show_pill());
    println!("theme/lang        {:?} / {}", c.theme(), c.language);
    println!("game mode         enabled={} {:?} auto={}",
        c.game_mode.enabled, c.game_mode.mode, c.game_mode.auto_detect_games);

    // Every glyph the config names, and whether it resolves. A config that paints cubes is the
    // most visible possible regression and the only way to see it before opening the wheel.
    let mut missing: Vec<String> = Vec::new();
    fn walk(items: &[config::AppItem], missing: &mut Vec<String>) {
        for item in items {
            if !item.icon_name.is_empty() && !crate::gfx::lucide::exists(&item.icon_name) {
                missing.push(format!("{} ({})", item.icon_name, item.label));
            }
            walk(item.child_slice(), missing);
        }
    }
    for w in &c.workspaces {
        if let Some(name) = &w.picker_icon_name {
            if !crate::gfx::lucide::exists(name) {
                missing.push(format!("{name} (workspace {})", w.name));
            }
        }
        walk(&w.apps, &mut missing);
    }
    println!();
    if missing.is_empty() {
        println!("glyphs            all resolve");
    } else {
        println!("glyphs            {} unresolved:", missing.len());
        for name in missing.iter().take(20) {
            println!("                    {name}");
        }
    }

    // What the shell says is installed, and how long it took to ask. The Electron build spent
    // 300-800 ms in a PowerShell host for this answer.
    let at = std::time::Instant::now();
    let apps = crate::sys::discovery::installed();
    println!();
    println!(
        "installed apps    {} found in {:.1} ms",
        apps.len(),
        at.elapsed().as_secs_f32() * 1000.0
    );
    for app in crate::sys::discovery::seed(&apps, 8) {
        println!("  seed            {:<28} {}", app.label, app.command);
    }

    // The displays, since every geometry decision starts here.
    println!();
    for d in crate::win::monitor::displays() {
        println!(
            "display           {}x{} @{}% work={}x{} at ({},{}){}",
            d.bounds.right - d.bounds.left,
            d.bounds.bottom - d.bounds.top,
            (d.scale() * 100.0).round(),
            d.work_width(),
            d.work_height(),
            d.work_area.left,
            d.work_area.top,
            if d.is_primary { "  [primary]" } else { "" },
        );
    }
}
