//! The wheel's window: a composition-backed, per-pixel-alpha overlay that never takes focus.
//!
//! **What this window is not.** The Electron build's overlay was a `BrowserWindow` whose first
//! paint happened in another process, so revealing it required a handshake — a paint token sent to
//! the renderer, acknowledged, and only then a `showInactive`, with a 120 ms fallback (240 ms when
//! restoring from minimised) in case the acknowledgement never came. Getting it wrong produced the
//! failures `docs/ARCHITECTURE.md` lists: the compositor presenting a stale texture, a black frame,
//! or the window appearing at its previous bounds. `scripts/verify-radial-windowing.mjs` existed to
//! keep that handshake intact.
//!
//! None of it is needed here, and not because it was done better: the problem is gone. The frame
//! is drawn and committed on this thread before `ShowWindow` is called, so there is no window in
//! which a surface can be visible and unpainted. [`Overlay::present_then_show`] is the whole of it.
//!
//! **Why it never takes focus.** `WS_EX_NOACTIVATE`, and the keyboard comes from a low-level hook
//! instead. The original had to steal the foreground — `backend/foreground-focus.ps1` exists
//! because Windows refuses focus to a process the user has not interacted with — which means the
//! app the user was in loses focus, and has to have it given back. Here it never loses it.
//!
//! **Why it is also `WS_EX_TRANSPARENT`.** It is not hit-testable at all. Every mouse event the
//! wheel acts on arrives from the hook, which is the only input path; a window that could also
//! receive a real click would be a second path, and two paths that can disagree about what was
//! clicked is the defect the original's `pointer-events: none` rules were fighting.

use crate::gfx::device::{Gpu, Surface};
use windows::core::{w, Result, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::HBRUSH;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, GetWindowLongPtrW, LoadCursorW, RegisterClassExW,
    ShowWindowAsync,
    SetWindowLongPtrW, SetWindowPos, CS_HREDRAW, CS_VREDRAW, GWLP_USERDATA,
    HICON, HWND_TOPMOST, IDC_ARROW, SWP_NOACTIVATE, SWP_NOZORDER, SW_HIDE, SW_SHOWNA,
    WNDCLASSEXW, WS_EX_NOACTIVATE, WS_EX_NOREDIRECTIONBITMAP, WS_EX_TOOLWINDOW,
    WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
};

const CLASS_NAME: PCWSTR = w!("RovylOverlay");

pub struct Overlay {
    pub hwnd: HWND,
    pub surface: Surface,
    bounds: RECT,
    visible: bool,
}

impl Overlay {
    /// Create the overlay, hidden, at `bounds` (physical pixels, virtual-desktop coordinates).
    ///
    /// It is created once per session and never destroyed: creating a window costs a class lookup,
    /// a composition target and two monitor-sized back buffers, and the wheel is opened dozens of
    /// times a day. Hiding it costs nothing and keeps the GPU resources warm, which is most of why
    /// the first frame after a trigger can be drawn inside one refresh.
    pub fn create(gpu: &Gpu, bounds: RECT) -> Result<Self> {
        register_class()?;
        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_NOREDIRECTIONBITMAP
                    // No redirection surface at all: the DWM is handed this window's swapchain as a
                    // texture. Without this flag the window gets a redirection bitmap it never
                    // draws into, and composition shows the uninitialised contents of it.
                    | WS_EX_TOPMOST
                    // Out of the taskbar and out of Alt+Tab. An overlay that is on screen for
                    // half a second at a time has no business being a window the user can switch
                    // to — and `WS_EX_TOOLWINDOW` is also what keeps it off the Task View.
                    | WS_EX_TOOLWINDOW
                    // Never activate. The keyboard arrives from the hook; see the module header.
                    | WS_EX_NOACTIVATE
                    // Not hit-testable. The hook is the only input path.
                    | WS_EX_TRANSPARENT,
                CLASS_NAME,
                // The title is what a screen reader and the Task Manager read. "Rovyl" rather
                // than a description: it is the product, and the window has no other identity.
                w!("Rovyl"),
                WS_POPUP,
                bounds.left,
                bounds.top,
                (bounds.right - bounds.left).max(1),
                (bounds.bottom - bounds.top).max(1),
                None,
                None,
                None,
                None,
            )?
        };

        let surface = Surface::create(
            gpu,
            hwnd,
            (bounds.right - bounds.left).max(1) as u32,
            (bounds.bottom - bounds.top).max(1) as u32,
        )?;

        Ok(Self {
            hwnd,
            surface,
            bounds,
            visible: false,
        })
    }

    pub fn bounds(&self) -> RECT {
        self.bounds
    }

    pub fn size(&self) -> (f32, f32) {
        (
            (self.bounds.right - self.bounds.left) as f32,
            (self.bounds.bottom - self.bounds.top) as f32,
        )
    }

    pub fn visible(&self) -> bool {
        self.visible
    }

    /// Move and resize the window, WHILE HIDDEN.
    ///
    /// The caller is expected to have hidden it first if the bounds are changing by more than the
    /// window can absorb. A resize reallocates both back buffers, which on some drivers presents
    /// one frame of the old surface stretched to the new size — a visible flash. The original
    /// documented the same hazard and its mitigation (park the idle window on the monitor the next
    /// open will use, so opening costs no resize at all), and [`crate::app`] does the same here.
    pub fn set_bounds(&mut self, bounds: RECT) -> Result<()> {
        if same_rect(self.bounds, bounds) {
            return Ok(());
        }
        let (w, h) = (
            (bounds.right - bounds.left).max(1),
            (bounds.bottom - bounds.top).max(1),
        );
        unsafe {
            SetWindowPos(
                self.hwnd,
                None,
                bounds.left,
                bounds.top,
                w,
                h,
                SWP_NOACTIVATE | SWP_NOZORDER,
            )?;
        }
        self.surface.resize(w as u32, h as u32)?;
        self.bounds = bounds;
        Ok(())
    }

    /// Reveal the window with a frame already committed to its surface.
    ///
    /// The order is the entire reason this function exists: present, then show. `ShowWindow` on a
    /// window whose swapchain has never been presented is how a composition overlay appears as a
    /// black or stale rectangle for one frame.
    pub fn present_then_show(&mut self) -> Result<(f32, f32)> {
        // No vsync wait on this one. The user is still holding the button down; waiting up to a
        // refresh interval here is latency added to the one moment the product is judged on.
        let at = std::time::Instant::now();
        self.surface.present(false)?;
        let presented = at.elapsed().as_secs_f32() * 1000.0;
        let at = std::time::Instant::now();
        if !self.visible {
            unsafe {
                // `SW_SHOWNA` and not `SetWindowPos(HWND_TOPMOST, ..., SWP_SHOWWINDOW)`.
                //
                // They look equivalent and they are not: asking for `HWND_TOPMOST` forces the
                // window manager to recompute the whole z-order and round-trip to the DWM, which
                // measured at 11 ms on this machine — most of the entire open. The window already
                // carries `WS_EX_TOPMOST`, so its band is preserved across a hide and a show and
                // there is nothing to re-establish; `raise()` exists for the one case where
                // something else has genuinely taken the front since.
                //
                // `NA` rather than `NOACTIVATE`: both avoid activation, and this one also leaves
                // the current foreground window's active state alone.
                // ASYNC, and that is the point. Showing a composition window is a round trip to
                // the DWM — measured at 11 ms on this machine, which was most of the whole open —
                // and performing it synchronously blocks this thread for that long at exactly the
                // moment it should be free to draw the next frame and service the hook. The posted
                // form reaches the same place at the same moment without holding the thread.
                let _ = ShowWindowAsync(self.hwnd, SW_SHOWNA);
            }
            self.visible = true;
        }
        Ok((presented, at.elapsed().as_secs_f32() * 1000.0))
    }

    /// Present an ordinary animation frame.
    ///
    /// `vsync` is what paces the wheel to the display. It is false only for a frame that must not
    /// wait — the one drawn immediately before the window is shown, and the benchmark's, which is
    /// measuring the drawing and not the refresh rate.
    pub fn present(&self, vsync: bool) -> Result<()> {
        self.surface.present(vsync)
    }

    pub fn hide(&mut self) {
        if !self.visible {
            return;
        }
        unsafe {
            // ASYNC, to match the show — and that is a correctness requirement, not a symmetry.
            // Both forms go through this thread's own message queue, so posting both keeps them in
            // order. A synchronous hide would execute immediately and could therefore run BEFORE a
            // show that was posted earlier, leaving the overlay on screen over a wheel that has
            // already closed.
            let _ = ShowWindowAsync(self.hwnd, SW_HIDE);
        }
        self.visible = false;
    }

    /// Release the back buffers while nothing is on screen.
    ///
    /// Two monitor-sized BGRA buffers are about 16 MB, and a launcher holds them for the hours
    /// between gestures. Shrinking them while hidden gives that back.
    ///
    /// The original could not do this: its overlay was parked at the size and position of the next
    /// open precisely so that opening cost no resize, because a resize on a VISIBLE window presents
    /// one frame of the old surface. That reasoning does not transfer — here the resize happens
    /// while the window is hidden and the next frame is drawn and committed before it is shown, so
    /// there is no surface for anyone to see. See `present_then_show`.
    ///
    /// `IDLE_SIDE` rather than 1x1: a swapchain of one pixel is a size some drivers refuse, and
    /// 16x16 is four hundred times smaller than a monitor either way.
    pub fn release_buffers(&mut self) {
        const IDLE_SIDE: u32 = 16;
        if self.visible || self.surface.size() == (IDLE_SIDE, IDLE_SIDE) {
            return;
        }
        let _ = self.surface.resize(IDLE_SIDE, IDLE_SIDE);
    }

    /// Grow the surface back to the window's own size, before the frame that will be shown.
    pub fn restore_buffers(&self) -> Result<()> {
        let (w, h) = (
            (self.bounds.right - self.bounds.left).max(1) as u32,
            (self.bounds.bottom - self.bounds.top).max(1) as u32,
        );
        self.surface.resize(w, h)
    }

    /// Re-assert topmost.
    ///
    /// Needed because another always-on-top window — a game's overlay, a screen recorder, the
    /// volume OSD — can take the front after this window was shown, and the wheel being behind
    /// something is the one failure a launcher cannot explain away. Cheap enough to do on every
    /// open rather than to detect.
    pub fn raise(&self) {
        unsafe {
            let _ = SetWindowPos(
                self.hwnd,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                windows::Win32::UI::WindowsAndMessaging::SWP_NOMOVE
                    | windows::Win32::UI::WindowsAndMessaging::SWP_NOSIZE
                    | SWP_NOACTIVATE,
            );
        }
    }
}

pub fn same_rect(a: RECT, b: RECT) -> bool {
    a.left == b.left && a.top == b.top && a.right == b.right && a.bottom == b.bottom
}

fn register_class() -> Result<()> {
    use std::sync::OnceLock;
    static DONE: OnceLock<bool> = OnceLock::new();
    if *DONE.get_or_init(|| {
        unsafe {
            let class = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(overlay_proc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: GetModuleHandleW(None).unwrap_or_default().into(),
                hIcon: HICON::default(),
                hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
                // No background brush. A class background is painted by `DefWindowProcW` on
                // `WM_ERASEBKGND`, and on a per-pixel-alpha window that is an opaque rectangle
                // drawn over the desktop before anything else gets a chance.
                hbrBackground: HBRUSH::default(),
                lpszMenuName: PCWSTR::null(),
                lpszClassName: CLASS_NAME,
                hIconSm: HICON::default(),
            };
            RegisterClassExW(&class) != 0
        }
    }) {
        Ok(())
    } else {
        Err(windows::core::Error::from_win32())
    }
}

/// The overlay's window procedure.
///
/// Deliberately almost empty. There is no `WM_PAINT` handling because the window has no
/// redirection surface to paint into — the swapchain is its content, and it is presented from the
/// frame loop. There is no mouse or keyboard handling because the hooks are the input path. What is
/// left is the messages that change the window's own geometry, and those are forwarded to the app
/// through its message window rather than handled here, so that one place decides what the wheel's
/// bounds should be.
unsafe extern "system" fn overlay_proc(
    hwnd: HWND,
    message: u32,
    w: WPARAM,
    l: LPARAM,
) -> LRESULT {
    use windows::Win32::UI::WindowsAndMessaging::{
        WM_DISPLAYCHANGE, WM_DPICHANGED, WM_ERASEBKGND, WM_PAINT,
    };
    match message {
        // The update region has to be validated here, not by `DefWindowProc`.
        //
        // This window has no redirection bitmap, so the default handler leaves the region dirty —
        // and `PeekMessage` synthesises `WM_PAINT` for as long as one is, which turns the message
        // loop into a spin. The content is presented from the render loop; nothing needs painting
        // in response to this.
        WM_PAINT => {
            let _ = windows::Win32::Graphics::Gdi::ValidateRect(hwnd, None);
            LRESULT(0)
        }

        // Answered rather than passed on: `DefWindowProcW` would fill the client area with the
        // class brush, and there is none — but the default for a null brush is still to do
        // nothing, and saying so explicitly is cheaper than a call.
        WM_ERASEBKGND => LRESULT(1),
        // Both are forwarded to the app, which owns the decision about which monitor the wheel
        // belongs on. Handling them here would be a second opinion.
        WM_DISPLAYCHANGE | WM_DPICHANGED => {
            let app = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
            if app != 0 {
                let _ = windows::Win32::UI::WindowsAndMessaging::PostMessageW(
                    HWND(app as _),
                    message,
                    w,
                    l,
                );
            }
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, message, w, l),
    }
}

/// Point the overlay at the app's message window, so geometry changes reach it.
pub fn set_app_window(overlay: &Overlay, app: HWND) {
    unsafe {
        SetWindowLongPtrW(overlay.hwnd, GWLP_USERDATA, app.0 as isize);
    }
}

/// The window's bounds for a wheel of this reach, on this display.
///
/// Two shapes, and which one is used is the whole of what `UiConfig::needs_full_bleed` decides.
///
/// **Full bleed** is the display's WORK AREA — not the monitor. The scrim is a dimming of the
/// DESKTOP, and a scrim drawn over the taskbar reads as the launcher having replaced the shell. A
/// dock in a bottom region lands just above the taskbar for the same reason.
///
/// **A box** is four times the wheel's reach, centred on it. Four, and not two, because the scrim's
/// pool has a radius of twice the reach: a box of twice would cut the pool at roughly half its
/// alpha, which is a dark rectangle with four hard edges sitting on a bright desktop. At four times
/// the pool has faded to nothing inside the box, so the box is invisible — which is the entire
/// point of having one. It keeps the compositor off a monitor-sized translucent surface for the
/// common case where the dimming is gentle.
///
/// When the box runs out of display it is clipped, and the clip then coincides with the physical
/// screen edge — so the cut is never visible there either.
pub fn bounds_for(display: &super::monitor::Display, center: (i32, i32), reach: f32, full_bleed: bool) -> RECT {
    if full_bleed {
        return display.work_area;
    }
    let half = (reach * 2.0).ceil() as i32;
    let work = display.work_area;
    RECT {
        left: (center.0 - half).max(work.left),
        top: (center.1 - half).max(work.top),
        right: (center.0 + half).min(work.right),
        bottom: (center.1 + half).min(work.bottom),
    }
}

/// Where the wheel's centre goes on this display.
///
/// `Center` is the middle of the work area. `Cursor` is under the pointer, pulled back from each
/// edge by the wheel's own reach — without that clamp, opening in a corner puts half the ring off
/// the screen, and the targets on that half cannot be aimed at.
pub fn center_for(
    display: &super::monitor::Display,
    placement: crate::config::RadialPlacement,
    cursor: windows::Win32::Foundation::POINT,
    reach: f32,
) -> (i32, i32) {
    use crate::config::RadialPlacement;
    match placement {
        RadialPlacement::Center => {
            let c = display.work_center();
            (c.x, c.y)
        }
        RadialPlacement::Cursor => {
            // Into the display's own space BEFORE clamping, and back out afterwards. The clamp is
            // expressed against a width and a height, so handing it a virtual-desktop coordinate
            // measures the pointer's distance from the PRIMARY's origin against the second
            // monitor's extent — which on a two-screen desktop puts the wheel a whole screen away
            // from the hand. The original warns about the same class of mistake for its own
            // screen-to-client conversion.
            let local = (
                (cursor.x - display.work_area.left) as f32,
                (cursor.y - display.work_area.top) as f32,
            );
            let clamped = crate::wheel::layout::clamp_wheel_center(
                local,
                (display.work_width() as f32, display.work_height() as f32),
                reach,
            );
            (
                display.work_area.left + clamped.0 as i32,
                display.work_area.top + clamped.1 as i32,
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::win::monitor::{Display, USER_DEFAULT_SCREEN_DPI};

    fn display() -> Display {
        Display {
            handle: 1,
            bounds: RECT { left: 0, top: 0, right: 1920, bottom: 1080 },
            // A taskbar 40px tall at the bottom.
            work_area: RECT { left: 0, top: 0, right: 1920, bottom: 1040 },
            dpi: USER_DEFAULT_SCREEN_DPI,
            is_primary: true,
        }
    }

    #[test]
    fn full_bleed_stops_at_the_taskbar() {
        // A scrim over the taskbar reads as the launcher having replaced the shell.
        let bounds = bounds_for(&display(), (960, 520), 226.0, true);
        assert_eq!(bounds.bottom, 1040);
        assert_eq!(bounds, display().work_area);
    }

    #[test]
    fn the_box_contains_the_whole_scrim_pool() {
        // The pool's radius is twice the reach; a box of less cuts it mid-alpha and the cut shows
        // as four hard edges on the desktop.
        let reach = 226.0_f32;
        let bounds = bounds_for(&display(), (960, 520), reach, false);
        let half_width = (bounds.right - bounds.left) as f32 / 2.0;
        assert!(
            half_width >= reach * 2.0 - 1.0,
            "half the box is {half_width}, the pool needs {}",
            reach * 2.0
        );
    }

    #[test]
    fn a_box_near_an_edge_is_clipped_to_the_work_area() {
        // Clipped there, the cut coincides with the physical screen edge and is not visible.
        let bounds = bounds_for(&display(), (100, 100), 226.0, false);
        assert_eq!(bounds.left, 0);
        assert_eq!(bounds.top, 0);
        assert!(bounds.right <= 1920);
    }

    #[test]
    fn centre_placement_is_the_middle_of_the_work_area() {
        let d = display();
        let at = center_for(&d, crate::config::RadialPlacement::Center, Default::default(), 226.0);
        assert_eq!(at, (960, 520));
    }

    #[test]
    fn cursor_placement_keeps_the_ring_on_screen() {
        use windows::Win32::Foundation::POINT;
        let d = display();
        let reach = 226.0;
        // A pointer in the top-left corner: the centre is pulled in by the reach, so the ring's
        // far side is still reachable.
        let at = center_for(
            &d,
            crate::config::RadialPlacement::Cursor,
            POINT { x: 5, y: 5 },
            reach,
        );
        assert!(at.0 as f32 >= reach - 1.0, "x={} reach={reach}", at.0);
        assert!(at.1 as f32 >= reach - 1.0, "y={} reach={reach}", at.1);
        // And in the middle it is left where the hand put it.
        let at = center_for(
            &d,
            crate::config::RadialPlacement::Cursor,
            POINT { x: 700, y: 400 },
            reach,
        );
        assert_eq!(at, (700, 400));
    }

    #[test]
    fn cursor_placement_on_a_second_monitor_stays_on_it() {
        // The clamp runs in the display's own space, so the offset has to be put back afterwards —
        // getting that wrong puts the wheel on the primary while the pointer is elsewhere.
        use windows::Win32::Foundation::POINT;
        let right = Display {
            handle: 2,
            bounds: RECT { left: 1920, top: 0, right: 3840, bottom: 1080 },
            work_area: RECT { left: 1920, top: 0, right: 3840, bottom: 1040 },
            dpi: USER_DEFAULT_SCREEN_DPI,
            is_primary: false,
        };
        let at = center_for(
            &right,
            crate::config::RadialPlacement::Cursor,
            POINT { x: 2800, y: 500 },
            226.0,
        );
        assert_eq!(at, (2800, 500));
        assert!(at.0 >= 1920, "the wheel left the monitor the pointer is on");
    }
}
