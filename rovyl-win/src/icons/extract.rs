//! Getting an application's own icon.
//!
//! **One API for both kinds of application.** The Electron build read `AppxManifest.xml` by hand
//! for packaged apps and used `IShellItemImageFactory` for desktop ones, because its renderer's
//! image path produced poor results for the first kind. That split is not needed here:
//! `IShellItemImageFactory::GetImage` on the AppsFolder item already reads the package manifest for
//! a Store app and extracts from the executable for a desktop one — it is the same code the Start
//! menu itself draws with, which is the only sensible definition of "the app's icon".
//!
//! **Order matters, and it is the original's.** The image is asked for WITHOUT `SCALEUP` first, so
//! the shell returns the largest asset it actually has and only one resample happens. A request
//! that allows scaling up gets a 32px icon stretched to 256 and no way to tell that it did.
//!
//! **Every candidate is measured for a white halo.** That is the signature of an icon composited
//! over a light plate and then alpha-cut, and it looks like a sticker on the wheel's dark tiles. A
//! dirty candidate loses to a clean one from another source — which is the whole reason more than
//! one source is tried.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::collections::VecDeque;
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::SIZE;
use windows::Win32::Graphics::Gdi::{DeleteObject, GetObjectW, GetDIBits, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, GetDC, ReleaseDC, HBITMAP};
use windows::Win32::UI::Shell::{
    IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF, SIIGBF_BIGGERSIZEOK,
    SIIGBF_ICONONLY, SIIGBF_RESIZETOFIT,
};

/// The size every icon is normalised to.
///
/// 256 because that is the largest an application is likely to ship and the largest the wheel can
/// draw at a big icon-size setting on a 200% display. Smaller would mean a second extraction the
/// day somebody turns the slider up.
pub const SIZE_PX: i32 = 256;

/// Extract and normalise the icon for a command, as PNG bytes.
///
/// Blocking and slow — shell I/O, sometimes a cold read of an executable's resources. WORKER ONLY.
pub fn extract(command: &str) -> Option<Vec<u8>> {
    let target = resolve(command)?;

    // Two candidates, best-first, and the second only exists so a haloed first can lose to it.
    //
    // `BIGGERSIZEOK` asks the shell for the largest asset it has rather than for exactly 256,
    // which is what keeps the resample count at one. `ICONONLY` refuses a thumbnail — for a
    // document or a folder the shell will happily return a PREVIEW, and a preview of the file a
    // shortcut points at is not that shortcut's icon.
    let mut best: Option<(Vec<u8>, f32)> = None;
    for flags in [
        SIIGBF_BIGGERSIZEOK,
        SIIGBF_ICONONLY | SIIGBF_RESIZETOFIT,
    ] {
        let Some(pixels) = shell_image(&target, flags) else {
            continue;
        };
        let halo = halo_score(&pixels.0, pixels.1, pixels.2);
        let keep = match &best {
            Some((_, best_halo)) => halo < *best_halo,
            None => true,
        };
        if keep {
            let encoded = crate::gfx::encode::encode_png(&pixels.0, pixels.1, pixels.2).ok();
            if let Some(encoded) = encoded {
                best = Some((encoded, halo));
            }
        }
        // A clean candidate ends the search: the second source is only ever a fallback.
        if halo < HALO_CLEAN {
            break;
        }
    }
    best.map(|(bytes, _)| bytes)
}

/// Below this, an icon is clean enough that no other source will do better.
const HALO_CLEAN: f32 = 0.12;

/// The shell item a command names.
///
/// An AppsFolder moniker goes to the shell as-is; a path goes as a path; anything else — an alias
/// like `notepad`, a URL — has no shell item at all and returns `None` rather than guessing.
fn resolve(command: &str) -> Option<HSTRING> {
    let trimmed = command.trim();
    // `unquote` is for ONE token and is applied as one here. Unwrapping the whole command line
    // first is wrong in a way that only shows on a line with two quoted parts:
    // `"C:\Tools\code.exe" "D:\Work"` starts and ends with a quote, so stripping both leaves
    // `C:\Tools\code.exe" "D:\Work` — and the executable comes out with a quote welded to it.
    let single = crate::launch::parse::unquote(trimmed);
    if crate::launch::parse::is_apps_folder(single) {
        return Some(HSTRING::from(single));
    }
    if crate::launch::parse::looks_like_bare_app_id(trimmed) {
        return Some(HSTRING::from(crate::launch::parse::to_apps_folder(trimmed)));
    }
    // A command line: the icon belongs to the executable, not to its arguments. The splitter
    // already understands a quoted first token, so the unquote belongs after it.
    let (exe, _) = crate::launch::parse::split_exe_and_args(trimmed);
    let exe = crate::launch::parse::unquote(&exe).to_string();
    if exe.is_empty() {
        return None;
    }
    if crate::launch::parse::is_absolute_target(&exe) {
        return Some(HSTRING::from(exe));
    }
    // A bare alias — `notepad`, `calc`. The shell cannot make an item from one, and the AppsFolder
    // entry (if there is one) was already covered above.
    None
}

/// Ask the shell for an image, as premultiplied BGRA.
fn shell_image(target: &HSTRING, flags: SIIGBF) -> Option<(Vec<u8>, u32, u32)> {
    unsafe {
        let factory: IShellItemImageFactory =
            SHCreateItemFromParsingName(PCWSTR(target.as_ptr()), None).ok()?;
        let bitmap = factory
            .GetImage(
                SIZE {
                    cx: SIZE_PX,
                    cy: SIZE_PX,
                },
                flags,
            )
            .ok()?;
        let pixels = read_bitmap(bitmap);
        // The shell hands over ownership of the HBITMAP; leaking one per icon per scan is how a
        // launcher exhausts the GDI object quota on a machine with three hundred applications.
        let handle: windows::Win32::Graphics::Gdi::HGDIOBJ = bitmap.into();
        let _ = DeleteObject(handle);
        pixels
    }
}

/// An `HBITMAP` as premultiplied BGRA, top-down.
fn read_bitmap(bitmap: HBITMAP) -> Option<(Vec<u8>, u32, u32)> {
    unsafe {
        let mut info = BITMAP::default();
        let handle: windows::Win32::Graphics::Gdi::HGDIOBJ = bitmap.into();
        if GetObjectW(
            handle,
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut info as *mut _ as *mut _),
        ) == 0
        {
            return None;
        }
        let (width, height) = (info.bmWidth, info.bmHeight);
        if width <= 0 || height <= 0 {
            return None;
        }

        let mut header = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                // Negative for a TOP-DOWN DIB. A positive height gives the rows bottom-up, and an
                // icon that is upside down is the single most obvious way to get this wrong.
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = vec![0u8; (width * height * 4) as usize];
        let dc = GetDC(None);
        let rows = GetDIBits(
            dc,
            bitmap,
            0,
            height as u32,
            Some(pixels.as_mut_ptr() as *mut _),
            &mut header,
            DIB_RGB_COLORS,
        );
        ReleaseDC(None, dc);
        if rows == 0 {
            return None;
        }

        // The shell returns STRAIGHT alpha here; the renderer and the store both want it
        // premultiplied. Doing it once, now, is what keeps the per-frame path a straight upload.
        //
        // An image whose alpha is entirely zero is one the shell produced without a mask — a 24-bit
        // icon. Treating that as fully transparent would draw nothing, so it is taken as opaque.
        let opaque = pixels.chunks_exact(4).all(|p| p[3] == 0);
        for pixel in pixels.chunks_exact_mut(4) {
            if opaque {
                pixel[3] = 255;
                continue;
            }
            let alpha = pixel[3] as u32;
            pixel[0] = ((pixel[0] as u32 * alpha) / 255) as u8;
            pixel[1] = ((pixel[1] as u32 * alpha) / 255) as u8;
            pixel[2] = ((pixel[2] as u32 * alpha) / 255) as u8;
        }
        Some((pixels, width as u32, height as u32))
    }
}

/// How much of a white halo this image has, 0..1.
///
/// The signature of an icon composited over a light plate and then alpha-cut: the pixels just
/// INSIDE the shape's edge are near-white, while the shape's interior is not. On the wheel's dark
/// tiles that reads as a white outline drawn around the icon — a sticker rather than an app.
///
/// Measured rather than guessed, because it cannot be predicted from the source: the same
/// application can produce a clean image through one shell flag and a haloed one through another,
/// which is the entire reason more than one is tried.
fn halo_score(pixels: &[u8], width: u32, height: u32) -> f32 {
    let at = |x: u32, y: u32| -> [u8; 4] {
        let i = ((y * width + x) * 4) as usize;
        [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]]
    };
    let near_white = |p: [u8; 4]| p[3] > 200 && p[0] > 228 && p[1] > 228 && p[2] > 228;

    let mut edge_total = 0u32;
    let mut edge_white = 0u32;
    let mut inside_total = 0u32;
    let mut inside_white = 0u32;

    // Every opaque pixel with a transparent neighbour is on the edge. Anything else that is opaque
    // is interior.
    for y in 1..height.saturating_sub(1) {
        for x in 1..width.saturating_sub(1) {
            let p = at(x, y);
            if p[3] < 160 {
                continue;
            }
            let transparent_neighbour = at(x - 1, y)[3] < 60
                || at(x + 1, y)[3] < 60
                || at(x, y - 1)[3] < 60
                || at(x, y + 1)[3] < 60;
            if transparent_neighbour {
                edge_total += 1;
                if near_white(p) {
                    edge_white += 1;
                }
            } else {
                inside_total += 1;
                if near_white(p) {
                    inside_white += 1;
                }
            }
        }
    }

    if edge_total < 32 || inside_total == 0 {
        // Too little shape to judge. Not a halo — a square icon with no transparency at all has no
        // edge pixels by this definition, and calling that dirty would reject most of them.
        return 0.0;
    }
    let edge_ratio = edge_white as f32 / edge_total as f32;
    let inside_ratio = inside_white as f32 / inside_total as f32;
    // The DIFFERENCE, not the edge alone. An icon that is genuinely white all over — a logo on a
    // transparent background — has a white edge and a white interior and is perfectly fine; what is
    // wrong is a white edge around something that is not white.
    (edge_ratio - inside_ratio).max(0.0)
}

// ─── The queue ──────────────────────────────────────────────────────────────

/// One finished extraction: the item it was for, and the reference it stored.
///
/// A web job can also bring back the page's own name, which is what a URL shortcut should be
/// called instead of `github.com`. `None` means the page did not say, or was not asked.
pub struct Extracted {
    pub item_id: String,
    pub reference: String,
    pub title: Option<String>,
}

/// Where a picture comes from.
///
/// Two sources, one queue, one worker. They share it because the expensive part is the same shape
/// — something slow that must not happen on a frame — and because an item wants exactly one of
/// them: a `shell:AppsFolder` moniker has no favicon and a URL has no resources to read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// A command line or a shell moniker, read through the shell's imaging factory.
    Shell(String),
    /// A hostname, asked of the icon services. `want_title` also fetches the page's own name.
    Web { host: String, want_title: bool },
}

struct Queue {
    items: Mutex<VecDeque<(String, Source)>>,
    wake: Condvar,
    stop: AtomicBool,
    /// Whether the worker is in the middle of a job.
    ///
    /// Separate from the queue being empty, because it is empty for the whole time the one job it
    /// held is being worked on. A caller that waits for "nothing pending" and reads only the queue
    /// stops waiting the instant the work STARTS -- which is how `--seed` reported no favicon for
    /// a site it had just gone and asked about.
    busy: AtomicBool,
}

/// A background extractor.
///
/// Shell extraction is the slowest thing this program does — a cold read of an executable's
/// resources can take tens of milliseconds, and a first discovery asks for three hundred of them.
/// It therefore runs on ONE worker, not several: the work is mostly disk, and three hundred
/// parallel cold reads is slower than three hundred sequential ones and competes with whatever the
/// user is actually doing.
pub struct Extractor {
    queue: Arc<Queue>,
    results: Receiver<Extracted>,
    /// Posted to when something finishes, so the UI thread can be blocked in `WaitMessage` the
    /// rest of the time. Without it the loop would need a timer, and a launcher that wakes sixty
    /// times a second while doing nothing is the thing this port exists to avoid.
    wake: Arc<Mutex<Option<isize>>>,
    /// What has already been asked for, so a repeated request does not re-extract.
    seen: std::cell::RefCell<std::collections::HashSet<String>>,
}

impl Extractor {
    pub fn new() -> Self {
        let queue = Arc::new(Queue {
            items: Mutex::new(VecDeque::new()),
            wake: Condvar::new(),
            stop: AtomicBool::new(false),
            busy: AtomicBool::new(false),
        });
        let (sender, results) = std::sync::mpsc::channel();
        let wake: Arc<Mutex<Option<isize>>> = Arc::new(Mutex::new(None));
        {
            let queue = Arc::clone(&queue);
            let wake = Arc::clone(&wake);
            std::thread::Builder::new()
                .name("rovyl-extract".into())
                .spawn(move || worker(queue, sender, wake))
                .ok();
        }
        Self {
            queue,
            results,
            wake,
            seen: std::cell::RefCell::new(std::collections::HashSet::new()),
        }
    }

    /// Where to post when work finishes.
    pub fn wake_on(&self, hwnd: isize, message: u32) {
        *self.wake.lock().unwrap() = Some((hwnd << 16) | message as isize);
    }

    /// Ask for an item's icon. Idempotent per session.
    pub fn request(&self, item_id: &str, command: &str) {
        if command.trim().is_empty() {
            return;
        }
        self.enqueue(item_id, Source::Shell(command.to_string()));
    }

    /// Ask for a web shortcut's favicon, and optionally the page's own name.
    ///
    /// The host is checked HERE rather than on the worker, so a half-typed address never becomes
    /// an outbound request. See `sys::web::is_fetchable_host` for what that cost the original.
    pub fn request_web(&self, item_id: &str, url: &str, want_title: bool) {
        let full = crate::sys::web::with_scheme(url);
        let Some(host) = crate::sys::web::host_of(&full) else {
            return;
        };
        if !crate::sys::web::is_fetchable_host(&host) {
            return;
        }
        self.enqueue(item_id, Source::Web { host, want_title });
    }

    fn enqueue(&self, item_id: &str, source: Source) {
        // Keyed by the item AND its source, so editing a shortcut's address asks again while a
        // frame that merely redraws does not.
        let key = format!("{item_id}|{source:?}");
        if !self.seen.borrow_mut().insert(key) {
            return;
        }
        let mut items = self.queue.items.lock().unwrap();
        items.push_back((item_id.to_string(), source));
        self.queue.wake.notify_one();
    }

    /// Everything finished since the last call.
    pub fn drain(&self) -> Vec<Extracted> {
        self.results.try_iter().collect()
    }

    pub fn pending(&self) -> bool {
        !self.queue.items.lock().unwrap().is_empty() || self.queue.busy.load(Ordering::Acquire)
    }
}

impl Default for Extractor {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for Extractor {
    fn drop(&mut self) {
        self.queue.stop.store(true, Ordering::Release);
        self.queue.wake.notify_all();
    }
}

fn worker(queue: Arc<Queue>, sender: Sender<Extracted>, wake: Arc<Mutex<Option<isize>>>) {
    unsafe {
        // The shell's imaging interfaces are apartment-threaded. WinHTTP needs no apartment,
        // so one worker serves both and this stays the only COM initialisation it does.
        let _ = windows::Win32::System::Com::CoInitializeEx(
            None,
            windows::Win32::System::Com::COINIT_APARTMENTTHREADED,
        );
    }
    loop {
        let job = {
            let mut items = queue.items.lock().unwrap();
            loop {
                if queue.stop.load(Ordering::Acquire) {
                    return;
                }
                match items.pop_front() {
                    Some(job) => break job,
                    None => items = queue.wake.wait(items).unwrap(),
                }
            }
        };
        let (item_id, source) = job;
        queue.busy.store(true, Ordering::Release);
        let finished = match source {
            Source::Shell(command) => extract(&command)
                .and_then(|bytes| super::store::put(&bytes, "png").ok())
                .map(|reference| Extracted {
                    item_id,
                    reference,
                    title: None,
                }),
            Source::Web { host, want_title } => {
                // The title first: it is the cheaper of the two and the one the user is watching
                // a field for. The icon can arrive a moment later without anybody noticing.
                let title = if want_title {
                    crate::sys::web::page_title(&host)
                } else {
                    None
                };
                let reference = crate::sys::web::favicon(&host).and_then(|bytes| {
                    let extension = crate::sys::web::extension_for(&bytes);
                    super::store::put(&bytes, extension).ok()
                });
                // A title with no icon is still worth sending back; an empty result is not.
                match (reference, title) {
                    (None, None) => None,
                    (reference, title) => Some(Extracted {
                        item_id,
                        reference: reference.unwrap_or_default(),
                        title,
                    }),
                }
            }
        };
        queue.busy.store(false, Ordering::Release);
        let Some(finished) = finished else { continue };
        if sender.send(finished).is_err() {
            return;
        }
        notify(&wake);
    }
}

/// Wake the UI thread, if it has asked to be.
///
/// The handle and the message are packed into one word behind one lock, so the worker takes a lock
/// it never contends for rather than two atomics that could be read half-updated.
fn notify(wake: &Arc<Mutex<Option<isize>>>) {
    let Some(packed) = *wake.lock().unwrap() else {
        return;
    };
    let hwnd = windows::Win32::Foundation::HWND((packed >> 16) as _);
    let message = (packed & 0xFFFF) as u32;
    unsafe {
        let _ = windows::Win32::UI::WindowsAndMessaging::PostMessageW(
            hwnd,
            message,
            windows::Win32::Foundation::WPARAM(0),
            windows::Win32::Foundation::LPARAM(0),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(width: u32, height: u32, colour: [u8; 4]) -> Vec<u8> {
        colour
            .iter()
            .cycle()
            .take((width * height * 4) as usize)
            .copied()
            .collect()
    }

    #[test]
    fn a_fully_opaque_image_has_no_halo() {
        // No transparency means no edge by this definition, and calling that dirty would reject
        // most real icons.
        let pixels = solid(64, 64, [40, 60, 200, 255]);
        assert_eq!(halo_score(&pixels, 64, 64), 0.0);
    }

    #[test]
    fn a_white_ring_around_a_dark_shape_scores() {
        // A disc of dark blue with a white rim, which is exactly what an alpha-cut composite looks
        // like.
        let (w, h) = (64u32, 64u32);
        let mut pixels = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let dx = x as f32 - 32.0;
                let dy = y as f32 - 32.0;
                let r = (dx * dx + dy * dy).sqrt();
                let i = ((y * w + x) * 4) as usize;
                if r > 28.0 {
                    continue;
                }
                let colour: [u8; 4] = if r > 25.0 {
                    [255, 255, 255, 255]
                } else {
                    [200, 60, 40, 255]
                };
                pixels[i..i + 4].copy_from_slice(&colour);
            }
        }
        assert!(halo_score(&pixels, w, h) > 0.5, "got {}", halo_score(&pixels, w, h));
    }

    #[test]
    fn a_genuinely_white_logo_is_not_a_halo() {
        // A white mark on a transparent background has a white edge AND a white interior. Judging
        // on the edge alone would reject every monochrome logo.
        let (w, h) = (64u32, 64u32);
        let mut pixels = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let dx = x as f32 - 32.0;
                let dy = y as f32 - 32.0;
                if (dx * dx + dy * dy).sqrt() > 28.0 {
                    continue;
                }
                let i = ((y * w + x) * 4) as usize;
                pixels[i..i + 4].copy_from_slice(&[255, 255, 255, 255]);
            }
        }
        assert!(halo_score(&pixels, w, h) < 0.1, "got {}", halo_score(&pixels, w, h));
    }

    #[test]
    fn a_clean_coloured_icon_is_not_a_halo() {
        let (w, h) = (64u32, 64u32);
        let mut pixels = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let dx = x as f32 - 32.0;
                let dy = y as f32 - 32.0;
                if (dx * dx + dy * dy).sqrt() > 28.0 {
                    continue;
                }
                let i = ((y * w + x) * 4) as usize;
                pixels[i..i + 4].copy_from_slice(&[30, 120, 220, 255]);
            }
        }
        assert!(halo_score(&pixels, w, h) < HALO_CLEAN);
    }

    #[test]
    fn commands_resolve_to_the_right_shell_item() {
        // A moniker goes through untouched, a bare id is wrapped, a path is the executable rather
        // than its arguments, and an alias has no shell item at all.
        assert_eq!(
            resolve("shell:AppsFolder\\Chrome").map(|h| h.to_string()),
            Some("shell:AppsFolder\\Chrome".to_string())
        );
        assert_eq!(
            resolve("com.squirrel.Figma.Figma").map(|h| h.to_string()),
            Some("shell:AppsFolder\\com.squirrel.Figma.Figma".to_string())
        );
        assert_eq!(
            resolve("\"C:\\Tools\\code.exe\" \"D:\\Work\"").map(|h| h.to_string()),
            Some("C:\\Tools\\code.exe".to_string())
        );
        assert!(resolve("notepad").is_none());
        assert!(resolve("https://example.com/").is_none());
        assert!(resolve("   ").is_none());
    }

    #[test]
    fn a_real_application_yields_a_real_icon() {
        // Runs against the live machine. The whole pipeline — shell item, image, premultiply,
        // halo, encode — in one assertion, which is the only kind that catches a flag or a
        // byte-order mistake.
        unsafe {
            let _ = windows::Win32::System::Com::CoInitializeEx(
                None,
                windows::Win32::System::Com::COINIT_APARTMENTTHREADED,
            );
        }
        let explorer = "C:\\Windows\\explorer.exe";
        let bytes = extract(explorer).expect("explorer.exe has an icon");
        assert!(bytes.len() > 256, "suspiciously small: {} bytes", bytes.len());
        assert_eq!(&bytes[1..4], b"PNG", "should be a PNG");
        // And it decodes back to something square and non-empty.
        let (pixels, w, h) = crate::gfx::encode::decode_bytes(&bytes).expect("decodes");
        assert_eq!(w, h);
        assert!(w >= 32, "only {w}px");
        assert!(pixels.iter().any(|b| *b != 0), "decoded to nothing");
    }
}
