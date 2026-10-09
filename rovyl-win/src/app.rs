//! The application: one window for messages, one for the wheel, and the frame loop that drives it.
//!
//! **The shape of the program.** There is a hidden message-only window that receives everything
//! asynchronous — the hooks' reports, the global hotkey, the tray, timers — and an overlay window
//! that is nothing but a surface. The message window exists rather than hanging the handlers off
//! the overlay because the overlay's bounds change and it is shown and hidden constantly, and a
//! window that is sometimes hidden is a poor place to receive a hotkey.
//!
//! **The frame loop.** Two modes, and the difference is the whole resting cost of the product.
//! While nothing is animating the loop BLOCKS in `WaitMessage` — zero wake-ups, zero CPU, for the
//! hours between gestures. While something is animating it waits on the swapchain's frame-latency
//! object alongside the message queue, which paces rendering to the display without polling and
//! without a timer.
//!
//! **What the loop must never do.** Block. The mouse hook runs on its own thread precisely so a
//! stall here cannot freeze the system's pointer, but a stall here still stalls the WHEEL, and the
//! wheel is on screen during a gesture the hand is still making. Everything slow — icon
//! extraction, the Start Menu scan, reading an IDE's recent-projects list — belongs on a worker.

use crate::config::{self, UiConfig};
use crate::gfx::device::Gpu;
use crate::gfx::lucide::GlyphCache;
use crate::gfx::painter::{Painter, ShadowCache};
use crate::gfx::text::TextCache;
use crate::icons::cache::IconCache;
use crate::icons::extract::Extractor;
use crate::input::{hook, hotkey, trigger};
use crate::launch;
use crate::wheel::render::{self, Frame};
use crate::wheel::state::{Action, TriggerSource, Wheel};
use crate::ui::settings::{Recording, SettingsUi};
use crate::ui::Ui;
use crate::win::{instance, monitor, overlay, settings, tray};
use std::time::Instant;
use windows::core::{w, PCWSTR, Result};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, InSendMessage, PeekMessageW, PostMessageW,
    PostQuitMessage, RegisterClassExW, TranslateMessage, WaitMessage, MSG, PM_REMOVE, WM_APP,
    WM_CLOSE, WM_DESTROY, WM_DISPLAYCHANGE, WM_HOTKEY, WM_MOUSEMOVE, WM_QUIT, WNDCLASSEXW,
    WS_EX_TOOLWINDOW, WS_POPUP,
};

const CLASS_NAME: PCWSTR = w!("RovylApp");

/// Posted by a worker when it has something for the UI thread.
///
/// It exists so the loop can block in `WaitMessage` the rest of the time. A launcher that polls a
/// channel sixty times a second while doing nothing has given up the thing it is for.
const MSG_WORKER: u32 = WM_APP + 400;

/// The timer that drives the deferred hold-mode open.
///
/// Started when a press begins and killed the moment it resolves — NOT left running. The original
/// comment about `WM_TIMER` being coalesced to ~15.6 ms is the reason the deferral is 200 ms and
/// not 50, and the reason this is a timer at all rather than a frame.
const TIMER_HOLD: usize = 1;

/// How long after a trigger press the wheel opens in HOLD mode.
///
/// The open is deferred so a second press inside the window can cancel it and open Settings
/// instead — which is the only gesture that reaches Settings without the tray or the corner gear.
/// Short enough that a deliberate hold does not feel laggy.
const HOLD_OPEN_DELAY_MS: u32 = 200;

pub struct App {
    hwnd: HWND,
    gpu: Gpu,
    overlay: overlay::Overlay,
    glyphs: GlyphCache,
    text: TextCache,
    shadows: ShadowCache,
    icons: IconCache,
    /// Produces the icons the cache then loads. Separate from it because they are different jobs:
    /// one reads a file the store already has, the other asks the shell for a new one.
    extractor: Extractor,
    /// A Start Menu scan in flight, and what it found.
    discovery: Option<std::sync::mpsc::Receiver<Vec<crate::sys::discovery::Installed>>>,
    /// Whether the deferred-open timer is running.
    hold_timer: bool,
    /// The recording the host has already acted on, so a change is told from a repeat.
    armed_recording: Option<Recording>,
    /// Whether the configured shortcut could not be registered because something else holds it.
    shortcut_taken: bool,
    /// Recent projects, by `label||command`.
    ///
    /// Kept for the session: an editor's MRU changes when the editor opens a folder, which it
    /// cannot do while the wheel is up. Re-reading it per open would be a SQLite scan per gesture.
    recents_cache: Vec<(String, Vec<crate::config::AppItem>)>,
    /// The failure card, created the first time something fails to start.
    ///
    /// Lazily, because most sessions never see one, and a window that is never shown is still a
    /// window: a swapchain, a surface and a place in the compositor's tree.
    card: Option<crate::win::card::Card>,
    /// What the card is showing, and since when.
    fault: Option<(crate::ui::fault::Fault, std::time::Instant)>,
    /// Whether the card's Copy button has been pressed for this fault.
    fault_copied: bool,
    /// An update check in flight.
    update_check: Option<std::sync::mpsc::Receiver<Option<crate::sys::updates::Release>>>,
    /// Prefetches in flight, so one is not started twice.
    recents_jobs: Vec<String>,
    recents_results: Option<std::sync::mpsc::Receiver<(String, Vec<crate::config::AppItem>)>>,
    recents_sender: Option<std::sync::mpsc::Sender<(String, Vec<crate::config::AppItem>)>>,

    config: UiConfig,
    user: Option<config::UserProfile>,
    legacy_apps: Option<Vec<config::AppItem>>,
    dirty: bool,

    wheel: Wheel,
    hotkeys: hotkey::Registry,
    /// When the overlay's first frame of this open was presented, for the dwell's arming delay.
    first_paint: Option<Instant>,
    /// A deferred hold-mode open: the instant the trigger went down, and where.
    pending_open: Option<(Instant, POINT)>,
    /// The next trigger release is the tail of a press that CLOSED the wheel, and must not reopen
    /// or confirm anything.
    suppress_release: bool,
    /// The wheel was opened by holding the keyboard shortcut; its release confirms.
    shortcut_held: bool,
    /// What is waiting on the launch echo to finish.
    pending_launch: Option<Box<config::AppItem>>,
    /// Where a tray menu should open once every mouse button is released.
    pending_menu_at: Option<POINT>,
    /// What the last frame drew in the corners, and what pressing each of them means.
    ///
    /// Kept from the frame that drew them rather than recomputed on the press, so there is one
    /// opinion about where a dock icon is — the same rule the wheel's own aiming follows.
    dock_targets: Vec<crate::wheel::docks::Target>,
    /// Whether the primary button is held, for the volume bar's drag.
    pointer_down: bool,
    /// What was lit on the last frame, so the hover note plays on a CHANGE rather than on every
    /// frame the pointer happens to be over the same slice.
    last_highlight: Option<usize>,
    /// A Windows panel to open once the wheel is down.
    pending_panel: Option<crate::sys::status::Panel>,
    /// Settings to open once the wheel is down.
    pending_settings: bool,
    /// The open path's sub-timings, in milliseconds. Written by `open_wheel` and read only by
    /// `bench`: an average is not enough to act on, because the four parts have completely
    /// different fixes.
    split_buffers: f32,
    split_bake: f32,
    split_draw: f32,
    split_present: f32,
    split_show: f32,
    /// The settings window, created the first time it is asked for.
    ///
    /// Lazily, because most sessions never open it: a window, its composition target and two back
    /// buffers for a panel nobody looked at is the kind of cost a launcher is judged on.
    settings: Option<settings::SettingsWindow>,
    settings_ui: SettingsUi,
    ui: Ui,
    tray: Option<tray::Tray>,
    /// Explorer's "the taskbar came back" broadcast, resolved once.
    taskbar_created: u32,
    /// A second launch's hand-off message, resolved once.
    wake_message: u32,
    /// Triggers are suspended from the tray menu. The hooks come down entirely, so a paused
    /// launcher costs what a closed one costs.
    paused: bool,
    /// When a timed pause runs out.
    ///
    /// Separate from `paused` rather than replacing it, because "paused with no end" is still a
    /// thing somebody can ask for and `None` has to keep meaning "no clock" rather than "not
    /// paused". The pair is read together and nowhere else.
    paused_until: Option<std::time::Instant>,
    /// Which workspace each registered key slot belongs to.
    ///
    /// A fixed array rather than a map: the slots are written in `arm_workspace_keys` and read in
    /// `on_hotkey`, and the only thing that can go wrong is the two disagreeing about an index —
    /// which a sparse structure makes easier, not harder.
    workspace_key_slots: [Option<usize>; MAX_WORKSPACE_KEYS],
    quit: bool,
}

/// How many workspace keys can be registered at once.
///
/// One per workspace, and nothing enforces a workspace limit — so this is a ceiling rather than a
/// capacity. Past it the remaining workspaces keep their place in the picker and lose their key,
/// which is the same thing that already happens past the ninth positional digit.
const MAX_WORKSPACE_KEYS: usize = 64;

impl App {
    pub fn new() -> Result<Self> {
        monitor::declare_dpi_awareness();

        let loaded = config::store::load();
        if loaded.source != config::store::Source::Primary {
            config::store::log_line(&format!(
                "config loaded from {:?} ({:?} bytes on disk)",
                loaded.source,
                config::store::persistence_meta()
            ));
        }
        let config = loaded.config;

        let gpu = Gpu::create()?;
        let hwnd = create_message_window()?;

        // The overlay is parked on the monitor the next open will use, at the size that open will
        // need. The point is that opening costs no window move and no buffer reallocation — both of
        // which can present one frame of the old surface, which is a visible flash.
        let display = monitor::target_display(config.monitor_choice(), config.placement());
        let bounds = overlay::bounds_for(
            &display,
            (display.work_center().x, display.work_center().y),
            320.0 * display.scale(),
            config.needs_full_bleed(),
        );
        let overlay_window = overlay::Overlay::create(&gpu, bounds)?;
        overlay::set_app_window(&overlay_window, hwnd);

        let wheel = Wheel::new(&config);
        let text = TextCache::new(gpu.dwrite.clone());

        let mut app = Self {
            hwnd,
            gpu,
            overlay: overlay_window,
            glyphs: GlyphCache::new(),
            text,
            shadows: ShadowCache::new(),
            icons: IconCache::new(),
            extractor: Extractor::new(),
            discovery: None,
            hold_timer: false,
            armed_recording: None,
            shortcut_taken: false,
            card: None,
            fault: None,
            fault_copied: false,
            recents_cache: Vec::new(),
            update_check: None,
            recents_jobs: Vec::new(),
            recents_results: None,
            recents_sender: None,
            config,
            user: loaded.user,
            legacy_apps: loaded.legacy_apps,
            dirty: false,
            wheel,
            hotkeys: hotkey::Registry::new(),
            first_paint: None,
            pending_open: None,
            suppress_release: false,
            shortcut_held: false,
            pending_launch: None,
            pending_menu_at: None,
            dock_targets: Vec::new(),
            pointer_down: false,
            last_highlight: None,
            pending_panel: None,
            pending_settings: false,
            settings: None,
            settings_ui: SettingsUi::default(),
            ui: Ui::new(),
            split_buffers: 0.0,
            split_bake: 0.0,
            split_draw: 0.0,
            split_present: 0.0,
            split_show: 0.0,
            tray: None,
            taskbar_created: taskbar_created(),
            wake_message: instance::wake_message(),
            paused: false,
            paused_until: None,
            workspace_key_slots: [None; MAX_WORKSPACE_KEYS],
            quit: false,
        };

        hook::set_target(hwnd);
        hook::start();
        app.extractor.wake_on(hwnd.0 as isize, MSG_WORKER);
        app.arm_triggers();
        app.tray = Some(tray::Tray::new(hwnd));
        Ok(app)
    }

    /// Put the mouse trigger and the global shortcut into the state the config asks for.
    ///
    /// Called at startup and after any settings change. Re-arming is idempotent and cheap, so it is
    /// done wholesale rather than diffed: a diff here would be a second model of what is armed,
    /// and the one failure mode that matters is the two disagreeing.
    fn arm_triggers(&mut self) {
        if self.paused {
            // Paused means the hooks come DOWN, not that their events are ignored: a low-level
            // hook is a system-wide tax on every mouse event in Windows, and "paused" has to be
            // worth something.
            hook::arm(None, false);
            self.hotkeys.clear(self.hwnd, hotkey::ID_TRIGGER);
            return;
        }
        if self.config.enable_mouse_trigger {
            let binding = trigger::resolve(self.config.mouse_trigger_button.as_deref());
            let hold = matches!(
                self.config.mouse_trigger_mode,
                Some(config::TriggerMode::Hold)
            ) && trigger::allows_hold(self.config.mouse_trigger_button.as_deref());
            hook::arm(Some(&binding), hold);
        } else {
            hook::arm(None, false);
        }

        if self.config.keyboard_trigger_on() {
            if let Some(parsed) = hotkey::parse(&self.config.global_shortcut) {
                // The outcome is kept, because a shortcut another program already holds is a
                // shortcut that does nothing -- and the panel says `Alt+Z` either way. "I set it
                // and it doesn't work" is the report that follows, and nothing in the program
                // knew enough to answer it.
                let probe = self.hotkeys.set(self.hwnd, hotkey::ID_TRIGGER, &parsed);
                self.shortcut_taken = matches!(probe, hotkey::Probe::Taken);
                if self.shortcut_taken {
                    config::store::log_line(&format!(
                        "shortcut {} is held by another program",
                        self.config.global_shortcut
                    ));
                }
            } else {
                self.hotkeys.clear(self.hwnd, hotkey::ID_TRIGGER);
                self.shortcut_taken = false;
            }
        } else {
            self.hotkeys.clear(self.hwnd, hotkey::ID_TRIGGER);
            self.shortcut_taken = false;
        }
    }

    /// Register the workspace keys, which are only live while the wheel is open.
    ///
    /// Two features cannot own one key. With `radial_number_launch` on, the wheel handles 1–9
    /// itself, so the DIGITS are not registered — a workspace still on its positional default goes
    /// quiet while a workspace whose key was recorded as a letter keeps working. That is said out
    /// loud in the settings row rather than discovered by pressing 2 and watching an app open.
    fn arm_workspace_keys(&mut self, open: bool) {
        self.hotkeys
            .clear_range(self.hwnd, hotkey::ID_WORKSPACE_BASE);
        self.workspace_key_slots = [None; MAX_WORKSPACE_KEYS];
        if !open {
            return;
        }
        let digits_claimed = self.config.number_launch();
        for (slot, (key, index)) in config::workspace_key_bindings(&self.config)
            .into_iter()
            .enumerate()
        {
            if digits_claimed && key.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            // Bare keys, with no modifier — which `hotkey::parse` refuses by design, so the
            // registration is built here rather than parsed from a string.
            let Some(vk) = key.chars().next().map(|c| c as u16) else {
                continue;
            };
            let binding = hotkey::Hotkey {
                modifiers: windows::Win32::UI::Input::KeyboardAndMouse::MOD_NOREPEAT,
                vk,
            };
            if slot >= MAX_WORKSPACE_KEYS {
                break;
            }
            let id = hotkey::ID_WORKSPACE_BASE + slot as i32;
            self.hotkeys.set(self.hwnd, id, &binding);
            self.workspace_key_slots[slot] = Some(index);
        }
    }

    /// One sample of a wheel being carried by its hub.
    fn carry_wheel(&mut self, at: windows::Win32::Foundation::POINT) {
        let step = self.wheel.hub_drag_move((at.x, at.y));
        if std::env::var_os("ROVYL_TRACE_CARRY").is_some() {
            config::store::log_line(&format!("carry: {step:?} at ({},{})", at.x, at.y));
        }
        match step {
            crate::wheel::state::Carry::Pending => return,
            // Asked for on the pixel the hand commits, so the window is already the size of the
            // screen by the time the carry has gone anywhere.
            crate::wheel::state::Carry::Began => self.make_room_to_carry(),
            crate::wheel::state::Carry::Moving => {}
        }
        let bounds = self.overlay.bounds();
        self.wheel.hub_drag_place((
            (at.x - bounds.left) as f32,
            (at.y - bounds.top) as f32,
        ));
    }

    /// Grow the overlay to the whole work area, so the wheel has somewhere to be carried TO.
    ///
    /// The box the wheel is born in is a few hundred pixels wider than the ring and no further,
    /// which is a fine desk to aim on and far too small a one to carry anything across.
    ///
    /// The growth moves the window's top-left corner, and every client coordinate is measured
    /// from it. Both halves of that have to land in one step: the wheel re-expressed in the new
    /// frame AND the frame it is re-expressed in. Half of it would move the wheel out from under
    /// the hand by exactly the distance the window travelled, in the middle of a gesture the hand
    /// is still making.
    fn make_room_to_carry(&mut self) {
        let display = monitor::from_window(self.overlay.hwnd);
        let wanted = display.work_area;
        let old = self.overlay.bounds();
        if overlay::same_rect(old, wanted) {
            return;
        }
        // `set_bounds` resizes the surface with the window, so there is nothing else to restore.
        if self.overlay.set_bounds(wanted).is_err() {
            return;
        }
        let shift = (
            (old.left - wanted.left) as f32,
            (old.top - wanted.top) as f32,
        );
        let viewport = self.overlay.size();
        self.wheel.reframe(shift, viewport);
    }

    // ── Opening and closing ─────────────────────────────────────────────────

    fn open_wheel(&mut self, source: TriggerSource) {
        let display = monitor::target_display(self.config.monitor_choice(), self.config.placement());
        let cursor = hook::cursor();

        // The reach has to be known before the window is sized, and it depends on the item count —
        // which depends on the level, which is what `open` sets up. So the wheel is opened once
        // against a provisional geometry to learn its reach, then the window is sized, then the
        // wheel is told the real geometry. Both passes are pure arithmetic; neither draws.
        let scale = display.scale();
        self.wheel.scale = scale;
        self.wheel.open(
            &self.config,
            source,
            (0.0, 0.0),
            (display.work_width() as f32, display.work_height() as f32),
            scale,
        );
        let reach = self.wheel.ring_reach();

        let center_screen = overlay::center_for(&display, self.config.placement(), cursor, reach);
        let full_bleed = self.config.needs_full_bleed();
        let bounds = overlay::bounds_for(&display, center_screen, reach, full_bleed);

        // A window that is about to move to another monitor is hidden first: a move of that size
        // can present one frame of the old surface at the new position.
        let moving_far = {
            let old = self.overlay.bounds();
            (old.left - bounds.left).abs() > 8 || (old.top - bounds.top).abs() > 8
        };
        if moving_far && self.overlay.visible() {
            self.overlay.hide();
        }
        if self.overlay.set_bounds(bounds).is_err() {
            return;
        }

        // The back buffers were released while idle; they come back before the frame is drawn and
        // well before the window is shown.
        let at = std::time::Instant::now();
        let restored = self.overlay.restore_buffers();
        self.split_buffers = at.elapsed().as_secs_f32() * 1000.0;
        if restored.is_err() {
            return;
        }
        let viewport = self.overlay.size();
        let center_client = (
            (center_screen.0 - bounds.left) as f32,
            (center_screen.1 - bounds.top) as f32,
        );
        self.wheel.center = center_client;
        self.wheel.viewport = viewport;
        self.wheel.relayout(&self.config);

        // The hook becomes the input authority for this monitor: it swallows buttons and the wheel
        // there and forwards them here. The rectangle is the whole monitor — see `begin_blocking`
        // for why there is no "allowed" sub-rectangle any more.
        hook::begin_blocking(display.bounds);
        self.arm_workspace_keys(true);

        if self.config.open_sound_on() {
            crate::sys::sound::play(
                &crate::sys::sound::normalize(
                    self.config.radial_open_sound_id.as_deref(),
                    "sub-tick",
                ),
                self.config.sound_volume(),
            );
        }
        // The readings should be current on the first frame, not whatever was true the last time
        // the wheel was up.
        if self.config.status_dock_cfg().needs_sampler() {
            crate::sys::status::invalidate();
            crate::sys::status::poll();
        }
        self.last_highlight = None;

        self.first_paint = None;
        // Draw and commit BEFORE showing. This is the whole of what the original's paint-token
        // handshake was for; see `overlay::present_then_show`.
        let at = std::time::Instant::now();
        self.render();
        self.split_draw = at.elapsed().as_secs_f32() * 1000.0 - self.split_bake;
        if let Ok((presented, shown)) = self.overlay.present_then_show() {
            self.split_present = presented;
            self.split_show = shown;
        }
        self.overlay.raise();
        self.first_paint = Some(Instant::now());
    }

    fn close_wheel(&mut self) {
        if !self.wheel.open {
            return;
        }
        self.wheel.begin_exit();
    }

    /// Finish the close: hide the window and release everything the open claimed.
    fn finish_close(&mut self) {
        self.wheel.close_now();
        self.overlay.hide();
        hook::end_blocking();
        self.arm_workspace_keys(false);
        self.first_paint = None;
        self.shortcut_held = false;

        if let Some(item) = self.pending_launch.take() {
            // The command leaves AFTER the echo and AFTER the window is down: the overlay is
            // always-on-top and the app that opens steals the foreground, so dispatching earlier
            // left the new window fighting a wheel that was still fading.
            let outcome = launch::run(&item);
            if !outcome.succeeded() {
                // Said out loud. A shortcut that does nothing when it is aimed at is the one
                // failure a launcher must never be quiet about -- the gesture worked, so the
                // user has no reason to suspect the shortcut rather than the wheel.
                let workspace = self
                    .config
                    .workspaces
                    .iter()
                    .position(|w| w.apps.iter().any(|a| a.id == item.id));
                self.show_fault(crate::ui::fault::from_launch(&item, &outcome, workspace));
            }
        }
        // Both of these wait on the close for the same reason, and the order is the one the
        // original follows: the wheel goes, then the window is asked for.
        if let Some(panel) = self.pending_panel.take() {
            crate::sys::status::open_panel(panel);
        }
        if std::mem::take(&mut self.pending_settings) {
            self.open_settings();
        }
        self.dock_targets.clear();
        // The audio endpoint is released with the wheel; a running client keeps a stream open and
        // a thread waking every few milliseconds.
        crate::sys::sound::sleep();

        if self.dirty {
            self.save();
        }

        // Park the overlay where the next open will want it, so that open costs no move and no
        // buffer reallocation. The original does the same thing for the same reason.
        let display = monitor::target_display(self.config.monitor_choice(), self.config.placement());
        let bounds = overlay::bounds_for(
            &display,
            (display.work_center().x, display.work_center().y),
            self.wheel.ring_reach().max(320.0 * display.scale()),
            self.config.needs_full_bleed(),
        );
        let _ = self.overlay.set_bounds(bounds);
        self.overlay.release_buffers();
        release_working_set();
    }

    fn save(&mut self) {
        self.dirty = false;
        if let Err(error) = config::store::save(
            &self.config,
            self.user.as_ref(),
            self.legacy_apps.as_deref(),
        ) {
            config::store::log_line(&format!("save failed: {error}"));
        }
    }

    // ── Actions ─────────────────────────────────────────────────────────────

    fn apply(&mut self, action: Action) {
        match action {
            Action::Idle | Action::Redraw => {}
            Action::Close => self.close_wheel(),
            Action::Launch(item) => {
                // Held, not run: the echo has to play first. `finish_close` dispatches it.
                self.pending_launch = Some(item);
            }
            Action::WorkspaceChanged(_) => {
                self.dirty = true;
                // The key bindings follow the workspace list, not the active one, so they do not
                // need re-registering here — but the level did change, and the layout with it.
                self.wheel.relayout(&self.config);
            }
            Action::FetchRecents(item) => {
                // The cache first, which the prefetch usually filled while the wheel was opening.
                // A miss reads it here and now: it is tens of milliseconds against a gesture the
                // hand has already finished, and a two-phase ring that appears empty and then
                // fills in is worse than one frame of waiting.
                let key = recents_key(&item);
                let found = match self.recents_cache.iter().find(|(k, _)| *k == key) {
                    Some((_, items)) => items.clone(),
                    None => {
                        let items = crate::sys::recents::fetch(&item.label, &item.command);
                        self.recents_cache.push((key, items.clone()));
                        items
                    }
                };
                self.wheel.recents_arrived(&self.config, &item, found);
            }
            Action::OpenSettings => {
                self.close_wheel();
            }
            Action::DirectionHintSeen => {
                self.config.has_seen_direction_hint = Some(true);
                self.dirty = true;
            }
        }
    }

    // ── Messages ────────────────────────────────────────────────────────────

    fn on_message(&mut self, message: u32, w: WPARAM, l: LPARAM) {
        match message {
            hook::MSG_TRIGGER_DOWN => self.on_trigger_down(hook::unpack_point(l)),
            hook::MSG_TRIGGER_CLICK => self.on_trigger_click(),
            hook::MSG_TRIGGER_HOLD_END => self.on_trigger_hold_end(),
            hook::MSG_POINTER => self.on_pointer(w, l),
            hook::MSG_KEY_DOWN => self.on_key(w.0 as u16, l.0 as u32),
            WM_HOTKEY => self.on_hotkey(w.0 as i32),
            WM_DISPLAYCHANGE => {
                // The monitor list has changed under the parked overlay. Re-park it rather than
                // waiting for the next open to notice, because the next open may be on a display
                // that no longer exists.
                if !self.wheel.open {
                    let display = monitor::target_display(
                        self.config.monitor_choice(),
                        self.config.placement(),
                    );
                    let bounds = overlay::bounds_for(
                        &display,
                        (display.work_center().x, display.work_center().y),
                        320.0 * display.scale(),
                        self.config.needs_full_bleed(),
                    );
                    let _ = self.overlay.set_bounds(bounds);
                }
            }
            WM_CLOSE | WM_DESTROY => self.quit = true,
            tray::MSG_TRAY => self.on_tray(w, l),
            other if other == self.taskbar_created => {
                // Explorer restarted and took every tray icon with it. An icon that does not come
                // back is an app with no way to be quit for the rest of the session.
                if let Some(tray) = self.tray.as_mut() {
                    tray.restore();
                }
            }
            other if other == self.wake_message => match w.0 {
                instance::WAKE_OPEN_WHEEL => {
                    if !self.wheel.open && self.may_open() {
                        self.open_wheel(TriggerSource::Shortcut);
                    }
                }
                _ => self.open_settings(),
            },
            hook::MSG_BUTTONS_UP => self.show_tray_menu(),
            hook::MSG_RECORD_MOUSE => self.on_recorded_button(w.0 as u32, l.0 as u32),
            _ => {}
        }
    }

    /// A button the settings recorder was waiting for.
    fn on_recorded_button(&mut self, button: u32, modifiers: u32) {
        if self.settings_ui.recording != Some(Recording::MouseButton) {
            return;
        }
        let Some(binding) = trigger::from_ordinal(button, modifiers) else {
            return;
        };
        // A binding the hook would refuse must not be saved: a row that displays a button and
        // opens nothing is worse than the one that was there before.
        if trigger::reject(&binding).is_some() {
            return;
        }
        self.config.mouse_trigger_button = Some(trigger::format(&binding));
        self.settings_ui.recording = None;
        hook::set_recording(false);
        self.dirty = true;
        self.arm_triggers();
        if let Some(window) = self.settings.as_mut() {
            window.state.needs_frame = true;
        }
    }

    fn on_tray(&mut self, w: WPARAM, l: LPARAM) {
        // What the callback MEANS depends on which contract the icon registered under, so the
        // answer comes from the tray itself rather than from the message alone.
        let version_4 = self.tray.as_ref().is_some_and(tray::Tray::version_4);
        match tray::Tray::classify(l, version_4) {
            // A click on the icon opens Settings, and so does a double click — which is what the
            // build this one replaces does, and what the shell's vocabulary forces anyway. One
            // double click arrives as NIN_SELECT, then WM_LBUTTONDBLCLK, then NIN_SELECT again:
            // three events for one gesture, and the only way that reads as one action is if all
            // three mean the same thing. Showing a window that is already up is free; a click that
            // toggled something would have opened it, swapped it, and opened it again.
            //
            // The wheel keeps the trigger, the shortcut and its own row in this menu. It does not
            // also need the icon, and it must not be left standing behind a settings window it
            // cannot be used alongside.
            tray::TrayEvent::Activate | tray::TrayEvent::Settings => {
                if self.wheel.open {
                    self.close_wheel();
                }
                self.open_settings();
            }
            tray::TrayEvent::Menu => {
                self.pending_menu_at = Some(tray::Tray::menu_point(w, version_4));
                // The menu runs its own modal loop, and opening one while a mouse button is
                // physically held leaves it owning input the hook is also watching — the menu then
                // will not close on the release. Wait for every button to come up first.
                hook::notify_on_buttons_up();
            }
            tray::TrayEvent::Nothing => {}
        }
    }

    fn show_tray_menu(&mut self) {
        let Some(at) = self.pending_menu_at.take() else {
            return;
        };
        // The wheel must not be up behind a menu it cannot interact with.
        if self.wheel.open {
            self.close_wheel();
        }
        // Taken out and put back rather than borrowed across the call: `show_menu` runs a modal
        // loop, and the handlers below need `&mut self`.
        let Some(tray) = self.tray.take() else {
            return;
        };
        let chosen = tray.show_menu(at, &self.menu_state());
        self.tray = Some(tray);
        let Some(command) = chosen else {
            return;
        };
        // The two lists first: both decode a RANGE of ids, so neither can be a `match` arm.
        if let Some(index) = tray::workspace_of(command, self.config.workspaces.len()) {
            // Through the wheel, not by assignment: switching rebuilds the root and the picker's
            // level, and a config field set behind the wheel's back is a wheel showing the last
            // workspace's shortcuts under this workspace's name.
            self.wheel.switch_workspace(&mut self.config, index);
            self.dirty = true;
            if let Some(tray) = self.tray.as_ref() {
                tray.update_tip(&self.tray_tip());
            }
            return;
        }
        if let Some(minutes) = tray::pause_minutes_of(command) {
            self.set_pause(true, Some(minutes));
            return;
        }
        match command {
            tray::CMD_OPEN_WHEEL => {
                if self.may_open() {
                    self.open_wheel(TriggerSource::Shortcut);
                }
            }
            tray::CMD_SETTINGS => self.open_settings(),
            tray::CMD_PAUSE => self.set_pause(true, None),
            tray::CMD_RESUME => self.set_pause(false, None),
            tray::CMD_UPDATES => self.updates_from_tray(),
            tray::CMD_QUIT => self.quit = true,
            _ => {}
        }
    }

    /// What the tray menu is told about the program, gathered in one place.
    fn menu_state(&self) -> tray::MenuState<'static> {
        use crate::ui::settings::UpdateState;
        tray::MenuState {
            version: env!("CARGO_PKG_VERSION"),
            workspaces: tray::workspaces_for_menu(
                self.config
                    .workspaces
                    .iter()
                    .map(|workspace| (workspace.name.clone(), workspace.enabled)),
                self.config.active_workspace_index,
            ),
            paused: self.paused,
            minutes_left: self.paused_until.map(|until| {
                // Rounded UP: a pause with forty seconds left has not run out, and a label saying
                // "0 min left" would be describing something that has.
                let left = until.saturating_duration_since(std::time::Instant::now());
                ((left.as_secs() + 59) / 60) as u32
            }),
            update: match self.settings_ui.update_state.as_ref() {
                None => tray::UpdateLine::Idle,
                Some(UpdateState::Checking) => tray::UpdateLine::Checking,
                Some(UpdateState::UpToDate) => tray::UpdateLine::UpToDate,
                Some(UpdateState::Available { version, .. }) => {
                    tray::UpdateLine::Available(version.clone())
                }
                Some(UpdateState::Unreachable) => tray::UpdateLine::Unreachable,
            },
        }
    }

    /// The hover text, which is the only place a pause is visible without opening the menu.
    fn tray_tip(&self) -> String {
        if !self.paused {
            return "Rovyl".into();
        }
        match self.paused_until {
            Some(_) => {
                let minutes = self
                    .menu_state()
                    .minutes_left
                    .unwrap_or(1)
                    .max(1);
                format!("Rovyl \u{2014} paused, {minutes} min left")
            }
            None => "Rovyl \u{2014} triggers paused".into(),
        }
    }

    /// Start, restart or end a pause.
    ///
    /// One function for all four menu items, because the thing that must not be got wrong is that
    /// `paused` and `paused_until` move together: a deadline left behind by a resume is a pause
    /// that comes back on its own.
    fn set_pause(&mut self, paused: bool, minutes: Option<u32>) {
        self.paused = paused;
        self.paused_until = if paused {
            minutes.map(|m| std::time::Instant::now() + std::time::Duration::from_secs(m as u64 * 60))
        } else {
            None
        };
        self.arm_triggers();
        if let Some(tray) = self.tray.as_ref() {
            tray.update_tip(&self.tray_tip());
        }
    }

    /// Let a timed pause run out.
    ///
    /// Called from the loop rather than from a timer, with the loop given a tick to wake on while
    /// one is running — a pause that only ended the next time the user happened to move the mouse
    /// would be a pause that outlasted what it promised.
    fn pump_pause(&mut self) {
        let Some(until) = self.paused_until else {
            return;
        };
        if std::time::Instant::now() >= until {
            self.set_pause(false, None);
        }
    }

    /// The tray's updates line, pressed.
    ///
    /// The same check the panel's row runs, and the same page: there is one updater and this is a
    /// second door to it, not a second copy of it.
    fn updates_from_tray(&mut self) {
        use crate::ui::settings::UpdateState;
        if let Some(UpdateState::Available { url, .. }) = self.settings_ui.update_state.as_ref() {
            crate::launch::open_url(&url.clone());
            return;
        }
        if self.update_check.is_some() {
            return;
        }
        let (sender, receiver) = std::sync::mpsc::channel();
        self.update_check = Some(receiver);
        self.settings_ui.update_state = Some(UpdateState::Checking);
        let _ = std::thread::Builder::new()
            .name("rovyl-updates".into())
            .spawn(move || {
                let _ = sender.send(crate::sys::updates::latest());
            });
    }

    fn on_trigger_down(&mut self, at: POINT) {
        // Pressing the trigger while the wheel is up CLOSES it, on the DOWN, and the matching
        // release is consumed. Without that, the app or workspace under the cursor would be
        // launched by the gesture that was meant to dismiss the wheel.
        if self.wheel.open && !self.wheel.exiting() {
            self.suppress_release = true;
            self.pending_open = None;
            self.close_wheel();
            return;
        }

        let hold = matches!(
            self.config.mouse_trigger_mode,
            Some(config::TriggerMode::Hold)
        ) && trigger::allows_hold(self.config.mouse_trigger_button.as_deref());
        if !hold {
            // Click mode settles everything on the release: the press might still turn out to be a
            // hold, in which case the button is handed back to the window underneath and nothing
            // of ours happens at all.
            return;
        }

        match self.pending_open.take() {
            // A second press inside the deferral window: the gesture was a double-press, which
            // opens Settings instead of the wheel.
            Some((at_time, _)) if at_time.elapsed().as_millis() >= 8 => {
                self.open_settings();
            }
            _ => self.pending_open = Some((Instant::now(), at)),
        }
    }

    fn on_trigger_click(&mut self) {
        if std::mem::take(&mut self.suppress_release) {
            return;
        }
        self.pending_open = None;
        if self.wheel.open {
            return;
        }
        if !self.may_open() {
            return;
        }
        self.open_wheel(TriggerSource::MouseClick);
    }

    fn on_trigger_hold_end(&mut self) {
        if std::mem::take(&mut self.suppress_release) {
            return;
        }
        // A deferral still pending means the press ended before the wheel was due to open: a quick
        // click in hold mode, which the hook has already handed back to the window underneath.
        if self.pending_open.take().is_some() {
            return;
        }
        if !self.wheel.open || self.wheel.exiting() {
            return;
        }
        if matches!(self.wheel.source, TriggerSource::MouseHold) {
            // Disjoint field borrows rather than moving the config in and out: it holds every
            // workspace and every shortcut, and a swap per event would be a deep copy on the path
            // between the hand letting go and the app opening.
            let action = self.wheel.confirm(&mut self.config);
            self.apply(action);
        }
    }

    fn on_pointer(&mut self, w: WPARAM, l: LPARAM) {
        let Some(event) = hook::PointerEvent::from_wparam(w) else {
            return;
        };
        let at = hook::unpack_point(l);
        let bounds = self.overlay.bounds();
        let client = (
            (at.x - bounds.left) as f32,
            (at.y - bounds.top) as f32,
        );
        let action = match event {
            hook::PointerEvent::LeftDown => {
                self.pointer_down = true;
                // A press on the hub may turn out to be a carry. Nothing is decided here --
                // `hub_drag_move` is what the hand decides it with.
                let began = self.wheel.begin_hub_drag(&self.config, (at.x, at.y), client);
                if std::env::var_os("ROVYL_TRACE_CARRY").is_some() {
                    config::store::log_line(&format!(
                        "carry: press at ({:.0},{:.0}) centre ({:.0},{:.0}) hub={} began={began}",
                        client.0, client.1, self.wheel.center.0, self.wheel.center.1,
                        self.wheel.hub_contains(client)
                    ));
                }
                Action::Idle
            }
            hook::PointerEvent::LeftUp => {
                self.pointer_down = false;
                // A carry is not a confirmation. The release that ends one must not also launch
                // whatever the hub happens to be sitting over, and the hub's own action is still
                // owed to a press that never moved -- so only a carry swallows the release.
                if self.wheel.end_hub_drag() {
                    // Worth a line: "the wheel is not where I left it" is a report somebody will
                    // make, and the answer is that they carried it.
                    config::store::log_line(&format!(
                        "carried the wheel to ({:.0}, {:.0})",
                        self.wheel.center.0, self.wheel.center.1
                    ));
                    return;
                }
                // The corners first. A release over a dock icon or the gear belongs to that, and
                // must NOT also confirm whatever slice the aim happens to be on — the original
                // stops the event dead at the dock for exactly this reason.
                if let Some(hit) = crate::wheel::docks::hit(&self.dock_targets, client).cloned() {
                    self.on_dock_hit(hit);
                    return;
                }
                self.wheel.pointer_moved(&self.config, client);
                self.wheel.confirm(&mut self.config)
            }
            // The right button cancels, and it has to be synchronous: a dwell timer survives the
            // window between a cancel and the close.
            hook::PointerEvent::RightDown => {
                self.wheel.begin_exit();
                Action::Close
            }
            hook::PointerEvent::WheelUp => self.wheel.cycle_workspace(&mut self.config, false),
            hook::PointerEvent::WheelDown => self.wheel.cycle_workspace(&mut self.config, true),
        };
        self.apply(action);
    }

    /// Act on a press in the wheel's corners.
    fn on_dock_hit(&mut self, hit: crate::wheel::docks::Hit) {
        use crate::wheel::docks::Hit;
        match hit {
            // A dock icon is an ordinary item and launches through the wheel's own path. One
            // launch path means one place where a failure is reported.
            Hit::Launch(item) => {
                self.pending_launch = Some(item);
                self.wheel.begin_exit();
            }
            // The wheel comes down FIRST and the panel is asked for second. A panel opening behind
            // a wheel that still holds the mouse is a window nobody can reach.
            Hit::OpenPanel(panel) => {
                self.pending_panel = Some(panel);
                self.wheel.begin_exit();
            }
            Hit::SetVolume(percent) => crate::sys::status::set_volume(percent),
            Hit::ToggleMute => {
                let muted = crate::sys::status::latest().muted;
                crate::sys::status::set_muted(!muted);
            }
            Hit::OpenSettings => {
                self.pending_settings = true;
                self.wheel.begin_exit();
            }
        }
    }

    fn on_key(&mut self, vk: u16, _modifiers: u32) {
        use windows::Win32::UI::Input::KeyboardAndMouse as k;
        if !self.wheel.open || self.wheel.exiting() {
            return;
        }
        let action = match vk {
            v if v == k::VK_ESCAPE.0 => {
                self.wheel.begin_exit();
                Action::Close
            }
            v if v == k::VK_BACK.0 => self.wheel.backspace(&mut self.config),
            v if v == k::VK_RETURN.0 => self.wheel.confirm(&mut self.config),
            // Digits launch by position only when asked for; otherwise they filter, which is what
            // makes "Photoshop 2024" findable.
            v if (b'0' as u16..=b'9' as u16).contains(&v) && self.config.number_launch() => {
                self.wheel
                    .launch_number(&mut self.config, (v - b'0' as u16) as usize)
            }
            _ => {
                let typed = char_for(vk);
                match typed {
                    Some(ch) => {
                        // The back key only answers where the hub actually says "Back": one level
                        // deep or more, with nothing typed. At the root the letter is a character
                        // the filter can have, which is what keeps `qBittorrent` reachable.
                        let back = self.config.back_key().to_string();
                        if !back.is_empty()
                            && self.wheel.back_key_active(&self.config)
                            && ch.to_uppercase().next() == back.chars().next()
                        {
                            self.wheel.center_activate(&mut self.config)
                        } else {
                            self.wheel.type_char(&self.config, ch)
                        }
                    }
                    None => Action::Idle,
                }
            }
        };
        self.apply(action);
    }

    fn on_hotkey(&mut self, id: i32) {
        if id == hotkey::ID_TRIGGER {
            let hold = matches!(
                self.config.shortcut_trigger_mode,
                Some(config::ShortcutTriggerMode::Hold)
            );
            if self.wheel.open && !self.wheel.exiting() {
                if !hold {
                    self.close_wheel();
                }
                return;
            }
            if !self.may_open() {
                return;
            }
            self.open_wheel(TriggerSource::Shortcut);
            self.shortcut_held = hold;
            return;
        }
        if id >= hotkey::ID_WORKSPACE_BASE {
            let slot = (id - hotkey::ID_WORKSPACE_BASE) as usize;
            if let Some(Some(index)) = self.workspace_key_slots.get(slot).copied() {
                let action = self.wheel.switch_workspace(&mut self.config, index);
                self.apply(action);
            }
        }
    }

    /// Whether the wheel may open at all right now.
    ///
    /// Focus protection: the wheel stays out of the way while the user is in a fullscreen game. The
    /// check has to be cheap, because it is on the path between the button and the wheel appearing.
    fn may_open(&self) -> bool {
        if !self.config.game_mode.enabled {
            return true;
        }
        !crate::sys::game::should_block(&self.config.game_mode)
    }

    fn open_settings(&mut self) {
        if self.settings.is_none() {
            let scale = monitor::primary().scale();
            match settings::SettingsWindow::create(&self.gpu, scale) {
                Ok(mut window) => {
                    settings::extend_frame(window.hwnd);
                    // Before it is ever shown, not on the first frame: the DWM would otherwise
                    // draw its own border for the frame or two between the window appearing and
                    // the panel painting, which is a white flash around a dark window.
                    window.sync_frame_theme(self.config.theme());
                    self.settings = Some(window);
                }
                Err(error) => {
                    config::store::log_line(&format!("settings window failed: {error}"));
                    return;
                }
            }
        }
        if let Some(window) = self.settings.as_mut() {
            window.show();
        }
    }

    /// Draw one frame of the settings window, and act on what the user did.
    fn settings_frame(&mut self) -> bool {
        let trace = std::env::var_os("ROVYL_TRACE_SETTINGS").is_some();
        let Some(window) = self.settings.as_mut() else {
            return false;
        };
        if !window.visible() {
            return false;
        }
        if window.state.close_requested {
            window.state.close_requested = false;
            window.hide();
            // Closing hides. The app lives in the tray, and a settings window that quit the
            // process would take the launcher with it — which is not what the X on a settings
            // window means anywhere else in Windows.
            if self.dirty {
                self.save();
            }
            return false;
        }
        if !std::mem::take(&mut window.state.needs_frame) {
            return false;
        }
        if let Err(error) = window.sync_surface() {
            if trace { config::store::log_line(&format!("settings: sync_surface {error}")); }
            return false;
        }

        let (width, height) = window.size();
        if width < 1.0 || height < 1.0 {
            return false;
        }
        let scale = window.scale();
        let dpi = window.state.dpi;
        let input = window.state.input.clone();
        window.state.input.end_frame();

        let theme = crate::gfx::palette::surface(self.config.theme());
        // The frame Windows draws around the client area, kept in step with the one we draw
        // inside it. Here rather than at creation because the user can change the theme while
        // the window is open, and a border that stayed dark over a white panel is the same
        // mismatch the other way round.
        window.sync_frame_theme(self.config.theme());
        let bounds = crate::gfx::painter::Rect::new(0.0, 0.0, width, height);
        let maximized = window.state.maximized;

        let painter = match crate::gfx::painter::Painter::new(&self.gpu, &self.glyphs, &self.text) {
            Ok(painter) => painter,
            Err(error) => {
                if trace { config::store::log_line(&format!("settings: painter {error}")); }
                return false;
            }
        };
        let _target = match window.surface.begin_frame(&self.gpu, dpi) {
            Ok(target) => target,
            Err(error) => {
                if trace { config::store::log_line(&format!("settings: begin_frame {error}")); }
                return false;
            }
        };
        if trace {
            config::store::log_line(&format!("settings: drawing {width}x{height} dpi={dpi}"));
        }


        // What a drag is doing over this window, and whatever it let go of.
        //
        // Read and CLEARED here rather than inside the panel, so a drop is handed to exactly one
        // frame: the lock is held by a COM call that can land between any two frames, and a page
        // that took the payload without taking it OUT would import the same files on every frame
        // until the pointer moved.
        let (drag_at, dropped) = match window.drag.as_ref() {
            Some(shared) => match shared.lock() {
                Ok(mut drag) => {
                    let at = (drag.point.0 as f32, drag.point.1 as f32);
                    (
                        drag.hovering.then_some(at),
                        drag.dropped.take().map(|payload| (payload, at)),
                    )
                }
                Err(_) => (None, None),
            },
            None => (None, None),
        };
        self.settings_ui.dropped = dropped;

        let mut frame =
            crate::ui::Frame::new(&painter, &mut self.ui, &input, theme, scale, bounds)
                .with_icons(&self.icons)
                .with_drag(drag_at);
        // The picker's grid pulls its thumbnails through the same cache the wheel uses, so they
        // arrive on a worker and upload on this thread like every other bitmap in the program.
        self.icons.pump(&self.gpu);
        self.settings_ui.shortcut_taken = self.shortcut_taken;
        let version = env!("CARGO_PKG_VERSION");
        let request =
            crate::ui::settings::draw(&mut frame, &mut self.settings_ui, &mut self.config, version);

        // The window buttons go last, over everything, so a dropdown that reached the titlebar
        // cannot swallow the close button.
        let bar = crate::gfx::painter::Rect::new(
            0.0,
            0.0,
            width,
            settings::TITLEBAR_H * scale,
        );
        let pressed = crate::ui::settings::window_buttons(&mut frame, bar, maximized);
        let outcome = frame.outcome;
        let dirty = outcome.dirty;
        let wants_more = outcome.animating;
        let cursor = outcome.cursor;
        drop(_target);

        let _ = window.surface.present(true);
        window.state.caption_buttons =
            crate::ui::settings::caption_buttons(bar, scale).map(|r| windows::Win32::Foundation::RECT {
                left: r.left as i32,
                top: r.top as i32,
                right: r.right as i32,
                bottom: r.bottom as i32,
            });
        window.state.cursor = cursor;
        window.apply_cursor(cursor);

        // A frame that asked for another one has to be given it.
        //
        // The loop below wakes on a timer while `wants_more` holds, but the draw at the top of
        // this function is gated on a DIRTY frame — and nothing in the message queue dirties it
        // when the only thing that changed is the clock. Without this, an animation in the panel
        // ran for exactly one frame unless the pointer happened to be moving over it — so every
        // transition the panel asked for was really a cut, delivered one frame late.
        window.state.needs_frame |= wants_more;

        match pressed {
            Some(0) => window.minimize(),
            Some(1) => window.toggle_maximize(),
            Some(2) => {
                window.hide();
                if dirty || self.dirty {
                    self.dirty = true;
                }
                // Three hundred application names are worth keeping while the panel that shows
                // them is open, and not a byte longer. The scan that rebuilds it is 150 ms, on a
                // worker, the next time somebody opens the picker.
                self.settings_ui.installed = Vec::new();
                self.settings_ui.installed.shrink_to_fit();
            }
            _ => {}
        }

        if dirty {
            self.dirty = true;
            // The wheel reads the same configuration, so a change has to reach it immediately —
            // somebody dragging the radius slider with the wheel open is watching it move.
            self.wheel.relayout(&self.config);
        }
        // The picker wants the list and does not have it. Asked for every frame it is open, which
        // costs a bool and a `is_some` once the scan is running.
        if request.list_apps && self.settings_ui.installed.is_empty() {
            self.begin_discovery();
        }
        self.apply_settings_request(request);
        if self.dirty {
            self.save();
        }
        wants_more
    }

    fn apply_settings_request(&mut self, request: crate::ui::settings::Request) {
        if request.rearm {
            self.arm_triggers();
        }
        if let Some(target) = request.pick_icon.clone() {
            self.pick_icon(target);
        }
        if let Some(mode) = request.pick_path {
            self.pick_path(mode);
        }
        if let Some((path, index)) = request.take_library_icon.clone() {
            self.take_library_icon(&path, index);
        }
        if request.check_updates && self.update_check.is_none() {
            let (sender, receiver) = std::sync::mpsc::channel();
            self.update_check = Some(receiver);
            let wake = self.hwnd.0 as isize;
            std::thread::Builder::new()
                .name("rovyl-updates".into())
                .spawn(move || {
                    let _ = sender.send(crate::sys::updates::latest());
                    unsafe {
                        let _ = windows::Win32::UI::WindowsAndMessaging::PostMessageW(
                            HWND(wake as _),
                            MSG_WORKER,
                            WPARAM(0),
                            LPARAM(0),
                        );
                    }
                })
                .ok();
        }
        if let Some(on) = request.set_autostart {
            crate::sys::autostart::set(on);
        }
        if let Some(url) = request.open_url {
            launch::open_url(&url);
        }
        if let Some(id) = request.preview_sound {
            crate::sys::sound::play(&id, self.config.sound_volume());
        }
        // Acted on when the recording CHANGES, not on every frame.
        //
        // `request.record` is set only on the frame the button was pressed, so reading it directly
        // meant every other frame looked like "not recording" -- which unregistered and
        // re-registered the global hotkey sixty times a second for as long as the panel was open.
        let wanted = self.settings_ui.recording;
        if wanted != self.armed_recording {
            match wanted {
                Some(Recording::MouseButton) => hook::set_recording(true),
                Some(Recording::Shortcut) => {
                    // Release the global binding for the duration. Pressing the shortcut that is
                    // being replaced would otherwise open the wheel over the panel recording it.
                    self.hotkeys.clear_all(self.hwnd);
                    hook::set_recording(false);
                    config::store::log_line("recording: listening for a global shortcut");
                }
                None => {
                    hook::set_recording(false);
                    self.arm_triggers();
                    config::store::log_line(&format!(
                        "recording: stopped, shortcut is {}",
                        self.config.global_shortcut
                    ));
                }
            }
            self.armed_recording = wanted;
        }
        if request.reset {
            // The shipped configuration, and the profile written immediately — a reset that only
            // took effect on the next launch would look like it had failed.
            self.config = config::defaults::ui_config();
            self.user = None;
            self.dirty = true;
            self.arm_triggers();
            self.wheel = crate::wheel::state::Wheel::new(&self.config);
        }
        if request.export {
            crate::sys::transfer::export(&self.config, self.user.as_ref());
        }
        if request.import {
            if let Some(imported) = crate::sys::transfer::import() {
                self.config = imported;
                self.dirty = true;
                self.arm_triggers();
                self.wheel = crate::wheel::state::Wheel::new(&self.config);
            }
        }
    }

    /// Run the timer only while a press is waiting to become an open.
    fn sync_hold_timer(&mut self) {
        let wanted = self.pending_open.is_some();
        if wanted == self.hold_timer {
            return;
        }
        unsafe {
            use windows::Win32::UI::WindowsAndMessaging::{KillTimer, SetTimer};
            if wanted {
                SetTimer(self.hwnd, TIMER_HOLD, 15, None);
            } else {
                let _ = KillTimer(self.hwnd, TIMER_HOLD);
            }
        }
        self.hold_timer = wanted;
    }

    // ── Discovery and icons ─────────────────────────────────────────────────

    /// Scan the Start menu, once, on a profile that has never been scanned.
    ///
    /// The flag is the test, not the emptiness: somebody who deleted every shortcut from Main
    /// meant to, and re-seeding it on the next launch would be the app arguing with them.
    fn begin_discovery_if_needed(&mut self) {
        if self.config.main_start_menu_discovery_done == Some(true) {
            return;
        }
        self.begin_discovery();
    }

    /// Scan, unless one is already running.
    ///
    /// Also what the settings panel's application picker asks for. The same scan answers both,
    /// because they want the same list and running it twice would be 150 ms spent twice.
    fn begin_discovery(&mut self) {
        if self.discovery.is_some() {
            return;
        }
        let (sender, receiver) = std::sync::mpsc::channel();
        self.discovery = Some(receiver);
        // The raw handle, not the `HWND`: a window handle is not `Send`, which is the type
        // system's way of saying "do not use a window from another thread". Posting to one is the
        // one thing that IS safe from anywhere, so the handle is carried as a number and rebuilt
        // on the far side for exactly that call.
        let wake = self.hwnd.0 as isize;
        std::thread::Builder::new()
            .name("rovyl-discovery".into())
            .spawn(move || {
                unsafe {
                    let _ = windows::Win32::System::Com::CoInitializeEx(
                        None,
                        windows::Win32::System::Com::COINIT_APARTMENTTHREADED,
                    );
                }
                let found = crate::sys::discovery::installed();
                let _ = sender.send(found);
                unsafe {
                    let _ = windows::Win32::UI::WindowsAndMessaging::PostMessageW(
                        HWND(wake as _),
                        MSG_WORKER,
                        WPARAM(0),
                        LPARAM(0),
                    );
                }
            })
            .ok();
    }

    /// Take a finished scan and seed the first workspace from it.
    fn collect_discovery(&mut self) {
        let Some(receiver) = self.discovery.as_ref() else {
            return;
        };
        let Ok(apps) = receiver.try_recv() else {
            return;
        };
        self.discovery = None;

        // The picker's copy. Built whatever the scan was started for: the list is the same list,
        // and the settings panel asking for it later would only run the scan again.
        self.settings_ui.installed = apps
            .iter()
            .map(|app| {
                let item = crate::sys::discovery::to_item(app);
                crate::ui::workspace::Installed {
                    id: item.id,
                    label: item.label,
                    command: item.command,
                }
            })
            .collect();

        let first_run = self.config.main_start_menu_discovery_done != Some(true);
        if !first_run {
            return;
        }
        // The flag goes down whatever the scan found. A machine that reports nothing is not a
        // machine to re-scan on every launch.
        self.config.main_start_menu_discovery_done = Some(true);
        self.dirty = true;

        let Some(workspace) = self.config.workspaces.first_mut() else {
            return;
        };
        if !workspace.apps.is_empty() {
            return;
        }
        workspace.apps = crate::sys::discovery::seed(&apps, 8);
        config::store::log_line(&format!(
            "discovery: {} apps found, seeded {} shortcuts",
            apps.len(),
            workspace.apps.len()
        ));
        self.wheel = crate::wheel::state::Wheel::new(&self.config);
    }

    /// Ask for any icon a `native` item is still missing, and apply the ones that arrived.
    ///
    /// Walked from the config rather than from the level on screen, because an icon is worth
    /// having BEFORE the wheel that needs it opens — the first open of a folder should not be the
    /// moment its icons start being fetched.
    fn pump_icons(&mut self) {
        for extracted in self.extractor.drain() {
            if !extracted.reference.is_empty()
                && apply_icon(&mut self.config, &extracted.item_id, &extracted.reference)
            {
                self.dirty = true;
            }
            if let Some(title) = extracted.title {
                if apply_title(&mut self.config, &extracted.item_id, &title) {
                    self.dirty = true;
                    // The wheel is built from the labels, so a name that arrived after it was
                    // built has to rebuild it -- otherwise the change shows up on the next launch.
                    self.wheel.relayout(&self.config);
                }
            }
        }

        // Requests are idempotent per session, so this costs a hash lookup per item.
        let mut wanted: Vec<Missing> = Vec::new();
        collect_missing(&self.config, &mut wanted);
        for item in wanted {
            match item {
                Missing::Shell { id, command } => self.extractor.request(&id, &command),
                Missing::Web { id, url, want_title } => {
                    self.extractor.request_web(&id, &url, want_title)
                }
            }
        }
    }

    /// Take a finished update check and tell the panel what it found.
    fn pump_updates(&mut self) {
        let Some(receiver) = self.update_check.as_ref() else {
            return;
        };
        let Ok(answer) = receiver.try_recv() else {
            return;
        };
        self.update_check = None;
        let current = env!("CARGO_PKG_VERSION");
        self.settings_ui.update_state = Some(match answer {
            Some(release) if crate::sys::updates::is_newer(&release.version, current) => {
                config::store::log_line(&format!(
                    "updates: {} is available (running {current})",
                    release.version
                ));
                crate::ui::settings::UpdateState::Available {
                    version: release.version,
                    url: release.url,
                }
            }
            Some(_) => crate::ui::settings::UpdateState::UpToDate,
            None => crate::ui::settings::UpdateState::Unreachable,
        });
        if let Some(window) = self.settings.as_mut() {
            window.state.needs_frame = true;
        }
    }

    /// Take finished prefetches, and start one for every editor on the level that is showing.
    ///
    /// Called from the loop, where it costs a `try_recv` and a walk of a dozen items. The point is
    /// that by the time somebody aims at their editor, the answer is already here: reading an
    /// MRU is a file scan, and a file scan on the frame that opens a ring is a dropped frame.
    fn pump_recents(&mut self) {
        if let Some(results) = self.recents_results.as_ref() {
            while let Ok((key, items)) = results.try_recv() {
                self.recents_jobs.retain(|k| k != &key);
                if !self.recents_cache.iter().any(|(k, _)| *k == key) {
                    self.recents_cache.push((key, items));
                }
            }
        }
        if !self.wheel.open {
            return;
        }
        let wanted: Vec<(String, String, String)> = self
            .wheel
            .items()
            .iter()
            .filter(|item| {
                item.wants_recents()
                    || crate::sys::recents::looks_like_an_ide(
                        &item.label,
                        &item.command,
                        item.command_type,
                    )
            })
            .map(|item| (recents_key(item), item.label.clone(), item.command.clone()))
            .filter(|(key, _, _)| {
                !self.recents_cache.iter().any(|(k, _)| k == key)
                    && !self.recents_jobs.contains(key)
            })
            .collect();

        for (key, label, command) in wanted {
            let sender = match self.recents_sender.as_ref() {
                Some(sender) => sender.clone(),
                None => {
                    let (sender, receiver) = std::sync::mpsc::channel();
                    self.recents_results = Some(receiver);
                    self.recents_sender = Some(sender.clone());
                    sender
                }
            };
            self.recents_jobs.push(key.clone());
            let wake = self.hwnd.0 as isize;
            std::thread::Builder::new()
                .name("rovyl-recents".into())
                .spawn(move || {
                    let items = crate::sys::recents::fetch(&label, &command);
                    let _ = sender.send((key, items));
                    unsafe {
                        let _ = windows::Win32::UI::WindowsAndMessaging::PostMessageW(
                            HWND(wake as _),
                            MSG_WORKER,
                            WPARAM(0),
                            LPARAM(0),
                        );
                    }
                })
                .ok();
        }
    }

    /// Ask for a picture and put it on whatever the picker was open for.
    ///
    /// The dialog is MODAL: it takes the message loop until the user is done, which is why it runs
    /// here, between frames, rather than from inside one.
    fn pick_icon(&mut self, target: crate::ui::workspace::IconTarget) {
        let owner = self
            .settings
            .as_ref()
            .map(|window| window.hwnd)
            .unwrap_or(self.hwnd);
        let Some(path) = crate::sys::picker::open_file(
            owner,
            "Choose a picture",
            crate::sys::picker::ICON_FILTERS,
        ) else {
            return;
        };

        // A program or a library holds many icons, so the grid opens on it rather than one being
        // picked on the user's behalf. Somebody who browsed to `shell32.dll` wanted to look.
        if crate::sys::picker::is_icon_library(&path) {
            let total = crate::icons::library::count(&path);
            if total > 0 {
                self.settings_ui.icon_library = Some((path, total));
                self.settings_ui.icon_library_row = 0;
                if let Some(window) = self.settings.as_mut() {
                    window.state.needs_frame = true;
                }
                return;
            }
        }

        let stored = decode_picture(&path).map(|reference| (reference, path.display().to_string()));

        let Some((reference, origin)) = stored else {
            config::store::log_line(&format!("icon: could not read {}", path.display()));
            self.show_fault(crate::ui::fault::Fault {
                title: "That file has no picture in it".into(),
                message: "Rovyl could not read an image or an icon out of it.".into(),
                hint: Some("PNG, JPG, BMP, GIF, ICO and the icons inside a program all work.".into()),
                item_id: None,
                workspace: None,
                raw: path.display().to_string(),
            });
            return;
        };

        self.apply_picture(&target, reference, origin);
    }

    /// Browse for the folder or file a new shortcut will open.
    ///
    /// Straight into the draft the add panel is holding, so the chosen path is already in the box
    /// when the dialog closes — there is nothing to confirm and nothing to paste.
    fn pick_path(&mut self, mode: crate::ui::workspace::AddMode) {
        let owner = self
            .settings
            .as_ref()
            .map(|window| window.hwnd)
            .unwrap_or(self.hwnd);
        let chosen = match mode {
            crate::ui::workspace::AddMode::Folder => {
                crate::sys::picker::open_folder(owner, "Choose a folder")
            }
            _ => crate::sys::picker::open_file(
                owner,
                "Choose a file",
                crate::sys::picker::ANY_FILE,
            ),
        };
        let Some(path) = chosen else { return };
        self.settings_ui.draft.target = path.display().to_string();
        if let Some(window) = self.settings.as_mut() {
            window.state.needs_frame = true;
        }
    }

    /// Store one icon out of a library and put it on whatever the picker is open for.
    fn take_library_icon(&mut self, path: &std::path::Path, index: u32) {
        let Some(target) = self.settings_ui.icon_picker.clone() else {
            return;
        };
        let Some((reference, origin)) = crate::icons::library::put(path, index) else {
            return;
        };
        self.apply_picture(&target, reference, origin);
        self.settings_ui.icon_library = None;
    }

    /// Put a chosen picture on a workspace or a shortcut.
    ///
    /// `custom` either way, which is what stops the extractor putting the program's own icon back
    /// on the next pass. That rule is the whole reason the field exists.
    fn apply_picture(
        &mut self,
        target: &crate::ui::workspace::IconTarget,
        reference: String,
        origin: String,
    ) {
        match target {
            crate::ui::workspace::IconTarget::Workspace => {
                if let Some(index) = self.settings_ui.editing_workspace {
                    if let Some(workspace) = self.config.workspaces.get_mut(index) {
                        workspace.picker_icon_url = Some(reference);
                        workspace.picker_icon_file = Some(origin);
                    }
                }
            }
            crate::ui::workspace::IconTarget::Item(id) => {
                if let Some(item) = find_item_mut(&mut self.config, id) {
                    item.custom_icon_url = Some(reference);
                    item.custom_icon_file = Some(origin);
                    item.icon_source = Some(config::IconSource::Custom);
                }
            }
        }
        self.settings_ui.icon_picker = None;
        self.dirty = true;
        self.wheel.relayout(&self.config);
        if let Some(window) = self.settings.as_mut() {
            window.state.needs_frame = true;
        }
    }

    // ── The failure card ────────────────────────────────────────────────────

    fn show_fault(&mut self, fault: crate::ui::fault::Fault) {
        if self.card.is_none() {
            match crate::win::card::Card::create(&self.gpu) {
                Ok(card) => self.card = Some(card),
                Err(error) => {
                    config::store::log_line(&format!("card: create failed {error}"));
                    return;
                }
            }
        }
        // On the monitor the wheel was on, in the corner the docks use.
        let display = monitor::target_display(self.config.monitor_choice(), self.config.placement());
        if let Some(card) = self.card.as_mut() {
            if let Err(error) = card.place_in(display.work_area) {
                config::store::log_line(&format!("card: place failed {error}"));
                return;
            }
        }
        self.fault = Some((fault, std::time::Instant::now()));
        self.fault_copied = false;
    }

    fn hide_fault(&mut self) {
        if let Some(card) = self.card.as_mut() {
            card.hide();
        }
        self.fault = None;
        self.fault_copied = false;
    }

    /// One frame of the card, if it is up. Returns whether it wants another.
    fn card_frame(&mut self) -> bool {
        let trace = std::env::var_os("ROVYL_TRACE_CARD").is_some();
        let Some((fault, since)) = self.fault.clone() else {
            return false;
        };
        let Some(card) = self.card.as_mut() else {
            return false;
        };
        if card.state.dismissed {
            self.hide_fault();
            return false;
        }

        // The clock stops while the pointer is on it: a card somebody is reading must not leave
        // mid-sentence, and a card nobody looked at should not become furniture.
        let hovered = !card.state.input.pointer_outside;
        if !hovered && since.elapsed().as_secs_f32() * 1000.0 > crate::win::card::LINGER_MS {
            self.hide_fault();
            return false;
        }

        if !std::mem::take(&mut card.state.needs_frame) {
            // Still wanted, because the linger clock has to be able to expire with no input.
            return true;
        }
        if trace { config::store::log_line("card: drawing"); }
        if let Err(error) = card.sync_surface(&self.gpu) {
            // Said out loud. A card that cannot size its surface draws nothing, every frame, for
            // ever -- and a silent failure in the thing that reports failures is the worst of
            // both.
            config::store::log_line(&format!("card: sync_surface {error}"));
            return false;
        }

        let (width, height) = card.size();
        if width < 1.0 || height < 1.0 {
            return true;
        }
        let scale = card.scale();
        let dpi = card.state.dpi;
        let input = card.state.input.clone();
        card.state.input.end_frame();

        let Ok(painter) = Painter::new(&self.gpu, &self.glyphs, &self.text) else {
            if trace { config::store::log_line("card: no painter"); }
            return true;
        };
        let theme = crate::gfx::palette::surface(self.config.theme());
        let bounds = crate::gfx::painter::Rect::new(0.0, 0.0, width, height);
        let action = {
            let target = card.surface.begin_frame(&self.gpu, dpi);
            let Ok(_target) = target else {
                if trace { config::store::log_line("card: begin_frame failed"); }
                return true;
            };
            if trace { config::store::log_line(&format!("card: frame {width}x{height} dpi={dpi}")); }
            let mut frame =
                crate::ui::Frame::new(&painter, &mut self.ui, &input, theme, scale, bounds);
            let action = crate::ui::fault::draw(&mut frame, &fault, self.fault_copied);
            drop(frame);
            let _ = card.surface.present(true);
            action
        };
        // Present, THEN show. A composition window revealed before its swapchain has ever been
        // presented puts a black rectangle on screen -- which is exactly what it did.
        card.reveal();

        if action.copy {
            crate::sys::clipboard::put(&fault.raw);
            self.fault_copied = true;
            card.state.needs_frame = true;
        }
        if action.dismiss {
            self.hide_fault();
            return false;
        }
        if action.fix {
            let workspace = fault.workspace;
            let item_id = fault.item_id.clone();
            self.hide_fault();
            self.settings_ui.section = crate::ui::settings::Section::Workspaces;
            self.settings_ui.editing_workspace = workspace;
            self.settings_ui.editing_item = item_id;
            self.open_settings();
            return false;
        }
        true
    }

    // ── Frames ──────────────────────────────────────────────────────────────

    fn render(&mut self) {
        let (width, height) = self.overlay.size();
        if width < 1.0 || height < 1.0 {
            return;
        }
        let display = monitor::from_window(self.overlay.hwnd);
        // The shadows are baked outside the frame: baking re-targets the device context, and a
        // nested draw on one context is invalid.
        // Anything the workers have finished is uploaded before the frame, never during it: a
        // D2D bitmap is a device allocation, and the device is single-threaded by construction.
        self.icons.pump(&self.gpu);
        // Ask for everything this level will draw. Cheap enough to do per frame — a reference the
        // cache already has or has already queued costs three hash lookups and no allocation — and
        // doing it here rather than on the level change means nothing has to remember to call it:
        // a dock icon, the centre button and a late MRU entry are all covered by the same line.
        self.icons.warm(
            self.wheel
                .items()
                .iter()
                .filter_map(|item| item.custom_icon_url.as_deref())
                .collect::<Vec<_>>()
                .into_iter(),
        );
        // The status dock samples while it is on screen; an idle session polls nothing.
        if self.config.status_dock_cfg().needs_sampler() {
            crate::sys::status::poll();
        }
        let bounds = self.overlay.bounds();
        let cursor = hook::cursor();
        // Asked before the frame is built, because asking STARTS the clock that decides when the
        // hint has been on screen long enough to count as read.
        let direction_hint = self.wheel.direction_hint_visible(&self.config);
        let frame = Frame {
            config: &self.config,
            icons: &self.icons,
            shadows: &self.shadows,
            pointer: Some((
                (cursor.x - bounds.left) as f32,
                (cursor.y - bounds.top) as f32,
            )),
            pointer_down: self.pointer_down,
            status: crate::sys::status::latest(),
            update_ready: false,
            discovering: false,
            direction_hint,
            clear_first: true,
        };
        let Ok(painter) = Painter::new(&self.gpu, &self.glyphs, &self.text) else {
            return;
        };
        // Pre-bake anything the frame will need, before `BeginDraw`.
        let at = std::time::Instant::now();
        render::prebake(&painter, &self.wheel, &frame);
        self.split_bake = at.elapsed().as_secs_f32() * 1000.0;

        let Ok(_target) = self.overlay.surface.begin_frame(&self.gpu, display.dpi) else {
            return;
        };
        let targets = render::draw(&painter, &self.wheel, &frame);
        drop(_target);
        self.dock_targets = targets;
    }

    /// Advance everything that moves on its own, and say whether another frame is wanted.
    fn tick(&mut self) -> bool {
        if !self.wheel.open {
            return false;
        }

        // The sustained-aim clock. Firing from a frame rather than from a timer is what makes
        // cancellation free: a wheel that has begun closing never gets another frame to fire in.
        if let Some(first_paint) = self.first_paint {
            let outcome = crate::wheel::dwell::advance(&mut self.wheel, &self.config, first_paint);
            if let crate::wheel::dwell::Outcome::Fire(index) = outcome {
                let action = self.wheel.activate(&mut self.config, index);
                self.apply(action);
            }
        }

        // The keyboard shortcut's hold mode: the release confirms, and a registered hotkey reports
        // only the press, so the release is observed here.
        if self.shortcut_held {
            if let Some(parsed) = hotkey::parse(&self.config.global_shortcut) {
                if !hotkey::key_is_held(&parsed) {
                    self.shortcut_held = false;
                    let action = self.wheel.confirm(&mut self.config);
                    self.apply(action);
                }
            }
        }

        // The pointer, read once per frame from the hook's latest sample. Not posted per move: a
        // 1000 Hz mouse would cost a thousand messages a second to say something the wheel can
        // only act on once per refresh.
        if self.wheel.hub_dragging() {
            // A carry is not an aim. The wheel follows the hand; the hand is not pointing at
            // anything while it does, and resolving an aim against a centre that is moving under
            // it would light a slice for every pixel travelled.
            self.carry_wheel(hook::cursor());
        } else if !self.wheel.exiting() {
            let at = hook::cursor();
            let bounds = self.overlay.bounds();
            let client = (
                (at.x - bounds.left) as f32,
                (at.y - bounds.top) as f32,
            );
            let action = self.wheel.pointer_moved(&self.config, client);
            self.apply(action);

            // A note each time the highlight moves to a different item — not on every sample, and
            // not when it moves to the hub, which has its own note on the open.
            let lit = self.wheel.active();
            if lit != self.last_highlight {
                if self.config.hover_sound_on() && lit.is_some() && self.last_highlight.is_some() {
                    crate::sys::sound::play(
                        &crate::sys::sound::normalize(
                            self.config.radial_hover_sound_id.as_deref(),
                            "thump",
                        ),
                        self.config.sound_volume(),
                    );
                }
                self.last_highlight = lit;
            }
        }

        if let Some(action) = self.wheel.take_direction_hint_seen() {
            self.apply(action);
        }

        // The echo holds the wheel on screen after a confirmation, so the user sees WHICH icon was
        // caught. Only then does the window come down and the command go out.
        if self.pending_launch.is_some() {
            if self.wheel.echo_done() {
                self.finish_close();
                return false;
            }
            return true;
        }

        if self.wheel.exiting() && self.wheel.exit_done() {
            self.finish_close();
            return false;
        }

        true
    }

    /// Whether the loop should ask for frames at all.
    fn needs_frames(&self) -> bool {
        self.wheel.open
    }

    /// Open and close the wheel repeatedly, reporting how long the open took.
    ///
    /// The measurement is the whole of what the user waits for: from the trigger being handled to
    /// the first frame being on screen — window sizing, buffer reallocation, layout, the draw, the
    /// present and the show. It is reported as a distribution rather than an average because the
    /// tail is the part anybody notices.
    /// Do what a first launch does — scan, seed, extract — and report it, then stop.
    ///
    /// This exists because the first-run path is the one path that cannot be tested by using the
    /// app: by the time there is a profile to look at, the scan has already been marked done and
    /// will never run again. Pointing `ROVYL_USER_DATA` at an empty directory and running this is
    /// how the seeding and the icon extraction get exercised at all.
    ///
    /// It runs the SAME methods the message loop runs, rather than its own copy of them. A
    /// first-run test that tests a second implementation of first run tests nothing.
    pub fn seed(&mut self) {
        /// Print and flush.
        ///
        /// Rust block-buffers stdout when it is not a terminal, so a diagnostic that runs for a
        /// minute would otherwise deliver its whole report at exit — which is exactly when it
        /// stops being able to tell you where it got stuck.
        macro_rules! say {
            ($($arg:tt)*) => {{
                use std::io::Write;
                println!($($arg)*);
                let _ = std::io::stdout().flush();
            }};
        }

        let started = std::time::Instant::now();
        say!("profile           {}", config::store::user_data_dir().display());
        say!("discovery done    {:?}", self.config.main_start_menu_discovery_done);

        self.begin_discovery_if_needed();
        // Polling rather than blocking on the channel: `collect_discovery` is the method the
        // message loop calls, and it `try_recv`s. Waiting on the receiver directly would consume
        // the scan and leave nothing for the real path to collect.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while self.discovery.is_some() && std::time::Instant::now() < deadline {
            self.collect_discovery();
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let scanned = started.elapsed();

        let seeded: Vec<(String, String)> = self
            .config
            .workspaces
            .first()
            .map(|w| {
                w.apps
                    .iter()
                    .map(|a| (a.label.clone(), a.command.clone()))
                    .collect()
            })
            .unwrap_or_default();
        say!("scan              {:.0} ms", scanned.as_secs_f64() * 1000.0);
        say!("seeded            {} shortcuts", seeded.len());
        for (label, command) in &seeded {
            // The leaf of the path: a seeded command is a full `C:\...\thing.exe` and what is
            // worth reading back is which exe it resolved to.
            let short: &str = command.rsplit('\\').next().unwrap_or(command.as_str());
            say!("  {label:<28} {short}");
        }

        // Icons. The requests go out on the first pump and the results come back on later ones,
        // so this is the loop the message loop runs, minus the messages.
        self.pump_icons();
        let icons_started = std::time::Instant::now();
        let deadline = icons_started + std::time::Duration::from_secs(60);
        while self.extractor.pending() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
            self.pump_icons();
        }
        self.pump_icons();

        let mut with_icon = 0usize;
        let mut total = 0usize;
        for workspace in &self.config.workspaces {
            count_icons(&workspace.apps, &mut with_icon, &mut total);
        }
        say!(
            "icons             {with_icon}/{total} items have a picture ({:.0} ms)",
            icons_started.elapsed().as_secs_f64() * 1000.0
        );
        let store = config::store::icon_store_dir();
        let on_disk = std::fs::read_dir(&store)
            .map(|entries| entries.flatten().count())
            .unwrap_or(0);
        say!("icon store        {on_disk} files in {}", store.display());

        if self.dirty {
            self.save();
            say!("config            saved");
        }
    }

    pub fn bench(&mut self, rounds: usize) {
        let mut opens: Vec<f32> = Vec::with_capacity(rounds);
        let mut frames: Vec<f32> = Vec::with_capacity(rounds);
        let mut buffers: Vec<f32> = Vec::with_capacity(rounds);
        let mut bakes: Vec<f32> = Vec::with_capacity(rounds);
        let mut draws: Vec<f32> = Vec::with_capacity(rounds);
        let mut presents: Vec<f32> = Vec::with_capacity(rounds);
        let mut shows: Vec<f32> = Vec::with_capacity(rounds);
        for round in 0..rounds {
            let at = Instant::now();
            self.open_wheel(TriggerSource::Shortcut);
            opens.push(at.elapsed().as_secs_f32() * 1000.0);
            buffers.push(self.split_buffers);
            bakes.push(self.split_bake);
            draws.push(self.split_draw);
            presents.push(self.split_present);
            shows.push(self.split_show);

            // One steady-state frame, which is what the wheel costs while the hand is moving.
            let at = Instant::now();
            self.render();
            let _ = self.overlay.present(false);
            frames.push(at.elapsed().as_secs_f32() * 1000.0);

            self.wheel.begin_exit();
            self.finish_close();
            // The first round pays for every lazily-built cache — glyph geometries, text layouts,
            // the shadow bake. It is reported separately rather than averaged in, because it
            // happens once per session and the other thousand opens are what the product feels
            // like.
            if round == 0 {
                println!("cold open        {:.2} ms", opens[0]);
                println!("cold frame       {:.2} ms", frames[0]);
                opens.clear();
                frames.clear();
                buffers.clear();
                bakes.clear();
                draws.clear();
                presents.clear();
                shows.clear();
            }
        }
        report("warm open", &mut opens);
        println!("  of which:");
        report("  buffers", &mut buffers);
        report("  prebake", &mut bakes);
        report("  draw", &mut draws);
        report("  present", &mut presents);
        report("  ShowWindow", &mut shows);
        report("warm frame", &mut frames);
    }

    // ── The loop ────────────────────────────────────────────────────────────

    pub fn run(&mut self) {
        // A launch the user made on purpose has somewhere to go: there is nothing else to show
        // them. A login start (`--tray`) does not, and must not put a window in front of whatever
        // they were doing when they signed in.
        let args: Vec<String> = std::env::args().collect();
        if !instance::starts_in_tray(&args) && !args.iter().any(|a| a == "--open-now") {
            self.open_settings();
        }
        // The login entry and the stored switch can disagree after the app is moved or
        // reinstalled to a different path. The config's value is what the user chose.
        crate::sys::autostart::reconcile(self.config.open_at_login == Some(true));
        self.begin_discovery_if_needed();

        // `--open-now` puts the wheel up on launch, with no trigger. It exists so the renderer
        // can be looked at on a machine where another build already holds the global shortcut,
        // which is the normal state of affairs while this port is being written.
        if std::env::args().any(|a| a == "--open-now") {
            self.open_wheel(TriggerSource::Shortcut);
        }

        while !self.quit {
            if !self.pump() {
                break;
            }

            // Both are cheap when there is nothing to do, and both have to happen off the wheel's
            // critical path — a scan takes 150 ms and an extraction can take tens.
            self.collect_discovery();
            self.pump_icons();
            self.pump_recents();
            self.pump_updates();
            self.pump_pause();

            // The deferred open, checked off the timer rather than from a frame — the wheel is
            // not up yet, so there are no frames.
            if let Some((at, _)) = self.pending_open {
                if at.elapsed().as_millis() as u32 >= HOLD_OPEN_DELAY_MS {
                    self.pending_open = None;
                    if self.may_open() {
                        self.open_wheel(TriggerSource::MouseHold);
                    }
                }
            }
            self.sync_hold_timer();

            // The settings window draws on demand rather than every iteration: it is an ordinary
            // window and most frames have nothing new in them.
            let settings_wants_more = self.settings_frame();
            let card_wants_more = self.card_frame();

            if self.needs_frames() {
                let wants_more = self.tick();
                if wants_more {
                    self.render();
                    let _ = self.overlay.present(true);
                }
                // Wait on the swapchain's frame-latency object alongside the message queue. This is
                // what paces rendering to the display without a timer and without polling — and
                // why an animating wheel costs one wake-up per refresh rather than one per
                // millisecond.
                unsafe {
                    use windows::Win32::UI::WindowsAndMessaging::{
                        MsgWaitForMultipleObjectsEx, MWMO_INPUTAVAILABLE, QS_ALLINPUT,
                    };
                    let handles = [self.overlay.surface.frame_latency_waitable];
                    let _ = MsgWaitForMultipleObjectsEx(
                        Some(&handles),
                        100,
                        QS_ALLINPUT,
                        MWMO_INPUTAVAILABLE,
                    );
                }
            } else if settings_wants_more {
                // Something in the panel is animating — a drag, a toast, a caret. Paced to the
                // display, like the wheel.
                unsafe {
                    use windows::Win32::UI::WindowsAndMessaging::{
                        MsgWaitForMultipleObjectsEx, MWMO_INPUTAVAILABLE, QS_ALLINPUT,
                    };
                    let _ = MsgWaitForMultipleObjectsEx(None, 16, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
                }
            } else if card_wants_more {
                // A card is up. It has nothing to animate, but its linger clock has to be able to
                // run out with no input at all -- so this wakes four times a second rather than
                // sixty, which is as precise as "about twelve seconds" needs to be.
                unsafe {
                    use windows::Win32::UI::WindowsAndMessaging::{
                        MsgWaitForMultipleObjectsEx, MWMO_INPUTAVAILABLE, QS_ALLINPUT,
                    };
                    let _ = MsgWaitForMultipleObjectsEx(None, 250, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
                }
            } else if self.paused_until.is_some() {
                // A timed pause has to be able to run out with nothing happening at all, and
                // `WaitMessage` would sit there until the user next touched something. Once a
                // second, which is as precise as a label reading "12 min left" needs to be, and
                // only while a pause is actually counting down.
                unsafe {
                    use windows::Win32::UI::WindowsAndMessaging::{
                        MsgWaitForMultipleObjectsEx, MWMO_INPUTAVAILABLE, QS_ALLINPUT,
                    };
                    let _ = MsgWaitForMultipleObjectsEx(None, 1000, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
                }
            } else {
                // Nothing is moving: block. Zero wake-ups and zero CPU for the hours between
                // gestures, which is most of what a launcher's resident cost is.
                unsafe {
                    let _ = WaitMessage();
                }
            }
        }

        hook::shutdown();
        self.hotkeys.clear_all(self.hwnd);
        if self.dirty {
            self.save();
        }
    }

    /// Drain the message queue. `false` means quit.
    fn pump(&mut self) -> bool {
        unsafe {
            let mut msg = MSG::default();
            // Bounded, deliberately.
            //
            // A window whose update region is never validated makes `PeekMessage` synthesise
            // `WM_PAINT` forever, and an unbounded drain then never returns — a pegged core with
            // nothing in the logs to say why. Both windows validate their own region now, so this
            // ceiling should be unreachable; it is here because the failure it prevents is a hang
            // rather than a glitch, and a frame skipped under a genuine message flood is invisible.
            let mut drained = 0u32;
            while drained < 4096 && PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                drained += 1;
                if msg.message == WM_QUIT {
                    return false;
                }
                // Messages addressed to this window are handled directly; everything else goes
                // through the normal path so the overlay and any future window still work.
                if msg.hwnd == self.hwnd || msg.hwnd.is_invalid() {
                    self.on_message(msg.message, msg.wParam, msg.lParam);
                } else {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
        }
        !self.quit
    }
}

/// Hand the process's resident pages back to the system.
///
/// A launcher spends almost all of its life doing nothing, and what it holds while doing nothing is
/// the number that matters. The pages are not DISCARDED — they go to the standby list, so the next
/// gesture faults the ones it needs back in without touching the disk in the common case, and the
/// rest stay available to whatever the user is actually running.
///
/// Called on the close, not on a timer: that is the moment the wheel's working set is at its peak
/// and the user's attention has already moved to the thing they launched.
fn release_working_set() {
    unsafe {
        use windows::Win32::System::Threading::{GetCurrentProcess, SetProcessWorkingSetSize};
        // `usize::MAX` for both bounds is the documented way to ask for a trim rather than to set
        // a quota.
        let _ = SetProcessWorkingSetSize(GetCurrentProcess(), usize::MAX, usize::MAX);
    }
}

/// Print a distribution. Sorts in place.
fn report(name: &str, samples: &mut Vec<f32>) {
    if samples.is_empty() {
        return;
    }
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let at = |q: f32| samples[((samples.len() - 1) as f32 * q).round() as usize];
    println!(
        "{name:<16} min {:.2}  p50 {:.2}  p95 {:.2}  max {:.2} ms   ({} samples)",
        samples[0],
        at(0.5),
        at(0.95),
        samples[samples.len() - 1],
        samples.len()
    );
}

/// Something an item is missing, and where to go and get it.
enum Missing {
    Shell { id: String, command: String },
    Web { id: String, url: String, want_title: bool },
}

/// Every `native` item that has a command and still no picture.
///
/// An item whose `icon_source` is `custom` is never touched: the user chose it, and nothing
/// automatic may replace it. That rule is why the field exists at all.
///
/// A web shortcut is asked of the icon services instead of the shell, and is asked for its name
/// as well when it is still wearing the one it was born with -- a URL labelled with its hostname
/// puts `github.com` on the wheel where the page itself says "GitHub".
fn collect_missing(config: &config::UiConfig, out: &mut Vec<Missing>) {
    fn walk(items: &[config::AppItem], out: &mut Vec<Missing>) {
        for item in items {
            let wants = matches!(item.icon_source, Some(config::IconSource::Native))
                && item.custom_icon_url.is_none()
                && !item.command.trim().is_empty();
            let is_web = matches!(item.command_type, Some(config::CommandType::Url));
            if is_web {
                // The name is asked for only while the label is still the host. Anything the user
                // typed is theirs, and a page title arriving on top of it is the program arguing.
                let host = crate::sys::web::host_of(&crate::sys::web::with_scheme(&item.command));
                let unnamed = host
                    .as_deref()
                    .is_some_and(|host| item.label.eq_ignore_ascii_case(host));
                if wants || unnamed {
                    out.push(Missing::Web {
                        id: item.id.clone(),
                        url: item.command.clone(),
                        want_title: unnamed,
                    });
                }
            } else if wants {
                out.push(Missing::Shell {
                    id: item.id.clone(),
                    command: item.command.clone(),
                });
            }
            walk(item.child_slice(), out);
        }
    }
    for workspace in &config.workspaces {
        walk(&workspace.apps, out);
    }
    if let Some(dock) = config.shortcut_dock.as_ref() {
        walk(&dock.items, out);
    }
}

/// Put a fetched page title on the item it was for. Returns whether anything changed.
///
/// Only over a label that is still the hostname, checked again here because the fetch takes a
/// second or two and the user may have typed a name of their own while it was in flight.
fn apply_title(config: &mut config::UiConfig, item_id: &str, title: &str) -> bool {
    fn walk(items: &mut [config::AppItem], item_id: &str, title: &str) -> bool {
        let mut changed = false;
        for item in items.iter_mut() {
            if item.id == item_id {
                let host = crate::sys::web::host_of(&crate::sys::web::with_scheme(&item.command));
                let still_unnamed = host
                    .as_deref()
                    .is_some_and(|host| item.label.eq_ignore_ascii_case(host));
                if still_unnamed && !title.trim().is_empty() {
                    item.label = title.trim().to_string();
                    changed = true;
                }
            }
            if let Some(children) = item.children.as_mut() {
                changed |= walk(children, item_id, title);
            }
        }
        changed
    }
    let mut changed = false;
    for workspace in config.workspaces.iter_mut() {
        changed |= walk(&mut workspace.apps, item_id, title);
    }
    if let Some(dock) = config.shortcut_dock.as_mut() {
        changed |= walk(&mut dock.items, item_id, title);
    }
    changed
}

/// Put an extracted icon on the item it was for. Returns whether anything changed.
fn apply_icon(config: &mut config::UiConfig, item_id: &str, reference: &str) -> bool {
    fn walk(items: &mut [config::AppItem], item_id: &str, reference: &str) -> bool {
        let mut changed = false;
        for item in items.iter_mut() {
            if item.id == item_id && item.custom_icon_url.is_none() {
                item.custom_icon_url = Some(reference.to_string());
                changed = true;
            }
            if let Some(children) = item.children.as_mut() {
                changed |= walk(children, item_id, reference);
            }
        }
        changed
    }
    let mut changed = false;
    for workspace in config.workspaces.iter_mut() {
        changed |= walk(&mut workspace.apps, item_id, reference);
    }
    if let Some(dock) = config.shortcut_dock.as_mut() {
        changed |= walk(&mut dock.items, item_id, reference);
    }
    changed
}

/// How many items carry a picture — the thing `--seed` is actually checking.
fn count_icons(items: &[config::AppItem], with_icon: &mut usize, total: &mut usize) {
    for item in items {
        *total += 1;
        if item.custom_icon_url.is_some() {
            *with_icon += 1;
        }
        count_icons(item.child_slice(), with_icon, total);
    }
}

/// A shortcut's identity for the recents cache.
///
/// The label AND the command: the profile a shortcut resolves to depends on both, and two items
/// pointing at different editors can carry the same label after a rename.
fn recents_key(item: &config::AppItem) -> String {
    format!("{}||{}", item.label, item.command)
}

/// Decode a picture file and put it in the store, normalised the way every other icon is.
fn decode_picture(path: &std::path::Path) -> Option<String> {
    let (pixels, width, height) = crate::gfx::encode::decode_file(path).ok()?;
    if width == 0 || height == 0 {
        return None;
    }
    let bytes = crate::gfx::encode::encode_png(&pixels, width, height).ok()?;
    crate::icons::store::put(&bytes, "png").ok()
}

/// One item anywhere in the configuration, by id.
fn find_item_mut<'a>(config: &'a mut config::UiConfig, id: &str) -> Option<&'a mut config::AppItem> {
    fn walk<'a>(items: &'a mut [config::AppItem], id: &str) -> Option<&'a mut config::AppItem> {
        for item in items.iter_mut() {
            if item.id == id {
                return Some(item);
            }
            if let Some(children) = item.children.as_mut() {
                // Recursing into the borrow this way needs the early return above to have taken
                // the simple case first; the folder's own id is checked before its contents.
                if let Some(found) = walk(children, id) {
                    return Some(found);
                }
            }
        }
        None
    }
    for workspace in config.workspaces.iter_mut() {
        if let Some(found) = walk(&mut workspace.apps, id) {
            return Some(found);
        }
    }
    if let Some(dock) = config.shortcut_dock.as_mut() {
        return walk(&mut dock.items, id);
    }
    None
}

fn create_message_window() -> Result<HWND> {
    unsafe {
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(app_proc),
            hInstance: windows::Win32::System::LibraryLoader::GetModuleHandleW(None)
                .unwrap_or_default()
                .into(),
            lpszClassName: CLASS_NAME,
            ..Default::default()
        };
        RegisterClassExW(&class);
        CreateWindowExW(
            // A tool window so it never appears anywhere, and never shown at all. It exists only
            // to own a message queue, a hotkey registration and a timer.
            WS_EX_TOOLWINDOW,
            CLASS_NAME,
            w!("Rovyl"),
            WS_POPUP,
            0,
            0,
            0,
            0,
            None,
            None,
            None,
            None,
        )
    }
}

/// The `TaskbarCreated` id, looked up once.
///
/// [`app_proc`] needs it and has no `App` to read it from — it is a free function, and it runs
/// before the one in `App::new` exists. `RegisterWindowMessageW` is a string lookup in a global
/// table, which is not something to do for every message a window receives.
fn taskbar_created() -> u32 {
    static ID: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
    *ID.get_or_init(tray::taskbar_created_message)
}

/// Whether a message that arrived SENT has to be put back into the queue for [`App::pump`].
///
/// **The bug this exists for.** `PeekMessage` returns POSTED messages and nothing else. A message
/// another process SENDS is handed straight to the window procedure while the peek is running and
/// never enters the queue at all — so it reached `app_proc`, fell through to `DefWindowProc`, and
/// went no further. The whole notification area is sent rather than posted: every click on the
/// icon, `TaskbarCreated`, and `WM_DISPLAYCHANGE` with it. The icon was inert — no menu on a right
/// click, no settings on a double click, nothing at all — and the handlers for them in
/// [`App::on_message`] had never once run.
///
/// The icon's own `WM_MOUSEMOVE` is deliberately left out. It is most of what the callback ever
/// says — one for every position the pointer passes over the icon — nothing acts on it, and
/// forwarding it would wake the loop out of `WaitMessage` for each one.
fn forwards_to_the_pump(message: u32, l: LPARAM) -> bool {
    if message == tray::MSG_TRAY {
        return (l.0 as u32) & 0xFFFF != WM_MOUSEMOVE;
    }
    message == WM_DISPLAYCHANGE || message == taskbar_created()
}

unsafe extern "system" fn app_proc(hwnd: HWND, message: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    // Posted back to this same window, unchanged, so the main loop finds it the way it finds
    // everything else. `InSendMessage` is what keeps this from looping forever: it is true only
    // while the procedure is handling a message sent from ANOTHER thread, and the copy posted here
    // comes back through `DispatchMessage` on this one — where it is left alone.
    if InSendMessage().as_bool() && forwards_to_the_pump(message, l) {
        let _ = PostMessageW(hwnd, message, w, l);
        return LRESULT(0);
    }
    match message {
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, message, w, l),
    }
}

/// The character a virtual key prints, for the wheel's filter.
///
/// `ToUnicode` rather than a table, because the filter has to accept what the user's LAYOUT
/// prints: the physical Q is `q` on QWERTY, `a` on AZERTY and `й` on ЙЦУКЕН, and somebody typing
/// to filter means the character they see on the key.
fn char_for(vk: u16) -> Option<char> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyboardLayout, GetKeyboardState, ToUnicodeEx};
    unsafe {
        let mut state = [0u8; 256];
        if GetKeyboardState(&mut state).is_err() {
            return None;
        }
        // The modifiers are cleared before translating: the wheel's filter takes the bare
        // character, and leaving Shift set would turn a typed letter into its upper case — which
        // the filter lowercases again anyway, at the cost of a wrong character on any layout where
        // Shift produces a different glyph.
        let layout = GetKeyboardLayout(0);
        let mut buffer = [0u16; 8];
        let written = ToUnicodeEx(
            vk as u32,
            0,
            &state,
            &mut buffer,
            // Do not change the keyboard state: a dead key left in the layout's buffer would
            // compose with the next keystroke typed into a real application.
            1 << 2,
            layout,
        );
        if written <= 0 {
            return None;
        }
        char::decode_utf16(buffer[..written as usize].iter().copied())
            .next()?
            .ok()
            .filter(|c| !c.is_control())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::UI::WindowsAndMessaging::{WM_CONTEXTMENU, WM_LBUTTONDBLCLK};

    /// A tray callback as the shell packs one: the event in the low word, the icon id in the high.
    fn tray_callback(event: u32) -> LPARAM {
        LPARAM((1isize << 16) | event as isize)
    }

    #[test]
    fn everything_the_shell_sends_is_put_back_into_the_queue() {
        // The bug this exists for: a sent message never comes out of `PeekMessage`, so the only
        // way the main loop can act on one is if the window procedure posts it back. Miss one and
        // the feature behind it is silently dead — the tray icon was, in full.
        assert!(forwards_to_the_pump(tray::MSG_TRAY, tray_callback(tray::NIN_SELECT)));
        assert!(forwards_to_the_pump(tray::MSG_TRAY, tray_callback(tray::NIN_KEYSELECT)));
        assert!(forwards_to_the_pump(tray::MSG_TRAY, tray_callback(WM_CONTEXTMENU)));
        assert!(forwards_to_the_pump(tray::MSG_TRAY, tray_callback(WM_LBUTTONDBLCLK)));
        assert!(forwards_to_the_pump(WM_DISPLAYCHANGE, LPARAM(0)));
        assert!(forwards_to_the_pump(taskbar_created(), LPARAM(0)));
    }

    #[test]
    fn the_icons_own_mouse_moves_are_not() {
        // One for every position the pointer passes over the icon, and nothing reads them.
        // Forwarded, they would wake the loop out of `WaitMessage` for each one — which is the
        // whole cost the loop is shaped to avoid.
        assert!(!forwards_to_the_pump(tray::MSG_TRAY, tray_callback(WM_MOUSEMOVE)));
    }

    #[test]
    fn an_ordinary_message_is_left_to_the_default_procedure() {
        // Forwarding indiscriminately would post a copy of everything the window is sent, and
        // `DefWindowProc` would never see the original.
        for message in [WM_CLOSE, WM_DESTROY, WM_HOTKEY, MSG_WORKER] {
            assert!(!forwards_to_the_pump(message, LPARAM(0)), "{message:#X}");
        }
    }
}
