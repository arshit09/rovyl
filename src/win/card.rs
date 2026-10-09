//! The card a failed launch puts on screen.
//!
//! **Why a window of its own.** The overlay is `WS_EX_TRANSPARENT` and must stay that way — every
//! mouse event it would otherwise swallow belongs to the application underneath, and that is the
//! whole reason a launcher can sit on top of everything without being in the way. A card has
//! buttons, so it needs to be hit-testable, so it is not the overlay.
//!
//! **Why it is not a balloon.** `Shell_NotifyIcon` would have been forty lines. But a balloon has
//! one action and this needs two that mean different things — go and fix the shortcut, or read
//! what actually went wrong — and a balloon that said "launch failed" with no way to act on it is
//! the same silence in a different font.
//!
//! It never takes focus: somebody who just tried to start something is about to type into whatever
//! they expected to open, and a card that stole the keyboard would eat that.

use crate::gfx::device::{Gpu, Surface};
use crate::ui::Input;
use windows::core::{w, PCWSTR, Result};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{ValidateRect, HBRUSH};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Controls::WM_MOUSELEAVE;
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Input::KeyboardAndMouse::{TrackMouseEvent, TME_LEAVE, TRACKMOUSEEVENT};
use windows::Win32::UI::WindowsAndMessaging::*;

const CLASS_NAME: PCWSTR = w!("RovylCard");

/// The card's size in DIPs. Fixed: the text is wrapped into it rather than the other way round,
/// so a long error cannot grow a notification across somebody's screen.
pub const CARD_W: f32 = 380.0;
pub const CARD_H: f32 = 164.0;

/// How far in from the corner it sits, matching the docks' own inset.
const INSET: f32 = 16.0;

/// How long it stays without being touched.
///
/// Long enough to read two sentences and decide, short enough that a card nobody acted on is gone
/// before it becomes furniture. The clock stops while the pointer is on it.
pub const LINGER_MS: f32 = 12_000.0;

pub struct CardState {
    pub dpi: u32,
    pub size: (u32, u32),
    pub input: Input,
    pub needs_frame: bool,
    /// Placed, sized, and waiting for a frame before it is shown.
    ///
    /// `ShowWindow` on a composition window whose swapchain has never been presented puts a black
    /// or stale rectangle on screen -- the overlay says so in its own comments and it is true
    /// here too. The card is therefore placed first, drawn, presented, and only then revealed.
    pub pending_show: bool,
    /// Set by the procedure, read and cleared by the host.
    pub dismissed: bool,
}

impl CardState {
    /// Whether the window is placed but still waiting for its first frame.
    pub fn awaiting_first_frame(&self) -> bool {
        self.pending_show
    }
}

pub struct Card {
    pub hwnd: HWND,
    pub surface: Surface,
    pub state: Box<CardState>,
    visible: bool,
}

impl Card {
    pub fn create(gpu: &Gpu) -> Result<Self> {
        register_class()?;
        let mut state = Box::new(CardState {
            dpi: 96,
            size: (1, 1),
            input: Input::default(),
            needs_frame: true,
            pending_show: false,
            dismissed: false,
        });

        let hwnd = unsafe {
            CreateWindowExW(
                // Composition, topmost, out of the taskbar and Task View, and never activated.
                WS_EX_NOREDIRECTIONBITMAP | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                CLASS_NAME,
                w!("Rovyl"),
                WS_POPUP,
                0,
                0,
                10,
                10,
                None,
                None,
                None,
                Some(&mut *state as *mut CardState as *mut _),
            )?
        };

        let surface = Surface::create(gpu, hwnd, 10, 10)?;
        Ok(Self {
            hwnd,
            surface,
            state,
            visible: false,
        })
    }

    pub fn scale(&self) -> f32 {
        self.state.dpi as f32 / 96.0
    }

    pub fn size(&self) -> (f32, f32) {
        (self.state.size.0 as f32, self.state.size.1 as f32)
    }

    pub fn visible(&self) -> bool {
        self.visible
    }

    /// Put it in the bottom-right of a work area, ready to be drawn.
    ///
    /// It is NOT shown here. See `pending_show`.
    pub fn place_in(&mut self, work: RECT) -> Result<()> {
        unsafe {
            self.state.dpi = GetDpiForWindow(self.hwnd).max(96);
        }
        let scale = self.scale();
        let width = (CARD_W * scale).round() as i32;
        let height = (CARD_H * scale).round() as i32;
        let inset = (INSET * scale).round() as i32;
        let left = work.right - inset - width;
        let top = work.bottom - inset - height;

        unsafe {
            let _ = SetWindowPos(
                self.hwnd,
                HWND_TOPMOST,
                left,
                top,
                width,
                height,
                SWP_NOACTIVATE,
            );
        }
        self.state.size = (width.max(1) as u32, height.max(1) as u32);
        self.state.input = Input::default();
        // The pointer starts OUTSIDE: the card appears under wherever the cursor happens to be,
        // and a button that reads as hovered before the pointer has moved is a button one stray
        // click away from being pressed by accident.
        self.state.input.pointer_outside = true;
        self.state.needs_frame = true;
        self.state.dismissed = false;
        self.state.pending_show = true;
        Ok(())
    }

    /// Reveal it, now that a frame has been presented to its surface.
    ///
    /// `SW_SHOWNOACTIVATE` so the keyboard stays wherever it was: somebody who just tried to start
    /// something is about to type into whatever they expected to open.
    pub fn reveal(&mut self) {
        if !self.state.pending_show {
            return;
        }
        self.state.pending_show = false;
        unsafe {
            let _ = ShowWindow(self.hwnd, SW_SHOWNOACTIVATE);
        }
        self.visible = true;
    }

    pub fn hide(&mut self) {
        if !self.visible {
            return;
        }
        unsafe {
            let _ = ShowWindow(self.hwnd, SW_HIDE);
        }
        self.visible = false;
    }

    pub fn sync_surface(&mut self, _gpu: &Gpu) -> Result<()> {
        self.surface
            .resize(self.state.size.0.max(1), self.state.size.1.max(1))
    }
}

impl Drop for Card {
    fn drop(&mut self) {
        unsafe {
            let _ = DestroyWindow(self.hwnd);
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
            lpfnWndProc: Some(card_proc),
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

unsafe fn state_of(hwnd: HWND) -> Option<&'static mut CardState> {
    let pointer = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut CardState;
    pointer.as_mut()
}

unsafe extern "system" fn card_proc(hwnd: HWND, message: u32, w: WPARAM, l: LPARAM) -> LRESULT {
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
        // A card is dismissed by the Escape key only while something else has the keyboard, so
        // this is here for completeness rather than as the way out: the X is the way out.
        WM_CLOSE => {
            state.dismissed = true;
            LRESULT(0)
        }
        WM_DPICHANGED => {
            state.dpi = ((w.0 & 0xFFFF) as u32).max(96);
            state.needs_frame = true;
            LRESULT(0)
        }
        // The window's content is a swapchain, so its update region has to be validated here or
        // `PeekMessage` regenerates `WM_PAINT` for ever.
        WM_PAINT => {
            let _ = ValidateRect(hwnd, None);
            state.needs_frame = true;
            LRESULT(0)
        }
        WM_ERASEBKGND => LRESULT(1),
        _ => DefWindowProcW(hwnd, message, w, l),
    }
}
