//! Displays: where they are, how big their work areas are, and what they scale by.
//!
//! One function answers "which monitor" for the wheel — `target_display` — and every caller that
//! decides the wheel's geometry goes through it. They HAVE to agree: the idle overlay parks itself
//! on the monitor the next open will use precisely so that opening costs no window move, and a
//! move on this window is a visible flash on some drivers.
//!
//! Everything here is in PHYSICAL pixels. That is the one deliberate departure from the Electron
//! build, and it closes a real defect rather than a tidiness one.
//!
//! The original passed DIP rectangles to a DPI-unaware PowerShell process that then compared them
//! against raw `MSLLHOOKSTRUCT` points. Those two coordinate spaces agree only while every monitor
//! shares the primary's scale factor: an unaware process is virtualised by the SYSTEM DPI,
//! uniformly across the virtual desktop, while Electron derives DIPs PER DISPLAY. On a 150% primary
//! with a 100% secondary, the secondary's 1920 logical pixels reached the hook as 1280 of its
//! virtualised units — so the allowed region landed partly off the wheel and the confirming click
//! could be swallowed. That is `docs/ARCHITECTURE.md`'s "known limitation", and it exists because
//! two processes in two DPI spaces had to agree about a rectangle.
//!
//! This process is `PerMonitorAwareV2` and there is no second process, so there is one space:
//! physical pixels, with the scale factor carried alongside for the one thing that actually needs
//! it — turning the user's DIP-denominated settings into pixels at paint time.

use windows::Win32::Foundation::{BOOL, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, MonitorFromPoint, MonitorFromWindow, HDC, HMONITOR,
    MONITORINFO, MONITORINFOEXW, MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTOPRIMARY,
};
use windows::Win32::UI::HiDpi::{
    GetDpiForMonitor, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT,
    MDT_EFFECTIVE_DPI,
};
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

/// `DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2`.
///
/// Declared here rather than imported because the constant's binding moves between `windows` crate
/// versions and its value is part of the OS ABI. V2 and not V1: V2 scales non-client areas and
/// dialogs with the monitor, and sends `WM_DPICHANGED` before the move rather than after, which is
/// what lets a window that crosses monitors paint its first frame at the new scale.
const PER_MONITOR_AWARE_V2: DPI_AWARENESS_CONTEXT = DPI_AWARENESS_CONTEXT(-4isize as _);

/// 96 DPI is 100%. Every scale factor in this file is `dpi / 96`.
pub const USER_DEFAULT_SCREEN_DPI: u32 = 96;

/// Declare this process per-monitor DPI aware, before any window exists.
///
/// It must run before the first HWND: awareness is latched per window on creation, and a window
/// created while the process is unaware stays virtualised for its whole life — which on a scaled
/// monitor means every coordinate this file reports is a lie by the scale factor.
///
/// A manifest would be the orthodox place for this, and the API call is used instead on purpose:
/// the manifest is embedded by the linker and silently absent in a few build configurations (a
/// `cargo run` against an older toolchain among them), and a DPI bug that appears only in some
/// builds is the kind that reaches a release.
pub fn declare_dpi_awareness() {
    unsafe {
        // Failure means the awareness was already set — by a manifest, or because this ran twice.
        // Either way the process is aware and there is nothing to report.
        let _ = SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Display {
    pub handle: isize,
    /// The whole monitor, in physical pixels, in virtual-desktop coordinates.
    pub bounds: RECT,
    /// The monitor minus the taskbar and any other appbar.
    ///
    /// The wheel is sized to this and not to `bounds`: the scrim is a dimming of the DESKTOP, and
    /// a scrim drawn over the taskbar reads as the launcher having replaced the shell.
    pub work_area: RECT,
    pub dpi: u32,
    pub is_primary: bool,
}

impl Display {
    pub fn scale(&self) -> f32 {
        self.dpi as f32 / USER_DEFAULT_SCREEN_DPI as f32
    }

    pub fn work_width(&self) -> i32 {
        self.work_area.right - self.work_area.left
    }

    pub fn work_height(&self) -> i32 {
        self.work_area.bottom - self.work_area.top
    }

    pub fn work_center(&self) -> POINT {
        POINT {
            x: self.work_area.left + self.work_width() / 2,
            y: self.work_area.top + self.work_height() / 2,
        }
    }

    pub fn contains(&self, point: POINT) -> bool {
        point.x >= self.bounds.left
            && point.x < self.bounds.right
            && point.y >= self.bounds.top
            && point.y < self.bounds.bottom
    }
}

fn info_for(handle: HMONITOR) -> Option<Display> {
    if handle.is_invalid() {
        return None;
    }
    unsafe {
        let mut ex = MONITORINFOEXW {
            monitorInfo: MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFOEXW>() as u32,
                ..Default::default()
            },
            ..Default::default()
        };
        if !GetMonitorInfoW(handle, &mut ex as *mut _ as *mut MONITORINFO).as_bool() {
            return None;
        }
        let mut dpi_x = USER_DEFAULT_SCREEN_DPI;
        let mut dpi_y = USER_DEFAULT_SCREEN_DPI;
        // A failure here is a monitor that was unplugged between the enumeration and this call.
        // 96 is the right answer for a display that no longer exists: it keeps the arithmetic
        // finite until the next `WM_DISPLAYCHANGE` replaces the list.
        let _ = GetDpiForMonitor(handle, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);
        Some(Display {
            handle: handle.0 as isize,
            bounds: ex.monitorInfo.rcMonitor,
            work_area: ex.monitorInfo.rcWork,
            // Square pixels are the only case Windows reports, and a wheel is round: using the
            // larger of the two would stretch it on the hypothetical display that does not.
            dpi: dpi_x,
            is_primary: (ex.monitorInfo.dwFlags & 1) != 0, // MONITORINFOF_PRIMARY
        })
    }
}

unsafe extern "system" fn collect(
    handle: HMONITOR,
    _hdc: HDC,
    _rect: *mut RECT,
    data: LPARAM,
) -> BOOL {
    let list = &mut *(data.0 as *mut Vec<Display>);
    if let Some(display) = info_for(handle) {
        list.push(display);
    }
    BOOL(1)
}

/// Every display attached right now.
///
/// Re-enumerated on `WM_DISPLAYCHANGE` rather than cached for the session: a laptop that docks
/// gains and loses monitors several times a day, and a stale list puts the wheel on a screen that
/// is not there.
pub fn displays() -> Vec<Display> {
    let mut list: Vec<Display> = Vec::with_capacity(4);
    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(collect),
            LPARAM(&mut list as *mut _ as isize),
        );
    }
    if list.is_empty() {
        // No monitors at all is a session with no desktop — an RDP connection mid-teardown. A
        // single notional display keeps every consumer's arithmetic finite.
        list.push(Display {
            handle: 0,
            bounds: RECT { left: 0, top: 0, right: 1920, bottom: 1080 },
            work_area: RECT { left: 0, top: 0, right: 1920, bottom: 1080 },
            dpi: USER_DEFAULT_SCREEN_DPI,
            is_primary: true,
        });
    }
    list
}

pub fn primary() -> Display {
    unsafe {
        info_for(MonitorFromPoint(
            POINT { x: 0, y: 0 },
            MONITOR_DEFAULTTOPRIMARY,
        ))
    }
    .unwrap_or_else(|| displays().into_iter().next().expect("displays() never returns empty"))
}

pub fn cursor_position() -> POINT {
    let mut point = POINT::default();
    unsafe {
        // A failure leaves the point at the origin, which resolves to the primary monitor — the
        // same screen the `Primary` setting would have chosen anyway.
        let _ = GetCursorPos(&mut point);
    }
    point
}

pub fn from_point(point: POINT) -> Display {
    unsafe { info_for(MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST)) }.unwrap_or_else(primary)
}

pub fn from_window(hwnd: windows::Win32::Foundation::HWND) -> Display {
    unsafe { info_for(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)) }.unwrap_or_else(primary)
}

/// Which monitor the wheel opens on — the single answer, which every geometry caller uses.
///
/// Two settings meet here and they answer two different questions. `monitor` chooses the SCREEN;
/// `placement` chooses the point on it. Choosing `Primary` and `Cursor` together is asking for two
/// places at once, and the pointer wins, because a wheel under a pointer that is on the second
/// monitor *is* on the second monitor — and the pointer is the one the hand can see.
pub fn target_display(
    monitor: crate::config::RadialMonitor,
    placement: crate::config::RadialPlacement,
) -> Display {
    use crate::config::{RadialMonitor, RadialPlacement};
    let follows_cursor =
        matches!(monitor, RadialMonitor::Cursor) || matches!(placement, RadialPlacement::Cursor);
    if follows_cursor {
        from_point(cursor_position())
    } else {
        primary()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scale_is_dpi_over_ninety_six() {
        let mut d = primary();
        d.dpi = 144;
        assert!((d.scale() - 1.5).abs() < 1e-6);
        d.dpi = 96;
        assert!((d.scale() - 1.0).abs() < 1e-6);
    }

    #[test]
    fn enumeration_never_comes_back_empty() {
        // Every consumer divides by a width; an empty list would be a panic at startup on a
        // session whose desktop is mid-teardown.
        assert!(!displays().is_empty());
    }

    #[test]
    fn the_work_area_never_exceeds_the_monitor() {
        for d in displays() {
            assert!(d.work_area.left >= d.bounds.left);
            assert!(d.work_area.top >= d.bounds.top);
            assert!(d.work_area.right <= d.bounds.right);
            assert!(d.work_area.bottom <= d.bounds.bottom);
        }
    }

    #[test]
    fn exactly_one_display_is_primary() {
        let list = displays();
        assert_eq!(list.iter().filter(|d| d.is_primary).count(), 1, "{list:?}");
    }
}
