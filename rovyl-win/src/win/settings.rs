//! The settings window.
//!
//! An ordinary, opaque, resizable window with its own titlebar drawn into the client area. It is
//! NOT the overlay: that one is transparent, click-through, never focused and drawn with no frame
//! at all. The only thing they share is the GPU device.
//!
//! **Why a custom titlebar and native non-client behaviour.** The product's titlebar is part of
//! its surface — it carries the theme and the wordmark — so it is drawn rather than left to the
//! system. What is NOT given up is everything else the non-client area does: the resize borders,
//! snap layouts, Aero shake, the window menu on right-click, double-click to maximise, and the
//! rounded corners Windows 11 draws. Those all still work because the frame is still there; only
//! its CAPTION is removed, in `WM_NCCALCSIZE`, and `WM_NCHITTEST` tells the system which part of
//! the client area to treat as the caption.
//!
//! An alternative — `WS_POPUP` with everything hand-rolled — is what loses snap and shake, and
//! those are the window behaviours people use without knowing their names.

use crate::gfx::device::{Gpu, Surface};
use crate::ui::{Cursor, Input};
use windows::core::{w, PCWSTR, Result};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{ScreenToClient, ValidateRect, HBRUSH};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
// `WM_MOUSELEAVE` lives in `Controls`, not `WindowsAndMessaging` where every other `WM_` is.
// Without this import the name is not a constant but a NEW BINDING, which matches anything -- and
// silently swallows every message after it in the window procedure.
use windows::Win32::UI::Controls::{MARGINS, WM_MOUSELEAVE};
use windows::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyState, ReleaseCapture, SetCapture, TrackMouseEvent, TME_LEAVE, TRACKMOUSEEVENT,
    VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
};
use windows::Win32::UI::WindowsAndMessaging::*;

const CLASS_NAME: PCWSTR = w!("RovylSettings");

/// The titlebar's height, in DIPs.
///
/// Windows' own is 32 at 100%, and matching it is what makes the window stop looking like a web
/// page in a frame. The drawn one is the same height so the system's own buttons would have landed
/// in the same place.
pub const TITLEBAR_H: f32 = 36.0;

/// The smallest the window may be.
///
/// Below this the two-column layout stops working — the nav takes its minimum, the control column
/// takes its minimum, and the row's sentence has nowhere to go.
const MIN_W: i32 = 760;
const MIN_H: i32 = 520;

/// The size it opens at, in DIPs. The original's.
const DEFAULT_W: i32 = 880;
const DEFAULT_H: i32 = 600;

pub struct SettingsWindow {
    pub hwnd: HWND,
    pub surface: Surface,
    pub input: Input,
    /// Collected by the window procedure, read and cleared by the frame.
    pub state: Box<State>,
    visible: bool,
    /// What a drag over this window is doing, while one is.
    ///
    /// `None` when OLE refused the registration, which costs drag-and-drop and nothing else — the
    /// window still opens and every other way of adding a shortcut still works.
    pub drag: Option<crate::win::drop::Shared>,
    /// What the frame was last told the theme is. `None` until it has been told once.
    ///
    /// Remembered so the DWM is asked only when the answer changes: it is a cross-process call,
    /// and a window that made two of them every frame would be paying for a repaint that
    /// almost never happens.
    frame_theme: Option<crate::config::Theme>,
}

/// Everything the window procedure writes and the frame reads.
///
/// Boxed and pointed at from `GWLP_USERDATA`, because a window procedure is a free function and
/// this is the only way to reach the instance from inside it.
#[derive(Default)]
pub struct State {
    pub input: Input,
    pub size: (u32, u32),
    pub dpi: u32,
    pub maximized: bool,
    pub close_requested: bool,
    pub needs_frame: bool,
    /// Where the drawn titlebar's buttons are, in client pixels, so `WM_NCHITTEST` can keep its
    /// hands off them — otherwise the whole bar is caption and the buttons can never be pressed.
    pub caption_buttons: [RECT; 6],
    /// The cursor the UI asked for on the last frame.
    pub cursor: Cursor,
}


impl Drop for SettingsWindow {
    /// Hand the drop target back.
    ///
    /// In practice this window outlives everything — it is HIDDEN between openings, never
    /// destroyed — so this runs only as the process winds down, if at all. It is here because the
    /// registration is owned by this struct and an owner that never gives its handle back is one
    /// nobody can safely reuse: the day this window is created twice, the second `RegisterDragDrop`
    /// would fail with `DRAGDROP_E_ALREADYREGISTERED` and the feature would be silently gone.
    fn drop(&mut self) {
        if self.drag.is_some() {
            crate::win::drop::revoke(self.hwnd);
        }
    }
}

impl SettingsWindow {
    pub fn create(gpu: &Gpu, scale: f32) -> Result<Self> {
        register_class()?;

        let mut state = Box::new(State {
            dpi: (96.0 * scale) as u32,
            ..Default::default()
        });

        // The original's own 880x600, and its rule for a screen too small to hold it: back off to
        // 80px short of the work area rather than hanging off the edge at high Windows scaling.
        let work = crate::win::monitor::primary().work_area;
        let width = ((DEFAULT_W as f32 * scale) as i32)
            .min(((work.right - work.left) - (80.0 * scale) as i32).max((MIN_W as f32 * scale) as i32));
        let height = ((DEFAULT_H as f32 * scale) as i32)
            .min(((work.bottom - work.top) - (80.0 * scale) as i32).max((MIN_H as f32 * scale) as i32));
        let left = work.left + ((work.right - work.left) - width) / 2;
        let top = work.top + ((work.bottom - work.top) - height) / 2;

        let hwnd = unsafe {
            CreateWindowExW(
                // `NOREDIRECTIONBITMAP` again: the content is a composition swapchain, and a
                // redirection surface this window never draws into would be composited underneath
                // it as uninitialised memory.
                WS_EX_NOREDIRECTIONBITMAP,
                CLASS_NAME,
                w!("Rovyl"),
                // The full overlapped style, including `THICKFRAME` and `CAPTION`. The caption is
                // removed in `WM_NCCALCSIZE`, but the STYLE has to be there: it is what gives the
                // window snap, shake, the maximise animation and the system menu.
                WS_OVERLAPPEDWINDOW,
                left,
                top,
                width,
                height,
                None,
                None,
                None,
                Some(&mut *state as *mut State as *mut _),
            )?
        };

        unsafe {
            // Tell Windows the frame has changed, so it asks `WM_NCCALCSIZE` again.
            //
            // Without this the window keeps the frame it was BORN with -- the one computed before
            // this procedure was answering -- and the result is a window with two titlebars: the
            // system's, which was never removed, and the drawn one below it. Nothing else in the
            // program is wrong at that point, which is why it survived this long.
            let _ = SetWindowPos(
                hwnd,
                None,
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
            // And the one-pixel frame that makes the DWM draw this window's shadow and rounded
            // corners. A window with its caption removed and no extended frame is a flat
            // rectangle with hard corners, which on Windows 11 looks like a bug.
            extend_frame(hwnd);
        }

        let mut client = RECT::default();
        unsafe {
            let _ = GetClientRect(hwnd, &mut client);
        }
        let surface = Surface::create(
            gpu,
            hwnd,
            (client.right - client.left).max(1) as u32,
            (client.bottom - client.top).max(1) as u32,
        )?;
        state.size = (
            (client.right - client.left).max(1) as u32,
            (client.bottom - client.top).max(1) as u32,
        );

        Ok(Self {
            hwnd,
            surface,
            input: Input::default(),
            state,
            visible: false,
            // Registered once, here, and revoked when the window goes. A drop target on a window
            // that is merely hidden is correct: the panel is hidden rather than destroyed between
            // openings, and re-registering on every show would be a handle leak with extra steps.
            drag: crate::win::drop::register(hwnd),
            frame_theme: None,
        })
    }

    pub fn show(&mut self) {
        unsafe {
            let _ = ShowWindow(self.hwnd, SW_SHOW);
            // A window the user asked for comes to the front and takes focus — unlike the overlay,
            // which must never do either.
            let _ = SetForegroundWindow(self.hwnd);
        }
        self.visible = true;
        self.state.needs_frame = true;
    }

    pub fn hide(&mut self) {
        unsafe {
            let _ = ShowWindow(self.hwnd, SW_HIDE);
        }
        self.visible = false;
    }

    pub fn visible(&self) -> bool {
        self.visible
    }

    pub fn size(&self) -> (f32, f32) {
        (self.state.size.0 as f32, self.state.size.1 as f32)
    }

    pub fn scale(&self) -> f32 {
        self.state.dpi as f32 / 96.0
    }

    /// Match the surface to the window, after a resize or a DPI change.
    pub fn sync_surface(&mut self) -> Result<()> {
        self.surface.resize(self.state.size.0, self.state.size.1)
    }

    pub fn apply_cursor(&self, cursor: Cursor) {
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

    pub fn toggle_maximize(&self) {
        unsafe {
            let _ = ShowWindow(
                self.hwnd,
                if self.state.maximized { SW_RESTORE } else { SW_MAXIMIZE },
            );
        }
    }

    pub fn minimize(&self) {
        unsafe {
            let _ = ShowWindow(self.hwnd, SW_MINIMIZE);
        }
    }
}

fn register_class() -> Result<()> {
    use std::sync::OnceLock;
    static DONE: OnceLock<bool> = OnceLock::new();
    if *DONE.get_or_init(|| unsafe {
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            // No `CS_HREDRAW | CS_VREDRAW`: those invalidate the whole window on every resize,
            // and this one has no `WM_PAINT` to answer — its content is a swapchain.
            style: CS_DBLCLKS,
            lpfnWndProc: Some(settings_proc),
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
    let raw = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
    (raw != 0).then(|| &mut *(raw as *mut State))
}

unsafe extern "system" fn settings_proc(
    hwnd: HWND,
    message: u32,
    w: WPARAM,
    l: LPARAM,
) -> LRESULT {
    if message == WM_NCCREATE {
        let create = &*(l.0 as *const CREATESTRUCTW);
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
        // Telling the system the window's DPI-scaling behaviour has to happen before the first
        // non-client calculation, which is why it is here rather than in `create`.
        if let Some(state) = state_of(hwnd) {
            state.dpi = GetDpiForWindow(hwnd).max(96);
        }
        return DefWindowProcW(hwnd, message, w, l);
    }

    let Some(state) = state_of(hwnd) else {
        return DefWindowProcW(hwnd, message, w, l);
    };

    match message {
        // Remove the caption, keep the frame.
        //
        // The documented way to keep the resize borders and the system's own shadow while drawing
        // the titlebar ourselves: let `DefWindowProc` compute the frame, then give the top edge
        // back. Without the give-back, the window loses the 1px line Windows draws at the top of a
        // maximised window and the content sits under the screen edge.
        WM_NCCALCSIZE if w.0 != 0 => {
            let params = &mut *(l.0 as *mut NCCALCSIZE_PARAMS);
            let requested = params.rgrc[0];
            DefWindowProcW(hwnd, message, w, l);
            let mut frame = params.rgrc[0];
            frame.top = requested.top;
            // A MAXIMISED window's frame hangs off every edge of the monitor by the border width,
            // so the client area has to be pulled in by it or the content is clipped on all four
            // sides. Not an issue when restored, where the border is outside the client area.
            if state.maximized {
                let border = GetSystemMetricsForDpi(SM_CXPADDEDBORDER, state.dpi)
                    + GetSystemMetricsForDpi(SM_CYSIZEFRAME, state.dpi);
                frame.top += border;
            }
            params.rgrc[0] = frame;
            LRESULT(0)
        }

        // Which part of the client area behaves like the non-client one.
        WM_NCHITTEST => {
            // The borders first: `DefWindowProc` already knows where they are, and reimplementing
            // them is how a window ends up resizable on three sides.
            let hit = DefWindowProcW(hwnd, message, w, l);
            if hit.0 != HTCLIENT as isize {
                return hit;
            }
            let mut point = POINT {
                x: (l.0 & 0xFFFF) as u16 as i16 as i32,
                y: ((l.0 >> 16) & 0xFFFF) as u16 as i16 as i32,
            };
            let _ = ScreenToClient(hwnd, &mut point);
            let bar = (TITLEBAR_H * state.dpi as f32 / 96.0) as i32;
            if point.y < bar {
                // Except where the drawn buttons are. A caption that swallowed them would leave
                // close, maximise and minimise unpressable — the whole bar would just drag.
                for button in &state.caption_buttons {
                    if point.x >= button.left
                        && point.x < button.right
                        && point.y >= button.top
                        && point.y < button.bottom
                    {
                        return LRESULT(HTCLIENT as isize);
                    }
                }
                return LRESULT(HTCAPTION as isize);
            }
            LRESULT(HTCLIENT as isize)
        }

        WM_SIZE => {
            state.size = (
                (l.0 & 0xFFFF) as u32,
                ((l.0 >> 16) & 0xFFFF) as u32,
            );
            state.maximized = w.0 as u32 == SIZE_MAXIMIZED;
            state.needs_frame = true;
            LRESULT(0)
        }

        WM_GETMINMAXINFO => {
            let info = &mut *(l.0 as *mut MINMAXINFO);
            let scale = state.dpi as f32 / 96.0;
            info.ptMinTrackSize.x = (MIN_W as f32 * scale) as i32;
            info.ptMinTrackSize.y = (MIN_H as f32 * scale) as i32;
            LRESULT(0)
        }

        WM_DPICHANGED => {
            state.dpi = (w.0 & 0xFFFF) as u32;
            // The suggested rectangle is the system's: it has already worked out where the window
            // should be so that it stays under the pointer during a drag between monitors.
            let suggested = &*(l.0 as *const RECT);
            let _ = SetWindowPos(
                hwnd,
                None,
                suggested.left,
                suggested.top,
                suggested.right - suggested.left,
                suggested.bottom - suggested.top,
                SWP_NOZORDER | SWP_NOACTIVATE,
            );
            state.needs_frame = true;
            LRESULT(0)
        }

        WM_MOUSEMOVE => {
            state.input.pointer = (
                (l.0 & 0xFFFF) as u16 as i16 as f32,
                ((l.0 >> 16) & 0xFFFF) as u16 as i16 as f32,
            );
            state.input.pointer_outside = false;
            state.needs_frame = true;
            // Asking for `WM_MOUSELEAVE` has to be re-armed after every one that fires.
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
            // Capture, so a drag that leaves the window still reaches the slider it started on.
            SetCapture(hwnd);
            LRESULT(0)
        }
        WM_LBUTTONUP => {
            state.input.down = false;
            state.input.released = true;
            state.needs_frame = true;
            let _ = ReleaseCapture();
            LRESULT(0)
        }

        WM_MOUSEWHEEL => {
            let delta = ((w.0 >> 16) & 0xFFFF) as u16 as i16 as f32 / 120.0;
            state.input.scroll += delta;
            state.needs_frame = true;
            LRESULT(0)
        }

        WM_CHAR => {
            if let Some(ch) = char::from_u32(w.0 as u32) {
                if !ch.is_control() {
                    state.input.typed.push(ch);
                    state.needs_frame = true;
                }
            }
            LRESULT(0)
        }
        WM_KEYDOWN | WM_SYSKEYDOWN => {
            state.input.keys.push(w.0 as u16);
            state.input.ctrl = (GetKeyState(VK_CONTROL.0 as i32) as u16 & 0x8000) != 0;
            state.input.shift = (GetKeyState(VK_SHIFT.0 as i32) as u16 & 0x8000) != 0;
            state.input.alt = (GetKeyState(VK_MENU.0 as i32) as u16 & 0x8000) != 0;
            // Either Windows key. `VK_LWIN`/`VK_RWIN` rather than a combined code, because there
            // is no combined code — unlike Control, Alt and Shift, the system does not define one.
            state.input.win = ((GetKeyState(VK_LWIN.0 as i32) as u16 & 0x8000) != 0)
                || ((GetKeyState(VK_RWIN.0 as i32) as u16 & 0x8000) != 0);
            state.needs_frame = true;
            // `WM_SYSKEYDOWN` is returned as handled so Alt does not open the (absent) system
            // menu and take the keyboard away mid-recording. `DefWindowProc` would beep at it.
            LRESULT(0)
        }

        WM_SETCURSOR => {
            // Only inside the client area; the frame's own cursors (the resize arrows) belong to
            // `DefWindowProc` and must not be overridden.
            if (l.0 & 0xFFFF) as u32 == HTCLIENT {
                return LRESULT(1);
            }
            DefWindowProcW(hwnd, message, w, l)
        }

        // Closing hides. The app lives in the tray; a settings window that quit the process would
        // take the launcher with it, which is not what the X on a settings window means.
        WM_CLOSE => {
            state.close_requested = true;
            LRESULT(0)
        }

        // A composition-backed window MUST validate its own update region.
        //
        // There is no redirection bitmap, so `DefWindowProc`'s `BeginPaint`/`EndPaint` has nothing
        // to paint into and leaves the region dirty — and `PeekMessage` SYNTHESISES `WM_PAINT`
        // whenever a region is dirty, so the message comes straight back. The result is a message
        // loop that never drains and a pegged CPU core, with nothing in the logs to say why.
        //
        // The frame itself is presented from the render loop; all this has to do is say the region
        // has been dealt with, and ask for a frame so that whatever prompted the repaint is drawn.
        WM_PAINT => {
            let _ = ValidateRect(hwnd, None);
            state.needs_frame = true;
            LRESULT(0)
        }

        WM_ERASEBKGND => LRESULT(1),

        _ => DefWindowProcW(hwnd, message, w, l),
    }
}

impl SettingsWindow {
    /// Keep the system-drawn frame in step with the theme the panel is painted in.
    ///
    /// Called every frame and cheap on all but the one where the user flips Black to White: the
    /// DWM is only asked when the answer has actually changed.
    pub fn sync_frame_theme(&mut self, theme: crate::config::Theme) {
        if self.frame_theme == Some(theme) {
            return;
        }
        apply_frame_theme(self.hwnd, theme);
        self.frame_theme = Some(theme);
    }
}

/// Stop Windows ringing this window in white.
///
/// A window with a resize frame gets a one-pixel border drawn by the DWM, and its colour is the
/// system's rather than the app's: near-white while the window is active, grey while it is not.
/// Around a #151515 panel that reads as an outline somebody forgot to remove — and because
/// `WM_NCCALCSIZE` hands the top edge back to the client, it is an outline on three sides with a
/// gap along the top, which looks less like a frame than like a window that failed to paint.
///
/// Two mechanisms, chosen by asking rather than by reading a version number:
///
/// - `DWMWA_BORDER_COLOR` names the border's colour outright. It exists from Windows 11 22000
///   and returns `E_INVALIDARG` before that, so the call itself is the capability test. Where it
///   works it is the better answer by far: the window keeps its rounded corners and its shadow,
///   and only the one pixel changes.
/// - Where it does not, there is no way to colour that pixel, so the DWM is told not to render
///   the non-client area at all. The border goes. The system drop shadow goes with it — that is
///   the whole cost, and it is a smaller one than a dark window with a white outline.
///
/// `USE_IMMERSIVE_DARK_MODE` goes on in both cases. It is what the rest of the shell reads to
/// decide how to draw anything of ours it draws itself, and it costs nothing to be honest about.
fn apply_frame_theme(hwnd: HWND, theme: crate::config::Theme) {
    use windows::Win32::Foundation::BOOL;
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWINDOWATTRIBUTE};

    let dark = matches!(theme, crate::config::Theme::Black);
    unsafe {
        // The attribute was renumbered in Windows 10 19041. Both are set; the one the running
        // build does not know rejects the call and nothing else happens.
        let flag: BOOL = dark.into();
        for attribute in [DWMWA_USE_IMMERSIVE_DARK_MODE, DWMWA_USE_IMMERSIVE_DARK_MODE_PRE_20H1] {
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWINDOWATTRIBUTE(attribute),
                &flag as *const BOOL as *const _,
                std::mem::size_of::<BOOL>() as u32,
            );
        }

        // The panel's own hairline, so on Windows 11 the border reads as the window's edge
        // rather than as the system's. `COLORREF` is 0x00BBGGRR, the other way round from every
        // other colour in this program.
        let line: u32 = if dark { 0x00_26_26_26 } else { 0x00_D2_D2_D0 };
        let coloured = DwmSetWindowAttribute(
            hwnd,
            DWMWINDOWATTRIBUTE(DWMWA_BORDER_COLOR),
            &line as *const u32 as *const _,
            std::mem::size_of::<u32>() as u32,
        )
        .is_ok();

        if !coloured {
            let policy: i32 = DWMNCRP_DISABLED;
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWINDOWATTRIBUTE(DWMWA_NCRENDERING_POLICY),
                &policy as *const i32 as *const _,
                std::mem::size_of::<i32>() as u32,
            );
        }
    }
}

/// `DWMWA_USE_IMMERSIVE_DARK_MODE` on Windows 10 19041 and later, and on 11.
const DWMWA_USE_IMMERSIVE_DARK_MODE: i32 = 20;
/// The number the same attribute had on Windows 10 1809 to 1903.
const DWMWA_USE_IMMERSIVE_DARK_MODE_PRE_20H1: i32 = 19;
/// `DWMWA_BORDER_COLOR`, Windows 11 22000 and later. Refused before that, which is the test.
const DWMWA_BORDER_COLOR: i32 = 34;
/// `DWMWA_NCRENDERING_POLICY`, and the value that turns the frame off.
const DWMWA_NCRENDERING_POLICY: i32 = 2;
const DWMNCRP_DISABLED: i32 = 1;

/// Extend the frame into the client area, so Windows draws its own drop shadow and rounded corners.
///
/// One pixel is enough: the DWM's test for "does this window want a frame" is whether any margin is
/// non-zero, and a larger one would show as a strip of the system's glass above the drawn titlebar.
pub fn extend_frame(hwnd: HWND) {
    unsafe {
        let _ = windows::Win32::Graphics::Dwm::DwmExtendFrameIntoClientArea(
            hwnd,
            &MARGINS {
                cxLeftWidth: 0,
                cxRightWidth: 0,
                cyTopHeight: 1,
                cyBottomHeight: 0,
            },
        );
    }
}
