//! Dropping things onto the settings window.
//!
//! **Why OLE and not `WM_DROPFILES`.** `DragAcceptFiles` is four lines and handles files, and it
//! is the wrong four lines: it says nothing until the hand lets go. There is no drag-enter, so the
//! panel cannot show that it would take the drop, and a target that gives no feedback is a target
//! nobody tries twice. It also carries only `CF_HDROP` — a link dragged out of a browser arrives
//! as text and would be silently ignored, which is half of what the Electron build accepts.
//!
//! So this registers a real drop target. `IDropTarget` is told about the drag the moment it
//! crosses the window, is told where the pointer is on every move, and is told when it leaves —
//! which is exactly the three things the sheet in `ui::workspace` needs to draw.
//!
//! **What crosses the boundary.** Nothing but a [`Payload`] of owned strings. The `IDataObject`
//! belongs to the source process and is valid only for the length of the call, so everything
//! wanted from it is copied out inside `Drop` and the rest of the program never sees COM. That is
//! the same rule the Electron build follows for a different reason — there, a `DataTransfer` is
//! emptied the moment the event returns.

use crate::sys::dropped::Payload;
use std::sync::{Arc, Mutex};
use windows::core::implement;
use windows::Win32::Foundation::{HWND, POINT, POINTL};
use windows::Win32::Graphics::Gdi::{InvalidateRect, ScreenToClient};
use windows::Win32::System::Com::{
    IDataObject, DATADIR_GET, DVASPECT_CONTENT, FORMATETC, TYMED, TYMED_HGLOBAL,
};
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
use windows::Win32::System::Ole::{
    IDropTarget, IDropTarget_Impl, OleInitialize, RegisterDragDrop, ReleaseStgMedium,
    RevokeDragDrop, CF_HDROP, CF_UNICODETEXT, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE,
};
use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
use windows::Win32::UI::Shell::DragQueryFileW;

/// What the window knows about a drag in progress.
///
/// Read by the frame, written by the drop target, and shared by an `Arc` rather than reached
/// through the window's `State`: the two are written from different places — one from the window
/// procedure, one from a COM call the message loop makes on its own — and a `Mutex` is the only
/// honest way to say so.
#[derive(Default)]
pub struct Drag {
    /// True while a drag this window would accept is over it.
    pub hovering: bool,
    /// The pointer, in CLIENT pixels, so the panel can compare it with a rectangle it drew.
    pub point: (i32, i32),
    /// Set once, by the drop. Taken by the frame that imports it.
    pub dropped: Option<Payload>,
}

pub type Shared = Arc<Mutex<Drag>>;

/// Accept drops on `hwnd`, and give back the slot the frame reads.
///
/// `None` when OLE would not have us — which costs the feature and nothing else, so the caller
/// goes on without it rather than failing to open the window.
pub fn register(hwnd: HWND) -> Option<Shared> {
    let shared: Shared = Arc::new(Mutex::new(Drag::default()));
    unsafe {
        // The thread is already an STA from `main`, so this returns `S_FALSE` and does only the
        // OLE half — which is the half `RegisterDragDrop` needs and `CoInitializeEx` does not do.
        let _ = OleInitialize(None);
        let target: IDropTarget = Target {
            hwnd,
            shared: shared.clone(),
        }
        .into();
        if let Err(error) = RegisterDragDrop(hwnd, &target) {
            // Said out loud, because the symptom is silence: drag-and-drop simply does not work,
            // the window is otherwise perfect, and there is nothing on screen to suggest a
            // registration was ever attempted. `DRAGDROP_E_ALREADYREGISTERED` here would mean
            // this ran twice for one window.
            crate::config::store::log_line(&format!("drop: RegisterDragDrop failed: {error}"));
            return None;
        }
        // The target is kept alive by OLE, which holds a reference until `RevokeDragDrop`.
    }
    crate::config::store::log_line("drop: accepting drops on the settings window");
    Some(shared)
}

/// Stop accepting drops. Called as the window goes away; OLE releases the target with it.
pub fn revoke(hwnd: HWND) {
    unsafe {
        let _ = RevokeDragDrop(hwnd);
    }
}

#[implement(IDropTarget)]
struct Target {
    hwnd: HWND,
    shared: Shared,
}

impl Target {
    /// Note where the pointer is and ask for a frame, so the sheet follows the hand.
    ///
    /// The point arrives in SCREEN pixels, as every OLE drag point does, and is converted here
    /// rather than at the reader: the panel compares it against rectangles it laid out in client
    /// space, and a conversion done at the far end is one every future reader has to remember.
    fn moved(&self, pt: &POINTL, hovering: bool) {
        let mut point = POINT { x: pt.x, y: pt.y };
        unsafe {
            let _ = ScreenToClient(self.hwnd, &mut point);
        }
        if let Ok(mut drag) = self.shared.lock() {
            drag.hovering = hovering;
            drag.point = (point.x, point.y);
        }
        // The window's content is a swapchain and it has no `WM_PAINT` of its own to wait for, so
        // one is asked for: that is what sets `needs_frame` and gets the sheet drawn. A drag is
        // one of the few times the panel has to repaint while nothing is being clicked.
        unsafe {
            let _ = InvalidateRect(self.hwnd, None, false);
        }
    }

    fn clear(&self) {
        if let Ok(mut drag) = self.shared.lock() {
            drag.hovering = false;
        }
        unsafe {
            let _ = InvalidateRect(self.hwnd, None, false);
        }
    }
}

// On the GENERATED type, not on `Target`.
//
// `#[implement]` wraps the struct in a `Target_Impl` that owns the vtables and the reference
// count, and the vtable thunks are handed a `&Target_Impl`. So that is what has to carry the
// methods; the data this file actually cares about is one field in, at `self.this`, and the
// helpers above stay on `Target` where they can be read without the ceremony.
impl IDropTarget_Impl for Target_Impl {
    fn DragEnter(
        &self,
        data: Option<&IDataObject>,
        _keys: MODIFIERKEYS_FLAGS,
        pt: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        // Whether the drop would produce anything is decided HERE, from the formats on offer,
        // rather than at the drop. The cursor the user sees is this answer, and promising a copy
        // that then does nothing is worse than refusing it.
        let carries = data.map(carries_a_shortcut).unwrap_or(false);
        unsafe {
            if !effect.is_null() {
                *effect = if carries { DROPEFFECT_COPY } else { DROPEFFECT_NONE };
            }
        }
        self.this.moved(pt, carries);
        Ok(())
    }

    fn DragOver(
        &self,
        _keys: MODIFIERKEYS_FLAGS,
        pt: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        // `DragEnter` already said whether this drag is one we take, and the data object cannot
        // change mid-drag, so the answer is remembered rather than asked again — this runs on
        // every mouse move, across a process boundary.
        let hovering = self.this.shared.lock().map(|drag| drag.hovering).unwrap_or(false);
        unsafe {
            if !effect.is_null() {
                *effect = if hovering { DROPEFFECT_COPY } else { DROPEFFECT_NONE };
            }
        }
        if hovering {
            self.this.moved(pt, true);
        }
        Ok(())
    }

    fn DragLeave(&self) -> windows::core::Result<()> {
        self.this.clear();
        Ok(())
    }

    fn Drop(
        &self,
        data: Option<&IDataObject>,
        _keys: MODIFIERKEYS_FLAGS,
        pt: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        let payload = data.map(read_payload).unwrap_or_default();
        let took = !payload.is_empty();
        unsafe {
            if !effect.is_null() {
                *effect = if took { DROPEFFECT_COPY } else { DROPEFFECT_NONE };
            }
        }

        let mut point = POINT { x: pt.x, y: pt.y };
        unsafe {
            let _ = ScreenToClient(self.this.hwnd, &mut point);
        }
        if let Ok(mut drag) = self.this.shared.lock() {
            drag.hovering = false;
            drag.point = (point.x, point.y);
            if took {
                drag.dropped = Some(payload);
            }
        }
        unsafe {
            let _ = InvalidateRect(self.this.hwnd, None, false);
        }
        Ok(())
    }
}

/// A clipboard format this window knows how to read, as a `FORMATETC` asking for global memory.
fn wanted(format: u16) -> FORMATETC {
    FORMATETC {
        cfFormat: format,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    }
}

/// `CFSTR_INETURLW` — what a browser puts a dragged link in. Registered, not a constant.
fn inet_url_format() -> u16 {
    unsafe { RegisterClipboardFormatW(windows::core::w!("UniformResourceLocatorW")) as u16 }
}

/// Whether the drag offers anything at all. Asked on enter so the cursor tells the truth.
fn carries_a_shortcut(data: &IDataObject) -> bool {
    let url = inet_url_format();
    [CF_HDROP.0, url, CF_UNICODETEXT.0]
        .into_iter()
        .any(|format| unsafe { data.QueryGetData(&wanted(format)).is_ok() })
}

/// Everything this window wants out of the drag, copied into owned strings.
fn read_payload(data: &IDataObject) -> Payload {
    Payload {
        paths: read_files(data),
        uri_list: read_text(data, inet_url_format()).unwrap_or_default(),
        text: read_text(data, CF_UNICODETEXT.0).unwrap_or_default(),
    }
}

/// `CF_HDROP` — files and folders dragged out of Explorer.
fn read_files(data: &IDataObject) -> Vec<String> {
    let mut out = Vec::new();
    unsafe {
        let Ok(medium) = data.GetData(&wanted(CF_HDROP.0)) else {
            return out;
        };
        // `HDROP` is the global handle itself; `DragQueryFileW` takes it without locking.
        let drop = windows::Win32::UI::Shell::HDROP(medium.u.hGlobal.0);
        // `0xFFFF_FFFF` asks for the count rather than for a name.
        let count = DragQueryFileW(drop, 0xFFFF_FFFF, None);
        for index in 0..count {
            // The length first, then the characters: a path may be longer than `MAX_PATH` and a
            // fixed buffer is how a long one comes back silently truncated.
            let needed = DragQueryFileW(drop, index, None);
            if needed == 0 {
                continue;
            }
            let mut buffer = vec![0u16; needed as usize + 1];
            let written = DragQueryFileW(drop, index, Some(&mut buffer));
            if written > 0 {
                out.push(String::from_utf16_lossy(&buffer[..written as usize]));
            }
        }
        ReleaseStgMedium(&mut { medium });
    }
    out
}

/// A wide string out of global memory, for the two text formats.
fn read_text(data: &IDataObject, format: u16) -> Option<String> {
    if format == 0 {
        return None;
    }
    unsafe {
        let medium = data.GetData(&wanted(format)).ok()?;
        let handle = medium.u.hGlobal;
        let bytes = GlobalSize(handle);
        let locked = GlobalLock(handle) as *const u16;
        let text = if locked.is_null() || bytes < 2 {
            None
        } else {
            // `GlobalSize` can round up, so the terminator is what ends the string rather than
            // the allocation — reading to the end would bring the padding along with it.
            let max = bytes / 2;
            let mut len = 0usize;
            while len < max && *locked.add(len) != 0 {
                len += 1;
            }
            Some(String::from_utf16_lossy(std::slice::from_raw_parts(locked, len)))
        };
        if !locked.is_null() {
            let _ = GlobalUnlock(handle);
        }
        ReleaseStgMedium(&mut { medium });
        text.filter(|value| !value.trim().is_empty())
    }
}

/// `TYMED_HGLOBAL` as the enum, so the `FORMATETC` above and this file agree about one number.
const _: () = {
    let _ = TYMED(TYMED_HGLOBAL.0);
    let _ = DATADIR_GET;
};

/// What this window would make of the clipboard, read as if it had been dropped.
///
/// The one way to exercise the COM half without a hand on a mouse. `OleGetClipboard` hands back an
/// `IDataObject` carrying exactly the formats a drag does — `CF_HDROP` after copying files in
/// Explorer, `CF_UNICODETEXT` after copying text — so everything below `read_payload` is the same
/// code running against the same interface. Only the three `IDropTarget` callbacks are left out,
/// and they do nothing but call it.
///
/// Reached from `--probe-drop`; see the flag table in the README.
pub fn payload_from_clipboard() -> Option<Payload> {
    unsafe {
        let _ = OleInitialize(None);
        let data = windows::Win32::System::Ole::OleGetClipboard().ok()?;
        if !carries_a_shortcut(&data) {
            return None;
        }
        Some(read_payload(&data))
    }
}
