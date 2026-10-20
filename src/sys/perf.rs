//! The performance trace: what the frame loop did, a second at a time, written for a machine that
//! is not this one.
//!
//! **Why it exists.** "It lags" cannot be reproduced on the machine the program is written on. The
//! monitor's refresh rate, the mouse's polling rate, the GPU and whatever else is drawing on it
//! are the user's, and those are what decide it. Start the app with `ROVYL_TRACE_PERF=1` and it
//! writes `rovyl-perf.log` beside the configuration: a header describing the machine, then one
//! line for every second in which a window wanted frames. `scripts/collect-diagnostics.bat` sets
//! the variable and collects the file.
//!
//! **Reading a line.** For each window: frames drawn, and frames DEFERRED — wanted on a wake-up
//! that came before the window could draw, because the display had not refreshed yet or the
//! compositor had not taken the last frame. Then the drawing time, and LATE frames: ones the
//! compositor took longer than a refresh to take, with how long it did take. Then why the loop
//! woke, how many mouse moves the hook saw (the mouse's polling rate, while it is moving), and
//! which window `WM_MOUSEMOVE` was delivered to.
//!
//! A healthy second draws no more frames than the display refreshes and has nothing late. Many
//! late frames with long "took" times is a compositor starved by something else on the GPU.
//!
//! Off, every call is one branch on a flag read once. On, it is the UI thread's alone, which is
//! why the state is thread-local rather than locked.

use crate::gfx::device::Gpu;
use std::cell::RefCell;
use std::fs::File;
use std::io::Write;
use std::sync::OnceLock;
use std::time::Instant;

pub const LOG_FILE: &str = "rovyl-perf.log";

/// The windows that draw frames.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Surface {
    Wheel = 0,
    Settings = 1,
    Card = 2,
}

const SURFACES: [&str; 3] = ["wheel", "settings", "card"];

/// Why a wait in the loop ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wake {
    /// A frame-latency object was signalled: the compositor took a frame.
    Frame = 0,
    /// The frame clock: a window may draw again.
    Clock = 1,
    /// A message arrived.
    Input = 2,
    /// Nothing happened before the timeout.
    Timeout = 3,
}

/// Where a `WM_MOUSEMOVE` was delivered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Overlay = 0,
    Settings = 1,
    Other = 2,
}

#[derive(Default, Clone, Copy)]
struct Counts {
    drawn: u32,
    deferred: u32,
    draw_total: f32,
    draw_max: f32,
    late: u32,
    late_total: f32,
    late_max: f32,
}

struct Trace {
    file: File,
    started: Instant,
    second: Instant,
    surfaces: [Counts; 3],
    wakes: [u32; 4],
    moves_to: [u32; 3],
}

thread_local! {
    static TRACE: RefCell<Option<Trace>> = const { RefCell::new(None) };
}

pub fn enabled() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("ROVYL_TRACE_PERF").is_some())
}

/// Open the file and describe the machine. `startup_ms` is how long the app took to come up.
pub fn begin(gpu: &Gpu, config: &crate::config::UiConfig, startup_ms: f32) {
    if !enabled() {
        return;
    }
    let dir = crate::config::store::user_data_dir();
    let _ = std::fs::create_dir_all(&dir);
    // Truncated, not appended: the trace describes one session, and a file that grew across
    // every session would bury it.
    let Ok(mut file) = File::create(dir.join(LOG_FILE)) else {
        return;
    };
    let _ = writeln!(file, "Rovyl {} performance trace", env!("CARGO_PKG_VERSION"));
    let _ = writeln!(file, "gpu       {}", adapter(gpu));
    for display in crate::win::monitor::displays() {
        let _ = writeln!(
            file,
            "display   {}x{} @ {} Hz, {} dpi{}",
            display.bounds.right - display.bounds.left,
            display.bounds.bottom - display.bounds.top,
            crate::win::monitor::refresh_hz(display.handle),
            display.dpi,
            if display.is_primary { ", primary" } else { "" },
        );
    }
    let shortcuts: usize = config.workspaces.iter().map(|w| w.apps.len()).sum();
    let _ = writeln!(
        file,
        "config    {} workspaces ({} enabled), {shortcuts} shortcuts, full-bleed {}, status dock {}",
        config.workspaces.len(),
        config.enabled_workspace_count(),
        config.needs_full_bleed(),
        config.status_dock_cfg().needs_sampler(),
    );
    let _ = writeln!(file, "startup   {startup_ms:.0} ms");
    let _ = writeln!(file);
    let now = Instant::now();
    TRACE.with(|trace| {
        *trace.borrow_mut() = Some(Trace {
            file,
            started: now,
            second: now,
            surfaces: [Counts::default(); 3],
            wakes: [0; 4],
            moves_to: [0; 3],
        });
    });
}

fn with(f: impl FnOnce(&mut Trace)) {
    if !enabled() {
        return;
    }
    TRACE.with(|trace| {
        if let Some(trace) = trace.borrow_mut().as_mut() {
            f(trace);
        }
    });
}

/// A frame was drawn and presented. `late_ms` is how long the compositor took to take the frame
/// before it, when that was longer than a refresh.
pub fn drew(surface: Surface, draw_ms: f32, late_ms: Option<f32>) {
    with(|trace| {
        let counts = &mut trace.surfaces[surface as usize];
        counts.drawn += 1;
        counts.draw_total += draw_ms;
        counts.draw_max = counts.draw_max.max(draw_ms);
        if let Some(late) = late_ms {
            counts.late += 1;
            counts.late_total += late;
            counts.late_max = counts.late_max.max(late);
        }
    });
}

/// A frame was wanted on a wake-up that came before the window could draw one.
pub fn deferred(surface: Surface) {
    with(|trace| trace.surfaces[surface as usize].deferred += 1);
}

/// A wait in the loop ended.
pub fn woke(why: Wake) {
    with(|trace| trace.wakes[why as usize] += 1);
}

/// A `WM_MOUSEMOVE` came out of the queue.
pub fn mouse_message(target: Target) {
    with(|trace| trace.moves_to[target as usize] += 1);
}

/// Something worth a line of its own — the wheel opening, the settings window showing.
pub fn note(text: &str) {
    with(|trace| {
        let at = trace.started.elapsed().as_secs_f32();
        let _ = writeln!(trace.file, "[{at:8.3}s] {text}");
    });
}

/// Write the second that just ended, if any window wanted frames in it. Called every turn of the
/// loop; does nothing until a second has passed.
pub fn flush() {
    with(|trace| {
        if trace.second.elapsed().as_millis() < 1000 {
            return;
        }
        let elapsed = trace.second.elapsed().as_secs_f32();
        trace.second = Instant::now();
        let moves = crate::input::hook::take_moves();
        if trace.surfaces.iter().any(|c| c.drawn > 0 || c.deferred > 0) {
            let at = trace.started.elapsed().as_secs_f32();
            let mut line = format!("[{at:8.3}s]");
            for (name, c) in SURFACES.iter().zip(trace.surfaces.iter()) {
                if c.drawn == 0 && c.deferred == 0 {
                    continue;
                }
                line.push_str(&format!(
                    " {name}: {} drawn, {} deferred, draw {:.1}/{:.1} ms",
                    c.drawn,
                    c.deferred,
                    c.draw_total / c.drawn.max(1) as f32,
                    c.draw_max,
                ));
                if c.late > 0 {
                    line.push_str(&format!(
                        ", {} late (took {:.0}/{:.0} ms)",
                        c.late,
                        c.late_total / c.late as f32,
                        c.late_max,
                    ));
                }
                line.push_str(" |");
            }
            let [frame, clock, input, timeout] = trace.wakes;
            line.push_str(&format!(
                " woke on frame {frame}, clock {clock}, input {input}, timeout {timeout} | mouse {:.0}/s, moves to overlay {}, settings {}, other {}",
                moves as f32 / elapsed,
                trace.moves_to[0],
                trace.moves_to[1],
                trace.moves_to[2],
            ));
            let _ = writeln!(trace.file, "{line}");
        }
        trace.surfaces = [Counts::default(); 3];
        trace.wakes = [0; 4];
        trace.moves_to = [0; 3];
    });
}

/// The adapter the device was made on. Microsoft's vendor id there means WARP — every frame drawn
/// on the CPU — which is the first thing to rule out on a machine that lags.
fn adapter(gpu: &Gpu) -> String {
    use windows::core::Interface;
    use windows::Win32::Graphics::Dxgi::IDXGIDevice;
    unsafe {
        let Ok(device) = gpu.d3d.cast::<IDXGIDevice>() else {
            return "unknown".into();
        };
        let Ok(adapter) = device.GetAdapter() else {
            return "unknown".into();
        };
        let Ok(desc) = adapter.GetDesc() else {
            return "unknown".into();
        };
        let end = desc.Description.iter().position(|&c| c == 0).unwrap_or(desc.Description.len());
        let name = String::from_utf16_lossy(&desc.Description[..end]);
        let software = if desc.VendorId == 0x1414 { " - SOFTWARE RENDERING" } else { "" };
        format!(
            "{name} (vendor {:04x}, device {:04x}, {} MB){software}",
            desc.VendorId,
            desc.DeviceId,
            desc.DedicatedVideoMemory / (1024 * 1024),
        )
    }
}
