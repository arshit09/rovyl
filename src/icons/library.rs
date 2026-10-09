//! The icons inside a program or a DLL.
//!
//! Windows keeps most of its iconography in resource libraries — `shell32.dll` alone holds over
//! three hundred — and a shortcut's icon has been addressable as `file,index` since Windows 95.
//! That is the form `custom_icon_file` stores, so a workspace file written here opens correctly in
//! the Electron build and the other way round.
//!
//! `PrivateExtractIconsW` rather than `ExtractIconEx`: it takes the size wanted and does the
//! scaling itself, which matters because the wheel draws icons at 56 DIPs and `ExtractIconEx`
//! only ever offers the two the system calls large and small.
//!
//! Everything here is a disk read of somebody else's file, so everything here is called from a
//! WORKER.

use std::os::windows::ffi::OsStrExt;
use windows::Win32::Graphics::Gdi::{DeleteObject, GetObjectW, GetDIBits, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HDC, CreateCompatibleDC, DeleteDC};
use windows::Win32::UI::WindowsAndMessaging::PrivateExtractIconsW;
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

/// The size icons are pulled at.
///
/// 256 because that is the largest a modern resource holds and the store keeps one copy for every
/// size the wheel might be set to. Asking for less and scaling up later is how an icon arrives
/// soft on a 4K display.
pub const SIZE: u32 = 256;

/// The path as the API wants it: a fixed `MAX_PATH` buffer, not a pointer.
///
/// A longer path is refused rather than truncated. A truncated path names a different file, and
/// the icons of a different file are worse than no icons.
fn wide_path(path: &std::path::Path) -> Option<[u16; 260]> {
    let mut buffer = [0u16; 260];
    let text: Vec<u16> = path.as_os_str().encode_wide().collect();
    if text.len() >= buffer.len() {
        return None;
    }
    buffer[..text.len()].copy_from_slice(&text);
    Some(buffer)
}

/// How many icons a file holds.
pub fn count(path: &std::path::Path) -> u32 {
    let Some(buffer) = wide_path(path) else {
        return 0;
    };
    // No output array: the return is then the count.
    unsafe { PrivateExtractIconsW(&buffer, 0, 0, 0, None, None, 0) }
}

/// One icon from a file, as premultiplied BGRA at `SIZE` square.
pub fn extract(path: &std::path::Path, index: u32) -> Option<Vec<u8>> {
    let buffer = wide_path(path)?;
    unsafe {
        let mut icons = [HICON::default(); 1];
        let mut id: u32 = 0;
        let taken = PrivateExtractIconsW(
            &buffer,
            index as i32,
            SIZE as i32,
            SIZE as i32,
            Some(&mut icons),
            Some(&mut id),
            0,
        );
        if taken == 0 || icons[0].is_invalid() {
            return None;
        }
        let pixels = icon_pixels(icons[0]);
        let _ = DestroyIcon(icons[0]);
        pixels
    }
}

/// Read an `HICON`'s colour bitmap out as premultiplied BGRA.
///
/// The alpha is the one thing worth being careful about. A 32-bit icon carries its own, and a
/// 1-bit or 8-bit one does not — for those every pixel comes back opaque and the MASK decides what
/// shows. Treating the second kind as if it had alpha gives a black square, which is what every
/// naive icon reader produces for the older half of `shell32.dll`.
unsafe fn icon_pixels(icon: HICON) -> Option<Vec<u8>> {
    let mut info = ICONINFO::default();
    GetIconInfo(icon, &mut info).ok()?;
    // Both bitmaps are owned by the caller from here.
    let colour = info.hbmColor;
    let mask = info.hbmMask;
    let cleanup = || {
        if !colour.is_invalid() {
            let _ = DeleteObject(colour);
        }
        if !mask.is_invalid() {
            let _ = DeleteObject(mask);
        }
    };

    if colour.is_invalid() {
        cleanup();
        return None;
    }

    let mut bitmap = BITMAP::default();
    let read = GetObjectW(
        colour,
        std::mem::size_of::<BITMAP>() as i32,
        Some(&mut bitmap as *mut BITMAP as *mut _),
    );
    if read == 0 || bitmap.bmWidth <= 0 || bitmap.bmHeight <= 0 {
        cleanup();
        return None;
    }
    let width = bitmap.bmWidth as u32;
    let height = bitmap.bmHeight as u32;

    let dc: HDC = CreateCompatibleDC(None);
    if dc.is_invalid() {
        cleanup();
        return None;
    }

    let mut header = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            // NEGATIVE: top-down, so row zero is the top one. A positive height gives the rows
            // upside down, which is the single most common way an icon reader produces a mirrored
            // image and then "fixes" it with a flip somewhere else.
            biHeight: -(height as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };

    let mut pixels = vec![0u8; (width * height * 4) as usize];
    let lines = GetDIBits(
        dc,
        colour,
        0,
        height,
        Some(pixels.as_mut_ptr() as *mut _),
        &mut header,
        DIB_RGB_COLORS,
    );
    if lines == 0 {
        let _ = DeleteDC(dc);
        cleanup();
        return None;
    }

    // Does this icon actually carry alpha, or is every pixel opaque because it has none?
    let has_alpha = pixels.chunks_exact(4).any(|p| p[3] != 0);
    if !has_alpha {
        // Fall back to the mask: a set bit means TRANSPARENT in an icon's AND mask.
        let mut mask_pixels = vec![0u8; (width * height * 4) as usize];
        let mut mask_header = header;
        let read = if mask.is_invalid() {
            0
        } else {
            GetDIBits(
                dc,
                mask,
                0,
                height,
                Some(mask_pixels.as_mut_ptr() as *mut _),
                &mut mask_header,
                DIB_RGB_COLORS,
            )
        };
        for (index, pixel) in pixels.chunks_exact_mut(4).enumerate() {
            let transparent = read != 0 && mask_pixels[index * 4] != 0;
            pixel[3] = if transparent { 0 } else { 255 };
        }
    }

    let _ = DeleteDC(dc);
    cleanup();

    // Premultiply, which is what the swapchain and every bitmap in this program expect.
    for pixel in pixels.chunks_exact_mut(4) {
        let alpha = pixel[3] as u32;
        if alpha != 255 {
            pixel[0] = ((pixel[0] as u32 * alpha) / 255) as u8;
            pixel[1] = ((pixel[1] as u32 * alpha) / 255) as u8;
            pixel[2] = ((pixel[2] as u32 * alpha) / 255) as u8;
        }
    }
    // A fully transparent icon is not an icon. Several indexes in every library are placeholders.
    if pixels.chunks_exact(4).all(|p| p[3] == 0) {
        return None;
    }
    Some(pixels)
}

/// Store one icon out of a library and return the reference and the `file,index` it came from.
pub fn put(path: &std::path::Path, index: u32) -> Option<(String, String)> {
    let pixels = extract(path, index)?;
    let bytes = crate::gfx::encode::encode_png(&pixels, SIZE, SIZE).ok()?;
    let reference = super::store::put(&bytes, "png").ok()?;
    // The `file,index` form Windows has used for shortcut icons since 1995, which is what makes a
    // workspace file written here open correctly in the Electron build.
    let origin = format!("{},{index}", path.display());
    Some((reference, origin))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell32_holds_hundreds_of_icons_and_they_decode() {
        let Some(path) = crate::sys::picker::windows_library("shell32.dll") else {
            return;
        };
        let total = count(&path);
        assert!(total > 100, "shell32 reported {total} icons");

        // The first few, which are the folder and drive icons every Windows has.
        let mut decoded = 0;
        for index in 0..6 {
            if let Some(pixels) = extract(&path, index) {
                assert_eq!(pixels.len(), (SIZE * SIZE * 4) as usize);
                // Not blank, and not a black square -- the failure mode when alpha is read wrong.
                assert!(pixels.chunks_exact(4).any(|p| p[3] > 0), "index {index} is empty");
                assert!(
                    pixels.chunks_exact(4).any(|p| p[3] > 0 && (p[0] > 8 || p[1] > 8 || p[2] > 8)),
                    "index {index} is a black square"
                );
                decoded += 1;
            }
        }
        assert!(decoded > 0, "nothing decoded out of shell32");
    }

    #[test]
    fn a_file_with_no_icons_reports_none() {
        assert_eq!(count(std::path::Path::new("Z:/nothing/here.dll")), 0);
        assert!(extract(std::path::Path::new("Z:/nothing/here.dll"), 0).is_none());
    }
}
