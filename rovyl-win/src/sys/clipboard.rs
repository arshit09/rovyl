//! Putting text on the clipboard, and taking it off again.
//!
//! Writing has three rules the API demands: open it, EMPTY it (ownership does not transfer
//! otherwise), and hand over an `HGLOBAL` the system then owns — which is why the handle is not
//! freed on the success path and must be on every failure path after the allocation.
//!
//! Reading has one: the block belongs to whoever put it there, so it is locked, COPIED, and
//! unlocked. Holding the pointer past `CloseClipboard` is holding a pointer into another
//! process's memory.

use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::CF_UNICODETEXT;

/// Copy `text`. Best effort: a clipboard another program is holding open is a reason to do
/// nothing, not a reason to fail a launch or a frame.
pub fn put(text: &str) {
    if text.is_empty() {
        return;
    }
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let bytes = std::mem::size_of_val(&wide[..]);

    unsafe {
        if OpenClipboard(None).is_err() {
            return;
        }
        // Everything past here must close the clipboard, so the work is done in a closure and the
        // close happens once, after it.
        let copied = (|| {
            EmptyClipboard().ok()?;
            let handle: HGLOBAL = GlobalAlloc(GMEM_MOVEABLE, bytes).ok()?;
            let destination = GlobalLock(handle);
            if destination.is_null() {
                let _ = GlobalFree(handle);
                return None;
            }
            std::ptr::copy_nonoverlapping(wide.as_ptr(), destination as *mut u16, wide.len());
            let _ = GlobalUnlock(handle);
            // On success the SYSTEM owns the block. Freeing it here would hand the clipboard a
            // pointer to memory this process had just given back.
            match SetClipboardData(CF_UNICODETEXT.0 as u32, HANDLE(handle.0)) {
                Ok(_) => Some(()),
                Err(_) => {
                    let _ = GlobalFree(handle);
                    None
                }
            }
        })();
        let _ = CloseClipboard();
        let _ = copied;
    }
}

/// The clipboard's text, if it holds any.
///
/// `None` for an empty clipboard, for a clipboard holding something that is not text, and for one
/// another program has open — all three are the same answer to the caller: there is nothing to
/// paste. Best effort, like `put`: a paste that cannot read the clipboard is a keystroke that does
/// nothing, not a failed frame.
pub fn get() -> Option<String> {
    unsafe {
        if IsClipboardFormatAvailable(CF_UNICODETEXT.0 as u32).is_err() {
            return None;
        }
        if OpenClipboard(None).is_err() {
            return None;
        }
        // Same shape as `put`: everything past the open happens in a closure, so the close happens
        // once and on every path out of it.
        let text = (|| {
            let handle = GetClipboardData(CF_UNICODETEXT.0 as u32).ok()?;
            let global = HGLOBAL(handle.0);
            let source = GlobalLock(global) as *const u16;
            if source.is_null() {
                return None;
            }
            // `GlobalSize` is a CEILING, not a length: the allocation may be rounded up and the
            // string's own terminator is inside it. The run is taken up to the first NUL, which is
            // where the text actually ends.
            let capacity = GlobalSize(global) / std::mem::size_of::<u16>();
            let units = std::slice::from_raw_parts(source, capacity);
            let length = units.iter().position(|&u| u == 0).unwrap_or(capacity);
            let owned = String::from_utf16_lossy(&units[..length]);
            let _ = GlobalUnlock(global);
            Some(owned)
        })();
        let _ = CloseClipboard();
        text.filter(|t| !t.is_empty())
    }
}
