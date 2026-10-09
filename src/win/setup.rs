//! The window somebody sees when they run the downloaded `Rovyl-Setup-x.y.z.exe`.
//!
//! **Why there is a window at all.** The silent path — the one the 1.x updater drives — shows
//! nothing, and for a long time that was the whole story: this executable installs itself, so a
//! person could have been shown nothing too. But a setup file that is double-clicked and appears
//! to do nothing is a setup file people run three more times, and then report as broken. One
//! window, one button, one sentence about what happens to their workspaces.
//!
//! **Why it is a `WS_POPUP` and not the settings window's frame.** Nothing here resizes, snaps,
//! maximises or minimises, so none of what `WS_OVERLAPPEDWINDOW` buys is worth the non-client
//! plumbing that comes with it. It is a plate: a fixed rectangle, drawn edge to edge by the same
//! painter as everything else, draggable by its top strip, with `WS_EX_APPWINDOW` so it still has
//! a taskbar button to come back to.
//!
//! **Why the install runs on a worker.** It deletes a 180 MB Electron folder, and a window that
//! stops answering the mouse while it does that is a window Windows paints over with "not
//! responding". The thread posts its answer into a slot; a timer wakes the loop to notice.

use crate::gfx::device::{Gpu, Surface};
use crate::gfx::lucide::GlyphCache;
use crate::gfx::painter::{Painter, Rect};
use crate::gfx::text::TextCache;
use crate::ui::setup::{Stage, WINDOW_H, WINDOW_W};
use crate::ui::{Cursor, Input, Ui};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use windows::core::{w, PCWSTR, Result};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
};
use windows::Win32::Graphics::Gdi::{ScreenToClient, ValidateRect, HBRUSH};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Controls::WM_MOUSELEAVE;
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Input::KeyboardAndMouse::{TrackMouseEvent, TME_LEAVE, TRACKMOUSEEVENT};
use windows::Win32::UI::WindowsAndMessaging::*;

const CLASS_NAME: PCWSTR = w!("RovylSetup");

/// The timer that keeps frames coming while the worker thread is busy.
const TICK: usize = 1;

/// How tall the strip at the top of the window is that drags it, in DIPs.
///
/// A plate with no titlebar still has to be movable, and this is the part of it that reads as one.
/// It stops short of the close affordance: a caption that covered the X would make the X
/// undraggable AND unclickable, since the system never sends a client-area click for it.
const DRAG_STRIP_H: f32 = 56.0;

struct State {
    dpi: u32,
    size: (u32, u32),
    input: Input,
    needs_frame: bool,
    closed: bool,
    cursor: Cursor,
    /// Where the close affordance is, in client pixels, so the drag strip can leave a hole for it.
    close_button: RECT,
}

/// Show the window and run it until it is closed. `Ok(true)` means Rovyl was installed.
pub fn run() -> Result<bool> {
    crate::win::monitor::declare_dpi_awareness();
    unsafe {
        let _ = windows::Win32::System::Com::CoInitializeEx(
            None,
            windows::Win32::System::Com::COINIT_APARTMENTTHREADED,
        );
    }

    let gpu = Gpu::create()?;
    let glyphs = GlyphCache::new();
    let text = TextCache::new(gpu.dwrite.clone());
    let mut ui = Ui::new();

    register_class()?;
    let mut state = Box::new(State {
        dpi: 96,
        size: (1, 1),
        input: Input {
            // The pointer starts outside: the window appears under wherever the cursor happens to
            // be, and a button that reads as hovered before the pointer has moved is a button one
            // stray click away from being pressed by accident.
            pointer_outside: true,
            ..Input::default()
        },
        needs_frame: true,
        closed: false,
        cursor: Cursor::Arrow,
        close_button: RECT::default(),
    });

    let hwnd = unsafe {
        CreateWindowExW(
            // `NOREDIRECTIONBITMAP` because the content is a composition swapchain, and
            // `APPWINDOW` because a popup is otherwise absent from the taskbar — an installer with
            // no way back to it after a click on something else.
            WS_EX_NOREDIRECTIONBITMAP | WS_EX_APPWINDOW,
            CLASS_NAME,
            w!("Rovyl Setup"),
            WS_POPUP | WS_SYSMENU,
            0,
            0,
            10,
            10,
            None,
            None,
            None,
            Some(&mut *state as *mut State as *mut _),
        )?
    };

    // Windows 11 rounds a popup's corners only when asked. It is one call and it fails harmlessly
    // on Windows 10, where there is nothing to round.
    unsafe {
        let preference = DWMWCP_ROUND;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &preference as *const _ as *const _,
            std::mem::size_of_val(&preference) as u32,
        );
    }

    let scale = unsafe { GetDpiForWindow(hwnd).max(96) } as f32 / 96.0;
    let width = (WINDOW_W * scale).round() as i32;
    let height = (WINDOW_H * scale).round() as i32;
    let work = crate::win::monitor::primary().work_area;
    unsafe {
        let _ = SetWindowPos(
            hwnd,
            HWND_TOP,
            work.left + ((work.right - work.left) - width) / 2,
            work.top + ((work.bottom - work.top) - height) / 2,
            width,
            height,
            SWP_NOACTIVATE,
        );
        state.dpi = GetDpiForWindow(hwnd).max(96);
    }
    state.size = (width.max(1) as u32, height.max(1) as u32);

    let mut surface = Surface::create(&gpu, hwnd, state.size.0, state.size.1)?;

    // Asked once, before anything is installed: after the succession there is no previous build
    // left to find, and the window would change its sentence halfway through.
    let replacing = crate::sys::migrate::previous().is_some();
    let mut stage = Stage::Ready;
    let mut installed: Option<PathBuf> = None;
    let answer: Arc<Mutex<Option<std::result::Result<PathBuf, String>>>> = Arc::default();

    // Drawn and presented BEFORE it is shown: a composition window revealed before its swapchain
    // has ever been presented puts a black rectangle on screen.
    frame(
        &gpu, &glyphs, &text, &mut ui, &mut surface, &mut state, &stage, replacing,
    );
    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOW);
        let _ = SetForegroundWindow(hwnd);
    }

    let mut message = MSG::default();
    while !state.closed {
        unsafe {
            if GetMessageW(&mut message, None, 0, 0).0 <= 0 {
                break;
            }
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }

        // The worker's answer, if it has one.
        if let Some(result) = answer.lock().ok().and_then(|mut slot| slot.take()) {
            unsafe {
                let _ = KillTimer(hwnd, TICK);
            }
            stage = match result {
                Ok(path) => {
                    installed = Some(path);
                    Stage::Done
                }
                Err(why) => {
                    crate::config::store::log_line(&format!("setup: {why}"));
                    Stage::Failed(why)
                }
            };
            state.needs_frame = true;
        }

        if !std::mem::take(&mut state.needs_frame) {
            continue;
        }
        let (action, animating) = frame(
            &gpu, &glyphs, &text, &mut ui, &mut surface, &mut state, &stage, replacing,
        );

        if action.install && stage != Stage::Working {
            stage = Stage::Working;
            state.needs_frame = true;
            let slot = answer.clone();
            // Detached on purpose. The loop's only interest in this thread is the slot it fills,
            // and a join would be the block the worker exists to avoid.
            std::thread::spawn(move || {
                let result = crate::sys::install::take_over();
                if let Ok(mut slot) = slot.lock() {
                    *slot = Some(result);
                }
            });
        }
        if action.open {
            if let Some(path) = installed.as_deref() {
                // No arguments: a launch nobody gave a flag to opens Settings, which is the
                // confirmation somebody who just installed it is looking for.
                let _ = std::process::Command::new(path).spawn();
            }
            state.closed = true;
        }
        if action.close {
            state.closed = true;
        }

        // Something has to wake a loop that is blocked in `GetMessage`: the worker's answer
        // arrives on another thread, and a button's hover fade is a clock rather than an event.
        // The timer runs only while one of those is outstanding, so an idle window costs nothing.
        unsafe {
            if animating || stage == Stage::Working {
                SetTimer(hwnd, TICK, 16, None);
            } else {
                let _ = KillTimer(hwnd, TICK);
            }
        }
    }

    unsafe {
        let _ = KillTimer(hwnd, TICK);
        let _ = DestroyWindow(hwnd);
    }
    Ok(installed.is_some())
}

/// One frame. Returns what was pressed, and whether an animation wants another.
#[allow(clippy::too_many_arguments)]
fn frame(
    gpu: &Gpu,
    glyphs: &GlyphCache,
    text: &TextCache,
    ui: &mut Ui,
    surface: &mut Surface,
    state: &mut State,
    stage: &Stage,
    replacing: bool,
) -> (crate::ui::setup::Action, bool) {
    let mut action = crate::ui::setup::Action::default();
    if surface
        .resize(state.size.0.max(1), state.size.1.max(1))
        .is_err()
    {
        return (action, false);
    }
    let Ok(painter) = Painter::new(gpu, glyphs, text) else {
        return (action, false);
    };
    let input = state.input.clone();
    state.input.end_frame();

    // Always the dark surface, whatever the system is set to. This is the product's own plate,
    // shown once, before there is a configuration to have a preference in.
    let theme = crate::gfx::palette::surface(crate::config::Theme::Black);
    let scale = state.dpi as f32 / 96.0;
    let bounds = Rect::new(0.0, 0.0, state.size.0 as f32, state.size.1 as f32);

    let Ok(target) = surface.begin_frame(gpu, state.dpi) else {
        return (action, false);
    };
    let mut f = crate::ui::Frame::new(&painter, ui, &input, theme, scale, bounds);
    action = crate::ui::setup::draw(&mut f, stage, replacing);
    let outcome = f.outcome;
    drop(target);
    let _ = surface.present(true);

    // Where the X ended up, so `WM_NCHITTEST` can keep the drag strip off it. The numbers are the
    // ones `ui::setup` lays it out with; they are here because the window procedure runs long
    // before and long after any frame.
    let pad = 16.0 * scale;
    state.close_button = RECT {
        left: (bounds.right - pad - 22.0 * scale) as i32,
        top: pad as i32,
        right: bounds.right as i32,
        bottom: (pad + 22.0 * scale) as i32,
    };
    state.cursor = outcome.cursor;
    apply_cursor(outcome.cursor);
    (action, outcome.animating)
}

/// Put the cursor the frame asked for on screen now, rather than waiting for the next move.
fn apply_cursor(cursor: Cursor) {
    unsafe {
        let name = match cursor {
            Cursor::Arrow => IDC_ARROW,
            Cursor::Hand => IDC_HAND,
            Cursor::Text => IDC_IBEAM,
            Cursor::SizeWestEast => IDC_SIZEWE,
        };
        if let Ok(handle) = LoadCursorW(None, name) {
            SetCursor(handle);
        }
    }
}

fn register_class() -> Result<()> {
    use std::sync::OnceLock;
    static DONE: OnceLock<bool> = OnceLock::new();
    if *DONE.get_or_init(|| unsafe {
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_DBLCLKS,
            lpfnWndProc: Some(setup_proc),
            hInstance: GetModuleHandleW(None).unwrap_or_default().into(),
            hIcon: crate::win::tray::app_icon(),
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
            hbrBackground: HBRUSH::default(),
            lpszClassName: CLASS_NAME,
            hIconSm: crate::win::tray::app_icon_small(),
            ..Default::default()
        };
        RegisterClassExW(&class) != 0
    }) {
        Ok(())
    } else {
        Err(windows::core::Error::from_win32())
    }
}

unsafe fn state_of(hwnd: HWND) -> Option<&'static mut State> {
    let pointer = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut State;
    pointer.as_mut()
}

unsafe extern "system" fn setup_proc(hwnd: HWND, message: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if message == WM_NCCREATE {
        let create = &*(l.0 as *const CREATESTRUCTW);
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
        return DefWindowProcW(hwnd, message, w, l);
    }
    let Some(state) = state_of(hwnd) else {
        return DefWindowProcW(hwnd, message, w, l);
    };

    match message {
        WM_MOUSEMOVE => {
            state.input.pointer = (
                (l.0 & 0xFFFF) as u16 as i16 as f32,
                ((l.0 >> 16) & 0xFFFF) as u16 as i16 as f32,
            );
            state.input.pointer_outside = false;
            state.needs_frame = true;
            let mut track = TRACKMOUSEEVENT {
                cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                dwFlags: TME_LEAVE,
                hwndTrack: hwnd,
                dwHoverTime: 0,
            };
            let _ = TrackMouseEvent(&mut track);
            LRESULT(0)
        }
        WM_MOUSELEAVE => {
            state.input.pointer_outside = true;
            state.needs_frame = true;
            LRESULT(0)
        }
        WM_SETCURSOR => {
            // Only inside the client area; the system owns the rest.
            if (l.0 & 0xFFFF) as u32 == HTCLIENT as u32 {
                let name = match state.cursor {
                    Cursor::Hand => IDC_HAND,
                    Cursor::Text => IDC_IBEAM,
                    Cursor::SizeWestEast => IDC_SIZEWE,
                    Cursor::Arrow => IDC_ARROW,
                };
                let _ = SetCursor(LoadCursorW(None, name).unwrap_or_default());
                return LRESULT(1);
            }
            DefWindowProcW(hwnd, message, w, l)
        }
        WM_LBUTTONDOWN | WM_LBUTTONDBLCLK => {
            state.input.down = true;
            state.input.pressed = true;
            state.needs_frame = true;
            LRESULT(0)
        }
        WM_LBUTTONUP => {
            state.input.down = false;
            state.input.released = true;
            state.needs_frame = true;
            LRESULT(0)
        }
        // The top strip is the titlebar this window does not have. Everything below it, and the
        // close affordance inside it, stays client area — a caption swallows clicks whole.
        WM_NCHITTEST => {
            let hit = DefWindowProcW(hwnd, message, w, l);
            if hit.0 != HTCLIENT as isize {
                return hit;
            }
            let mut point = POINT {
                x: (l.0 & 0xFFFF) as u16 as i16 as i32,
                y: ((l.0 >> 16) & 0xFFFF) as u16 as i16 as i32,
            };
            let _ = ScreenToClient(hwnd, &mut point);
            let strip = (DRAG_STRIP_H * state.dpi as f32 / 96.0) as i32;
            let over_close = point.x >= state.close_button.left
                && point.x <= state.close_button.right
                && point.y >= state.close_button.top
                && point.y <= state.close_button.bottom;
            if point.y < strip && !over_close {
                return LRESULT(HTCAPTION as isize);
            }
            hit
        }
        WM_TIMER => {
            state.needs_frame = true;
            LRESULT(0)
        }
        WM_KEYDOWN if w.0 as u16 == 0x1B => {
            // Escape, which on a one-button window means the button that is not the button.
            state.closed = true;
            LRESULT(0)
        }
        WM_CLOSE => {
            state.closed = true;
            LRESULT(0)
        }
        WM_DPICHANGED => {
            state.dpi = ((w.0 & 0xFFFF) as u32).max(96);
            state.needs_frame = true;
            DefWindowProcW(hwnd, message, w, l)
        }
        // The window's content is a swapchain, so its update region has to be validated here or
        // `GetMessage` regenerates `WM_PAINT` for ever.
        WM_PAINT => {
            let _ = ValidateRect(hwnd, None);
            state.needs_frame = true;
            LRESULT(0)
        }
        WM_ERASEBKGND => LRESULT(1),
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, message, w, l),
    }
}
